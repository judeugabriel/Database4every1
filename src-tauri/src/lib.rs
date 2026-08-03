pub mod db;
pub mod storage;

use db::commands::{
    cancel_query, connect_db, disconnect_db, get_schema_tree, refresh_schema_cache, run_query,
    DatabaseState,
};
use storage::{delete_connection, load_connection_workspace, save_connection_workspace, save_export_file};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DatabaseState::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            connect_db,
            run_query,
            cancel_query,
            get_schema_tree,
            refresh_schema_cache,
            disconnect_db,
            delete_connection,
            load_connection_workspace,
            save_connection_workspace
            ,save_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
