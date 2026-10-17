use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct ExitGuard {
    ready: AtomicBool,
    approved: AtomicBool,
}
#[tauri::command]
pub fn enable_workspace_exit_guard(state: tauri::State<'_, ExitGuard>) {
    state.ready.store(true, Ordering::SeqCst);
}
#[tauri::command]
pub fn finish_workspace_exit(app: AppHandle, state: tauri::State<'_, ExitGuard>) {
    state.approved.store(true, Ordering::SeqCst);
    app.exit(0);
}
/// 关这个窗口是不是等于退出应用。只有主窗口是 —— 链路画布、监控中心开的独立窗口关掉就只关它自己,
/// 以前它们也被当成退出,点一下红色关闭按钮整个应用就没了。
pub fn closing_exits_app(label: &str) -> bool {
    label == "main"
}
pub fn should_intercept(app: &AppHandle) -> bool {
    let guard = app.state::<ExitGuard>();
    guard.should_intercept()
}
pub fn request_exit(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("workspace-exit-requested", ());
}

impl ExitGuard {
    fn should_intercept(&self) -> bool {
        self.ready.load(Ordering::SeqCst) && !self.approved.load(Ordering::SeqCst)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_main_window_closes_the_app() {
        assert!(closing_exits_app("main"));
        assert!(!closing_exits_app(crate::canvas_window::CANVAS_LABEL));
        assert!(!closing_exits_app("monitor-win-abc"));
    }
    #[test]
    fn exit_requires_frontend_approval_after_guard_is_ready() {
        let guard = ExitGuard::default();
        assert!(!guard.should_intercept());
        guard.ready.store(true, Ordering::SeqCst);
        assert!(guard.should_intercept());
        // Canceling the dialog does not approve subsequent exit requests.
        assert!(guard.should_intercept());
        guard.approved.store(true, Ordering::SeqCst);
        assert!(!guard.should_intercept());
    }
}
