//! macOS 菜单栏(中文)。结构和 Tauri 默认菜单一样,只有「编辑」菜单里的「全选」换成了我们自己的,
//! 外加「查找 / 查找并替换 / 查找下一个 / 查找上一个」。
//!
//! 为什么要换「全选」:系统自带的「全选 ⌘A」在页面里没有输入框获得焦点时会先把按键吃掉,
//! 做浏览器原生的全选 —— 把界面上看得见的字选成一片(编辑器只渲染屏幕上那几十行,于是看起来像
//! 「只选中了屏幕上能看到的部分」),页面里的 ⌘A 处理(编辑器全选、画布全选)根本收不到。
//! 换成自己的菜单项后,按下时把动作交回页面(`menu://edit`),由页面决定作用在谁身上。
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const EDIT_EVENT: &str = "menu://edit";

/// (菜单项 id, 文字, 快捷键)。id 也是发给页面的内容。
const EDIT_ITEMS: [(&str, &str, &str); 5] = [
    ("edit.select_all", "全选", "CmdOrCtrl+A"),
    ("edit.find", "查找…", "CmdOrCtrl+F"),
    ("edit.replace", "查找并替换…", "CmdOrCtrl+Alt+F"),
    ("edit.find_next", "查找下一个", "CmdOrCtrl+G"),
    ("edit.find_prev", "查找上一个", "CmdOrCtrl+Shift+G"),
];

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let name = info.name.clone();
    let about = AboutMetadata { name: Some(name.clone()), version: Some(info.version.to_string()), ..Default::default() };
    let custom = |i: usize| {
        let (id, text, accel) = EDIT_ITEMS[i];
        MenuItem::with_id(app, id, text, true, Some(accel))
    };
    let app_menu = Submenu::with_items(app, &name, true, &[
        &PredefinedMenuItem::about(app, Some(&format!("关于 {name}")), Some(about))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::services(app, Some("服务"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, Some(&format!("隐藏 {name}")))?,
        &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, Some(&format!("退出 {name}")))?,
    ])?;
    let file_menu = Submenu::with_items(app, "文件", true, &[&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?])?;
    let edit_menu = Submenu::with_items(app, "编辑", true, &[
        &PredefinedMenuItem::undo(app, Some("撤销"))?,
        &PredefinedMenuItem::redo(app, Some("重做"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, Some("剪切"))?,
        &PredefinedMenuItem::copy(app, Some("拷贝"))?,
        &PredefinedMenuItem::paste(app, Some("粘贴"))?,
        &custom(0)?,
        &PredefinedMenuItem::separator(app)?,
        &custom(1)?,
        &custom(2)?,
        &custom(3)?,
        &custom(4)?,
    ])?;
    let view_menu = Submenu::with_items(app, "显示", true, &[&PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?])?;
    let window_menu = Submenu::with_items(app, "窗口", true, &[
        &PredefinedMenuItem::minimize(app, Some("最小化"))?,
        &PredefinedMenuItem::maximize(app, Some("缩放"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::close_window(app, Some("关闭"))?,
    ])?;
    let help_menu = Submenu::with_items(app, "帮助", true, &[])?;
    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
}

/// 菜单项被点(或按了快捷键)。主窗口:交给页面处理;监控中心开的外部网页窗口里没有我们的页面代码,
/// 「全选」就让那个网页自己全选。
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if !EDIT_ITEMS.iter().any(|(item, _, _)| *item == id) {
        return;
    }
    let focused = app.webview_windows().into_iter().find(|(_, w)| w.is_focused().unwrap_or(false));
    match focused {
        Some((label, window)) if label != "main" => {
            if id == "edit.select_all" {
                let _ = window.eval("document.execCommand('selectAll')");
            }
        }
        _ => {
            let _ = app.emit_to("main", EDIT_EVENT, id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::EDIT_ITEMS;

    #[test]
    fn edit_items_are_unique_and_namespaced() {
        let ids: std::collections::HashSet<_> = EDIT_ITEMS.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(ids.len(), EDIT_ITEMS.len());
        assert!(EDIT_ITEMS.iter().all(|(id, _, accel)| id.starts_with("edit.") && accel.starts_with("CmdOrCtrl+")));
    }
}
