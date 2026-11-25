//! 跑脚本:起进程、把 stdout/stderr 流回界面(`python://event`)、停止;脚本里 `import sonde` 查库走的本机桥;pip / playwright 安装。

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::runtime::runtime_ready;
use super::workspace::in_workspace;
use super::{lock_unpoisoned, python_bin, workspace_dir, write_mplconfig, write_pylib, PyRuntime};

/// Maximum HTTP body accepted on the localhost `sonde` bridge (1 MB).
const MAX_BRIDGE_BODY_BYTES: u64 = 1024 * 1024;
/// Maximum concurrent `sonde.query()` calls handled on the bridge.
const MAX_BRIDGE_CONCURRENCY: usize = 8;
/// Maximum bytes buffered in a single output chunk/line before flushing (32 KiB).
const MAX_OUTPUT_CHUNK_BYTES: usize = 32 * 1024;
/// Maximum lines emitted per stdout/stderr stream before truncating (draining continues).
const MAX_STREAM_LINES: usize = 20_000;
/// Batching window for `python://event` emissions so print loops never flood IPC.
const EMIT_BATCH_INTERVAL: Duration = Duration::from_millis(25);
const EMIT_BATCH_MAX_LINES: usize = 128;

#[derive(Deserialize)]
pub struct RunReq {
    #[serde(rename = "runId")]
    run_id: String,
    /// Absolute path of the .py file to run (already saved by the frontend).
    path: String,
}

#[derive(Serialize, Clone)]
struct PyEvent {
    #[serde(rename = "runId")]
    run_id: String,
    kind: String, // "out" | "err" | "exit"
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

#[cfg(unix)]
fn configure_process_group(cmd: &mut Command) -> &mut Command {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0)
}

#[cfg(not(unix))]
fn configure_process_group(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Start the localhost bridge server once; return (port, token).
fn ensure_bridge(app: &tauri::AppHandle, rt: &PyRuntime) -> Result<(u16, String), String> {
    let mut g = lock_unpoisoned(&rt.bridge);
    if let Some((p, t)) = g.as_ref() {
        return Ok((*p, t.clone()));
    }
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("桥启动失败:{e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("无法获取桥端口")?;
    let token = uuid::Uuid::new_v4().to_string();
    let app2 = app.clone();
    let token2 = token.clone();
    std::thread::spawn(move || bridge_serve(app2, server, token2));
    *g = Some((port, token.clone()));
    Ok((port, token))
}

#[derive(Deserialize)]
struct BridgeReq {
    sql: Option<String>,
    conn: Option<String>,
    database: Option<String>,
    #[serde(rename = "maxRows")]
    max_rows: Option<usize>,
}

fn err_json(msg: &str) -> String {
    serde_json::json!({ "ok": false, "error": msg }).to_string()
}

fn read_bounded_body(reader: &mut dyn Read) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    let mut limited = reader.take(MAX_BRIDGE_BODY_BYTES + 1);
    limited.read_to_end(&mut bytes).map_err(|_| "读取请求体失败")?;
    if bytes.len() as u64 > MAX_BRIDGE_BODY_BYTES {
        return Err("请求体超过 1 MB 安全上限");
    }
    String::from_utf8(bytes).map_err(|_| "请求体必须是合法 UTF-8")
}

fn respond_json(req: tiny_http::Request, status: u16, payload: String) {
    let mut response = tiny_http::Response::from_string(payload).with_status_code(status);
    if let Ok(header) = tiny_http::Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    ) {
        response = response.with_header(header);
    }
    let _ = req.respond(response);
}

fn bridge_serve(app: tauri::AppHandle, server: tiny_http::Server, token: String) {
    let permits = Arc::new(tokio::sync::Semaphore::new(MAX_BRIDGE_CONCURRENCY));
    for mut req in server.incoming_requests() {
        let authed = req
            .headers()
            .iter()
            .any(|h| h.field.equiv("X-Sonde-Token") && h.value.as_str() == token);
        if !authed {
            respond_json(req, 403, err_json("unauthorized"));
            continue;
        }
        let app = app.clone();
        let permits = Arc::clone(&permits);
        std::thread::spawn(move || {
            let url = req.url().to_string();
            let body = match read_bounded_body(req.as_reader()) {
                Ok(b) => b,
                Err(msg) => {
                    respond_json(req, 413, err_json(msg));
                    return;
                }
            };
            let out = tauri::async_runtime::block_on(async move {
                let _permit = permits.acquire().await;
                handle_bridge(&app, &url, &body).await
            });
            respond_json(req, 200, out);
        });
    }
}

async fn handle_bridge(app: &tauri::AppHandle, url: &str, body: &str) -> String {
    use crate::commands::{self, AppState};
    let state = app.state::<AppState>();
    if url.starts_with("/connections") {
        let names = commands::query::bridge_conn_names(&state).await;
        return serde_json::json!({ "ok": true, "connections": names }).to_string();
    }
    if url.starts_with("/query") {
        let req: BridgeReq = match serde_json::from_str(body) {
            Ok(r) => r,
            Err(e) => return err_json(&format!("请求解析失败:{e}")),
        };
        let sql = req.sql.unwrap_or_default();
        if sql.trim().is_empty() {
            return err_json("sql 不能为空");
        }
        let conn = req.conn.unwrap_or_default();
        let res = commands::query::bridge_query(
            &state,
            &conn,
            req.database.as_deref(),
            &sql,
            req.max_rows,
        )
        .await;
        return match res {
            Ok(qr) => {
                let cols: Vec<&str> = qr.columns.iter().map(|c| c.name.as_str()).collect();
                serde_json::json!({
                    "ok": true,
                    "columns": cols,
                    "rows": qr.rows,
                    "truncated": qr.truncated,
                    "rowsAffected": qr.rows_affected,
                })
                .to_string()
            }
            Err(e) => err_json(&e.to_string()),
        };
    }
    err_json("未知接口")
}

/// Run a saved script, streaming stdout/stderr to `python://event`.
#[tauri::command]
pub fn python_run(
    app: tauri::AppHandle,
    rt: tauri::State<'_, PyRuntime>,
    req: RunReq,
) -> Result<(), String> {
    if !runtime_ready() {
        return Err("Python 运行时还没就绪".into());
    }
    let script = PathBuf::from(&req.path);
    if !script.exists() {
        return Err("脚本文件不存在".into());
    }
    /* 读、写、删、改名都过 in_workspace,唯独"运行"没过 —— 这条命令能跑机器上
    任何一个 .py。目前只有前端在调,传的都是工作区里的路径,但把守卫留一个
    缺口本身就是问题:下一个调用方(AI 工具、自动化、别的面板)不会知道
    这条路没人看门。 */
    if !in_workspace(&script) {
        return Err("脚本不在工作区内".into());
    }
    let workdir = script
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(workspace_dir);

    // Start the bridge + drop the `sonde` module in, so scripts can query the
    // user's live connections. Failure here is non-fatal (plain Python still runs).
    let (bridge_port, bridge_token) = ensure_bridge(&app, &rt).unwrap_or((0, String::new()));
    let pylib = write_pylib();

    let mut cmd = Command::new(python_bin());
    configure_process_group(&mut cmd)
        .arg("-X")
        .arg("utf8")
        .arg(&script)
        .current_dir(&workdir)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        // pylib holds our `sonde` module; site-packages still resolves normally
        .env("PYTHONPATH", &pylib)
        .env(
            "SONDE_BRIDGE_URL",
            format!("http://127.0.0.1:{bridge_port}"),
        )
        .env("SONDE_BRIDGE_TOKEN", &bridge_token)
        .env("SONDE_WORKSPACE", workspace_dir())
        .env("MPLBACKEND", "Agg") // headless matplotlib; use sonde.show() to render
        .env("MPLCONFIGDIR", write_mplconfig()) // CJK fonts + font cache
        .env_remove("PYTHONHOME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("启动 Python 失败:{e}"))?;

    stream_child(&app, req.run_id.clone(), child);
    Ok(())
}

/// Register a child under `run_id`, stream its stdout/stderr as `python://event`
/// (kind out/err), and emit an `exit` event when it finishes and pipes are drained.
fn stream_child(app: &tauri::AppHandle, run_id: String, mut child: Child) {
    let out_handle = child.stdout.take().map(|out| {
        let app = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || pump(app, rid, out, "out"))
    });
    let err_handle = child.stderr.take().map(|err| {
        let app = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || pump(app, rid, err, "err"))
    });
    let shared = Arc::new(Mutex::new(child));
    if let Some(state) = app.try_state::<PyRuntime>() {
        lock_unpoisoned(&state.procs).insert(run_id.clone(), Arc::clone(&shared));
    }
    let app_exit = app.clone();
    std::thread::spawn(move || {
        // 不能在这里阻塞 wait：停止按钮还要拿同一把锁去 kill。轮询 try_wait，锁马上放开。
        let code = loop {
            let polled = {
                let mut child = lock_unpoisoned(&shared);
                match child.try_wait() {
                    Ok(Some(status)) => Some(status.code()),
                    Ok(None) => None,
                    Err(_) => Some(None),
                }
            };
            if let Some(code) = polled {
                break code;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        if let Some(h) = out_handle {
            let _ = h.join();
        }
        if let Some(h) = err_handle {
            let _ = h.join();
        }
        if let Some(state) = app_exit.try_state::<PyRuntime>() {
            lock_unpoisoned(&state.procs).remove(&run_id);
        }
        let _ = app_exit.emit(
            "python://event",
            PyEvent {
                run_id,
                kind: "exit".into(),
                text: None,
                lines: None,
                code,
            },
        );
    });
}

/// Read up to `max_bytes` or the next `\n`, so a script printing huge single lines
/// (or `\r` progress bars without `\n`) never grows an unbounded buffer in RAM.
fn read_bounded_chunk<R: BufRead>(reader: &mut R, max_bytes: usize) -> std::io::Result<Option<String>> {
    let mut raw = Vec::new();
    while raw.len() < max_bytes {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            break;
        }
        let room = max_bytes - raw.len();
        let window = &available[..available.len().min(room)];
        if let Some(nl) = window.iter().position(|&b| b == b'\n') {
            raw.extend_from_slice(&window[..=nl]);
            reader.consume(nl + 1);
            break;
        }
        let consumed = window.len();
        raw.extend_from_slice(window);
        reader.consume(consumed);
    }
    if raw.is_empty() {
        Ok(None)
    } else {
        Ok(Some(String::from_utf8_lossy(&raw).into_owned()))
    }
}

fn flush_batch(app: &tauri::AppHandle, run_id: &str, kind: &str, batch: &mut Vec<String>) {
    if batch.is_empty() {
        return;
    }
    let lines = std::mem::take(batch);
    let single = if lines.len() == 1 {
        Some(lines[0].clone())
    } else {
        None
    };
    let _ = app.emit(
        "python://event",
        PyEvent {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            text: single,
            lines: Some(lines),
            code: None,
        },
    );
}

fn pump<R: Read>(app: tauri::AppHandle, run_id: String, reader: R, kind: &'static str) {
    let mut buf = BufReader::new(reader);
    let mut batch: Vec<String> = Vec::new();
    let mut last_emit = Instant::now();
    let mut total_lines: usize = 0;
    let mut truncated = false;

    while let Ok(Some(chunk)) = read_bounded_chunk(&mut buf, MAX_OUTPUT_CHUNK_BYTES) {
        if truncated {
            // Keep draining the pipe so the child process never blocks on a full OS pipe buffer.
            continue;
        }
        total_lines += 1;
        if total_lines > MAX_STREAM_LINES {
            batch.push(format!(
                "… 输出已超过 {MAX_STREAM_LINES} 行上限，后续日志已省略（脚本仍在继续执行）…\n"
            ));
            flush_batch(&app, &run_id, kind, &mut batch);
            truncated = true;
            continue;
        }
        batch.push(chunk);
        if batch.len() >= EMIT_BATCH_MAX_LINES || last_emit.elapsed() >= EMIT_BATCH_INTERVAL {
            flush_batch(&app, &run_id, kind, &mut batch);
            last_emit = Instant::now();
        }
    }
    flush_batch(&app, &run_id, kind, &mut batch);
}

/// Unix 上先 SIGTERM，宽限期内还在就 SIGKILL（含整个子进程组）。
/// 宽限放在后台线程里，这个命令本身马上返回，不占界面线程。
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(2);

#[tauri::command]
pub async fn python_stop(rt: tauri::State<'_, PyRuntime>, run_id: String) -> Result<(), String> {
    let shared = {
        let procs = lock_unpoisoned(&rt.procs);
        match procs.get(&run_id) {
            Some(shared) => Arc::clone(shared),
            // 已经跑完了(退出线程把它摘掉了)。不是错误,界面很快会收到 exit 事件。
            None => return Ok(()),
        }
    };
    tauri::async_runtime::spawn_blocking(move || stop_shared_child(&shared))
        .await
        .map_err(|e| format!("停止脚本失败: {e}"))?
}

/// 停掉脚本进程及其整个进程组。
#[cfg(unix)]
fn stop_shared_child(shared: &Arc<Mutex<Child>>) -> Result<(), String> {
    let mut child = lock_unpoisoned(shared);
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let pid = child.id();
    if let Err(err) = signal_tree(pid, libc::SIGTERM) {
        if err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        return Err(format!("发送停止信号失败:{err}"));
    }
    drop(child);
    let shared = Arc::clone(shared);
    std::thread::spawn(move || {
        let deadline = Instant::now() + STOP_GRACE;
        loop {
            let mut child = lock_unpoisoned(&shared);
            if !matches!(child.try_wait(), Ok(None)) {
                let _ = signal_tree(pid, libc::SIGKILL);
                return;
            }
            if Instant::now() >= deadline {
                // 退出线程还拿着这个 Child 去 try_wait，这里发 SIGKILL 给进程组 + 子进程，不 wait。
                let _ = signal_tree(pid, libc::SIGKILL);
                let _ = child.kill();
                return;
            }
            drop(child);
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    Ok(())
}

/// 应用退出时立即终止脚本及其孙进程。
#[cfg(unix)]
pub(super) fn force_kill_shared_child(shared: &Arc<Mutex<Child>>) {
    let mut child = lock_unpoisoned(shared);
    let pid = child.id();
    let _ = signal_tree(pid, libc::SIGKILL);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
pub(super) fn force_kill_shared_child(shared: &Arc<Mutex<Child>>) {
    let _ = stop_shared_child(shared);
    let mut child = lock_unpoisoned(shared);
    let _ = child.wait();
}

#[cfg(not(any(unix, windows)))]
pub(super) fn force_kill_shared_child(shared: &Arc<Mutex<Child>>) {
    let mut child = lock_unpoisoned(shared);
    let _ = child.kill();
    let _ = child.wait();
}

/// 优先向独立进程组 `-pid` 发信号（连孙进程一起终止）；若目标不是进程组长（如测试直接起的子进程），
/// 则回退到向单个 `pid` 发信号。
#[cfg(unix)]
fn signal_tree(pid: u32, sig: i32) -> std::io::Result<()> {
    let raw = pid as libc::pid_t;
    if raw <= 1 {
        return Err(std::io::Error::from_raw_os_error(libc::EINVAL));
    }
    // SAFETY: `configure_process_group` 为脚本创建了 pgid == pid 的独立进程组；
    // 若该 pid 不是进程组长，`kill(-raw, sig)` 返回 ESRCH，不会误伤当前应用进程组。
    let group_rc = unsafe { libc::kill(-raw, sig) };
    if group_rc == 0 {
        return Ok(());
    }
    let group_err = std::io::Error::last_os_error();
    if group_err.raw_os_error() != Some(libc::ESRCH) {
        return Err(group_err);
    }
    let single_rc = unsafe { libc::kill(raw, sig) };
    if single_rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Windows 没有 `kill`。`taskkill /T` 连子进程一起结束（pip / playwright 会再起进程）；
/// 命令本身失败时退回 `Child::kill`，只结束这一支。
#[cfg(windows)]
fn stop_shared_child(shared: &Arc<Mutex<Child>>) -> Result<(), String> {
    let mut child = lock_unpoisoned(shared);
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }
    let pid = child.id();
    use std::os::windows::process::CommandExt;
    let killed = Command::new("taskkill")
        .creation_flags(0x0800_0000)
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match killed {
        Ok(status) if status.success() || status.code() == Some(128) => Ok(()),
        Ok(status) => {
            child
                .kill()
                .map_err(|e| format!("没能停掉这个脚本(进程 {pid}, taskkill {status}):{e}"))?;
            Ok(())
        }
        Err(e) => {
            child
                .kill()
                .map_err(|kill_err| format!("没能停掉这个脚本(进程 {pid}):{e}; {kill_err}"))?;
            Ok(())
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn stop_shared_child(shared: &Arc<Mutex<Child>>) -> Result<(), String> {
    let mut child = lock_unpoisoned(shared);
    child.kill().map_err(|e| format!("发送停止信号失败:{e}"))?;
    Ok(())
}

// ---- Phase 3: package install / plots / lint / completion ----

/// Validate a pip requirement specifier so CLI flags (`--index-url`, `--target`, `-e`)
/// and local/URL paths cannot be smuggled into `pip install`.
pub(crate) fn validate_pip_package(raw: &str) -> Result<&str, String> {
    let spec = raw.trim();
    if spec.is_empty() {
        return Err("包名不能为空".into());
    }
    if spec.len() > 128 {
        return Err(format!("包名过长: {spec}"));
    }
    if spec.starts_with('-') {
        return Err(format!("不允许传入 pip 选项参数: {spec}"));
    }
    if !spec.as_bytes()[0].is_ascii_alphanumeric() {
        return Err(format!("不合法的包名: {spec}"));
    }
    if spec.contains('@') || spec.contains('/') || spec.contains('\\') || spec.contains(':') {
        return Err(format!("仅支持标准 PyPI 包名与版本约束,不支持路径或 URL: {spec}"));
    }
    let valid_chars = spec.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(b, b'.' | b'_' | b'-' | b'[' | b']' | b',' | b'=' | b'<' | b'>' | b'!' | b'~' | b'*')
    });
    if !valid_chars {
        return Err(format!("包名包含非法字符: {spec}"));
    }
    Ok(spec)
}

/// pip-install packages from the Tsinghua mirror, streaming to `python://event`.
#[tauri::command]
pub fn py_pip_install(
    app: tauri::AppHandle,
    run_id: String,
    packages: Vec<String>,
) -> Result<(), String> {
    if !runtime_ready() {
        return Err("Python 运行时未就绪".into());
    }
    let mut cleaned = Vec::with_capacity(packages.len());
    for pkg in &packages {
        cleaned.push(validate_pip_package(pkg)?);
    }
    if cleaned.is_empty() {
        return Err("没有要安装的包".into());
    }
    let mut cmd = Command::new(python_bin());
    configure_process_group(&mut cmd)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--disable-pip-version-check")
        .arg("-i")
        .arg("https://pypi.tuna.tsinghua.edu.cn/simple")
        .arg("--");
    for p in cleaned {
        cmd.arg(p);
    }
    let child = cmd
        .env("PYTHONUNBUFFERED", "1")
        .env_remove("PYTHONHOME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 pip 失败:{e}"))?;
    stream_child(&app, run_id, child);
    Ok(())
}

/// Download Playwright's Chromium browser (via a China mirror), streaming logs.
#[tauri::command]
pub fn py_playwright_install(app: tauri::AppHandle, run_id: String) -> Result<(), String> {
    if !runtime_ready() {
        return Err("Python 运行时未就绪".into());
    }
    let mut cmd = Command::new(python_bin());
    configure_process_group(&mut cmd)
        .arg("-m")
        .arg("playwright")
        .arg("install")
        .arg("chromium")
        .env("PYTHONUNBUFFERED", "1")
        .env(
            "PLAYWRIGHT_DOWNLOAD_HOST",
            "https://cdn.npmmirror.com/binaries/playwright",
        )
        .env_remove("PYTHONHOME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 playwright 失败:{e}(先装 playwright 包)"))?;
    stream_child(&app, run_id, child);
    Ok(())
}

#[cfg(test)]
mod pip_validation_tests {
    use super::{read_bounded_chunk, validate_pip_package};
    use std::io::BufReader;

    #[test]
    fn curated_and_versioned_packages_pass_while_flags_and_urls_fail() {
        for good in [
            "oracledb",
            "PyMySQL",
            "psycopg[binary]",
            "scikit-learn",
            "pandas>=2.1,<3.0",
            "pydantic[email]~=2.5",
        ] {
            assert_eq!(validate_pip_package(good).unwrap(), good);
        }
        for bad in [
            "",
            "   ",
            "-e",
            "--index-url=https://evil.example/simple",
            "--target=/tmp/out",
            "../local_pkg",
            "evil@https://evil.example/pkg.whl",
            "git+https://evil.example/repo.git",
            "pkg;rm -rf /",
        ] {
            assert!(validate_pip_package(bad).is_err(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn bounded_chunk_splits_long_lines_without_newline() {
        let input = "abcdefghij\nxy";
        let mut reader = BufReader::new(input.as_bytes());
        assert_eq!(read_bounded_chunk(&mut reader, 4).unwrap().as_deref(), Some("abcd"));
        assert_eq!(read_bounded_chunk(&mut reader, 4).unwrap().as_deref(), Some("efgh"));
        assert_eq!(read_bounded_chunk(&mut reader, 4).unwrap().as_deref(), Some("ij\n"));
        assert_eq!(read_bounded_chunk(&mut reader, 4).unwrap().as_deref(), Some("xy"));
        assert_eq!(read_bounded_chunk(&mut reader, 4).unwrap(), None);
    }
}

#[cfg(all(test, unix))]
mod stop_tests {
    use super::*;

    struct KillOnDrop(Arc<Mutex<Child>>);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            if let Ok(mut child) = self.0.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    fn wait_until_exited(shared: &Arc<Mutex<Child>>, limit: Duration) -> std::process::ExitStatus {
        let deadline = Instant::now() + limit;
        loop {
            let mut child = shared.lock().unwrap();
            match child.try_wait().unwrap() {
                Some(status) => return status,
                None if Instant::now() < deadline => {
                    drop(child);
                    std::thread::sleep(Duration::from_millis(30));
                }
                None => panic!("进程在 {:?} 内没有退出", limit),
            }
        }
    }

    #[test]
    fn stop_sends_sigterm_without_a_kill_command() {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let shared = Arc::new(Mutex::new(child));
        let _guard = KillOnDrop(Arc::clone(&shared));
        stop_shared_child(&shared).unwrap();
        let status = wait_until_exited(&shared, Duration::from_secs(5));
        assert!(
            !status.success(),
            "SIGTERM 之后 sleep 不该以 0 退出:{status}"
        );
    }

    #[test]
    fn stop_kills_when_sigterm_is_ignored() {
        let mut child = Command::new("bash")
            .args([
                "-c",
                "trap '' TERM; echo ready; while true; do sleep 0.2; done",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let shared = Arc::new(Mutex::new(child));
        let _guard = KillOnDrop(Arc::clone(&shared));
        // 等 trap 装好再发信号，否则 SIGTERM 会在 bash 忽略它之前把进程打死。
        let mut ready = [0_u8; 6];
        std::io::Read::read_exact(&mut stdout, &mut ready).unwrap();
        assert_eq!(&ready, b"ready\n");
        let started = Instant::now();
        stop_shared_child(&shared).unwrap();
        let status = wait_until_exited(&shared, Duration::from_secs(8));
        assert!(
            started.elapsed() >= STOP_GRACE - Duration::from_millis(300),
            "忽略 SIGTERM 时应该等到宽限期再 kill，实际 {:?}",
            started.elapsed()
        );
        assert!(!status.success(), "{status}");
    }

    #[test]
    fn stop_terminates_grandchild_processes_in_the_same_process_group() {
        let mut cmd = Command::new("bash");
        configure_process_group(&mut cmd)
            .args([
                "-c",
                "sleep 30 & gpid=$!; echo $gpid; wait $gpid",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let shared = Arc::new(Mutex::new(child));
        let _guard = KillOnDrop(Arc::clone(&shared));
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        let grandchild_pid: libc::pid_t = line.trim().parse().unwrap();
        stop_shared_child(&shared).unwrap();
        let _ = wait_until_exited(&shared, Duration::from_secs(5));
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if unsafe { libc::kill(grandchild_pid, 0) } != 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        unsafe { libc::kill(grandchild_pid, libc::SIGKILL) };
        panic!("孙进程 {grandchild_pid} 在父脚本停止后仍然残留");
    }
}

#[cfg(all(test, windows))]
mod windows_stop_tests {
    use super::*;
    #[test]
    fn stop_uses_the_owned_windows_process_and_is_idempotent() {
        use std::os::windows::process::CommandExt;
        let child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let shared = Arc::new(Mutex::new(child));
        stop_shared_child(&shared).unwrap();
        let start = std::time::Instant::now();
        loop {
            if shared.lock().unwrap().try_wait().unwrap().is_some() {
                break;
            }
            if start.elapsed() > Duration::from_secs(5) {
                let mut child = shared.lock().unwrap();
                let _ = child.kill();
                let _ = child.wait();
                panic!("Windows child did not stop");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        stop_shared_child(&shared).unwrap();
    }
}
