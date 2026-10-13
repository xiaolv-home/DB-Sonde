//! 连真实的 MySQL 协议数据库(MySQL / Doris / StarRocks …)把日常操作走一遍(默认跳过)。
//!
//! SONDE_MYSQL_FAMILY_TEST='{"host":"127.0.0.1","port":9030,"username":"root","password":"…","flavor":"doris"}' \
//!   cargo test --lib live_mysql_family -- --ignored --nocapture
//!
//! flavor 只决定建表语句怎么写(Doris 要 UNIQUE KEY / DISTRIBUTED BY),其余步骤完全一样。
//! 每一步单独记成败,最后一起报出来 —— 一次就能看全哪里不能用。

use super::{connect, edit, introspect, run_query, run_statements, DbPool};
use crate::models::{ConnectionConfig, UpdateCellRequest};
use serde_json::{json, Value};
use std::collections::HashMap;

struct Report {
    rows: Vec<(String, Result<String, String>)>,
}
impl Report {
    fn step<T>(&mut self, name: &str, r: Result<T, String>, show: impl Fn(&T) -> String) -> Option<T> {
        match r {
            Ok(v) => { self.rows.push((name.into(), Ok(show(&v)))); Some(v) }
            Err(e) => { self.rows.push((name.into(), Err(e))); None }
        }
    }
}

fn cfg_from(v: &Value) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": "live", "name": "live", "kind": "mysql",
        "host": v["host"], "port": v["port"], "username": v["username"], "database": v["database"].as_str().unwrap_or(""),
    }))
    .expect("连接配置")
}

#[tokio::test]
#[ignore]
async fn live_mysql_family_everyday_operations() {
    let Ok(raw) = std::env::var("SONDE_MYSQL_FAMILY_TEST") else { return };
    let v: Value = serde_json::from_str(&raw).expect("SONDE_MYSQL_FAMILY_TEST 不是 JSON");
    let doris = v["flavor"].as_str() == Some("doris");
    let info = connect(&cfg_from(&v), v["password"].as_str()).await.expect("连不上");
    let pool: DbPool = info.pool;
    println!("server: {}", info.server_version);
    let db = format!("sonde_live_{}", std::process::id());
    let t = format!("`{db}`.`t`");
    let mut rep = Report { rows: vec![] };
    let q = |r: crate::error::AppResult<crate::models::QueryResult>| r.map_err(|e| e.to_string());
    let rows_of = |r: &crate::models::QueryResult| format!("{} 行 · {:?}", r.rows.len(), r.rows.first());

    rep.step("CREATE DATABASE", q(run_query(&pool, &format!("CREATE DATABASE `{db}`"), None).await), |_| "ok".into());
    let create = if doris {
        format!("CREATE TABLE {t} (id INT NOT NULL COMMENT '主键', name VARCHAR(50) COMMENT '名字', amt DECIMAL(12,2), ts DATETIME, d DATE, f DOUBLE, flag BOOLEAN) \
                 UNIQUE KEY(id) COMMENT '测试表' DISTRIBUTED BY HASH(id) BUCKETS 1 PROPERTIES (\"replication_num\" = \"1\")")
    } else {
        format!("CREATE TABLE {t} (id INT NOT NULL PRIMARY KEY COMMENT '主键', name VARCHAR(50) COMMENT '名字', amt DECIMAL(12,2), ts DATETIME, d DATE, f DOUBLE, flag BOOLEAN) COMMENT '测试表'")
    };
    rep.step("CREATE TABLE", q(run_query(&pool, &create, None).await), |_| "ok".into());
    rep.step("INSERT", q(run_query(&pool, &format!(
        "INSERT INTO {t} VALUES (1, '甲', 12.50, '2026-10-01 08:30:00', '2026-10-01', 1.5, true), (2, NULL, NULL, NULL, NULL, NULL, false)"), None).await),
        |r| format!("{:?}", r.rows_affected));
    rep.step("批量语句(run_statements)", run_statements(&pool, &[format!("INSERT INTO {t} VALUES (3, '丙', 3.00, '2026-10-02 00:00:00', '2026-10-02', 3.0, true)")]).await.map_err(|e| e.to_string()), |n| format!("{n}"));
    rep.step("SELECT *", q(run_query(&pool, &format!("SELECT * FROM {t} ORDER BY id"), None).await), rows_of);
    rep.step("SELECT 分页(LIMIT/OFFSET)", q(run_query(&pool, &format!("SELECT * FROM {t} ORDER BY id LIMIT 2 OFFSET 1"), None).await), rows_of);
    rep.step("COUNT", q(run_query(&pool, &format!("SELECT COUNT(*) AS n FROM {t}"), None).await), rows_of);
    rep.step("空结果也要有列", q(run_query(&pool, &format!("SELECT id, name FROM {t} WHERE 1 = 0"), None).await), |r| format!("列 {:?}", r.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>()));
    rep.step("SHOW DATABASES", q(run_query(&pool, "SHOW DATABASES", None).await), |r| format!("{} 行", r.rows.len()));
    rep.step("SHOW CREATE TABLE", q(run_query(&pool, &format!("SHOW CREATE TABLE {t}"), None).await), |r| format!("{} 行", r.rows.len()));
    rep.step("DESC", q(run_query(&pool, &format!("DESC {t}"), None).await), |r| format!("{} 行", r.rows.len()));
    rep.step("EXPLAIN", q(run_query(&pool, &format!("EXPLAIN SELECT * FROM {t}"), None).await), |r| format!("{} 行", r.rows.len()));
    rep.step("树:列库", introspect::list_databases(&pool, crate::models::DbKind::Mysql).await.map_err(|e| e.to_string()), |d| format!("含测试库={}", d.contains(&db)));
    rep.step("树:列表", introspect::list_tables(&pool, &db, &db).await.map_err(|e| e.to_string()), |ts| format!("{:?}", ts.iter().map(|t| (t.name.clone(), t.comment.clone())).collect::<Vec<_>>()));
    rep.step("树:列字段", introspect::list_columns(&pool, &db, &db, "t").await.map_err(|e| e.to_string()), |cs| format!("{:?}", cs.iter().map(|c| (c.name.clone(), c.data_type.clone(), c.is_primary_key, c.comment.clone())).collect::<Vec<_>>()));
    rep.step("树:索引", introspect::list_indexes(&pool, &db, &db, "t").await.map_err(|e| e.to_string()), |ix| format!("{} 个", ix.len()));
    rep.step("DDL", introspect::get_object_ddl(&pool, &db, &db, "t", "table").await.map_err(|e| e.to_string()), |s| s.lines().next().unwrap_or("").to_string());
    rep.step("改单元格", edit::apply_edits(&pool, &[UpdateCellRequest {
        conn_id: "live".into(), database: db.clone(), schema: db.clone(), table: "t".into(), column: "name".into(),
        primary_key: HashMap::from([("id".to_string(), json!(1))]), old_value: json!("甲"), new_value: json!("甲改"),
    }]).await.map_err(|e| e.to_string()), |n| format!("{n} 行"));
    rep.step("改完读回", q(run_query(&pool, &format!("SELECT name FROM {t} WHERE id = 1"), None).await), rows_of);
    rep.step("看板只读查询(带参数)", super::run_read_only_query(&pool, &format!("SELECT id, name FROM {t} WHERE id = ?"), &["1".to_string()], Some(10), std::time::Duration::from_secs(30)).await.map_err(|e| e.to_string()), rows_of);
    rep.step("关自动提交(没事务的库应清楚拒绝)", match super::begin_tx(&pool).await { Ok(tx) => { let _ = super::rollback_tx(tx).await; Ok("支持事务".to_string()) } Err(e) if !super::supports_session_tx(&pool) => Ok(format!("拒绝:{e}")), Err(e) => Err(e.to_string()) }, |s| s.clone());
    rep.step("拒绝事务后连接没被弄坏", q(run_query(&pool, &format!("SELECT COUNT(*) FROM {t}"), None).await), rows_of);
    rep.step("带停止标记的语句", q(run_query(&pool, &format!("/* sonde:qlive-1 */ SELECT COUNT(*) FROM {t}"), None).await), rows_of);
    rep.step("停止(按标记找正在跑的语句)", super::cancel_marked_query(&pool, "sonde:qlive-404").await.map_err(|e| e.to_string()), |n| format!("取消了 {n} 条"));
    rep.step("DELETE", q(run_query(&pool, &format!("DELETE FROM {t} WHERE id = 3"), None).await), |r| format!("{:?}", r.rows_affected));
    rep.step("DROP DATABASE", q(run_query(&pool, &format!("DROP DATABASE `{db}`"), None).await), |_| "ok".into());

    let mut failed = 0;
    for (name, r) in &rep.rows {
        match r {
            Ok(s) => println!("  ✓ {name}: {s}"),
            Err(e) => { failed += 1; println!("  ✗ {name}: {e}"); }
        }
    }
    assert_eq!(failed, 0, "{failed} 步失败");
}

/// 改走文本协议后,每种类型读出来的值必须和原来(二进制协议)一模一样 —— 只在完整 MySQL 上跑。
#[tokio::test]
#[ignore]
async fn live_mysql_text_and_binary_protocols_decode_the_same() {
    use sqlx::{Column, Executor, Row};
    let Ok(raw) = std::env::var("SONDE_MYSQL_FAMILY_TEST") else { return };
    let v: Value = serde_json::from_str(&raw).unwrap();
    if v["flavor"].as_str() == Some("doris") { return; }
    let info = connect(&cfg_from(&v), v["password"].as_str()).await.expect("连不上");
    let DbPool::MySql(m) = info.pool else { panic!() };
    let p = &m.pool;
    let db = format!("sonde_parity_{}", std::process::id());
    p.execute(format!("CREATE DATABASE `{db}`").as_str()).await.unwrap();
    p.execute(format!("CREATE TABLE `{db}`.t (
        id INT PRIMARY KEY, big BIGINT, ubig BIGINT UNSIGNED, tiny TINYINT, b1 TINYINT(1), dec1 DECIMAL(20,6), f FLOAT, d DOUBLE,
        dt DATETIME(3), ts TIMESTAMP NULL, dd DATE, tm TIME, yr YEAR, js JSON, bt BIT(8), bl BLOB, vb VARBINARY(8), en ENUM('甲','乙'), st SET('a','b'), txt TEXT, ch CHAR(4))").as_str()).await.unwrap();
    p.execute(format!("INSERT INTO `{db}`.t VALUES
        (1, -9223372036854775808, 18446744073709551615, -128, 1, 12345678901234.123456, 1.25, 3.141592653589793,
         '2026-10-13 08:30:01.123', '2026-10-13 08:30:01', '2026-10-13', '-12:34:56', 2026, '{{\"a\": [1, \"中\"]}}', b'10100101', x'00FF10', x'0102', '乙', 'a,b', '中文 text', 'ab'),
        (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)").as_str()).await.unwrap();
    let sql = format!("SELECT * FROM `{db}`.t ORDER BY id");
    let binary = sqlx::query(&sql).fetch_all(p).await.unwrap();
    let text = p.fetch_all(sql.as_str()).await.unwrap();
    let mut diffs = vec![];
    for (rb, rt) in binary.iter().zip(text.iter()) {
        for i in 0..rb.columns().len() {
            let (a, b) = (super::value::mysql_value(rb, i), super::value::mysql_value(rt, i));
            if a != b { diffs.push(format!("{}: 二进制 {a:?} / 文本 {b:?}", rb.column(i).name())); }
        }
    }
    let tm = binary[0].columns().iter().position(|c| c.name() == "tm").unwrap();
    assert_eq!(super::value::mysql_value(&text[0], tm), json!("-12:34:56"), "TIME 是时长,负号不能丢");
    p.execute(format!("DROP DATABASE `{db}`").as_str()).await.unwrap();
    for d in &diffs { println!("  ✗ {d}"); }
    assert!(diffs.is_empty(), "{} 个值两种协议读出来不一样", diffs.len());
    println!("  ✓ {} 列 × 2 行,两种协议读出来完全一致", binary[0].columns().len());
}
