use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::sync::{Mutex, RwLock};

use crate::db::{self, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{
    ColumnInfo, ConnectionConfig, ConnectionMeta, DbKind, IndexInfo, QueryResult, RoutineInfo,
    TableInfo, UpdateCellRequest,
};
use crate::readonly::{prepare_dashboard_query, ReadOnlyFilter};
use crate::store;

/// One open connection held in memory for the lifetime of the session.
pub struct ActiveConn {
    pub kind: DbKind,
    pub pool: DbPool,
    pub current_database: String,
    /// Snapshot used for PostgreSQL sibling-database pools. The password is
    /// session-only and is never serialized or logged.
    pub config: ConnectionConfig,
    pub session_password: Option<String>,
}

/// Shared application state: the map of currently open connections.
#[derive(Default)]
pub struct AppState {
    pub conns: RwLock<HashMap<String, ActiveConn>>,
    /// PostgreSQL is database-scoped. Pools opened lazily for sibling databases
    /// are cached separately and removed with their parent connection.
    pub database_pools: RwLock<HashMap<String, DbPool>>,
    /// Held transactions for connections in manual-commit (autocommit-off) mode.
    pub sessions: RwLock<HashMap<String, Arc<Mutex<ManualSession>>>>,
    /// Per-connection autocommit flag. Absent means autocommit is on (default).
    pub autocommit: RwLock<HashMap<String, bool>>,
}

/// A manual transaction is bound to the selected database for its whole lifetime.
/// An empty transaction means recovery failed: all work stays blocked, never auto-committed.
pub struct ManualSession {
    database: String,
    pool: DbPool,
    tx: Option<db::SessionTx>,
}
impl ManualSession {
    fn transaction(&mut self, database: &str) -> AppResult<&mut db::SessionTx> {
        if self.database != database {
            return Err(AppError::msg(format!("手动事务属于数据库「{}」，请先结束手动模式再切换数据库", self.database)));
        }
        self.tx.as_mut().ok_or_else(|| AppError::msg("手动事务暂不可用，未执行操作；请重试提交或回滚以恢复事务"))
    }
    async fn reopen(&mut self) -> AppResult<()> {
        self.tx = Some(db::begin_tx(&self.pool).await.map_err(|e|
            AppError::msg(format!("上一笔事务已结束，但新事务启动失败：{e}。仍为手动模式，后续操作已阻止")))?);
        Ok(())
    }
}
async fn requested_database(state: &State<'_, AppState>, id: &str, database: Option<&str>) -> AppResult<String> {
    let conns = state.conns.read().await;
    let conn = conns.get(id).ok_or_else(|| AppError::NotConnected(id.into()))?;
    Ok(database.filter(|v| !v.is_empty()).unwrap_or(&conn.current_database).to_owned())
}

/// Drop any manual-commit session for a connection (the held transaction rolls
/// back on drop) and reset it to autocommit.
async fn clear_session(state: &State<'_, AppState>, id: &str) {
    state.sessions.write().await.remove(id);
    state.autocommit.write().await.remove(id);
}

/// Clone the pool + engine kind for an open connection, or error if it isn't open.
async fn pool_for(state: &State<'_, AppState>, id: &str) -> AppResult<(DbKind, DbPool)> {
    let (kind, pool) = {
        let guard = state.conns.read().await;
        let c = guard
            .get(id)
            .ok_or_else(|| AppError::NotConnected(id.to_string()))?;
        (c.kind, c.pool.clone())
    };
    Ok((kind, revive_if_dead(state, id, pool).await?))
}

/// Hand back a pool that can actually run something, reopening a dead Oracle
/// connection in place.
///
/// Only Oracle needs this. The sqlx pools recycle broken connections themselves,
/// but the Oracle thin driver marks its one handle dead and never recovers it, so
/// everything afterwards fails with "connection not ready" until the user
/// disconnects and reconnects by hand.
///
/// Reopening here is safe precisely because of *where* it happens: the caller has
/// not handed over a statement yet, so nothing has reached the server and no work
/// can be duplicated. Never retry a statement that was already sent — a DDL that
/// succeeded server-side before the connection broke would run a second time.
async fn revive_if_dead(
    state: &State<'_, AppState>,
    id: &str,
    pool: DbPool,
) -> AppResult<DbPool> {
    let DbPool::Oracle(ref handle) = pool else {
        return Ok(pool);
    };
    if db::oracle_driver::is_alive(handle).await {
        return Ok(pool);
    }

    let (config, password) = {
        let guard = state.conns.read().await;
        let active = guard
            .get(id)
            .ok_or_else(|| AppError::NotConnected(id.to_string()))?;
        (active.config.clone(), active.session_password.clone())
    };
    let info = db::connect(&config, password.as_deref()).await?;
    if let Some(active) = state.conns.write().await.get_mut(id) {
        active.pool = info.pool.clone();
    }
    Ok(info.pool)
}

fn database_pool_key(id: &str, database: &str) -> String {
    format!("{id}\u{0}{database}")
}

async fn pool_for_database(
    state: &State<'_, AppState>,
    id: &str,
    database: Option<&str>,
) -> AppResult<(DbKind, DbPool)> {
    let (kind, primary_pool, current_database, mut config, session_password) = {
        let guard = state.conns.read().await;
        let active = guard
            .get(id)
            .ok_or_else(|| AppError::NotConnected(id.to_string()))?;
        (
            active.kind,
            active.pool.clone(),
            active.current_database.clone(),
            active.config.clone(),
            active.session_password.clone(),
        )
    };
    let requested = database.filter(|value| !value.is_empty());
    // Databases that need a connection actually scoped to the target database so
    // unqualified `table` references resolve (Postgres is per-database; MySQL
    // connected without a default DB otherwise errors "No database selected").
    let scoped = matches!(kind, DbKind::Postgres | DbKind::Mysql | DbKind::Mariadb);
    if !scoped || requested.is_none() || requested == Some(current_database.as_str()) {
        return Ok((kind, revive_if_dead(state, id, primary_pool).await?));
    }

    let requested = requested.unwrap_or_default();
    let key = database_pool_key(id, requested);
    if let Some(pool) = state.database_pools.read().await.get(&key).cloned() {
        return Ok((kind, pool));
    }

    config.database = requested.to_string();
    let info = db::connect(&config, session_password.as_deref()).await?;
    let pool = info.pool;
    state.database_pools.write().await.insert(key, pool.clone());
    Ok((kind, pool))
}

async fn clear_database_pools(state: &State<'_, AppState>, id: &str) {
    let prefix = format!("{id}\u{0}");
    state
        .database_pools
        .write()
        .await
        .retain(|key, _| !key.starts_with(&prefix));
}

// --- saved connection profiles --------------------------------------------

#[tauri::command]
pub fn list_connections(app: AppHandle) -> AppResult<Vec<ConnectionConfig>> {
    store::load_connections(&app)
}

#[tauri::command]
pub fn save_connection(app: AppHandle, config: ConnectionConfig) -> AppResult<ConnectionConfig> {
    let mut list = store::load_connections(&app)?;
    if let Some(existing) = list.iter_mut().find(|c| c.id == config.id) {
        if crate::credentials::account(existing) != crate::credentials::account(&config) { crate::credentials::remove(&app, existing)?; }
        *existing = config.clone();
    } else {
        list.push(config.clone());
    }
    store::save_connections(&app, &list)?;

    Ok(config)
}

#[tauri::command]
pub async fn delete_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let mut list = store::load_connections(&app)?;
    if let Some(config) = list.iter().find(|c| c.id == id) { crate::credentials::remove(&app, config)?; }
    list.retain(|c| c.id != id);
    store::save_connections(&app, &list)?;
    state.conns.write().await.remove(&id);
    clear_database_pools(&state, &id).await;
    clear_session(&state, &id).await;
    Ok(())
}

// --- connecting ------------------------------------------------------------

#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<String> {
    let password = match password { Some(value) => Some(value), None => crate::credentials::load(&app, &config)? };
    let info = db::connect(&config, password.as_deref()).await?;
    let version = info.server_version.clone();
    // Drop the pool; this was only a probe.
    drop(info);
    Ok(if version.is_empty() {
        "Connected".to_string()
    } else {
        version
    })
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> AppResult<ConnectionMeta> {
    let list = store::load_connections(&app)?;
    let cfg = list
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::UnknownConnection(id.clone()))?;

    let supplied = password.is_some();
    let pw = if cfg.kind == DbKind::Sqlite { None } else {
        match password { Some(value) => Some(value), None => crate::credentials::load(&app, &cfg)? }
    };
    if cfg.kind != DbKind::Sqlite && pw.is_none() { return Err(AppError::msg("CREDENTIAL_REQUIRED: 请输入数据库密码，成功连接后会加密保存")); }
    let info = db::connect(&cfg, pw.as_deref()).await.map_err(|error| {
        let auth_error = match &error {
            AppError::Db(sqlx::Error::Database(db)) => matches!(db.code().as_deref(), Some("1045" | "28P01" | "28000")),
            _ => error.to_string().contains("ORA-01017") || error.to_string().contains("AUTHENTICATION_FAILED"),
        };
        if !supplied && auth_error { AppError::msg("CREDENTIAL_REJECTED: 保存的密码已失效，请重新输入") } else { error }
    })?;
    // Only successful authentication may replace saved credentials.
    let credential_warning = if supplied && cfg.kind != DbKind::Sqlite {
        crate::credentials::save(&app, &cfg, pw.as_deref().unwrap_or("")).err().map(|_| "连接成功，但凭据未能保存。请检查本地凭据文件权限或完整性。".to_string())
    } else { None };

    let meta = ConnectionMeta {
        credential_warning,
        id: id.clone(),
        kind: cfg.kind,
        server_version: info.server_version.clone(),
        current_database: info.current_database.clone(),
        has_schemas: matches!(cfg.kind, DbKind::Postgres | DbKind::Oracle),
        has_multiple_databases: matches!(
            cfg.kind,
            DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres
        ),
    };

    clear_database_pools(&state, &id).await;
    clear_session(&state, &id).await;
    state.conns.write().await.insert(
        id,
        ActiveConn {
            kind: cfg.kind,
            pool: info.pool,
            current_database: info.current_database,
            config: cfg,
            session_password: pw,
        },
    );
    Ok(meta)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.conns.write().await.remove(&id);
    clear_database_pools(&state, &id).await;
    clear_session(&state, &id).await;
    Ok(())
}

// --- object tree -----------------------------------------------------------

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, conn_id: String) -> AppResult<Vec<String>> {
    let (kind, pool) = pool_for(&state, &conn_id).await?;
    db::introspect::list_databases(&pool, kind).await
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> AppResult<Vec<String>> {
    let (_kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    db::introspect::list_schemas(&pool, &database).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: String,
) -> AppResult<Vec<TableInfo>> {
    let (_kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    db::introspect::list_tables(&pool, &database, &schema).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: String,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    let (_kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    db::introspect::list_columns(&pool, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_routines(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: String,
) -> AppResult<Vec<RoutineInfo>> {
    let (_kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    db::introspect::list_routines(&pool, &database, &schema).await
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: String,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    let (_kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    db::introspect::list_indexes(&pool, &database, &schema, &table).await
}

#[tauri::command]
pub async fn get_object_ddl(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: String,
    table: String,
    object_kind: String,
) -> AppResult<String> {
    let (_kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    db::introspect::get_object_ddl(&pool, &database, &schema, &table, &object_kind).await
}

// --- querying --------------------------------------------------------------

#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    sql: String,
    max_rows: Option<usize>,
    run_id: Option<String>,
) -> AppResult<QueryResult> {
    // 带上编号标记,「停止」按钮才能在服务器的运行列表里找到这一条
    let sql = match run_id.as_deref().and_then(db::run_marker) {
        Some(marker) => format!("/* {marker} */ {sql}"),
        None => sql,
    };
    let target = requested_database(&state, &conn_id, database.as_deref()).await?;
    if let Some(cell) = state.sessions.read().await.get(&conn_id).cloned() {
        let mut session = cell.lock().await;
        let tx = session.transaction(&target)?;
        crate::readonly::validate_manual_sql(matches!(tx, db::SessionTx::MySql(_)), &sql)?;
        return db::run_query_on_tx(tx, &sql, max_rows).await;
    }
    let (_kind, pool) = pool_for_database(&state, &conn_id, database.as_deref()).await?;
    db::run_query(&pool, &sql, max_rows).await
}

/// 停止编辑器里正在跑的那条语句(run_query 时带的 run_id)。
/// 返回 true = 已让数据库取消;false = 没找到(已跑完)或这种库不支持服务器端取消。
#[tauri::command]
pub async fn cancel_query(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    run_id: String,
) -> AppResult<bool> {
    let marker = db::run_marker(&run_id).ok_or_else(|| AppError::msg("运行编号无效"))?;
    let (_kind, pool) = pool_for_database(&state, &conn_id, database.as_deref()).await?;
    Ok(db::cancel_marked_query(&pool, &marker).await? > 0)
}

/// Resolve an open connection by its human name or its id.
async fn resolve_open_conn(state: &State<'_, AppState>, conn: &str) -> AppResult<String> {
    let guard = state.conns.read().await;
    if conn.is_empty() {
        return match guard.len() {
            1 => Ok(guard.keys().next().unwrap().clone()),
            0 => Err(AppError::msg("没有已连接的数据库,先在左侧连上一个")),
            _ => {
                let names: Vec<String> = guard.values().map(|c| c.config.name.clone()).collect();
                Err(AppError::msg(format!(
                    "打开了多个连接,请用 conn= 指定:{}",
                    names.join(" / ")
                )))
            }
        };
    }
    for (id, c) in guard.iter() {
        if id == conn || c.config.name == conn {
            return Ok(id.clone());
        }
    }
    Err(AppError::msg(format!(
        "没有打开的连接叫「{conn}」;先在左侧连上它(或用连接名/ID)"
    )))
}

/// Run a query on a named/opened connection, for the Python `sonde` bridge.
/// Uses an isolated read-only transaction, independent of editor sessions.
pub async fn bridge_query(
    state: &State<'_, AppState>,
    conn: &str,
    database: Option<&str>,
    sql: &str,
    max_rows: Option<usize>,
) -> AppResult<QueryResult> {
    /* 桥是只读的。它的 API 叫 query、返回 DataFrame,文档写的是「查」——
       可原来走的是通用执行通道,一段手滑或 AI 生成的脚本能在生产库上 DROP 表,
       没有确认也没有提示。现在先校验语句，再由数据库只读事务限制函数副作用。 */
    crate::readonly::validate_bridge_sql(sql)?;
    let conn_id = resolve_open_conn(state, conn).await?;
    let (_kind, pool) = pool_for_database(state, &conn_id, database).await?;
    db::run_read_only_query(&pool, sql, &[], Some(max_rows.unwrap_or(10_000).clamp(1, 200_000)), std::time::Duration::from_secs(300)).await
}

/// Human names of every currently-open connection (for the bridge's `connections()`).
pub async fn bridge_conn_names(state: &State<'_, AppState>) -> Vec<String> {
    state
        .conns
        .read()
        .await
        .values()
        .map(|c| c.config.name.clone())
        .collect()
}

/// Process inspection never waits on the editor's held transaction.
#[tauri::command]
pub async fn list_processes(state: State<'_, AppState>, conn_id: String) -> AppResult<QueryResult> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let (kind, pool) = pool_for(&state, &conn_id).await?;
        let sql = process_query(kind)?;
        db::run_query(&pool, sql, Some(2000)).await
    }).await.map_err(|_| AppError::msg("读取会话超过 10 秒，请稍后刷新；其他页面仍可使用"))?
}

fn process_query(kind: DbKind) -> AppResult<&'static str> {
    match kind {
        DbKind::Mysql | DbKind::Mariadb => Ok("SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 2048) AS INFO FROM information_schema.processlist ORDER BY TIME DESC LIMIT 2001"),
        DbKind::Postgres => Ok("SELECT pid AS \"ID\", usename AS \"USER\", host(client_addr) AS \"HOST\", datname AS \"DB\", state AS \"COMMAND\", COALESCE(EXTRACT(EPOCH FROM (now() - query_start))::int, 0) AS \"TIME\", wait_event AS \"STATE\", LEFT(query, 2048) AS \"INFO\" FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY query_start NULLS LAST LIMIT 2001"),
        _ => Err(AppError::msg("此数据库不支持进程管理")),
    }
}

/// Kill a server-side session/process by id (MySQL/PostgreSQL).
#[tauri::command]
pub async fn kill_process(state: State<'_, AppState>, conn_id: String, id: i64) -> AppResult<()> {
    let (_kind, pool) = pool_for_database(&state, &conn_id, None).await?;
    db::kill_process(&pool, id).await
}

/// Execute a bounded, read-only dataset query for the dashboard engine.
/// This path never joins the editor's manual transaction and is guarded again
/// in Rust even when the frontend has already validated the SQL.
#[tauri::command]
pub async fn run_read_only_query(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    sql: String,
    max_rows: Option<usize>,
    filters: Option<Vec<ReadOnlyFilter>>,
    timeout_secs: Option<u64>,
) -> AppResult<QueryResult> {
    // 天花板 200k:看板运行时自身仍 clamp 到 5000(前端),只有「导出离线 HTML」
    // 需要把锁定范围内的明细一次性烘进文件时才会请求更大的量。
    let limit = max_rows.unwrap_or(1_000).clamp(1, 200_000);
    // 超时由调用方说了算,别拿一个数字管两种场景:看板组件刷新是用户盯着等的交互,
    // 30 秒到头很合理;AI 分析是跑几分钟也无所谓的后台活,被 30 秒掐掉只会白跑一趟。
    // 上限 300 秒 —— 再长的查询该去优化口径,不该在客户端这儿硬扛。
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(30).clamp(5, 300));
    let (kind, pool) = pool_for_database(&state, &conn_id, database.as_deref()).await?;
    let prepared = prepare_dashboard_query(kind, &sql, filters.as_deref().unwrap_or_default())?;
    db::run_read_only_query(&pool, &prepared.sql, &prepared.params, Some(limit), timeout).await
}

/// Turning autocommit on commits pending work. A failed commit leaves the
/// session blocked in manual mode so the UI cannot promise a rollback falsely.
#[tauri::command]
pub async fn set_autocommit(
    state: State<'_, AppState>, conn_id: String, enabled: bool, database: Option<String>,
) -> AppResult<()> {
    let target = requested_database(&state, &conn_id, database.as_deref()).await?;
    let mut sessions = state.sessions.write().await;
    if enabled {
        if let Some(cell) = sessions.get(&conn_id) {
            let mut session = cell.lock().await;
            if let Some(tx) = session.tx.take() { db::commit_tx(tx).await?; }
        }
        sessions.remove(&conn_id);
        state.autocommit.write().await.insert(conn_id, true);
    } else if let Some(cell) = sessions.get(&conn_id) {
        let mut session = cell.lock().await;
        if session.database != target { return Err(AppError::msg("已有其他数据库的手动事务，请先结束手动模式")); }
        if session.tx.is_none() { session.reopen().await?; }
    } else {
        let (_, pool) = pool_for_database(&state, &conn_id, Some(&target)).await?;
        let tx = db::begin_tx(&pool).await?;
        sessions.insert(conn_id.clone(), Arc::new(Mutex::new(ManualSession { database: target, pool, tx: Some(tx) })));
        state.autocommit.write().await.insert(conn_id, false);
    }
    Ok(())
}

async fn finish_session(state: &State<'_, AppState>, conn_id: &str, commit: bool) -> AppResult<()> {
    let cell = state.sessions.read().await.get(conn_id).cloned()
        .ok_or_else(|| AppError::msg("没有手动事务"))?;
    let mut session = cell.lock().await;
    let finished = match session.tx.take() {
        Some(tx) if commit => db::commit_tx(tx).await,
        Some(tx) => db::rollback_tx(tx).await,
        None => Ok(()),
    };
    let reopened = session.reopen().await;
    finished?;
    reopened
}
#[tauri::command]
pub async fn commit_session(state: State<'_, AppState>, conn_id: String) -> AppResult<()> {
    finish_session(&state, &conn_id, true).await
}
#[tauri::command]
pub async fn rollback_session(state: State<'_, AppState>, conn_id: String) -> AppResult<()> {
    finish_session(&state, &conn_id, false).await
}

#[tauri::command]
pub async fn update_cell(state: State<'_, AppState>, request: UpdateCellRequest) -> AppResult<u64> {
    apply_cell_edits(state, vec![request]).await
}

/// Apply a batch of staged cell edits atomically (one transaction per pooled
/// engine). All edits must target the same connection + database.
#[tauri::command]
pub async fn apply_cell_edits(
    state: State<'_, AppState>,
    edits: Vec<UpdateCellRequest>,
) -> AppResult<u64> {
    if edits.is_empty() {
        return Ok(0);
    }
    let conn_id = edits[0].conn_id.clone();
    let database = edits[0].database.clone();
    if edits.iter().any(|e| e.conn_id != conn_id || e.database != database) {
        return Err(AppError::msg("一批修改必须属于同一个连接和数据库"));
    }
    let target = requested_database(&state, &conn_id, Some(&database)).await?;
    if let Some(cell) = state.sessions.read().await.get(&conn_id).cloned() {
        let mut session = cell.lock().await;
        let pool = session.pool.clone();
        return db::edit::apply_edits_on_tx(&pool, session.transaction(&target)?, &edits).await;
    }
    let (_kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    db::edit::apply_edits(&pool, &edits).await
}

/// 一批写语句跑在**同一笔事务**里:要么全成,要么一条都不留。
///
/// 表详情里的"增行/删行"和"整列赋值"原来是散装 `run_query` 一条一条发的。
/// 删到第三条炸了,前两条已经生效;错误往上抛、界面的 setRows 不执行,
/// 于是表格还显示着那两行。用户再点一次保存,插入那批就重复插了一遍。
/// 单元格改动那条路(apply_cell_edits)本来就是包在事务里的 —— 同一个应用里
/// 两套做法,这儿补齐。
///
/// Oracle / ClickHouse 没有可回滚的会话事务,只能一条条来。那就不假装原子,
/// 出错时把"前几条已经生效"写进错误里,让用户知道该去核对什么。
#[tauri::command]
pub async fn run_statements(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    statements: Vec<String>,
) -> AppResult<u64> {
    if statements.is_empty() {
        return Ok(0);
    }
    let target = requested_database(&state, &conn_id, database.as_deref()).await?;
    if let Some(cell) = state.sessions.read().await.get(&conn_id).cloned() {
        let mut session = cell.lock().await;
        let tx = session.transaction(&target)?;
        for sql in &statements { crate::readonly::validate_manual_sql(matches!(tx, db::SessionTx::MySql(_)), sql)?; }
        return db::run_statements_on_tx(tx, &statements).await;
    }
    let (_kind, pool) = pool_for_database(&state, &conn_id, database.as_deref()).await?;
    db::run_statements(&pool, &statements).await
}

// --- demo database ---------------------------------------------------------

/// Create (or reuse) a local SQLite demo database seeded with sample data, and
/// register it as a saved connection. Lets the app do something useful with no
/// external server.
#[tauri::command]
pub async fn create_demo(app: AppHandle) -> AppResult<ConnectionConfig> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("cannot resolve config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("demo.db");
    let db_path_str = db_path.to_string_lossy().to_string();

    let cfg = ConnectionConfig {
        id: "demo-sqlite".to_string(),
        name: "Demo (SQLite)".to_string(),
        kind: DbKind::Sqlite,
        host: String::new(),
        port: 0,
        username: String::new(),
        database: db_path_str.clone(),
        ssl_mode: None,
        color: Some("#3b9c7a".to_string()),
        brand: None,
        oracle_thick: false,
    };

    let info = db::connect(&cfg, None).await?;
    if let DbPool::Sqlite(pool) = &info.pool {
        seed_demo(pool).await?;
    }
    drop(info);

    // Register it as a saved connection (idempotent upsert).
    let mut list = store::load_connections(&app)?;
    if !list.iter().any(|c| c.id == cfg.id) {
        list.push(cfg.clone());
        store::save_connections(&app, &list)?;
    }
    Ok(cfg)
}

async fn seed_demo(pool: &sqlx::SqlitePool) -> AppResult<()> {
    // Only seed once.
    let already: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='demo_sales'",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if already > 0 {
        return Ok(());
    }

    let ddl = [
        "CREATE TABLE demo_customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, created_at TEXT)",
        "CREATE TABLE demo_products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, price REAL)",
        "CREATE TABLE demo_sales (id INTEGER PRIMARY KEY, sale_date TEXT NOT NULL, product_id INTEGER, amount REAL, quantity INTEGER)",
    ];
    for stmt in ddl {
        sqlx::query(stmt).execute(pool).await?;
    }

    let customers = [
        ("Aria Chen", "Shanghai"),
        ("Bruno Sato", "Osaka"),
        ("Carla Dubois", "Paris"),
        ("Dmitri Ivanov", "Berlin"),
        ("Elena Rossi", "Milan"),
    ];
    for (i, (name, city)) in customers.iter().enumerate() {
        sqlx::query("INSERT INTO demo_customers (id, name, city, created_at) VALUES (?, ?, ?, ?)")
            .bind((i + 1) as i64)
            .bind(name)
            .bind(city)
            .bind("2026-05-01")
            .execute(pool)
            .await?;
    }

    let products = [
        ("Nimbus Keyboard", "Peripherals", 89.0),
        ("Halo Monitor 27\"", "Displays", 329.0),
        ("Pulse Mouse", "Peripherals", 45.0),
        ("Aurora Dock", "Accessories", 129.0),
    ];
    for (i, (name, cat, price)) in products.iter().enumerate() {
        sqlx::query("INSERT INTO demo_products (id, name, category, price) VALUES (?, ?, ?, ?)")
            .bind((i + 1) as i64)
            .bind(name)
            .bind(cat)
            .bind(price)
            .execute(pool)
            .await?;
    }

    // 30 days of sales, gently wavy so the chart view has something to show.
    for day in 1..=30i64 {
        let amount = 6000.0 + ((day as f64 * 0.7).sin() * 250.0) + (day as f64 * 4.0);
        let quantity = 700 + ((day as f64 * 0.9).cos() * 40.0) as i64 + day;
        let date = format!("2026-06-{day:02}");
        sqlx::query(
            "INSERT INTO demo_sales (sale_date, product_id, amount, quantity) VALUES (?, ?, ?, ?)",
        )
        .bind(&date)
        .bind((day % 4) + 1)
        .bind((amount * 100.0).round() / 100.0)
        .bind(quantity)
        .execute(pool)
        .await?;
    }

    Ok(())
}

// --- bulk ETL config import (read *.json under a picked folder) -------------

#[derive(serde::Serialize)]
pub struct ImportedFile {
    pub name: String,
    pub content: String,
}

/// Read every *.json under `dir` (recursively) as {relative name, content}.
/// Used by the ETL center to bulk-import a folder of DataX job configs. The
/// folder is chosen by the user via a native dialog; we only read what's there.
// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn read_json_dir(dir: String) -> AppResult<Vec<ImportedFile>> {
    let root = std::path::PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(AppError::msg("不是一个文件夹"));
    }
    let mut out: Vec<ImportedFile> = Vec::new();
    fn walk(base: &std::path::Path, cur: &std::path::Path, out: &mut Vec<ImportedFile>) {
        if out.len() >= 4000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(cur) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if e.metadata().map(|m| m.len() > 4_000_000).unwrap_or(false) {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&p) {
                    let name = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().into_owned();
                    out.push(ImportedFile { name, content });
                }
            }
        }
    }
    walk(&root, &root, &mut out);
    Ok(out)
}


/// Preview and execution share one identifier-only SQL builder.
#[tauri::command]
pub async fn preview_drop_object(
    state: State<'_, AppState>,
    conn_id: String,
    object_kind: String,
    database: String,
    schema: Option<String>,
    table: Option<String>,
) -> AppResult<String> {
    let (kind, _) = pool_for(&state, &conn_id).await?;
    db::drop_object::statement(
        kind,
        &object_kind,
        &database,
        schema.as_deref().unwrap_or(""),
        table.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
pub async fn drop_object(
    state: State<'_, AppState>,
    conn_id: String,
    object_kind: String,
    database: String,
    schema: Option<String>,
    table: Option<String>,
    confirmation: String,
) -> AppResult<()> {
    let target = if object_kind == "database" {
        database.as_str()
    } else {
        table.as_deref().unwrap_or("")
    };
    if target.is_empty() || confirmation != target {
        return Err(AppError::msg("输入的确认名称与删除对象不一致"));
    }
    if state.autocommit.read().await.get(&conn_id) == Some(&false) {
        return Err(AppError::msg(
            "请先处理当前事务并切回自动提交模式，再删除对象",
        ));
    }
    let (kind, current_database, mut config, password) = {
        let conns = state.conns.read().await;
        let c = conns
            .get(&conn_id)
            .ok_or_else(|| AppError::NotConnected(conn_id.clone()))?;
        (
            c.kind,
            c.current_database.clone(),
            c.config.clone(),
            c.session_password.clone(),
        )
    };
    let sql = db::drop_object::statement(
        kind,
        &object_kind,
        &database,
        schema.as_deref().unwrap_or(""),
        table.as_deref().unwrap_or(""),
    )?;
    if object_kind == "table" {
        let (_, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
        db::run_query(&pool, &sql, Some(0)).await?;
    } else {
        if kind == DbKind::Postgres && database == current_database {
            return Err(AppError::msg(
                "PostgreSQL 不能删除当前连接所在的库，请连接其他数据库后再操作",
            ));
        }
        if matches!(kind, DbKind::Mysql | DbKind::Mariadb) {
            config.database = String::new();
        }
        if kind == DbKind::Clickhouse { config.database = "system".to_string(); }
        let admin = db::connect(&config, password.as_deref()).await?;
        // Execute exactly once on an independent connection, never a held transaction.
        db::run_query(&admin.pool, &sql, Some(0)).await?;
        state
            .database_pools
            .write()
            .await
            .remove(&database_pool_key(&conn_id, &database));
        if matches!(kind, DbKind::Mysql | DbKind::Mariadb | DbKind::Clickhouse) && database == current_database {
            if let Some(active) = state.conns.write().await.get_mut(&conn_id) {
                active.pool = admin.pool;
                active.current_database = admin.current_database;
                active.config.database = config.database;
            }
        }
    }
    Ok(())
}


#[tauri::command]
pub async fn get_routine_details(state: State<'_, AppState>, conn_id:String, database:String, schema:String, name:String, kind:String) -> AppResult<db::routines::Details> {
    let (_,pool)=pool_for_database(&state,&conn_id,Some(&database)).await?;
    db::routines::details(&pool,&database,&schema,&name,&kind).await
}
#[tauri::command]
pub async fn execute_routine(state: State<'_, AppState>, conn_id:String, database:String, schema:String, name:String, kind:String, values:Vec<Option<String>>) -> AppResult<QueryResult> {
    let (_,pool)=pool_for_database(&state,&conn_id,Some(&database)).await?;
    let details=db::routines::details(&pool,&database,&schema,&name,&kind).await?;
    if let Some(cell)=state.sessions.read().await.get(&conn_id).cloned(){
        let mut session=cell.lock().await;
        let tx=session.transaction(&database)?;
        if matches!(tx, db::SessionTx::MySql(_)) {
            return Err(AppError::msg("MySQL 存储过程可能自行提交，手动模式下已阻止执行"));
        }
            let sets=match tx {
                db::SessionTx::MySql(tx)=>db::routines::execute_mysql(&mut **tx,&database,&details,&values).await?,
                db::SessionTx::Postgres(tx)=>db::routines::execute_pg(&mut **tx,&schema,&details,&values).await?,
                _=>return Err(AppError::msg("该数据库不支持此例程执行面板")),
            };return Ok(db::routines::combine(sets));
    }
    let sets=match pool{
        DbPool::MySql(pool)=>db::routines::execute_mysql(&mut *pool.acquire().await?,&database,&details,&values).await?,
        DbPool::Postgres(pool)=>db::routines::execute_pg(&mut *pool.acquire().await?,&schema,&details,&values).await?,
        _=>return Err(AppError::msg("该数据库不支持此例程执行面板")),
    };Ok(db::routines::combine(sets))
}
