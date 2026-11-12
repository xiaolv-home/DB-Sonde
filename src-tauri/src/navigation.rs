//! 主窗口不许离开应用自己的页面。
//!
//! 窗口是 `tauri.conf.json` 里声明的,没有单独的 `WebviewWindowBuilder`,所以用插件的
//! `on_navigation`(和 builder 上那个回调是同一条 wry 钩子)。返回 false 就取消这次导航。
//! 远程的 http(s) 交给已经在用的 opener 插件,用系统浏览器打开。
//!
//! 监控中心的页面是主窗口里的 iframe,不是主框架跳转。Windows 的 `NavigationStarting`
//! 本来就只报主框架。macOS 的 `decidePolicyForNavigationAction` 主框架和 iframe 都会进
//! 这个钩子,而且回调里只有 URL,分不出来 —— 所以在 macOS 上改 wry 的策略方法:目标框架
//! 不是主框架就直接允许,主框架仍走下面的判断。Linux 上 WebKitGTK 同样分不清(发行说明里
//! Linux 也还没做验证),iframe 导航会被当成主窗口跳转取消;真要在 Linux 上嵌监控页,得等
//! wry 把 frame 信息传出来。

use tauri::{Runtime, Url, Webview};
use tauri_plugin_opener::OpenerExt;

const MAIN_WINDOW_LABEL: &str = "main";
/// 跟 `tauri.conf.json` 的 `build.devUrl` / Vite 端口一致。只在 debug 构建里放行。
const DEV_SERVER_PORT: u16 = 1420;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavigationDecision {
    Allow,
    /// 远程 http(s):取消 webview 导航,改用系统浏览器打开。
    OpenExternal,
    Deny,
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
        "about" => matches!(url.path(), "blank" | "srcdoc"),
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

/// 真正的远程网页。ipc.localhost 是 Tauri 自己的通道,不是该拿去浏览器打开的链接。
fn is_remote_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.host_str() != Some("ipc.localhost")
}

fn on_navigation<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    // 画布窗口是应用页面;监控独立窗口本来就是远程页。都不要拦。
    if webview.label() != MAIN_WINDOW_LABEL {
        return true;
    }
    match decide_navigation(url, cfg!(debug_assertions)) {
        NavigationDecision::Allow => true,
        NavigationDecision::OpenExternal => {
            let _ = webview.opener().open_url(url.as_str(), None::<&str>);
            false
        }
        NavigationDecision::Deny => false,
    }
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("sonde-navigation")
        .on_navigation(on_navigation)
        .on_webview_ready(|webview| {
            if webview.label() == MAIN_WINDOW_LABEL {
                install_platform_hooks();
            }
        })
        .build()
}

fn install_platform_hooks() {
    #[cfg(target_os = "macos")]
    macos::install_subframe_bypass();
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::sel;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

    /// `WKNavigationActionPolicyAllow`.
    const ALLOW: isize = 1;

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

    pub fn install_subframe_bypass() {
        if INSTALLED.load(Ordering::Acquire) {
            return;
        }
        let Some(class) = delegate_class() else {
            eprintln!("DB Sonde: 找不到 WryNavigationDelegate,子框架导航无法单独放行");
            return;
        };
        let Some(method) =
            class.instance_method(sel!(webView:decidePolicyForNavigationAction:decisionHandler:))
        else {
            eprintln!("DB Sonde: WryNavigationDelegate 没有导航策略方法,子框架导航无法单独放行");
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
            allow(handler);
            return;
        }
        let original = ORIGINAL.load(Ordering::Acquire);
        if original.is_null() {
            allow(handler);
            return;
        }
        let original: Decide = std::mem::transmute(original);
        original(this, sel, webview, action, handler);
    }

    /// `targetFrame == nil` 是 window.open / target=_blank,按主框架处理(取消并交给浏览器)。
    /// 普通 iframe 的 targetFrame 不是主框架,必须放行,否则监控中心嵌不进页面。
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

    unsafe fn allow(handler: *mut c_void) {
        if handler.is_null() {
            return;
        }
        let block = &*(handler as *const DecisionBlock);
        (block.invoke)(handler as *mut DecisionBlock, ALLOW);
    }
}

#[cfg(test)]
mod tests {
    use super::{decide_navigation, NavigationDecision};
    use tauri::Url;

    fn decide(raw: &str, dev: bool) -> NavigationDecision {
        decide_navigation(&Url::parse(raw).unwrap(), dev)
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
            "http://tauri.localhost:8080/",
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
        ] {
            assert_eq!(decide(raw, false), NavigationDecision::Deny, "{raw}");
        }
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
            "connect-src 'self' ipc: http://ipc.localhost",
            "http://127.0.0.1:*",
            "http://localhost:*",
            "https:",
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
