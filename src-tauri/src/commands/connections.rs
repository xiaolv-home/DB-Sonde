//! 连接:保存的连接配置、测试 / 连上 / 断开,以及本地 SQLite 示例库。

use tauri::{AppHandle, Manager, State};

use super::{clear_database_pools, clear_session, ActiveConn, AppState};
use crate::db::{self, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionConfig, ConnectionMeta, DbKind};
use crate::store;

// --- saved connection profiles --------------------------------------------

#[tauri::command]
pub fn list_connections(app: AppHandle) -> AppResult<Vec<ConnectionConfig>> {
    store::load_connections(&app)
}

#[tauri::command]
pub fn save_connection(app: AppHandle, config: ConnectionConfig) -> AppResult<ConnectionConfig> {
    let mut list = store::load_connections(&app)?;
    if let Some(existing) = list.iter_mut().find(|c| c.id == config.id) {
        if crate::credentials::account(existing) != crate::credentials::account(&config) { crate::credentials::remove(&app, existing)?; }
        *existing = config.clone();
    } else {
        list.push(config.clone());
    }
    store::save_connections(&app, &list)?;

    Ok(config)
}

#[tauri::command]
pub async fn delete_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let mut list = store::load_connections(&app)?;
    if let Some(config) = list.iter().find(|c| c.id == id) { crate::credentials::remove(&app, config)?; }
    list.retain(|c| c.id != id);
    store::save_connections(&app, &list)?;
    state.conns.write().await.remove(&id);
    clear_database_pools(&state, &id).await;
    clear_session(&state, &id).await;
    Ok(())
}

// --- connecting ------------------------------------------------------------

#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    config: ConnectionConfig,
    password: Option<String>,
) -> AppResult<String> {
    let password = match password { Some(value) => Some(value), None => crate::credentials::load(&app, &config)? };
    let info = db::connect(&config, password.as_deref()).await?;
    let version = info.server_version.clone();
    // Drop the pool; this was only a probe.
    drop(info);
    Ok(if version.is_empty() {
        "Connected".to_string()
    } else {
        version
    })
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> AppResult<ConnectionMeta> {
    let list = store::load_connections(&app)?;
    let cfg = list
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::UnknownConnection(id.clone()))?;

    let supplied = password.is_some();
    let pw = if cfg.kind == DbKind::Sqlite { None } else {
        match password { Some(value) => Some(value), None => crate::credentials::load(&app, &cfg)? }
    };
    if cfg.kind != DbKind::Sqlite && pw.is_none() { return Err(AppError::msg("CREDENTIAL_REQUIRED: 请输入数据库密码，成功连接后会加密保存")); }
    let info = db::connect(&cfg, pw.as_deref()).await.map_err(|error| {
        let auth_error = match &error {
            AppError::Db(sqlx::Error::Database(db)) => matches!(db.code().as_deref(), Some("1045" | "28P01" | "28000")),
            _ => error.to_string().contains("ORA-01017") || error.to_string().contains("AUTHENTICATION_FAILED"),
        };
        if !supplied && auth_error { AppError::msg("CREDENTIAL_REJECTED: 保存的密码已失效，请重新输入") } else { error }
    })?;
    // Only successful authentication may replace saved credentials.
    let credential_warning = if supplied && cfg.kind != DbKind::Sqlite {
        crate::credentials::save(&app, &cfg, pw.as_deref().unwrap_or("")).err().map(|_| "连接成功，但凭据未能保存。请检查本地凭据文件权限或完整性。".to_string())
    } else { None };

    let meta = ConnectionMeta {
        credential_warning,
        id: id.clone(),
        kind: cfg.kind,
        server_version: info.server_version.clone(),
        current_database: info.current_database.clone(),
        has_schemas: matches!(cfg.kind, DbKind::Postgres | DbKind::Oracle),
        has_multiple_databases: matches!(
            cfg.kind,
            DbKind::Mysql | DbKind::Mariadb | DbKind::Postgres
        ),
        manual_transactions: db::supports_session_tx(&info.pool),
    };

    clear_database_pools(&state, &id).await;
    clear_session(&state, &id).await;
    state.conns.write().await.insert(
        id,
        ActiveConn {
            kind: cfg.kind,
            pool: info.pool,
            current_database: info.current_database,
            config: cfg,
            session_password: pw,
        },
    );
    Ok(meta)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.conns.write().await.remove(&id);
    clear_database_pools(&state, &id).await;
    clear_session(&state, &id).await;
    Ok(())
}

// --- demo database ---------------------------------------------------------

/// Create (or reuse) a local SQLite demo database seeded with sample data, and
/// register it as a saved connection. Lets the app do something useful with no
/// external server.
#[tauri::command]
pub async fn create_demo(app: AppHandle) -> AppResult<ConnectionConfig> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("cannot resolve config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("demo.db");
    let db_path_str = db_path.to_string_lossy().to_string();

    let cfg = ConnectionConfig {
        id: "demo-sqlite".to_string(),
        name: "Demo (SQLite)".to_string(),
        kind: DbKind::Sqlite,
        host: String::new(),
        port: 0,
        username: String::new(),
        database: db_path_str.clone(),
        ssl_mode: None,
        color: Some("#3b9c7a".to_string()),
        brand: None,
        oracle_thick: false,
    };

    let info = db::connect(&cfg, None).await?;
    if let DbPool::Sqlite(pool) = &info.pool {
        seed_demo(pool).await?;
    }
    drop(info);

    // Register it as a saved connection (idempotent upsert).
    let mut list = store::load_connections(&app)?;
    if !list.iter().any(|c| c.id == cfg.id) {
        list.push(cfg.clone());
        store::save_connections(&app, &list)?;
    }
    Ok(cfg)
}

async fn seed_demo(pool: &sqlx::SqlitePool) -> AppResult<()> {
    // Only seed once.
    let already: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='demo_sales'",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if already > 0 {
        return Ok(());
    }

    let ddl = [
        "CREATE TABLE demo_customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, created_at TEXT)",
        "CREATE TABLE demo_products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, price REAL)",
        "CREATE TABLE demo_sales (id INTEGER PRIMARY KEY, sale_date TEXT NOT NULL, product_id INTEGER, amount REAL, quantity INTEGER)",
    ];
    for stmt in ddl {
        sqlx::query(stmt).execute(pool).await?;
    }

    let customers = [
        ("Aria Chen", "Shanghai"),
        ("Bruno Sato", "Osaka"),
        ("Carla Dubois", "Paris"),
        ("Dmitri Ivanov", "Berlin"),
        ("Elena Rossi", "Milan"),
    ];
    for (i, (name, city)) in customers.iter().enumerate() {
        sqlx::query("INSERT INTO demo_customers (id, name, city, created_at) VALUES (?, ?, ?, ?)")
            .bind((i + 1) as i64)
            .bind(name)
            .bind(city)
            .bind("2026-05-01")
            .execute(pool)
            .await?;
    }

    let products = [
        ("Nimbus Keyboard", "Peripherals", 89.0),
        ("Halo Monitor 27\"", "Displays", 329.0),
        ("Pulse Mouse", "Peripherals", 45.0),
        ("Aurora Dock", "Accessories", 129.0),
    ];
    for (i, (name, cat, price)) in products.iter().enumerate() {
        sqlx::query("INSERT INTO demo_products (id, name, category, price) VALUES (?, ?, ?, ?)")
            .bind((i + 1) as i64)
            .bind(name)
            .bind(cat)
            .bind(price)
            .execute(pool)
            .await?;
    }

    // 30 days of sales, gently wavy so the chart view has something to show.
    for day in 1..=30i64 {
        let amount = 6000.0 + ((day as f64 * 0.7).sin() * 250.0) + (day as f64 * 4.0);
        let quantity = 700 + ((day as f64 * 0.9).cos() * 40.0) as i64 + day;
        let date = format!("2026-06-{day:02}");
        sqlx::query(
            "INSERT INTO demo_sales (sale_date, product_id, amount, quantity) VALUES (?, ?, ?, ?)",
        )
        .bind(&date)
        .bind((day % 4) + 1)
        .bind((amount * 100.0).round() / 100.0)
        .bind(quantity)
        .execute(pool)
        .await?;
    }

    Ok(())
}
