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

mod meta;
mod thick;
mod thin;

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
    crate::db::edit::hit_error(affected)
}

pub async fn update_cell(conn: &OracleConn, request: UpdateCellRequest) -> AppResult<u64> {
    match conn {
        OracleConn::Thin(h) => thin::update_cell(h, request).await,
        OracleConn::Thick(h) => thick::update_cell(h, request).await,
    }
}


#[cfg(test)]
mod row_guard_tests {
    use super::rows_error;

    /// Oracle 这边的"命中行数不对"要跟其余引擎(db::edit::guard)说**同一句话** —— 现在是同一个函数。
    #[test]
    fn wording_matches_the_shared_guard() {
        for n in [0, 2, 5] {
            assert_eq!(rows_error(n).to_string(), crate::db::edit::hit_error(n).to_string());
        }
        assert!(rows_error(0).to_string().contains("刷新"));
        assert!(rows_error(2).to_string().contains("不止一行"));
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

        // DDL 是 CLOB,要读出全文,不能是 <LOB: … locator>
        let ddl = super::get_object_ddl(&conn, owner, &first.name, "table").await.expect("取 DDL");
        assert!(ddl.contains("CREATE TABLE"), "DDL 没读出来:{}", ddl.chars().take(80).collect::<String>());
        println!("DDL 前一行:{}", ddl.lines().next().unwrap_or(""));
        // 普通查询里的 CLOB 也要读出内容
        // RPAD 按显示宽度算(中文占 2),实际字数以 Oracle 自己报的 GETLENGTH 为准
        let r = super::run_query(&conn, "SELECT c, DBMS_LOB.GETLENGTH(c) AS n FROM (SELECT RPAD(TO_CLOB('中'), 12000, '文') AS c FROM DUAL)", 10).await.expect("CLOB 查询");
        let cell = r.rows[0][0].as_str().unwrap_or_default().to_string();
        let n: usize = r.rows[0][1].as_u64().map(|v| v as usize)
            .or_else(|| r.rows[0][1].as_str().and_then(|t| t.parse().ok()))
            .expect("GETLENGTH 读不出来");
        assert!(n > 4000, "要测的是超过 4000 字的大 CLOB(实际 {n})");
        assert_eq!(cell.chars().count(), n, "CLOB 内容读全:{}", cell.chars().take(40).collect::<String>());
        println!("CLOB {n} 字全部读出");

        // 从对象树删视图 / 存储过程 / 函数(Oracle 不带引号建的名字存成大写,删的时候按树上显示的大写名找)
        let drop = |kind: &str, name: &str| crate::db::drop_object::statement(crate::models::DbKind::Oracle, kind, "", owner, name).expect("删除语句");
        let mut made = vec![("view", "SONDE_DROP_V")];
        super::run_query(&conn, &format!("CREATE OR REPLACE VIEW {owner}.SONDE_DROP_V AS SELECT 1 AS X FROM DUAL"), 10).await.expect("建视图");
        // 练习库的账号不一定有建存储过程的权限;没有就只验视图(存储过程 / 函数的语句由单元测试和 MySQL 真库覆盖)
        for (kind, name, ddl) in [
            ("procedure", "SONDE_DROP_P", format!("CREATE OR REPLACE PROCEDURE {owner}.SONDE_DROP_P AS BEGIN NULL; END;")),
            ("function", "SONDE_DROP_F", format!("CREATE OR REPLACE FUNCTION {owner}.SONDE_DROP_F RETURN NUMBER AS BEGIN RETURN 1; END;")),
        ] {
            match super::run_query(&conn, &ddl, 10).await {
                Ok(_) => made.push((kind, name)),
                Err(e) if e.to_string().contains("ORA-01031") => println!("{owner} 没有建 {kind} 的权限,跳过"),
                Err(e) => panic!("建 {kind} 失败:{e}"),
            }
        }
        for (kind, name) in made {
            let sql = drop(kind, name);
            super::run_query(&conn, &sql, 10).await.unwrap_or_else(|e| panic!("{sql} 失败:{e}"));
            println!("{sql} ok");
        }
        let left_tables = super::list_tables(&conn, owner).await.expect("读表");
        assert!(!left_tables.iter().any(|t| t.name == "SONDE_DROP_V"), "视图还在");
        let left_routines = super::list_routines(&conn, owner).await.expect("读存储过程");
        assert!(!left_routines.iter().any(|r| r.name.starts_with("SONDE_DROP_")), "存储过程 / 函数还在");

        // 表结构页改注释(建一张临时表来改,不动练习库里原有的表)
        use crate::db::alter_column::{apply, Change, TableRef};
        let _ = super::run_query(&conn, &format!("DROP TABLE {owner}.SONDE_ALTER_T"), 10).await;
        super::run_query(&conn, &format!("CREATE TABLE {owner}.SONDE_ALTER_T (ID NUMBER PRIMARY KEY, NAME VARCHAR2(20))"), 10).await.expect("建表");
        let pool = crate::db::DbPool::Oracle(conn.clone());
        let col = TableRef { pool: &pool, kind: crate::models::DbKind::Oracle, database: "", schema: owner, table: "SONDE_ALTER_T", column: Some("NAME") };
        apply(&col, &Change::Comment { text: "名字 it's".into() }).await.expect("改列注释");
        let tbl = TableRef { column: None, ..col };
        apply(&tbl, &Change::Comment { text: "临时表".into() }).await.expect("改表注释");
        let cols = super::list_columns(&conn, owner, "SONDE_ALTER_T").await.expect("读字段");
        assert_eq!(cols.iter().find(|c| c.name == "NAME").and_then(|c| c.comment.clone()).as_deref(), Some("名字 it's"));
        let tables = super::list_tables(&conn, owner).await.expect("读表");
        assert_eq!(tables.iter().find(|t| t.name == "SONDE_ALTER_T").and_then(|t| t.comment.clone()).as_deref(), Some("临时表"));
        super::run_query(&conn, &format!("DROP TABLE {owner}.SONDE_ALTER_T"), 10).await.expect("删临时表");
        println!("Oracle 改表 / 列注释 ok");
    }
}
