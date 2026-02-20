use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_key: String,
    pub model: String,
    #[serde(default, rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

pub fn load_config() -> Result<AppConfig, String> {
    // Try project root first (development), then app data dir
    let paths: Vec<PathBuf> = vec![
        // CWD (project root in production)
        PathBuf::from("config.json"),
        // Parent of CWD (dev mode CWD is src-tauri/, config is in project root)
        PathBuf::from("../config.json"),
        // Alongside the executable
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("config.json")))
            .unwrap_or_default(),
        // App data directory
        dirs::config_dir()
            .map(|p| p.join("thechat").join("config.json"))
            .unwrap_or_default(),
    ];

    for path in &paths {
        if path.exists() {
            let content = fs::read_to_string(path)
                .map_err(|e| format!("Failed to read config at {}: {}", path.display(), e))?;
            let config: AppConfig = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            return Ok(config);
        }
    }

    Err("config.json not found. Create one with {\"api_key\": \"...\", \"model\": \"...\"}".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_config() {
        let json = r#"{"api_key": "sk-test-123", "model": "gpt-4"}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.api_key, "sk-test-123");
        assert_eq!(config.model, "gpt-4");
    }

    #[test]
    fn parse_invalid_json() {
        let result = serde_json::from_str::<AppConfig>("not json");
        assert!(result.is_err());
    }

    #[test]
    fn parse_missing_fields() {
        let json = r#"{"api_key": "sk-test"}"#;
        let result = serde_json::from_str::<AppConfig>(json);
        assert!(result.is_err());
    }

    #[test]
    fn load_config_from_temp_file() {
        let dir = std::env::temp_dir().join("thechat_config_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, r#"{"api_key": "key", "model": "m"}"#).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let config: AppConfig = serde_json::from_str(&content).unwrap();
        assert_eq!(config.api_key, "key");
        assert_eq!(config.model, "m");

        std::fs::remove_dir_all(dir).ok();
    }
}
