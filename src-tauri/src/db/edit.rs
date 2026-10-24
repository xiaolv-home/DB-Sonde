//! Guarded table editing. Only authoritative table/column metadata is trusted;
//! values are parameter-bound and every update is protected by the complete
//! primary key plus the previous cell value (optimistic concurrency control).

use serde_json::Value;
use sqlx::{types::Json, QueryBuilder};

use super::{introspect, oracle_driver, DbPool, SessionTx};
use crate::error::{AppError, AppResult};
use crate::models::{DbKind, UpdateCellRequest};

fn quote_ident(kind: DbKind, name: &str) -> String {
    match kind {
        DbKind::Mysql | DbKind::Mariadb => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn qualified_table(kind: DbKind, request: &UpdateCellRequest) -> String {
    match kind {
        DbKind::Mysql | DbKind::Mariadb if !request.database.is_empty() => format!(
            "{}.{}",
            quote_ident(kind, &request.database),
            quote_ident(kind, &request.table)
        ),
        DbKind::Postgres if !request.schema.is_empty() => format!(
            "{}.{}",
            quote_ident(kind, &request.schema),
            quote_ident(kind, &request.table)
        ),
        _ => quote_ident(kind, &request.table),
    }
}

async fn validate(pool: &DbPool, request: &UpdateCellRequest) -> AppResult<()> {
    let tables = introspect::list_tables(pool, &request.database, &request.schema).await?;
    if !tables
        .iter()
        .any(|table| table.name == request.table && table.kind == "table")
    {
        return Err(AppError::msg("The edit target is not a base table."));
    }

    let columns =
        introspect::list_columns(pool, &request.database, &request.schema, &request.table).await?;
    if !columns.iter().any(|column| column.name == request.column) {
        return Err(AppError::msg("The edited column no longer exists."));
    }

    let primary_keys: Vec<&str> = columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.name.as_str())
        .collect();
    /* 没有主键:前端按整行的值定位(跟 DBeaver 的「所有列」一样,值对不准的列不参与)。
       这里只认「键里每一列都是这张表真有的列」;到底是不是只命中一行,由 guard 兜底 ——
       命中 0 行或多行都整笔撤销。 */
    if primary_keys.is_empty() {
        if request.primary_key.is_empty()
            || request.primary_key.keys().any(|key| !columns.iter().any(|column| &column.name == key))
        {
            return Err(AppError::msg("这张表没有主键,要按整行的列定位,但给的列对不上表结构。"));
        }
        return Ok(());
    }
    if request.primary_key.len() != primary_keys.len()
        || primary_keys
            .iter()
            .any(|column| !request.primary_key.contains_key(*column))
    {
        return Err(AppError::msg(
            "Editing requires the complete primary key in the result set.",
        ));
    }
    Ok(())
}

/// MySQL 一族改单元格时参数怎么带:能预编译写语句的走绑定参数;不能的(Doris / StarRocks)
/// 把值转义后直接写进 SQL,走文本协议。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum MySqlArgs {
    Bind,
    Inline,
}

/// JSON 值 → MySQL 字面量(Inline 模式用)。字符串按 mysql_real_escape_string 的规则转义。
pub(crate) fn mysql_literal(value: &Value) -> String {
    fn quote(text: &str) -> String {
        let mut out = String::with_capacity(text.len() + 2);
        out.push('\'');
        for ch in text.chars() {
            match ch {
                '\\' => out.push_str("\\\\"),
                '\'' => out.push_str("\\'"),
                '"' => out.push_str("\\\""),
                '\0' => out.push_str("\\0"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\u{1a}' => out.push_str("\\Z"),
                c => out.push(c),
            }
        }
        out.push('\'');
        out
    }
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Value::Number(n) => n.to_string(),
        Value::String(text) => quote(text),
        other => quote(&other.to_string()),
    }
}

fn push_mysql_value(query: &mut QueryBuilder<'_, sqlx::MySql>, value: &Value, args: MySqlArgs) {
    if args == MySqlArgs::Inline {
        query.push(mysql_literal(value));
        return;
    }
    match value {
        Value::Null => query.push("NULL"),
        Value::Bool(value) => query.push_bind(*value),
        Value::Number(value) if value.is_i64() => {
            query.push_bind(value.as_i64().unwrap_or_default())
        }
        Value::Number(value) if value.is_u64() => {
            query.push_bind(value.as_u64().unwrap_or_default())
        }
        Value::Number(value) => query.push_bind(value.as_f64().unwrap_or_default()),
        Value::String(value) => query.push_bind(value.clone()),
        value => query.push_bind(value.to_string()),
    };
}

// MySQL may compare an integer with a string through DOUBLE. The extra
// textual guard preserves the exact identity even if that comparison rounds.
fn mysql_exact_integer_guard(query: &mut QueryBuilder<'_, sqlx::MySql>, column: &str, value: &Value, args: MySqlArgs) {
    if let Value::String(text) = value {
        if text.parse::<i128>().is_ok_and(|n| !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n)) {
            query.push(" AND CAST(").push(quote_ident(DbKind::Mysql, column)).push(" AS CHAR) = ");
            push_mysql_value(query, value, args);
        }
    }
}

fn push_sqlite_value(query: &mut QueryBuilder<'_, sqlx::Sqlite>, value: &Value) {
    match value {
        Value::Null => query.push("NULL"),
        Value::Bool(value) => query.push_bind(*value),
        Value::Number(value) if value.is_i64() => {
            query.push_bind(value.as_i64().unwrap_or_default())
        }
        Value::Number(value) if value.is_u64() => {
            query.push_bind(i64::try_from(value.as_u64().unwrap_or_default()).unwrap_or(i64::MAX))
        }
        Value::Number(value) => query.push_bind(value.as_f64().unwrap_or_default()),
        Value::String(value) => query.push_bind(value.clone()),
        value => query.push_bind(value.to_string()),
    };
}

fn mysql_update_query(request: &UpdateCellRequest, args: MySqlArgs) -> QueryBuilder<'_, sqlx::MySql> {
    let kind = DbKind::Mysql;
    let mut query = QueryBuilder::<sqlx::MySql>::new("UPDATE ");
    query
        .push(qualified_table(kind, request))
        .push(" SET ")
        .push(quote_ident(kind, &request.column))
        .push(" = ");
    push_mysql_value(&mut query, &request.new_value, args);
    query.push(" WHERE ");
    for (index, (column, value)) in request.primary_key.iter().enumerate() {
        if index > 0 {
            query.push(" AND ");
        }
        query.push(quote_ident(kind, column)).push(" <=> ");
        push_mysql_value(&mut query, value, args);
        mysql_exact_integer_guard(&mut query, column, value, args);
    }
    query
        .push(" AND ")
        .push(quote_ident(kind, &request.column))
        .push(" <=> ");
    push_mysql_value(&mut query, &request.old_value, args);
    mysql_exact_integer_guard(&mut query, &request.column, &request.old_value, args);
    query
}

async fn update_mysql<'e, E>(executor: E, request: &UpdateCellRequest, args: MySqlArgs) -> AppResult<u64>
where
    E: sqlx::Executor<'e, Database = sqlx::MySql>,
{
    let mut query = mysql_update_query(request, args);
    Ok(match args {
        MySqlArgs::Bind => query.build().execute(executor).await?.rows_affected(),
        // 不带参数的 &str = 文本协议,不预编译
        MySqlArgs::Inline => executor.execute(query.sql()).await?.rows_affected(),
    })
}

async fn update_mysql_bound<'e, E>(executor: E, request: &UpdateCellRequest) -> AppResult<u64>
where
    E: sqlx::Executor<'e, Database = sqlx::MySql>,
{
    update_mysql(executor, request, MySqlArgs::Bind).await
}

async fn update_postgres<'e, E>(executor: E, request: &UpdateCellRequest) -> AppResult<u64>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    Ok(postgres_update_query(request).build().execute(executor).await?.rows_affected())
}

// Cast incoming JSON through the table's column types: large integers and
// decimals travel as strings, and SQL NULL must compare equal to SQL NULL.
fn pg_record_field(query: &mut QueryBuilder<'_, sqlx::Postgres>, table: &str, column: &str, value: &Value) {
    query.push("(jsonb_populate_record(NULL::").push(table)
        .push(", ").push_bind(Json(serde_json::json!({column: value})))
        .push(")).").push(quote_ident(DbKind::Postgres, column));
}

fn postgres_update_query(request: &UpdateCellRequest) -> QueryBuilder<'static, sqlx::Postgres> {
    let kind = DbKind::Postgres;
    let table = qualified_table(kind, request);
    let mut query = QueryBuilder::<sqlx::Postgres>::new("UPDATE ");
    query.push(&table).push(" SET ").push(quote_ident(kind, &request.column)).push(" = ");
    pg_record_field(&mut query, &table, &request.column, &request.new_value);
    query.push(" WHERE ");
    for (index, (pk, value)) in request.primary_key.iter().enumerate() {
        if index > 0 { query.push(" AND "); }
        query.push("to_jsonb(").push(quote_ident(kind, pk)).push(") IS NOT DISTINCT FROM to_jsonb(");
        pg_record_field(&mut query, &table, pk, value);
        query.push(")");
    }
    query.push(" AND to_jsonb(").push(quote_ident(kind, &request.column)).push(") IS NOT DISTINCT FROM to_jsonb(");
    pg_record_field(&mut query, &table, &request.column, &request.old_value);
    query.push(")");
    query
}

async fn update_sqlite<'e, E>(executor: E, request: &UpdateCellRequest) -> AppResult<u64>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let kind = DbKind::Sqlite;
    let mut query = QueryBuilder::<sqlx::Sqlite>::new("UPDATE ");
    query
        .push(qualified_table(kind, request))
        .push(" SET ")
        .push(quote_ident(kind, &request.column))
        .push(" = ");
    push_sqlite_value(&mut query, &request.new_value);
    query.push(" WHERE ");
    for (index, (column, value)) in request.primary_key.iter().enumerate() {
        if index > 0 {
            query.push(" AND ");
        }
        query.push(quote_ident(kind, column)).push(" IS ");
        push_sqlite_value(&mut query, value);
    }
    query
        .push(" AND ")
        .push(quote_ident(kind, &request.column))
        .push(" IS ");
    push_sqlite_value(&mut query, &request.old_value);
    Ok(query.build().execute(executor).await?.rows_affected())
}

/// Every guarded UPDATE must touch exactly one row. Zero means the row changed
/// (optimistic-lock miss); more than one means the guard was too weak.
fn guard(affected: u64) -> AppResult<()> {
    match affected {
        1 => Ok(()),
        n => Err(hit_error(n)),
    }
}

/// 改一格没有正好命中一行时说什么。Oracle 驱动(在它自己那边提交前检查)也用这一份。
pub(crate) fn hit_error(affected: u64) -> AppError {
    if affected == 0 {
        AppError::msg("这一行在读出来之后已经被改过或删掉了,请刷新后再改。")
    } else {
        AppError::msg("这次修改会同时改到不止一行(没有主键的表里有一模一样的重复行),已撤销;这种行只能用 SQL 改。")
    }
}

/// Apply a batch of single-cell edits. For pooled engines every edit runs inside
/// one transaction so the whole save is atomic — any guard miss rolls the batch
/// back (the transaction is dropped without commit). Oracle applies each edit on
/// its session connection.
pub async fn apply_edits(pool: &DbPool, requests: &[UpdateCellRequest]) -> AppResult<u64> {
    for request in requests {
        validate(pool, request).await?;
    }
    match pool {
        DbPool::MySql(p) => {
            let args = if p.caps.prepared_writes { MySqlArgs::Bind } else { MySqlArgs::Inline };
            if p.caps.transactions {
                let mut tx = p.begin().await?;
                for request in requests {
                    guard(update_mysql(&mut *tx, request, args).await?)?;
                }
                tx.commit().await?;
            } else {
                // 没有普通事务(Doris / StarRocks):一处一处改,每处都核对改到了一行;
                // 中途失败时前面的已经生效、撤不回,如实说清楚
                for (index, request) in requests.iter().enumerate() {
                    let outcome = match update_mysql(&p.pool, request, args).await {
                        Ok(rows) => guard(rows),
                        Err(error) => Err(error),
                    };
                    if let Err(error) = outcome {
                        return Err(AppError::msg(format!(
                            "第 {} 处修改失败:{error}。这个数据库没有事务,前 {} 处已经生效,请自行核对。",
                            index + 1,
                            index
                        )));
                    }
                }
            }
        }
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await?;
            for request in requests {
                guard(update_postgres(&mut *tx, request).await?)?;
            }
            tx.commit().await?;
        }
        DbPool::Sqlite(p) => {
            let mut tx = p.begin().await?;
            for request in requests {
                guard(update_sqlite(&mut *tx, request).await?)?;
            }
            tx.commit().await?;
        }
        DbPool::Oracle(handle) => {
            for request in requests {
                guard(oracle_driver::update_cell(handle, request.clone()).await?)?;
            }
        }
        DbPool::ClickHouse(_) => {
            return Err(AppError::msg("ClickHouse 暂不支持在结果网格里直接改单元格。"));
        }
    }
    Ok(requests.len() as u64)
}

/// Apply staged edits inside an already-open session transaction (autocommit
/// off). Validation still reads authoritative metadata from the pool; the writes
/// go to the held transaction and are not committed here.
pub async fn apply_edits_on_tx(
    pool: &DbPool,
    tx: &mut SessionTx,
    requests: &[UpdateCellRequest],
) -> AppResult<u64> {
    for request in requests {
        validate(pool, request).await?;
    }
    // Nested sqlx transactions use savepoints. Drop rolls back this batch even
    // on cancellation; the user's earlier work remains in the parent session.
    use sqlx::Acquire;
    macro_rules! batch {
        ($parent:expr, $update:ident) => {{
            let mut batch = $parent.begin().await?;
            for request in requests {
                guard($update(&mut *batch, request).await?)?;
            }
            batch.commit().await?;
        }};
    }
    match tx {
        // 能开会话事务的 MySQL 一定是完整 MySQL(没有事务的引擎根本进不到这里),照常绑定参数
        SessionTx::MySql(t) => batch!(t, update_mysql_bound),
        SessionTx::Postgres(t) => batch!(t, update_postgres),
        SessionTx::Sqlite(t) => batch!(t, update_sqlite),
    }
    Ok(requests.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn mysql_literals_are_escaped_like_the_server_expects() {
        use serde_json::json;
        assert_eq!(mysql_literal(&json!(null)), "NULL");
        assert_eq!(mysql_literal(&json!(true)), "TRUE");
        assert_eq!(mysql_literal(&json!(-12)), "-12");
        assert_eq!(mysql_literal(&json!(12.5)), "12.5");
        assert_eq!(mysql_literal(&json!("甲")), "'甲'");
        assert_eq!(mysql_literal(&json!("O'Brien")), "'O\\'Brien'");
        assert_eq!(mysql_literal(&json!("a\\b")), "'a\\\\b'", "反斜杠要双写,否则会吃掉后面的引号");
        assert_eq!(mysql_literal(&json!("x\\' OR 1=1 -- ")), "'x\\\\\\' OR 1=1 -- '", "注入串整个留在引号里");
        assert_eq!(mysql_literal(&json!("行1\n行2\r\0\u{1a}")), "'行1\\n行2\\r\\0\\Z'");
        assert_eq!(mysql_literal(&json!("9007199254740993")), "'9007199254740993'", "大整数走字符串不丢精度");
    }

    #[test]
    fn inline_update_has_no_placeholders_and_keeps_the_same_guards() {
        use serde_json::json;
        let request = UpdateCellRequest {
            conn_id: "c".into(), database: "db".into(), schema: "db".into(), table: "t".into(), column: "name".into(),
            primary_key: HashMap::from([("id".to_string(), json!(1))]), old_value: json!("甲"), new_value: json!("O'B"),
        };
        let inline = mysql_update_query(&request, MySqlArgs::Inline).into_sql();
        assert_eq!(inline, "UPDATE `db`.`t` SET `name` = 'O\\'B' WHERE `id` <=> 1 AND `name` <=> '甲'");
        let bound = mysql_update_query(&request, MySqlArgs::Bind).into_sql();
        assert_eq!(bound, "UPDATE `db`.`t` SET `name` = ? WHERE `id` <=> ? AND `name` <=> ?");
    }

    #[test]
    fn identifier_quoting_escapes_engine_delimiters() {
        assert_eq!(quote_ident(DbKind::Mysql, "a`b"), "`a``b`");
        assert_eq!(quote_ident(DbKind::Postgres, "a\"b"), "\"a\"\"b\"");
    }

    #[tokio::test]
    async fn sqlite_update_is_primary_key_and_old_value_guarded() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO items (id, name) VALUES (1, 'before')")
            .execute(&pool)
            .await
            .unwrap();
        let request = UpdateCellRequest {
            conn_id: "test".into(),
            database: "main".into(),
            schema: "main".into(),
            table: "items".into(),
            column: "name".into(),
            primary_key: HashMap::from([("id".into(), Value::from(1))]),
            old_value: Value::from("before"),
            new_value: Value::from("after"),
        };

        let db_pool = DbPool::Sqlite(pool.clone());
        assert_eq!(apply_edits(&db_pool, std::slice::from_ref(&request)).await.unwrap(), 1);
        let stored: String = sqlx::query_scalar("SELECT name FROM items WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(stored, "after");
        assert!(apply_edits(&db_pool, std::slice::from_ref(&request)).await.is_err());
    }
}

#[cfg(test)]
#[test]
fn postgres_edit_query_fixture() {
    let request = UpdateCellRequest {
        conn_id: "fixture".into(), database: "fixture".into(), schema: "public".into(), table: "items".into(), column: "name".into(),
        primary_key: std::collections::HashMap::from([("id".into(), Value::String("9007199254740993".into()))]),
        old_value: Value::String("before".into()), new_value: Value::String("after".into()),
    };
    let query = postgres_update_query(&request);
    assert!(query.sql().contains("(jsonb_populate_record(NULL::\"public\".\"items\", $1)).\"name\""));
    // The optional harness executes this exact SQL in an in-memory PostgreSQL
    // engine; ordinary unit tests do not create an output file.
    if let Some(path) = std::env::var_os("SONDE_TEST_PG_QUERY") {
        std::fs::write(path, serde_json::to_vec(&serde_json::json!({
            "sql": query.sql(),
            "params": [
                serde_json::json!({"name":request.new_value}).to_string(),
                serde_json::json!({"id":request.primary_key["id"]}).to_string(),
                serde_json::json!({"name":request.old_value}).to_string()
            ]
        })).unwrap()).unwrap();
    }
}

#[cfg(test)]
mod binary_key_tests {
    use super::*;
    use sqlx::{mysql::MySqlConnectOptions, Connection, MySqlConnection};
    use std::collections::HashMap;

    /// 真机:主键是 VARBINARY、里面存的是文本("10087947")的表,改哪一格都报
    /// 「该行已被修改」。原因是读出来的值被显示成 "0x3130…",编辑时这串字符被当
    /// 原值拿去 WHERE,和列里的字节永远对不上。现在读出来就是文本,绑回去的正是
    /// 原来的字节。这里用一个用完即删的库,在真 MySQL 上走一遍「读 → 用读到的值改」。
    #[tokio::test]
    #[ignore = "requires SONDE_TEST_MYSQL_HOST, SONDE_TEST_MYSQL_USER and SONDE_TEST_MYSQL_PASSWORD"]
    async fn varbinary_text_key_round_trips_through_an_edit() {
        let options = MySqlConnectOptions::new()
            .host(&std::env::var("SONDE_TEST_MYSQL_HOST").expect("test MySQL host"))
            .port(std::env::var("SONDE_TEST_MYSQL_PORT").unwrap_or_else(|_| "3306".into()).parse().unwrap())
            .username(&std::env::var("SONDE_TEST_MYSQL_USER").expect("test MySQL user"))
            .password(&std::env::var("SONDE_TEST_MYSQL_PASSWORD").expect("test MySQL password"));
        let mut conn = MySqlConnection::connect_with(&options).await.unwrap();
        let db = "sonde_binary_key_test";
        sqlx::query(&format!("DROP DATABASE IF EXISTS `{db}`")).execute(&mut conn).await.unwrap();
        sqlx::query(&format!("CREATE DATABASE `{db}`")).execute(&mut conn).await.unwrap();
        sqlx::query(&format!(
            "CREATE TABLE `{db}`.`t` (`store_id` VARBINARY(64) NOT NULL, `dt` DATE NOT NULL, \
             `code` VARBINARY(64) NULL, PRIMARY KEY (`store_id`, `dt`))"
        )).execute(&mut conn).await.unwrap();
        sqlx::query(&format!("INSERT INTO `{db}`.`t` VALUES ('69a13f63076831e41a13998176664b5e', '2026-09-27', '10087947')"))
            .execute(&mut conn).await.unwrap();

        // 读:两列都应是文本,不是 0x…
        let row = sqlx::query(&format!("SELECT `store_id`, `code` FROM `{db}`.`t`")).fetch_one(&mut conn).await.unwrap();
        let key = crate::db::value::mysql_value(&row, 0);
        let code = crate::db::value::mysql_value(&row, 1);
        assert_eq!(key, Value::String("69a13f63076831e41a13998176664b5e".into()));
        assert_eq!(code, Value::String("10087947".into()));

        let request = |key: Value, old: Value, new: Value| UpdateCellRequest {
            conn_id: String::new(), database: db.into(), schema: String::new(), table: "t".into(),
            column: "code".into(),
            primary_key: HashMap::from([("store_id".into(), key), ("dt".into(), Value::String("2026-09-27".into()))]),
            old_value: old, new_value: new,
        };

        // 老的显示值拿去改,对不上 —— 这就是原来的 bug
        let hex = Value::String("0x3639613133663633303736383331653431613133393938313736363634623565".into());
        // 绑定参数和直接写字面量(Doris 那条路)两种写法,结果必须一样
        let mut current = code.clone();
        for (args, next) in [(MySqlArgs::Bind, "20010733"), (MySqlArgs::Inline, "20010734")] {
            let stale = update_mysql(&mut conn, &request(hex.clone(), current.clone(), Value::String("x".into())), args).await.unwrap();
            assert_eq!(stale, 0, "{args:?}: 0x 显示值作为主键永远匹配不上");

            // 用现在读出来的值改,改得动
            let updated = update_mysql(&mut conn, &request(key.clone(), current.clone(), Value::String(next.into())), args).await.unwrap();
            assert_eq!(updated, 1, "{args:?}: 用读出来的文本当主键和旧值,必须改到这一行");
            let back: Vec<u8> = sqlx::query_scalar(&format!("SELECT `code` FROM `{db}`.`t`")).fetch_one(&mut conn).await.unwrap();
            assert_eq!(back, next.as_bytes(), "{args:?}: 写进去的是正确的字节");
            current = Value::String(next.into());
        }

        sqlx::query(&format!("DROP DATABASE `{db}`")).execute(&mut conn).await.unwrap();
    }
}
