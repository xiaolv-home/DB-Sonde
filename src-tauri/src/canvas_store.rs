//! Local atomic persistence for Lineage Canvases and their version history.
//!
//! Moving canvases out of `localStorage` avoids the browser's 5 MB storage ceiling
//! (especially with up to 30 snapshots per canvas) and aligns persistence with
//! `dashboard_store` and `dataset_store`.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};

static STORE_LOCK: Mutex<()> = Mutex::new(());

fn lock_store() -> MutexGuard<'static, ()> {
    STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn config_file(app: &AppHandle, name: &str) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::msg(format!("cannot resolve config dir: {error}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(name))
}

#[tauri::command(async)]
pub fn load_canvases(app: AppHandle) -> AppResult<Option<Value>> {
    let _guard = lock_store();
    let path = config_file(&app, "lineage-canvases.json")?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

#[tauri::command(async)]
pub fn save_canvases(app: AppHandle, documents: Value) -> AppResult<()> {
    let _guard = lock_store();
    let encoded = serde_json::to_vec(&documents)?;
    if encoded.len() > 25 * 1024 * 1024 {
        return Err(AppError::msg("链路画布数据超过 25 MB 安全上限"));
    }
    let path = config_file(&app, "lineage-canvases.json")?;
    crate::persistence::write_json_atomic(&path, &documents)?;
    let _ = app.emit("canvas://updated", ());
    Ok(())
}

#[tauri::command(async)]
pub fn load_canvas_history(app: AppHandle) -> AppResult<Option<Value>> {
    let _guard = lock_store();
    let path = config_file(&app, "lineage-canvas-history.json")?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}

#[tauri::command(async)]
pub fn save_canvas_history(app: AppHandle, history: Value) -> AppResult<()> {
    let _guard = lock_store();
    let encoded = serde_json::to_vec(&history)?;
    if encoded.len() > 50 * 1024 * 1024 {
        return Err(AppError::msg("画布历史记录超过 50 MB 安全上限"));
    }
    let path = config_file(&app, "lineage-canvas-history.json")?;
    crate::persistence::write_json_atomic(&path, &history)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn atomic_canvas_roundtrip_writes_clean_json() {
        let path = std::env::temp_dir().join(format!(
            "sonde-canvas-store-{}.json",
            uuid::Uuid::new_v4()
        ));
        let sample = json!([{"id": "c1", "name": "ETL", "nodes": [], "edges": [], "updatedAt": 1}]);
        crate::persistence::write_json_atomic(&path, &sample).unwrap();
        let loaded: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded, sample);
        let _ = std::fs::remove_file(&path);
    }
}
