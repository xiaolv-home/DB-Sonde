//! 建连接:MySQL 一族 / PostgreSQL / SQLite 开连接池,顺带读出服务器版本、当前库和能力。Oracle、ClickHouse 走各自的驱动。

use std::str::FromStr;
use std::time::Duration;

use serde_json::Value;

use super::{clickhouse_driver, oracle_driver, value, ConnectInfo, DbPool, MySql, MySqlCaps};
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionConfig, DbKind};

fn effective_port(cfg: &ConnectionConfig) -> u16 {
    if cfg.port == 0 {
        cfg.kind.default_port()
    } else {
        cfg.port
    }
}

/// Open a pool for the given profile. `password` is passed separately so it
/// never has to live in the persisted config.
pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectInfo> {
    match cfg.kind {
        DbKind::Mysql | DbKind::Mariadb => connect_mysql(cfg, password).await,
        DbKind::Postgres => connect_postgres(cfg, password).await,
        DbKind::Sqlite => connect_sqlite(cfg).await,
        DbKind::Oracle => oracle_driver::connect(cfg, password).await,
        DbKind::Clickhouse => clickhouse_driver::connect(cfg, password).await,
    }
}

async fn connect_mysql(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectInfo> {
    use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};

    let ssl = match cfg.ssl_mode.as_deref() {
        Some("disable") => MySqlSslMode::Disabled,
        Some("require") => MySqlSslMode::Required,
        _ => MySqlSslMode::Preferred,
    };

    let mut opts = MySqlConnectOptions::new()
        .host(&cfg.host)
        .port(effective_port(cfg))
        .username(&cfg.username)
        .ssl_mode(ssl);
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if !cfg.database.is_empty() {
        opts = opts.database(&cfg.database);
    }

    let pool = MySqlPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(45))
        .connect_with(opts)
        .await?;

    let probe = DbPool::MySql(MySql { pool: pool.clone(), caps: MySqlCaps::FULL });
    let server_version = fetch_scalar(&probe, "SELECT VERSION()").await.unwrap_or_default();
    let current_database = fetch_scalar(&probe, "SELECT DATABASE()").await.unwrap_or_default();
    let caps = MySqlCaps::from_version_comment(&fetch_scalar(&probe, "SELECT @@version_comment").await.unwrap_or_default());

    Ok(ConnectInfo {
        pool: DbPool::MySql(MySql { pool, caps }),
        server_version,
        current_database,
    })
}

async fn connect_postgres(
    cfg: &ConnectionConfig,
    password: Option<&str>,
) -> AppResult<ConnectInfo> {
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};

    let ssl = match cfg.ssl_mode.as_deref() {
        Some("disable") => PgSslMode::Disable,
        Some("require") => PgSslMode::Require,
        _ => PgSslMode::Prefer,
    };

    let database = if cfg.database.is_empty() {
        "postgres".to_string()
    } else {
        cfg.database.clone()
    };

    let mut opts = PgConnectOptions::new()
        .host(&cfg.host)
        .port(effective_port(cfg))
        .username(&cfg.username)
        .database(&database)
        .ssl_mode(ssl);
    if let Some(pw) = password {
        opts = opts.password(pw);
    }

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(45))
        .connect_with(opts)
        .await?;

    let server_version = fetch_scalar(&DbPool::Postgres(pool.clone()), "SHOW server_version")
        .await
        .unwrap_or_default();
    let current_database =
        fetch_scalar(&DbPool::Postgres(pool.clone()), "SELECT current_database()")
            .await
            .unwrap_or(database);

    Ok(ConnectInfo {
        pool: DbPool::Postgres(pool),
        server_version,
        current_database,
    })
}

async fn connect_sqlite(cfg: &ConnectionConfig) -> AppResult<ConnectInfo> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    if cfg.database.is_empty() {
        return Err(AppError::msg("SQLite needs a database file path."));
    }

    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", cfg.database))
        .map_err(|e| AppError::msg(format!("bad SQLite path: {e}")))?
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(45))
        .connect_with(opts)
        .await?;

    let server_version = fetch_scalar(&DbPool::Sqlite(pool.clone()), "SELECT sqlite_version()")
        .await
        .map(|v| format!("SQLite {v}"))
        .unwrap_or_default();

    Ok(ConnectInfo {
        pool: DbPool::Sqlite(pool),
        server_version,
        current_database: cfg.database.clone(),
    })
}

/// Fetch the first column of the first row as a string. Used for version and
/// current-database probes.
async fn fetch_scalar(pool: &DbPool, sql: &str) -> Option<String> {
    let value = match pool {
        // 文本协议;sqlx 的 raw_sql 没有真正的 fetch_optional(它内部就是 fetch_one),没行就当没有
        DbPool::MySql(p) => sqlx::raw_sql(sql)
            .fetch_one(&p.pool)
            .await
            .ok()
            .map(|r| value::mysql_value(&r, 0)),
        DbPool::Postgres(p) => sqlx::query(sql)
            .fetch_optional(p)
            .await
            .ok()
            .flatten()
            .map(|r| value::pg_value(&r, 0)),
        DbPool::Sqlite(p) => sqlx::query(sql)
            .fetch_optional(p)
            .await
            .ok()
            .flatten()
            .map(|r| value::sqlite_value(&r, 0)),
        DbPool::Oracle(_) => None,
        DbPool::ClickHouse(_) => None,
    };
    match value {
        Some(Value::String(s)) => Some(s),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }
}
