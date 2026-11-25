mod ai;
mod app_menu;
mod canvas_store;
mod canvas_window;
mod monitor;
mod commands;
mod credentials;
mod ipc_access;
mod cloud_proxy;
mod paths;
mod workspace_lifecycle;
mod dashboard_store;
mod dataset_store;
mod db;
mod error;
mod export;
mod models;
mod python;
mod readonly;
mod store;
mod persistence;

use commands::AppState;
use tauri::Manager;

/// macOS 菜单栏:中文 + 「全选 / 查找」交给页面处理(见 app_menu.rs)。
/// 别的系统默认没有菜单栏,不加 —— 加了 Windows 窗口顶上会多出一条菜单。
fn with_app_menu(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu::build);
    builder
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_app_menu(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 剪贴板:WKWebView 里 navigator.clipboard.readText() 会被拒,读剪贴板必须走原生插件。
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| app_menu::on_event(app, event.id().as_ref()))
        .manage(AppState::default())
        .manage(workspace_lifecycle::ExitGuard::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 只有关主窗口才等于退出应用;画布、监控这些独立窗口点关闭就只关它自己
                if workspace_lifecycle::closing_exits_app(window.label()) && workspace_lifecycle::should_intercept(window.app_handle()) {
                    api.prevent_close();
                    workspace_lifecycle::request_exit(window.app_handle());
                }
            }
        })
        .manage(ai::AiEngine::default())
        .manage(cloud_proxy::CloudProxy::default())
        .manage(python::PyRuntime::default())
        .invoke_handler({
            let commands: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
            credentials::load_service_config,
            credentials::save_service_config,
            cloud_proxy::cloud_model_request,
            cloud_proxy::cloud_chat_stream,
            cloud_proxy::cloud_model_cancel,
            workspace_lifecycle::enable_workspace_exit_guard,
            workspace_lifecycle::finish_workspace_exit,
            ai::ai_engine_status,
            ai::ai_engine_start,
            ai::ai_engine_stop,
            ai::ai_model_download,
            ai::ai_model_progress,
            python::runtime::python_status,
            python::runtime::python_ensure,
            python::runtime::python_install,
            python::run::python_run,
            python::run::python_stop,
            python::workspace::py_workspace_dir,
            python::workspace::py_list_files,
            python::workspace::py_read_file,
            python::workspace::workspace_list_files,
            python::workspace::py_write_file,
            python::workspace::py_new_file,
            python::workspace::py_delete_file,
            python::workspace::py_rename_file,
            python::run::py_pip_install,
            python::run::py_playwright_install,
            python::workspace::py_read_image,
            python::assist::py_lint,
            python::assist::py_complete,
            monitor::monitor_probe,
            monitor::monitor_open_window,
            store::load_semantic_catalog,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::test_connection,
            commands::connections::connect,
            commands::connections::disconnect,
            commands::objects::list_databases,
            commands::objects::list_schemas,
            commands::objects::list_tables,
            commands::objects::list_columns,
            commands::objects::list_routines,
            commands::objects::get_routine_details,
            commands::objects::execute_routine,
            commands::objects::list_indexes,
            commands::objects::get_object_ddl,
            commands::query::run_query,
            commands::query::cancel_query,
            commands::objects::preview_drop_object,
            commands::objects::drop_object,
            canvas_window::open_canvas_window,
            canvas_store::load_canvases,
            canvas_store::save_canvases,
            canvas_store::load_canvas_history,
            canvas_store::save_canvas_history,
            commands::objects::plan_column_change,
            commands::objects::apply_column_change,
            commands::query::run_read_only_query,
            dashboard_store::dashboard_storage_path,
            commands::query::list_processes,
            commands::query::kill_process,
            commands::query::set_autocommit,
            commands::query::commit_session,
            commands::query::rollback_session,
            commands::query::update_cell,
            commands::query::apply_cell_edits,
            commands::query::run_statements,
            commands::connections::create_demo,
            dashboard_store::list_dashboards,
            dashboard_store::save_dashboard,
            dashboard_store::publish_dashboard,
            dashboard_store::list_dashboard_versions,
            dashboard_store::delete_dashboard,
            dataset_store::list_datasets,
            dataset_store::save_dataset,
            dataset_store::delete_dataset,
            export::save_export,
            ];
            move |invoke: tauri::ipc::Invoke| {
                if ipc_access::application_window(invoke.message.webview_ref().label()) {
                    commands(invoke)
                } else {
                    invoke.resolver.reject("这个窗口不能调用应用命令");
                    true
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if workspace_lifecycle::should_intercept(app) {
                        api.prevent_exit();
                        workspace_lifecycle::request_exit(app);
                    }
                }
                tauri::RunEvent::Exit => {
                    if let Some(ai) = app.try_state::<ai::AiEngine>() {
                        ai.shutdown();
                    }
                    if let Some(py) = app.try_state::<python::PyRuntime>() {
                        py.shutdown();
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod safety_tests;

#[cfg(test)]
mod main_thread_guard {
    /// Extract `(fn_name, body_text)` for every synchronous `#[tauri::command]`
    /// (excluding `#[tauri::command(async)]` and `async fn`), handling comments,
    /// intermediate attributes, `pub(crate) fn`, and multiline signatures.
    fn sync_command_bodies(src: &str) -> Vec<(String, String)> {
        let lines: Vec<&str> = src.lines().collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < lines.len() {
            let trimmed = lines[i].trim();
            if trimmed.starts_with("#[tauri::command") && !trimmed.contains("async") {
                i += 1;
                let mut sig = String::new();
                while i < lines.len() {
                    let t = lines[i].trim();
                    if t.starts_with("//") || t.starts_with('#') || t.is_empty() {
                        i += 1;
                        continue;
                    }
                    sig.push_str(t);
                    sig.push(' ');
                    if t.contains('{') {
                        break;
                    }
                    i += 1;
                }
                let is_async = sig.contains("async fn ");
                if !is_async {
                    if let Some(after_fn) = sig.split("fn ").nth(1) {
                        let name: String = after_fn
                            .chars()
                            .take_while(|c| c.is_alphanumeric() || *c == '_')
                            .collect();
                        // Collect balanced braces from the opening `{` line onward.
                        let mut body = String::new();
                        let mut depth = 0i32;
                        let mut started = false;
                        while i < lines.len() {
                            let line = lines[i];
                            body.push_str(line);
                            body.push('\n');
                            for ch in line.chars() {
                                if ch == '{' {
                                    depth += 1;
                                    started = true;
                                } else if ch == '}' {
                                    depth -= 1;
                                }
                            }
                            i += 1;
                            if started && depth <= 0 {
                                break;
                            }
                        }
                        if !name.is_empty() {
                            out.push((name, body));
                        }
                        continue;
                    }
                }
            }
            i += 1;
        }
        out
    }

    /// 同步的 `#[tauri::command]` 默认在主线程(界面线程)执行,跑多久界面就卡多久。
    /// 这里守住:同步命令的函数体里若有「等子进程 / 读写文件 / 封装的磁盘存储 helper / 阻塞网络」,
    /// 必须标成 `#[tauri::command(async)]`(放进线程池)或改成 async。
    #[test]
    fn blocking_work_never_runs_on_the_ui_thread() {
        const BLOCKING: &[&str] = &[
            ".output()",
            ".wait_with_output()",
            ".wait()",
            "read_to_string(",
            "fs::read(",
            "fs::write(",
            "fs::remove_file(",
            "fs::rename(",
            "read_dir(",
            "blocking::",
            "write_all(",
            "store::load_",
            "store::save_",
            "credentials::",
            "persistence::write_json_atomic(",
            "load_path(",
            "save_path(",
            "upsert_document(",
            "load_versions_path(",
            "save_versions_path(",
        ];
        let sources = [
            ("python/runtime.rs", include_str!("python/runtime.rs")),
            ("python/run.rs", include_str!("python/run.rs")),
            ("python/workspace.rs", include_str!("python/workspace.rs")),
            ("python/assist.rs", include_str!("python/assist.rs")),
            ("canvas_store.rs", include_str!("canvas_store.rs")),
            ("canvas_window.rs", include_str!("canvas_window.rs")),
            ("commands/connections.rs", include_str!("commands/connections.rs")),
            ("commands/objects.rs", include_str!("commands/objects.rs")),
            ("commands/query.rs", include_str!("commands/query.rs")),
            ("export.rs", include_str!("export.rs")),
            ("ai/mod.rs", include_str!("ai/mod.rs")),
            ("credentials.rs", include_str!("credentials.rs")),
            ("cloud_proxy/mod.rs", include_str!("cloud_proxy/mod.rs")),
            ("dashboard_store.rs", include_str!("dashboard_store.rs")),
            ("dataset_store.rs", include_str!("dataset_store.rs")),
            ("monitor.rs", include_str!("monitor.rs")),
            ("store.rs", include_str!("store.rs")),
            ("workspace_lifecycle.rs", include_str!("workspace_lifecycle.rs")),
        ];
        // 清单本身也要守:文件拆开 / 新加命令文件后忘了登记,这条检查就悄悄少扫一块
        let listed: std::collections::HashSet<&str> = sources.iter().map(|(f, _)| *f).collect();
        let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut unlisted = Vec::new();
        let mut stack = vec![src_dir.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() { stack.push(path); continue; }
                if path.extension().is_none_or(|e| e != "rs") { continue; }
                let text = std::fs::read_to_string(&path).unwrap();
                let rel = path.strip_prefix(&src_dir).unwrap().to_string_lossy().replace('\\', "/");
                if text.lines().any(|l| l.trim_start().starts_with("#[tauri::command")) && !listed.contains(rel.as_str()) {
                    unlisted.push(rel);
                }
            }
        }
        assert!(unlisted.is_empty(), "这些文件里有 #[tauri::command],但没登记进上面的 sources:{unlisted:?}");
        let mut offenders = Vec::new();
        for (file, src) in sources {
            for (name, body) in sync_command_bodies(src) {
                if let Some(hit) = BLOCKING.iter().find(|p| body.contains(**p)) {
                    offenders.push(format!("{file}::{name} ({hit})"));
                }
            }
        }
        assert!(offenders.is_empty(), "这些同步命令在界面线程上做阻塞的事,会卡界面:\n  {}", offenders.join("\n  "));

        // 守卫自检:多行签名、夹着注释或 pub(crate) 的同步命令也必须被扫出来
        let sample = "#[tauri::command]\n// comment\npub(crate) fn sneaky(\n  a: String,\n) -> String {\n  store::load_connections(&app);\n}\n";
        let detected = sync_command_bodies(sample);
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].0, "sneaky");
        assert!(detected[0].1.contains("store::load_connections("));
    }
}
