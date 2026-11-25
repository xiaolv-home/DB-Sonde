//! Local persistence for datasets — the single source a dashboard widget draws from.
//!
//! Datasets are global on purpose: one definition of a table join or a query,
//! reused across dashboards, edited in one place. That is why they live here
//! rather than inside a dashboard document.
//!
//! As with dashboards, the backend keeps them as opaque JSON: the TypeScript
//! domain layer owns the schema, this module owns one atomic storage boundary.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> AppResult<MutexGuard<'static, ()>> {
    STORE_LOCK
        .lock()
        .map_err(|_| AppError::msg("Dataset storage lock is unavailable."))
}

fn datasets_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::msg(format!("cannot resolve config dir: {error}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("datasets.json"))
}

fn load_path(path: &Path) -> AppResult<Vec<Value>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_slice::<Vec<Value>>(&std::fs::read(path)?)?)
}

fn validate(dataset: &Value) -> AppResult<String> {
    let id = dataset
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 100)
        .ok_or_else(|| AppError::msg("Dataset requires a valid id."))?
        .to_string();
    if serde_json::to_vec(dataset)?.len() > 2 * 1024 * 1024 {
        return Err(AppError::msg("Dataset exceeds the 2 MB limit."));
    }
    Ok(id)
}

#[tauri::command(async)]
pub fn list_datasets(app: AppHandle) -> AppResult<Vec<Value>> {
    let _guard = lock_store()?;
    load_path(&datasets_path(&app)?)
}

#[tauri::command(async)]
pub fn save_dataset(app: AppHandle, dataset: Value) -> AppResult<Value> {
    let _guard = lock_store()?;
    let id = validate(&dataset)?;
    let path = datasets_path(&app)?;
    let mut datasets = load_path(&path)?;
    match datasets
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        Some(existing) => *existing = dataset.clone(),
        None => datasets.push(dataset.clone()),
    }
    crate::persistence::write_json_atomic(&path, &datasets)?;
    Ok(dataset)
}

#[tauri::command(async)]
pub fn delete_dataset(app: AppHandle, id: String) -> AppResult<()> {
    let _guard = lock_store()?;
    let path = datasets_path(&app)?;
    let mut datasets = load_path(&path)?;
    datasets.retain(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()));
    crate::persistence::write_json_atomic(&path, &datasets)
}
