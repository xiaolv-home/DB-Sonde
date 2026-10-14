//! 执行 SQL:编辑器的普通查询、看板的只读查询(只读事务里、参数按文本绑定)、判断语句会不会返回结果集。

use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::{Column, Executor, Row};

use super::session::{begin_read_only_tx, rollback_tx, SessionTx};
use super::{clickhouse_driver, oracle_driver, routines, value, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{ColumnMeta, QueryResult};

/// 带文本参数的只读查询在哪儿跑:只读事务里,或者(没有事务的引擎)直接在连接池上。
enum ReadOn<'a> {
    Tx(&'a mut SessionTx),
    MySqlPool(&'a sqlx::MySqlPool),
}

async fn run_bound_read_query(
    on: ReadOn<'_>,
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
        ($exec:expr, $cell:path) => {{
            let mut query = sqlx::query(sql);
            for value in params {
                query = query.bind(value);
            }
            let mut stream = query.fetch($exec);
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

    match on {
        ReadOn::Tx(SessionTx::MySql(t)) => collect_bound!(&mut **t, value::mysql_value),
        ReadOn::Tx(SessionTx::Postgres(t)) => collect_bound!(&mut **t, value::pg_value),
        ReadOn::Tx(SessionTx::Sqlite(t)) => collect_bound!(&mut **t, value::sqlite_value),
        ReadOn::MySqlPool(p) => collect_bound!(p, value::mysql_value),
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
    let query_result = match pool {
        // 没有普通事务的引擎(Doris / StarRocks)开不了只读事务:调用方已经用语句校验挡掉了写语句
        // (validate_dashboard_sql / validate_bridge_sql,和 SQLite 同理),直接在连接池上跑
        DbPool::MySql(m) if !m.caps.transactions => {
            tokio::time::timeout(timeout, run_bound_read_query(ReadOn::MySqlPool(&m.pool), sql, text_params, max_rows)).await
        }
        _ => {
            let mut transaction = begin_read_only_tx(pool).await?;
            let result = tokio::time::timeout(
                timeout,
                run_bound_read_query(ReadOn::Tx(&mut transaction), sql, text_params, max_rows),
            )
            .await;
            rollback_tx(transaction).await?;
            result
        }
    };
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

/// Does this statement return a result set we should render as a grid?
pub(crate) fn returns_rows(sql: &str) -> bool {
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

/// Run a statement, capping returned rows at `max_rows` (default 10k) and
/// reporting whether the result was truncated.
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
            // MySQL 一族手写的 SQL 走文本协议(和 mysql 命令行一样),不预编译 —— 见 MySql 上的说明
            DbPool::MySql(p) => sqlx::Executor::execute(&p.pool, sql).await?.rows_affected(),
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
        ($stream:expr, $cell:path) => {{
            let mut stream = $stream;
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
        // 传 &str = 文本协议(COM_QUERY),不预编译
        DbPool::MySql(p) => collect!(sqlx::Executor::fetch(&p.pool, sql), value::mysql_value),
        DbPool::Postgres(p) => collect!(sqlx::query(sql).fetch(p), value::pg_value),
        DbPool::Sqlite(p) => collect!(sqlx::query(sql).fetch(p), value::sqlite_value),
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
mod read_only_tests {
    use super::*;
    use crate::models::DbKind;
    use crate::readonly::{prepare_dashboard_query, ReadOnlyFilter};
    use sqlx::sqlite::SqlitePoolOptions;

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
