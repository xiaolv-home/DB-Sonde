//! ClickHouse driver over the HTTP interface (default port 8123, HTTPS 8443).
//!
//! ClickHouse isn't sqlx-compatible, so — like `oracle_driver` — it lives in its
//! own module behind the `DbPool::ClickHouse(ClickHouseHandle)` arm. It speaks
//! the HTTP API with `FORMAT JSON`, which is self-describing (meta + data), so
//! rows map straight onto `serde_json::Value`. Read-first: no cell editing and
//! no manual-commit transactions (ClickHouse has neither in the usual sense).

use std::time::Instant;

use serde_json::Value as Json;

use super::{ConnectInfo, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{ColumnInfo, ColumnMeta, ConnectionConfig, IndexInfo, QueryResult, RoutineInfo, TableInfo};

/// A ClickHouse HTTP endpoint plus the credentials/database to run against.
#[derive(Clone)]
pub struct ClickHouseHandle {
    client: reqwest::Client,
    url: String, // scheme://host:port/
    user: String,
    password: String,
    database: String,
}

fn bt(s: &str) -> String {
    s.replace('`', "``")
}
/// Escape a single-quoted SQL string literal (ClickHouse uses backslash escapes).
fn lit(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}
fn json_to_string(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::String(s) => s.clone(),
        other => other.to_string(),
    }
}
fn json_i64(v: Option<&Json>) -> Option<i64> {
    match v? {
        Json::Number(n) => n.as_i64(),
        Json::String(s) => s.parse().ok(),
        _ => None,
    }
}
/// Append `FORMAT JSON` to a row-returning statement unless it already sets one.
fn with_json_format(sql: &str) -> String {
    let t = sql.trim().trim_end_matches(';').trim();
    if t.to_uppercase().rsplit_once(" FORMAT ").is_some() {
        t.to_string()
    } else {
        format!("{t}\nFORMAT JSON")
    }
}

mod http;
pub use http::QueryOptions;

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectInfo> {
    let url = http::endpoint(cfg)?;
    let client = http::client()?;
    let user = if cfg.username.trim().is_empty() { "default".to_string() } else { cfg.username.clone() };
    let database = if cfg.database.trim().is_empty() { "default".to_string() } else { cfg.database.clone() };
    let handle = ClickHouseHandle {
        client,
        url,
        user,
        password: password.unwrap_or("").to_string(),
        database: database.clone(),
    };

    // A real round-trip so connection/auth failures surface at connect time.
    let server_version = handle
        .scalar("SELECT version()")
        .await
        .ok_or_else(|| AppError::msg("无法连接 ClickHouse(检查地址/端口/账号,HTTP 接口默认 8123)"))?;
    let current_database = handle.scalar("SELECT currentDatabase()").await.unwrap_or(database);

    Ok(ConnectInfo {
        pool: DbPool::ClickHouse(handle),
        server_version: format!("ClickHouse {server_version}"),
        current_database,
    })
}

pub async fn run_query(handle: &ClickHouseHandle, sql: &str, cap: usize) -> AppResult<QueryResult> {
    run_query_with_options(handle, sql, cap, QueryOptions::new(None, None)).await
}

pub async fn run_query_with_options(handle: &ClickHouseHandle, sql: &str, cap: usize, options: QueryOptions) -> AppResult<QueryResult> {
    let started = Instant::now();

    if !super::returns_rows(sql) {
        handle.execute(sql, &options).await?;
        return Ok(QueryResult {
            additional_results: None,
            message: Some("语句已执行(ClickHouse 不返回受影响行数)".into()),
            rows_affected: Some(0),
            elapsed_ms: started.elapsed().as_millis(),
            ..Default::default()
        });
    }

    let text = handle.execute(&with_json_format(sql), &options).await?;
    let j: Json = serde_json::from_str(&text).map_err(|e| AppError::msg(format!("解析 ClickHouse 响应失败: {e}")))?;
    let columns: Vec<ColumnMeta> = j
        .get("meta")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .map(|c| ColumnMeta {
                    name: c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    type_name: c.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

    let mut rows: Vec<Vec<Json>> = Vec::new();
    let mut truncated = false;
    if let Some(data) = j.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if rows.len() >= cap {
                truncated = true;
                break;
            }
            let obj = item.as_object();
            rows.push(
                names
                    .iter()
                    .map(|n| super::value::exact_json_integer(obj.and_then(|o| o.get(n)).cloned().unwrap_or(Json::Null)))
                    .collect(),
            );
        }
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

/// Databases (ClickHouse has no schema layer; databases are the top level).
pub async fn list_schemas(handle: &ClickHouseHandle) -> AppResult<Vec<String>> {
    let j = handle
        .query_json(
            "SELECT name FROM system.databases \
             WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY name",
        )
        .await?;
    Ok(rows_col(&j, "name"))
}

pub async fn list_tables(handle: &ClickHouseHandle, database: &str) -> AppResult<Vec<TableInfo>> {
    let db = if database.is_empty() { handle.database.clone() } else { database.to_string() };
    let j = handle
        .query_json(&format!(
            "SELECT name, engine, total_rows, total_bytes, comment \
             FROM system.tables WHERE database = '{}' ORDER BY name",
            lit(&db)
        ))
        .await?;
    let empty = Vec::new();
    let data = j.get("data").and_then(|d| d.as_array()).unwrap_or(&empty);
    Ok(data
        .iter()
        .map(|r| {
            let engine = r.get("engine").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let is_view = engine.contains("View");
            TableInfo {
                name: r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                kind: if is_view { "view" } else { "table" }.to_string(),
                engine: if engine.is_empty() { None } else { Some(engine) },
                estimated_rows: json_i64(r.get("total_rows")),
                data_size: json_i64(r.get("total_bytes")),
                comment: r.get("comment").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from),
                collation: None,
            }
        })
        .collect())
}

pub async fn list_columns(handle: &ClickHouseHandle, database: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let db = if database.is_empty() { handle.database.clone() } else { database.to_string() };
    let j = handle
        .query_json(&format!(
            "SELECT name, type, comment, is_in_primary_key, default_expression, position \
             FROM system.columns WHERE database = '{}' AND table = '{}' ORDER BY position",
            lit(&db),
            lit(table)
        ))
        .await?;
    let empty = Vec::new();
    let data = j.get("data").and_then(|d| d.as_array()).unwrap_or(&empty);
    Ok(data
        .iter()
        .map(|r| {
            let ty = r.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let default = r.get("default_expression").and_then(|v| v.as_str()).unwrap_or("");
            ColumnInfo {
                name: r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                nullable: ty.starts_with("Nullable("),
                data_type: ty,
                is_primary_key: json_i64(r.get("is_in_primary_key")).unwrap_or(0) != 0,
                default_value: if default.is_empty() { None } else { Some(default.to_string()) },
                ordinal_position: json_i64(r.get("position")),
                auto_increment: false,
                generated: false,
                comment: r.get("comment").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from),
            }
        })
        .collect())
}

/// ClickHouse has no stored procedures; user-defined functions aren't surfaced here.
pub async fn list_routines(_handle: &ClickHouseHandle, _database: &str) -> AppResult<Vec<RoutineInfo>> {
    Ok(vec![])
}

/// ClickHouse indexing (ORDER BY key, data-skipping indices) doesn't map to the
/// classic index model, so none are listed for now.
pub async fn list_indexes(_handle: &ClickHouseHandle, _database: &str, _table: &str) -> AppResult<Vec<IndexInfo>> {
    Ok(vec![])
}

pub async fn get_object_ddl(handle: &ClickHouseHandle, database: &str, table: &str) -> AppResult<String> {
    let db = if database.is_empty() { handle.database.clone() } else { database.to_string() };
    let j = handle
        .query_json(&format!("SHOW CREATE TABLE `{}`.`{}`", bt(&db), bt(table)))
        .await?;
    let stmt = j
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .and_then(|r| r.as_object())
        .and_then(|o| o.values().next())
        .map(json_to_string)
        .unwrap_or_default();
    Ok(stmt)
}

/// Collect one string column across every data row.
fn rows_col(j: &Json, col: &str) -> Vec<String> {
    j.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| r.get(col).and_then(|v| v.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
