//! 编辑器辅助:lint(pyflakes)、补全(常驻 jedi 进程)、SQL 表级血缘(sqlglot)。

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde::Serialize;

use super::runtime::runtime_ready;
use super::{python_bin, python_dir, write_pylib, PyRuntime};

pub(super) struct JediProc {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
}


#[derive(Serialize)]
pub struct LintIssue {
    line: u32,
    col: u32,
    code: String,
    message: String,
}

/// Lint a saved script with the bundled ruff. Empty when ruff isn't present.
// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn py_lint(path: String) -> Result<Vec<LintIssue>, String> {
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
        .arg(&path)
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

/// Start (or reuse) the persistent jedi server.
fn ensure_jedi(rt: &PyRuntime) -> Result<(), String> {
    let mut g = rt.jedi.lock().unwrap();
    if let Some(jp) = g.as_mut() {
        if matches!(jp.child.try_wait(), Ok(None)) {
            return Ok(());
        }
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
    *g = Some(JediProc { child, stdin, reader: BufReader::new(stdout) });
    Ok(())
}

/// Code completion via jedi. `line` is 1-based, `col` 0-based (jedi's convention).
/// Returns empty on any failure so the editor never breaks.
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
    let mut g = rt.jedi.lock().unwrap();
    let jp = match g.as_mut() {
        Some(x) => x,
        None => return Ok(vec![]),
    };
    let req = serde_json::json!({ "source": source, "line": line, "col": col }).to_string();
    if writeln!(jp.stdin, "{req}").and_then(|_| jp.stdin.flush()).is_err() {
        *g = None;
        return Ok(vec![]);
    }
    let mut buf = String::new();
    if jp.reader.read_line(&mut buf).is_err() {
        *g = None;
        return Ok(vec![]);
    }
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

#[derive(Serialize, Default)]
pub struct LineageResult {
    flows: Vec<serde_json::Value>,
    ok: bool,
    target: Option<String>,
    sources: Vec<String>,
    error: Option<String>,
}

/// Table-level lineage of one SQL statement, via sqlglot. `dialect` is a sqlglot
/// dialect name (mysql/postgres/oracle/sqlite/tsql/clickhouse…), or empty.
// 在线程池里跑,不占界面线程(同步命令默认在主线程执行,跑多久界面就卡多久)
#[tauri::command(async)]
pub fn py_sql_lineage(sql: String, dialect: Option<String>) -> Result<LineageResult, String> {
    if !runtime_ready() {
        return Err("Python 运行时未就绪".into());
    }
    let pylib = write_pylib();
    let mut child = Command::new(python_bin())
        .arg("-X")
        .arg("utf8")
        .arg(pylib.join("sqllineage.py"))
        .arg(dialect.unwrap_or_default())
        .env("PYTHONPATH", &pylib)
        .env("PYTHONIOENCODING", "utf-8")
        .env_remove("PYTHONHOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动解析失败:{e}"))?;
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(sql.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| format!("解析失败:{e}"))?;
    let s = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(s.trim()).unwrap_or_default();
    Ok(LineageResult {
        flows: v["flows"].as_array().cloned().unwrap_or_default(),
        ok: v["ok"].as_bool().unwrap_or(false),
        target: v["target"].as_str().map(|x| x.to_string()),
        sources: v["sources"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        error: v["error"].as_str().map(|x| x.to_string()),
    })
}
