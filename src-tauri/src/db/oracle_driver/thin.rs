//! Thin mode — pure-Rust `oracle-rs`: speaks Oracle's TNS wire protocol directly, no Instant Client needed.

use super::{esc, meta, quote_ident, rows_error, OracleConn};
use std::sync::Arc;
use std::time::Instant;

use oracle_rs::{Config, Connection, LobData, LobValue, QueryResult as OraResult, Row, Value};
use serde_json::Value as Json;

use crate::db::{ConnectInfo, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{
    ColumnInfo, ColumnMeta, ConnectionConfig, IndexInfo, QueryResult, RoutineInfo, TableInfo,
    UpdateCellRequest,
};

type Handle = Arc<Connection>;

fn oe(e: oracle_rs::Error) -> AppError {
    let raw = e.to_string();
    // Fallback for the crate's two hard-coded "we lost the error" strings. The
    // underlying bug — marker packets written with a 16-bit length field, so the
    // server never answers the RESET — is fixed in our vendored copy (see
    // third_party/oracle-rs/VENDORED.md), and real ORA codes now come through.
    // This stays as a guard: if that patch is ever dropped, say what we actually
    // know rather than repeating the crate's guess about LOBs.
    if raw.contains("binding a temporary LOB")
        || raw.contains("without providing error details")
    {
        return AppError::msg(
            "Oracle 拒绝了这条语句并断开连接。当前 thin 驱动取不到具体的 ORA 错误码，\
             常见原因：对象已存在、对象不存在、语法或数据类型有误、权限不足。",
        );
    }
    AppError::msg(format!("Oracle: {raw}"))
}

fn cell_to_json(v: &Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Integer(i) => crate::db::value::exact_integer(*i),
        Value::Float(f) => Json::from(*f),
        Value::Boolean(b) => Json::Bool(*b),
        Value::Json(j) => j.clone(),
        other => Json::String(other.to_string()),
    }
}

/// 查询结果里的大字段只读前这么多(字符 / 字节),免得一页结果几百兆卡住界面;看 DDL 时读全
const LOB_PREVIEW: u64 = 1 << 20;

/// CLOB 读成文字,BLOB 读成字节(和 MySQL 的二进制列一样显示成 0x…)。
/// `limit` 有值且内容更长时只读前 limit 个,末尾注明原来多大。
async fn lob_to_json(handle: &Handle, lob: &LobValue, limit: Option<u64>) -> AppResult<Json> {
    Ok(match lob {
        LobValue::Null => Json::Null,
        LobValue::Empty => Json::String(String::new()),
        LobValue::Inline(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => Json::String(text.to_string()),
            Err(_) => crate::db::value::bytes_to_value(bytes.to_vec()),
        },
        LobValue::Locator(loc) => {
            let size = loc.size();
            let take = limit.map_or(size, |l| l.min(size));
            let data = if take < size {
                handle.read_lob_range(loc, 1, take).await.map_err(oe)?
            } else {
                handle.read_lob(loc).await.map_err(oe)?
            };
            let cut = if take < size { format!("…(共 {size},只显示前 {take})") } else { String::new() };
            match data {
                LobData::String(text) => Json::String(format!("{text}{cut}")),
                LobData::Bytes(bytes) => crate::db::value::bytes_to_value(bytes.to_vec()),
            }
        }
    })
}

fn cell_str(row: &Row, i: usize) -> Option<String> {
    match row.get(i) {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.to_string()),
    }
}

fn to_bind(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Boolean(*b),
        Json::Number(n) if n.is_i64() => Value::Integer(n.as_i64().unwrap_or(0)),
        Json::Number(n) if n.is_u64() => Value::Integer(n.as_u64().unwrap_or(0) as i64),
        Json::Number(n) => Value::Float(n.as_f64().unwrap_or(0.0)),
        Json::String(s) => Value::String(s.clone()),
        other => Value::String(other.to_string()),
    }
}

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectInfo> {
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

    let config = Config::new(host, port, service, cfg.username.clone(), password.unwrap_or("").to_string());
    let conn = Connection::connect_with_config(config).await.map_err(oe)?;
    let handle: Handle = Arc::new(conn);

    let server_version = handle
        .query("SELECT banner FROM v$version WHERE ROWNUM = 1", &[])
        .await
        .ok()
        .and_then(|r| r.rows.first().and_then(|row| cell_str(row, 0)))
        .unwrap_or_default();
    let current_schema = handle
        .query("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL", &[])
        .await
        .ok()
        .and_then(|r| r.rows.first().and_then(|row| cell_str(row, 0)))
        .unwrap_or_else(|| cfg.username.to_uppercase());

    Ok(ConnectInfo {
        pool: DbPool::Oracle(OracleConn::Thin(handle)),
        server_version,
        current_database: current_schema,
    })
}

/// Run a query and accumulate rows across prefetch batches, up to `cap`.
async fn query_all(handle: &Handle, sql: &str, cap: usize) -> AppResult<(OraResult, bool)> {
    let mut result = handle.query(sql, &[]).await.map_err(oe)?;
    let columns = result.columns.clone();
    let mut rows = std::mem::take(&mut result.rows);
    let mut truncated = false;
    while result.has_more_rows {
        if rows.len() >= cap {
            truncated = true;
            break;
        }
        let cursor_id = result.cursor_id;
        result = handle.fetch_more(cursor_id, &columns, 1000).await.map_err(oe)?;
        rows.append(&mut result.rows);
    }
    if rows.len() > cap {
        rows.truncate(cap);
        truncated = true;
    }
    result.rows = rows;
    result.columns = columns;
    Ok((result, truncated))
}

pub async fn run_query(handle: &Handle, sql: &str, cap: usize) -> AppResult<QueryResult> {
    let started = Instant::now();
    if crate::db::returns_rows(sql) {
        let (result, truncated) = query_all(handle, sql, cap).await?;
        let columns: Vec<ColumnMeta> = result
            .columns
            .iter()
            .map(|c| ColumnMeta {
                name: c.name.clone(),
                type_name: format!("{:?}", c.oracle_type),
            })
            .collect();
        let ncols = result.columns.len();
        let mut rows: Vec<Vec<Json>> = Vec::with_capacity(result.rows.len());
        for row in &result.rows {
            let mut cells = Vec::with_capacity(ncols);
            for i in 0..ncols {
                cells.push(match row.get(i) {
                    // CLOB / BLOB 在结果里只是个「指针」,要再去服务器把内容读回来
                    Some(Value::Lob(lob)) => lob_to_json(handle, lob, Some(LOB_PREVIEW)).await?,
                    Some(v) => cell_to_json(v),
                    None => Json::Null,
                });
            }
            rows.push(cells);
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
    } else {
        let result = handle.execute(sql, &[]).await.map_err(oe)?;
        handle.commit().await.map_err(oe)?;
        Ok(QueryResult {
        additional_results: None,
            rows_affected: Some(result.rows_affected),
            message: Some(format!("{} row(s) affected", result.rows_affected)),
            elapsed_ms: started.elapsed().as_millis(),
            ..Default::default()
        })
    }
}

pub async fn list_schemas(handle: &Handle) -> AppResult<Vec<String>> {
    let (result, _) = query_all(handle, "SELECT DISTINCT owner FROM all_tables ORDER BY owner", 100_000).await?;
    Ok(result.rows.iter().filter_map(|r| cell_str(r, 0)).collect())
}

/// 一次查询的结果转成「每行若干个可能为空的字符串」,交给 super::meta 去认
async fn string_rows(handle: &Handle, sql: &str) -> AppResult<Vec<Vec<Option<String>>>> {
    let (result, _) = query_all(handle, sql, 100_000).await?;
    let n = result.columns.len();
    Ok(result.rows.iter().map(|r| (0..n).map(|i| cell_str(r, i)).collect()).collect())
}

pub async fn list_tables(handle: &Handle, owner: &str) -> AppResult<Vec<TableInfo>> {
    let mut out: Vec<TableInfo> = string_rows(handle, &meta::tables_sql(owner)).await?.iter().filter_map(|r| meta::table_from(r)).collect();
    out.extend(string_rows(handle, &meta::views_sql(owner)).await?.iter().filter_map(|r| meta::view_from(r)));
    Ok(out)
}

pub async fn list_columns(handle: &Handle, owner: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    let pks = meta::primary_keys(&string_rows(handle, &meta::primary_key_sql(owner, table)).await?);
    Ok(string_rows(handle, &meta::columns_sql(owner, table)).await?.iter().filter_map(|r| meta::column_from(r, &pks)).collect())
}

pub async fn list_routines(handle: &Handle, owner: &str) -> AppResult<Vec<RoutineInfo>> {
    let o = esc(owner);
    let (rows, _) = query_all(
        handle,
        &format!(
            "SELECT object_name, object_type FROM all_objects \
             WHERE owner = '{o}' AND object_type IN ('PROCEDURE', 'FUNCTION') \
             ORDER BY object_type, object_name"
        ),
        100_000,
    )
    .await?;
    Ok(rows
        .rows
        .iter()
        .filter_map(|r| {
            let name = cell_str(r, 0)?;
            let otype = cell_str(r, 1).unwrap_or_default();
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
}

pub async fn list_indexes(handle: &Handle, owner: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    let o = esc(owner);
    let tb = esc(table);
    let (rows, _) = query_all(
        handle,
        &format!(
            "SELECT i.index_name, i.uniqueness, i.index_type, ic.column_name \
             FROM all_indexes i \
             JOIN all_ind_columns ic ON i.owner = ic.index_owner \
               AND i.index_name = ic.index_name \
             WHERE i.table_owner = '{o}' AND i.table_name = '{tb}' \
             ORDER BY i.index_name, ic.column_position"
        ),
        100_000,
    )
    .await?;
    let mut indexes: Vec<IndexInfo> = Vec::new();
    for r in &rows.rows {
        let name = cell_str(r, 0).unwrap_or_default();
        let unique = cell_str(r, 1).map(|s| s.eq_ignore_ascii_case("UNIQUE")).unwrap_or(false);
        let index_type = cell_str(r, 2);
        let column = cell_str(r, 3).unwrap_or_default();
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
}

pub async fn get_object_ddl(
    handle: &Handle,
    owner: &str,
    table: &str,
    object_kind: &str,
) -> AppResult<String> {
    let obj = if object_kind.eq_ignore_ascii_case("view") {
        "VIEW"
    } else {
        "TABLE"
    };
    let o = esc(owner);
    let tb = esc(table);
    match query_all(
        handle,
        &format!("SELECT DBMS_METADATA.GET_DDL('{obj}', '{tb}', '{o}') FROM DUAL"),
        10,
    )
    .await
    {
        // GET_DDL 返回 CLOB:读全文(不截断),不然只能看到 <LOB: … locator>
        Ok((result, _)) => match result.rows.first().and_then(|r| r.get(0)) {
            Some(Value::Lob(lob)) => Ok(lob_to_json(handle, lob, None).await?.as_str().unwrap_or_default().trim().to_string()),
            Some(_) => Ok(result.rows.first().and_then(|r| cell_str(r, 0)).unwrap_or_default()),
            None => Ok(String::new()),
        },
        Err(e) => Ok(format!("-- DDL unavailable (DBMS_METADATA): {e}")),
    }
}

pub async fn update_cell(handle: &Handle, request: UpdateCellRequest) -> AppResult<u64> {
    let table_ref = format!("{}.{}", quote_ident(&request.schema), quote_ident(&request.table));
    let set_col = quote_ident(&request.column);

    let mut binds: Vec<Value> = vec![to_bind(&request.new_value)];
    let mut clauses: Vec<String> = Vec::new();
    let mut idx = 2; // :1 is the new value
    for (col, val) in &request.primary_key {
        clauses.push(format!("DECODE({}, :{}, 0, 1) = 0", quote_ident(col), idx));
        binds.push(to_bind(val));
        idx += 1;
    }
    clauses.push(format!("DECODE({}, :{}, 0, 1) = 0", set_col, idx));
    binds.push(to_bind(&request.old_value));

    let sql = format!("UPDATE {table_ref} SET {set_col} = :1 WHERE {}", clauses.join(" AND "));
    let result = handle.execute(&sql, &binds).await.map_err(oe)?;
    /* 「只能命中一行」这道检查必须在**提交之前**。
       原来是先 commit 再把行数交回上层,由 db::edit::guard 去判 —— 那时候写
       已经落库了,报一句"安全检查失败"也收不回来。其余三种引擎的 guard 跑在
       事务里,命中多行是真能回滚的;Oracle 这边形同虚设。
       (正常情况下 validate 已经强制主键完整、只会命中一行。这是最后一道
       防线,防的就是"正常情况"不成立的时候。) */
    if result.rows_affected != 1 {
        let _ = handle.rollback().await;
        return Err(rows_error(result.rows_affected));
    }
    handle.commit().await.map_err(oe)?;
    Ok(result.rows_affected)
}
