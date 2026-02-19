mod config;
mod db;

use db::{Conversation, Database, Message};
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db_state)
        .invoke_handler(tauri::generate_handler![
            get_config,
            create_conversation,
            list_conversations,
            update_conversation_title,
            save_message,
            get_messages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
