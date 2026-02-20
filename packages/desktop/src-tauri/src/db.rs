use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub reasoning_content: Option<String>,
    pub created_at: String,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn = Connection::open(db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                reasoning_content TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        Ok(Database {
            conn: Mutex::new(conn),
        })
    }

    pub fn create_conversation(&self, title: &str) -> Result<Conversation, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let now: DateTime<Utc> = Utc::now();
        let now_str = now.to_rfc3339();

        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, now_str, now_str],
        )
        .map_err(|e| format!("Failed to create conversation: {}", e))?;

        Ok(Conversation {
            id,
            title: title.to_string(),
            created_at: now_str.clone(),
            updated_at: now_str,
        })
    }

    pub fn list_conversations(&self) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut conversations = Vec::new();
        for row in rows {
            conversations.push(row.map_err(|e| e.to_string())?);
        }
        Ok(conversations)
    }

    pub fn update_conversation_title(&self, id: &str, title: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now: DateTime<Utc> = Utc::now();
        conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now.to_rfc3339(), id],
        )
        .map_err(|e| format!("Failed to update conversation: {}", e))?;
        Ok(())
    }

    pub fn save_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        reasoning_content: Option<&str>,
    ) -> Result<Message, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let now: DateTime<Utc> = Utc::now();
        let now_str = now.to_rfc3339();

        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, reasoning_content, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, conversation_id, role, content, reasoning_content, now_str],
        )
        .map_err(|e| format!("Failed to save message: {}", e))?;

        // Update conversation's updated_at
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now_str, conversation_id],
        )
        .map_err(|e| format!("Failed to update conversation timestamp: {}", e))?;

        Ok(Message {
            id,
            conversation_id: conversation_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            reasoning_content: reasoning_content.map(|s| s.to_string()),
            created_at: now_str,
        })
    }

    pub fn get_messages(&self, conversation_id: &str) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, role, content, reasoning_content, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![conversation_id], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    reasoning_content: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut messages = Vec::new();
        for row in rows {
            messages.push(row.map_err(|e| e.to_string())?);
        }
        Ok(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new(":memory:").unwrap()
    }

    #[test]
    fn create_conversation() {
        let db = test_db();
        let conv = db.create_conversation("Test Chat").unwrap();
        assert_eq!(conv.title, "Test Chat");
        assert!(!conv.id.is_empty());
        assert!(!conv.created_at.is_empty());
        assert_eq!(conv.created_at, conv.updated_at);
    }

    #[test]
    fn list_conversations_empty() {
        let db = test_db();
        let convs = db.list_conversations().unwrap();
        assert!(convs.is_empty());
    }

    #[test]
    fn list_conversations_ordered_by_updated_at() {
        let db = test_db();
        let first = db.create_conversation("First").unwrap();
        let second = db.create_conversation("Second").unwrap();

        let convs = db.list_conversations().unwrap();
        assert_eq!(convs.len(), 2);
        // Most recently created should be first (ORDER BY updated_at DESC)
        assert_eq!(convs[0].id, second.id);
        assert_eq!(convs[1].id, first.id);
    }

    #[test]
    fn update_conversation_title() {
        let db = test_db();
        let conv = db.create_conversation("Old Title").unwrap();
        db.update_conversation_title(&conv.id, "New Title").unwrap();

        let convs = db.list_conversations().unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].title, "New Title");
    }

    #[test]
    fn save_and_get_messages() {
        let db = test_db();
        let conv = db.create_conversation("Chat").unwrap();

        db.save_message(&conv.id, "user", "Hello", None).unwrap();
        db.save_message(&conv.id, "assistant", "Hi there", Some("thinking..."))
            .unwrap();

        let msgs = db.get_messages(&conv.id).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "Hello");
        assert!(msgs[0].reasoning_content.is_none());
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].content, "Hi there");
        assert_eq!(msgs[1].reasoning_content.as_deref(), Some("thinking..."));
    }

    #[test]
    fn get_messages_empty() {
        let db = test_db();
        let conv = db.create_conversation("Empty").unwrap();
        let msgs = db.get_messages(&conv.id).unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn save_message_updates_conversation_timestamp() {
        let db = test_db();
        let conv = db.create_conversation("Chat").unwrap();
        let original_updated = conv.updated_at.clone();

        // Small sleep to ensure timestamp differs
        std::thread::sleep(std::time::Duration::from_millis(10));
        db.save_message(&conv.id, "user", "Hello", None).unwrap();

        let convs = db.list_conversations().unwrap();
        assert!(convs[0].updated_at >= original_updated);
    }

    #[test]
    fn messages_ordered_by_created_at() {
        let db = test_db();
        let conv = db.create_conversation("Chat").unwrap();

        db.save_message(&conv.id, "user", "First", None).unwrap();
        db.save_message(&conv.id, "assistant", "Second", None)
            .unwrap();
        db.save_message(&conv.id, "user", "Third", None).unwrap();

        let msgs = db.get_messages(&conv.id).unwrap();
        assert_eq!(msgs[0].content, "First");
        assert_eq!(msgs[1].content, "Second");
        assert_eq!(msgs[2].content, "Third");
    }

    #[test]
    fn messages_isolated_per_conversation() {
        let db = test_db();
        let conv1 = db.create_conversation("Chat 1").unwrap();
        let conv2 = db.create_conversation("Chat 2").unwrap();

        db.save_message(&conv1.id, "user", "In chat 1", None)
            .unwrap();
        db.save_message(&conv2.id, "user", "In chat 2", None)
            .unwrap();

        let msgs1 = db.get_messages(&conv1.id).unwrap();
        let msgs2 = db.get_messages(&conv2.id).unwrap();
        assert_eq!(msgs1.len(), 1);
        assert_eq!(msgs2.len(), 1);
        assert_eq!(msgs1[0].content, "In chat 1");
        assert_eq!(msgs2[0].content, "In chat 2");
    }
}
