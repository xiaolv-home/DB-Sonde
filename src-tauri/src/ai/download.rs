//! 内置模型下载：固定的 ModelScope 地址、主机白名单、逐跳重定向校验、
//! 断点续传、空闲超时和 SHA-256 校验。引擎进程的启停在上一级 `ai` 模块。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

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
pub(super) const BUILTIN_MODEL_FILENAME: &str = "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf";
const BUILTIN_MODEL_SHA256: &str =
    "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c";
pub(super) const BUILTIN_MODEL_SIZE: u64 = 4_683_073_344;

/// 空闲读超时。blocking 客户端的 `timeout` 包在每一次 `Read::read` 外面，
/// 这次读完、下次再计。不要写成 `.timeout(24h)`，也不要注释成
/// 「24 小时只是为了停住卡住的连接」——24 小时没有数据才失败，等于发现不了卡死。
/// 异步客户端的 `timeout` 是另一回事：那是整次请求的总期限。
const MODEL_IDLE_READ_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) fn builtin_model_url() -> String {
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

pub(super) fn validate_model_url(raw: &str) -> Result<reqwest::Url, String> {
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
pub(super) fn model_destination(dir: &Path, filename: &str) -> Result<PathBuf, String> {
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
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT: never follow a link.
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

pub(super) fn download_builtin_model(url: &str, dest: &Path) -> Result<(), String> {
    let client = model_http_client(MODEL_IDLE_READ_TIMEOUT, false)?;
    let partial = dest.with_extension("gguf.part");
    download_model_file(
        &client,
        url,
        &partial,
        BUILTIN_MODEL_SHA256,
        MODEL_IDLE_READ_TIMEOUT,
    )?;
    fs::rename(&partial, dest).map_err(|e| format!("保存已校验模型失败: {e}"))
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

#[cfg(test)]
#[path = "download_tests.rs"]
mod model_download_tests;
