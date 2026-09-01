use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tracing::instrument;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub project_dir: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesTaskProject {
    pub id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesTaskProjectAssignment {
    pub thread_id: String,
    pub project_id: String,
}

const HERMES_TASK_PROJECT_COLORS: &[&str] = &["blue", "violet", "emerald", "amber", "rose", "cyan"];
const HERMES_TASK_PROJECT_NAME_MAX_CHARS: usize = 80;

fn validate_local_scope(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    Ok(())
}

fn normalize_hermes_task_project_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }
    if name.chars().count() > HERMES_TASK_PROJECT_NAME_MAX_CHARS {
        return Err(format!(
            "Project name cannot exceed {HERMES_TASK_PROJECT_NAME_MAX_CHARS} characters"
        ));
    }
    Ok(name.to_string())
}

fn validate_hermes_task_project_color(color: &str) -> Result<(), String> {
    if !HERMES_TASK_PROJECT_COLORS.contains(&color) {
        return Err("Project color is not supported".to_string());
    }
    Ok(())
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    #[instrument]
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn = Connection::open(db_path).map_err(|e| format!("Failed to open DB: {}", e))?;

        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS conversations (
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
            );
            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            -- Hermes task projects intentionally live only in this device's
            -- SQLite database. Their scope columns prevent local metadata from
            -- leaking between signed-in users or Hermes conversations.
            CREATE TABLE IF NOT EXISTS hermes_task_projects (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                name TEXT NOT NULL COLLATE NOCASE,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE (user_id, conversation_id, name),
                UNIQUE (id, user_id, conversation_id)
            );
            CREATE TABLE IF NOT EXISTS hermes_task_project_assignments (
                user_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                assigned_at TEXT NOT NULL,
                PRIMARY KEY (user_id, conversation_id, thread_id),
                FOREIGN KEY (project_id, user_id, conversation_id)
                    REFERENCES hermes_task_projects(id, user_id, conversation_id)
                    ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
                ON messages(conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_hermes_task_projects_scope_position
                ON hermes_task_projects(user_id, conversation_id, position);",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        // Migrations
        conn.execute_batch("ALTER TABLE conversations ADD COLUMN project_dir TEXT;")
            .ok(); // Ignore error if column already exists

        Ok(Database {
            conn: Mutex::new(conn),
        })
    }

    #[instrument(skip(self))]
    pub fn create_conversation(
        &self,
        title: &str,
        project_dir: Option<&str>,
    ) -> Result<Conversation, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        let now: DateTime<Utc> = Utc::now();
        let now_str = now.to_rfc3339();

        conn.execute(
            "INSERT INTO conversations (id, title, project_dir, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, title, project_dir, now_str, now_str],
        )
        .map_err(|e| format!("Failed to create conversation: {}", e))?;

        Ok(Conversation {
            id,
            title: title.to_string(),
            project_dir: project_dir.map(|s| s.to_string()),
            created_at: now_str.clone(),
            updated_at: now_str,
        })
    }

    #[instrument(skip(self))]
    pub fn get_conversation(&self, id: &str) -> Result<Option<Conversation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, title, project_dir, created_at, updated_at FROM conversations WHERE id = ?1")
            .map_err(|e| e.to_string())?;

        stmt.query_row(params![id], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                project_dir: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())
    }

    #[instrument(skip(self))]
    pub fn list_conversations(&self) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, title, project_dir, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    project_dir: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
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
    pub fn list_hermes_task_projects(
        &self,
        user_id: &str,
        conversation_id: &str,
    ) -> Result<Vec<HermesTaskProject>, String> {
        validate_local_scope(user_id, "User ID")?;
        validate_local_scope(conversation_id, "Conversation ID")?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, color, position, created_at, updated_at
                 FROM hermes_task_projects
                 WHERE user_id = ?1 AND conversation_id = ?2
                 ORDER BY position ASC, created_at ASC, id ASC",
            )
            .map_err(|e| format!("Failed to prepare project list: {e}"))?;
        let rows = stmt
            .query_map(params![user_id, conversation_id], |row| {
                Ok(HermesTaskProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    position: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| format!("Failed to list projects: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read projects: {e}"))
    }

    #[instrument(skip(self))]
    pub fn create_hermes_task_project(
        &self,
        user_id: &str,
        conversation_id: &str,
        name: &str,
        color: &str,
    ) -> Result<HermesTaskProject, String> {
        validate_local_scope(user_id, "User ID")?;
        validate_local_scope(conversation_id, "Conversation ID")?;
        let name = normalize_hermes_task_project_name(name)?;
        validate_hermes_task_project_color(color)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM hermes_task_projects
                    WHERE user_id = ?1 AND conversation_id = ?2
                      AND name = ?3 COLLATE NOCASE
                )",
                params![user_id, conversation_id, name],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to validate project name: {e}"))?;
        if exists {
            return Err("A project with this name already exists".to_string());
        }

        let position: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0)
                 FROM hermes_task_projects
                 WHERE user_id = ?1 AND conversation_id = ?2",
                params![user_id, conversation_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to choose project position: {e}"))?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO hermes_task_projects
                (id, user_id, conversation_id, name, color, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, user_id, conversation_id, name, color, position, now],
        )
        .map_err(|e| format!("Failed to create project: {e}"))?;

        Ok(HermesTaskProject {
            id,
            name,
            color: color.to_string(),
            position,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    #[instrument(skip(self))]
    pub fn update_hermes_task_project(
        &self,
        user_id: &str,
        conversation_id: &str,
        project_id: &str,
        name: &str,
        color: &str,
    ) -> Result<HermesTaskProject, String> {
        validate_local_scope(user_id, "User ID")?;
        validate_local_scope(conversation_id, "Conversation ID")?;
        validate_local_scope(project_id, "Project ID")?;
        let name = normalize_hermes_task_project_name(name)?;
        validate_hermes_task_project_color(color)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let duplicate: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM hermes_task_projects
                    WHERE user_id = ?1 AND conversation_id = ?2
                      AND name = ?3 COLLATE NOCASE AND id != ?4
                )",
                params![user_id, conversation_id, name, project_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to validate project name: {e}"))?;
        if duplicate {
            return Err("A project with this name already exists".to_string());
        }

        let now = Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE hermes_task_projects
                 SET name = ?1, color = ?2, updated_at = ?3
                 WHERE id = ?4 AND user_id = ?5 AND conversation_id = ?6",
                params![name, color, now, project_id, user_id, conversation_id],
            )
            .map_err(|e| format!("Failed to update project: {e}"))?;
        if changed == 0 {
            return Err("Project not found in this local conversation".to_string());
        }

        conn.query_row(
            "SELECT id, name, color, position, created_at, updated_at
             FROM hermes_task_projects
             WHERE id = ?1 AND user_id = ?2 AND conversation_id = ?3",
            params![project_id, user_id, conversation_id],
            |row| {
                Ok(HermesTaskProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    position: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .map_err(|e| format!("Failed to read updated project: {e}"))
    }

    #[instrument(skip(self))]
    pub fn delete_hermes_task_project(
        &self,
        user_id: &str,
        conversation_id: &str,
        project_id: &str,
    ) -> Result<(), String> {
        validate_local_scope(user_id, "User ID")?;
        validate_local_scope(conversation_id, "Conversation ID")?;
        validate_local_scope(project_id, "Project ID")?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "DELETE FROM hermes_task_projects
                 WHERE id = ?1 AND user_id = ?2 AND conversation_id = ?3",
                params![project_id, user_id, conversation_id],
            )
            .map_err(|e| format!("Failed to delete project: {e}"))?;
        if changed == 0 {
            return Err("Project not found in this local conversation".to_string());
        }
        Ok(())
    }

    #[instrument(skip(self))]
    pub fn list_hermes_task_project_assignments(
        &self,
        user_id: &str,
        conversation_id: &str,
    ) -> Result<Vec<HermesTaskProjectAssignment>, String> {
        validate_local_scope(user_id, "User ID")?;
        validate_local_scope(conversation_id, "Conversation ID")?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT assignment.thread_id, assignment.project_id
                 FROM hermes_task_project_assignments AS assignment
                 INNER JOIN hermes_task_projects AS project
                   ON project.id = assignment.project_id
                  AND project.user_id = assignment.user_id
                  AND project.conversation_id = assignment.conversation_id
                 WHERE assignment.user_id = ?1 AND assignment.conversation_id = ?2
                 ORDER BY assignment.assigned_at ASC, assignment.thread_id ASC",
            )
            .map_err(|e| format!("Failed to prepare project assignments: {e}"))?;
        let rows = stmt
            .query_map(params![user_id, conversation_id], |row| {
                Ok(HermesTaskProjectAssignment {
                    thread_id: row.get(0)?,
                    project_id: row.get(1)?,
                })
            })
            .map_err(|e| format!("Failed to list project assignments: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read project assignments: {e}"))
    }

    #[instrument(skip(self))]
    pub fn assign_hermes_task_to_project(
        &self,
        user_id: &str,
        conversation_id: &str,
        thread_id: &str,
        project_id: Option<&str>,
    ) -> Result<(), String> {
        validate_local_scope(user_id, "User ID")?;
        validate_local_scope(conversation_id, "Conversation ID")?;
        validate_local_scope(thread_id, "Thread ID")?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let Some(project_id) = project_id else {
            conn.execute(
                "DELETE FROM hermes_task_project_assignments
                 WHERE user_id = ?1 AND conversation_id = ?2 AND thread_id = ?3",
                params![user_id, conversation_id, thread_id],
            )
            .map_err(|e| format!("Failed to unfile task: {e}"))?;
            return Ok(());
        };
        validate_local_scope(project_id, "Project ID")?;

        let project_exists: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM hermes_task_projects
                    WHERE id = ?1 AND user_id = ?2 AND conversation_id = ?3
                )",
                params![project_id, user_id, conversation_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to validate project assignment: {e}"))?;
        if !project_exists {
            return Err("Project not found in this local conversation".to_string());
        }

        conn.execute(
            "INSERT INTO hermes_task_project_assignments
                (user_id, conversation_id, thread_id, project_id, assigned_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id, conversation_id, thread_id)
             DO UPDATE SET project_id = excluded.project_id,
                           assigned_at = excluded.assigned_at",
            params![
                user_id,
                conversation_id,
                thread_id,
                project_id,
                Utc::now().to_rfc3339()
            ],
        )
        .map_err(|e| format!("Failed to file task in project: {e}"))?;
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
    fn hermes_task_projects_persist_across_database_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thechat.db");
        let path = path.to_str().unwrap();
        let project_id;

        {
            let db = Database::new(path).unwrap();
            let project = db
                .create_hermes_task_project("user-a", "conversation-a", "Website refresh", "violet")
                .unwrap();
            project_id = project.id.clone();
            db.assign_hermes_task_to_project(
                "user-a",
                "conversation-a",
                "thread-a",
                Some(&project.id),
            )
            .unwrap();
        }

        let reopened = Database::new(path).unwrap();
        let projects = reopened
            .list_hermes_task_projects("user-a", "conversation-a")
            .unwrap();
        let assignments = reopened
            .list_hermes_task_project_assignments("user-a", "conversation-a")
            .unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, project_id);
        assert_eq!(projects[0].name, "Website refresh");
        assert_eq!(projects[0].color, "violet");
        assert_eq!(assignments.len(), 1);
        assert_eq!(assignments[0].thread_id, "thread-a");
        assert_eq!(assignments[0].project_id, project_id);
    }

    #[test]
    fn hermes_task_projects_are_scoped_by_user_and_conversation() {
        let db = test_db();
        db.create_hermes_task_project("user-a", "conversation-a", "Launch", "blue")
            .unwrap();
        db.create_hermes_task_project("user-a", "conversation-b", "Launch", "emerald")
            .unwrap();
        db.create_hermes_task_project("user-b", "conversation-a", "Launch", "amber")
            .unwrap();

        assert_eq!(
            db.list_hermes_task_projects("user-a", "conversation-a")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            db.list_hermes_task_projects("user-a", "conversation-b")
                .unwrap()[0]
                .color,
            "emerald"
        );
        assert!(db
            .create_hermes_task_project("user-a", "conversation-a", "launch", "rose")
            .unwrap_err()
            .contains("already exists"));
    }

    #[test]
    fn hermes_task_assignments_move_unfile_and_follow_project_deletion() {
        let db = test_db();
        let first = db
            .create_hermes_task_project("user-a", "conversation-a", "First", "blue")
            .unwrap();
        let second = db
            .create_hermes_task_project("user-a", "conversation-a", "Second", "rose")
            .unwrap();

        db.assign_hermes_task_to_project("user-a", "conversation-a", "thread-a", Some(&first.id))
            .unwrap();
        db.assign_hermes_task_to_project("user-a", "conversation-a", "thread-a", Some(&second.id))
            .unwrap();
        let moved = db
            .list_hermes_task_project_assignments("user-a", "conversation-a")
            .unwrap();
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].project_id, second.id);

        db.assign_hermes_task_to_project("user-a", "conversation-a", "thread-a", None)
            .unwrap();
        assert!(db
            .list_hermes_task_project_assignments("user-a", "conversation-a")
            .unwrap()
            .is_empty());

        db.assign_hermes_task_to_project("user-a", "conversation-a", "thread-a", Some(&second.id))
            .unwrap();
        db.delete_hermes_task_project("user-a", "conversation-a", &second.id)
            .unwrap();
        assert!(db
            .list_hermes_task_project_assignments("user-a", "conversation-a")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn hermes_task_projects_validate_local_scope_and_fields() {
        let db = test_db();
        let project = db
            .create_hermes_task_project("user-a", "conversation-a", "Launch", "cyan")
            .unwrap();

        assert!(db
            .assign_hermes_task_to_project(
                "user-a",
                "conversation-b",
                "thread-a",
                Some(&project.id),
            )
            .unwrap_err()
            .contains("not found"));
        assert!(db
            .create_hermes_task_project("user-a", "conversation-a", "   ", "blue")
            .is_err());
        assert!(db
            .create_hermes_task_project("user-a", "conversation-a", &"a".repeat(81), "blue",)
            .is_err());
        assert!(db
            .create_hermes_task_project("user-a", "conversation-a", "Other", "chartreuse")
            .is_err());
    }
}
