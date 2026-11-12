//! 带权限的窗口不许离开应用自己的页面。
//!
//! 窗口是 `tauri.conf.json` 里声明的,没有单独的 `WebviewWindowBuilder`,所以用插件的
//! `on_navigation`(和 builder 上那个回调是同一条 wry 钩子)。返回 false 就取消这次导航。
//! 用户点开的远程 http(s) 交给已经在用的 opener 插件,用系统浏览器打开,并且一秒最多一次。
//!
//! 权限清单里的窗口(现在是主窗口和链路画布)都走这套判断。监控中心的独立窗口
//! (`monitor-win-*`)本身就是远程网页,顶层可以继续在窗口里浏览 http(s),但不能打开
//! 应用自己的页面或 `file:` / `javascript:` 这类地址。
//!
//! 监控中心嵌在主窗口里的页面是 iframe,不是主框架跳转。Windows 的 `NavigationStarting`
//! 本来就只报主框架。macOS 的 `decidePolicyForNavigationAction` 主框架和 iframe 都会进
//! 这个钩子,而且回调里只有 URL —— 所以在 macOS 上改 wry 的策略方法:子框架只放行
//! http(s)(排除应用、ipc、asset 这些主机)和 `about:blank` / `about:srcdoc`。
//! Linux 上 WebKitGTK 同样分不清(发行说明里 Linux 也还没做验证),iframe 导航会被当成
//! 主窗口跳转取消;真要在 Linux 上嵌监控页,得等 wry 把 frame 信息传出来。

use std::cell::Cell;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Runtime, Url, Webview};
use tauri_plugin_opener::OpenerExt;

/// 跟 `tauri.conf.json` 的 `build.devUrl` / Vite 端口一致。只在 debug 构建里放行。
const DEV_SERVER_PORT: u16 = 1420;
/// 页面脚本可以连着改地址。系统浏览器一秒最多弹一次,其余的直接丢掉。
const EXTERNAL_OPEN_GAP: Duration = Duration::from_secs(1);

// wry 的导航回调只有 URL,点没点过链接只有 macOS 的策略方法能看见。
// `None` 表示这个平台看不出来,仍按「可能是用户」处理,靠上面的节流挡连发。
thread_local! {
    static USER_GESTURE: Cell<Option<bool>> = Cell::new(None);
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn set_user_gesture(value: Option<bool>) {
    USER_GESTURE.with(|slot| slot.set(value));
}

fn take_user_gesture() -> Option<bool> {
    USER_GESTURE.with(|slot| slot.replace(None))
}

fn external_open_slot() -> &'static Mutex<Option<Instant>> {
    static SLOT: Mutex<Option<Instant>> = Mutex::new(None);
    &SLOT
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavigationDecision {
    Allow,
    /// 远程 http(s):取消 webview 导航,改用系统浏览器打开。
    OpenExternal,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavigationEffect {
    Allow,
    OpenExternal,
    Cancel,
}

/// 除了监控独立窗口,别的窗口都有可能带 Tauri 权限(能力清单现在给了 main 和
/// lineage-canvas,以后新加的窗口默认也守)。
fn applies_app_navigation_guard(label: &str) -> bool {
    !label.starts_with("monitor-win-")
}

fn decide_navigation(url: &Url, allow_dev_server: bool) -> NavigationDecision {
    if is_app_navigation(url, allow_dev_server) {
        NavigationDecision::Allow
    } else if is_remote_http(url) {
        NavigationDecision::OpenExternal
    } else {
        NavigationDecision::Deny
    }
}

fn is_app_navigation(url: &Url, allow_dev_server: bool) -> bool {
    match url.scheme() {
        // macOS / Linux 上应用页面是 tauri://localhost。别的 host 不是本应用。
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => is_tauri_localhost(url) || (allow_dev_server && is_dev_server(url)),
        // 导出用 `<a download href="blob:...">`。blob 是页面自己造的,不是远程源。
        // about:blank / about:srcdoc 是 webview 和 iframe 的空文档,不是远程页面。
        "blob" => true,
        "about" => is_about_document(url),
        _ => false,
    }
}

/// Windows(以及打开了 https 自定义协议时)的应用源是 http(s)://tauri.localhost,不带端口。
fn is_tauri_localhost(url: &Url) -> bool {
    url.host_str() == Some("tauri.localhost") && url.port().is_none()
}

fn is_dev_server(url: &Url) -> bool {
    url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
        && url.port() == Some(DEV_SERVER_PORT)
}

/// 应用页面、Tauri IPC、asset 协议用的主机。iframe 和监控窗口都不能打开它们。
fn is_internal_http_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("tauri.localhost" | "ipc.localhost" | "asset.localhost")
    )
}

fn is_about_document(url: &Url) -> bool {
    url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc")
}

/// 真正的远程网页。应用 / ipc / asset 主机不是该拿去浏览器打开的链接。
fn is_remote_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && !is_internal_http_host(url)
}

/// 子框架只许普通网页和空文档。`tauri:`、`file:`、`javascript:`、`data:`、
/// 应用自己的源(含开发服务器)一律拒绝,避免 iframe 把带权限的页面再加载一遍。
fn subframe_navigation_allowed(url: &Url) -> bool {
    if is_about_document(url) {
        return true;
    }
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && !is_internal_http_host(url)
        && !is_dev_server(url)
}

/// 监控独立窗口要在里面浏览远程网页,所以 http(s) 留在窗口里。
/// blob 是页面自己造的下载/预览,about 是空文档。其余和子框架一样拒绝。
fn monitor_navigation_allowed(url: &Url) -> bool {
    url.scheme() == "blob" || subframe_navigation_allowed(url)
}

/// `WKNavigationType` 里算用户操作的:点链接、提交表单、重新提交表单。
/// 脚本改 `location`、`window.open`、重定向是 Other(-1),后退和刷新也不该弹出浏览器。
fn navigation_type_is_user_gesture(kind: isize) -> bool {
    matches!(kind, 0 | 1 | 4)
}

/// 脚本触发的跳转不打开浏览器。看不出是不是用户时照常打开,但一秒只开一次。
fn handoff_to_browser(
    user_gesture: Option<bool>,
    now: Instant,
    last: &mut Option<Instant>,
) -> bool {
    if user_gesture == Some(false) {
        return false;
    }
    let recent = last.is_some_and(|prev| now.saturating_duration_since(prev) < EXTERNAL_OPEN_GAP);
    if recent {
        return false;
    }
    *last = Some(now);
    true
}

fn judge(
    label: &str,
    url: &Url,
    allow_dev_server: bool,
    user_gesture: Option<bool>,
    now: Instant,
    last_external_open: &mut Option<Instant>,
) -> NavigationEffect {
    if !applies_app_navigation_guard(label) {
        return if monitor_navigation_allowed(url) {
            NavigationEffect::Allow
        } else {
            NavigationEffect::Cancel
        };
    }
    match decide_navigation(url, allow_dev_server) {
        NavigationDecision::Allow => NavigationEffect::Allow,
        NavigationDecision::Deny => NavigationEffect::Cancel,
        NavigationDecision::OpenExternal => {
            if handoff_to_browser(user_gesture, now, last_external_open) {
                NavigationEffect::OpenExternal
            } else {
                NavigationEffect::Cancel
            }
        }
    }
}

fn on_navigation<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    let gesture = take_user_gesture();
    let effect = {
        let mut last = external_open_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        judge(
            webview.label(),
            url,
            cfg!(debug_assertions),
            gesture,
            Instant::now(),
            &mut last,
        )
    };
    match effect {
        NavigationEffect::Allow => true,
        NavigationEffect::OpenExternal => {
            let _ = webview.opener().open_url(url.as_str(), None::<&str>);
            false
        }
        NavigationEffect::Cancel => false,
    }
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("sonde-navigation")
        .on_navigation(on_navigation)
        .on_webview_ready(|_webview| {
            install_platform_hooks();
        })
        .build()
}

fn install_platform_hooks() {
    #[cfg(target_os = "macos")]
    macos::install_subframe_filter();
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::sel;
    use std::ffi::{c_char, c_void};
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

    use super::{navigation_type_is_user_gesture, set_user_gesture, subframe_navigation_allowed};

    /// `WKNavigationActionPolicyAllow` / `Cancel`.
    const ALLOW: isize = 1;
    const CANCEL: isize = 0;

    type Decide = unsafe extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut AnyObject,
        *mut c_void,
    );

    /// Apple block:isa、flags、reserved,然后是 invoke。64 位上 flags 后面正好对齐到函数指针。
    #[repr(C)]
    struct DecisionBlock {
        _isa: *const c_void,
        _flags: i32,
        _reserved: i32,
        invoke: unsafe extern "C-unwind" fn(*mut DecisionBlock, isize),
    }

    static INSTALLED: AtomicBool = AtomicBool::new(false);
    static ORIGINAL: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    pub fn install_subframe_filter() {
        if INSTALLED.load(Ordering::Acquire) {
            return;
        }
        let Some(class) = delegate_class() else {
            eprintln!("DB Sonde: 找不到 WryNavigationDelegate,子框架导航无法单独判断");
            return;
        };
        let Some(method) =
            class.instance_method(sel!(webView:decidePolicyForNavigationAction:decisionHandler:))
        else {
            eprintln!("DB Sonde: WryNavigationDelegate 没有导航策略方法,子框架导航无法单独判断");
            return;
        };
        if INSTALLED.swap(true, Ordering::AcqRel) {
            return;
        }
        let previous = method.implementation();
        ORIGINAL.store(previous as *const () as *mut c_void, Ordering::Release);
        unsafe {
            let hooked: Imp = std::mem::transmute(hooked as Decide);
            method.set_implementation(hooked);
        }
    }

    /// wry 用 `define_class!` 且没写死类名,运行时的名字是
    /// `wry::wkwebview::class::wry_navigation_delegate::WryNavigationDelegate` 再拼上版本号。
    /// 元类和类同名,只能改实例方法所在的那个类。
    fn delegate_class() -> Option<&'static AnyClass> {
        AnyClass::classes().iter().copied().find(|class| {
            !class.is_metaclass()
                && class
                    .name()
                    .to_str()
                    .is_ok_and(|name| name.contains("WryNavigationDelegate"))
        })
    }

    unsafe extern "C-unwind" fn hooked(
        this: *mut AnyObject,
        sel: Sel,
        webview: *mut AnyObject,
        action: *mut AnyObject,
        handler: *mut c_void,
    ) {
        if is_subframe(action) {
            let allowed = action_url(action).is_some_and(|url| subframe_navigation_allowed(&url));
            finish(handler, if allowed { ALLOW } else { CANCEL });
            return;
        }
        // 主框架仍走原来的回调(里面有窗口标签和节流)。手势先记下来,回调同步读走。
        set_user_gesture(Some(action_is_user_gesture(action)));
        let original = ORIGINAL.load(Ordering::Acquire);
        if !original.is_null() {
            let original: Decide = std::mem::transmute(original);
            original(this, sel, webview, action, handler);
        } else {
            finish(handler, CANCEL);
        }
        set_user_gesture(None);
    }

    /// `targetFrame == nil` 是 window.open / target=_blank,按主框架处理。
    unsafe fn is_subframe(action: *mut AnyObject) -> bool {
        if action.is_null() {
            return false;
        }
        let action = &*action;
        let frame: Option<Retained<AnyObject>> = msg_send![action, targetFrame];
        match frame {
            Some(frame) => {
                let is_main: Bool = msg_send![&*frame, isMainFrame];
                !is_main.as_bool()
            }
            None => false,
        }
    }

    unsafe fn action_is_user_gesture(action: *mut AnyObject) -> bool {
        if action.is_null() {
            return false;
        }
        let kind: isize = msg_send![&*action, navigationType];
        navigation_type_is_user_gesture(kind)
    }

    unsafe fn action_url(action: *mut AnyObject) -> Option<tauri::Url> {
        if action.is_null() {
            return None;
        }
        let action = &*action;
        let request: Option<Retained<AnyObject>> = msg_send![action, request];
        let request = request?;
        let nsurl: Option<Retained<AnyObject>> = msg_send![&*request, URL];
        let nsurl = nsurl?;
        let abs: Option<Retained<AnyObject>> = msg_send![&*nsurl, absoluteString];
        let abs = abs?;
        let ptr: *const c_char = msg_send![&*abs, UTF8String];
        if ptr.is_null() {
            return None;
        }
        let text = std::ffi::CStr::from_ptr(ptr).to_str().ok()?;
        tauri::Url::parse(text).ok()
    }

    unsafe fn finish(handler: *mut c_void, policy: isize) {
        if handler.is_null() {
            return;
        }
        let block = &*(handler as *const DecisionBlock);
        (block.invoke)(handler as *mut DecisionBlock, policy);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        applies_app_navigation_guard, decide_navigation, handoff_to_browser, judge,
        monitor_navigation_allowed, navigation_type_is_user_gesture, subframe_navigation_allowed,
        NavigationDecision, NavigationEffect, EXTERNAL_OPEN_GAP,
    };
    use std::time::Instant;
    use tauri::Url;

    fn parse(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    fn decide(raw: &str, dev: bool) -> NavigationDecision {
        decide_navigation(&parse(raw), dev)
    }

    fn effect(label: &str, raw: &str, dev: bool, gesture: Option<bool>) -> NavigationEffect {
        let mut last = None;
        judge(label, &parse(raw), dev, gesture, Instant::now(), &mut last)
    }

    #[test]
    fn app_pages_stay_in_the_main_window() {
        for raw in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "about:blank",
            "about:srcdoc",
            "blob:http://tauri.localhost/11111111-1111-1111-1111-111111111111",
        ] {
            assert_eq!(decide(raw, false), NavigationDecision::Allow, "{raw}");
        }
    }

    #[test]
    fn dev_server_is_only_allowed_while_debugging() {
        assert_eq!(
            decide("http://localhost:1420/", true),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide("http://127.0.0.1:1420/src/main.tsx", true),
            NavigationDecision::Allow
        );
        assert_eq!(
            decide("http://localhost:1420/", false),
            NavigationDecision::OpenExternal
        );
        assert_eq!(
            decide("http://localhost:1421/", true),
            NavigationDecision::OpenExternal
        );
        assert_eq!(
            decide("https://localhost:1420/", true),
            NavigationDecision::OpenExternal
        );
    }

    #[test]
    fn remote_http_pages_leave_the_webview() {
        for raw in [
            "https://example.com/docs",
            "https://api.openai.com/v1/chat/completions",
            "http://192.0.2.10:8080/grafana",
        ] {
            assert_eq!(
                decide(raw, false),
                NavigationDecision::OpenExternal,
                "{raw}"
            );
        }
    }

    #[test]
    fn non_http_and_internal_schemes_are_blocked() {
        for raw in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hello",
            "tauri://evil.example/",
            "ftp://example.com/file",
            "ipc://localhost/",
            "http://ipc.localhost/plugin%3Aevent",
            "https://ipc.localhost/",
            "http://asset.localhost/icon.png",
            "https://asset.localhost/",
            "http://tauri.localhost:8080/",
        ] {
            assert_eq!(decide(raw, false), NavigationDecision::Deny, "{raw}");
        }
    }

    #[test]
    fn capability_windows_share_the_guard_and_monitor_windows_do_not() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let windows = caps["windows"].as_array().expect("capability windows");
        assert!(windows.iter().any(|w| w == "main"));
        assert!(windows.iter().any(|w| w == "lineage-canvas"));
        for window in windows {
            let label = window.as_str().unwrap();
            assert!(
                applies_app_navigation_guard(label),
                "{label} is in the capability list"
            );
            assert_eq!(
                effect(label, "https://example.com/docs", false, Some(true)),
                NavigationEffect::OpenExternal,
                "{label}"
            );
            assert_eq!(
                effect(label, "tauri://localhost/", false, None),
                NavigationEffect::Allow,
                "{label}"
            );
            assert_eq!(
                effect(label, "file:///etc/passwd", false, Some(true)),
                NavigationEffect::Cancel,
                "{label}"
            );
        }
        assert!(!applies_app_navigation_guard("monitor-win-abc_1-2"));
        assert!(applies_app_navigation_guard("monitor-window"));
        assert!(applies_app_navigation_guard("future-tool"));
    }

    #[test]
    fn monitor_windows_browse_remote_pages_but_not_app_pages() {
        for raw in [
            "https://example.com/dashboard",
            "http://192.0.2.10:8080/grafana",
            "http://localhost:3000/",
            "about:blank",
            "about:srcdoc",
            "blob:https://example.com/11111111-1111-1111-1111-111111111111",
        ] {
            assert!(monitor_navigation_allowed(&parse(raw)), "{raw}");
            assert_eq!(
                effect("monitor-win-abc", raw, false, Some(true)),
                NavigationEffect::Allow,
                "{raw}"
            );
        }
        for raw in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://tauri.localhost:8080/",
            "http://ipc.localhost/",
            "http://asset.localhost/icon.png",
            "http://localhost:1420/",
            "http://127.0.0.1:1420/index.html",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
            "ftp://example.com/file",
        ] {
            assert!(!monitor_navigation_allowed(&parse(raw)), "{raw}");
            assert_eq!(
                effect("monitor-win-abc", raw, true, Some(true)),
                NavigationEffect::Cancel,
                "{raw}"
            );
        }
    }

    #[test]
    fn subframes_only_allow_plain_http_and_about_documents() {
        for raw in [
            "https://example.com/embed",
            "http://192.0.2.10:8080/grafana",
            "http://localhost:3000/",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(subframe_navigation_allowed(&parse(raw)), "{raw}");
        }
        for raw in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://tauri.localhost:8080/",
            "http://ipc.localhost/plugin",
            "https://ipc.localhost/",
            "http://asset.localhost/icon.png",
            "https://asset.localhost/",
            "http://localhost:1420/",
            "http://127.0.0.1:1420/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
            "blob:https://example.com/11111111-1111-1111-1111-111111111111",
            "ftp://example.com/file",
            "about:cache",
        ] {
            assert!(!subframe_navigation_allowed(&parse(raw)), "{raw}");
        }
    }

    #[test]
    fn external_opens_require_a_plausible_gesture_and_drop_bursts() {
        let start = Instant::now();
        let mut last = None;
        assert!(
            !handoff_to_browser(Some(false), start, &mut last),
            "a script navigation must not open or consume the slot"
        );
        assert!(last.is_none());
        assert!(handoff_to_browser(Some(true), start, &mut last));
        assert_eq!(
            judge(
                "lineage-canvas",
                &parse("https://example.com/1"),
                false,
                Some(true),
                start,
                &mut last
            ),
            NavigationEffect::Cancel,
            "the click above already used this second"
        );
        assert!(!handoff_to_browser(
            None,
            start + EXTERNAL_OPEN_GAP - std::time::Duration::from_millis(1),
            &mut last
        ));
        assert_eq!(last, Some(start));
        let later = start + EXTERNAL_OPEN_GAP;
        assert!(handoff_to_browser(None, later, &mut last));
        assert_eq!(last, Some(later));

        assert_eq!(
            effect("main", "https://example.com/a", false, Some(false)),
            NavigationEffect::Cancel
        );
        assert!(navigation_type_is_user_gesture(0));
        assert!(navigation_type_is_user_gesture(1));
        assert!(navigation_type_is_user_gesture(4));
        assert!(!navigation_type_is_user_gesture(-1));
        assert!(!navigation_type_is_user_gesture(2));
        assert!(!navigation_type_is_user_gesture(3));
    }

    #[test]
    fn configured_csp_is_restrictive_and_overrides_do_not_clear_it() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = main["app"]["security"]["csp"]
            .as_str()
            .expect("main window CSP must be a string");
        let dev = main["app"]["security"]["devCsp"]
            .as_str()
            .expect("dev CSP must be a string");
        for needle in [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' blob: data:",
            "connect-src ",
            "frame-src http: https:",
            "worker-src 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ] {
            assert!(
                csp.contains(needle),
                "production CSP missing {needle}: {csp}"
            );
        }
        assert!(
            !csp.contains("unsafe-eval"),
            "production script-src must not allow eval"
        );
        assert!(
            !csp.contains("ws:"),
            "production connect-src does not need a websocket"
        );
        assert!(dev.contains("'unsafe-inline'"));
        assert!(dev.contains("'unsafe-eval'"));
        assert!(dev.contains("ws://localhost:*"));
        assert!(dev.contains("ws://127.0.0.1:*"));
        for (name, text) in [
            ("tauri.ci.conf.json", include_str!("../tauri.ci.conf.json")),
            (
                "tauri.bundled.conf.json",
                include_str!("../tauri.bundled.conf.json"),
            ),
        ] {
            let value: serde_json::Value = serde_json::from_str(text).unwrap();
            assert!(
                value.pointer("/app/security/csp").is_none(),
                "{name} must not override the main window CSP"
            );
        }
    }
}
