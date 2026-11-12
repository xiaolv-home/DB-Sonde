//! 跑脚本:起进程、把 stdout/stderr 流回界面(`python://event`)、停止;脚本里 `import sonde` 查库走的本机桥;pip / playwright 安装。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::runtime::runtime_ready;
use super::workspace::in_workspace;
use super::{python_bin, workspace_dir, write_mplconfig, write_pylib, PyRuntime};

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
    code: Option<i32>,
}

/// Start the localhost bridge server once; return (port, token).
fn ensure_bridge(app: &tauri::AppHandle, rt: &PyRuntime) -> Result<(u16, String), String> {
    let mut g = rt.bridge.lock().unwrap();
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

fn bridge_serve(app: tauri::AppHandle, server: tiny_http::Server, token: String) {
    for mut req in server.incoming_requests() {
        let authed = req
            .headers()
            .iter()
            .any(|h| h.field.equiv("X-Sonde-Token") && h.value.as_str() == token);
        if !authed {
            let _ = req.respond(
                tiny_http::Response::from_string(err_json("unauthorized")).with_status_code(403),
            );
            continue;
        }
        let url = req.url().to_string();
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let out = handle_bridge(&app, &url, &body);
        let header = tiny_http::Header::from_bytes(
            &b"Content-Type"[..],
            &b"application/json; charset=utf-8"[..],
        )
        .unwrap();
        let _ = req.respond(tiny_http::Response::from_string(out).with_header(header));
    }
}

fn handle_bridge(app: &tauri::AppHandle, url: &str, body: &str) -> String {
    use crate::commands::{self, AppState};
    let state = app.state::<AppState>();
    if url.starts_with("/connections") {
        let names = tauri::async_runtime::block_on(commands::query::bridge_conn_names(&state));
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
        let res = tauri::async_runtime::block_on(commands::query::bridge_query(
            &state,
            &conn,
            req.database.as_deref(),
            &sql,
            req.max_rows,
        ));
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

    let child = Command::new(python_bin())
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
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 Python 失败:{e}"))?;

    stream_child(&app, req.run_id.clone(), child);
    Ok(())
}

/// Register a child under `run_id`, stream its stdout/stderr as `python://event`
/// (kind out/err), and emit an `exit` event when it finishes.
fn stream_child(app: &tauri::AppHandle, run_id: String, mut child: Child) {
    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || pump(app, rid, out, "out"));
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        let rid = run_id.clone();
        std::thread::spawn(move || pump(app, rid, err, "err"));
    }
    let shared = Arc::new(Mutex::new(child));
    if let Some(state) = app.try_state::<PyRuntime>() {
        state
            .procs
            .lock()
            .unwrap()
            .insert(run_id.clone(), Arc::clone(&shared));
    }
    let app_exit = app.clone();
    std::thread::spawn(move || {
        // 不能在这里阻塞 wait：停止按钮还要拿同一把锁去 kill。轮询 try_wait，锁马上放开。
        let code = loop {
            let polled = {
                let mut child = shared.lock().unwrap();
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
        if let Some(state) = app_exit.try_state::<PyRuntime>() {
            state.procs.lock().unwrap().remove(&run_id);
        }
        let _ = app_exit.emit(
            "python://event",
            PyEvent {
                run_id,
                kind: "exit".into(),
                text: None,
                code,
            },
        );
    });
}

fn pump<R: std::io::Read>(app: tauri::AppHandle, run_id: String, reader: R, kind: &'static str) {
    let mut buf = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match buf.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let _ = app.emit(
                    "python://event",
                    PyEvent {
                        run_id: run_id.clone(),
                        kind: kind.to_string(),
                        text: Some(line.clone()),
                        code: None,
                    },
                );
            }
            Err(_) => break,
        }
    }
}

/// Unix 上先 SIGTERM，宽限期内还在就 `Child::kill`（SIGKILL）。
/// 宽限放在后台线程里，这个同步命令本身马上返回，不占界面线程。
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(2);

#[tauri::command]
pub fn python_stop(rt: tauri::State<'_, PyRuntime>, run_id: String) -> Result<(), String> {
    let shared = {
        let procs = rt.procs.lock().unwrap();
        match procs.get(&run_id) {
            Some(shared) => Arc::clone(shared),
            // 已经跑完了(退出线程把它摘掉了)。不是错误,界面很快会收到 exit 事件。
            None => return Ok(()),
        }
    };
    stop_shared_child(&shared)
}

/// 停掉脚本进程。不调用 `kill` / `kill -TERM` 这种只有 Unix 才有的命令。
#[cfg(unix)]
fn stop_shared_child(shared: &Arc<Mutex<Child>>) -> Result<(), String> {
    let pid = shared.lock().unwrap().id();
    if let Err(err) = signal_pid(pid, libc::SIGTERM) {
        if err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        return Err(format!("发送停止信号失败:{err}"));
    }
    let shared = Arc::clone(shared);
    std::thread::spawn(move || {
        let deadline = Instant::now() + STOP_GRACE;
        loop {
            if !process_alive(pid) {
                return;
            }
            if Instant::now() >= deadline {
                // 退出线程还拿着这个 Child 去 try_wait，这里只发 SIGKILL，不 wait，避免把退出码收走。
                if let Ok(mut child) = shared.lock() {
                    let _ = child.kill();
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    Ok(())
}

/// `pid` 必须是本进程启动的脚本。`sig` 只用 SIGTERM（请求退出）或 0（探测是否还在）。
#[cfg(unix)]
fn signal_pid(pid: u32, sig: i32) -> std::io::Result<()> {
    // SAFETY: pid 来自 Child::id()，sig 是 SIGTERM 或 0，不会把信号发给进程组。
    let rc = unsafe { libc::kill(pid as libc::pid_t, sig) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    match signal_pid(pid, 0) {
        Ok(()) => true,
        Err(err) if err.raw_os_error() == Some(libc::ESRCH) => false,
        // 没权限探测时宁可再杀一次，不要当成已经停了。
        Err(_) => true,
    }
}

/// Windows 没有 `kill`。`taskkill /T` 连子进程一起结束（pip / playwright 会再起进程）；
/// 命令本身失败时退回 `Child::kill`，只结束这一支。
#[cfg(windows)]
fn stop_shared_child(shared: &Arc<Mutex<Child>>) -> Result<(), String> {
    let pid = shared.lock().unwrap().id();
    let killed = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match killed {
        Ok(status) if status.success() || status.code() == Some(128) => Ok(()),
        Ok(status) => {
            let mut child = shared.lock().unwrap();
            child
                .kill()
                .map_err(|e| format!("没能停掉这个脚本(进程 {pid}, taskkill {status}):{e}"))?;
            Ok(())
        }
        Err(e) => {
            let mut child = shared.lock().unwrap();
            child
                .kill()
                .map_err(|kill_err| format!("没能停掉这个脚本(进程 {pid}):{e}; {kill_err}"))?;
            Ok(())
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn stop_shared_child(shared: &Arc<Mutex<Child>>) -> Result<(), String> {
    let mut child = shared.lock().unwrap();
    child.kill().map_err(|e| format!("发送停止信号失败:{e}"))?;
    Ok(())
}

// ---- Phase 3: package install / plots / lint / completion ----

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
    if packages.is_empty() {
        return Err("没有要安装的包".into());
    }
    let mut cmd = Command::new(python_bin());
    cmd.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--disable-pip-version-check")
        .arg("-i")
        .arg("https://pypi.tuna.tsinghua.edu.cn/simple");
    for p in &packages {
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
    let child = Command::new(python_bin())
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
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 playwright 失败:{e}(先装 playwright 包)"))?;
    stream_child(&app, run_id, child);
    Ok(())
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
}
