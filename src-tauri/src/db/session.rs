//! 手动提交的会话事务:开、提交、回滚,在事务里执行;一批写语句要么全成要么全不成。

use std::time::Instant;

use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::Row;

use super::query::{returns_rows, run_query, strip_leading_noise};
use super::{routines, value, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{ColumnMeta, QueryResult};

/// A held transaction for a manual-commit (autocommit-off) session. Statements
/// run on this same connection until the user commits or rolls back.
pub enum SessionTx {
    MySql(sqlx::Transaction<'static, sqlx::MySql>),
    Postgres(sqlx::Transaction<'static, sqlx::Postgres>),
    Sqlite(sqlx::Transaction<'static, sqlx::Sqlite>),
}

/// 这个引擎有没有可回滚的会话事务。Oracle 不走同一套连接池,ClickHouse 压根没有
/// 会话事务 —— 批量写入时要据此决定是"要么全成要么全不成",还是只能一条条来、
/// 然后老实告诉用户跑掉了几条。
pub fn supports_session_tx(pool: &DbPool) -> bool {
    match pool {
        DbPool::MySql(m) => m.caps.transactions,
        DbPool::Postgres(_) | DbPool::Sqlite(_) => true,
        DbPool::Oracle(_) | DbPool::ClickHouse(_) => false,
    }
}

/// 不支持普通事务的 MySQL 协议引擎(Doris / StarRocks):要事务的地方直接说清楚,
/// 别真去 BEGIN —— BEGIN 会把连接卡进只许 INSERT 的导入事务,还回连接池后连累后面所有查询。
fn no_transactions() -> AppError {
    AppError::msg("这个数据库(Doris / StarRocks 一类)没有普通事务,不能关闭自动提交,语句都是即时生效的。")
}

/// Begin a manual-commit transaction on a pooled engine. Oracle isn't pooled the
/// same way, so it manages autocommit on its own connection instead.
pub async fn begin_tx(pool: &DbPool) -> AppResult<SessionTx> {
    Ok(match pool {
        DbPool::MySql(p) if !p.caps.transactions => return Err(no_transactions()),
        DbPool::MySql(p) => SessionTx::MySql(p.begin().await?),
        DbPool::Postgres(p) => SessionTx::Postgres(p.begin().await?),
        DbPool::Sqlite(p) => SessionTx::Sqlite(p.begin().await?),
        DbPool::Oracle(_) => {
            return Err(AppError::msg(
                "Manual-commit sessions aren't supported for Oracle yet.",
            ))
        }
        DbPool::ClickHouse(_) => {
            return Err(AppError::msg(
                "ClickHouse 不支持手动提交事务(它没有可回滚的会话事务)。",
            ))
        }
    })
}

/// Start a transaction suitable for dashboard reads. MySQL needs the
/// characteristic set on the same acquired connection before BEGIN; Postgres
/// accepts it immediately after BEGIN. SQLite is protected by the conservative
/// statement validator and a rollback-only transaction because its
/// `query_only` pragma would leak connection state back into the shared pool.
pub(super) async fn begin_read_only_tx(pool: &DbPool) -> AppResult<SessionTx> {
    Ok(match pool {
        DbPool::MySql(p) if !p.caps.transactions => return Err(no_transactions()),
        DbPool::MySql(p) => SessionTx::MySql(p.begin_with("START TRANSACTION READ ONLY").await?),
        DbPool::Postgres(p) => SessionTx::Postgres(p.begin_with("BEGIN READ ONLY").await?),
        DbPool::Sqlite(p) => SessionTx::Sqlite(p.begin().await?),
        DbPool::Oracle(_) => {
            return Err(AppError::msg(
                "Dashboard datasets do not support Oracle until read-only transaction isolation is available.",
            ))
        }
        DbPool::ClickHouse(_) => {
            return Err(AppError::msg(
                "ClickHouse 暂不支持看板只读事务数据集(可用编辑器直接查询)。",
            ))
        }
    })
}

pub async fn commit_tx(tx: SessionTx) -> AppResult<()> {
    match tx {
        SessionTx::MySql(t) => t.commit().await?,
        SessionTx::Postgres(t) => t.commit().await?,
        SessionTx::Sqlite(t) => t.commit().await?,
    }
    Ok(())
}

pub async fn rollback_tx(tx: SessionTx) -> AppResult<()> {
    match tx {
        SessionTx::MySql(t) => t.rollback().await?,
        SessionTx::Postgres(t) => t.rollback().await?,
        SessionTx::Sqlite(t) => t.rollback().await?,
    }
    Ok(())
}

/// 第 index 条语句的影响行数是不是调用方要求的那个数(没要求就不管)。
///
/// 表格里删一行,0 行 = 那一行已经变了,或者按整行的值没对上 —— 界面上那行消失了,
/// 库里还在;没有主键时整行一模一样的有好几行,不限定就会一起删掉。都不能当成功。
fn check_rows(expect: &[Option<u64>], index: usize, affected: u64) -> Option<String> {
    match expect.get(index).copied().flatten() {
        Some(want) if want != affected => Some(format!(
            "第 {} 条语句应影响 {want} 行,实际 {affected} 行 —— 那一行可能已经被改过或删掉了",
            index + 1
        )),
        _ => None,
    }
}

/// 一批写语句跑在**同一笔事务**里:要么全成,要么一条都不留。
///
/// Oracle / ClickHouse 没有可回滚的会话事务,只能一条条来。那就不假装原子 ——
/// 出错时把"前几条已经生效"写进错误里,让用户知道该去核对什么。
/// 最怕的是既没回滚、又不说,留下一个谁也不知道停在哪儿的半拉状态。
///
/// expect[i] = 第 i 条必须正好影响几行(空 = 不核对)。对不上:能回滚的整批撤销;
/// 不能回滚的停下并说清前几条已经生效。
pub async fn run_statements(pool: &DbPool, statements: &[String], expect: &[Option<u64>]) -> AppResult<u64> {
    if statements.is_empty() {
        return Ok(0);
    }
    if !supports_session_tx(pool) {
        let mut total = 0u64;
        for (index, sql) in statements.iter().enumerate() {
            match run_query(pool, sql, Some(0)).await {
                Ok(result) => {
                    let affected = result.rows_affected.unwrap_or(0);
                    if let Some(problem) = check_rows(expect, index, affected) {
                        // 0 行 = 这一条什么也没动;多了 = 这一条也已经生效了
                        let landed = if affected == 0 { format!("前 {index} 条") } else { format!("这一条和前 {index} 条") };
                        return Err(AppError::msg(format!(
                            "{problem}。这个数据库不支持可回滚的批量写入,{landed}已经生效,请自行核对。"
                        )));
                    }
                    total += affected;
                }
                Err(error) => {
                    return Err(AppError::msg(format!(
                        "第 {} 条语句失败:{error}。这个数据库不支持可回滚的批量写入,前 {} 条已经生效,请自行核对。",
                        index + 1,
                        index
                    )))
                }
            }
        }
        return Ok(total);
    }
    let mut tx = begin_tx(pool).await?;
    let mut total = 0u64;
    for (index, sql) in statements.iter().enumerate() {
        match run_query_on_tx(&mut tx, sql, Some(0)).await {
            Ok(result) => {
                let affected = result.rows_affected.unwrap_or(0);
                if let Some(problem) = check_rows(expect, index, affected) {
                    let _ = rollback_tx(tx).await;
                    return Err(AppError::msg(format!("{problem},这一批已撤销。")));
                }
                total += affected;
            }
            Err(error) => {
                // 回滚本身失败也不该盖掉真正的原因,原样把原错误交回去。
                let _ = rollback_tx(tx).await;
                return Err(error);
            }
        }
    }
    commit_tx(tx).await?;
    Ok(total)
}

/// A failed batch rolls back only its savepoint, preserving earlier manual work.
/// expect 同 run_statements;对不上也只撤销这一批。
pub async fn run_statements_on_tx(tx: &mut SessionTx, statements: &[String], expect: &[Option<u64>]) -> AppResult<u64> {
    use sqlx::Acquire;
    macro_rules! batch {
        ($parent:expr, |$c:ident, $sql:ident| $run:expr) => {{
            let mut nested = $parent.begin().await?;
            let mut total = 0;
            for (index, $sql) in statements.iter().enumerate() {
                let $c = &mut *nested;
                let affected = $run.await?.rows_affected();
                // 直接返回:nested 被丢掉就是回滚到保存点
                if let Some(problem) = check_rows(expect, index, affected) {
                    return Err(AppError::msg(format!("{problem},这一批已撤销。")));
                }
                total += affected;
            }
            nested.commit().await?;
            Ok(total)
        }};
    }
    match tx {
        SessionTx::MySql(t) => batch!(t, |c, sql| sqlx::Executor::execute(c, sql.as_str())),
        SessionTx::Postgres(t) => batch!(t, |c, sql| sqlx::query(sql).execute(c)),
        SessionTx::Sqlite(t) => batch!(t, |c, sql| sqlx::query(sql).execute(c)),
    }
}

/// Run a statement inside a held session transaction (autocommit off).
pub async fn run_query_on_tx(
    tx: &mut SessionTx,
    sql: &str,
    max_rows: Option<usize>,
) -> AppResult<QueryResult> {
    // No cap when the caller passes None — the editor returns every row.
    let cap = max_rows.unwrap_or(usize::MAX);
    let started = Instant::now();

    if strip_leading_noise(sql).split_whitespace().next().is_some_and(|word|word.eq_ignore_ascii_case("CALL")) {
        return routines::call_sql_tx(tx, sql, cap).await;
    }
    if !returns_rows(sql) {
        let affected = match tx {
            SessionTx::MySql(t) => sqlx::Executor::execute(&mut **t, sql).await?.rows_affected(),
            SessionTx::Postgres(t) => sqlx::query(sql).execute(&mut **t).await?.rows_affected(),
            SessionTx::Sqlite(t) => sqlx::query(sql).execute(&mut **t).await?.rows_affected(),
        };
        return Ok(QueryResult {
            additional_results: None,
            rows_affected: Some(affected),
            message: Some(format!("{affected} row(s) affected")),
            elapsed_ms: started.elapsed().as_millis(),
            ..Default::default()
        });
    }

    let mut columns: Vec<ColumnMeta> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut truncated = false;

    macro_rules! collect_tx {
        ($stream:expr, $cell:path) => {{
            let mut stream = $stream;
            while let Some(row) = stream.try_next().await? {
                if columns.is_empty() {
                    columns = value::columns_from_row(&row);
                }
                if rows.len() >= cap {
                    truncated = true;
                    break;
                }
                let n = row.columns().len();
                let mut cells = Vec::with_capacity(n);
                for i in 0..n {
                    cells.push($cell(&row, i));
                }
                rows.push(cells);
            }
        }};
    }

    match tx {
        SessionTx::MySql(t) => collect_tx!(sqlx::Executor::fetch(&mut **t, sql), value::mysql_value),
        SessionTx::Postgres(t) => collect_tx!(sqlx::query(sql).fetch(&mut **t), value::pg_value),
        SessionTx::Sqlite(t) => collect_tx!(sqlx::query(sql).fetch(&mut **t), value::sqlite_value),
    }

    Ok(QueryResult {
            additional_results: None,
        columns,
        rows,
        rows_affected: None,
        truncated,
        elapsed_ms: started.elapsed().as_millis(),
        message: None,
    })
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn scalar_name(pool: &sqlx::SqlitePool) -> String {
        sqlx::query_scalar::<_, String>("SELECT name FROM items WHERE id = 1")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn session_tx_rolls_back_and_commits() {
        // One connection keeps the in-memory database alive across acquires.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO items (id, name) VALUES (1, 'before')")
            .execute(&pool)
            .await
            .unwrap();
        let db_pool = DbPool::Sqlite(pool.clone());

        // Autocommit off: an update inside the session, then rollback -> unchanged.
        let mut tx = begin_tx(&db_pool).await.unwrap();
        run_query_on_tx(
            &mut tx,
            "UPDATE items SET name = 'rolled' WHERE id = 1",
            None,
        )
        .await
        .unwrap();
        rollback_tx(tx).await.unwrap();
        assert_eq!(scalar_name(&pool).await, "before");

        // Autocommit off: an update inside the session, then commit -> persisted.
        let mut tx = begin_tx(&db_pool).await.unwrap();
        run_query_on_tx(
            &mut tx,
            "UPDATE items SET name = 'after' WHERE id = 1",
            None,
        )
        .await
        .unwrap();
        commit_tx(tx).await.unwrap();
        assert_eq!(scalar_name(&pool).await, "after");
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    async fn fixture() -> (DbPool, sqlx::SqlitePool) {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        (DbPool::Sqlite(pool.clone()), pool)
    }
    async fn ids(pool: &sqlx::SqlitePool) -> Vec<i64> {
        sqlx::query_scalar("SELECT id FROM items ORDER BY id")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    /// 全成的时候该全部落库。
    #[tokio::test]
    async fn all_statements_land_when_every_one_succeeds() {
        let (db, raw) = fixture().await;
        let affected = run_statements(
            &db,
            &[
                "INSERT INTO items (id, name) VALUES (1, 'a')".to_string(),
                "INSERT INTO items (id, name) VALUES (2, 'b')".to_string(),
                "DELETE FROM items WHERE id = 1".to_string(),
            ],
            &[],
        )
        .await
        .unwrap();
        assert_eq!(affected, 3, "三条各影响一行");
        assert_eq!(ids(&raw).await, vec![2]);
    }

    /// 中间失败要整笔回滚 —— 这正是表详情"增行/删行"原来出的事:
    /// 删到第三条炸了,前两条已经生效,而界面还显示着那两行。
    #[tokio::test]
    async fn a_failure_midway_rolls_the_whole_batch_back() {
        let (db, raw) = fixture().await;
        sqlx::query("INSERT INTO items (id, name) VALUES (1, 'keep'), (2, 'keep')")
            .execute(&raw)
            .await
            .unwrap();

        let error = run_statements(
            &db,
            &[
                "DELETE FROM items WHERE id = 1".to_string(),
                "DELETE FROM items WHERE id = 2".to_string(),
                // NOT NULL 约束:这条必炸
                "INSERT INTO items (id, name) VALUES (3, NULL)".to_string(),
            ],
            &[],
        )
        .await
        .unwrap_err();
        assert!(!format!("{error:?}").is_empty(), "要把失败原因交回去");
        assert_eq!(
            ids(&raw).await,
            vec![1, 2],
            "第三条失败,前两条的删除必须一起回滚 —— 不能留下半拉状态"
        );
    }

    /// 表格删行要求每条正好删一行:一条落空(那一行已经变了、或按整行的值没对上),
    /// 整批撤销 —— 不能界面上那行消失了,库里还在;前面删掉的也得回来。
    #[tokio::test]
    async fn a_delete_that_misses_its_row_rolls_the_batch_back() {
        let (db, raw) = fixture().await;
        sqlx::query("INSERT INTO items (id, name) VALUES (1, 'a'), (2, 'b')").execute(&raw).await.unwrap();
        let error = run_statements(
            &db,
            &["DELETE FROM items WHERE id = 1".to_string(), "DELETE FROM items WHERE id = 99".to_string()],
            &[Some(1), Some(1)],
        )
        .await
        .unwrap_err();
        assert!(format!("{error}").contains("第 2 条语句应影响 1 行,实际 0 行"), "{error}");
        assert_eq!(ids(&raw).await, vec![1, 2], "第一条也得撤销");
        // 不核对的语句不受影响
        assert_eq!(run_statements(&db, &["DELETE FROM items WHERE id = 99".to_string()], &[None]).await.unwrap(), 0);
    }

    /// 空批次不该去开一笔事务。
    #[tokio::test]
    async fn empty_batch_is_a_no_op() {
        let (db, raw) = fixture().await;
        assert_eq!(run_statements(&db, &[], &[]).await.unwrap(), 0);
        assert!(ids(&raw).await.is_empty());
    }

    /// 哪些引擎有可回滚的会话事务 —— 决定上面走原子那条路还是老实报"跑掉了几条"。
    #[tokio::test]
    async fn only_pooled_engines_claim_session_transactions() {
        let (db, _raw) = fixture().await;
        assert!(supports_session_tx(&db), "SQLite 有");
    }
}
