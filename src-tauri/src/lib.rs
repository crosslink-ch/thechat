mod config;
mod db;
mod mcp;

use db::{Conversation, Database, Message};
use mcp::McpManager;
use std::sync::Arc;
use tauri::State;

type DbState = Arc<Database>;

#[tauri::command]
fn get_config() -> Result<config::AppConfig, String> {
    config::load_config()
}

#[tauri::command]
fn create_conversation(title: String, db: State<DbState>) -> Result<Conversation, String> {
    db.create_conversation(&title)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("thechat");
    std::fs::create_dir_all(&db_path).expect("Failed to create data directory");
    let db_path = db_path.join("thechat.db");

    let database =
        Database::new(db_path.to_str().unwrap()).expect("Failed to initialize database");
    let db_state: DbState = Arc::new(database);
    let mcp_state: Arc<McpManager> = Arc::new(McpManager::new());

    log::info!("App started");

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(db_state)
        .manage(mcp_state)
        .invoke_handler(tauri::generate_handler![
            get_config,
            create_conversation,
            list_conversations,
            update_conversation_title,
            save_message,
            get_messages,
            mcp::mcp_initialize,
            mcp::mcp_call_tool,
            mcp::mcp_shutdown,
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

        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_log::Builder::new().build())
            .manage(db_state)
            .manage(mcp_state)
            .invoke_handler(tauri::generate_handler![
                get_config,
                create_conversation,
                list_conversations,
                update_conversation_title,
                save_message,
                get_messages,
                mcp::mcp_initialize,
                mcp::mcp_call_tool,
                mcp::mcp_shutdown,
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
        let conv = db.create_conversation("Test").unwrap();
        assert_eq!(conv.title, "Test");

        db.save_message(&conv.id, "user", "Hello", None).unwrap();
        let msgs = db.get_messages(&conv.id).unwrap();
        assert_eq!(msgs.len(), 1);
    }
}
