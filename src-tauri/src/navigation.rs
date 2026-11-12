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
//! 只报主框架,所以 webview 就绪后另订 `FrameNavigationStarting`,并在 `FrameCreated`
//! 上给更里面的框架订同样的取消。判断和 macOS 是同一个 `subframe_navigation_allowed`:
//! 只放行普通 http(s)(排除应用、ipc、asset 主机和开发服务器)和 `about:blank` /
//! `about:srcdoc`。子框架被取消时不打开系统浏览器。
//!
//! 打包后的 HTML 由自定义协议带回 `Content-Security-Policy` 响应头(Tauri 2.11 的
//! `protocol::tauri::get_response`;`set_csp` 注明 Windows / macOS 用响应头,`<meta>`
//! 只在 data URL 那条路上注入)。`frame-ancestors` 在 `<meta>` 里会被忽略,在响应头里
//! 才生效,所以 `frame-ancestors 'none'` 让应用页面本身嵌不进任何框架。Vite 开发服务器
//! 不发这道头,ipc/asset 主机也不是这份 HTML,导航事件仍然要取消。
//!
//! wry 会把 WebView2 的请求头抄进自定义协议的 `http::Request`,`Sec-Fetch-Dest` 在协议
//! 处理函数里看得见。但这条 `tauri` 协议由 Tauri 注册一次,应用挂不进去:先注册会盖掉
//! 页面资源,后加的 `WebResourceRequested` 写出的拒绝会被 wry 的 deferral 盖掉。
//! 所以不在协议层拒绝。`reject_framed_app_request` 把「iframe/frame 来取不允许的地址」
//! 留成可测判断,和导航事件用的是同一套地址规则。
//!
//! Tauri 的 IPC 不区分是不是子框架。Windows 上消息来源是发出 `postMessage` 的那个框架
//! 的 URL(`WebMessageReceived.Source`)。来源算应用自己的源时,权限只看窗口标签。
//! 主窗口里若真有 iframe 打开到了应用源,会按 `main` 放行。`monitor-win-*` 不在能力清单
//! 里,本地源也调不了命令。公开接口没有「非顶层框架」这个身份,按框架拒绝会把主页面
//! 自己的调用一起挡掉。
//!
//! macOS 的 `decidePolicyForNavigationAction` 主框架和 iframe 都会进这个钩子,而且回调里
//! 只有 URL,所以改 wry 的策略方法,子框架走上面那套判断。Linux 上 WebKitGTK 同样分不清
//! (发行说明里 Linux 也还没做验证),iframe 导航会被当成主窗口跳转取消;真要在 Linux 上
//! 嵌监控页,得等 wry 把 frame 信息传出来。

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

fn is_loopback_host(host: &str) -> bool {
    // `url` 把 IPv6 主机序列化成带方括号的 `[::1]`,跟页面里 `hostname` 一致。
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

fn is_dev_server(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str().is_some_and(is_loopback_host)
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

/// 响应头里的 CSP 单独有一条 `frame-ancestors 'none'` 时,这份文档不能被嵌进框架。
///
/// 打包后 Tauri 把同一段策略写成 `Content-Security-Policy` 响应头,不是 `<meta>`。
/// 浏览器只认响应头里的 `frame-ancestors`。这里锁的是配置文本本身;开发服务器不发这道头。
fn csp_frame_ancestors_blocks_embedding(csp: &str) -> bool {
    csp.split(';').any(|directive| {
        let mut tokens = directive.split_whitespace();
        tokens
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors"))
            && tokens.eq(["'none'"])
    })
}

/// 请求头能看见 `Sec-Fetch-Dest` 时:iframe / frame 来取子框架策略不允许的地址就拒绝。
/// 顶层文档的 dest 是 `document`,不在这里拒绝,应用自己的页面还要能打开。
fn reject_framed_app_request(url: &Url, sec_fetch_dest: Option<&str>) -> bool {
    let framed = sec_fetch_dest.is_some_and(|dest| {
        matches!(
            dest.trim().to_ascii_lowercase().as_str(),
            "iframe" | "frame" | "fencedframe" | "object" | "embed"
        )
    });
    framed && !subframe_navigation_allowed(url)
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
        .on_webview_ready(|webview| {
            install_platform_hooks(&webview);
        })
        .build()
}

fn install_platform_hooks<R: Runtime>(webview: &Webview<R>) {
    #[cfg(target_os = "macos")]
    macos::install_subframe_filter();
    #[cfg(windows)]
    windows_frame::install(webview);
    #[cfg(not(windows))]
    let _ = webview;
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

/// WebView2 的主框架事件看不到 iframe。直接子框架用 `FrameNavigationStarting`,
/// 再往里的框架在 `FrameCreated` 上订同一个取消。旧运行时没有后两个接口时,
/// 直接子框架(监控页那个 iframe)仍然会被第一道事件拦住。
#[cfg(windows)]
mod windows_frame {
    use std::sync::Mutex;

    use tauri::Runtime;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2Frame, ICoreWebView2Frame2, ICoreWebView2Frame7,
        ICoreWebView2NavigationStartingEventArgs, ICoreWebView2_4,
    };
    use webview2_com::{
        take_pwstr, FrameChildFrameCreatedEventHandler, FrameCreatedEventHandler,
        FrameNavigationStartingEventHandler, NavigationStartingEventHandler,
    };
    use windows_core::{Interface, PWSTR};

    use super::subframe_navigation_allowed;

    pub fn install<R: Runtime>(webview: &tauri::Webview<R>) {
        let label = webview.label().to_string();
        if let Err(err) = webview.with_webview(move |platform| {
            if !claim(&label) {
                return;
            }
            if let Err(err) = unsafe { attach(&platform.controller()) } {
                release(&label);
                eprintln!("DB Sonde: 子框架导航守卫没装上({label}): {err}");
            }
        }) {
            eprintln!("DB Sonde: 拿不到 WebView2({label}): {err}");
        }
    }

    fn seen() -> &'static Mutex<Vec<String>> {
        static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
        &SEEN
    }

    fn claim(label: &str) -> bool {
        let mut seen = seen()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if seen.iter().any(|item| item == label) {
            return false;
        }
        seen.push(label.to_string());
        true
    }

    fn release(label: &str) {
        let mut seen = seen()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        seen.retain(|item| item != label);
    }

    unsafe fn attach(controller: &ICoreWebView2Controller) -> windows_core::Result<()> {
        let core = controller.CoreWebView2()?;
        let mut token = 0i64;
        // 和顶层 NavigationStarting 同一个参数:Uri + SetCancel。这个事件只报子框架。
        core.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|_sender, args| {
                cancel_if_blocked(args)?;
                Ok(())
            })),
            &mut token,
        )?;

        match core.cast::<ICoreWebView2_4>() {
            Ok(newer) => {
                let mut created = 0i64;
                if let Err(err) = newer.add_FrameCreated(
                    &FrameCreatedEventHandler::create(Box::new(|_sender, args| {
                        if let Some(args) = args {
                            if let Ok(frame) = unsafe { args.Frame() } {
                                if let Err(err) = unsafe { watch_frame(&frame) } {
                                    eprintln!("DB Sonde: 嵌套框架导航守卫没装上: {err}");
                                }
                            }
                        }
                        Ok(())
                    })),
                    &mut created,
                ) {
                    eprintln!("DB Sonde: 嵌套框架创建事件没订上: {err}");
                }
            }
            Err(err) => {
                eprintln!("DB Sonde: 这份 WebView2 没有 FrameCreated,只守直接子框架: {err}");
            }
        }
        Ok(())
    }

    unsafe fn watch_frame(frame: &ICoreWebView2Frame) -> windows_core::Result<()> {
        let frame2 = frame.cast::<ICoreWebView2Frame2>()?;
        let mut token = 0i64;
        frame2.add_NavigationStarting(
            &FrameNavigationStartingEventHandler::create(Box::new(|_frame, args| {
                cancel_if_blocked(args)?;
                Ok(())
            })),
            &mut token,
        )?;
        if let Ok(deeper) = frame.cast::<ICoreWebView2Frame7>() {
            let mut created = 0i64;
            deeper.add_FrameCreated(
                &FrameChildFrameCreatedEventHandler::create(Box::new(|_parent, args| {
                    if let Some(args) = args {
                        if let Ok(child) = unsafe { args.Frame() } {
                            if let Err(err) = unsafe { watch_frame(&child) } {
                                eprintln!("DB Sonde: 嵌套框架导航守卫没装上: {err}");
                            }
                        }
                    }
                    Ok(())
                })),
                &mut created,
            )?;
        }
        Ok(())
    }

    /// 地址缺失或解析失败按不允许处理。允许的远程网页保持原样,不改去系统浏览器。
    fn cancel_if_blocked(
        args: Option<ICoreWebView2NavigationStartingEventArgs>,
    ) -> windows_core::Result<()> {
        let Some(args) = args else {
            return Ok(());
        };
        let mut raw = PWSTR::null();
        let allowed = match unsafe { args.Uri(&mut raw) } {
            Ok(()) => {
                let text = take_pwstr(raw);
                tauri::Url::parse(&text).is_ok_and(|url| subframe_navigation_allowed(&url))
            }
            Err(err) => {
                eprintln!("DB Sonde: 读不到子框架地址,取消这次导航: {err}");
                false
            }
        };
        if !allowed {
            unsafe { args.SetCancel(true) }?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        applies_app_navigation_guard, csp_frame_ancestors_blocks_embedding, decide_navigation,
        handoff_to_browser, judge, monitor_navigation_allowed, navigation_type_is_user_gesture,
        reject_framed_app_request, subframe_navigation_allowed, NavigationDecision,
        NavigationEffect, EXTERNAL_OPEN_GAP,
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
            decide("http://[::1]:1420/", true),
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
                !label.starts_with("monitor-win-"),
                "{label} would skip the app guard and still be allowed to invoke"
            );
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
            "http://[::1]:1420/",
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
            "http://[::1]:1420/",
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
    fn framed_app_requests_are_rejected_when_the_fetch_dest_says_frame() {
        let app = parse("http://tauri.localhost/index.html");
        let ipc = parse("https://ipc.localhost/plugin");
        let asset = parse("http://asset.localhost/icon.png");
        let dev = parse("http://localhost:1420/");
        let remote = parse("https://example.com/embed");
        for dest in [
            "iframe",
            "frame",
            "IFRAME",
            " fencedframe ",
            "object",
            "embed",
        ] {
            assert!(reject_framed_app_request(&app, Some(dest)), "{dest}");
            assert!(reject_framed_app_request(&ipc, Some(dest)), "{dest}");
            assert!(reject_framed_app_request(&asset, Some(dest)), "{dest}");
            assert!(reject_framed_app_request(&dev, Some(dest)), "{dest}");
            assert!(
                !reject_framed_app_request(&remote, Some(dest)),
                "a remote page is a normal monitoring frame"
            );
        }
        assert!(!reject_framed_app_request(&app, Some("document")));
        assert!(!reject_framed_app_request(&app, Some("empty")));
        assert!(!reject_framed_app_request(&app, None));
        assert!(reject_framed_app_request(
            &parse("javascript:alert(1)"),
            Some("iframe")
        ));
    }

    #[test]
    fn production_csp_frame_ancestors_none_is_a_response_header_policy() {
        // 自定义协议对 HTML 设置 Content-Security-Policy 响应头。frame-ancestors
        // 只有写在响应头里才禁止被嵌入;<meta http-equiv> 里的同名指令会被忽略。
        // 开发服务器不走这条协议,所以导航取消不能省。
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = main["app"]["security"]["csp"].as_str().unwrap();
        let dev = main["app"]["security"]["devCsp"].as_str().unwrap();
        assert!(csp_frame_ancestors_blocks_embedding(csp), "{csp}");
        assert!(csp_frame_ancestors_blocks_embedding(dev), "{dev}");
        assert!(!csp_frame_ancestors_blocks_embedding(
            "default-src 'self'; frame-src 'none'"
        ));
        assert!(!csp_frame_ancestors_blocks_embedding(
            "frame-ancestors 'none' https://example.com"
        ));
        assert!(!csp_frame_ancestors_blocks_embedding(
            "frame-ancestors 'self'"
        ));
        assert!(csp_frame_ancestors_blocks_embedding(
            "default-src 'self'; Frame-Ancestors 'none'; frame-src http:"
        ));
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
