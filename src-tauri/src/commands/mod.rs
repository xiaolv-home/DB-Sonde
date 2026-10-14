//! 前端调的数据库命令。这里放它们共用的:打开的连接、手动提交会话,以及按连接 / 库取连接池。

use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;
use tokio::sync::{Mutex, RwLock};

use crate::db::{self, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionConfig, DbKind};

pub mod connections;
pub mod objects;
pub mod query;

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
