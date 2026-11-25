//! Versioned local persistence for generic dashboard documents.
//!
//! The backend deliberately treats documents as JSON. The TypeScript domain
//! layer owns the evolving schema, while this module provides one stable,
//! atomic application-storage boundary with no dependency on any BI service.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> AppResult<MutexGuard<'static, ()>> {
    STORE_LOCK
        .lock()
        .map_err(|_| AppError::msg("Dashboard storage lock is unavailable."))
}

fn dashboards_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::msg(format!("cannot resolve config dir: {error}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("dashboards.json"))
}

fn versions_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(dashboards_path(app)?.with_file_name("dashboard-versions.json"))
}

fn load_path(path: &Path) -> AppResult<Vec<Value>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(path)?;
    let documents = serde_json::from_slice::<Vec<Value>>(&bytes)?;
    Ok(documents)
}

fn save_path(path: &Path, documents: &[Value]) -> AppResult<()> {
    crate::persistence::write_json_atomic(path, documents)
}

fn load_versions_path(path: &Path) -> AppResult<HashMap<String, Vec<Value>>> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn save_versions_path(path: &Path, versions: &HashMap<String, Vec<Value>>) -> AppResult<()> {
    crate::persistence::write_json_atomic(path, versions)
}

fn document_id(document: &Value) -> AppResult<&str> {
    document
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 100)
        .ok_or_else(|| AppError::msg("Dashboard document requires a valid id."))
}

fn validate_document(document: &Value) -> AppResult<String> {
    let id = document_id(document)?.to_string();
    if serde_json::to_vec(document)?.len() > 10 * 1024 * 1024 {
        return Err(AppError::msg("Dashboard document exceeds the 10 MB limit."));
    }
    Ok(id)
}

fn upsert_document(path: &Path, document: &Value, id: &str) -> AppResult<()> {
    let mut documents = load_path(path)?;
    if let Some(existing) = documents
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
    {
        *existing = document.clone();
    } else {
        documents.push(document.clone());
    }
    save_path(path, &documents)
}

/// 看板存盘的文件路径。界面上要能回答「我保存的东西在哪」—— 存在应用配置目录里的
/// 一个 json,不告诉人的话就只能靠猜。
#[tauri::command]
pub async fn dashboard_storage_path(app: AppHandle) -> AppResult<String> {
    Ok(dashboards_path(&app)?.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn list_dashboards(app: AppHandle) -> AppResult<Vec<Value>> {
    let _guard = lock_store()?;
    load_path(&dashboards_path(&app)?)
}

#[tauri::command(async)]
pub fn save_dashboard(app: AppHandle, document: Value) -> AppResult<Value> {
    let _guard = lock_store()?;
    let id = validate_document(&document)?;
    let path = dashboards_path(&app)?;
    upsert_document(&path, &document, &id)?;
    Ok(document)
}

#[tauri::command(async)]
pub fn publish_dashboard(app: AppHandle, document: Value) -> AppResult<Value> {
    let _guard = lock_store()?;
    let id = validate_document(&document)?;
    let revision = document
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::msg("Published dashboards require a numeric revision."))?;
    let version_path = versions_path(&app)?;
    let mut versions = load_versions_path(&version_path)?;
    let history = versions.entry(id.clone()).or_default();
    history.retain(|item| item.get("revision").and_then(Value::as_u64) != Some(revision));
    history.push(document.clone());
    history.sort_by_key(|item| {
        item.get("revision")
            .and_then(Value::as_u64)
            .unwrap_or_default()
    });
    if history.len() > 50 {
        history.drain(..history.len() - 50);
    }
    save_versions_path(&version_path, &versions)?;
    upsert_document(&dashboards_path(&app)?, &document, &id)?;
    Ok(document)
}

#[tauri::command(async)]
pub fn list_dashboard_versions(app: AppHandle, id: String) -> AppResult<Vec<Value>> {
    let _guard = lock_store()?;
    let mut history = load_versions_path(&versions_path(&app)?)?
        .remove(&id)
        .unwrap_or_default();
    history.sort_by_key(|item| {
        std::cmp::Reverse(
            item.get("revision")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        )
    });
    Ok(history)
}

#[tauri::command(async)]
pub fn delete_dashboard(app: AppHandle, id: String) -> AppResult<()> {
    let _guard = lock_store()?;
    let path = dashboards_path(&app)?;
    let mut documents = load_path(&path)?;
    documents.retain(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()));
    save_path(&path, &documents)?;
    let version_path = versions_path(&app)?;
    let mut versions = load_versions_path(&version_path)?;
    versions.remove(&id);
    save_versions_path(&version_path, &versions)
}

#[cfg(test)]
mod tests {
    use super::{document_id, load_path, load_versions_path, save_path, save_versions_path};
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn validates_document_identity() {
        assert_eq!(document_id(&json!({"id": "board-1"})).unwrap(), "board-1");
        assert!(document_id(&json!({"id": ""})).is_err());
        assert!(document_id(&json!({"title": "missing"})).is_err());
    }

    #[test]
    fn round_trips_documents() {
        let path = std::env::temp_dir().join(format!(
            "sonde-dashboard-store-{}.json",
            std::process::id()
        ));
        let documents = vec![json!({"id": "board-1", "schemaVersion": 1})];
        save_path(&path, &documents).unwrap();
        assert_eq!(load_path(&path).unwrap(), documents);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn round_trips_version_history() {
        let path = std::env::temp_dir().join(format!(
            "sonde-dashboard-versions-{}.json",
            std::process::id()
        ));
        let versions = HashMap::from([(
            "board-1".to_string(),
            vec![json!({"id": "board-1", "revision": 2})],
        )]);
        save_versions_path(&path, &versions).unwrap();
        assert_eq!(load_versions_path(&path).unwrap(), versions);
        let _ = std::fs::remove_file(path);
    }
}
