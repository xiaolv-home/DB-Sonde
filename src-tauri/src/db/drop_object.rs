use crate::error::{AppError, AppResult};
use crate::models::DbKind;

fn ident(kind: DbKind, name: &str) -> AppResult<String> {
    if name.is_empty() || name.contains('\0') {
        return Err(AppError::msg("对象名称不能为空或包含空字符"));
    }
    let quote = if matches!(kind, DbKind::Mysql | DbKind::Mariadb | DbKind::Clickhouse) {
        '`'
    } else {
        '"'
    };
    Ok(format!(
        "{quote}{}{quote}",
        name.replace(quote, &format!("{quote}{quote}"))
    ))
}

pub fn statement(
    kind: DbKind,
    object_kind: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<String> {
    let system = match kind {
        DbKind::Mysql | DbKind::Mariadb => {
            ["mysql", "sys", "information_schema", "performance_schema"]
                .contains(&database.to_ascii_lowercase().as_str())
        }
        DbKind::Postgres => {
            ["template0", "template1"].contains(&database.to_ascii_lowercase().as_str())
                || schema.to_ascii_lowercase().starts_with("pg_")
                || schema.eq_ignore_ascii_case("information_schema")
        }
        DbKind::Clickhouse => {
            database.eq_ignore_ascii_case("system")
                || database.eq_ignore_ascii_case("information_schema")
        }
        DbKind::Sqlite => table.to_ascii_lowercase().starts_with("sqlite_"),
        DbKind::Oracle => ["SYS", "SYSTEM"].contains(&schema.to_ascii_uppercase().as_str()),
    };
    if system {
        return Err(AppError::msg("不能从此菜单删除系统库或系统对象"));
    }
    match object_kind {
        "database"
            if matches!(
                kind,
                DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres | DbKind::Clickhouse
            ) =>
        {
            Ok(format!("DROP DATABASE {}", ident(kind, database)?))
        }
        "table" | "view" | "materialized_view" | "procedure" | "function" => {
            let keyword = object_keyword(kind, object_kind)?;
            let namespace = match kind {
                DbKind::Postgres | DbKind::Oracle => schema,
                DbKind::Sqlite => {
                    if schema.is_empty() {
                        "main"
                    } else {
                        schema
                    }
                }
                _ => database,
            };
            let target = if kind == DbKind::Postgres && matches!(object_kind, "procedure" | "function") {
                pg_routine_target(table)?
            } else {
                ident(kind, table)?
            };
            Ok(format!("DROP {keyword} {}.{target}", ident(kind, namespace)?))
        }
        _ => Err(AppError::msg(
            "此对象不支持删除；SQLite 文件和 Oracle 用户不作为数据库删除",
        )),
    }
}

/// 各引擎能删的对象类型。SQLite 没有存储过程 / 函数;ClickHouse 的函数是全局的,不挂在库下面;
/// 物化视图只有 PostgreSQL 单独用 DROP MATERIALIZED VIEW(ClickHouse 的物化视图 DROP VIEW 就能删)。
fn object_keyword(kind: DbKind, object_kind: &str) -> AppResult<&'static str> {
    let supported = match object_kind {
        "table" | "view" => true,
        "materialized_view" => kind == DbKind::Postgres,
        "procedure" | "function" => matches!(kind, DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres | DbKind::Oracle),
        _ => false,
    };
    if !supported {
        return Err(AppError::msg("这种数据库不支持从菜单删除这类对象"));
    }
    Ok(match object_kind {
        "table" => "TABLE",
        "view" => "VIEW",
        "materialized_view" => "MATERIALIZED VIEW",
        "procedure" => "PROCEDURE",
        _ => "FUNCTION",
    })
}

/// PostgreSQL 的函数 / 存储过程可以重名(重载),树上显示的名字带着参数签名,
/// 形如 `add(a integer, b integer)`(来自 pg_get_function_identity_arguments)。
/// 删除时把签名原样带上,才删得准是哪一个;签名是从前端传回来的,只放行类型名里会出现的字符。
fn pg_routine_target(label: &str) -> AppResult<String> {
    let Some(open) = label.find('(') else {
        return ident(DbKind::Postgres, label);
    };
    let (name, args) = label.split_at(open);
    let allowed = |c: char| c.is_alphanumeric() || " _,.[]()\"".contains(c);
    let balanced = args.ends_with(')')
        && args.matches('(').count() == args.matches(')').count()
        && args.matches('"').count() % 2 == 0;
    if name.is_empty() || !balanced || !args.chars().all(allowed) {
        return Err(AppError::msg("函数的参数签名里有不认识的字符,请在 SQL 编辑器里手动执行 DROP FUNCTION"));
    }
    Ok(format!("{}{args}", ident(DbKind::Postgres, name)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_exact_identifiers_and_never_cascades() {
        assert_eq!(
            statement(
                DbKind::Mysql,
                "table",
                "odd`db",
                "",
                "a`; DROP DATABASE other;--"
            )
            .unwrap(),
            "DROP TABLE `odd``db`.`a``; DROP DATABASE other;--`"
        );
        assert_eq!(
            statement(DbKind::Postgres, "table", "db", "odd\"schema", "t").unwrap(),
            "DROP TABLE \"odd\"\"schema\".\"t\""
        );
        assert_eq!(
            statement(DbKind::Clickhouse, "database", "test", "", "").unwrap(),
            "DROP DATABASE `test`"
        );
        assert!(statement(DbKind::Mysql, "database", "mysql", "", "").is_err());
        assert!(statement(DbKind::Sqlite, "database", "main", "", "").is_err());
        assert!(statement(DbKind::Mysql, "index", "db", "", "v").is_err());
        assert!(statement(DbKind::Postgres, "table", "db", "", "t").is_err());
    }
    #[test]
    fn views_and_routines_use_the_right_keyword_per_engine() {
        assert_eq!(statement(DbKind::Mysql, "view", "db", "", "v").unwrap(), "DROP VIEW `db`.`v`");
        assert_eq!(statement(DbKind::Mariadb, "procedure", "db", "", "p`x").unwrap(), "DROP PROCEDURE `db`.`p``x`");
        assert_eq!(statement(DbKind::Mysql, "function", "db", "", "f").unwrap(), "DROP FUNCTION `db`.`f`");
        assert_eq!(statement(DbKind::Postgres, "view", "db", "public", "v").unwrap(), "DROP VIEW \"public\".\"v\"");
        assert_eq!(statement(DbKind::Postgres, "materialized_view", "db", "public", "mv").unwrap(), "DROP MATERIALIZED VIEW \"public\".\"mv\"");
        assert_eq!(statement(DbKind::Oracle, "procedure", "", "QH", "P_LOAD").unwrap(), "DROP PROCEDURE \"QH\".\"P_LOAD\"");
        assert_eq!(statement(DbKind::Sqlite, "view", "main", "", "v").unwrap(), "DROP VIEW \"main\".\"v\"");
        assert_eq!(statement(DbKind::Clickhouse, "view", "db", "", "mv").unwrap(), "DROP VIEW `db`.`mv`");
        // 引擎本身没有的对象类型直接拒绝,不拼出一条注定失败的语句
        assert!(statement(DbKind::Sqlite, "procedure", "main", "", "p").is_err());
        assert!(statement(DbKind::Clickhouse, "function", "db", "", "f").is_err());
        assert!(statement(DbKind::Mysql, "materialized_view", "db", "", "v").is_err());
        // 系统库里的视图 / 过程同样不让删
        assert!(statement(DbKind::Mysql, "view", "sys", "", "version").is_err());
    }

    #[test]
    fn postgres_routines_keep_the_signature_and_refuse_injection() {
        assert_eq!(
            statement(DbKind::Postgres, "function", "db", "public", "add(a integer, b integer)").unwrap(),
            "DROP FUNCTION \"public\".\"add\"(a integer, b integer)",
            "带上签名才能在重载里删准是哪一个"
        );
        assert_eq!(
            statement(DbKind::Postgres, "procedure", "db", "s", "load(IN d timestamp with time zone, VARIADIC x text[])").unwrap(),
            "DROP PROCEDURE \"s\".\"load\"(IN d timestamp with time zone, VARIADIC x text[])"
        );
        assert_eq!(statement(DbKind::Postgres, "function", "db", "s", "noargs()").unwrap(), "DROP FUNCTION \"s\".\"noargs\"()");
        // 签名是从前端传回来的:分号、注释、引号、签名后面再接东西(CASCADE)、括号 / 双引号不配对,一律拒绝
        for bad in ["f(); DROP TABLE t", "f(a int) CASCADE", "f(a int); --", "f(a 'x')", "f(a int", "f(\"a) int)", "f(a int)/**/"] {
            assert!(statement(DbKind::Postgres, "function", "db", "s", bad).is_err(), "{bad} 应该被拒绝");
        }
    }

    #[tokio::test]
    async fn drops_only_requested_table_in_disposable_database() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE keep_me (value INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE \"odd; name\" (value INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        let sql = statement(DbKind::Sqlite, "table", "main", "main", "odd; name").unwrap();
        sqlx::query(&sql).execute(&pool).await.unwrap();
        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table'")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(names, vec!["keep_me"]);
    }
}
