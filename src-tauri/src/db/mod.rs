pub mod clickhouse_driver;
pub mod edit;
pub mod drop_object;
pub mod introspect;
pub mod routines;
pub mod oracle_driver;
pub mod value;

use std::str::FromStr;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::{Column, Executor, Row};

use crate::error::{AppError, AppResult};
use crate::models::{ColumnMeta, ConnectionConfig, DbKind, QueryResult};

/// A live pooled connection to one engine. Pools are cheap to clone (they're
/// reference-counted internally), so callers clone one out of shared state and
/// run queries without holding a lock.
#[derive(Clone)]
pub enum DbPool {
    MySql(sqlx::MySqlPool),
    Postgres(sqlx::PgPool),
    Sqlite(sqlx::SqlitePool),
    Oracle(oracle_driver::OracleHandle),
    ClickHouse(clickhouse_driver::ClickHouseHandle),
}

/// What a fresh connection tells us about the server.
pub struct ConnectInfo {
    pub pool: DbPool,
    pub server_version: String,
    pub current_database: String,
}

/// A held transaction for a manual-commit (autocommit-off) session. Statements
/// run on this same connection until the user commits or rolls back.
pub enum SessionTx {
    MySql(sqlx::Transaction<'static, sqlx::MySql>),
    Postgres(sqlx::Transaction<'static, sqlx::Postgres>),
    Sqlite(sqlx::Transaction<'static, sqlx::Sqlite>),
}

/// 这个引擎有没有可回滚的会话事务。Oracle 不走同一套连接池,ClickHouse 压根没有
/// 会话事务 —— 批量写入时要据此决定是"要么全成要么全不成",还是只能一条条来、
/// 然后老实告诉用户跑掉了几条。
pub fn supports_session_tx(pool: &DbPool) -> bool {
    matches!(pool, DbPool::MySql(_) | DbPool::Postgres(_) | DbPool::Sqlite(_))
}

/// Begin a manual-commit transaction on a pooled engine. Oracle isn't pooled the
/// same way, so it manages autocommit on its own connection instead.
pub async fn begin_tx(pool: &DbPool) -> AppResult<SessionTx> {
    Ok(match pool {
        DbPool::MySql(p) => SessionTx::MySql(p.begin().await?),
        DbPool::Postgres(p) => SessionTx::Postgres(p.begin().await?),
        DbPool::Sqlite(p) => SessionTx::Sqlite(p.begin().await?),
        DbPool::Oracle(_) => {
            return Err(AppError::msg(
                "Manual-commit sessions aren't supported for Oracle yet.",
            ))
        }
        DbPool::ClickHouse(_) => {
            return Err(AppError::msg(
                "ClickHouse 不支持手动提交事务(它没有可回滚的会话事务)。",
            ))
        }
    })
}

/// Start a transaction suitable for dashboard reads. MySQL needs the
/// characteristic set on the same acquired connection before BEGIN; Postgres
/// accepts it immediately after BEGIN. SQLite is protected by the conservative
/// statement validator and a rollback-only transaction because its
/// `query_only` pragma would leak connection state back into the shared pool.
async fn begin_read_only_tx(pool: &DbPool) -> AppResult<SessionTx> {
    Ok(match pool {
        DbPool::MySql(p) => SessionTx::MySql(p.begin_with("START TRANSACTION READ ONLY").await?),
        DbPool::Postgres(p) => SessionTx::Postgres(p.begin_with("BEGIN READ ONLY").await?),
        DbPool::Sqlite(p) => SessionTx::Sqlite(p.begin().await?),
        DbPool::Oracle(_) => {
            return Err(AppError::msg(
                "Dashboard datasets do not support Oracle until read-only transaction isolation is available.",
            ))
        }
        DbPool::ClickHouse(_) => {
            return Err(AppError::msg(
                "ClickHouse 暂不支持看板只读事务数据集(可用编辑器直接查询)。",
            ))
        }
    })
}

pub async fn commit_tx(tx: SessionTx) -> AppResult<()> {
    match tx {
        SessionTx::MySql(t) => t.commit().await?,
        SessionTx::Postgres(t) => t.commit().await?,
        SessionTx::Sqlite(t) => t.commit().await?,
    }
    Ok(())
}

pub async fn rollback_tx(tx: SessionTx) -> AppResult<()> {
    match tx {
        SessionTx::MySql(t) => t.rollback().await?,
        SessionTx::Postgres(t) => t.rollback().await?,
        SessionTx::Sqlite(t) => t.rollback().await?,
    }
    Ok(())
}

/// 一批写语句跑在**同一笔事务**里:要么全成,要么一条都不留。
///
/// Oracle / ClickHouse 没有可回滚的会话事务,只能一条条来。那就不假装原子 ——
/// 出错时把"前几条已经生效"写进错误里,让用户知道该去核对什么。
/// 最怕的是既没回滚、又不说,留下一个谁也不知道停在哪儿的半拉状态。
pub async fn run_statements(pool: &DbPool, statements: &[String]) -> AppResult<u64> {
    if statements.is_empty() {
        return Ok(0);
    }
    if !supports_session_tx(pool) {
        let mut total = 0u64;
        for (index, sql) in statements.iter().enumerate() {
            match run_query(pool, sql, Some(0)).await {
                Ok(result) => total += result.rows_affected.unwrap_or(0),
                Err(error) => {
                    return Err(AppError::msg(format!(
                        "第 {} 条语句失败:{error}。这个数据库不支持可回滚的批量写入,前 {} 条已经生效,请自行核对。",
                        index + 1,
                        index
                    )))
                }
            }
        }
        return Ok(total);
    }
    let mut tx = begin_tx(pool).await?;
    let mut total = 0u64;
    for sql in statements {
        match run_query_on_tx(&mut tx, sql, Some(0)).await {
            Ok(result) => total += result.rows_affected.unwrap_or(0),
            Err(error) => {
                // 回滚本身失败也不该盖掉真正的原因,原样把原错误交回去。
                let _ = rollback_tx(tx).await;
                return Err(error);
            }
        }
    }
    commit_tx(tx).await?;
    Ok(total)
}

/// A failed batch rolls back only its savepoint, preserving earlier manual work.
pub async fn run_statements_on_tx(tx: &mut SessionTx, statements: &[String]) -> AppResult<u64> {
    use sqlx::Acquire;
    macro_rules! batch {
        ($parent:expr) => {{
            let mut nested = $parent.begin().await?;
            let mut total = 0;
            for sql in statements {
                total += sqlx::query(sql).execute(&mut *nested).await?.rows_affected();
            }
            nested.commit().await?;
            Ok(total)
        }};
    }
    match tx {
        SessionTx::MySql(t) => batch!(t),
        SessionTx::Postgres(t) => batch!(t),
        SessionTx::Sqlite(t) => batch!(t),
    }
}

/// Run a statement inside a held session transaction (autocommit off).
pub async fn run_query_on_tx(
    tx: &mut SessionTx,
    sql: &str,
    max_rows: Option<usize>,
) -> AppResult<QueryResult> {
    // No cap when the caller passes None — the editor returns every row.
    let cap = max_rows.unwrap_or(usize::MAX);
    let started = Instant::now();

    if strip_leading_noise(sql).split_whitespace().next().is_some_and(|word|word.eq_ignore_ascii_case("CALL")) {
        return routines::call_sql_tx(tx, sql, cap).await;
    }
    if !returns_rows(sql) {
        let affected = match tx {
            SessionTx::MySql(t) => sqlx::query(sql).execute(&mut **t).await?.rows_affected(),
            SessionTx::Postgres(t) => sqlx::query(sql).execute(&mut **t).await?.rows_affected(),
            SessionTx::Sqlite(t) => sqlx::query(sql).execute(&mut **t).await?.rows_affected(),
        };
        return Ok(QueryResult {
            additional_results: None,
            rows_affected: Some(affected),
            message: Some(format!("{affected} row(s) affected")),
            elapsed_ms: started.elapsed().as_millis(),
            ..Default::default()
        });
    }

    let mut columns: Vec<ColumnMeta> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;

    macro_rules! collect_tx {
        ($t:expr, $cell:path) => {{
            let mut stream = sqlx::query(sql).fetch(&mut **$t);
            while let Some(row) = stream.try_next().await? {
                if columns.is_empty() {
                    columns = value::columns_from_row(&row);
                }
                if rows.len() >= cap {
                    truncated = true;
                    break;
                }
                let n = row.columns().len();
                let mut cells = Vec::with_capacity(n);
                for i in 0..n {
                    cells.push($cell(&row, i));
                }
                rows.push(cells);
            }
        }};
    }

    match tx {
        SessionTx::MySql(t) => collect_tx!(t, value::mysql_value),
        SessionTx::Postgres(t) => collect_tx!(t, value::pg_value),
        SessionTx::Sqlite(t) => collect_tx!(t, value::sqlite_value),
    }

    Ok(QueryResult {
            additional_results: None,
        columns,
        rows,
        rows_affected: None,
        truncated,
        elapsed_ms: started.elapsed().as_millis(),
        message: None,
    })
}

async fn run_bound_read_query_on_tx(
    tx: &mut SessionTx,
    sql: &str,
    params: &[String],
    max_rows: Option<usize>,
) -> AppResult<QueryResult> {
    let cap = max_rows.unwrap_or(10_000);
    let started = Instant::now();
    let mut columns: Vec<ColumnMeta> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;

    macro_rules! collect_bound {
        ($t:expr, $cell:path) => {{
            let mut query = sqlx::query(sql);
            for value in params {
                query = query.bind(value);
            }
            let mut stream = query.fetch(&mut **$t);
            while let Some(row) = stream.try_next().await? {
                if columns.is_empty() {
                    columns = value::columns_from_row(&row);
                }
                if rows.len() >= cap {
                    truncated = true;
                    break;
                }
                let n = row.columns().len();
                let mut cells = Vec::with_capacity(n);
                for i in 0..n {
                    cells.push($cell(&row, i));
                }
                rows.push(cells);
            }
        }};
    }

    match tx {
        SessionTx::MySql(t) => collect_bound!(t, value::mysql_value),
        SessionTx::Postgres(t) => collect_bound!(t, value::pg_value),
        SessionTx::Sqlite(t) => collect_bound!(t, value::sqlite_value),
    }

    Ok(QueryResult {
            additional_results: None,
        columns,
        rows,
        rows_affected: None,
        truncated,
        elapsed_ms: started.elapsed().as_millis(),
        message: None,
    })
}

/// Execute one dashboard query in an isolated transaction that is always
/// rolled back. The timeout covers the query only, so cleanup still runs after
/// a cancelled or failed query instead of returning a dirty pooled connection.
pub async fn run_read_only_query(
    pool: &DbPool,
    sql: &str,
    text_params: &[String],
    max_rows: Option<usize>,
    timeout: Duration,
) -> AppResult<QueryResult> {
    let mut transaction = begin_read_only_tx(pool).await?;
    let query_result = tokio::time::timeout(
        timeout,
        run_bound_read_query_on_tx(&mut transaction, sql, text_params, max_rows),
    )
    .await;
    let rollback_result = rollback_tx(transaction).await;
    rollback_result?;
    let mut result = query_result.map_err(|_| {
        AppError::msg(format!(
            "Dashboard query timed out after {} seconds.",
            timeout.as_secs()
        ))
    })??;
    if result.columns.is_empty() {
        result.columns = describe_columns(pool, sql).await.unwrap_or_default();
    }
    Ok(result)
}

fn effective_port(cfg: &ConnectionConfig) -> u16 {
    if cfg.port == 0 {
        cfg.kind.default_port()
    } else {
        cfg.port
    }
}

/// Open a pool for the given profile. `password` is passed separately so it
/// never has to live in the persisted config.
pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectInfo> {
    match cfg.kind {
        DbKind::Mysql | DbKind::Mariadb => connect_mysql(cfg, password).await,
        DbKind::Postgres => connect_postgres(cfg, password).await,
        DbKind::Sqlite => connect_sqlite(cfg).await,
        DbKind::Oracle => oracle_driver::connect(cfg, password).await,
        DbKind::Clickhouse => clickhouse_driver::connect(cfg, password).await,
    }
}

async fn connect_mysql(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectInfo> {
    use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};

    let ssl = match cfg.ssl_mode.as_deref() {
        Some("disable") => MySqlSslMode::Disabled,
        Some("require") => MySqlSslMode::Required,
        _ => MySqlSslMode::Preferred,
    };

    let mut opts = MySqlConnectOptions::new()
        .host(&cfg.host)
        .port(effective_port(cfg))
        .username(&cfg.username)
        .ssl_mode(ssl);
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if !cfg.database.is_empty() {
        opts = opts.database(&cfg.database);
    }

    let pool = MySqlPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(45))
        .connect_with(opts)
        .await?;

    let server_version = fetch_scalar(&DbPool::MySql(pool.clone()), "SELECT VERSION()")
        .await
        .unwrap_or_default();
    let current_database = fetch_scalar(&DbPool::MySql(pool.clone()), "SELECT DATABASE()")
        .await
        .unwrap_or_default();

    Ok(ConnectInfo {
        pool: DbPool::MySql(pool),
        server_version,
        current_database,
    })
}

async fn connect_postgres(
    cfg: &ConnectionConfig,
    password: Option<&str>,
) -> AppResult<ConnectInfo> {
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};

    let ssl = match cfg.ssl_mode.as_deref() {
        Some("disable") => PgSslMode::Disable,
        Some("require") => PgSslMode::Require,
        _ => PgSslMode::Prefer,
    };

    let database = if cfg.database.is_empty() {
        "postgres".to_string()
    } else {
        cfg.database.clone()
    };

    let mut opts = PgConnectOptions::new()
        .host(&cfg.host)
        .port(effective_port(cfg))
        .username(&cfg.username)
        .database(&database)
        .ssl_mode(ssl);
    if let Some(pw) = password {
        opts = opts.password(pw);
    }

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(45))
        .connect_with(opts)
        .await?;

    let server_version = fetch_scalar(&DbPool::Postgres(pool.clone()), "SHOW server_version")
        .await
        .unwrap_or_default();
    let current_database =
        fetch_scalar(&DbPool::Postgres(pool.clone()), "SELECT current_database()")
            .await
            .unwrap_or(database);

    Ok(ConnectInfo {
        pool: DbPool::Postgres(pool),
        server_version,
        current_database,
    })
}

async fn connect_sqlite(cfg: &ConnectionConfig) -> AppResult<ConnectInfo> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    if cfg.database.is_empty() {
        return Err(AppError::msg("SQLite needs a database file path."));
    }

    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", cfg.database))
        .map_err(|e| AppError::msg(format!("bad SQLite path: {e}")))?
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(45))
        .connect_with(opts)
        .await?;

    let server_version = fetch_scalar(&DbPool::Sqlite(pool.clone()), "SELECT sqlite_version()")
        .await
        .map(|v| format!("SQLite {v}"))
        .unwrap_or_default();

    Ok(ConnectInfo {
        pool: DbPool::Sqlite(pool),
        server_version,
        current_database: cfg.database.clone(),
    })
}

/// Fetch the first column of the first row as a string. Used for version and
/// current-database probes.
async fn fetch_scalar(pool: &DbPool, sql: &str) -> Option<String> {
    let value = match pool {
        DbPool::MySql(p) => sqlx::query(sql)
            .fetch_optional(p)
            .await
            .ok()
            .flatten()
            .map(|r| value::mysql_value(&r, 0)),
        DbPool::Postgres(p) => sqlx::query(sql)
            .fetch_optional(p)
            .await
            .ok()
            .flatten()
            .map(|r| value::pg_value(&r, 0)),
        DbPool::Sqlite(p) => sqlx::query(sql)
            .fetch_optional(p)
            .await
            .ok()
            .flatten()
            .map(|r| value::sqlite_value(&r, 0)),
        DbPool::Oracle(_) => None,
        DbPool::ClickHouse(_) => None,
    };
    match value {
        Some(Value::String(s)) => Some(s),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }
}

/// Does this statement return a result set we should render as a grid?
fn returns_rows(sql: &str) -> bool {
    let trimmed = strip_leading_noise(sql);
    let first: String = trimmed
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_ascii_uppercase();
    matches!(
        first.as_str(),
        "SELECT"
            | "WITH"
            | "SHOW"
            | "DESC"
            | "DESCRIBE"
            | "EXPLAIN"
            | "PRAGMA"
            | "VALUES"
            | "TABLE"
    )
}

/// Strip leading whitespace, `--` line comments and `/* */` block comments so
/// classification looks at the real first keyword.
/// 跳过语句最前面的注释,好看清它到底是什么语句。
///
/// `#` 也是行注释(MySQL / MariaDB / ClickHouse)。原来只认 `--` 和 `/* */`,
/// 于是在编辑器里选中这样一段执行:
///
/// ```text
/// #示例连锁网点实收日汇总-点评平台
/// SELECT FLOW_DATE, COUNT(*) ... FROM t_shop_dish_flow_summary WHERE ...
/// ```
///
/// returns_rows 从 `#` 开始取首词、取到空串,就把整条当成了写语句 —— 走 execute()
/// 那条路,界面上只剩一句「0 row(s) affected」,查询结果一行都看不到。
/// 而这种「注释写在 SQL 上面」是最常见的写法。
///
/// 这里不分方言:PostgreSQL / SQLite / Oracle 的语句**不可能以 `#` 开头**
/// (它们那儿 `#` 只出现在运算符里,比如 PG 的 `#>`),所以剥掉开头的 `#` 行
/// 对它们也没有副作用。语句中间的 `#` 是另一回事,由前端的 scanSql 按方言处理。
pub(crate) fn strip_leading_noise(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--").or_else(|| s.strip_prefix("#")) {
            match rest.find('\n') {
                Some(nl) => s = rest[nl + 1..].trim_start(),
                None => return "",
            }
        } else if let Some(rest) = s.strip_prefix("/*") {
            match rest.find("*/") {
                Some(end) => s = rest[end + 2..].trim_start(),
                None => return "",
            }
        } else {
            return s;
        }
    }
}

/// 编辑器每条语句前加的标记 `/* sonde:<run_id> */`。「停止」按钮靠它在服务器的
/// 运行列表里找到这一条(MySQL 的 PROCESSLIST.INFO、PostgreSQL 的 pg_stat_activity.query
/// 都保留注释原文)。run_id 只许字母数字和 `-`:不会提前结束注释,也不是 LIKE 通配符。
pub fn run_marker(run_id: &str) -> Option<String> {
    let ok = !run_id.is_empty() && run_id.len() <= 64 && run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| format!("sonde:{run_id}"))
}

/// 「停止」:找到带这个标记、正在跑的语句,在服务器端取消它(只取消语句,不断开会话 ——
/// 手动提交模式下事务还在)。返回取消了几条;0 表示没找到(已经跑完,或这种库不支持)。
///
/// 用一条新开的独立连接去发取消:慢查询可能正把连接池占满,从池里借要排队 45 秒。
pub async fn cancel_marked_query(pool: &DbPool, marker: &str) -> AppResult<u64> {
    let like = format!("%{marker}%");
    match pool {
        DbPool::MySql(p) => {
            // 单连接的小池子 = 一条新开的独立连接(直接拿 &mut 连接在命令里会撞 sqlx 的生命周期限制)
            let side = sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(10))
                .connect_with((*p.connect_options()).clone())
                .await?;
            let ids: Vec<u64> = sqlx::query_scalar(
                "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND ID <> CONNECTION_ID()",
            )
            .bind(&like)
            .fetch_all(&side)
            .await?;
            for id in &ids {
                // KILL 不能走预处理协议;id 是数据库返回的整数,拼进去是安全的
                sqlx::raw_sql(&format!("KILL QUERY {id}")).execute(&side).await?;
            }
            side.close().await;
            Ok(ids.len() as u64)
        }
        DbPool::Postgres(p) => {
            let side = sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(10))
                .connect_with((*p.connect_options()).clone())
                .await?;
            let n: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FILTER (WHERE pg_cancel_backend(pid)) FROM pg_stat_activity \
                 WHERE query LIKE $1 AND pid <> pg_backend_pid() AND state = 'active'",
            )
            .bind(&like)
            .fetch_one(&side)
            .await?;
            side.close().await;
            Ok(n.max(0) as u64)
        }
        // SQLite 在本机、Oracle / ClickHouse 走各自驱动:暂不支持服务器端取消,界面只停止等待
        _ => Ok(0),
    }
}

/// Run a statement, capping returned rows at `max_rows` (default 10k) and
/// reporting whether the result was truncated.
/// Kill a server-side session/process by id. MySQL uses the text protocol
/// (KILL is not allowed in the prepared-statement protocol); Postgres uses
/// pg_terminate_backend. `id` is a typed integer, so it is injection-safe.
pub async fn kill_process(pool: &DbPool, id: i64) -> AppResult<()> {
    match pool {
        DbPool::MySql(p) => {
            sqlx::raw_sql(&format!("KILL {id}")).execute(p).await?;
        }
        DbPool::Postgres(p) => {
            sqlx::query("SELECT pg_terminate_backend($1)")
                .bind(id as i32)
                .execute(p)
                .await?;
        }
        DbPool::Sqlite(_) | DbPool::Oracle(_) | DbPool::ClickHouse(_) => {
            return Err(AppError::msg("This engine has no killable server processes."));
        }
    }
    Ok(())
}

pub async fn run_query(
    pool: &DbPool,
    sql: &str,
    max_rows: Option<usize>,
) -> AppResult<QueryResult> {
    // No cap when the caller passes None — the editor returns every row.
    let cap = max_rows.unwrap_or(usize::MAX);
    let started = Instant::now();

    // Oracle runs on the synchronous ODPI-C driver, handled end-to-end there.
    if let DbPool::Oracle(handle) = pool {
        return oracle_driver::run_query(handle, sql, cap).await;
    }
    // ClickHouse runs over its HTTP interface, handled end-to-end in its driver.
    if let DbPool::ClickHouse(handle) = pool {
        return clickhouse_driver::run_query(handle, sql, cap).await;
    }

    if strip_leading_noise(sql).split_whitespace().next().is_some_and(|word|word.eq_ignore_ascii_case("CALL")) {
        return routines::call_sql(pool, sql, cap).await;
    }
    if !returns_rows(sql) {
        let affected = match pool {
            DbPool::MySql(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Postgres(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Sqlite(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Oracle(_) => unreachable!("oracle handled above"),
            DbPool::ClickHouse(_) => unreachable!("clickhouse handled above"),
        };
        return Ok(QueryResult {
            additional_results: None,
            rows_affected: Some(affected),
            message: Some(format!("{affected} row(s) affected")),
            elapsed_ms: started.elapsed().as_millis(),
            ..Default::default()
        });
    }

    let mut columns: Vec<ColumnMeta> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;

    macro_rules! collect {
        ($p:expr, $cell:path) => {{
            let mut stream = sqlx::query(sql).fetch($p);
            while let Some(row) = stream.try_next().await? {
                if columns.is_empty() {
                    columns = value::columns_from_row(&row);
                }
                if rows.len() >= cap {
                    truncated = true;
                    break;
                }
                let n = row.columns().len();
                let mut cells = Vec::with_capacity(n);
                for i in 0..n {
                    cells.push($cell(&row, i));
                }
                rows.push(cells);
            }
        }};
    }

    match pool {
        DbPool::MySql(p) => collect!(p, value::mysql_value),
        DbPool::Postgres(p) => collect!(p, value::pg_value),
        DbPool::Sqlite(p) => collect!(p, value::sqlite_value),
        DbPool::Oracle(_) => unreachable!("oracle handled above"),
        DbPool::ClickHouse(_) => unreachable!("clickhouse handled above"),
    }

    if columns.is_empty() {
        columns = describe_columns(pool, sql).await.unwrap_or_default();
    }

    Ok(QueryResult {
            additional_results: None,
        columns,
        rows,
        rows_affected: None,
        truncated,
        elapsed_ms: started.elapsed().as_millis(),
        message: None,
    })
}

/// Column metadata for a statement that returned no rows.
async fn describe_columns(pool: &DbPool, sql: &str) -> AppResult<Vec<ColumnMeta>> {
    fn map<DB: sqlx::Database>(d: &sqlx::Describe<DB>) -> Vec<ColumnMeta> {
        d.columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.type_info().to_string(),
            })
            .collect()
    }
    match pool {
        DbPool::MySql(p) => Ok(map(&p.describe(sql).await?)),
        DbPool::Postgres(p) => Ok(map(&p.describe(sql).await?)),
        DbPool::Sqlite(p) => Ok(map(&p.describe(sql).await?)),
        DbPool::Oracle(_) => Ok(vec![]),
        DbPool::ClickHouse(_) => Ok(vec![]),
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use crate::readonly::{prepare_dashboard_query, ReadOnlyFilter};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn scalar_name(pool: &sqlx::SqlitePool) -> String {
        sqlx::query_scalar::<_, String>("SELECT name FROM items WHERE id = 1")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn session_tx_rolls_back_and_commits() {
        // One connection keeps the in-memory database alive across acquires.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO items (id, name) VALUES (1, 'before')")
            .execute(&pool)
            .await
            .unwrap();
        let db_pool = DbPool::Sqlite(pool.clone());

        // Autocommit off: an update inside the session, then rollback -> unchanged.
        let mut tx = begin_tx(&db_pool).await.unwrap();
        run_query_on_tx(
            &mut tx,
            "UPDATE items SET name = 'rolled' WHERE id = 1",
            None,
        )
        .await
        .unwrap();
        rollback_tx(tx).await.unwrap();
        assert_eq!(scalar_name(&pool).await, "before");

        // Autocommit off: an update inside the session, then commit -> persisted.
        let mut tx = begin_tx(&db_pool).await.unwrap();
        run_query_on_tx(
            &mut tx,
            "UPDATE items SET name = 'after' WHERE id = 1",
            None,
        )
        .await
        .unwrap();
        commit_tx(tx).await.unwrap();
        assert_eq!(scalar_name(&pool).await, "after");
    }

    #[tokio::test]
    async fn dashboard_filters_bind_literal_values_inside_read_only_transaction() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE labels (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO labels (id, label) VALUES \
             (1, '100% safe'), (2, '1000 safe'), (3, 'O''Reilly 100% safe')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let db_pool = DbPool::Sqlite(pool);

        let contains = prepare_dashboard_query(
            DbKind::Sqlite,
            "SELECT id, label FROM labels ORDER BY id",
            &[ReadOnlyFilter {
                field: "label".to_string(),
                kind: "text".to_string(),
                value: "100%".to_string(),
            }],
        )
        .unwrap();
        assert!(!contains.sql.contains("100%"));
        let result = run_read_only_query(
            &db_pool,
            &contains.sql,
            &contains.params,
            Some(100),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(result.rows.len(), 2);

        let exact = prepare_dashboard_query(
            DbKind::Sqlite,
            "SELECT id, label FROM labels ORDER BY id",
            &[ReadOnlyFilter {
                field: "label".to_string(),
                kind: "select".to_string(),
                value: "O'Reilly 100% safe".to_string(),
            }],
        )
        .unwrap();
        assert!(!exact.sql.contains("O'Reilly"));
        let result = run_read_only_query(
            &db_pool,
            &exact.sql,
            &exact.params,
            Some(100),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][1], serde_json::json!("O'Reilly 100% safe"));
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    async fn fixture() -> (DbPool, sqlx::SqlitePool) {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        (DbPool::Sqlite(pool.clone()), pool)
    }
    async fn ids(pool: &sqlx::SqlitePool) -> Vec<i64> {
        sqlx::query_scalar("SELECT id FROM items ORDER BY id")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    /// 全成的时候该全部落库。
    #[tokio::test]
    async fn all_statements_land_when_every_one_succeeds() {
        let (db, raw) = fixture().await;
        let affected = run_statements(
            &db,
            &[
                "INSERT INTO items (id, name) VALUES (1, 'a')".to_string(),
                "INSERT INTO items (id, name) VALUES (2, 'b')".to_string(),
                "DELETE FROM items WHERE id = 1".to_string(),
            ],
        )
        .await
        .unwrap();
        assert_eq!(affected, 3, "三条各影响一行");
        assert_eq!(ids(&raw).await, vec![2]);
    }

    /// 中间失败要整笔回滚 —— 这正是表详情"增行/删行"原来出的事:
    /// 删到第三条炸了,前两条已经生效,而界面还显示着那两行。
    #[tokio::test]
    async fn a_failure_midway_rolls_the_whole_batch_back() {
        let (db, raw) = fixture().await;
        sqlx::query("INSERT INTO items (id, name) VALUES (1, 'keep'), (2, 'keep')")
            .execute(&raw)
            .await
            .unwrap();

        let error = run_statements(
            &db,
            &[
                "DELETE FROM items WHERE id = 1".to_string(),
                "DELETE FROM items WHERE id = 2".to_string(),
                // NOT NULL 约束:这条必炸
                "INSERT INTO items (id, name) VALUES (3, NULL)".to_string(),
            ],
        )
        .await
        .unwrap_err();
        assert!(!format!("{error:?}").is_empty(), "要把失败原因交回去");
        assert_eq!(
            ids(&raw).await,
            vec![1, 2],
            "第三条失败,前两条的删除必须一起回滚 —— 不能留下半拉状态"
        );
    }

    /// 空批次不该去开一笔事务。
    #[tokio::test]
    async fn empty_batch_is_a_no_op() {
        let (db, raw) = fixture().await;
        assert_eq!(run_statements(&db, &[]).await.unwrap(), 0);
        assert!(ids(&raw).await.is_empty());
    }

    /// 哪些引擎有可回滚的会话事务 —— 决定上面走原子那条路还是老实报"跑掉了几条"。
    #[tokio::test]
    async fn only_pooled_engines_claim_session_transactions() {
        let (db, _raw) = fixture().await;
        assert!(supports_session_tx(&db), "SQLite 有");
    }
}

#[cfg(test)]
mod statement_shape_tests {
    use super::returns_rows;

    /// `#` 是 MySQL(和 ClickHouse)的行注释。在编辑器里选中带 `#` 注释的一段
    /// 执行时,这条语句必须仍然被认成「会返回行」—— 否则走的是 execute() 那条路,
    /// 界面上只剩一句「0 row(s) affected」,查询结果一行都看不到。
    #[test]
    fn a_leading_hash_comment_does_not_hide_the_select() {
        assert!(returns_rows("#示例连锁网点实收日汇总-点评平台\nSELECT FLOW_DATE FROM t"));
        assert!(returns_rows("  # 带缩进的注释\n  SELECT 1"));
        assert!(returns_rows("#a\n#b\n-- c\n/* d */\nSELECT 1"), "几种注释混着也要穿过去");
        assert!(returns_rows("#! clickhouse 风格\nSELECT 1"));
    }

    /// 原有的两种注释不能退化。
    #[test]
    fn dash_and_block_comments_still_work() {
        assert!(returns_rows("-- 说明\nSELECT 1"));
        assert!(returns_rows("/* 说明 */ SELECT 1"));
        assert!(returns_rows("/* 多行\n说明 */\nWITH x AS (SELECT 1) SELECT * FROM x"));
    }

    /// 写语句照旧要被认成不返回行,否则会去等一个不存在的结果集。
    #[test]
    fn writes_are_still_writes() {
        assert!(!returns_rows("#注释\nUPDATE t SET a = 1"));
        assert!(!returns_rows("INSERT INTO t VALUES (1)"));
        assert!(!returns_rows("#只有注释没有语句"));
    }
}

#[cfg(test)]
mod cancel_tests {
    use super::*;

    #[test]
    fn run_markers_cannot_break_out_of_the_comment_or_widen_the_match() {
        assert_eq!(run_marker("q1-abc").as_deref(), Some("sonde:q1-abc"));
        for bad in ["", "a*/ DROP", "x%", "x_y", "a b", &"z".repeat(65)] {
            assert!(run_marker(bad).is_none(), "{bad} 应该被拒");
        }
    }

    /// 「停止」在真 MySQL 上的效果:一条要睡 20 秒的语句,1 秒后按停止,应在几秒内结束。
    #[tokio::test]
    #[ignore = "requires SONDE_TEST_MYSQL_HOST and SONDE_TEST_MYSQL_USER"]
    async fn stop_cancels_a_running_mysql_statement_on_the_server() {
        let options = sqlx::mysql::MySqlConnectOptions::new()
            .host(&std::env::var("SONDE_TEST_MYSQL_HOST").expect("test MySQL host"))
            .port(std::env::var("SONDE_TEST_MYSQL_PORT").unwrap_or_else(|_| "3306".into()).parse().unwrap())
            .username(&std::env::var("SONDE_TEST_MYSQL_USER").expect("test MySQL user"))
            .password(&std::env::var("SONDE_TEST_MYSQL_PASSWORD").unwrap_or_default());
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(2).connect_with(options).await.unwrap();
        let db = DbPool::MySql(pool.clone());
        let marker = run_marker("stop-test-1").unwrap();
        let sql = format!("/* {marker} */ SELECT SLEEP(20) AS s");
        let started = Instant::now();
        let running = tokio::spawn({ let db = DbPool::MySql(pool.clone()); async move { run_query(&db, &sql, Some(10)).await } });
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let cancelled = cancel_marked_query(&db, &marker).await.unwrap();
        assert_eq!(cancelled, 1, "应当找到并取消那一条");
        let outcome = tokio::time::timeout(Duration::from_secs(5), running).await.expect("停止后 5 秒内必须结束").unwrap();
        assert!(started.elapsed() < Duration::from_secs(8), "用了 {:?},没有被取消", started.elapsed());
        // MySQL 被 KILL QUERY 打断的 SLEEP 返回 1(而不是睡满返回 0)
        let r = outcome.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!(1));
        // 已经跑完的再按停止:什么都不做
        assert_eq!(cancel_marked_query(&db, &marker).await.unwrap(), 0);
    }
}
