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
    rep.step("批量语句(run_statements)", run_statements(&pool, &[format!("INSERT INTO {t} VALUES (3, '丙', 3.00, '2026-10-02 00:00:00', '2026-10-02', 3.0, true)")], &[]).await.map_err(|e| e.to_string()), |n| format!("{n}"));
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
    if !doris {
        rep.step("建函数", q(run_query(&pool, &format!("CREATE FUNCTION `{db}`.f_name() RETURNS VARCHAR(10) DETERMINISTIC RETURN 'x'"), None).await), |_| "ok".into());
    }
    rep.step("树:存储过程 / 函数", introspect::list_routines(&pool, &db, &db).await.map_err(|e| e.to_string()).and_then(|r| {
        // MySQL 上那个函数的返回类型要读成完整的 varchar(10)
        match r.iter().find(|x| x.name == "f_name") {
            Some(f) if f.return_type.as_deref() != Some("varchar(10)") => Err(format!("返回类型读成了 {:?}", f.return_type)),
            _ => Ok(r),
        }
    }), |r| format!("{:?}", r.iter().map(|x| (x.name.clone(), x.return_type.clone())).collect::<Vec<_>>()));
    // 从对象树删除视图 / 存储过程 / 函数:用的就是菜单「删除…」生成的那条语句
    let drop_sql = |object_kind: &str, name: &str| super::drop_object::statement(crate::models::DbKind::Mysql, object_kind, &db, "", name).expect("删除语句");
    rep.step("建视图", q(run_query(&pool, &format!("CREATE VIEW `{db}`.`v_t` AS SELECT id, name FROM {t}"), None).await), |_| "ok".into());
    rep.step("删视图(菜单生成的语句)", q(run_query(&pool, &drop_sql("view", "v_t"), None).await), |_| drop_sql("view", "v_t"));
    rep.step("视图真没了、表还在", introspect::list_tables(&pool, &db, &db).await.map_err(|e| e.to_string()).and_then(|ts| {
        let names: Vec<_> = ts.iter().map(|t| t.name.clone()).collect();
        if names.contains(&"v_t".to_string()) || !names.contains(&"t".to_string()) { Err(format!("还剩 {names:?}")) } else { Ok(names) }
    }), |n| format!("{n:?}"));
    if !doris {
        rep.step("建存储过程", q(run_query(&pool, &format!("CREATE PROCEDURE `{db}`.p_touch() SELECT 1"), None).await), |_| "ok".into());
        rep.step("删存储过程", q(run_query(&pool, &drop_sql("procedure", "p_touch"), None).await), |_| drop_sql("procedure", "p_touch"));
    }
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
    // ── 表结构页:双击改注释 / 数据类型 ──
    {
        use super::alter_column::{apply, plan, Change, TableRef};
        let kind = crate::models::DbKind::Mysql;
        let line_of = |create: &str, col: &str| create.lines().map(str::trim).find(|l| l.starts_with(&format!("`{col}` "))).unwrap_or("").trim_end_matches(',').to_string();
        let show = |tbl: &str| format!("SHOW CREATE TABLE `{db}`.`{tbl}`");
        if doris {
            let target = TableRef { pool: &pool, kind, database: &db, schema: &db, table: "t", column: Some("name") };
            rep.step("Doris:改列注释", apply(&target, &Change::Comment { text: "名字 it's".into() }).await.map_err(|e| e.to_string()), |_| "ok".into());
            rep.step("Doris:改完读回列注释", introspect::list_columns(&pool, &db, &db, "t").await.map_err(|e| e.to_string()).and_then(|cs| {
                let c = cs.iter().find(|c| c.name == "name").and_then(|c| c.comment.clone());
                if c.as_deref() == Some("名字 it's") { Ok(c) } else { Err(format!("读回 {c:?}")) }
            }), |c| format!("{c:?}"));
            let table_target = TableRef { pool: &pool, kind, database: &db, schema: &db, table: "t", column: None };
            rep.step("Doris:改表注释", apply(&table_target, &Change::Comment { text: "测试表2".into() }).await.map_err(|e| e.to_string()), |_| "ok".into());
            rep.step("Doris:改类型应清楚拒绝", match plan(&target, &Change::Type { to: "varchar(80)".into() }).await {
                Err(e) if e.to_string().contains("schema change") => Ok(e.to_string()), Err(e) => Err(e.to_string()), Ok(p) => Err(format!("不该放行:{}", p.sql)),
            }, |s| s.clone());
        } else {
            rep.step("建改类型的测试表", q(run_query(&pool, &format!(
                "CREATE TABLE `{db}`.`t2` (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '主键', \
                 code VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '0' COMMENT '编码', \
                 amt DECIMAL(12,3), ts DATETIME) COMMENT '改类型'"), None).await), |_| "ok".into());
            rep.step("灌数据", q(run_query(&pool, &format!(
                "INSERT INTO `{db}`.`t2` (code, amt, ts) VALUES ('12', 1.500, '2026-10-01 00:00:00'), ('abc', 2.125, '2026-10-01 08:30:00'), ('99999999999', 3.000, NULL)"), None).await),
                |r| format!("{:?}", r.rows_affected));
            let col = |c: &'static str| TableRef { pool: &pool, kind, database: &db, schema: &db, table: "t2", column: Some(c) };
            rep.step("varchar→int:查出两行转不了", plan(&col("code"), &Change::Type { to: "int".into() }).await.map_err(|e| e.to_string()).and_then(|p| {
                let pr = p.problem.as_ref().ok_or("应该查出问题")?;
                let whys: Vec<_> = pr.samples.iter().map(|s| format!("{}:{}", s.value, s.why)).collect();
                if pr.bad_rows == 2 && whys.iter().any(|w| w.starts_with("abc:不是数字")) && whys.iter().any(|w| w.contains("超出范围")) { Ok(whys) } else { Err(format!("{} 行 {whys:?}", pr.bad_rows)) }
            }), |w| format!("{w:?}"));
            rep.step("有问题时执行要被拒绝、表不动", match apply(&col("code"), &Change::Type { to: "int".into() }).await {
                Err(e) => Ok(e.to_string()), Ok(()) => Err("居然改了".into()),
            }, |s| s.clone());
            rep.step("decimal(12,3)→(12,2):查出四舍五入", plan(&col("amt"), &Change::Type { to: "decimal(12,2)".into() }).await.map_err(|e| e.to_string()).and_then(|p| {
                let pr = p.problem.ok_or("应该查出 2.125")?;
                if pr.bad_rows == 1 && pr.samples[0].why.contains("四舍五入") { Ok(pr.samples[0].value.clone()) } else { Err(format!("{} 行", pr.bad_rows)) }
            }), |v| v.clone());
            rep.step("datetime→date:查出丢时分秒", plan(&col("ts"), &Change::Type { to: "date".into() }).await.map_err(|e| e.to_string()).and_then(|p| {
                let pr = p.problem.ok_or("应该查出 08:30")?;
                if pr.bad_rows == 1 && pr.samples[0].why.contains("时分秒") { Ok(pr.samples[0].value.clone()) } else { Err(format!("{} 行 {:?}", pr.bad_rows, pr.samples.iter().map(|s| &s.why).collect::<Vec<_>>())) }
            }), |v| v.clone());
            rep.step("把脏数据修好", q(run_query(&pool, &format!("UPDATE `{db}`.`t2` SET code = '7' WHERE code = 'abc'"), None).await), |r| format!("{:?}", r.rows_affected));
            rep.step("varchar→bigint:全部能转", plan(&col("code"), &Change::Type { to: "BIGINT".into() }).await.map_err(|e| e.to_string()).and_then(|p| {
                if p.problem.is_none() && p.checked_rows == Some(3) { Ok(p.sql) } else { Err(format!("{:?} {:?}", p.checked_rows, p.problem.map(|x| x.bad_rows))) }
            }), |s| s.clone());
            rep.step("varchar→bigint:执行", apply(&col("code"), &Change::Type { to: "BIGINT".into() }).await.map_err(|e| e.to_string()), |_| "ok".into());
            rep.step("改完类型:非空 / 默认值 / 注释都还在,字符集去掉", q(run_query(&pool, &show("t2"), None).await).and_then(|r| {
                let create = r.rows[0][1].as_str().unwrap_or_default().to_string();
                let l = line_of(&create, "code");
                if l == "`code` bigint NOT NULL DEFAULT '0' COMMENT '编码'" { Ok(l) } else { Err(l) }
            }), |l| l.clone());
            rep.step("数据转对了", q(run_query(&pool, &format!("SELECT code FROM `{db}`.`t2` ORDER BY id"), None).await), rows_of);
            let tricky = "主键 it's \\ 说明".to_string();
            rep.step("改列注释(带引号和反斜杠)", apply(&col("id"), &Change::Comment { text: tricky.clone() }).await.map_err(|e| e.to_string()), |_| "ok".into());
            rep.step("改完注释:自增 / 主键都还在,注释原样", introspect::list_columns(&pool, &db, &db, "t2").await.map_err(|e| e.to_string()).and_then(|cs| {
                let c = cs.iter().find(|c| c.name == "id").ok_or("没有 id")?;
                if c.auto_increment && c.is_primary_key && c.comment.as_deref() == Some(tricky.as_str()) { Ok(c.comment.clone()) } else { Err(format!("{c:?}")) }
            }), |c| format!("{c:?}"));
            rep.step("清空列注释", apply(&col("amt"), &Change::Comment { text: String::new() }).await.map_err(|e| e.to_string()), |_| "ok".into());
            let table_target = TableRef { pool: &pool, kind, database: &db, schema: &db, table: "t2", column: None };
            rep.step("改表注释", apply(&table_target, &Change::Comment { text: "门店信息表 v2".into() }).await.map_err(|e| e.to_string()), |_| "ok".into());
            rep.step("改完读回表注释", introspect::list_tables(&pool, &db, &db).await.map_err(|e| e.to_string()).and_then(|ts| {
                let c = ts.iter().find(|t| t.name == "t2").and_then(|t| t.comment.clone());
                if c.as_deref() == Some("门店信息表 v2") { Ok(c) } else { Err(format!("{c:?}")) }
            }), |c| format!("{c:?}"));
            rep.step("不认识的类型直接拒绝", match plan(&col("code"), &Change::Type { to: "int; DROP TABLE t2".into() }).await {
                Err(e) => Ok(e.to_string()), Ok(p) => Err(p.sql),
            }, |s| s.clone());
        }
    }
    rep.step("DELETE", q(run_query(&pool, &format!("DELETE FROM {t} WHERE id = 3"), None).await), |r| format!("{:?}", r.rows_affected));
    if !doris {
        rep.step("删函数", q(run_query(&pool, &drop_sql("function", "f_name"), None).await), |_| drop_sql("function", "f_name"));
        rep.step("存储过程和函数都删干净了", introspect::list_routines(&pool, &db, &db).await.map_err(|e| e.to_string()).and_then(|r| {
            if r.is_empty() { Ok(r) } else { Err(format!("还剩 {:?}", r.iter().map(|x| x.name.clone()).collect::<Vec<_>>())) }
        }), |_| "空".into());
    }
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
