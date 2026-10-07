//! 监控中心:在主窗口里嵌真正的浏览器视图(子 webview)。
//!
//! 为什么不用 iframe:很多页面(包括自建的运行台)会发 `X-Frame-Options: DENY` /
//! `frame-ancestors 'none'`,iframe 里只剩一片空白;就算对方放开,WKWebView 默认挡
//! 第三方 Cookie,需要登录的页面在 iframe 里登不上。子 webview 是一个独立的浏览器
//! 视图,不受这两条限制,用起来和在浏览器里打开没有区别。
//!
//! 安全:子 webview 加载的是远程页面。Tauri 的权限(capabilities)默认只给本地
//! 应用页面,远程来源调不到任何命令 —— 嵌进来的网页碰不到连接、口令和本地文件。
//!
//! 坐标:前端量好占位框(CSS 像素 = 逻辑像素),这里按逻辑像素摆放。
//! 命令都是 async 的:add_child 要回主线程建视图,同步命令本身就跑在主线程上,会死锁。

use serde::Deserialize;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

const PREFIX: &str = "monitor-";

#[derive(Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn label_for(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("监控页编号无效".into());
    }
    Ok(format!("{PREFIX}{id}"))
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

fn clamp(b: &Bounds) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (
        LogicalPosition::new(b.x.max(0.0), b.y.max(0.0)),
        LogicalSize::new(b.width.max(1.0), b.height.max(1.0)),
    )
}

/// 显示某个监控页:没有就建,有就挪到位置上再显示;地址变了就跳过去。
/// 同一时间只显示一个,其余的藏起来(不关 —— 登录状态、滚动位置都留着)。
#[tauri::command]
pub async fn monitor_show(app: tauri::AppHandle, id: String, url: String, bounds: Bounds) -> Result<(), String> {
    let label = label_for(&id)?;
    let target = page_url(&url)?;
    let (pos, size) = clamp(&bounds);
    for (other, view) in app.webviews() {
        if other.starts_with(PREFIX) && other != label {
            let _ = view.hide();
        }
    }
    if let Some(view) = app.get_webview(&label) {
        view.set_position(pos).map_err(|e| e.to_string())?;
        view.set_size(size).map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("找不到主窗口")?;
    window
        .add_child(WebviewBuilder::new(&label, WebviewUrl::External(target)), pos, size)
        .map_err(|e| format!("打开监控页失败:{e}"))?;
    Ok(())
}

/// 占位框挪了 / 变了大小(窗口缩放、浮层动画)时跟着走。
#[tauri::command]
pub async fn monitor_bounds(app: tauri::AppHandle, id: String, bounds: Bounds) -> Result<(), String> {
    let label = label_for(&id)?;
    if let Some(view) = app.get_webview(&label) {
        let (pos, size) = clamp(&bounds);
        view.set_position(pos).map_err(|e| e.to_string())?;
        view.set_size(size).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 藏起所有监控页(切走、关掉数据资产、弹确认框时)。
#[tauri::command]
pub async fn monitor_hide_all(app: tauri::AppHandle) -> Result<(), String> {
    for (label, view) in app.webviews() {
        if label.starts_with(PREFIX) {
            let _ = view.hide();
        }
    }
    Ok(())
}

/// 删掉某个监控页的视图(删除这一项、或改了地址要重开)。
#[tauri::command]
pub async fn monitor_close(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let label = label_for(&id)?;
    if let Some(view) = app.get_webview(&label) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 后退 / 前进 / 刷新 / 回到首页。
#[tauri::command]
pub async fn monitor_nav(app: tauri::AppHandle, id: String, action: String, home: Option<String>) -> Result<(), String> {
    let label = label_for(&id)?;
    let view = app.get_webview(&label).ok_or("这个页面还没打开")?;
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.eval("location.reload()"),
        "home" => view.navigate(page_url(home.as_deref().unwrap_or(""))?),
        _ => return Err("不支持的操作".into()),
    }
    .map_err(|e| e.to_string())
}

/// 当前页面地址(用户在页面里点来点去之后,工具栏显示的地址跟着变)。
#[tauri::command]
pub async fn monitor_current_url(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    let label = label_for(&id)?;
    Ok(app.get_webview(&label).and_then(|v| v.url().ok()).map(|u| u.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{label_for, page_url};

    #[test]
    fn only_plain_http_pages_are_accepted() {
        assert!(page_url("http://192.0.2.10:18086").is_ok());
        assert!(page_url("https://example.com/dashboard?x=1").is_ok());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost", "http://user:pw@192.0.2.10", "ftp://x", "not a url"] {
            assert!(page_url(bad).is_err(), "{bad} 应该被拒");
        }
    }

    #[test]
    fn labels_cannot_escape_the_monitor_namespace() {
        assert_eq!(label_for("abc_1-2").unwrap(), "monitor-abc_1-2");
        for bad in ["", "main", "../x", "a b", "a/b"] {
            if bad == "main" { assert_eq!(label_for(bad).unwrap(), "monitor-main"); continue; }
            assert!(label_for(bad).is_err(), "{bad} 应该被拒");
        }
    }
}
