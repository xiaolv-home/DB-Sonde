//! Oracle Database driver with two selectable modes:
//!
//! * **Thin** (default) — pure-Rust `oracle-rs`, speaks Oracle's TNS wire
//!   protocol directly. **No Instant Client needed.**
//! * **Thick** (opt-in per connection) — `oracle` crate (ODPI-C), which loads an
//!   installed **Oracle Instant Client** at runtime.
//!
//! `ConnectionConfig.oracle_thick` selects the mode. Both compile without any
//! Oracle SDK present.

use std::sync::{Arc, Mutex};

use crate::db::ConnectInfo;
use crate::error::{AppError, AppResult};
use crate::models::{
    ColumnInfo, ConnectionConfig, IndexInfo, QueryResult, RoutineInfo, TableInfo, UpdateCellRequest,
};

/// A live Oracle connection in one of the two driver modes. Cheap to clone.
#[derive(Clone)]
pub enum OracleConn {
    Thin(Arc<oracle_rs::Connection>),
    Thick(Arc<Mutex<oracle::Connection>>),
}

/// Kept for the `DbPool::Oracle(oracle_driver::OracleHandle)` variant.
pub type OracleHandle = OracleConn;

// --- shared helpers --------------------------------------------------------

fn esc(s: &str) -> String {
    s.replace('\'', "''")
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn format_oracle_type(
    dtype: &str,
    length: Option<i64>,
    precision: Option<i64>,
    scale: Option<i64>,
) -> String {
    let d = dtype.to_ascii_uppercase();
    if d.starts_with("VARCHAR") || d.starts_with("CHAR") || d.starts_with("NVARCHAR") || d.starts_with("NCHAR") {
        if let Some(l) = length {
            return format!("{dtype}({l})");
        }
    }
    if d == "NUMBER" {
        return match (precision, scale) {
            (Some(p), Some(s)) if s != 0 => format!("NUMBER({p},{s})"),
            (Some(p), _) => format!("NUMBER({p})"),
            _ => "NUMBER".to_string(),
        };
    }
    dtype.to_string()
}

// --- dispatch --------------------------------------------------------------

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectInfo> {
    if cfg.oracle_thick {
        thick::connect(cfg, password).await
    } else {
        thin::connect(cfg, password).await
    }
}

/// Whether this handle can still run statements.
///
/// The thin driver never revives a connection it gave up on: `state` goes to
/// `Closed` and every later call fails with "connection not ready", which is what
/// the user ends up staring at until they reconnect by hand. Callers check this
/// before handing work to the connection. Thick mode is pooled by ODPI-C, which
/// does its own recycling, so it always reports alive.
pub async fn is_alive(conn: &OracleConn) -> bool {
    match conn {
        OracleConn::Thin(h) => h.is_usable().await,
        OracleConn::Thick(_) => true,
    }
}

pub async fn run_query(conn: &OracleConn, sql: &str, cap: usize) -> AppResult<QueryResult> {
    let sql = strip_trailing_semicolon(sql);
    match conn {
        OracleConn::Thin(h) => thin::run_query(h, sql, cap).await,
        OracleConn::Thick(h) => thick::run_query(h, sql, cap).await,
    }
}

/// Oracle's wire protocol rejects a trailing `;` — sqlplus strips it client-side,
/// so a statement pasted from another client fails here with ORA-00922. Strip it
/// ourselves instead of handing the server something it will always refuse.
///
/// PL/SQL is the exception: the `;` closing `END;` is part of the syntax.
fn strip_trailing_semicolon(sql: &str) -> &str {
    let trimmed = sql.trim_end();
    if !trimmed.ends_with(';') || is_plsql(sql) {
        return sql;
    }
    trimmed[..trimmed.len() - 1].trim_end()
}

/// Anonymous blocks and stored-program DDL, whose trailing `;` must survive.
fn is_plsql(sql: &str) -> bool {
    let mut words = crate::db::strip_leading_noise(sql)
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric() && c != '_')
                .to_ascii_uppercase()
        });
    match words.next().unwrap_or_default().as_str() {
        "BEGIN" | "DECLARE" => true,
        "CREATE" => words.any(|w| {
            matches!(
                w.as_str(),
                "PROCEDURE" | "FUNCTION" | "PACKAGE" | "TRIGGER" | "TYPE" | "LIBRARY" | "BODY"
            )
        }),
        _ => false,
    }
}

pub async fn list_schemas(conn: &OracleConn) -> AppResult<Vec<String>> {
    match conn {
        OracleConn::Thin(h) => thin::list_schemas(h).await,
        OracleConn::Thick(h) => thick::list_schemas(h).await,
    }
}

pub async fn list_tables(conn: &OracleConn, owner: &str) -> AppResult<Vec<TableInfo>> {
    match conn {
        OracleConn::Thin(h) => thin::list_tables(h, owner).await,
        OracleConn::Thick(h) => thick::list_tables(h, owner).await,
    }
}

pub async fn list_columns(conn: &OracleConn, owner: &str, table: &str) -> AppResult<Vec<ColumnInfo>> {
    match conn {
        OracleConn::Thin(h) => thin::list_columns(h, owner, table).await,
        OracleConn::Thick(h) => thick::list_columns(h, owner, table).await,
    }
}

pub async fn list_routines(conn: &OracleConn, owner: &str) -> AppResult<Vec<RoutineInfo>> {
    match conn {
        OracleConn::Thin(h) => thin::list_routines(h, owner).await,
        OracleConn::Thick(h) => thick::list_routines(h, owner).await,
    }
}

pub async fn list_indexes(conn: &OracleConn, owner: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    match conn {
        OracleConn::Thin(h) => thin::list_indexes(h, owner, table).await,
        OracleConn::Thick(h) => thick::list_indexes(h, owner, table).await,
    }
}

pub async fn get_object_ddl(
    conn: &OracleConn,
    owner: &str,
    table: &str,
    object_kind: &str,
) -> AppResult<String> {
    match conn {
        OracleConn::Thin(h) => thin::get_object_ddl(h, owner, table, object_kind).await,
        OracleConn::Thick(h) => thick::get_object_ddl(h, owner, table, object_kind).await,
    }
}

/// 命中行数不对时的说法 —— 跟 db::edit::guard 对其余引擎给的是同一句,
/// 免得同一件事在 Oracle 上换个说法,用户以为是另一个毛病。
fn rows_error(affected: u64) -> AppError {
    if affected == 0 {
        AppError::msg("The row changed since it was loaded. Refresh before saving again.")
    } else {
        AppError::msg("Safety check failed: more than one row matched the edit.")
    }
}

pub async fn update_cell(conn: &OracleConn, request: UpdateCellRequest) -> AppResult<u64> {
    match conn {
        OracleConn::Thin(h) => thin::update_cell(h, request).await,
        OracleConn::Thick(h) => thick::update_cell(h, request).await,
    }
}

// ===========================================================================
// Thin mode — pure-Rust `oracle-rs`
// ===========================================================================
/// 表 / 视图 / 字段元数据:SQL 和「一行结果 → 结构体」只写一份,thin 和 thick 两种驱动共用,
/// 各自只管把查询跑起来、把每行转成 `Vec<Option<String>>`。
/// 注释来自 ALL_TAB_COMMENTS / ALL_COL_COMMENTS(COMMENT ON TABLE / COLUMN 写进去的)。
mod meta {
    use super::{esc, format_oracle_type};
    use crate::models::{ColumnInfo, TableInfo};
    use std::collections::HashSet;

    pub type Row = [Option<String>];

    pub fn tables_sql(owner: &str) -> String {
        let o = esc(owner);
        format!(
            "SELECT t.table_name, t.num_rows, c.comments FROM all_tables t \
             LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name \
             WHERE t.owner = '{o}' ORDER BY t.table_name"
        )
    }

    pub fn views_sql(owner: &str) -> String {
        let o = esc(owner);
        format!(
            "SELECT v.view_name, c.comments FROM all_views v \
             LEFT JOIN all_tab_comments c ON c.owner = v.owner AND c.table_name = v.view_name \
             WHERE v.owner = '{o}' ORDER BY v.view_name"
        )
    }

    pub fn primary_key_sql(owner: &str, table: &str) -> String {
        let (o, tb) = (esc(owner), esc(table));
        format!(
            "SELECT cc.column_name FROM all_constraints c \
             JOIN all_cons_columns cc ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name \
             WHERE c.constraint_type = 'P' AND c.owner = '{o}' AND c.table_name = '{tb}'"
        )
    }

    pub fn columns_sql(owner: &str, table: &str) -> String {
        let (o, tb) = (esc(owner), esc(table));
        format!(
            "SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale, \
                    c.nullable, c.column_id, m.comments \
             FROM all_tab_columns c \
             LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name \
               AND m.column_name = c.column_name \
             WHERE c.owner = '{o}' AND c.table_name = '{tb}' ORDER BY c.column_id"
        )
    }

    fn cell(row: &Row, i: usize) -> Option<String> {
        row.get(i).cloned().flatten()
    }
    /// 空串当没有注释
    fn comment(row: &Row, i: usize) -> Option<String> {
        cell(row, i).filter(|s| !s.trim().is_empty())
    }

    pub fn table_from(row: &Row) -> Option<TableInfo> {
        Some(TableInfo {
            name: cell(row, 0)?,
            kind: "table".into(),
            engine: None,
            estimated_rows: cell(row, 1).and_then(|s| s.parse::<i64>().ok()),
            data_size: None,
            comment: comment(row, 2),
            collation: None,
        })
    }

    pub fn view_from(row: &Row) -> Option<TableInfo> {
        Some(TableInfo {
            name: cell(row, 0)?,
            kind: "view".into(),
            engine: None,
            estimated_rows: None,
            data_size: None,
            comment: comment(row, 1),
            collation: None,
        })
    }

    pub fn primary_keys(rows: &[Vec<Option<String>>]) -> HashSet<String> {
        rows.iter().filter_map(|r| cell(r, 0)).collect()
    }

    pub fn column_from(row: &Row, pks: &HashSet<String>) -> Option<ColumnInfo> {
        let name = cell(row, 0)?;
        let num = |i: usize| cell(row, i).and_then(|s| s.parse().ok());
        Some(ColumnInfo {
            is_primary_key: pks.contains(&name),
            data_type: format_oracle_type(&cell(row, 1).unwrap_or_default(), num(2), num(3), num(4)),
            nullable: cell(row, 5).map(|s| s.eq_ignore_ascii_case("Y")).unwrap_or(true),
            default_value: None,
            ordinal_position: num(6),
            auto_increment: false,
            generated: false,
            comment: comment(row, 7),
            name,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn row(cells: &[Option<&str>]) -> Vec<Option<String>> {
            cells.iter().map(|c| c.map(str::to_string)).collect()
        }

        #[test]
        fn comments_are_read_and_blank_ones_dropped() {
            let t = table_from(&row(&[Some("QH_STORE"), Some("42"), Some("门店")])).unwrap();
            assert_eq!((t.name.as_str(), t.estimated_rows, t.comment.as_deref()), ("QH_STORE", Some(42), Some("门店")));
            assert_eq!(table_from(&row(&[Some("T"), None, Some("  ")])).unwrap().comment, None, "空注释当没有");
            assert_eq!(view_from(&row(&[Some("V"), Some("视图说明")])).unwrap().comment.as_deref(), Some("视图说明"));
            let pks = primary_keys(&[row(&[Some("STORE_ID")])]);
            let c = column_from(&row(&[Some("STORE_ID"), Some("NUMBER"), Some("22"), Some("10"), Some("0"), Some("N"), Some("1"), Some("门店ID,主键")]), &pks).unwrap();
            assert!(c.is_primary_key && !c.nullable);
            assert_eq!(c.comment.as_deref(), Some("门店ID,主键"));
            assert_eq!(c.ordinal_position, Some(1));
            assert!(column_from(&row(&[None]), &pks).is_none(), "没有列名的行跳过");
        }

        #[test]
        fn metadata_sql_joins_comments_and_escapes_names() {
            assert!(tables_sql("QH").contains("all_tab_comments"));
            assert!(views_sql("QH").contains("all_tab_comments"));
            assert!(columns_sql("QH", "T").contains("all_col_comments"));
            assert!(columns_sql("O'X", "T'Y").contains("'O''X'") && columns_sql("O'X", "T'Y").contains("'T''Y'"), "单引号要转义");
        }
    }
}

mod thin {
    use super::{esc, meta, quote_ident, rows_error, OracleConn};
    use std::sync::Arc;
    use std::time::Instant;

    use oracle_rs::{Config, Connection, QueryResult as OraResult, Row, Value};
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
            let rows: Vec<Vec<Json>> = result
                .rows
                .iter()
                .map(|row| {
                    (0..ncols)
                        .map(|i| row.get(i).map(cell_to_json).unwrap_or(Json::Null))
                        .collect()
                })
                .collect();
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
            Ok((result, _)) => Ok(result.rows.first().and_then(|r| cell_str(r, 0)).unwrap_or_default()),
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
}

// ===========================================================================
// Thick mode — ODPI-C `oracle` crate (Instant Client)
// ===========================================================================
mod thick {
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
}

#[cfg(test)]
mod row_guard_tests {
    use super::rows_error;

    /// Oracle 这边的"命中行数不对"要跟其余引擎(db::edit::guard)说**同一句话**。
    /// 同一件事换个说法,用户会以为是另一个毛病。两处文案一旦走散,这条就变红。
    #[test]
    fn wording_matches_the_shared_guard() {
        assert_eq!(
            rows_error(0).to_string(),
            "The row changed since it was loaded. Refresh before saving again."
        );
        assert_eq!(
            rows_error(5).to_string(),
            "Safety check failed: more than one row matched the edit."
        );
    }
}

#[cfg(test)]
mod semicolon_tests {
    use super::{is_plsql, strip_trailing_semicolon};

    #[test]
    fn strips_trailing_semicolon_from_plain_statements() {
        assert_eq!(
            strip_trailing_semicolon("CREATE TABLE t (id NUMBER);"),
            "CREATE TABLE t (id NUMBER)"
        );
        assert_eq!(strip_trailing_semicolon("SELECT 1 FROM dual;  "), "SELECT 1 FROM dual");
        assert_eq!(strip_trailing_semicolon("SELECT 1 FROM dual"), "SELECT 1 FROM dual");
    }

    #[test]
    fn leaves_a_semicolon_inside_the_statement_alone() {
        let sql = "SELECT 'a;b' FROM dual";
        assert_eq!(strip_trailing_semicolon(sql), sql);
    }

    #[test]
    fn keeps_the_semicolon_that_closes_plsql() {
        for sql in [
            "BEGIN NULL; END;",
            "DECLARE v NUMBER; BEGIN v := 1; END;",
            "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;",
            "CREATE PACKAGE BODY pkg AS END;",
        ] {
            assert!(is_plsql(sql), "should be PL/SQL: {sql}");
            assert_eq!(strip_trailing_semicolon(sql), sql);
        }
    }

    #[test]
    fn plain_ddl_is_not_mistaken_for_plsql() {
        for sql in [
            "CREATE TABLE t (id NUMBER)",
            "CREATE INDEX i ON t (id)",
            "CREATE VIEW v AS SELECT 1 FROM dual",
            "SELECT * FROM t",
        ] {
            assert!(!is_plsql(sql), "should not be PL/SQL: {sql}");
        }
    }

    #[test]
    fn leading_comments_do_not_hide_plsql() {
        let sql = "-- build it\nBEGIN NULL; END;";
        assert!(is_plsql(sql));
        assert_eq!(strip_trailing_semicolon(sql), sql);
    }
}

#[cfg(test)]
mod live_tests {
    /// 连真 Oracle 看表 / 字段注释读不读得出来(默认跳过):
    /// SONDE_ORACLE_TEST='{"host":"127.0.0.1","port":1521,"database":"FREEPDB1","username":"qh","password":"…","owner":"QH"}' \
    ///   cargo test --lib oracle_comments -- --ignored
    #[tokio::test]
    #[ignore]
    async fn oracle_comments_come_back_from_a_real_server() {
        let Ok(raw) = std::env::var("SONDE_ORACLE_TEST") else { return };
        let v: serde_json::Value = serde_json::from_str(&raw).expect("SONDE_ORACLE_TEST 不是 JSON");
        let cfg: crate::models::ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "live", "name": "live", "kind": "oracle",
            "host": v["host"], "port": v["port"], "username": v["username"], "database": v["database"],
            "oracleThick": false,
        }))
        .expect("连接配置");
        let info = super::connect(&cfg, v["password"].as_str()).await.expect("连不上");
        let crate::db::DbPool::Oracle(conn) = info.pool else { panic!("不是 Oracle 连接") };
        let owner = v["owner"].as_str().unwrap_or("QH");
        let tables = super::list_tables(&conn, owner).await.expect("读表");
        let with_comment = tables.iter().filter(|t| t.comment.is_some()).count();
        assert!(with_comment > 0, "{owner} 下没有一张表读出注释");
        let first = tables.iter().find(|t| t.comment.is_some()).unwrap();
        let cols = super::list_columns(&conn, owner, &first.name).await.expect("读字段");
        assert!(cols.iter().any(|c| c.comment.is_some()), "{} 的字段没读出注释", first.name);
        println!("{} 张表里 {with_comment} 张有注释;{} 第一列注释:{:?}", tables.len(), first.name, cols.iter().find_map(|c| c.comment.clone()));
    }
}
