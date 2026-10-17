//! 对象树:库 / 模式 / 表 / 字段 / 索引 / 例程 / DDL,删除对象(先预览再执行),存储过程详情与执行。

use tauri::State;

use super::{database_pool_key, pool_for, pool_for_database, AppState};
use crate::db::{self, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{ColumnInfo, DbKind, IndexInfo, QueryResult, RoutineInfo, TableInfo};

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
    drop_sql(&state, &conn_id, &object_kind, &database, schema.as_deref().unwrap_or(""), table.as_deref().unwrap_or("")).await
}

/// 生成删除语句。PostgreSQL 的物化视图在树上和普通视图一样显示成「视图」,
/// 可它只能用 DROP MATERIALIZED VIEW 删 —— 这里先查一下它到底是哪种。
async fn drop_sql(
    state: &State<'_, AppState>,
    conn_id: &str,
    object_kind: &str,
    database: &str,
    schema: &str,
    name: &str,
) -> AppResult<String> {
    let (kind, _) = pool_for(state, conn_id).await?;
    let mut object_kind = object_kind;
    if kind == DbKind::Postgres && object_kind == "view" {
        let (_, pool) = pool_for_database(state, conn_id, Some(database)).await?;
        if let DbPool::Postgres(pg) = &pool {
            let relkind: Option<String> = sqlx::query_scalar(
                "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2",
            )
            .bind(schema)
            .bind(name)
            .fetch_optional(pg)
            .await?;
            if relkind.as_deref() == Some("m") {
                object_kind = "materialized_view";
            }
        }
    }
    db::drop_object::statement(kind, object_kind, database, schema, name)
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
    let sql = drop_sql(&state, &conn_id, &object_kind, &database, schema.as_deref().unwrap_or(""), table.as_deref().unwrap_or("")).await?;
    // 表、视图、存储过程、函数都在所属库的连接上删;只有删整个库要另开一条不在那个库里的连接
    if object_kind != "database" {
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
        DbPool::MySql(db::MySql { pool, .. })=>db::routines::execute_mysql(&mut *pool.acquire().await?,&database,&details,&values).await?,
        DbPool::Postgres(pool)=>db::routines::execute_pg(&mut *pool.acquire().await?,&schema,&details,&values).await?,
        _=>return Err(AppError::msg("该数据库不支持此例程执行面板")),
    };Ok(db::routines::combine(sets))
}

/// 表结构页双击改注释 / 数据类型:先预检查(会执行什么、改类型时整列数据能不能转),确认后再执行。
#[tauri::command]
pub async fn plan_column_change(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    column: Option<String>,
    change: db::alter_column::Change,
) -> AppResult<db::alter_column::Plan> {
    let (kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    let target = db::alter_column::TableRef {
        pool: &pool, kind, database: &database, schema: schema.as_deref().unwrap_or(""), table: &table, column: column.as_deref(),
    };
    db::alter_column::plan(&target, &change).await
}

#[tauri::command]
pub async fn apply_column_change(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    column: Option<String>,
    change: db::alter_column::Change,
) -> AppResult<()> {
    if state.autocommit.read().await.get(&conn_id) == Some(&false) {
        return Err(AppError::msg("请先处理当前事务并切回自动提交模式,再改表结构"));
    }
    let (kind, pool) = pool_for_database(&state, &conn_id, Some(&database)).await?;
    let target = db::alter_column::TableRef {
        pool: &pool, kind, database: &database, schema: schema.as_deref().unwrap_or(""), table: &table, column: column.as_deref(),
    };
    db::alter_column::apply(&target, &change).await
}
