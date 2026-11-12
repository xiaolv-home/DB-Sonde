use super::{value, DbPool, SessionTx};
use crate::{
    error::{AppError, AppResult},
    models::QueryResult,
};
use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::{Executor, Row};
use std::time::Instant;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Parameter {
    pub name: String,
    pub mode: String,
    pub data_type: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub name: String,
    pub kind: String,
    pub definition: Option<String>,
    pub parameters: Vec<Parameter>,
}
fn ident(name: &str, mysql: bool) -> String {
    let quote = if mysql { '`' } else { '"' };
    format!(
        "{quote}{}{quote}",
        name.replace(quote, &format!("{quote}{quote}"))
    )
}
pub async fn details(
    pool: &DbPool,
    database: &str,
    schema: &str,
    name: &str,
    kind: &str,
) -> AppResult<Details> {
    if !matches!(kind, "procedure" | "function") {
        return Err(AppError::msg("无效的例程类型"));
    }
    match pool {
        DbPool::MySql(super::MySql { pool, .. }) => {
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? AND ROUTINE_NAME=? AND ROUTINE_TYPE=?")
                .bind(database).bind(name).bind(kind.to_uppercase()).fetch_one(pool).await?;
            if exists != 1 {
                return Err(AppError::msg(
                    "存储过程或函数不存在，或当前账号没有查看权限",
                ));
            }
            let rows = sqlx::query("SELECT PARAMETER_NAME, PARAMETER_MODE, DTD_IDENTIFIER FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=? AND SPECIFIC_NAME=? AND ROUTINE_TYPE=? AND ORDINAL_POSITION>0 ORDER BY ORDINAL_POSITION")
                .bind(database).bind(name).bind(kind.to_uppercase()).fetch_all(pool).await?;
            let parameters = rows
                .iter()
                .enumerate()
                .map(|(i, r)| Parameter {
                    name: r
                        .try_get::<String, _>(0)
                        .unwrap_or_else(|_| format!("参数{}", i + 1)),
                    mode: r.try_get(1).unwrap_or_else(|_| "IN".into()),
                    data_type: r.try_get(2).unwrap_or_default(),
                })
                .collect();
            let sql = format!(
                "SHOW CREATE {} {}.{}",
                kind.to_uppercase(),
                ident(database, true),
                ident(name, true)
            );
            let definition = sqlx::query(&sql)
                .fetch_one(pool)
                .await
                .ok()
                .and_then(|r| r.try_get::<Option<String>, _>(2).ok().flatten());
            Ok(Details {
                name: name.into(),
                kind: kind.into(),
                definition,
                parameters,
            })
        }
        DbPool::Postgres(pool) => {
            // Match the full identity shown in the tree, not just an overloaded name.
            let row = sqlx::query("SELECT p.oid::bigint, p.proname, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind::text=$2 AND (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')=$3")
                .bind(schema).bind(if kind=="procedure" {"p"} else {"f"}).bind(name).fetch_optional(pool).await?.ok_or_else(||AppError::msg("存储过程或函数不存在，或签名已变更，请刷新目录"))?;
            let oid: i64 = row.try_get(0)?;
            let rows=sqlx::query("SELECT COALESCE(p.proargnames[a.ord::int], '参数' || a.ord::text), COALESCE(p.proargmodes[a.ord::int]::text,'i'), format_type(a.type_oid,NULL) FROM pg_proc p CROSS JOIN LATERAL unnest(COALESCE(p.proallargtypes,p.proargtypes::oid[])) WITH ORDINALITY a(type_oid,ord) WHERE p.oid=$1::bigint::oid ORDER BY a.ord")
                .bind(oid).fetch_all(pool).await?;
            let mut parameters = Vec::new();
            for r in rows {
                let mode: String = r.try_get(1)?;
                if kind == "function" && matches!(mode.as_str(), "o" | "t") {
                    continue;
                }
                parameters.push(Parameter {
                    name: r.try_get(0)?,
                    mode: match mode.as_str() {
                        "o" => "OUT",
                        "b" => "INOUT",
                        "v" => "VARIADIC",
                        _ => "IN",
                    }
                    .into(),
                    data_type: r.try_get(2)?,
                });
            }
            Ok(Details {
                name: row.try_get(1)?,
                kind: kind.into(),
                definition: row.try_get(2).ok(),
                parameters,
            })
        }
        _ => Err(AppError::msg(
            "该执行面板目前支持 MySQL、MariaDB 和 PostgreSQL 的存储过程与函数",
        )),
    }
}

// Every command completion marks a result-set boundary; never merge differently
// shaped SELECT results returned by one CALL. Drain the stream even at the cap.
macro_rules! collect_results {
    ($conn:expr, $query:expr, $cell:path, $cap:expr) => {{
        let started = Instant::now();
        let mut results = Vec::new();
        let mut current = QueryResult::default();
        let mut stream = Executor::fetch_many($conn, $query);
        while let Some(item) = stream.try_next().await? {
            match item {
                sqlx::Either::Right(row) => {
                    if current.columns.is_empty() {
                        current.columns = value::columns_from_row(&row);
                    }
                    if current.rows.len() < $cap {
                        current
                            .rows
                            .push((0..current.columns.len()).map(|i| $cell(&row, i)).collect());
                    } else {
                        current.truncated = true;
                    }
                }
                sqlx::Either::Left(done) => {
                    current.rows_affected = Some(done.rows_affected());
                    current.elapsed_ms = started.elapsed().as_millis();
                    results.push(std::mem::take(&mut current));
                }
            }
        }
        if !current.columns.is_empty() {
            results.push(current);
        }
        if results.is_empty() {
            results.push(QueryResult::default());
        }
        results
    }};
}

pub async fn mysql_sql(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    cap: usize,
) -> AppResult<Vec<QueryResult>> {
    Ok(collect_results!(conn, sql, value::mysql_value, cap))
}
pub async fn pg_sql(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    cap: usize,
) -> AppResult<Vec<QueryResult>> {
    Ok(collect_results!(conn, sql, value::pg_value, cap))
}
pub fn combine(mut sets: Vec<QueryResult>) -> QueryResult {
    // CALL's trailing OK packet is not a second empty table.
    if sets.len() > 1
        && sets
            .last()
            .is_some_and(|r| r.columns.is_empty() && r.rows_affected.unwrap_or(0) == 0)
    {
        sets.pop();
    }
    let mut first = if sets.is_empty() {
        QueryResult::default()
    } else {
        sets.remove(0)
    };
    if !sets.is_empty() {
        first.additional_results = Some(sets);
    }
    first
}
pub async fn call_sql(pool: &DbPool, sql: &str, cap: usize) -> AppResult<QueryResult> {
    let sets = match pool {
        DbPool::MySql(super::MySql { pool, .. }) => mysql_sql(&mut *pool.acquire().await?, sql, cap).await?,
        DbPool::Postgres(pool) => pg_sql(&mut *pool.acquire().await?, sql, cap).await?,
        _ => return Err(AppError::msg("该数据库不支持 CALL 执行")),
    };
    Ok(combine(sets))
}
pub async fn call_sql_tx(tx: &mut SessionTx, sql: &str, cap: usize) -> AppResult<QueryResult> {
    let sets = match tx {
        SessionTx::MySql(tx) => mysql_sql(&mut **tx, sql, cap).await?,
        SessionTx::Postgres(tx) => pg_sql(&mut **tx, sql, cap).await?,
        _ => return Err(AppError::msg("该数据库不支持 CALL 执行")),
    };
    Ok(combine(sets))
}
fn validate_values(details: &Details, values: &[Option<String>]) -> AppResult<()> {
    if details.parameters.len() != values.len() {
        return Err(AppError::msg("参数数量已变更，请重新打开执行面板"));
    }
    Ok(())
}
pub async fn execute_mysql(
    conn: &mut sqlx::MySqlConnection,
    database: &str,
    d: &Details,
    values: &[Option<String>],
) -> AppResult<Vec<QueryResult>> {
    validate_values(d, values)?;
    // Reuse reserved session slots; UUID names would grow pooled-session state on every run.
    let prefix = "sonde_routine_param";
    let mut args = Vec::new();
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    for (i, p) in d.parameters.iter().enumerate() {
        if matches!(p.mode.as_str(), "OUT" | "INOUT") {
            let variable = format!("@{prefix}_{i}");
            sqlx::query(&format!("SET {variable} = ?"))
                .bind(if p.mode == "OUT" {
                    None
                } else {
                    values[i].clone()
                })
                .execute(&mut *conn)
                .await?;
            args.push(variable.clone());
            outputs.push(format!("{variable} AS {}", ident(&p.name, true)));
        } else {
            args.push("?".into());
            inputs.push(values[i].clone());
        }
    }
    let sql = format!(
        "{} {}.{}({})",
        if d.kind == "procedure" {
            "CALL"
        } else {
            "SELECT"
        },
        ident(database, true),
        ident(&d.name, true),
        args.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for value in inputs {
        query = query.bind(value);
    }
    let mut sets = collect_results!(&mut *conn, query, value::mysql_value, 100_000);
    if !outputs.is_empty() {
        sets.extend(mysql_sql(conn, &format!("SELECT {}", outputs.join(", ")), 100_000).await?);
    }
    Ok(sets)
}
pub async fn execute_pg(
    conn: &mut sqlx::PgConnection,
    schema: &str,
    d: &Details,
    values: &[Option<String>],
) -> AppResult<Vec<QueryResult>> {
    validate_values(d, values)?;
    let mut inputs = Vec::new();
    let mut args = Vec::new();
    for (i, p) in d.parameters.iter().enumerate() {
        if p.mode == "OUT" {
            args.push("NULL".into());
            continue;
        }
        inputs.push(values[i].clone());
        args.push(format!(
            "{}${}::text::{}",
            if p.mode == "VARIADIC" {
                "VARIADIC "
            } else {
                ""
            },
            inputs.len(),
            p.data_type
        ));
    }
    let sql = format!(
        "{} {}.{}({})",
        if d.kind == "procedure" {
            "CALL"
        } else {
            "SELECT * FROM"
        },
        ident(schema, false),
        ident(&d.name, false),
        args.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for value in inputs {
        query = query.bind(value);
    }
    Ok(collect_results!(conn, query, value::pg_value, 100_000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ColumnMeta;

    fn result(name: &str, value: serde_json::Value) -> QueryResult {
        QueryResult {
            columns: vec![ColumnMeta {
                name: name.into(),
                type_name: "VARCHAR".into(),
            }],
            rows: vec![vec![value]],
            ..Default::default()
        }
    }
    #[test]
    fn retains_distinct_result_shapes_and_output_parameters() {
        let merged = combine(vec![
            result("id", serde_json::json!(1)),
            result("message", serde_json::json!("done")),
            QueryResult::default(),
        ]);
        assert_eq!(merged.columns[0].name, "id");
        let more = merged.additional_results.unwrap();
        assert_eq!(more.len(), 1);
        assert_eq!(more[0].columns[0].name, "message");
        assert_eq!(more[0].rows[0][0], serde_json::json!("done"));
    }
    #[test]
    fn retains_empty_intermediate_results_and_affected_rows() {
        let merged = combine(vec![
            QueryResult::default(),
            result("x", serde_json::json!(1)),
            QueryResult {
                rows_affected: Some(3),
                ..Default::default()
            },
        ]);
        assert!(merged.columns.is_empty());
        assert_eq!(merged.additional_results.as_ref().unwrap().len(), 2);
        assert_eq!(merged.additional_results.unwrap()[1].rows_affected, Some(3));
    }
    #[test]
    fn quotes_routine_and_parameter_identifiers() {
        assert_eq!(
            ident("a`; DROP DATABASE x; --", true),
            "`a``; DROP DATABASE x; --`"
        );
        assert_eq!(ident("a\"b", false), "\"a\"\"b\"");
    }
    #[test]
    fn rejects_changed_parameter_count() {
        let d = Details {
            name: "p".into(),
            kind: "procedure".into(),
            definition: None,
            parameters: vec![Parameter {
                name: "code".into(),
                mode: "IN".into(),
                data_type: "text".into(),
            }],
        };
        assert!(validate_values(&d, &[]).is_err());
        assert!(validate_values(&d, &[Some("0001' OR 1=1".into())]).is_ok());
        assert!(validate_values(&d, &[None]).is_ok());
    }
}
