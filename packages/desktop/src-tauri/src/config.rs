use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpServerConfig {
    Http {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: HashMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_key: String,
    pub model: String,
    #[serde(default, rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

pub const DEFAULT_BACKEND_URL: &str = "http://localhost:3000";

pub fn backend_url() -> String {
    std::env::var("THECHAT_BACKEND_URL").unwrap_or_else(|_| DEFAULT_BACKEND_URL.to_string())
}

fn config_dir_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("thechat").join("config.json"))
}

fn default_config(backend_url: &str) -> AppConfig {
    let mut mcp_servers = HashMap::new();
    mcp_servers.insert(
        "thechat".to_string(),
        McpServerConfig::Http {
            url: format!("{}/mcp", backend_url),
            headers: HashMap::new(),
        },
    );
    AppConfig {
        api_key: String::new(),
        model: "openai/gpt-4.1".to_string(),
        mcp_servers,
    }
}

fn create_default_config() -> Result<AppConfig, String> {
    let config_path = config_dir_path()
        .ok_or("Could not determine config directory")?;

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let config = default_config(&backend_url());
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize default config: {}", e))?;

    fs::write(&config_path, &json)
        .map_err(|e| format!("Failed to write default config: {}", e))?;

    Ok(config)
}

pub fn load_config() -> Result<AppConfig, String> {
    // Try project root first (development), then app data dir
    let paths: Vec<PathBuf> = vec![
        // CWD (project root in production)
        PathBuf::from("config.json"),
        // Parent of CWD (dev mode CWD is src-tauri/, config is in packages/desktop/)
        PathBuf::from("../config.json"),
        // Monorepo root when CWD is packages/desktop/src-tauri/
        PathBuf::from("../../config.json"),
        // Extra safety net (monorepo root from deeper nesting)
        PathBuf::from("../../../config.json"),
        // Alongside the executable
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("config.json")))
            .unwrap_or_default(),
        // App data directory
        config_dir_path().unwrap_or_default(),
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

    // No config found — create default at ~/.config/thechat/config.json
    create_default_config()
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

    #[test]
    fn parse_stdio_mcp_server() {
        let json = r#"{
            "api_key": "key",
            "model": "m",
            "mcpServers": {
                "exa": {
                    "command": "npx",
                    "args": ["-y", "exa-mcp-server"],
                    "env": {"EXA_API_KEY": "abc"}
                }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        match &config.mcp_servers["exa"] {
            McpServerConfig::Stdio { command, args, env } => {
                assert_eq!(command, "npx");
                assert_eq!(args, &["-y", "exa-mcp-server"]);
                assert_eq!(env["EXA_API_KEY"], "abc");
            }
            _ => panic!("Expected Stdio variant"),
        }
    }

    #[test]
    fn parse_http_mcp_server() {
        let json = r#"{
            "api_key": "key",
            "model": "m",
            "mcpServers": {
                "thechat": {
                    "url": "http://localhost:3000/mcp"
                }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        match &config.mcp_servers["thechat"] {
            McpServerConfig::Http { url, headers } => {
                assert_eq!(url, "http://localhost:3000/mcp");
                assert!(headers.is_empty());
            }
            _ => panic!("Expected Http variant"),
        }
    }

    #[test]
    fn parse_http_mcp_server_with_headers() {
        let json = r#"{
            "api_key": "key",
            "model": "m",
            "mcpServers": {
                "thechat": {
                    "url": "http://localhost:3000/mcp",
                    "headers": {"authorization": "Bearer tok123"}
                }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        match &config.mcp_servers["thechat"] {
            McpServerConfig::Http { url, headers } => {
                assert_eq!(url, "http://localhost:3000/mcp");
                assert_eq!(headers["authorization"], "Bearer tok123");
            }
            _ => panic!("Expected Http variant"),
        }
    }

    #[test]
    fn parse_mixed_mcp_servers() {
        let json = r#"{
            "api_key": "key",
            "model": "m",
            "mcpServers": {
                "thechat": {
                    "url": "http://localhost:3000/mcp"
                },
                "exa": {
                    "command": "npx",
                    "args": ["-y", "exa-mcp-server"]
                }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert!(matches!(config.mcp_servers["thechat"], McpServerConfig::Http { .. }));
        assert!(matches!(config.mcp_servers["exa"], McpServerConfig::Stdio { .. }));
    }

    #[test]
    fn default_config_has_thechat_mcp() {
        let config = default_config(DEFAULT_BACKEND_URL);
        assert_eq!(config.api_key, "");
        assert_eq!(config.model, "openai/gpt-4.1");
        match &config.mcp_servers["thechat"] {
            McpServerConfig::Http { url, .. } => {
                assert_eq!(url, "http://localhost:3000/mcp");
            }
            _ => panic!("Expected Http variant"),
        }
    }

    #[test]
    fn default_config_uses_custom_backend_url() {
        let config = default_config("https://api.thechat.app");
        match &config.mcp_servers["thechat"] {
            McpServerConfig::Http { url, .. } => {
                assert_eq!(url, "https://api.thechat.app/mcp");
            }
            _ => panic!("Expected Http variant"),
        }
    }

    #[test]
    fn default_config_roundtrips_through_json() {
        let config = default_config(DEFAULT_BACKEND_URL);
        let json = serde_json::to_string_pretty(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.api_key, "");
        assert_eq!(parsed.model, "openai/gpt-4.1");
        assert!(matches!(parsed.mcp_servers["thechat"], McpServerConfig::Http { .. }));
    }
}
