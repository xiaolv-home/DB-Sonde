//! Thick mode — ODPI-C `oracle` crate, loads an installed Oracle Instant Client at runtime.

use super::{esc, meta, quote_ident, rows_error, OracleConn};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::Value;

use crate::db::{ConnectInfo, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{
    ColumnInfo, ColumnMeta, ConnectionConfig, IndexInfo, QueryResult, RoutineInfo, TableInfo,
    UpdateCellRequest,
};

type Handle = Arc<Mutex<oracle::Connection>>;

fn oe(e: oracle::Error) -> AppError {
    AppError::msg(format!("Oracle: {e}"))
}

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectInfo> {
    let user = cfg.username.clone();
    let pass = password.unwrap_or("").to_string();
    let host = if cfg.host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        cfg.host.clone()
    };
    let port = if cfg.port == 0 { 1521 } else { cfg.port };
    let service = cfg.database.clone();
    if service.is_empty() {
        return Err(AppError::msg(
            "Oracle needs a service name (or SID) in the Database field, e.g. ORCLPDB1.",
        ));
    }
    let connect_string = format!("//{host}:{port}/{service}");

    let (handle, server_version, current_schema) = tokio::task::spawn_blocking(
        move || -> AppResult<(Handle, String, String)> {
            let mut conn = oracle::Connection::connect(&user, &pass, &connect_string).map_err(oe)?;
            conn.set_autocommit(true);
            let server_version = conn.server_version().map(|(_, banner)| banner).unwrap_or_default();
            let current_schema = conn
                .query_row("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL", &[])
                .ok()
                .and_then(|row| row.get::<usize, String>(0).ok())
                .unwrap_or_else(|| user.to_uppercase());
            Ok((Arc::new(Mutex::new(conn)), server_version, current_schema))
        },
    )
    .await
    .map_err(|e| AppError::msg(format!("oracle connect task failed: {e}")))??;

    Ok(ConnectInfo {
        pool: DbPool::Oracle(OracleConn::Thick(handle)),
        server_version,
        current_database: current_schema,
    })
}

fn fetch_strings(conn: &oracle::Connection, sql: &str) -> AppResult<Vec<Vec<Option<String>>>> {
    let rows = conn.query(sql, &[]).map_err(oe)?;
    let ncols = rows.column_info().len();
    let mut out = Vec::new();
    for row in rows {
        let row = row.map_err(oe)?;
        let mut cells = Vec::with_capacity(ncols);
        for i in 0..ncols {
            cells.push(row.get::<usize, Option<String>>(i).unwrap_or(None));
        }
        out.push(cells);
    }
    Ok(out)
}

fn oracle_cell(row: &oracle::Row, col_type: &str, i: usize) -> Value {
    let numeric = col_type.contains("NUMBER")
        || col_type.contains("FLOAT")
        || col_type.contains("BINARY_DOUBLE")
        || col_type.contains("BINARY_FLOAT");
    if numeric {
        if let Ok(v) = row.get::<usize, Option<i64>>(i) {
            return v.map(crate::db::value::exact_integer).unwrap_or(Value::Null);
        }
        if let Ok(v) = row.get::<usize, Option<f64>>(i) {
            return v.map(Value::from).unwrap_or(Value::Null);
        }
    }
    match row.get::<usize, Option<String>>(i) {
        Ok(Some(s)) => Value::String(s),
        _ => Value::Null,
    }
}

fn run_query_blocking(conn: &oracle::Connection, sql: &str, cap: usize) -> AppResult<QueryResult> {
    let started = Instant::now();
    if crate::db::returns_rows(sql) {
        let rows = conn.query(sql, &[]).map_err(oe)?;
        let columns: Vec<ColumnMeta> = rows
            .column_info()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.oracle_type().to_string(),
            })
            .collect();
        let col_types: Vec<String> = rows
            .column_info()
            .iter()
            .map(|c| c.oracle_type().to_string().to_ascii_uppercase())
            .collect();
        let mut out: Vec<Vec<Value>> = Vec::new();
        let mut truncated = false;
        for row in rows {
            if out.len() >= cap {
                truncated = true;
                break;
            }
            let row = row.map_err(oe)?;
            let mut cells = Vec::with_capacity(col_types.len());
            for (i, ty) in col_types.iter().enumerate() {
                cells.push(oracle_cell(&row, ty, i));
            }
            out.push(cells);
        }
        Ok(QueryResult {
        additional_results: None,
            columns,
            rows: out,
            rows_affected: None,
            truncated,
            elapsed_ms: started.elapsed().as_millis(),
            message: None,
        })
    } else {
        let stmt = conn.execute(sql, &[]).map_err(oe)?;
        let affected = stmt.row_count().unwrap_or(0);
        Ok(QueryResult {
        additional_results: None,
            rows_affected: Some(affected),
            message: Some(format!("{affected} row(s) affected")),
            elapsed_ms: started.elapsed().as_millis(),
            ..Default::default()
        })
    }
}

pub async fn run_query(handle: &Handle, sql: &str, cap: usize) -> AppResult<QueryResult> {
    let h = handle.clone();
    let sql = sql.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = h.lock().map_err(|_| AppError::msg("oracle connection busy"))?;
        run_query_blocking(&conn, &sql, cap)
    })
    .await
    .map_err(|e| AppError::msg(format!("oracle task failed: {e}")))?
}

pub async fn list_schemas(handle: &Handle) -> AppResult<Vec<String>> {
    let h = handle.clone();
    tokio::task::spawn_blocking(move || {
        let conn = h.lock().map_err(|_| AppError::msg("oracle connection busy"))?;
        let rows = fetch_strings(&conn, "SELECT DISTINCT owner FROM all_tables ORDER BY owner")?;
        Ok(rows.into_iter().filter_map(|r| r.into_iter().next().flatten()).collect())
    })
    .await
    .map_err(|e| AppError::msg(format!("oracle task failed: {e}")))?
}

pub async fn list_tables(handle: &Handle, owner: &str) -> AppResult<Vec<TableInfo>> {
    let h = handle.clone();
    let owner = owner.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = h.lock().map_err(|_| AppError::msg("oracle connection busy"))?;
        let mut out: Vec<TableInfo> = fetch_strings(&conn, &meta::tables_sql(&owner))?.iter().filter_map(|r| meta::table_from(r)).collect();
        out.extend(fetch_strings(&conn, &meta::views_sql(&owner))?.iter().filter_map(|r| meta::view_from(r)));
        Ok(out)
    })
    .await
    .map_err(|e| AppError::msg(format!("oracle task failed: {e}")))?
}

pub async fn list_columns(handle: &Handle, owner: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let h = handle.clone();
    let (owner, table) = (owner.to_string(), table.to_string());
    tokio::task::spawn_blocking(move || {
        let conn = h.lock().map_err(|_| AppError::msg("oracle connection busy"))?;
        let pks = meta::primary_keys(&fetch_strings(&conn, &meta::primary_key_sql(&owner, &table))?);
        Ok(fetch_strings(&conn, &meta::columns_sql(&owner, &table))?.iter().filter_map(|r| meta::column_from(r, &pks)).collect())
    })
    .await
    .map_err(|e| AppError::msg(format!("oracle task failed: {e}")))?
}

pub async fn list_routines(handle: &Handle, owner: &str) -> AppResult<Vec<RoutineInfo>> {
    let h = handle.clone();
    let owner = owner.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = h.lock().map_err(|_| AppError::msg("oracle connection busy"))?;
        let o = esc(&owner);
        let rows = fetch_strings(
            &conn,
            &format!(
                "SELECT object_name, object_type FROM all_objects \
                 WHERE owner = '{o}' AND object_type IN ('PROCEDURE', 'FUNCTION') \
                 ORDER BY object_type, object_name"
            ),
        )?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = r.first().and_then(|v| v.clone())?;
                let otype = r.get(1).and_then(|v| v.clone()).unwrap_or_default();
                Some(RoutineInfo {
                    name,
                    kind: if otype.eq_ignore_ascii_case("PROCEDURE") {
                        "procedure".into()
                    } else {
                        "function".into()
                    },
                    language: Some("PL/SQL".into()),
                    return_type: None,
                    comment: None,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| AppError::msg(format!("oracle task failed: {e}")))?
}

pub async fn list_indexes(handle: &Handle, owner: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    let h = handle.clone();
    let owner = owner.to_string();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = h.lock().map_err(|_| AppError::msg("oracle connection busy"))?;
        let o = esc(&owner);
        let tb = esc(&table);
        let rows = fetch_strings(
            &conn,
            &format!(
                "SELECT i.index_name, i.uniqueness, i.index_type, ic.column_name \
                 FROM all_indexes i \
                 JOIN all_ind_columns ic ON i.owner = ic.index_owner \
                   AND i.index_name = ic.index_name \
                 WHERE i.table_owner = '{o}' AND i.table_name = '{tb}' \
                 ORDER BY i.index_name, ic.column_position"
            ),
        )?;
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for r in rows {
            let name = r.first().and_then(|v| v.clone()).unwrap_or_default();
            let unique = r
                .get(1)
                .and_then(|v| v.clone())
                .map(|s| s.eq_ignore_ascii_case("UNIQUE"))
                .unwrap_or(false);
            let index_type = r.get(2).and_then(|v| v.clone());
            let column = r.get(3).and_then(|v| v.clone()).unwrap_or_default();
            if let Some(existing) = indexes.iter_mut().find(|x| x.name == name) {
                existing.columns.push(column);
            } else {
                indexes.push(IndexInfo {
                    name,
                    columns: vec![column],
                    unique,
                    primary: false,
                    index_type,
                    definition: None,
                });
            }
        }
        Ok(indexes)
    })
    .await
    .map_err(|e| AppError::msg(format!("oracle task failed: {e}")))?
}

pub async fn get_object_ddl(
    handle: &Handle,
    owner: &str,
    table: &str,
    object_kind: &str,
) -> AppResult<String> {
    let h = handle.clone();
    let owner = owner.to_string();
    let table = table.to_string();
    let object_kind = object_kind.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = h.lock().map_err(|_| AppError::msg("oracle connection busy"))?;
        let obj = if object_kind.eq_ignore_ascii_case("view") {
            "VIEW"
        } else {
            "TABLE"
        };
        let o = esc(&owner);
        let tb = esc(&table);
        match fetch_strings(
            &conn,
            &format!("SELECT DBMS_METADATA.GET_DDL('{obj}', '{tb}', '{o}') FROM DUAL"),
        ) {
            Ok(rows) => Ok(rows
                .into_iter()
                .next()
                .and_then(|r| r.into_iter().next().flatten())
                .unwrap_or_default()),
            Err(e) => Ok(format!("-- DDL unavailable (DBMS_METADATA): {e}")),
        }
    })
    .await
    .map_err(|e| AppError::msg(format!("oracle task failed: {e}")))?
}

fn to_bind(v: &Value) -> Box<dyn oracle::sql_type::ToSql> {
    match v {
        Value::Null => Box::new(Option::<String>::None),
        Value::Bool(b) => Box::new(if *b { 1i64 } else { 0i64 }),
        Value::Number(n) if n.is_i64() => Box::new(n.as_i64().unwrap_or(0)),
        Value::Number(n) if n.is_u64() => Box::new(n.as_u64().unwrap_or(0) as i64),
        Value::Number(n) => Box::new(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

pub async fn update_cell(handle: &Handle, request: UpdateCellRequest) -> AppResult<u64> {
    let h = handle.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = h.lock().map_err(|_| AppError::msg("oracle connection busy"))?;
        let table_ref = format!("{}.{}", quote_ident(&request.schema), quote_ident(&request.table));
        let set_col = quote_ident(&request.column);

        let pks: Vec<(&String, &Value)> = request.primary_key.iter().collect();
        let mut clauses: Vec<String> = Vec::new();
        for (i, (col, _)) in pks.iter().enumerate() {
            let qc = quote_ident(col.as_str());
            clauses.push(format!("({qc} = :pk_{i} OR ({qc} IS NULL AND :pk_{i} IS NULL))"));
        }
        clauses.push(format!("({set_col} = :old OR ({set_col} IS NULL AND :old IS NULL))"));
        let sql = format!("UPDATE {table_ref} SET {set_col} = :new WHERE {}", clauses.join(" AND "));

        let new_bind = to_bind(&request.new_value);
        let old_bind = to_bind(&request.old_value);
        let pk_names: Vec<String> = (0..pks.len()).map(|i| format!("pk_{i}")).collect();
        let pk_binds: Vec<Box<dyn oracle::sql_type::ToSql>> =
            pks.iter().map(|(_, v)| to_bind(v)).collect();

        let mut params: Vec<(&str, &dyn oracle::sql_type::ToSql)> = Vec::new();
        params.push(("new", new_bind.as_ref()));
        for (i, name) in pk_names.iter().enumerate() {
            params.push((name.as_str(), pk_binds[i].as_ref()));
        }
        params.push(("old", old_bind.as_ref()));

        /* 同 thin:命中行数要在提交之前查。这个连接是 set_autocommit(true) 建的,
           所以得临时关掉自动提交,自己决定 commit 还是 rollback ——
           并且**任何一条返回路径都要把它恢复回去**,否则后面所有写操作都不再提交,
           用户会看到「改了但没生效」,而且完全看不出跟这次编辑有关。

           靠包一层闭包来保证:里面的 ? 返回的是闭包、不是这个函数,所以
           set_autocommit(true) 一定跑得到。别图省事把闭包拆掉 —— 拆了之后
           任何一个 ? 都会带着「自动提交还关着」的连接直接返回。
           (中途 panic 的话 Mutex 会中毒,这条连接后续一律报 busy ——
           那是显式坏掉,不会变成悄悄不提交。) */
        conn.set_autocommit(false);
        let outcome = (|| {
            let stmt = conn.execute_named(&sql, &params).map_err(oe)?;
            let affected = stmt.row_count().map_err(oe)?;
            if affected != 1 {
                let _ = conn.rollback();
                return Err(rows_error(affected));
            }
            conn.commit().map_err(oe)?;
            Ok(affected)
        })();
        conn.set_autocommit(true);
        outcome
    })
    .await
    .map_err(|e| AppError::msg(format!("oracle task failed: {e}")))?
}
