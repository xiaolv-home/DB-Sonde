//! Python workbench backend.
//!
//! A relocatable CPython + core data packages ships as a single tarball in the
//! app's resources (see scripts/bundle-python.sh). On first use we extract it
//! into ~/.db-sonde/runtime/python so users never configure an environment.
//! `python_run` spawns a script and streams stdout/stderr back to the UI via
//! `python://event`; a run can be stopped. Simple workspace file CRUD backs the
//! "文件 · Python 脚本" list.

//!
//! 分成四块,各管一件事:`runtime`(运行时下载 / 解压 / 状态)、`run`(跑脚本 + `sonde` 查库桥)、
//! `workspace`(工作区文件)、`assist`(lint / 补全 / SQL 血缘)。这里只放它们共用的:
//! 状态、目录布局、写进运行时的那几个辅助 Python 模块。

pub mod assist;
pub mod run;
pub mod runtime;
pub mod workspace;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use assist::JediProc;

#[derive(Default)]
pub struct PyRuntime {
    /// run_id -> child pid, for stop().
    procs: Mutex<HashMap<String, u32>>,
    extracting: Arc<Mutex<bool>>,
    /// 下载进度 0-100。None = 没在下载。
    progress: Arc<Mutex<Option<u8>>>,
    error: Arc<Mutex<Option<String>>>,
    /// The `sonde` bridge HTTP server: (port, token), started lazily.
    bridge: Mutex<Option<(u16, String)>>,
    /// Persistent jedi completion server (stdin/stdout line protocol).
    jedi: Mutex<Option<JediProc>>,
}

/// The `sonde` Python module written into the runtime's pylib dir. It POSTs
/// SQL back to the local bridge so scripts can query the user's live connections.
const SONDE_PY: &str = r#"""" Sonde 桥:在脚本里直接查你已连接的数据库。

    from sonde import query, connections
    df = query("SELECT * FROM t", conn="原始库")   # -> pandas.DataFrame
    print(connections())                            # 当前打开的连接名
"""
import os as _os, json as _json, urllib.request as _u

_URL = _os.environ.get("SONDE_BRIDGE_URL")
_TOKEN = _os.environ.get("SONDE_BRIDGE_TOKEN", "")


def _call(path, payload):
    if not _URL:
        raise RuntimeError("sonde 桥不可用:请在 Sonde 的 Python 工作台里运行本脚本")
    data = _json.dumps(payload).encode("utf-8")
    req = _u.Request(_URL + path, data=data, method="POST",
                     headers={"Content-Type": "application/json",
                              "X-Sonde-Token": _TOKEN})
    with _u.urlopen(req, timeout=1800) as resp:
        obj = _json.loads(resp.read().decode("utf-8"))
    if not obj.get("ok", False):
        raise RuntimeError(obj.get("error", "查询失败"))
    return obj


def query(sql, conn="", database=None, max_rows=None):
    """跑一段**只读** SQL,返回 pandas.DataFrame。conn 传连接名(左侧那个名字)。

    只接受 SELECT / WITH / SHOW / EXPLAIN / DESCRIBE,而且一次只能一条语句。
    要改数据请去 SQL 编辑器 —— 那里的写操作会先让你确认,这儿不会。
    """
    obj = _call("/query", {"sql": sql, "conn": conn or "",
                           "database": database, "maxRows": max_rows})
    import pandas as pd
    return pd.DataFrame(obj.get("rows", []), columns=obj.get("columns", []))


def connections():
    """当前打开的连接名列表。"""
    return _call("/connections", {}).get("connections", [])


def show(fig=None, dpi=120):
    """把当前(或指定的)matplotlib 图片显示到输出台。"""
    import uuid as _uuid
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as _plt
    f = fig if fig is not None else _plt.gcf()
    d = _os.path.join(_os.environ.get("SONDE_WORKSPACE", "."), ".sonde_plots")
    _os.makedirs(d, exist_ok=True)
    p = _os.path.join(d, _uuid.uuid4().hex + ".png")
    f.savefig(p, dpi=dpi, bbox_inches="tight")
    _plt.close(f)
    print("⟦SONDE_IMG⟧" + p + "⟦/IMG⟧", flush=True)
"#;

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}
fn runtime_root() -> PathBuf {
    home().join(".db-sonde/runtime")
}
fn python_dir() -> PathBuf {
    runtime_root().join("python")
}
/// python-build-standalone 的 install_only 布局在两边不一样:
/// unix 是 `python/bin/python3`,Windows 是 `python/python.exe`。
/// 写死 unix 那条的话,Windows 上装好了运行时也找不到解释器。
fn python_bin() -> PathBuf {
    #[cfg(windows)]
    { python_dir().join("python.exe") }
    #[cfg(not(windows))]
    { python_dir().join("bin/python3") }
}
#[cfg(test)]
thread_local! { static TEST_WORKSPACE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) }; }
fn workspace_dir() -> PathBuf {
    #[cfg(test)]
    { TEST_WORKSPACE.with(|p| p.borrow().clone().expect("workspace tests must install an isolated fixture")) }
    #[cfg(not(test))]
    { home().join(".db-sonde/workspace") }
}
// ---- the `sonde` bridge: scripts query the user's live connections ----

fn pylib_dir() -> PathBuf {
    runtime_root().join("pylib")
}

/// Point matplotlib at macOS system CJK fonts so Chinese labels aren't tofu.
/// matplotlib reads `matplotlibrc` from MPLCONFIGDIR at import, so this applies
/// to every plot from the start (setting rcParams after plotting is too late).
fn write_mplconfig() -> PathBuf {
    let dir = runtime_root().join("mplconfig");
    let _ = std::fs::create_dir_all(&dir);
    let rc = "font.sans-serif: PingFang SC, Hiragino Sans GB, Heiti SC, STHeiti, Arial Unicode MS, DejaVu Sans\n\
              axes.unicode_minus: False\n";
    let _ = std::fs::write(dir.join("matplotlibrc"), rc);
    dir
}

/// Write `sonde.py` into the pylib dir (idempotent). Kept out of the bundled
/// site-packages so we can update it by changing Rust, no re-bundle needed.
fn write_pylib() -> PathBuf {
    let dir = pylib_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("sonde.py"), SONDE_PY);
    let _ = std::fs::write(dir.join("jedi_server.py"), JEDI_SERVER);
    dir
}

/// A persistent jedi completion server: one JSON request per line on stdin,
/// one JSON response per line on stdout. Keeps jedi warm between keystrokes.
const JEDI_SERVER: &str = r#"import sys, json
def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            import jedi
            script = jedi.Script(code=req["source"], path=None)
            comps = script.complete(int(req["line"]), int(req["col"]))
            items = [{"name": c.name, "type": c.type, "complete": c.complete} for c in comps[:60]]
            sys.stdout.write(json.dumps({"ok": True, "items": items}) + "\n")
        except Exception as e:
            sys.stdout.write(json.dumps({"ok": False, "error": str(e)}) + "\n")
        sys.stdout.flush()
main()
"#;
