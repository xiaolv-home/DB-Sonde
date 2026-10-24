//! 执行:编辑器查询与停止、看板只读查询、手动提交会话、改单元格、批量语句、服务器进程;Python `sonde` 桥的查库也走这里。

use std::sync::Arc;

use tauri::State;
use tokio::sync::Mutex;

use super::{pool_for, pool_for_database, requested_database, AppState, ManualSession};
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{DbKind, QueryResult, UpdateCellRequest};
use crate::readonly::{prepare_dashboard_query, ReadOnlyFilter};

#[tauri::command]
pub async fn run_query(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    sql: String,
    max_rows: Option<usize>,
    run_id: Option<String>,
) -> AppResult<QueryResult> {
    // 带上编号标记,「停止」按钮才能在服务器的运行列表里找到这一条。
    // 只给能按标记取消的库加(MySQL / MariaDB / PostgreSQL):别的库用不上,
    // 而 Oracle 的 thin 驱动看到开头是注释会认错语句类型、发出畸形包,服务端直接掐断连接(ORA-03137/03138)。
    let kind = state.conns.read().await.get(&conn_id).map(|active| active.kind);
    let sql = match run_id.as_deref().and_then(db::run_marker) {
        Some(marker) if kind.is_some_and(db::cancel_supported) => format!("/* {marker} */ {sql}"),
        _ => sql,
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
    // 第 i 条必须正好影响几行(表格删行用);None / 不传 = 不核对
    expect_rows: Option<Vec<Option<u64>>>,
) -> AppResult<u64> {
    if statements.is_empty() {
        return Ok(0);
    }
    let expect = expect_rows.unwrap_or_default();
    let target = requested_database(&state, &conn_id, database.as_deref()).await?;
    if let Some(cell) = state.sessions.read().await.get(&conn_id).cloned() {
        let mut session = cell.lock().await;
        let tx = session.transaction(&target)?;
        for sql in &statements { crate::readonly::validate_manual_sql(matches!(tx, db::SessionTx::MySql(_)), sql)?; }
        return db::run_statements_on_tx(tx, &statements, &expect).await;
    }
    let (_kind, pool) = pool_for_database(&state, &conn_id, database.as_deref()).await?;
    db::run_statements(&pool, &statements, &expect).await
}
