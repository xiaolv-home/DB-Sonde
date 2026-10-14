//! Persistence for saved connections.
//!
//! Connection profiles (host, port, user, database …) live in a JSON file in
//! the app config directory. Passwords are encrypted separately by credentials.rs.
//! This module never writes passwords to connection profiles.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::models::ConnectionConfig;

fn config_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("cannot resolve config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("connections.json"))
}

pub fn load_connections(app: &AppHandle) -> AppResult<Vec<ConnectionConfig>> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let bytes = std::fs::read(&path)?;
    let list: Vec<ConnectionConfig> = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::msg(format!("连接配置格式错误，已保留原文件：{e}")))?;
    Ok(list)
}

pub fn save_connections(app: &AppHandle, list: &[ConnectionConfig]) -> AppResult<()> {
    let path = config_path(app)?;
    crate::persistence::write_json_atomic(&path, list)
}

/// Optional user-supplied catalog, separate from the application binary.
// 读文件,放线程池里
#[tauri::command(async)]
pub fn load_semantic_catalog(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("semantic-catalog.json");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("指标目录格式错误: {e}"))
}
