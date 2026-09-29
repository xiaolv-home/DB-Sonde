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
    if primary_keys.is_empty()
        || request.primary_key.len() != primary_keys.len()
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

fn push_mysql_value(query: &mut QueryBuilder<'_, sqlx::MySql>, value: &Value) {
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
fn mysql_exact_integer_guard(query: &mut QueryBuilder<'_, sqlx::MySql>, column: &str, value: &Value) {
    if let Value::String(text) = value {
        if text.parse::<i128>().is_ok_and(|n| !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n)) {
            query.push(" AND CAST(").push(quote_ident(DbKind::Mysql, column))
                .push(" AS CHAR) = ").push_bind(text.clone());
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

async fn update_mysql<'e, E>(executor: E, request: &UpdateCellRequest) -> AppResult<u64>
where
    E: sqlx::Executor<'e, Database = sqlx::MySql>,
{
    let kind = DbKind::Mysql;
    let mut query = QueryBuilder::<sqlx::MySql>::new("UPDATE ");
    query
        .push(qualified_table(kind, request))
        .push(" SET ")
        .push(quote_ident(kind, &request.column))
        .push(" = ");
    push_mysql_value(&mut query, &request.new_value);
    query.push(" WHERE ");
    for (index, (column, value)) in request.primary_key.iter().enumerate() {
        if index > 0 {
            query.push(" AND ");
        }
        query.push(quote_ident(kind, column)).push(" <=> ");
        push_mysql_value(&mut query, value);
        mysql_exact_integer_guard(&mut query, column, value);
    }
    query
        .push(" AND ")
        .push(quote_ident(kind, &request.column))
        .push(" <=> ");
    push_mysql_value(&mut query, &request.old_value);
    mysql_exact_integer_guard(&mut query, &request.column, &request.old_value);
    Ok(query.build().execute(executor).await?.rows_affected())
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
        0 => Err(AppError::msg(
            "The row changed since it was loaded. Refresh before saving again.",
        )),
        _ => Err(AppError::msg(
            "Safety check failed: more than one row matched the edit.",
        )),
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
            let mut tx = p.begin().await?;
            for request in requests {
                guard(update_mysql(&mut *tx, request).await?)?;
            }
            tx.commit().await?;
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
        SessionTx::MySql(t) => batch!(t, update_mysql),
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
        let stale = update_mysql(&mut conn, &request(hex, code.clone(), Value::String("x".into()))).await.unwrap();
        assert_eq!(stale, 0, "0x 显示值作为主键永远匹配不上");

        // 用现在读出来的值改,改得动
        let updated = update_mysql(&mut conn, &request(key.clone(), code, Value::String("20010733".into()))).await.unwrap();
        assert_eq!(updated, 1, "用读出来的文本当主键和旧值,必须改到这一行");
        let back: Vec<u8> = sqlx::query_scalar(&format!("SELECT `code` FROM `{db}`.`t`")).fetch_one(&mut conn).await.unwrap();
        assert_eq!(back, b"20010733", "写进去的是正确的字节");

        sqlx::query(&format!("DROP DATABASE `{db}`")).execute(&mut conn).await.unwrap();
    }
}
