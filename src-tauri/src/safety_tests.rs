//! Destructive-operation regression fixtures: in-memory databases only.
use crate::{commands::{self, ActiveConn, AppState}, db::{self, DbPool}, models::*, readonly};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::Manager;

async fn fixture() -> DbPool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(3).connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO items VALUES (1,'before'),(2,'before'),(3,'before')").execute(&pool).await.unwrap();
    DbPool::Sqlite(pool)
}
fn req(id: Value, old: &str) -> UpdateCellRequest {
    UpdateCellRequest { conn_id: "c".into(), database: "main".into(), schema: "main".into(), table: "items".into(), column: "name".into(), primary_key: HashMap::from([("id".into(), id)]), old_value: old.into(), new_value: "after".into() }
}
#[tokio::test]
async fn failed_manual_edits_preserve_earlier_work_but_revert_the_whole_batch() {
    let pool = fixture().await;
    let mut tx = db::begin_tx(&pool).await.unwrap();
    db::run_query_on_tx(&mut tx, "UPDATE items SET name='earlier' WHERE id=3", None).await.unwrap();
    assert!(db::edit::apply_edits_on_tx(&pool, &mut tx, &[req(json!(1), "before"), req(json!(2), "stale")]).await.is_err());
    db::commit_tx(tx).await.unwrap();
    assert_eq!(db::run_query(&pool, "SELECT name FROM items ORDER BY id", None).await.unwrap().rows,
        vec![vec![json!("before")], vec![json!("before")], vec![json!("earlier")]]);
}
#[tokio::test]
async fn failed_manual_statements_revert_batch_and_parent_remains_usable() {
    let pool = fixture().await;
    let mut tx = db::begin_tx(&pool).await.unwrap();
    db::run_query_on_tx(&mut tx, "UPDATE items SET name='earlier' WHERE id=3", None).await.unwrap();
    assert!(db::run_statements_on_tx(&mut tx, &["DELETE FROM items WHERE id=1".into(), "INSERT INTO items VALUES(2,'duplicate')".into()], &[]).await.is_err());
    db::run_query_on_tx(&mut tx, "UPDATE items SET name='later' WHERE id=2", None).await.unwrap();
    db::commit_tx(tx).await.unwrap();
    assert_eq!(db::run_query(&pool, "SELECT name FROM items ORDER BY id", None).await.unwrap().rows,
        vec![vec![json!("before")], vec![json!("later")], vec![json!("earlier")]]);
}
#[tokio::test]
async fn unsafe_integer_primary_key_roundtrips_and_updates_only_selected_row() {
    let pool = fixture().await;
    db::run_query(&pool, "INSERT INTO items VALUES (9007199254740992,'even'),(9007199254740993,'odd')", None).await.unwrap();
    let result = db::run_query(&pool, "SELECT id FROM items WHERE id=9007199254740993", None).await.unwrap();
    let wire: Value = serde_json::from_str(&serde_json::to_string(&result).unwrap()).unwrap();
    assert_eq!(wire["rows"][0][0], json!("9007199254740993"));
    db::edit::apply_edits(&pool, &[req(wire["rows"][0][0].clone(), "odd")]).await.unwrap();
    assert_eq!(db::run_query(&pool, "SELECT name FROM items WHERE id>=9007199254740992 ORDER BY id", None).await.unwrap().rows,
        vec![vec![json!("even")], vec![json!("after")]]);
    for n in [i64::MIN as i128, i64::MAX as i128, u64::MAX as i128, -9_007_199_254_740_992] {
        assert_eq!(db::value::exact_integer(n), json!(n.to_string()));
    }
    assert_eq!(db::value::exact_integer(9_007_199_254_740_991_i64), json!(9_007_199_254_740_991_i64));
}
async fn register(state: &tauri::State<'_, AppState>, pool: DbPool, kind: DbKind, database: &str) {
    let config: ConnectionConfig = serde_json::from_value(json!({"id":"c","name":"fixture","kind":kind,"database":database})).unwrap();
    state.conns.write().await.insert("c".into(), ActiveConn { kind, pool, current_database: database.into(), config, session_password: None });
}
#[tokio::test]
async fn manual_queries_writes_and_reopen_stay_on_selected_database() {
    let pool = fixture().await;
    let other = fixture().await;
    let app = tauri::test::mock_app();
    app.manage(AppState::default());
    let state = app.state::<AppState>();
    // Two SQLite handles exercise database routing without opening a server.
    register(&state, pool.clone(), DbKind::Mysql, "primary").await;
    state.database_pools.write().await.insert("c\0other".into(), other.clone());
    commands::query::set_autocommit(state.clone(), "c".into(), false, Some("other".into())).await.unwrap();
    for sql in ["SELECT 1", "DELETE FROM items", "UPDATE items SET name='wrong'"] {
        assert!(commands::query::run_query(state.clone(), "c".into(), Some("primary".into()), sql.into(), None, None).await.is_err());
    }
    assert!(commands::query::run_statements(state.clone(), "c".into(), Some("primary".into()), vec!["DELETE FROM items".into()], None).await.is_err());
    assert!(commands::query::apply_cell_edits(state.clone(), vec![req(json!(1), "before")]).await.is_err());
    commands::query::run_query(state.clone(), "c".into(), Some("other".into()), "UPDATE items SET name='right' WHERE id=1".into(), None, None).await.unwrap();
    commands::query::commit_session(state.clone(), "c".into()).await.unwrap();
    commands::query::run_query(state.clone(), "c".into(), Some("other".into()), "UPDATE items SET name='rollback' WHERE id=2".into(), None, None).await.unwrap();
    commands::query::rollback_session(state.clone(), "c".into()).await.unwrap();
    commands::query::set_autocommit(state, "c".into(), true, None).await.unwrap();
    assert_eq!(db::run_query(&pool, "SELECT name FROM items WHERE id=1", None).await.unwrap().rows[0][0], json!("before"));
    assert_eq!(db::run_query(&other, "SELECT name FROM items ORDER BY id", None).await.unwrap().rows,
        vec![vec![json!("right")], vec![json!("before")], vec![json!("before")]]);
}
#[tokio::test]
async fn reopen_failure_stays_manual_and_blocks_execution() {
    let pool = fixture().await;
    let app = tauri::test::mock_app();
    app.manage(AppState::default());
    let state = app.state::<AppState>();
    register(&state, pool.clone(), DbKind::Sqlite, "main").await;
    commands::query::set_autocommit(state.clone(), "c".into(), false, None).await.unwrap();
    let DbPool::Sqlite(p) = &pool else { unreachable!() };
    let closing = p.clone();
    let close_task = tokio::spawn(async move { closing.close().await });
    tokio::task::yield_now().await;
    assert!(p.is_closed());
    assert!(commands::query::commit_session(state.clone(), "c".into()).await.is_err());
    assert_eq!(state.autocommit.read().await.get("c"), Some(&false));
    let error = commands::query::run_query(state, "c".into(), None, "DELETE FROM items".into(), None, None).await.unwrap_err();
    assert!(error.to_string().contains("未执行"));
    close_task.await.unwrap();
}
#[test]
fn manual_session_cannot_be_ended_or_retargeted_by_sql() {
    for sql in ["COMMIT", "ROLLBACK", "USE other", "SET autocommit=1", "SELECT 1; COMMIT", "/*! COMMIT */", "/*M! SET autocommit=1 */"] {
        assert!(readonly::validate_manual_sql(false, sql).is_err(), "{sql}");
    }
    for sql in ["ALTER TABLE items ADD n INT", "CALL maybe_commit()", "TRUNCATE items"] {
        assert!(readonly::validate_manual_sql(true, sql).is_err(), "{sql}");
    }
    assert!(readonly::validate_dashboard_sql("SELECT 1 /*! INTO OUTFILE '/tmp/out' */").is_err());
    readonly::validate_manual_sql(true, "SELECT CASE WHEN 1=1 THEN 'COMMIT' ELSE 'ROLLBACK' END").unwrap();
}

/// 没有主键的表:按整行的值定位(前端 rowKeyOf / buildRowDelete 的整行模式)。
/// NULL 要能对上;有一模一样的两行时,改不了(命中两行整笔撤销),删只删其中一行。
#[tokio::test]
async fn tables_without_a_primary_key_are_edited_by_whole_row() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE logs (note TEXT, qty INTEGER)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO logs VALUES ('a',1),('a',1),(NULL,2)").execute(&pool).await.unwrap();
    let pool = DbPool::Sqlite(pool);
    let edit = |key: Value, old: Value, new: Value| UpdateCellRequest {
        conn_id: "c".into(), database: "main".into(), schema: "main".into(), table: "logs".into(), column: "qty".into(),
        primary_key: serde_json::from_value(key).unwrap(), old_value: old, new_value: new,
    };
    let rows = |pool: DbPool| async move { db::run_query(&pool, "SELECT note, qty FROM logs ORDER BY rowid", None).await.unwrap().rows };

    db::edit::apply_edits(&pool, &[edit(json!({"note": null, "qty": 2}), json!(2), json!(3))]).await.unwrap();
    assert_eq!(rows(pool.clone()).await[2], vec![json!(null), json!(3)], "值是 NULL 的列也要对上");

    let twin = db::edit::apply_edits(&pool, &[edit(json!({"note": "a", "qty": 1}), json!(1), json!(9))]).await.unwrap_err();
    assert!(format!("{twin}").contains("不止一行"), "{twin}");
    assert_eq!(rows(pool.clone()).await[0], vec![json!("a"), json!(1)], "两行一模一样:改不了,也不能两行一起改");

    assert!(db::edit::apply_edits(&pool, &[edit(json!({"nope": 1}), json!(1), json!(2))]).await.is_err(), "键里的列必须是表里真有的");

    // 前端 buildRowDelete(…, wholeRow=true) 在 SQLite 上生成的就是这句
    let delete = r#"DELETE FROM "logs" WHERE rowid = (SELECT rowid FROM "logs" WHERE "note" = 'a' AND "qty" = 1 LIMIT 1)"#;
    db::run_statements(&pool, &[delete.into()], &[Some(1)]).await.unwrap();
    assert_eq!(rows(pool.clone()).await.len(), 2, "两行一模一样的只删掉一行");
    let gone = r#"DELETE FROM "logs" WHERE rowid = (SELECT rowid FROM "logs" WHERE "note" = 'zzz' LIMIT 1)"#;
    assert!(db::run_statements(&pool, &[gone.into()], &[Some(1)]).await.is_err(), "对不上就报错,不能当成删掉了");
}
