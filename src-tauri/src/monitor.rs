//! 监控中心:把监控网页嵌进来(iframe),嵌不进来的开成软件里的独立窗口。
//!
//! 曾经用过「主窗口里再嵌一个原生浏览器视图」(Tauri 的 unstable 多 webview)。它让
//! 主界面本身也变成了子视图,macOS 上 ⌘V / ⌘C / ⌘Z / ⌘S 这类组合键就到不了页面里的 JS
//! (wry 只在单 webview 下修过这个),表格粘贴、编辑器保存全都失灵。所以退回单 webview:
//!   · 页面允许被嵌入 → 前端直接 iframe;
//!   · 页面禁止被嵌入(X-Frame-Options / CSP frame-ancestors)→ 开一个独立窗口,
//!     那是一个完整的浏览器窗口,功能一样都不少。
//! 远程页面在 iframe 和独立窗口里都拿不到应用命令(权限只给本地页面)。

use serde::Serialize;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn window_label(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("监控页编号无效".into());
    }
    Ok(format!("monitor-win-{id}"))
}

/// 只认 http/https,不许把账号密码写在地址里(会明文留在配置和历史里)。
pub fn page_url(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw.trim()).map_err(|_| "请输入完整网址,例如 http://192.0.2.10:8080".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("只支持 http / https 网页".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("不要把账号密码写在网址里,打开页面后在页面上登录".into());
    }
    Ok(url)
}

const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Embeddability {
    embeddable: bool,
    reason: Option<String>,
}

/// 按响应头判断这个页面准不准被嵌入。只看 X-Frame-Options 和 CSP 的 frame-ancestors:
/// 浏览器就是按这两个决定 iframe 显示还是一片空白。
pub fn judge_headers(x_frame: Option<&str>, csp: Option<&str>) -> Embeddability {
    if let Some(x) = x_frame.map(|v| v.trim().to_ascii_lowercase()) {
        if x == "deny" || x == "sameorigin" {
            return Embeddability { embeddable: false, reason: Some(format!("页面设置了 X-Frame-Options: {}", x.to_uppercase())) };
        }
    }
    if let Some(policy) = csp {
        for directive in policy.split(';') {
            let mut parts = directive.split_whitespace();
            if parts.next().is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors")) {
                let sources: Vec<String> = parts.map(|s| s.to_ascii_lowercase()).collect();
                let allows_app = sources.iter().any(|s| s == "*" || s == "tauri:" || s.starts_with("tauri://") || s.contains("tauri.localhost"));
                if !allows_app {
                    return Embeddability { embeddable: false, reason: Some(format!("页面的 frame-ancestors 只允许 {}", if sources.is_empty() { "'none'".into() } else { sources.join(" ") })) };
                }
            }
        }
    }
    Embeddability { embeddable: true, reason: None }
}

/// 打开前先看一眼对方允不允许被嵌入,不允许就让界面直接给「在独立窗口打开」,
/// 而不是嵌出一片空白让人以为坏了。连不上时按「可以嵌」处理,由 iframe 自己显示错误。
#[tauri::command]
pub async fn monitor_probe(url: String) -> Result<Embeddability, String> {
    let target = page_url(&url)?;
    // 带上浏览器的 User-Agent:有些站对「不像浏览器」的请求直接回 403、不带这些头,会被误判成能嵌
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(target).header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,*/*;q=0.8").send().await {
        Ok(resp) => {
            let header = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
            Ok(judge_headers(header("x-frame-options").as_deref(), header("content-security-policy").as_deref()))
        }
        Err(_) => Ok(Embeddability { embeddable: true, reason: None }),
    }
}

/// 在软件里开一个独立窗口打开这个页面;已经开着就把它拿到前面。
#[tauri::command]
pub async fn monitor_open_window(app: tauri::AppHandle, id: String, url: String, title: String) -> Result<(), String> {
    let label = window_label(&id)?;
    let target = page_url(&url)?;
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target))
        .title(format!("{title} · DB Sonde 监控中心"))
        .inner_size(1280.0, 820.0)
        .min_inner_size(640.0, 420.0)
        .build()
        .map_err(|e| format!("打开窗口失败:{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{judge_headers, page_url, window_label};

    #[test]
    fn only_plain_http_pages_are_accepted() {
        assert!(page_url("http://192.0.2.10:18086").is_ok());
        assert!(page_url("https://example.com/dashboard?x=1").is_ok());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost", "http://user:pw@192.0.2.10", "ftp://x", "not a url"] {
            assert!(page_url(bad).is_err(), "{bad} 应该被拒");
        }
    }

    #[test]
    fn window_labels_cannot_escape_the_monitor_namespace() {
        assert_eq!(window_label("abc_1-2").unwrap(), "monitor-win-abc_1-2");
        for bad in ["", "../x", "a b", "a/b"] {
            assert!(window_label(bad).is_err(), "{bad} 应该被拒");
        }
    }

    #[test]
    fn embedding_is_judged_like_a_browser_would() {
        assert!(judge_headers(None, None).embeddable);
        assert!(!judge_headers(Some("DENY"), None).embeddable);
        assert!(!judge_headers(Some("sameorigin"), None).embeddable);
        assert!(!judge_headers(None, Some("default-src 'self'; frame-ancestors 'none'")).embeddable);
        assert!(!judge_headers(None, Some("frame-ancestors 'self' https://a.example")).embeddable);
        assert!(judge_headers(None, Some("default-src 'self'; frame-ancestors 'self' tauri://localhost http://tauri.localhost")).embeddable);
        assert!(judge_headers(None, Some("frame-ancestors *")).embeddable);
        assert!(judge_headers(None, Some("default-src 'self'")).embeddable, "没写 frame-ancestors 就不限制");
    }
}
