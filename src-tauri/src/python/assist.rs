//! 编辑器辅助:lint(ruff)、补全(常驻 jedi 进程,带超时熔断)。

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use serde::Serialize;

use super::runtime::runtime_ready;
use super::workspace::in_workspace;
use super::{lock_unpoisoned, python_bin, python_dir, write_pylib, PyRuntime};

const JEDI_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_JEDI_LINE_BYTES: u64 = 512 * 1024;

pub(super) struct JediProc {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    rx: Receiver<String>,
}

impl JediProc {
    pub(super) fn shutdown(mut self) {
        drop(self.stdin);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize)]
pub struct LintIssue {
    line: u32,
    col: u32,
    code: String,
    message: String,
}

pub(crate) fn validate_lint_path(path: &str) -> Result<&Path, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err("路径不在工作区内".into());
    }
    let candidate = Path::new(trimmed);
    if !in_workspace(candidate) {
        return Err("路径不在工作区内".into());
    }
    Ok(candidate)
}

/// Lint a saved script with the bundled ruff. Empty when ruff isn't present.
// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn py_lint(path: String) -> Result<Vec<LintIssue>, String> {
    let checked = validate_lint_path(&path)?;
    let ruff = python_dir().join("bin/ruff");
    if !ruff.exists() {
        return Ok(vec![]);
    }
    let out = Command::new(&ruff)
        .arg("check")
        .arg("--output-format")
        .arg("json")
        .arg("--quiet")
        .arg("--no-cache")
        .arg("--")
        .arg(checked)
        .output()
        .map_err(|e| format!("ruff 运行失败:{e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let arr: Vec<serde_json::Value> = serde_json::from_str(&stdout).unwrap_or_default();
    Ok(arr
        .iter()
        .map(|v| LintIssue {
            line: v["location"]["row"].as_u64().unwrap_or(1) as u32,
            col: v["location"]["column"].as_u64().unwrap_or(1) as u32,
            code: v["code"].as_str().unwrap_or("").to_string(),
            message: v["message"].as_str().unwrap_or("").to_string(),
        })
        .collect())
}

#[derive(Serialize)]
pub struct Completion {
    label: String,
    kind: String,
    apply: String,
}

fn read_bounded_jedi_line(reader: &mut BufReader<std::process::ChildStdout>) -> Option<String> {
    let mut line = String::new();
    let mut limited = reader.take(MAX_JEDI_LINE_BYTES);
    match limited.read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line),
    }
}

/// Start (or reuse) the persistent jedi server.
fn ensure_jedi(rt: &PyRuntime) -> Result<(), String> {
    let mut g = lock_unpoisoned(&rt.jedi);
    if let Some(jp) = g.as_mut() {
        if matches!(jp.child.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    if let Some(dead) = g.take() {
        dead.shutdown();
    }
    let pylib = write_pylib();
    let mut child = Command::new(python_bin())
        .arg("-X")
        .arg("utf8")
        .arg(pylib.join("jedi_server.py"))
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONPATH", &pylib)
        .env_remove("PYTHONHOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动补全失败:{e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::sync_channel(4);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(line) = read_bounded_jedi_line(&mut reader) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    *g = Some(JediProc { child, stdin, rx });
    Ok(())
}

/// Code completion via jedi. `line` is 1-based, `col` 0-based (jedi's convention).
/// Returns empty on any failure or timeout so the editor never breaks or deadlocks.
// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn py_complete(
    rt: tauri::State<'_, PyRuntime>,
    source: String,
    line: u32,
    col: u32,
) -> Result<Vec<Completion>, String> {
    if !runtime_ready() || ensure_jedi(&rt).is_err() {
        return Ok(vec![]);
    }
    let mut g = lock_unpoisoned(&rt.jedi);
    let jp = match g.as_mut() {
        Some(x) => x,
        None => return Ok(vec![]),
    };
    while jp.rx.try_recv().is_ok() {}
    let req = serde_json::json!({ "source": source, "line": line, "col": col }).to_string();
    if writeln!(jp.stdin, "{req}").and_then(|_| jp.stdin.flush()).is_err() {
        if let Some(dead) = g.take() {
            dead.shutdown();
        }
        return Ok(vec![]);
    }
    let buf = match jp.rx.recv_timeout(JEDI_TIMEOUT) {
        Ok(line) => line,
        Err(_) => {
            if let Some(hung) = g.take() {
                hung.shutdown();
            }
            return Ok(vec![]);
        }
    };
    let resp: serde_json::Value = serde_json::from_str(buf.trim()).unwrap_or_default();
    if !resp["ok"].as_bool().unwrap_or(false) {
        return Ok(vec![]);
    }
    let items = resp["items"].as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .map(|it| Completion {
            label: it["name"].as_str().unwrap_or("").to_string(),
            kind: it["type"].as_str().unwrap_or("").to_string(),
            apply: it["complete"].as_str().unwrap_or("").to_string(),
        })
        .collect())
}

#[cfg(test)]
mod assist_tests {
    use super::validate_lint_path;
    use crate::python::TEST_WORKSPACE;

    #[test]
    fn lint_rejects_outside_paths_and_cli_flags() {
        let root = std::env::temp_dir().join(format!("sonde-lint-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        TEST_WORKSPACE.with(|p| *p.borrow_mut() = Some(root.clone()));

        let inside = root.join("ok.py");
        std::fs::write(&inside, "x = 1\n").unwrap();
        assert!(validate_lint_path(&inside.to_string_lossy()).is_ok());

        for bad in [
            "",
            "--config=/etc/passwd",
            "-e",
            "/etc/passwd",
            &root.join("../outside.py").to_string_lossy(),
        ] {
            assert!(validate_lint_path(bad).is_err(), "{bad} 应被拒绝");
        }

        TEST_WORKSPACE.with(|p| *p.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
