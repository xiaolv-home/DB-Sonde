//! 跑脚本:起进程、把 stdout/stderr 流回界面(`python://event`)、停止;脚本里 `import sonde` 查库走的本机桥;pip / playwright 安装。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

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
            let _ = req.respond(tiny_http::Response::from_string(err_json("unauthorized")).with_status_code(403));
            continue;
        }
        let url = req.url().to_string();
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let out = handle_bridge(&app, &url, &body);
        let header =
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap();
        let _ = req.respond(tiny_http::Response::from_string(out).with_header(header));
    }
}

fn handle_bridge(app: &tauri::AppHandle, url: &str, body: &str) -> String {
    use crate::commands::{self, AppState};
    let state = app.state::<AppState>();
    if url.starts_with("/connections") {
        let names = tauri::async_runtime::block_on(commands::bridge_conn_names(&state));
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
        let res = tauri::async_runtime::block_on(commands::bridge_query(
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
pub fn python_run(app: tauri::AppHandle, rt: tauri::State<'_, PyRuntime>, req: RunReq) -> Result<(), String> {
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
    let workdir = script.parent().map(PathBuf::from).unwrap_or_else(workspace_dir);

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
        .env("SONDE_BRIDGE_URL", format!("http://127.0.0.1:{bridge_port}"))
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
fn stream_child(app: &tauri::AppHandle, run_id: String, mut child: std::process::Child) {
    if let Some(state) = app.try_state::<PyRuntime>() {
        state.procs.lock().unwrap().insert(run_id.clone(), child.id());
    }
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
    let app_exit = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        if let Some(state) = app_exit.try_state::<PyRuntime>() {
            state.procs.lock().unwrap().remove(&run_id);
        }
        let _ = app_exit.emit(
            "python://event",
            PyEvent { run_id, kind: "exit".into(), text: None, code },
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

#[tauri::command]
pub fn python_stop(rt: tauri::State<'_, PyRuntime>, run_id: String) -> Result<(), String> {
    let pid = match rt.procs.lock().unwrap().get(&run_id).copied() {
        Some(pid) => pid,
        // 已经跑完了(退出线程把它摘掉了)。不是错误,界面很快会收到 exit 事件。
        None => return Ok(()),
    };
    /* 原来是 `let _ = ...status()` —— 信号没发出去也照样返回 Ok,界面就以为停了。
       实际它还在跑,输出还在往外冒,用户只会觉得"这个停止按钮是坏的"。 */
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .map_err(|e| format!("发送停止信号失败:{e}"))?;
    if !status.success() {
        return Err(format!(
            "没能停掉这个脚本(进程 {pid})。它可能正卡在系统调用里,可以在活动监视器里结束它。"
        ));
    }
    Ok(())
}

// ---- Phase 3: package install / plots / lint / completion ----

/// pip-install packages from the Tsinghua mirror, streaming to `python://event`.
#[tauri::command]
pub fn py_pip_install(app: tauri::AppHandle, run_id: String, packages: Vec<String>) -> Result<(), String> {
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
        .env("PLAYWRIGHT_DOWNLOAD_HOST", "https://cdn.npmmirror.com/binaries/playwright")
        .env_remove("PYTHONHOME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 playwright 失败:{e}(先装 playwright 包)"))?;
    stream_child(&app, run_id, child);
    Ok(())
}
