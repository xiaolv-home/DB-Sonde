//! Python 运行时:随包带的或从 Release 下载的 CPython + 数据包,校验后解压到 ~/.db-sonde/runtime/python。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager};

use super::{python_bin, python_dir, runtime_root, workspace_dir, PyRuntime};

/// Bump when scripts/bundle-python.sh changes the python/packages, so the app
/// re-extracts on upgrade. Must match RUNTIME_VERSION in that script.
const RUNTIME_VERSION: &str = "py3.12.14-pkgs3";

/// 运行时不随安装包分发时,从这个固定的 Release tag 下载。运行时很少变
/// (只有 Python 版本或包清单变了才动),所以不跟应用版本绑。
const RUNTIME_TAG: &str = "runtime-py3.12.14-pkgs3";
const RUNTIME_BASE: &str =
    "https://github.com/xiaolv-home/DB-Sonde/releases/download";

/// 每个平台的 (资产名, 期望的 SHA256)。
///
/// **哈希写死在源码里,不从同一个服务器下 .sha256 来比。** 后者挡不住任何
/// 控制了那台服务器或 CDN 的人 —— 他连哈希一起换掉就行。写死的坏处是换
/// 运行时要改代码,但运行时本来就极少变。
///
/// 没有对应条目的平台**不下载**,直接告诉用户自己构建 —— 宁可不能用,
/// 也不能不校验就解压执行一个 180MB 的 tar。
fn runtime_asset() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(("python-runtime-aarch64-apple-darwin.tar.gz", "b2c7611af35cc003158b96ba2cbe382d9bb3b16bc34ed1e36872e9ba880ca097")),
        ("macos", "x86_64") => Some(("python-runtime-x86_64-apple-darwin.tar.gz", "6e98e22f3a1374716c827bd5c2692ee4573a18ceca0cc326594dd39b90c01001")),
        ("windows", "x86_64") => Some(("python-runtime-x86_64-pc-windows-msvc.tar.gz", "ed9c0139dcafc09762e70bea4ebbb32a90c68f093c5954b52dca72a52e919bb5")),
        _ => None,
    }
}

fn bundled_tar(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let p = dir.join("binaries/python-runtime.tar.gz");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// The installed runtime matches the version this build expects.
pub(super) fn runtime_ready() -> bool {
    if !python_bin().exists() {
        return false;
    }
    match std::fs::read_to_string(python_dir().join("RUNTIME_VERSION")) {
        Ok(v) => v.trim() == RUNTIME_VERSION,
        Err(_) => false,
    }
}

#[derive(Serialize)]
pub struct PyStatus {
    installed: bool,
    extracting: bool,
    bundled: bool,
    /// 没内置时,这个平台能不能下载(有资产名且哈希已配置)。
    downloadable: bool,
    /// 0-100,仅下载阶段有意义;解压阶段看 extracting。
    progress: u8,
    version: String,
    python: Option<String>,
    workspace: String,
    error: Option<String>,
}

fn make_status(app: &tauri::AppHandle, rt: &PyRuntime) -> PyStatus {
    PyStatus {
        installed: runtime_ready(),
        extracting: *rt.extracting.lock().unwrap(),
        bundled: bundled_tar(app).is_some(),
        downloadable: runtime_asset().is_some_and(|(_, sha)| !sha.is_empty()),
        progress: rt.progress.lock().unwrap().unwrap_or(0),
        version: RUNTIME_VERSION.to_string(),
        python: runtime_ready().then(|| python_bin().to_string_lossy().into_owned()),
        workspace: workspace_dir().to_string_lossy().into_owned(),
        error: rt.error.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub fn python_status(app: tauri::AppHandle, rt: tauri::State<'_, PyRuntime>) -> PyStatus {
    make_status(&app, &rt)
}

/// Extract the bundled runtime if it isn't installed yet. Returns immediately;
/// extraction runs on a thread. Poll `python_status` for `installed`.
#[tauri::command]
pub fn python_ensure(app: tauri::AppHandle, rt: tauri::State<'_, PyRuntime>) -> PyStatus {
    if runtime_ready() || *rt.extracting.lock().unwrap() {
        return make_status(&app, &rt);
    }
    // 没内置就直接返回状态 —— 前端据此显示「一键安装」按钮,由用户决定要不要
    // 下 180MB。以前这里塞一条错误,进面板就红一片,而用户什么都没做错。
    let tar = match bundled_tar(&app) {
        Some(t) => t,
        None => return make_status(&app, &rt),
    };

    *rt.extracting.lock().unwrap() = true;
    *rt.error.lock().unwrap() = None;
    let extracting = rt.extracting.clone();
    let error = rt.error.clone();
    let app2 = app.clone();

    std::thread::spawn(move || {
        let result = extract_runtime(&tar);
        if let Err(e) = &result {
            *error.lock().unwrap() = Some(e.clone());
        }
        *extracting.lock().unwrap() = false;
        // nudge the UI to re-read status
        let _ = app2.emit("python://ready", runtime_ready());
    });

    make_status(&app, &rt)
}


/// 下载并安装运行时。内置就用内置的,否则按平台从固定 Release tag 下载,
/// **校验 SHA256 之后**才解压。立刻返回,进度轮询 `python_status`。
#[tauri::command]
pub fn python_install(app: tauri::AppHandle, rt: tauri::State<'_, PyRuntime>) -> PyStatus {
    if runtime_ready() || *rt.extracting.lock().unwrap() || rt.progress.lock().unwrap().is_some() {
        return make_status(&app, &rt);
    }
    if bundled_tar(&app).is_some() {
        return python_ensure(app, rt);
    }
    let (asset, sha) = match runtime_asset() {
        Some(a) => a,
        None => {
            *rt.error.lock().unwrap() =
                Some(format!("这个平台({} {})没有预建的 Python 运行时,请自行用 scripts/bundle-python.sh 构建。",
                    std::env::consts::OS, std::env::consts::ARCH));
            return make_status(&app, &rt);
        }
    };
    if sha.is_empty() {
        *rt.error.lock().unwrap() =
            Some("这个平台的运行时校验和尚未配置,拒绝下载 —— 不校验就解压执行等于把机器交给下载源。请自行用 scripts/bundle-python.sh 构建。".into());
        return make_status(&app, &rt);
    }

    *rt.progress.lock().unwrap() = Some(0);
    *rt.error.lock().unwrap() = None;
    let (progress, extracting, error) = (rt.progress.clone(), rt.extracting.clone(), rt.error.clone());
    let app2 = app.clone();
    let url = format!("{RUNTIME_BASE}/{RUNTIME_TAG}/{asset}");

    std::thread::spawn(move || {
        let result = download_and_extract(&url, sha, &progress, &extracting);
        if let Err(e) = &result {
            *error.lock().unwrap() = Some(e.clone());
        }
        *progress.lock().unwrap() = None;
        *extracting.lock().unwrap() = false;
        let _ = app2.emit("python://ready", runtime_ready());
    });

    make_status(&app, &rt)
}

fn download_and_extract(
    url: &str,
    expect_sha: &str,
    progress: &Arc<Mutex<Option<u8>>>,
    extracting: &Arc<Mutex<bool>>,
) -> Result<(), String> {
    use std::io::Read;
    let mut resp = download_client()?.get(url).send().map_err(|e| format!("下载失败:{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败:HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    let tmp = runtime_root().join("python-runtime.download");
    std::fs::create_dir_all(runtime_root()).map_err(|e| format!("建目录失败:{e}"))?;
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("写临时文件失败:{e}"))?;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = resp.read(&mut buf).map_err(|e| format!("下载中断:{e}"))?;
        if n == 0 { break; }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("写盘失败:{e}"))?;
        sha2::Digest::update(&mut hasher, &buf[..n]);
        done += n as u64;
        if total > 0 {
            *progress.lock().unwrap() = Some(((done * 100 / total) as u8).min(100));
        }
    }
    drop(file);

    let got = format!("{:x}", sha2::Digest::finalize(hasher));
    if let Err(e) = check_sha256(&got, expect_sha) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    *extracting.lock().unwrap() = true;
    let r = extract_runtime(&tmp);
    let _ = std::fs::remove_file(&tmp);
    r
}

/// 下载运行时用的客户端。
///
/// 不能用 `reqwest::blocking::get`:阻塞客户端默认**总时限 30 秒,连读响应体也算在内** ——
/// 180MB 的运行时要 30 秒内下完得 6MB/s 以上,国内从 GitHub 下基本做不到,一键安装必然超时。
/// 阻塞客户端没有「多久没收到数据」这种超时,所以总时限放宽到 60 分钟(50KB/s 也能下完),
/// 真卡死了也不会永远挂着;连不上 20 秒就报错。
fn download_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(DOWNLOAD_TOTAL_TIMEOUT)
        .build()
        .map_err(|e| format!("下载失败:{e}"))
}
const DOWNLOAD_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// 下载完的实际哈希 vs 源码里写死的期望值。抽出来是为了能单测 ——
/// 「校验通过」这种事最怕写了个永远不会失败的检查。
fn check_sha256(got: &str, expect: &str) -> Result<(), String> {
    if expect.is_empty() {
        return Err("没有配置校验和,拒绝安装".into());
    }
    if !got.eq_ignore_ascii_case(expect) {
        return Err(format!("校验和不符,已丢弃。期望 {expect},实际 {got}"));
    }
    Ok(())
}

fn extract_runtime(tar: &Path) -> Result<(), String> {
    let root = runtime_root();
    // fresh extract: drop any stale/partial runtime first
    let _ = std::fs::remove_dir_all(python_dir());
    std::fs::create_dir_all(&root).map_err(|e| format!("建目录失败:{e}"))?;
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(tar)
        .arg("-C")
        .arg(&root)
        .status()
        .map_err(|e| format!("解压失败:{e}"))?;
    if !status.success() {
        return Err("解压 Python 运行时失败".into());
    }
    if !python_bin().exists() {
        return Err("解压后未找到 python 可执行文件".into());
    }
    Ok(())
}

#[cfg(test)]
mod runtime_download_tests {
    use super::*;

    /* 运行时是从网上下的一个 180MB tar,解开就直接执行。校验和是这条路上
       唯一的防线,所以这里要确认它真的能**拒绝**,而不是写了个永远返回 Ok
       的检查。 */
    #[test]
    fn checksum_rejects_a_mismatch_and_a_missing_expectation() {
        let good = "b2c7611af35cc003158b96ba2cbe382d9bb3b16bc34ed1e36872e9ba880ca097";
        assert!(check_sha256(good, good).is_ok(), "一致时必须放行");
        assert!(check_sha256(&good.to_uppercase(), good).is_ok(), "大小写不该影响");

        let tampered = format!("0{}", &good[1..]);
        let err = check_sha256(&tampered, good).unwrap_err();
        assert!(err.contains("校验和不符"), "改一位就必须拒绝,实际:{err}");

        // 没配置期望值时绝不能"因为没东西可比"就放过去
        let err = check_sha256(good, "").unwrap_err();
        assert!(err.contains("拒绝安装"), "没有期望值必须拒绝,实际:{err}");
    }

    /* 每个平台要么有哈希,要么没有条目 —— 不能出现"有资产名但哈希是空串",
       那样 downloadable 会是 false,按钮消失,而原因没人看得出来。 */
    #[test]
    fn every_listed_platform_has_a_pinned_hash() {
        if let Some((asset, sha)) = runtime_asset() {
            assert_eq!(sha.len(), 64, "{asset} 的哈希长度不对:{sha:?}");
            assert!(sha.chars().all(|c| c.is_ascii_hexdigit()), "{asset} 的哈希不是十六进制");
        }
    }
}

#[cfg(test)]
mod download_timeout_tests {
    /// 本地起一个慢服务器:35 秒才把响应体发完(比阻塞客户端默认的 30 秒总时限长)。
    /// 旧写法 `reqwest::blocking::get` 在这里会超时失败;下载运行时用的客户端必须能下完。
    #[test]
    #[ignore = "慢:要 35 秒以上"]
    fn runtime_download_survives_a_body_slower_than_30_seconds() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/runtime.tar.gz", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut s = stream.unwrap();
                let mut req = [0u8; 1024];
                let _ = s.read(&mut req);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n");
                for _ in 0..8 {
                    std::thread::sleep(std::time::Duration::from_millis(4400));
                    if s.write_all(b"x").is_err() { break; }
                }
            }
        });
        let old = std::thread::spawn({ let url = url.clone(); move || reqwest::blocking::get(&url).and_then(|r| r.bytes()).map(|b| b.len()) });
        let mut resp = super::download_client().unwrap().get(&url).send().unwrap();
        let mut body = Vec::new();
        resp.read_to_end(&mut body).expect("新客户端应能下完");
        assert_eq!(body.len(), 8);
        assert!(old.join().unwrap().is_err(), "旧写法应该在 30 秒时被掐断(证明这个测试真的测到了总时限)");
    }
}
