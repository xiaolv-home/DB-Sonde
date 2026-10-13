//! Object-tree introspection. Each engine organizes namespaces differently, so
//! the queries branch per backend but return the same normalized shapes.

use std::collections::HashSet;

use sqlx::Row;

use super::{clickhouse_driver, oracle_driver, DbPool};
use crate::error::AppResult;
use crate::models::{ColumnInfo, DbKind, IndexInfo, RoutineInfo, TableInfo};

fn empty_table_metadata(name: String, kind: String) -> TableInfo {
    TableInfo {
        name,
        kind,
        engine: None,
        estimated_rows: None,
        data_size: None,
        comment: None,
        collation: None,
    }
}

fn table_kind(raw: &str) -> String {
    // MySQL-compatible engines may report VIEW, SYSTEM VIEW, or other
    // vendor-specific view types. Normalize the catalog value before the UI
    // groups objects; never guess from an object's name.
    if raw.trim().to_ascii_uppercase().contains("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

fn mysql_table_kind(is_view: i64) -> String {
    if is_view != 0 {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

/// Top-level databases browsable on this connection.
pub async fn list_databases(pool: &DbPool, kind: DbKind) -> AppResult<Vec<String>> {
    match pool {
        DbPool::MySql(super::MySql { pool: p, .. }) => {
            let rows = sqlx::query(
                "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
            )
            .fetch_all(p)
            .await?;
            Ok(rows.iter().filter_map(|r| r.try_get(0).ok()).collect())
        }
        DbPool::Postgres(p) => {
            let rows = sqlx::query(
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
            )
            .fetch_all(p)
            .await?;
            Ok(rows.iter().filter_map(|r| r.try_get(0).ok()).collect())
        }
        DbPool::Sqlite(_) => {
            let _ = kind;
            Ok(vec!["main".to_string()])
        }
        DbPool::Oracle(_) => Ok(vec![]),
        DbPool::ClickHouse(h) => clickhouse_driver::list_schemas(h).await,
    }
}

/// Schema level between database and table. Empty for engines without one.
pub async fn list_schemas(pool: &DbPool, _database: &str) -> AppResult<Vec<String>> {
    match pool {
        DbPool::MySql(_) => Ok(vec![]),
        DbPool::Postgres(p) => {
            let rows = sqlx::query(
                "SELECT schema_name FROM information_schema.schemata \
                 WHERE schema_name NOT IN ('pg_catalog', 'information_schema') \
                   AND schema_name NOT LIKE 'pg_toast%' \
                   AND schema_name NOT LIKE 'pg_temp%' \
                 ORDER BY schema_name",
            )
            .fetch_all(p)
            .await?;
            Ok(rows.iter().filter_map(|r| r.try_get(0).ok()).collect())
        }
        DbPool::Sqlite(_) => Ok(vec!["main".to_string()]),
        DbPool::Oracle(h) => oracle_driver::list_schemas(h).await,
        DbPool::ClickHouse(_) => Ok(vec![]),
    }
}

/// Tables and views inside a namespace. For MySQL the namespace is `database`;
/// for PostgreSQL it's `schema`; SQLite ignores both.
pub async fn list_tables(pool: &DbPool, database: &str, schema: &str) -> AppResult<Vec<TableInfo>> {
    match pool {
        DbPool::MySql(super::MySql { pool: p, .. }) => {
            let rows = sqlx::query(
                "SELECT t.table_name, \
                        CAST(CASE WHEN v.table_name IS NOT NULL \
                                      OR UPPER(CAST(t.table_type AS CHAR)) LIKE '%VIEW%' \
                                  THEN 1 ELSE 0 END AS SIGNED), \
                        t.engine, CAST(t.table_rows AS SIGNED), \
                        CAST(COALESCE(t.data_length, 0) + COALESCE(t.index_length, 0) AS SIGNED), \
                        NULLIF(t.table_comment, ''), t.table_collation \
                 FROM information_schema.tables t \
                 LEFT JOIN information_schema.views v \
                   ON v.table_schema = t.table_schema AND v.table_name = t.table_name \
                 WHERE t.table_schema = ? ORDER BY t.table_name",
            )
            .bind(database)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get(0).ok()?;
                    let is_view: i64 = r.try_get(1).unwrap_or(0);
                    Some(TableInfo {
                        name,
                        kind: mysql_table_kind(is_view),
                        engine: r.try_get(2).ok().flatten(),
                        estimated_rows: r.try_get(3).ok().flatten(),
                        data_size: r.try_get(4).ok().flatten(),
                        comment: r.try_get(5).ok().flatten(),
                        collation: r.try_get(6).ok().flatten(),
                    })
                })
                .collect())
        }
        DbPool::Postgres(p) => {
            let rows = sqlx::query(
                "SELECT c.relname, \
                        CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END, \
                        am.amname, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, \
                        pg_total_relation_size(c.oid)::bigint, \
                        obj_description(c.oid, 'pg_class'), NULL::text \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_am am ON am.oid = c.relam \
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') \
                 ORDER BY c.relname",
            )
            .bind(schema)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get(0).ok()?;
                    let ttype: String = r.try_get(1).unwrap_or_default();
                    Some(TableInfo {
                        name,
                        kind: table_kind(&ttype),
                        engine: r.try_get(2).ok().flatten(),
                        estimated_rows: r.try_get(3).ok().flatten(),
                        data_size: r.try_get(4).ok().flatten(),
                        comment: r.try_get(5).ok().flatten(),
                        collation: r.try_get(6).ok().flatten(),
                    })
                })
                .collect())
        }
        DbPool::Sqlite(p) => {
            let rows = sqlx::query(
                "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name",
            )
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get(0).ok()?;
                    let ttype: String = r.try_get(1).unwrap_or_default();
                    Some(empty_table_metadata(name, table_kind(&ttype)))
                })
                .collect())
        }
        DbPool::Oracle(h) => oracle_driver::list_tables(h, schema).await,
        DbPool::ClickHouse(h) => clickhouse_driver::list_tables(h, database).await,
    }
}

/// Columns of a table, including nullability, primary-key flag and default.
pub async fn list_columns(
    pool: &DbPool,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<Vec<ColumnInfo>> {
    match pool {
        DbPool::MySql(super::MySql { pool: p, caps }) => {
            let rows = sqlx::query(
                "SELECT column_name, CAST(column_type AS CHAR), \
                        CAST(CASE WHEN is_nullable = 'YES' THEN 1 ELSE 0 END AS SIGNED), \
                        CAST(column_key AS CHAR), CAST(column_default AS CHAR), \
                        CAST(ordinal_position AS SIGNED), CAST(extra AS CHAR), \
                        NULLIF(CAST(column_comment AS CHAR), '') \
                 FROM information_schema.columns \
                 WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
            )
            .bind(database)
            .bind(table)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get(0).ok()?;
                    let data_type: String = r.try_get(1).unwrap_or_default();
                    let nullable: i64 = r.try_get(2).unwrap_or(0);
                    let key: String = r.try_get(3).unwrap_or_default();
                    let default_value: Option<String> = r.try_get(4).ok().flatten();
                    let extra: String = r.try_get(6).unwrap_or_default();
                    Some(ColumnInfo {
                        name,
                        data_type,
                        nullable: nullable != 0,
                        is_primary_key: caps.is_row_key(&key),
                        default_value,
                        ordinal_position: r.try_get(5).ok(),
                        auto_increment: extra.to_ascii_lowercase().contains("auto_increment"),
                        generated: extra.to_ascii_lowercase().contains("generated"),
                        comment: r.try_get(7).ok().flatten(),
                    })
                })
                .collect())
        }
        DbPool::Postgres(p) => {
            // Primary-key columns first, so we can flag them below.
            let pk_rows = sqlx::query(
                "SELECT kcu.column_name FROM information_schema.table_constraints tc \
                 JOIN information_schema.key_column_usage kcu \
                   ON tc.constraint_name = kcu.constraint_name \
                  AND tc.table_schema = kcu.table_schema \
                 WHERE tc.constraint_type = 'PRIMARY KEY' \
                   AND tc.table_schema = $1 AND tc.table_name = $2",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(p)
            .await?;
            let pks: HashSet<String> = pk_rows
                .iter()
                .filter_map(|r| r.try_get::<String, _>(0).ok())
                .collect();

            let rows = sqlx::query(
                "SELECT c.column_name, format_type(pa.atttypid, pa.atttypmod), \
                        c.is_nullable, c.column_default, \
                        c.ordinal_position::bigint, c.is_identity, c.is_generated, \
                        col_description(pc.oid, pa.attnum) \
                 FROM information_schema.columns c \
                 JOIN pg_namespace pn ON pn.nspname = c.table_schema \
                 JOIN pg_class pc ON pc.relnamespace = pn.oid AND pc.relname = c.table_name \
                 JOIN pg_attribute pa ON pa.attrelid = pc.oid AND pa.attname = c.column_name \
                                     AND pa.attnum > 0 AND NOT pa.attisdropped \
                 WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get(0).ok()?;
                    let data_type: String = r.try_get(1).unwrap_or_default();
                    let nullable: String = r.try_get(2).unwrap_or_default();
                    let default_value: Option<String> = r.try_get(3).ok().flatten();
                    let identity: String = r.try_get(5).unwrap_or_default();
                    let generated: String = r.try_get(6).unwrap_or_default();
                    Some(ColumnInfo {
                        is_primary_key: pks.contains(&name),
                        name,
                        data_type,
                        nullable: nullable.eq_ignore_ascii_case("YES"),
                        default_value,
                        ordinal_position: r.try_get(4).ok(),
                        auto_increment: identity.eq_ignore_ascii_case("YES"),
                        generated: !generated.eq_ignore_ascii_case("NEVER"),
                        comment: r.try_get(7).ok().flatten(),
                    })
                })
                .collect())
        }
        DbPool::Sqlite(p) => {
            let _ = (database, schema);
            // PRAGMA doesn't accept a bound parameter for the table name.
            let safe = table.replace('\'', "''");
            let rows = sqlx::query(&format!("PRAGMA table_info('{safe}')"))
                .fetch_all(p)
                .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get("name").ok()?;
                    let data_type: String = r.try_get("type").unwrap_or_default();
                    let notnull: i64 = r.try_get("notnull").unwrap_or(0);
                    let pk: i64 = r.try_get("pk").unwrap_or(0);
                    let default_value: Option<String> = r.try_get("dflt_value").ok().flatten();
                    Some(ColumnInfo {
                        name,
                        data_type,
                        nullable: notnull == 0,
                        is_primary_key: pk > 0,
                        default_value,
                        ordinal_position: r.try_get::<i64, _>("cid").ok().map(|v| v + 1),
                        auto_increment: false,
                        generated: false,
                        comment: None,
                    })
                })
                .collect())
        }
        DbPool::Oracle(h) => oracle_driver::list_columns(h, schema, table).await,
        DbPool::ClickHouse(h) => clickhouse_driver::list_columns(h, database, table).await,
    }
}

/// Stored procedures and functions in a namespace. SQLite has no comparable
/// schema objects, so it returns an empty collection.
pub async fn list_routines(
    pool: &DbPool,
    database: &str,
    schema: &str,
) -> AppResult<Vec<RoutineInfo>> {
    match pool {
        // 返回类型用 DTD_IDENTIFIER(完整类型,如 varchar(10)):MySQL / MariaDB 都有,
        // Doris / StarRocks 的 routines 表没有 DATA_TYPE 列
        DbPool::MySql(super::MySql { pool: p, .. }) => {
            let rows = sqlx::query(
                "SELECT routine_name, \
                        CAST(CASE WHEN routine_type = 'PROCEDURE' THEN 1 ELSE 0 END AS SIGNED), \
                        CAST(external_language AS CHAR), NULLIF(CAST(dtd_identifier AS CHAR), ''), \
                        NULLIF(routine_comment, '') \
                 FROM information_schema.routines \
                 WHERE routine_schema = ? ORDER BY routine_type, routine_name",
            )
            .bind(database)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    let name: String = r.try_get(0).ok()?;
                    let is_procedure: i64 = r.try_get(1).unwrap_or(0);
                    Some(RoutineInfo {
                        name,
                        kind: if is_procedure != 0 {
                            "procedure".into()
                        } else {
                            "function".into()
                        },
                        language: r.try_get(2).ok().flatten(),
                        return_type: r.try_get(3).ok().flatten(),
                        comment: r.try_get(4).ok().flatten(),
                    })
                })
                .collect())
        }
        DbPool::Postgres(p) => {
            let rows = sqlx::query(
                "SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', \
                        CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END, \
                        l.lanname, pg_get_function_result(p.oid), \
                        obj_description(p.oid, 'pg_proc') \
                 FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 JOIN pg_language l ON l.oid = p.prolang \
                 WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') ORDER BY 2, p.proname",
            )
            .bind(schema)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    Some(RoutineInfo {
                        name: r.try_get(0).ok()?,
                        kind: r.try_get(1).unwrap_or_else(|_| "function".into()),
                        language: r.try_get(2).ok(),
                        return_type: r.try_get(3).ok().flatten(),
                        comment: r.try_get(4).ok().flatten(),
                    })
                })
                .collect())
        }
        DbPool::Sqlite(_) => Ok(vec![]),
        DbPool::Oracle(h) => oracle_driver::list_routines(h, schema).await,
        DbPool::ClickHouse(h) => clickhouse_driver::list_routines(h, database).await,
    }
}

/// Index metadata for one table. The query only reads catalogs and preserves
/// the database-defined column order.
pub async fn list_indexes(
    pool: &DbPool,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<Vec<IndexInfo>> {
    match pool {
        DbPool::MySql(super::MySql { pool: p, .. }) => {
            let rows = sqlx::query(
                "SELECT index_name, CAST(non_unique AS SIGNED), index_type, \
                        COALESCE(column_name, '') \
                 FROM information_schema.statistics \
                 WHERE table_schema = ? AND table_name = ? \
                 ORDER BY index_name, seq_in_index",
            )
            .bind(database)
            .bind(table)
            .fetch_all(p)
            .await?;
            let mut indexes: Vec<IndexInfo> = vec![];
            for row in rows {
                let name: String = row.try_get(0).unwrap_or_default();
                let non_unique: i64 = row.try_get(1).unwrap_or(1);
                let index_type: Option<String> = row.try_get(2).ok();
                let column: String = row.try_get(3).unwrap_or_default();
                if let Some(index) = indexes.iter_mut().find(|index| index.name == name) {
                    index.columns.push(column);
                } else {
                    indexes.push(IndexInfo {
                        primary: name.eq_ignore_ascii_case("PRIMARY"),
                        name,
                        columns: vec![column],
                        unique: non_unique == 0,
                        index_type,
                        definition: None,
                    });
                }
            }
            Ok(indexes)
        }
        DbPool::Postgres(p) => {
            let rows = sqlx::query(
                "SELECT ic.relname, ix.indisunique, ix.indisprimary, am.amname, \
                        pg_get_indexdef(ix.indexrelid), \
                        ARRAY(SELECT pg_get_indexdef(ix.indexrelid, n, true) \
                              FROM generate_series(1, ix.indnkeyatts) AS n ORDER BY n) \
                 FROM pg_index ix \
                 JOIN pg_class tc ON tc.oid = ix.indrelid \
                 JOIN pg_namespace ns ON ns.oid = tc.relnamespace \
                 JOIN pg_class ic ON ic.oid = ix.indexrelid \
                 JOIN pg_am am ON am.oid = ic.relam \
                 WHERE ns.nspname = $1 AND tc.relname = $2 ORDER BY ic.relname",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(p)
            .await?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    Some(IndexInfo {
                        name: r.try_get(0).ok()?,
                        unique: r.try_get(1).unwrap_or(false),
                        primary: r.try_get(2).unwrap_or(false),
                        index_type: r.try_get(3).ok(),
                        definition: r.try_get(4).ok(),
                        columns: r.try_get(5).unwrap_or_default(),
                    })
                })
                .collect())
        }
        DbPool::Sqlite(p) => {
            let _ = (database, schema);
            let safe = table.replace('\'', "''");
            let rows = sqlx::query(&format!("PRAGMA index_list('{safe}')"))
                .fetch_all(p)
                .await?;
            let mut indexes = vec![];
            for row in rows {
                let name: String = row.try_get("name").unwrap_or_default();
                let unique: i64 = row.try_get("unique").unwrap_or(0);
                let origin: String = row.try_get("origin").unwrap_or_default();
                let safe_index = name.replace('\'', "''");
                let column_rows = sqlx::query(&format!("PRAGMA index_info('{safe_index}')"))
                    .fetch_all(p)
                    .await?;
                indexes.push(IndexInfo {
                    name,
                    columns: column_rows
                        .iter()
                        .filter_map(|column| column.try_get("name").ok())
                        .collect(),
                    unique: unique != 0,
                    primary: origin == "pk",
                    index_type: Some("btree".into()),
                    definition: None,
                });
            }
            Ok(indexes)
        }
        DbPool::Oracle(h) => oracle_driver::list_indexes(h, schema, table).await,
        DbPool::ClickHouse(h) => clickhouse_driver::list_indexes(h, database, table).await,
    }
}

/// Return the database's DDL when available. PostgreSQL does not expose a
/// built-in `SHOW CREATE TABLE`, so table DDL is reconstructed from catalog
/// columns and primary-key metadata and clearly remains a read-only preview.
pub async fn get_object_ddl(
    pool: &DbPool,
    database: &str,
    schema: &str,
    table: &str,
    object_kind: &str,
) -> AppResult<String> {
    match pool {
        DbPool::MySql(super::MySql { pool: p, .. }) => {
            let database = database.replace('`', "``");
            let table = table.replace('`', "``");
            let noun = if object_kind.eq_ignore_ascii_case("view") {
                "VIEW"
            } else {
                "TABLE"
            };
            // 文本协议:SHOW CREATE 在 Doris 上不能预编译
            let sql = format!("SHOW CREATE {noun} `{database}`.`{table}`");
            let row = sqlx::Executor::fetch_one(p, sql.as_str()).await?;
            Ok(row.try_get::<String, _>(1).unwrap_or_default())
        }
        DbPool::Sqlite(p) => {
            let row = sqlx::query(
                "SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
            )
            .bind(table)
            .fetch_optional(p)
            .await?;
            Ok(row.and_then(|r| r.try_get(0).ok()).unwrap_or_default())
        }
        DbPool::Postgres(p) if object_kind.eq_ignore_ascii_case("view") => {
            let row = sqlx::query(
                "SELECT pg_get_viewdef(c.oid, true) \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')",
            )
            .bind(schema)
            .bind(table)
            .fetch_optional(p)
            .await?;
            let body: String = row.and_then(|r| r.try_get(0).ok()).unwrap_or_default();
            let schema = schema.replace('"', "\"\"");
            let table = table.replace('"', "\"\"");
            Ok(format!("CREATE VIEW \"{schema}\".\"{table}\" AS\n{body}"))
        }
        DbPool::Postgres(_) => {
            let columns = list_columns(pool, database, schema, table).await?;
            let schema = schema.replace('"', "\"\"");
            let table = table.replace('"', "\"\"");
            let mut definitions = columns
                .iter()
                .map(|column| {
                    let name = column.name.replace('"', "\"\"");
                    let mut definition = format!("  \"{name}\" {}", column.data_type);
                    if let Some(default) = &column.default_value {
                        definition.push_str(" DEFAULT ");
                        definition.push_str(default);
                    }
                    if !column.nullable {
                        definition.push_str(" NOT NULL");
                    }
                    definition
                })
                .collect::<Vec<_>>();
            let primary_keys = columns
                .iter()
                .filter(|column| column.is_primary_key)
                .map(|column| format!("\"{}\"", column.name.replace('"', "\"\"")))
                .collect::<Vec<_>>();
            if !primary_keys.is_empty() {
                definitions.push(format!("  PRIMARY KEY ({})", primary_keys.join(", ")));
            }
            Ok(format!(
                "-- Reconstructed from PostgreSQL catalog metadata\nCREATE TABLE \"{schema}\".\"{table}\" (\n{}\n);",
                definitions.join(",\n")
            ))
        }
        DbPool::Oracle(h) => oracle_driver::get_object_ddl(h, schema, table, object_kind).await,
        DbPool::ClickHouse(h) => clickhouse_driver::get_object_ddl(h, database, table).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_view_types_are_normalized_without_name_guessing() {
        assert_eq!(table_kind("VIEW"), "view");
        assert_eq!(table_kind("system view"), "view");
        assert_eq!(table_kind("MATERIALIZED VIEW"), "view");
        assert_eq!(table_kind("BASE TABLE"), "table");
        assert_eq!(table_kind("UNKNOWN"), "table");
        assert_eq!(mysql_table_kind(1), "view");
        assert_eq!(mysql_table_kind(0), "table");
    }

    #[tokio::test]
    async fn sqlite_metadata_keeps_object_types_columns_indexes_and_ddl() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sales (id INTEGER PRIMARY KEY, amount REAL NOT NULL DEFAULT 0);")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE INDEX sales_amount_idx ON sales(amount);")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE VIEW sales_view AS SELECT id, amount FROM sales;")
            .execute(&pool)
            .await
            .unwrap();
        let db_pool = DbPool::Sqlite(pool);

        let tables = list_tables(&db_pool, "main", "main").await.unwrap();
        assert_eq!(
            tables
                .iter()
                .map(|item| (item.name.as_str(), item.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![("sales", "table"), ("sales_view", "view")]
        );
        let columns = list_columns(&db_pool, "main", "main", "sales")
            .await
            .unwrap();
        assert_eq!(columns.len(), 2);
        assert!(columns[0].is_primary_key);
        assert_eq!(columns[1].ordinal_position, Some(2));
        let indexes = list_indexes(&db_pool, "main", "main", "sales")
            .await
            .unwrap();
        assert!(indexes.iter().any(|index| {
            index.name == "sales_amount_idx" && index.columns == vec!["amount".to_string()]
        }));
        let ddl = get_object_ddl(&db_pool, "main", "main", "sales", "table")
            .await
            .unwrap();
        assert!(ddl.contains("CREATE TABLE sales"));
        assert!(list_routines(&db_pool, "main", "main")
            .await
            .unwrap()
            .is_empty());
    }
}
