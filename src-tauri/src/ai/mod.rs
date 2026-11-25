//! Built-in AI engine: manages a local `llama-server` (llama.cpp) child process
//! that speaks the OpenAI-compatible API on 127.0.0.1. Self-contained — the
//! server binary + dylibs ship in the app's resources (see scripts/bundle-llama.sh);
//! the model is downloaded on first use. The repository path and SHA-256 are
//! pinned in `download`; the download is checked before it is treated as done.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

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

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
pub struct AiEngine {
    server: Mutex<Option<Child>>,
    download: Mutex<Option<Download>>,
}

impl AiEngine {
    /// Terminate and reap the managed `llama-server` child process on app shutdown.
    pub fn shutdown(&self) {
        let mut guard = lock_unpoisoned(&self.server);
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for AiEngine {
    fn drop(&mut self) {
        self.shutdown();
    }
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
                let mut error = lock_unpoisoned(&self.error);
                if error.is_none() {
                    *error = Some("download failed".to_string());
                }
            }
        }
        lock_unpoisoned(&self.error).clone()
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

/// Validate a caller-supplied model path: must reside inside `models_dir`,
/// must not be a symlink or directory, and must have a `.gguf` extension.
fn validate_supplied_model_path(dir: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let name = candidate
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid model path".to_string())?;
    if !name.to_ascii_lowercase().ends_with(".gguf") || name.len() == ".gguf".len() {
        return Err("model file must end with .gguf".into());
    }
    let meta = fs::symlink_metadata(candidate)
        .map_err(|_| format!("model not found: {}", candidate.display()))?;
    if meta.file_type().is_symlink() {
        return Err("model path must not be a symlink".into());
    }
    if !meta.is_file() {
        return Err("model path must be a regular .gguf file".into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("failed to resolve models directory: {e}"))?;
    let root = fs::canonicalize(dir)
        .map_err(|e| format!("failed to resolve models directory: {e}"))?;
    let resolved = fs::canonicalize(candidate)
        .map_err(|e| format!("failed to resolve model path: {e}"))?;
    if resolved.parent() != Some(root.as_path()) || !resolved.starts_with(&root) {
        return Err("model path must stay inside ~/.db-sonde/models".into());
    }
    Ok(resolved)
}

#[tauri::command]
pub fn ai_engine_status(app: tauri::AppHandle, engine: tauri::State<'_, AiEngine>) -> EngineStatus {
    let mut guard = lock_unpoisoned(&engine.server);
    status(&mut guard, resource_dir(&app).as_deref())
}

/// Start the engine (idempotent). `model_path` overrides auto-detection within `models_dir`.
#[tauri::command(async)]
pub fn ai_engine_start(
    app: tauri::AppHandle,
    engine: tauri::State<'_, AiEngine>,
    model_path: Option<String>,
) -> Result<EngineStatus, String> {
    let resource = resource_dir(&app);
    let mut guard = lock_unpoisoned(&engine.server);
    if is_running(&mut guard) {
        return Ok(status(&mut guard, resource.as_deref()));
    }
    let binary = resolve_binary(resource.as_deref())
        .ok_or_else(|| "llama-server not found (bundle it or install llama.cpp)".to_string())?;
    let model = match model_path.filter(|p| !p.trim().is_empty()) {
        Some(raw) => validate_supplied_model_path(&models_dir(), Path::new(&raw))?,
        None => resolve_model()
            .ok_or_else(|| format!("no .gguf model found in {}", models_dir().display()))?,
    };
    if !model.exists() {
        return Err(format!("model not found: {}", model.display()));
    }

    let mut child = Command::new(&binary)
        .arg("-m")
        .arg(&model)
        .args(["--host", "127.0.0.1", "--port", &BUILTIN_PORT.to_string()])
        .args(["-c", "8192", "-ngl", "999", "--jinja"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start llama-server: {e}"))?;

    // Catch immediate startup failures (e.g. port 8899 already bound or corrupted GGUF)
    // instead of returning running=false with zero diagnostics.
    std::thread::sleep(Duration::from_millis(120));
    if let Ok(Some(exit_status)) = child.try_wait() {
        let mut stderr_tail = String::new();
        if let Some(err_pipe) = child.stderr.take() {
            use std::io::Read;
            let _ = err_pipe.take(2048).read_to_string(&mut stderr_tail);
        }
        let detail = stderr_tail.trim();
        return Err(if detail.is_empty() {
            format!("llama-server 启动后立即退出({exit_status}),请检查端口 {BUILTIN_PORT} 是否已被占用")
        } else {
            format!("llama-server 启动失败({exit_status}): {detail}")
        });
    }
    // Drop stderr pipe handle into a background drain thread so the child never blocks on pipe buffer.
    if let Some(err_pipe) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::BufReader::new(err_pipe), &mut std::io::sink());
        });
    }

    *guard = Some(child);
    Ok(status(&mut guard, resource.as_deref()))
}

// 要等引擎进程退出,放线程池里,别卡界面
#[tauri::command(async)]
pub fn ai_engine_stop(app: tauri::AppHandle, engine: tauri::State<'_, AiEngine>) -> EngineStatus {
    let mut guard = lock_unpoisoned(&engine.server);
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    status(&mut guard, resource_dir(&app).as_deref())
}

/// Download the pinned GGUF (resumable). Returns once the download has started;
/// poll `ai_model_progress`. The filename and URL still go through the ModelScope
/// allowlist (single `.gguf`, no symlink, https only, redirect hops checked).
#[tauri::command(async)]
pub fn ai_model_download(engine: tauri::State<'_, AiEngine>) -> Result<(), String> {
    let dest = model_destination(&models_dir(), BUILTIN_MODEL_FILENAME)?;
    let url = validate_model_url(&builtin_model_url())?.to_string();
    let mut guard = lock_unpoisoned(&engine.download);
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
            *lock_unpoisoned(&error_slot) = Some(msg);
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
    let mut guard = lock_unpoisoned(&engine.download);
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
        let bytes = size_of(&dl.dest.with_extension("gguf.part")).unwrap_or(0);
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

#[cfg(test)]
mod engine_path_tests {
    use super::validate_supplied_model_path;
    use std::fs;

    #[test]
    fn supplied_model_path_must_stay_in_models_dir_and_end_with_gguf() {
        let root = std::env::temp_dir().join(format!("sonde-ai-path-{}", uuid::Uuid::new_v4()));
        let models = root.join("models");
        fs::create_dir_all(&models).unwrap();
        let good = models.join("coder.gguf");
        fs::write(&good, b"gguf").unwrap();
        assert!(validate_supplied_model_path(&models, &good).is_ok());

        let outside = root.join("outside.gguf");
        fs::write(&outside, b"gguf").unwrap();
        assert!(validate_supplied_model_path(&models, &outside).is_err());

        let bad_ext = models.join("coder.bin");
        fs::write(&bad_ext, b"bin").unwrap();
        assert!(validate_supplied_model_path(&models, &bad_ext).is_err());

        #[cfg(unix)]
        {
            let link = models.join("link.gguf");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(validate_supplied_model_path(&models, &link).is_err());
        }
        let _ = fs::remove_dir_all(&root);
    }
}
