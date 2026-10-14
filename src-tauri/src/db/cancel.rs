//! 「停止」:按语句里的标记在服务器端取消正在跑的语句;按进程号结束会话。

use std::time::Duration;


use super::DbPool;
use crate::error::{AppError, AppResult};

/// 哪些库能按标记取消正在跑的语句(和 cancel_marked_query 的分支保持一致)。
pub fn cancel_supported(kind: crate::models::DbKind) -> bool {
    use crate::models::DbKind;
    matches!(kind, DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres)
}

/// 编辑器每条语句前加的标记 `/* sonde:<run_id> */`。「停止」按钮靠它在服务器的
/// 运行列表里找到这一条(MySQL 的 PROCESSLIST.INFO、PostgreSQL 的 pg_stat_activity.query
/// 都保留注释原文)。run_id 只许字母数字和 `-`:不会提前结束注释,也不是 LIKE 通配符。
pub fn run_marker(run_id: &str) -> Option<String> {
    let ok = !run_id.is_empty() && run_id.len() <= 64 && run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| format!("sonde:{run_id}"))
}

/// 「停止」:找到带这个标记、正在跑的语句,在服务器端取消它(只取消语句,不断开会话 ——
/// 手动提交模式下事务还在)。返回取消了几条;0 表示没找到(已经跑完,或这种库不支持)。
///
/// 用一条新开的独立连接去发取消:慢查询可能正把连接池占满,从池里借要排队 45 秒。
pub async fn cancel_marked_query(pool: &DbPool, marker: &str) -> AppResult<u64> {
    let like = format!("%{marker}%");
    match pool {
        DbPool::MySql(p) => {
            // 单连接的小池子 = 一条新开的独立连接(直接拿 &mut 连接在命令里会撞 sqlx 的生命周期限制)
            let side = sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(10))
                .connect_with((*p.connect_options()).clone())
                .await?;
            let ids: Vec<u64> = sqlx::query_scalar(
                "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND ID <> CONNECTION_ID()",
            )
            .bind(&like)
            .fetch_all(&side)
            .await?;
            for id in &ids {
                // KILL 不能走预处理协议;id 是数据库返回的整数,拼进去是安全的
                sqlx::raw_sql(&format!("KILL QUERY {id}")).execute(&side).await?;
            }
            side.close().await;
            Ok(ids.len() as u64)
        }
        DbPool::Postgres(p) => {
            let side = sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(10))
                .connect_with((*p.connect_options()).clone())
                .await?;
            let n: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FILTER (WHERE pg_cancel_backend(pid)) FROM pg_stat_activity \
                 WHERE query LIKE $1 AND pid <> pg_backend_pid() AND state = 'active'",
            )
            .bind(&like)
            .fetch_one(&side)
            .await?;
            side.close().await;
            Ok(n.max(0) as u64)
        }
        // SQLite 在本机、Oracle / ClickHouse 走各自驱动:暂不支持服务器端取消,界面只停止等待
        _ => Ok(0),
    }
}

/// Kill a server-side session/process by id. MySQL uses the text protocol
/// (KILL is not allowed in the prepared-statement protocol); Postgres uses
/// pg_terminate_backend. `id` is a typed integer, so it is injection-safe.
pub async fn kill_process(pool: &DbPool, id: i64) -> AppResult<()> {
    match pool {
        DbPool::MySql(p) => {
            sqlx::raw_sql(&format!("KILL {id}")).execute(&p.pool).await?;
        }
        DbPool::Postgres(p) => {
            sqlx::query("SELECT pg_terminate_backend($1)")
                .bind(id as i32)
                .execute(p)
                .await?;
        }
        DbPool::Sqlite(_) | DbPool::Oracle(_) | DbPool::ClickHouse(_) => {
            return Err(AppError::msg("This engine has no killable server processes."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod cancel_tests {
    use super::*;
    use crate::db::{run_query, MySql, MySqlCaps};
    use std::time::Instant;

    #[test]
    fn markers_only_go_to_databases_that_can_cancel_by_marker() {
        use crate::models::DbKind;
        for kind in [DbKind::Mysql, DbKind::Mariadb, DbKind::Postgres] {
            assert!(cancel_supported(kind), "{kind:?} 能按标记取消");
        }
        // Oracle 的 thin 驱动遇到开头的注释会发畸形包被服务端掐线;SQLite / ClickHouse 不支持按标记取消
        for kind in [DbKind::Oracle, DbKind::Sqlite, DbKind::Clickhouse] {
            assert!(!cancel_supported(kind), "{kind:?} 不该加标记");
        }
    }

    #[test]
    fn run_markers_cannot_break_out_of_the_comment_or_widen_the_match() {
        assert_eq!(run_marker("q1-abc").as_deref(), Some("sonde:q1-abc"));
        for bad in ["", "a*/ DROP", "x%", "x_y", "a b", &"z".repeat(65)] {
            assert!(run_marker(bad).is_none(), "{bad} 应该被拒");
        }
    }

    /// 「停止」在真 MySQL 上的效果:一条要睡 20 秒的语句,1 秒后按停止,应在几秒内结束。
    #[tokio::test]
    #[ignore = "requires SONDE_TEST_MYSQL_HOST and SONDE_TEST_MYSQL_USER"]
    async fn stop_cancels_a_running_mysql_statement_on_the_server() {
        let options = sqlx::mysql::MySqlConnectOptions::new()
            .host(&std::env::var("SONDE_TEST_MYSQL_HOST").expect("test MySQL host"))
            .port(std::env::var("SONDE_TEST_MYSQL_PORT").unwrap_or_else(|_| "3306".into()).parse().unwrap())
            .username(&std::env::var("SONDE_TEST_MYSQL_USER").expect("test MySQL user"))
            .password(&std::env::var("SONDE_TEST_MYSQL_PASSWORD").unwrap_or_default());
        let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(2).connect_with(options).await.unwrap();
        let db = DbPool::MySql(MySql { pool: pool.clone(), caps: MySqlCaps::FULL });
        let marker = run_marker("stop-test-1").unwrap();
        let sql = format!("/* {marker} */ SELECT SLEEP(20) AS s");
        let started = Instant::now();
        let running = tokio::spawn({ let db = DbPool::MySql(MySql { pool: pool.clone(), caps: MySqlCaps::FULL }); async move { run_query(&db, &sql, Some(10)).await } });
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let cancelled = cancel_marked_query(&db, &marker).await.unwrap();
        assert_eq!(cancelled, 1, "应当找到并取消那一条");
        let outcome = tokio::time::timeout(Duration::from_secs(5), running).await.expect("停止后 5 秒内必须结束").unwrap();
        assert!(started.elapsed() < Duration::from_secs(8), "用了 {:?},没有被取消", started.elapsed());
        // MySQL 被 KILL QUERY 打断的 SLEEP 返回 1(而不是睡满返回 0)
        let r = outcome.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!(1));
        // 已经跑完的再按停止:什么都不做
        assert_eq!(cancel_marked_query(&db, &marker).await.unwrap(), 0);
    }
}
