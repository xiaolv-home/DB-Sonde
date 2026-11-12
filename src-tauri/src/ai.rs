//! Built-in AI engine: manages a local `llama-server` (llama.cpp) child process
//! that speaks the OpenAI-compatible API on 127.0.0.1. Self-contained — the
//! server binary + dylibs ship in the app's resources (see scripts/bundle-llama.sh);
//! the model is downloaded on first use. No extra Cargo deps (std + curl only).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

/// Fixed loopback port for the built-in engine.
const PORT: u16 = 8899;

#[derive(Default)]
pub struct AiEngine {
    server: Mutex<Option<Child>>,
    download: Mutex<Option<Download>>,
}

struct Download {
    child: Child,
    dest: PathBuf,
    total: u64,
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

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// Where the built-in model(s) live.
fn models_dir() -> PathBuf {
    home().join(".db-sonde").join("models")
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
    let mut candidates = vec![home().join(".db-sonde").join("bin").join(LLAMA_EXE)];
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
        if !name.ends_with(".gguf") || name.contains("bge") || name.contains("embed") || name.contains("rerank") {
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
        port: PORT,
        base_url: format!("http://127.0.0.1:{PORT}/v1"),
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
        .args(["--host", "127.0.0.1", "--port", &PORT.to_string()])
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

/// Download a GGUF into the models dir via `curl` (resumable). Returns once the
/// download has started; poll `ai_model_progress` for status.
#[tauri::command]
pub fn ai_model_download(
    engine: tauri::State<'_, AiEngine>,
    url: String,
    filename: String,
    total: u64,
) -> Result<(), String> {
    let dir = models_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&filename);
    let mut guard = engine.download.lock().unwrap();
    if let Some(dl) = guard.as_mut() {
        if matches!(dl.child.try_wait(), Ok(None)) {
            return Ok(()); // already downloading
        }
    }
    let child = Command::new("curl")
        .args(["-L", "--fail", "-C", "-", "-o"])
        .arg(&dest)
        .arg(&url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start download: {e}"))?;
    *guard = Some(Download { child, dest, total });
    Ok(())
}

#[tauri::command]
pub fn ai_model_progress(engine: tauri::State<'_, AiEngine>) -> DownloadProgress {
    let mut guard = engine.download.lock().unwrap();
    let Some(dl) = guard.as_mut() else {
        return DownloadProgress { downloading: false, bytes: 0, total: 0, done: false, error: None };
    };
    let bytes = size_of(&dl.dest).unwrap_or(0);
    match dl.child.try_wait() {
        Ok(Some(st)) => DownloadProgress {
            downloading: false,
            bytes,
            total: dl.total,
            done: st.success(),
            error: (!st.success()).then(|| "download failed".to_string()),
        },
        Ok(None) => DownloadProgress { downloading: true, bytes, total: dl.total, done: false, error: None },
        Err(e) => DownloadProgress { downloading: false, bytes, total: dl.total, done: false, error: Some(e.to_string()) },
    }
}
