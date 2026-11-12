//! Built-in AI engine: manages a local `llama-server` (llama.cpp) child process
//! that speaks the OpenAI-compatible API on 127.0.0.1. Self-contained — the
//! server binary + dylibs ship in the app's resources (see scripts/bundle-llama.sh);
//! the model is downloaded on first use. The repository path and SHA-256 are
//! pinned in `download`; the download is checked before it is treated as done.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::Serialize;
use tauri::Manager;

use crate::paths::home_dir;

mod download;

use download::{
    builtin_model_url, download_builtin_model, model_destination, validate_model_url,
    BUILTIN_MODEL_FILENAME, BUILTIN_MODEL_SIZE,
};

/// Fixed loopback port for the built-in engine. The model proxy only allows this port.
pub const BUILTIN_PORT: u16 = 8899;

#[derive(Default)]
pub struct AiEngine {
    server: Mutex<Option<Child>>,
    download: Mutex<Option<Download>>,
}

struct Download {
    worker: Option<JoinHandle<()>>,
    dest: PathBuf,
    total: u64,
    error: Arc<Mutex<Option<String>>>,
}

impl Download {
    fn still_running(&self) -> bool {
        self.worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
    }

    /// Join only after the worker has finished so the UI thread never blocks on it.
    fn finish(&mut self) -> Option<String> {
        if self.still_running() {
            return None;
        }
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                let mut error = self.error.lock().unwrap();
                if error.is_none() {
                    *error = Some("download failed".to_string());
                }
            }
        }
        self.error.lock().unwrap().clone()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    running: bool,
    port: u16,
    base_url: String,
    binary: Option<String>,
    model: Option<String>,
    model_size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloading: bool,
    bytes: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

/// Where the built-in model(s) live.
fn models_dir() -> PathBuf {
    home_dir().join(".db-sonde").join("models")
}

/// Windows 上可执行文件带 .exe —— 拼路径的地方都得跟着变,否则在 Windows
/// 上永远找不到已经装好的 llama-server(而且是静默找不到,只报"未安装")。
#[cfg(windows)]
const LLAMA_EXE: &str = "llama-server.exe";
#[cfg(not(windows))]
const LLAMA_EXE: &str = "llama-server";

/// Resolve `llama-server`: the copy bundled in app resources, an env override,
/// `~/.db-sonde/bin`, then the platform's usual install locations.
fn resolve_binary(resource: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = resource {
        let bundled = dir.join("binaries/llama").join(LLAMA_EXE);
        if bundled.exists() {
            return Some(bundled);
        }
    }
    if let Some(p) = std::env::var_os("SONDE_LLAMA_SERVER") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let mut candidates = vec![home_dir().join(".db-sonde").join("bin").join(LLAMA_EXE)];
    #[cfg(target_os = "macos")]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/llama-server"),
        PathBuf::from("/usr/local/bin/llama-server"),
    ]);
    #[cfg(target_os = "linux")]
    candidates.extend([
        PathBuf::from("/usr/local/bin/llama-server"),
        PathBuf::from("/usr/bin/llama-server"),
    ]);
    #[cfg(windows)]
    if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(dir).join("llama.cpp").join(LLAMA_EXE));
    }
    candidates.into_iter().find(|c| c.exists())
}

/// Pick a chat/coder GGUF from the models dir, skipping embedding models.
fn resolve_model() -> Option<PathBuf> {
    let mut best: Option<PathBuf> = None;
    for entry in fs::read_dir(models_dir()).ok()?.flatten() {
        let path = entry.path();
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_lowercase(),
            None => continue,
        };
        if !name.ends_with(".gguf")
            || name.contains("bge")
            || name.contains("embed")
            || name.contains("rerank")
        {
            continue;
        }
        if name.contains("qwen") && name.contains("coder") {
            return Some(path);
        }
        best.get_or_insert(path);
    }
    best
}

fn size_of(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| m.len())
}

fn is_running(child: &mut Option<Child>) -> bool {
    matches!(child.as_mut().map(|c| c.try_wait()), Some(Ok(None)))
}

fn status(child: &mut Option<Child>, resource: Option<&Path>) -> EngineStatus {
    let binary = resolve_binary(resource);
    let model = resolve_model();
    EngineStatus {
        running: is_running(child),
        port: BUILTIN_PORT,
        base_url: format!("http://127.0.0.1:{BUILTIN_PORT}/v1"),
        binary: binary.map(|p| p.to_string_lossy().into_owned()),
        model_size: model.as_deref().and_then(size_of),
        model: model.map(|p| p.to_string_lossy().into_owned()),
    }
}

fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

#[tauri::command]
pub fn ai_engine_status(app: tauri::AppHandle, engine: tauri::State<'_, AiEngine>) -> EngineStatus {
    let mut guard = engine.server.lock().unwrap();
    status(&mut guard, resource_dir(&app).as_deref())
}

/// Start the engine (idempotent). `model_path` overrides auto-detection.
#[tauri::command]
pub fn ai_engine_start(
    app: tauri::AppHandle,
    engine: tauri::State<'_, AiEngine>,
    model_path: Option<String>,
) -> Result<EngineStatus, String> {
    let resource = resource_dir(&app);
    let mut guard = engine.server.lock().unwrap();
    if is_running(&mut guard) {
        return Ok(status(&mut guard, resource.as_deref()));
    }
    let binary = resolve_binary(resource.as_deref())
        .ok_or_else(|| "llama-server not found (bundle it or install llama.cpp)".to_string())?;
    let model = model_path
        .map(PathBuf::from)
        .or_else(resolve_model)
        .ok_or_else(|| format!("no .gguf model found in {}", models_dir().display()))?;
    if !model.exists() {
        return Err(format!("model not found: {}", model.display()));
    }

    let child = Command::new(&binary)
        .arg("-m")
        .arg(&model)
        .args(["--host", "127.0.0.1", "--port", &BUILTIN_PORT.to_string()])
        .args(["-c", "8192", "-ngl", "999", "--jinja"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start llama-server: {e}"))?;

    *guard = Some(child);
    Ok(status(&mut guard, resource.as_deref()))
}

// 要等引擎进程退出,放线程池里,别卡界面
#[tauri::command(async)]
pub fn ai_engine_stop(app: tauri::AppHandle, engine: tauri::State<'_, AiEngine>) -> EngineStatus {
    let mut guard = engine.server.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    status(&mut guard, resource_dir(&app).as_deref())
}

/// Download the pinned GGUF (resumable). Returns once the download has started;
/// poll `ai_model_progress`. The filename and URL still go through the ModelScope
/// allowlist (single `.gguf`, no symlink, https only, redirect hops checked).
#[tauri::command]
pub fn ai_model_download(engine: tauri::State<'_, AiEngine>) -> Result<(), String> {
    let dest = model_destination(&models_dir(), BUILTIN_MODEL_FILENAME)?;
    let url = validate_model_url(&builtin_model_url())?.to_string();
    let mut guard = engine.download.lock().unwrap();
    if let Some(current) = guard.as_mut() {
        if current.still_running() {
            return Ok(());
        }
        let _ = current.finish();
    }
    let error = Arc::new(Mutex::new(None));
    let error_slot = Arc::clone(&error);
    let path = dest.clone();
    let worker = std::thread::spawn(move || {
        if let Err(msg) = download_builtin_model(&url, &path) {
            *error_slot.lock().unwrap() = Some(msg);
        }
    });
    *guard = Some(Download {
        worker: Some(worker),
        dest,
        total: BUILTIN_MODEL_SIZE,
        error,
    });
    Ok(())
}

#[tauri::command]
pub fn ai_model_progress(engine: tauri::State<'_, AiEngine>) -> DownloadProgress {
    let mut guard = engine.download.lock().unwrap();
    let Some(dl) = guard.as_mut() else {
        return DownloadProgress {
            downloading: false,
            bytes: 0,
            total: 0,
            done: false,
            error: None,
        };
    };
    if dl.still_running() {
        let bytes = size_of(&dl.dest).unwrap_or(0);
        return DownloadProgress {
            downloading: true,
            bytes,
            total: dl.total,
            done: false,
            error: None,
        };
    }
    let error = dl.finish();
    // SHA mismatch deletes the file, so measure again after the worker finishes.
    let bytes = size_of(&dl.dest).unwrap_or(0);
    DownloadProgress {
        downloading: false,
        bytes,
        total: dl.total,
        done: error.is_none(),
        error,
    }
}
