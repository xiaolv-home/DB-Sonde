mod ai;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 剪贴板:WKWebView 里 navigator.clipboard.readText() 会被拒,读剪贴板必须走原生插件。
        .plugin(tauri_plugin_clipboard_manager::init())
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
            python::python_status,
            python::python_ensure,
            python::python_install,
            python::python_run,
            python::python_stop,
            python::py_workspace_dir,
            python::py_list_files,
            python::py_read_file,
            python::workspace_list_files,
            python::py_write_file,
            python::py_new_file,
            python::py_delete_file,
            python::py_rename_file,
            python::py_pip_install,
            python::py_playwright_install,
            python::py_read_image,
            python::py_lint,
            python::py_complete,
            python::py_sql_lineage,
            etl_files::inspect_etl_files,
            monitor::monitor_show,
            monitor::monitor_bounds,
            monitor::monitor_hide_all,
            monitor::monitor_close,
            monitor::monitor_nav,
            monitor::monitor_current_url,
            store::load_semantic_catalog,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::list_schemas,
            commands::list_tables,
            commands::list_columns,
            commands::list_routines,
            commands::get_routine_details,
            commands::execute_routine,
            commands::list_indexes,
            commands::get_object_ddl,
            commands::run_query,
            commands::preview_drop_object,
            commands::drop_object,
            commands::run_read_only_query,
            dashboard_store::dashboard_storage_path,
            commands::list_processes,
            commands::kill_process,
            commands::set_autocommit,
            commands::commit_session,
            commands::rollback_session,
            commands::update_cell,
            commands::apply_cell_edits,
            commands::run_statements,
            commands::create_demo,
            commands::read_json_dir,
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
