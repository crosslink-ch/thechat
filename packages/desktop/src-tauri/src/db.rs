use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;
use tracing::instrument;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub project_dir: Option<String>,
    pub agent_profile_id: Option<String>,
    pub acp_session_id: Option<String>,
    #[serde(skip)]
    pub acp_profile_fingerprint: Option<String>,
    #[serde(skip)]
    #[allow(dead_code)]
    // Internal metadata CAS state; intentionally never sent to the renderer.
    pub acp_runtime_epoch: Option<String>,
    #[serde(skip)]
    #[allow(dead_code)]
    // Internal metadata CAS state; intentionally never sent to the renderer.
    pub acp_generation: Option<i64>,
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

fn migrate_conversation_columns(conn: &mut Connection) -> Result<(), String> {
    let existing = {
        let mut statement = conn
            .prepare("PRAGMA table_info(conversations)")
            .map_err(|e| format!("Failed to inspect conversations schema: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("Failed to read conversations schema: {e}"))?;
        rows.collect::<rusqlite::Result<HashSet<_>>>()
            .map_err(|e| format!("Failed to decode conversations schema: {e}"))?
    };

    let transaction = conn
        .transaction()
        .map_err(|e| format!("Failed to start conversation migration: {e}"))?;
    for (name, sql_type) in [
        ("project_dir", "TEXT"),
        ("agent_profile_id", "TEXT"),
        ("acp_session_id", "TEXT"),
        ("acp_profile_fingerprint", "TEXT"),
        ("acp_runtime_epoch", "TEXT"),
        ("acp_generation", "INTEGER"),
    ] {
        if !existing.contains(name) {
            transaction
                .execute(
                    &format!("ALTER TABLE conversations ADD COLUMN {name} {sql_type}"),
                    [],
                )
                .map_err(|e| format!("Failed to add conversations.{name}: {e}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|e| format!("Failed to commit conversation migration: {e}"))
}

impl Database {
    #[instrument]
    pub fn new(db_path: &str) -> Result<Self, String> {
        let mut conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_dir TEXT,
                agent_profile_id TEXT,
                acp_session_id TEXT,
                acp_profile_fingerprint TEXT,
                acp_runtime_epoch TEXT,
                acp_generation INTEGER,
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
            );
            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
                ON messages(conversation_id, created_at);",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        migrate_conversation_columns(&mut conn)?;

        Ok(Database {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    #[instrument(skip(self))]
    pub fn create_conversation(
        &self,
        title: &str,
        project_dir: Option<&str>,
    ) -> Result<Conversation, String> {
        self.create_conversation_with_agent(title, project_dir, None)
    }

    #[instrument(skip(self))]
    pub fn create_conversation_with_agent(
        &self,
        title: &str,
        project_dir: Option<&str>,
        agent_profile_id: Option<&str>,
    ) -> Result<Conversation, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let now: DateTime<Utc> = Utc::now();
        let now_str = now.to_rfc3339();

        conn.execute(
            "INSERT INTO conversations (id, title, project_dir, agent_profile_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, title, project_dir, agent_profile_id, now_str, now_str],
        )
        .map_err(|e| format!("Failed to create conversation: {}", e))?;

        Ok(Conversation {
            id,
            title: title.to_string(),
            project_dir: project_dir.map(str::to_string),
            agent_profile_id: agent_profile_id.map(str::to_string),
            acp_session_id: None,
            acp_profile_fingerprint: None,
            acp_runtime_epoch: None,
            acp_generation: None,
            created_at: now_str.clone(),
            updated_at: now_str,
        })
    }

    #[instrument(skip(self))]
    pub fn get_conversation(&self, id: &str) -> Result<Option<Conversation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, title, project_dir, agent_profile_id, acp_session_id, acp_profile_fingerprint, acp_runtime_epoch, acp_generation, created_at, updated_at FROM conversations WHERE id = ?1")
            .map_err(|e| e.to_string())?;

        stmt.query_row(params![id], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                project_dir: row.get(2)?,
                agent_profile_id: row.get(3)?,
                acp_session_id: row.get(4)?,
                acp_profile_fingerprint: row.get(5)?,
                acp_runtime_epoch: row.get(6)?,
                acp_generation: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())
    }

    #[instrument(skip(self))]
    pub fn list_conversations(&self) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, title, project_dir, agent_profile_id, acp_session_id, acp_profile_fingerprint, acp_runtime_epoch, acp_generation, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    project_dir: row.get(2)?,
                    agent_profile_id: row.get(3)?,
                    acp_session_id: row.get(4)?,
                    acp_profile_fingerprint: row.get(5)?,
                    acp_runtime_epoch: row.get(6)?,
                    acp_generation: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut conversations = Vec::new();
        for row in rows {
            conversations.push(row.map_err(|e| e.to_string())?);
        }
        Ok(conversations)
    }

    #[instrument(skip(self))]
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

    #[instrument(skip(self, session_id, profile_fingerprint, runtime_epoch))]
    pub fn set_acp_session_metadata(
        &self,
        id: &str,
        session_id: &str,
        profile_fingerprint: &str,
        runtime_epoch: &str,
        generation: i64,
    ) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE conversations
                 SET acp_session_id = ?1,
                     acp_profile_fingerprint = ?2,
                     acp_runtime_epoch = ?3,
                     acp_generation = ?4,
                     updated_at = ?5
                 WHERE id = ?6
                   AND (
                     acp_runtime_epoch IS NULL
                     OR acp_runtime_epoch != ?3
                     OR acp_generation IS NULL
                     OR acp_generation < ?4
                   )",
                params![
                    session_id,
                    profile_fingerprint,
                    runtime_epoch,
                    generation,
                    Utc::now().to_rfc3339(),
                    id
                ],
            )
            .map_err(|e| format!("Failed to update ACP session metadata: {e}"))?;
        if changed == 0 {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM conversations WHERE id = ?1)",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to verify conversation metadata target: {e}"))?;
            if !exists {
                return Err(format!("Conversation not found: {id}"));
            }
        }
        Ok(changed == 1)
    }

    #[instrument(skip(self, expected_session_id, expected_profile_fingerprint))]
    pub fn clear_acp_session_metadata_if_matches(
        &self,
        id: &str,
        expected_session_id: Option<&str>,
        expected_profile_fingerprint: Option<&str>,
    ) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE conversations
                 SET acp_session_id = NULL,
                     acp_profile_fingerprint = NULL,
                     acp_runtime_epoch = NULL,
                     acp_generation = NULL,
                     updated_at = ?1
                 WHERE id = ?2
                   AND acp_session_id IS ?3
                   AND acp_profile_fingerprint IS ?4",
                params![
                    Utc::now().to_rfc3339(),
                    id,
                    expected_session_id,
                    expected_profile_fingerprint
                ],
            )
            .map_err(|e| format!("Failed to clear ACP session metadata: {e}"))?;
        if changed == 0 {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM conversations WHERE id = ?1)",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to verify conversation metadata target: {e}"))?;
            if !exists {
                return Err(format!("Conversation not found: {id}"));
            }
        }
        Ok(changed == 1)
    }

    #[instrument(skip(self, content, reasoning_content))]
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

    #[instrument(skip(self, content, reasoning_content))]
    pub fn begin_acp_turn(
        &self,
        conversation_id: &str,
        generation: u64,
        content: &str,
        reasoning_content: Option<&str>,
    ) -> Result<(Message, String), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let transaction = conn
            .transaction()
            .map_err(|e| format!("Failed to start ACP turn transaction: {e}"))?;
        let dirty_key = format!("acp_dirty_turn:{conversation_id}");
        let existing: Option<String> = transaction
            .query_row(
                "SELECT value FROM kv_store WHERE key = ?1",
                params![dirty_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to inspect ACP turn ledger: {e}"))?;
        if existing.is_some() {
            return Err(
                "This conversation has an unfinished ACP turn. Start a new Agent Chat.".into(),
            );
        }

        let message_id = Uuid::new_v4().to_string();
        let turn_token = format!("{generation}:{}", Uuid::new_v4());
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO messages (id, conversation_id, role, content, reasoning_content, created_at)
                 VALUES (?1, ?2, 'user', ?3, ?4, ?5)",
                params![message_id, conversation_id, content, reasoning_content, now],
            )
            .map_err(|e| format!("Failed to save ACP user message: {e}"))?;
        let changed = transaction
            .execute(
                "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
                params![now, conversation_id],
            )
            .map_err(|e| format!("Failed to update ACP conversation timestamp: {e}"))?;
        if changed != 1 {
            return Err(format!("Conversation not found: {conversation_id}"));
        }
        transaction
            .execute(
                "INSERT INTO kv_store (key, value) VALUES (?1, ?2)",
                params![dirty_key, turn_token],
            )
            .map_err(|e| format!("Failed to mark ACP turn dirty: {e}"))?;
        transaction
            .commit()
            .map_err(|e| format!("Failed to commit ACP turn start: {e}"))?;

        Ok((
            Message {
                id: message_id,
                conversation_id: conversation_id.to_string(),
                role: "user".into(),
                content: content.to_string(),
                reasoning_content: reasoning_content.map(str::to_string),
                created_at: now,
            },
            turn_token,
        ))
    }

    #[instrument(skip(self, turn_token))]
    pub fn claim_acp_turn(&self, conversation_id: &str, turn_token: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let dirty_key = format!("acp_dirty_turn:{conversation_id}");
        let dispatched = format!("dispatched:{turn_token}");
        let changed = conn
            .execute(
                "UPDATE kv_store SET value = ?1 WHERE key = ?2 AND value = ?3",
                params![dispatched, dirty_key, turn_token],
            )
            .map_err(|e| format!("Failed to claim ACP turn dispatch: {e}"))?;
        Ok(changed == 1)
    }

    #[instrument(skip(self, turn_token, content, reasoning_content))]
    pub fn complete_acp_turn(
        &self,
        conversation_id: &str,
        turn_token: &str,
        content: &str,
        reasoning_content: Option<&str>,
    ) -> Result<Message, String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let transaction = conn
            .transaction()
            .map_err(|e| format!("Failed to start ACP completion transaction: {e}"))?;
        let dirty_key = format!("acp_dirty_turn:{conversation_id}");
        let persisted_token: Option<String> = transaction
            .query_row(
                "SELECT value FROM kv_store WHERE key = ?1",
                params![dirty_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to inspect ACP turn token: {e}"))?;
        let dispatched_token = format!("dispatched:{turn_token}");
        if persisted_token.as_deref() != Some(dispatched_token.as_str()) {
            return Err("ACP turn token is stale or missing".into());
        }

        let message_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO messages (id, conversation_id, role, content, reasoning_content, created_at)
                 VALUES (?1, ?2, 'assistant', ?3, ?4, ?5)",
                params![message_id, conversation_id, content, reasoning_content, now],
            )
            .map_err(|e| format!("Failed to save ACP assistant message: {e}"))?;
        let changed = transaction
            .execute(
                "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
                params![now, conversation_id],
            )
            .map_err(|e| format!("Failed to update ACP conversation timestamp: {e}"))?;
        if changed != 1 {
            return Err(format!("Conversation not found: {conversation_id}"));
        }
        let cleared = transaction
            .execute(
                "DELETE FROM kv_store WHERE key = ?1 AND value = ?2",
                params![dirty_key, dispatched_token],
            )
            .map_err(|e| format!("Failed to clear ACP turn token: {e}"))?;
        if cleared != 1 {
            return Err("ACP turn token changed before completion".into());
        }
        transaction
            .commit()
            .map_err(|e| format!("Failed to commit ACP turn completion: {e}"))?;

        Ok(Message {
            id: message_id,
            conversation_id: conversation_id.to_string(),
            role: "assistant".into(),
            content: content.to_string(),
            reasoning_content: reasoning_content.map(str::to_string),
            created_at: now,
        })
    }

    #[instrument(skip(self))]
    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT value FROM kv_store WHERE key = ?1")
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_row(params![key], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(result)
    }

    #[instrument(skip(self, value))]
    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO kv_store (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| format!("Failed to set kv: {}", e))?;
        Ok(())
    }

    #[instrument(skip(self))]
    pub fn kv_delete(&self, key: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM kv_store WHERE key = ?1", params![key])
            .map_err(|e| format!("Failed to delete kv: {}", e))?;
        Ok(())
    }

    #[instrument(skip(self))]
    pub fn get_messages(
        &self,
        conversation_id: &str,
        limit: Option<u32>,
        before: Option<&str>,
    ) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let limit = limit.unwrap_or(50).clamp(1, 100);
        let query = if before.is_some() {
            "SELECT id, conversation_id, role, content, reasoning_content, created_at
             FROM messages
             WHERE conversation_id = ?1 AND created_at < ?2
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?3"
        } else {
            "SELECT id, conversation_id, role, content, reasoning_content, created_at
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?2"
        };

        let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;

        let mut messages = Vec::new();
        if let Some(before) = before {
            let rows = stmt
                .query_map(params![conversation_id, before, limit], |row| {
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

            for row in rows {
                messages.push(row.map_err(|e| e.to_string())?);
            }
        } else {
            let rows = stmt
                .query_map(params![conversation_id, limit], |row| {
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

            for row in rows {
                messages.push(row.map_err(|e| e.to_string())?);
            }
        }

        messages.reverse();
        Ok(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        Database::new(":memory:").unwrap()
    }

    fn save_ordered_message(
        db: &Database,
        conversation_id: &str,
        role: &str,
        content: &str,
    ) -> Message {
        let message = db
            .save_message(conversation_id, role, content, None)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        message
    }

    #[test]
    fn create_conversation() {
        let db = test_db();
        let conv = db.create_conversation("Test Chat", None).unwrap();
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
        let first = db.create_conversation("First", None).unwrap();
        let second = db.create_conversation("Second", None).unwrap();

        let convs = db.list_conversations().unwrap();
        assert_eq!(convs.len(), 2);
        // Most recently created should be first (ORDER BY updated_at DESC)
        assert_eq!(convs[0].id, second.id);
        assert_eq!(convs[1].id, first.id);
    }

    #[test]
    fn update_conversation_title() {
        let db = test_db();
        let conv = db.create_conversation("Old Title", None).unwrap();
        db.update_conversation_title(&conv.id, "New Title").unwrap();

        let convs = db.list_conversations().unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].title, "New Title");
    }

    #[test]
    fn save_and_get_messages() {
        let db = test_db();
        let conv = db.create_conversation("Chat", None).unwrap();

        db.save_message(&conv.id, "user", "Hello", None).unwrap();
        db.save_message(&conv.id, "assistant", "Hi there", Some("thinking..."))
            .unwrap();

        let msgs = db.get_messages(&conv.id, None, None).unwrap();
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
        let conv = db.create_conversation("Empty", None).unwrap();
        let msgs = db.get_messages(&conv.id, None, None).unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn save_message_updates_conversation_timestamp() {
        let db = test_db();
        let conv = db.create_conversation("Chat", None).unwrap();
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
        let conv = db.create_conversation("Chat", None).unwrap();

        save_ordered_message(&db, &conv.id, "user", "First");
        save_ordered_message(&db, &conv.id, "assistant", "Second");
        save_ordered_message(&db, &conv.id, "user", "Third");

        let msgs = db.get_messages(&conv.id, None, None).unwrap();
        assert_eq!(msgs[0].content, "First");
        assert_eq!(msgs[1].content, "Second");
        assert_eq!(msgs[2].content, "Third");
    }

    #[test]
    fn get_messages_limits_to_latest_page() {
        let db = test_db();
        let conv = db.create_conversation("Chat", None).unwrap();

        save_ordered_message(&db, &conv.id, "user", "First");
        save_ordered_message(&db, &conv.id, "assistant", "Second");
        save_ordered_message(&db, &conv.id, "user", "Third");

        let msgs = db.get_messages(&conv.id, Some(2), None).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, "Second");
        assert_eq!(msgs[1].content, "Third");
    }

    #[test]
    fn get_messages_fetches_older_page_before_cursor() {
        let db = test_db();
        let conv = db.create_conversation("Chat", None).unwrap();

        let first = save_ordered_message(&db, &conv.id, "user", "First");
        save_ordered_message(&db, &conv.id, "assistant", "Second");
        let third = save_ordered_message(&db, &conv.id, "user", "Third");

        let msgs = db
            .get_messages(&conv.id, Some(2), Some(third.created_at.as_str()))
            .unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, first.content);
        assert_eq!(msgs[1].content, "Second");
    }

    #[test]
    fn kv_set_and_get() {
        let db = test_db();
        db.kv_set("hello", "world").unwrap();
        assert_eq!(db.kv_get("hello").unwrap(), Some("world".to_string()));
    }

    #[test]
    fn kv_get_missing() {
        let db = test_db();
        assert_eq!(db.kv_get("nonexistent").unwrap(), None);
    }

    #[test]
    fn kv_overwrite() {
        let db = test_db();
        db.kv_set("key", "first").unwrap();
        db.kv_set("key", "second").unwrap();
        assert_eq!(db.kv_get("key").unwrap(), Some("second".to_string()));
    }

    #[test]
    fn kv_delete() {
        let db = test_db();
        db.kv_set("key", "value").unwrap();
        db.kv_delete("key").unwrap();
        assert_eq!(db.kv_get("key").unwrap(), None);
    }

    #[test]
    fn kv_delete_missing() {
        let db = test_db();
        // Should not error
        db.kv_delete("nonexistent").unwrap();
    }

    #[test]
    fn messages_isolated_per_conversation() {
        let db = test_db();
        let conv1 = db.create_conversation("Chat 1", None).unwrap();
        let conv2 = db.create_conversation("Chat 2", None).unwrap();

        db.save_message(&conv1.id, "user", "In chat 1", None)
            .unwrap();
        db.save_message(&conv2.id, "user", "In chat 2", None)
            .unwrap();

        let msgs1 = db.get_messages(&conv1.id, None, None).unwrap();
        let msgs2 = db.get_messages(&conv2.id, None, None).unwrap();
        assert_eq!(msgs1.len(), 1);
        assert_eq!(msgs2.len(), 1);
        assert_eq!(msgs1[0].content, "In chat 1");
        assert_eq!(msgs2[0].content, "In chat 2");
    }

    #[test]
    fn old_conversation_schema_migrates_with_nullable_acp_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.db");
        let old = Connection::open(&path).unwrap();
        old.execute_batch(
            "CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO conversations VALUES ('legacy', 'Legacy', 'now', 'now');",
        )
        .unwrap();
        drop(old);

        let db = Database::new(path.to_str().unwrap()).unwrap();
        let legacy = db.get_conversation("legacy").unwrap().unwrap();
        assert_eq!(legacy.project_dir, None);
        assert_eq!(legacy.agent_profile_id, None);
        assert_eq!(legacy.acp_session_id, None);
        assert_eq!(legacy.acp_profile_fingerprint, None);
        assert_eq!(legacy.acp_runtime_epoch, None);
        assert_eq!(legacy.acp_generation, None);
    }

    #[test]
    fn acp_turn_ledger_atomically_blocks_overlap_and_completes() {
        let db = test_db();
        let conversation = db
            .create_conversation_with_agent("Agent", Some("/project"), Some("profile-a"))
            .unwrap();
        let (user, token) = db
            .begin_acp_turn(&conversation.id, 7, "hello", None)
            .unwrap();
        assert_eq!(user.role, "user");
        assert_eq!(
            db.kv_get(&format!("acp_dirty_turn:{}", conversation.id))
                .unwrap()
                .as_deref(),
            Some(token.as_str())
        );
        assert!(db
            .begin_acp_turn(&conversation.id, 7, "overlap", None)
            .unwrap_err()
            .contains("unfinished ACP turn"));

        assert!(db.claim_acp_turn(&conversation.id, &token).unwrap());
        assert!(!db.claim_acp_turn(&conversation.id, &token).unwrap());
        let assistant = db
            .complete_acp_turn(&conversation.id, &token, "answer", Some("thought"))
            .unwrap();
        assert_eq!(assistant.role, "assistant");
        assert_eq!(
            db.kv_get(&format!("acp_dirty_turn:{}", conversation.id))
                .unwrap(),
            None
        );
        let messages = db.get_messages(&conversation.id, None, None).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, user.id);
        assert_eq!(messages[1].id, assistant.id);
    }

    #[test]
    fn acp_turn_completion_requires_the_exact_dirty_token() {
        let db = test_db();
        let conversation = db
            .create_conversation_with_agent("Agent", Some("/project"), Some("profile-a"))
            .unwrap();
        let (_, token) = db
            .begin_acp_turn(&conversation.id, 3, "hello", None)
            .unwrap();
        assert!(db
            .complete_acp_turn(&conversation.id, "wrong-token", "answer", None)
            .unwrap_err()
            .contains("turn token"));
        assert_eq!(
            db.get_messages(&conversation.id, None, None).unwrap().len(),
            1
        );
        assert_eq!(
            db.kv_get(&format!("acp_dirty_turn:{}", conversation.id))
                .unwrap()
                .as_deref(),
            Some(token.as_str())
        );
    }

    #[test]
    fn acp_metadata_compare_and_set_rejects_stale_generations() {
        let db = test_db();
        let conversation = db
            .create_conversation_with_agent("Agent", Some("/project"), Some("profile-a"))
            .unwrap();
        assert!(db
            .set_acp_session_metadata(
                &conversation.id,
                "session-2",
                "sha256-profile",
                "runtime-a",
                2,
            )
            .unwrap());
        assert!(!db
            .set_acp_session_metadata(
                &conversation.id,
                "session-1",
                "sha256-stale",
                "runtime-a",
                1,
            )
            .unwrap());
        assert!(db
            .set_acp_session_metadata(
                &conversation.id,
                "session-new-runtime",
                "sha256-new",
                "runtime-b",
                1,
            )
            .unwrap());
        let loaded = db.get_conversation(&conversation.id).unwrap().unwrap();
        assert_eq!(
            loaded.acp_session_id.as_deref(),
            Some("session-new-runtime")
        );
        assert_eq!(loaded.acp_generation, Some(1));
        assert_eq!(loaded.acp_runtime_epoch.as_deref(), Some("runtime-b"));
        assert!(!db
            .clear_acp_session_metadata_if_matches(
                &conversation.id,
                Some("session-2"),
                Some("sha256-profile"),
            )
            .unwrap());
        assert!(db
            .clear_acp_session_metadata_if_matches(
                &conversation.id,
                Some("session-new-runtime"),
                Some("sha256-new"),
            )
            .unwrap());
    }

    #[test]
    fn acp_conversation_metadata_round_trips() {
        let db = test_db();
        let conversation = db
            .create_conversation_with_agent("Agent", Some("/project"), Some("profile-a"))
            .unwrap();
        assert!(db
            .set_acp_session_metadata(
                &conversation.id,
                "session-7",
                "sha256-profile",
                "runtime-a",
                7,
            )
            .unwrap());

        let loaded = db.get_conversation(&conversation.id).unwrap().unwrap();
        assert_eq!(loaded.project_dir.as_deref(), Some("/project"));
        assert_eq!(loaded.agent_profile_id.as_deref(), Some("profile-a"));
        assert_eq!(loaded.acp_session_id.as_deref(), Some("session-7"));
        assert_eq!(
            loaded.acp_profile_fingerprint.as_deref(),
            Some("sha256-profile")
        );
        assert_eq!(loaded.acp_runtime_epoch.as_deref(), Some("runtime-a"));
        assert_eq!(loaded.acp_generation, Some(7));
    }
}
