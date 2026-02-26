mod config;
mod db;
mod fs;
mod mcp;
mod shell;
mod stream;

use db::{Conversation, Database, Message};
use mcp::McpManager;
use shell::ShellProcesses;
use stream::StreamCancellers;
use std::sync::Arc;
use tauri::State;

fn log_level_from_env() -> log::LevelFilter {
    let val = std::env::var("THECHAT_LOG_LEVEL").unwrap_or_default().to_lowercase();
    match val.as_str() {
        "trace" => log::LevelFilter::Trace,
        "debug" => log::LevelFilter::Debug,
        "info" => log::LevelFilter::Info,
        "warn" | "warning" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        "off" | "none" => log::LevelFilter::Off,
        _ => {
            if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            }
        }
    }
}

type DbState = Arc<Database>;

pub struct InitialProjectDir(pub Option<String>);

#[tauri::command]
fn get_config() -> Result<config::AppConfig, String> {
    config::load_config()
}

#[tauri::command]
fn get_config_path() -> Option<String> {
    config::config_dir_path().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_config(config: config::AppConfig) -> Result<(), String> {
    config::save_config(&config)
}

#[tauri::command]
fn create_conversation(
    title: String,
    project_dir: Option<String>,
    db: State<DbState>,
) -> Result<Conversation, String> {
    db.create_conversation(&title, project_dir.as_deref())
}

#[tauri::command]
fn list_conversations(db: State<DbState>) -> Result<Vec<Conversation>, String> {
    db.list_conversations()
}

#[tauri::command]
fn update_conversation_title(id: String, title: String, db: State<DbState>) -> Result<(), String> {
    db.update_conversation_title(&id, &title)
}

#[tauri::command]
fn save_message(
    conversation_id: String,
    role: String,
    content: String,
    reasoning_content: Option<String>,
    db: State<DbState>,
) -> Result<Message, String> {
    db.save_message(
        &conversation_id,
        &role,
        &content,
        reasoning_content.as_deref(),
    )
}

#[tauri::command]
fn get_messages(conversation_id: String, db: State<DbState>) -> Result<Vec<Message>, String> {
    db.get_messages(&conversation_id)
}

#[tauri::command]
fn kv_get(key: String, db: State<DbState>) -> Result<Option<String>, String> {
    db.kv_get(&key)
}

#[tauri::command]
fn kv_set(key: String, value: String, db: State<DbState>) -> Result<(), String> {
    db.kv_set(&key, &value)
}

#[tauri::command]
fn kv_delete(key: String, db: State<DbState>) -> Result<(), String> {
    db.kv_delete(&key)
}

#[tauri::command]
fn get_initial_project_dir(state: State<InitialProjectDir>) -> Option<String> {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Fix pixelated/aliased font rendering on Linux (WebKitGTK).
    // The DMA-BUF renderer can bypass GPU-accelerated text rasterisation,
    // falling back to a path that respects system fontconfig antialiasing.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    let initial_project_dir = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .and_then(|arg| match std::fs::canonicalize(&arg) {
            Ok(path) if path.is_dir() => Some(path.to_string_lossy().into_owned()),
            Ok(path) => {
                eprintln!("Warning: '{}' is not a directory", path.display());
                None
            }
            Err(e) => {
                eprintln!("Warning: cannot resolve '{}': {}", arg, e);
                None
            }
        });
    let db_path = if let Ok(dir) = std::env::var("THECHAT_DATA_DIR") {
        // Explicit override (used by E2E tests for isolation)
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).expect("Failed to create data directory");
        dir.join("thechat.db")
    } else if cfg!(debug_assertions) {
        // In development, store the database inside the project directory
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dev.db")
    } else {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("thechat");
        std::fs::create_dir_all(&dir).expect("Failed to create data directory");
        dir.join("thechat.db")
    };

    let database =
        Database::new(db_path.to_str().unwrap()).expect("Failed to initialize database");
    let db_state: DbState = Arc::new(database);
    let mcp_state: Arc<McpManager> = Arc::new(McpManager::new());
    let shell_state: Arc<ShellProcesses> = Arc::new(ShellProcesses::new());
    let stream_state: Arc<StreamCancellers> = Arc::new(StreamCancellers::new());

    log::info!("App started");

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().level(log_level_from_env()).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .manage(db_state)
        .manage(mcp_state)
        .manage(shell_state)
        .manage(stream_state)
        .manage(InitialProjectDir(initial_project_dir))
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_config_path,
            save_config,
            get_initial_project_dir,
            create_conversation,
            list_conversations,
            update_conversation_title,
            save_message,
            get_messages,
            kv_get,
            kv_set,
            kv_delete,
            mcp::mcp_initialize,
            mcp::mcp_initialize_authed,
            mcp::mcp_initialize_servers,
            mcp::mcp_call_tool,
            mcp::mcp_shutdown,
            shell::execute_shell_command,
            shell::kill_shell_process,
            fs::get_project_info,
            fs::get_cwd,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_edit_file,
            fs::fs_glob,
            fs::fs_grep,
            fs::fs_list_dir,
            stream::stream_completion,
            stream::cancel_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    #[test]
    fn app_builds_with_mock_runtime() {
        let database = Database::new(":memory:").unwrap();
        let db_state: DbState = Arc::new(database);
        let mcp_state: Arc<McpManager> = Arc::new(McpManager::new());
        let shell_state: Arc<ShellProcesses> = Arc::new(ShellProcesses::new());
        let stream_state: Arc<StreamCancellers> = Arc::new(StreamCancellers::new());

        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_log::Builder::new().level(log_level_from_env()).build())
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_process::init())
            .manage(db_state)
            .manage(mcp_state)
            .manage(shell_state)
            .manage(stream_state)
            .manage(InitialProjectDir(None))
            .invoke_handler(tauri::generate_handler![
                get_config,
                save_config,
                get_initial_project_dir,
                create_conversation,
                list_conversations,
                update_conversation_title,
                save_message,
                get_messages,
                kv_get,
                kv_set,
                kv_delete,
                mcp::mcp_initialize,
                mcp::mcp_initialize_servers,
                mcp::mcp_call_tool,
                mcp::mcp_shutdown,
                shell::execute_shell_command,
                shell::kill_shell_process,
                fs::get_project_info,
                fs::get_cwd,
                fs::fs_read_file,
                fs::fs_write_file,
                fs::fs_edit_file,
                fs::fs_glob,
                fs::fs_grep,
                fs::fs_list_dir,
                stream::stream_completion,
                stream::cancel_stream,
            ])
            .build(tauri::generate_context!())
            .expect("failed to build app with mock runtime");

        // Verify managed state is accessible
        let state = app.state::<DbState>();
        let convs = state.list_conversations().unwrap();
        assert!(convs.is_empty());
    }

    #[test]
    fn managed_db_operations_through_app_state() {
        let database = Database::new(":memory:").unwrap();
        let db_state: DbState = Arc::new(database);

        let app = tauri::test::mock_builder()
            .manage(db_state)
            .build(tauri::generate_context!())
            .expect("failed to build app");

        let db = app.state::<DbState>();
        let conv = db.create_conversation("Test", None).unwrap();
        assert_eq!(conv.title, "Test");

        db.save_message(&conv.id, "user", "Hello", None).unwrap();
        let msgs = db.get_messages(&conv.id).unwrap();
        assert_eq!(msgs.len(), 1);
    }
}
