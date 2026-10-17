//! 链路画布单独开一个系统窗口:能和主窗口(数据库)并排摆着看。
//!
//! 窗口加载的是应用自己的页面(index.html),页面脚本跑之前注入 `window.__SONDE_VIEW__ = "canvas"`,
//! 页面据此只渲染画布(不用 `?view=` 查询参数:App 路径里的问号可能被当成文件名转义掉)。和主窗口同源,共用一份本地存储,
//! 画布数据还是同一份。不用「主窗口里再嵌一层 webview」那条路 —— 它会让 ⌘V / ⌘C / ⌘S 失灵(见 monitor.rs)。
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const CANVAS_LABEL: &str = "lineage-canvas";

/// 已经开着就拉到前面来,一个应用只开一个画布窗口(两个窗口同时改同一份画布会互相覆盖)
#[tauri::command]
pub async fn open_canvas_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(CANVAS_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, CANVAS_LABEL, WebviewUrl::App("index.html".into()))
        .initialization_script("window.__SONDE_VIEW__ = 'canvas';")
        .title("链路画布 · DB Sonde")
        .inner_size(1360.0, 860.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| format!("打开画布窗口失败:{e}"))?;
    Ok(())
}
