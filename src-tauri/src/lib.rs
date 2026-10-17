mod ai;
mod app_menu;
mod canvas_window;
mod etl_files;
mod monitor;
mod commands;
mod credentials;
mod workspace_lifecycle;
mod scheduler;
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
                if workspace_lifecycle::should_intercept(window.app_handle()) {
                    api.prevent_close();
                    workspace_lifecycle::request_exit(window.app_handle());
                }
            }
        })
        .manage(ai::AiEngine::default())
        .manage(python::PyRuntime::default())
        .invoke_handler(tauri::generate_handler![
            credentials::load_service_config,
            credentials::save_service_config,
            workspace_lifecycle::enable_workspace_exit_guard,
            workspace_lifecycle::finish_workspace_exit,
            ai::ai_engine_status,
            ai::ai_engine_start,
            ai::ai_engine_stop,
            ai::ai_model_download,
            ai::ai_model_progress,
            scheduler::scheduler_fetch,
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
            python::assist::py_sql_lineage,
            etl_files::inspect_etl_files,
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
            etl_files::read_json_dir,
            dashboard_store::list_dashboards,
            dashboard_store::save_dashboard,
            dashboard_store::publish_dashboard,
            dashboard_store::list_dashboard_versions,
            dashboard_store::delete_dashboard,
            dataset_store::list_datasets,
            dataset_store::save_dataset,
            dataset_store::delete_dataset,
            export::save_export,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if workspace_lifecycle::should_intercept(app) {
                    api.prevent_exit();
                    workspace_lifecycle::request_exit(app);
                }
            }
        });
}

#[cfg(test)]
mod safety_tests;

#[cfg(test)]
mod main_thread_guard {
    /// 同步的 `#[tauri::command]` 默认在主线程(界面线程)执行,跑多久界面就卡多久。
    /// 实测过:血缘扫描每条 SQL 都起一个 Python 进程并在主线程等它,153 个指标卡十几秒。
    /// 这里守住:同步命令的函数体里若有「等子进程 / 读写文件 / 读目录 / 阻塞网络」,
    /// 必须标成 `#[tauri::command(async)]`(放进线程池)或改成 async。
    #[test]
    fn blocking_work_never_runs_on_the_ui_thread() {
        const BLOCKING: &[&str] = &[".output()", ".wait_with_output()", ".wait()", "read_to_string(", "fs::read(", "fs::write(", "read_dir(", "blocking::", "write_all("];
        let sources = [
            ("python/runtime.rs", include_str!("python/runtime.rs")),
            ("python/run.rs", include_str!("python/run.rs")),
            ("python/workspace.rs", include_str!("python/workspace.rs")),
            ("python/assist.rs", include_str!("python/assist.rs")),
            ("canvas_window.rs", include_str!("canvas_window.rs")),
            ("commands/connections.rs", include_str!("commands/connections.rs")),
            ("commands/objects.rs", include_str!("commands/objects.rs")),
            ("commands/query.rs", include_str!("commands/query.rs")),
            ("export.rs", include_str!("export.rs")),
            ("ai.rs", include_str!("ai.rs")),
            ("credentials.rs", include_str!("credentials.rs")),
            ("dashboard_store.rs", include_str!("dashboard_store.rs")),
            ("dataset_store.rs", include_str!("dataset_store.rs")),
            ("etl_files.rs", include_str!("etl_files.rs")),
            ("monitor.rs", include_str!("monitor.rs")),
            ("scheduler.rs", include_str!("scheduler.rs")),
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
            // 不按 #[cfg(test)] 截断:有的文件开头就有测试用的 thread_local,截断会漏扫整个文件
            for (i, chunk) in src.split("#[tauri::command]\npub fn ").enumerate().skip(1) {
                let _ = i;
                let name: String = chunk.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                let body = chunk.split("\n}\n").next().unwrap_or(chunk);
                if let Some(hit) = BLOCKING.iter().find(|p| body.contains(**p)) {
                    offenders.push(format!("{file}::{name} ({hit})"));
                }
            }
        }
        assert!(offenders.is_empty(), "这些同步命令在界面线程上做阻塞的事,会卡界面:\n  {}", offenders.join("\n  "));
    }
}
