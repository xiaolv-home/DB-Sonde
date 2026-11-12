//! Built-in AI engine: manages a local `llama-server` (llama.cpp) child process
//! that speaks the OpenAI-compatible API on 127.0.0.1. Self-contained — the
//! server binary + dylibs ship in the app's resources (see scripts/bundle-llama.sh);
//! the model is downloaded on first use. The repository path and SHA-256 are
//! pinned below; the download is checked before it is treated as done.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;

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

/// ModelScope is the only host the built-in download uses. Its `/resolve/` URL
/// returns 302 to a `cdn-lfs-*.modelscope.cn` object host, so subdomains of
/// this registrable domain are the same source, not an open redirect.
const MODEL_HOST: &str = "modelscope.cn";
const MAX_MODEL_REDIRECTS: usize = 10;

/// 内置模型。仓库路径和 SHA-256 写死在这里，不从界面或下载响应里拿。
/// 文件是 Qwen 官方 GGUF（Q4_K_M，4,683,073,344 字节），从 ModelScope 拉，
/// 哈希与 Hugging Face 上同一文件的 SHA-256 一致。
const BUILTIN_MODEL_REPO: &str = "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF";
const BUILTIN_MODEL_FILE: &str = "qwen2.5-coder-7b-instruct-q4_k_m.gguf";
const BUILTIN_MODEL_FILENAME: &str = "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf";
const BUILTIN_MODEL_SHA256: &str =
    "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c";
const BUILTIN_MODEL_SIZE: u64 = 4_683_073_344;

/// 空闲读超时。blocking 客户端的 `timeout` 包在每一次 `Read::read` 外面，
/// 这次读完、下次再计。不要写成 `.timeout(24h)`，也不要注释成
/// 「24 小时只是为了停住卡住的连接」——24 小时没有数据才失败，等于发现不了卡死。
/// 异步客户端的 `timeout` 是另一回事：那是整次请求的总期限。
const MODEL_IDLE_READ_TIMEOUT: Duration = Duration::from_secs(60);

fn builtin_model_url() -> String {
    format!("https://modelscope.cn/models/{BUILTIN_MODEL_REPO}/resolve/master/{BUILTIN_MODEL_FILE}")
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct DownloadReject(String);

fn model_host_allowed(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == MODEL_HOST {
        return true;
    }
    let Some(prefix) = host.strip_suffix(MODEL_HOST) else {
        return false;
    };
    let Some(labels) = prefix.strip_suffix('.') else {
        return false;
    };
    !labels.is_empty()
        && !labels.starts_with('.')
        && !labels.ends_with('.')
        && !labels.contains("..")
}

fn validate_model_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid model URL".to_string())?;
    if url.scheme() != "https" {
        return Err("model URL must use https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("model URL must not include credentials".into());
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "invalid model URL".to_string())?;
    if !model_host_allowed(host) {
        return Err(format!("model download host is not allowed: {host}"));
    }
    Ok(url)
}

fn validate_model_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("model filename is empty".into());
    }
    if filename.contains("..") {
        return Err("model filename must not contain '..'".into());
    }
    if filename.starts_with('/') || filename.starts_with('\\') || Path::new(filename).is_absolute()
    {
        return Err("model filename must not be an absolute path".into());
    }
    if filename.contains('/') || filename.contains('\\') {
        return Err("model filename must not contain a path separator".into());
    }
    if filename.contains(':') {
        return Err("model filename must not include a drive prefix".into());
    }
    if !filename
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err("model filename contains invalid characters".into());
    }
    let lower = filename.to_ascii_lowercase();
    if !lower.ends_with(".gguf") || lower.len() == ".gguf".len() {
        return Err("model filename must end with .gguf".into());
    }
    if windows_reserved(filename) {
        return Err("model filename is a reserved Windows device name".into());
    }
    Ok(())
}

fn windows_reserved(filename: &str) -> bool {
    let base = filename.split('.').next().unwrap_or(filename);
    let upper = base.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit())
}

/// Single path component inside `dir`. Rejects symlinks so a link cannot retarget the write.
fn model_destination(dir: &Path, filename: &str) -> Result<PathBuf, String> {
    validate_model_filename(filename)?;
    fs::create_dir_all(dir).map_err(|e| format!("failed to create models directory: {e}"))?;
    let root =
        fs::canonicalize(dir).map_err(|e| format!("failed to resolve models directory: {e}"))?;
    let dest = root.join(filename);
    if dest.file_name().and_then(|name| name.to_str()) != Some(filename)
        || dest.parent() != Some(root.as_path())
    {
        return Err("model path escapes the models directory".into());
    }
    match fs::symlink_metadata(&dest) {
        Ok(meta) if meta.file_type().is_symlink() => Err("model path must not be a symlink".into()),
        Ok(meta) if meta.is_dir() => {
            Err("model path must be a file inside the models directory".into())
        }
        Ok(_) => {
            let resolved = fs::canonicalize(&dest)
                .map_err(|e| format!("failed to resolve model path: {e}"))?;
            if resolved.parent() != Some(root.as_path()) || !resolved.starts_with(&root) {
                Err("model path escapes the models directory".into())
            } else {
                Ok(dest)
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(dest),
        Err(e) => Err(format!("failed to inspect model path: {e}")),
    }
}

fn model_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_MODEL_REDIRECTS {
            return attempt.error(DownloadReject("too many model download redirects".into()));
        }
        match validate_model_url(attempt.url().as_str()) {
            Ok(_) => attempt.follow(),
            Err(reason) => attempt.error(DownloadReject(reason)),
        }
    })
}

fn model_http_client(idle: Duration, direct: bool) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(idle)
        .redirect(model_redirect_policy());
    if direct {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| format!("failed to start download: {e}"))
}

fn open_model_file(dest: &Path, append: bool) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(dest)
        .map_err(|e| format!("failed to open model file: {e}"))
}

/// reqwest's Display stops at "error following redirect" and hides the policy error.
fn error_detail(err: &dyn std::error::Error) -> String {
    let mut detail = err.to_string();
    let mut next = std::error::Error::source(err);
    while let Some(inner) = next {
        detail.push_str(": ");
        detail.push_str(&inner.to_string());
        next = std::error::Error::source(inner);
    }
    detail
}

fn download_builtin_model(url: &str, dest: &Path) -> Result<(), String> {
    let client = model_http_client(MODEL_IDLE_READ_TIMEOUT, false)?;
    download_model_file(
        &client,
        url,
        dest,
        BUILTIN_MODEL_SHA256,
        MODEL_IDLE_READ_TIMEOUT,
    )
}

fn download_model_file(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    expect_sha: &str,
    idle: Duration,
) -> Result<(), String> {
    fetch_model(client, url, dest, idle)?;
    verify_sha256_file(dest, expect_sha)
}

fn fetch_model(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    idle: Duration,
) -> Result<(), String> {
    let existing = fs::metadata(dest)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .unwrap_or(0);
    let mut request = client.get(url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let mut response = request
        .send()
        .map_err(|e| format!("download failed: {}", error_detail(&e)))?;
    let status = response.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let header = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        return match classify_416(existing, header.as_deref()) {
            RangeOutcome::Complete => Ok(()),
            RangeOutcome::Mismatch { local, total } => {
                let _ = fs::remove_file(dest);
                Err(match total {
                    Some(total) => format!(
                        "断点续传被拒绝(HTTP 416):本地 {local} 字节,服务器总大小 {total} 字节,已删除未完成文件"
                    ),
                    None => format!(
                        "断点续传被拒绝(HTTP 416):本地 {local} 字节,服务器没有给出总大小,已删除未完成文件"
                    ),
                })
            }
        };
    }
    let append = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        if existing == 0 {
            return Err("download failed: unexpected partial response".into());
        }
        true
    } else if status == reqwest::StatusCode::OK {
        false
    } else {
        return Err(format!("download failed: HTTP {status}"));
    };
    copy_body(&mut response, dest, append, idle)
}

/// 416 的 `Content-Range` 形如 `bytes */1234`（或 `bytes 0-0/1234`）。
/// 本地大小和 total 相等，说明文件已经下完，接下来再做 SHA-256。
fn classify_416(local_len: u64, content_range: Option<&str>) -> RangeOutcome {
    match content_range.and_then(content_range_total) {
        Some(total) if total == local_len && local_len > 0 => RangeOutcome::Complete,
        total => RangeOutcome::Mismatch {
            local: local_len,
            total,
        },
    }
}

enum RangeOutcome {
    Complete,
    Mismatch { local: u64, total: Option<u64> },
}

fn content_range_total(header: &str) -> Option<u64> {
    let spec = header.split_whitespace().nth(1)?;
    let total = spec.rsplit_once('/')?.1;
    if total == "*" {
        return None;
    }
    total.parse().ok()
}

fn copy_body(
    response: &mut impl Read,
    dest: &Path,
    append: bool,
    idle: Duration,
) -> Result<(), String> {
    let mut file = open_model_file(dest, append)?;
    let mut buf = vec![0_u8; 256 * 1024];
    loop {
        let n = match response.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(read_error(&e, idle)),
        };
        file.write_all(&buf[..n])
            .map_err(|e| format!("download failed: {e}"))?;
    }
    file.sync_all()
        .map_err(|e| format!("download failed: {e}"))?;
    Ok(())
}

fn read_error(err: &std::io::Error, idle: Duration) -> String {
    let detail = error_detail(err);
    let lower = detail.to_ascii_lowercase();
    if err.kind() == std::io::ErrorKind::TimedOut
        || lower.contains("timed out")
        || lower.contains("timeout")
    {
        format!("下载卡住:连续 {} 秒没有收到数据", idle.as_secs().max(1))
    } else {
        format!("download failed: {detail}")
    }
}

fn verify_sha256_file(path: &Path, expect: &str) -> Result<(), String> {
    if expect.len() != 64 || !expect.bytes().all(|b| b.is_ascii_hexdigit()) {
        let _ = fs::remove_file(path);
        return Err("内置模型没有配置合法的 SHA-256,已删除下载文件".into());
    }
    let got = sha256_file(path)?;
    if !got.eq_ignore_ascii_case(expect) {
        let _ = fs::remove_file(path);
        return Err(format!(
            "模型校验和不符,已删除文件。期望 {expect},实际 {got}"
        ));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读取模型失败:{e}"))?;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut buf = vec![0_u8; 256 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取模型失败:{e}"))?;
        if n == 0 {
            break;
        }
        sha2::Digest::update(&mut hasher, &buf[..n]);
    }
    Ok(format!("{:x}", sha2::Digest::finalize(hasher)))
}

#[cfg(test)]
fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, bytes);
    format!("{:x}", sha2::Digest::finalize(hasher))
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

/// 用户主目录。不要读 `HOME`：Windows 上通常没有这个变量。
/// `dirs::home_dir()` 在 Windows 用的是用户配置里的 Profile；那个接口失败时再看 `USERPROFILE`。
fn home() -> PathBuf {
    if let Some(dir) = dirs::home_dir().filter(|dir| !dir.as_os_str().is_empty()) {
        return dir;
    }
    #[cfg(windows)]
    if let Some(dir) = std::env::var_os("USERPROFILE").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        PathBuf::new()
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/")
    }
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

#[cfg(test)]
mod model_download_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "sonde-model-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn client() -> reqwest::blocking::Client {
        model_http_client(Duration::from_secs(5), true).unwrap()
    }

    fn filename_error(name: &str) -> String {
        let dir = TempDir::new();
        model_destination(&dir.0, name).unwrap_err()
    }

    #[test]
    fn filename_rejects_traversal_absolute_paths_bad_extension_and_reserved_names() {
        assert!(filename_error("../secret.gguf").contains(".."), "traversal");
        assert!(filename_error("..").contains(".."));
        assert!(filename_error("foo/../../etc/passwd.gguf").contains(".."));
        assert!(filename_error(r"..\..\windows\system.gguf").contains(".."));
        assert!(
            filename_error("/tmp/secret.gguf").contains("absolute"),
            "unix absolute"
        );
        assert!(filename_error(r"\Windows\system.gguf").contains("absolute"));
        let windows_abs = filename_error(r"C:\Windows\system.gguf");
        assert!(
            windows_abs.contains("absolute") || windows_abs.contains("separator"),
            "{windows_abs}"
        );
        assert!(filename_error("nested/model.gguf").contains("separator"));
        assert!(
            filename_error("C:model.gguf").contains("drive"),
            "drive prefix"
        );
        assert!(filename_error("").contains("empty"));
        assert!(
            filename_error("model.bin").contains(".gguf"),
            "bad extension"
        );
        assert!(filename_error("model.gguf.txt").contains(".gguf"));
        assert!(filename_error(".gguf").contains(".gguf"));
        assert!(filename_error("CON.gguf").contains("reserved"));
        assert!(filename_error("nul.gguf").contains("reserved"));
        assert!(filename_error("COM1.gguf").contains("reserved"));
        assert!(filename_error("LPT9.gguf").contains("reserved"));
        assert!(filename_error("my model.gguf").contains("invalid"));
        assert!(filename_error("模型.gguf").contains("invalid"));
    }

    #[test]
    fn filename_stays_inside_the_models_directory() {
        let root = TempDir::new();
        let models = root.0.join("models");
        let name = "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf";
        let dest = model_destination(&models, name).unwrap();
        let canonical = fs::canonicalize(&models).unwrap();
        assert_eq!(dest.parent(), Some(canonical.as_path()));
        assert!(dest.starts_with(&canonical));
        assert_eq!(dest.file_name().and_then(|n| n.to_str()), Some(name));
        fs::write(&dest, b"partial").unwrap();
        let again = model_destination(&models, name).unwrap();
        assert_eq!(again, dest);

        let outside = root.0.join("outside.gguf");
        fs::write(&outside, b"secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, models.join("evil.gguf")).unwrap();
            let err = model_destination(&models, "evil.gguf").unwrap_err();
            assert!(err.contains("symlink"), "{err}");
            assert_eq!(fs::read(&outside).unwrap(), b"secret");
        }
    }

    #[test]
    fn url_rejects_http_scheme_and_bad_host_but_allows_modelscope() {
        assert_eq!(
            validate_model_url("http://modelscope.cn/a.gguf").unwrap_err(),
            "model URL must use https"
        );
        assert_eq!(
            validate_model_url("http://cdn-lfs-cn-1.modelscope.cn/obj").unwrap_err(),
            "model URL must use https",
        );
        assert!(validate_model_url("https://evil.example/a.gguf")
            .unwrap_err()
            .contains("not allowed"));
        assert!(
            validate_model_url("https://modelscope.cn.evil.example/a.gguf")
                .unwrap_err()
                .contains("not allowed")
        );
        assert!(validate_model_url("https://notmodelscope.cn/a.gguf")
            .unwrap_err()
            .contains("not allowed"));
        assert!(validate_model_url("https://evilmodelscope.cn/a.gguf")
            .unwrap_err()
            .contains("not allowed"));
        assert_eq!(
            validate_model_url("https://user:pass@modelscope.cn/a.gguf").unwrap_err(),
            "model URL must not include credentials",
        );
        let builtin = builtin_model_url();
        assert_eq!(validate_model_url(&builtin).unwrap().as_str(), builtin);
        assert!(validate_model_url(
            "https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/abc?filename=q.gguf&auth_key=1"
        )
        .is_ok());
        assert!(validate_model_url("https://www.modelscope.cn/models/Qwen/x").is_ok());
    }

    #[test]
    fn builtin_pinned_model_passes_the_allowlist() {
        let dir = TempDir::new();
        assert!(
            model_destination(&dir.0, BUILTIN_MODEL_FILENAME).is_ok(),
            "{}",
            BUILTIN_MODEL_FILENAME
        );
        let url = builtin_model_url();
        assert!(validate_model_url(&url).is_ok(), "{url}");
        assert_eq!(BUILTIN_MODEL_SHA256.len(), 64);
    }

    #[test]
    fn download_writes_the_body_and_resumes_a_partial_file() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) else {
                    break;
                };
                let range = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Range"))
                    .map(|h| h.value.as_str().to_string());
                let (status, payload) = match range.as_deref() {
                    None => (200, "hello"),
                    Some("bytes=5-") => (206, "WORLD"),
                    Some(_) => (400, "bad-range"),
                };
                let _ =
                    req.respond(tiny_http::Response::from_string(payload).with_status_code(status));
            }
        });
        let dir = TempDir::new();
        let dest = dir.0.join("model.gguf");
        let url = format!("http://{addr}/model.gguf");
        let http = client();
        download_model_file(
            &http,
            &url,
            &dest,
            &sha256_bytes(b"hello"),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"hello");
        download_model_file(
            &http,
            &url,
            &dest,
            &sha256_bytes(b"helloWORLD"),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"helloWORLD");
    }

    fn redirect_error(location: &str) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let location = location.to_string();
        std::thread::spawn(move || {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let header =
                    tiny_http::Header::from_bytes(&b"Location"[..], location.as_bytes()).unwrap();
                let _ = req.respond(tiny_http::Response::empty(302).with_header(header));
            }
        });
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .redirect(model_redirect_policy())
            .build()
            .unwrap();
        let err = client
            .get(format!("http://{addr}/model.gguf"))
            .send()
            .unwrap_err();
        error_detail(&err)
    }

    #[test]
    fn redirect_to_non_allowlisted_host_is_rejected() {
        let err = redirect_error("https://evil.example/steal.gguf");
        assert!(err.contains("not allowed"), "{err}");
        assert!(err.contains("evil.example"), "{err}");
    }

    #[test]
    fn redirect_to_http_on_allowlisted_host_is_rejected() {
        let err = redirect_error("http://cdn-lfs-cn-1.modelscope.cn/prod/object");
        assert!(err.contains("https"), "{err}");
    }

    #[test]
    fn home_comes_from_dirs() {
        let expected = dirs::home_dir().expect("this machine has a home directory");
        assert_eq!(home(), expected);
    }

    #[test]
    fn sha256_mismatch_deletes_the_downloaded_file() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = Arc::clone(&hits);
        std::thread::spawn(move || {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                hits2.fetch_add(1, Ordering::SeqCst);
                let _ = req.respond(tiny_http::Response::from_string("not-the-model"));
            }
        });
        let dir = TempDir::new();
        let dest = dir.0.join("model.gguf");
        let err = download_model_file(
            &client(),
            &format!("http://{addr}/model.gguf"),
            &dest,
            &sha256_bytes(b"the-model"),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(err.contains("校验和不符"), "{err}");
        assert!(!dest.exists(), "校验失败必须删掉文件");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn http_416_with_matching_size_is_complete_and_keeps_a_matching_sha256() {
        let body = b"hello-model";
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits2 = Arc::clone(&hits);
        std::thread::spawn(move || {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                hits2.fetch_add(1, Ordering::SeqCst);
                let value = format!("bytes */{}", body.len());
                let header =
                    tiny_http::Header::from_bytes(&b"Content-Range"[..], value.as_bytes()).unwrap();
                let _ = req.respond(tiny_http::Response::empty(416).with_header(header));
            }
        });
        let dir = TempDir::new();
        let dest = dir.0.join("model.gguf");
        fs::write(&dest, body).unwrap();
        download_model_file(
            &client(),
            &format!("http://{addr}/model.gguf"),
            &dest,
            &sha256_bytes(body),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(
            fs::read(&dest).unwrap(),
            body,
            "大小一致时应保留已完成的文件"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1, "已完成的文件不应该再拉一次");
    }

    #[test]
    fn http_416_matching_size_still_rejects_a_bad_sha256_and_deletes_the_file() {
        let body = b"hello-model";
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        std::thread::spawn(move || {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let value = format!("bytes */{}", body.len());
                let header =
                    tiny_http::Header::from_bytes(&b"Content-Range"[..], value.as_bytes()).unwrap();
                let _ = req.respond(tiny_http::Response::empty(416).with_header(header));
            }
        });
        let dir = TempDir::new();
        let dest = dir.0.join("model.gguf");
        fs::write(&dest, body).unwrap();
        let err = download_model_file(
            &client(),
            &format!("http://{addr}/model.gguf"),
            &dest,
            &sha256_bytes(b"other-bytes"),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(err.contains("校验和不符"), "{err}");
        assert!(!dest.exists(), "416 视为完成之后仍要校验,不符必须删掉");
    }

    #[test]
    fn http_416_with_a_different_size_errors_and_deletes_the_partial() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        std::thread::spawn(move || {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let header =
                    tiny_http::Header::from_bytes(&b"Content-Range"[..], &b"bytes */3"[..])
                        .unwrap();
                let _ = req.respond(tiny_http::Response::empty(416).with_header(header));
            }
        });
        let dir = TempDir::new();
        let dest = dir.0.join("model.gguf");
        fs::write(&dest, b"hello").unwrap();
        let err = download_model_file(
            &client(),
            &format!("http://{addr}/model.gguf"),
            &dest,
            &sha256_bytes(b"hello"),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(err.contains("416"), "{err}");
        assert!(err.contains("5") && err.contains("3"), "{err}");
        assert!(!dest.exists(), "大小对不上必须删掉半截文件,下次才能重下");
    }

    #[test]
    fn stalled_body_fails_on_the_idle_read_timeout() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0_u8; 2048];
            let _ = sock.read(&mut buf);
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n");
            std::thread::sleep(Duration::from_secs(3));
        });
        let dir = TempDir::new();
        let dest = dir.0.join("model.gguf");
        let idle = Duration::from_millis(400);
        let http = model_http_client(idle, true).unwrap();
        let started = Instant::now();
        let err = download_model_file(
            &http,
            &format!("http://{addr}/model.gguf"),
            &dest,
            &sha256_bytes(b"x"),
            idle,
        )
        .unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "空闲超时应该很快失败,实际 {:?}",
            started.elapsed()
        );
        assert!(err.contains("下载卡住"), "{err}");
    }
}
