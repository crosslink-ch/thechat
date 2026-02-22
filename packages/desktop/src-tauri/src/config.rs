use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default, rename = "requiresAuth")]
    pub requires_auth: bool,
    #[serde(default)]
    pub lazy: bool,
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
        McpServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some(format!("{}/mcp", backend_url)),
            headers: HashMap::new(),
            requires_auth: true,
            lazy: false,
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
            "api_key": "k", "model": "m",
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "server"], "env": {} }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        let srv = &config.mcp_servers["fs"];
        assert_eq!(srv.command.as_deref(), Some("npx"));
        assert!(srv.url.is_none());
    }

    #[test]
    fn parse_http_mcp_server() {
        let json = r#"{
            "api_key": "k", "model": "m",
            "mcpServers": {
                "remote": { "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer tok"} }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        let srv = &config.mcp_servers["remote"];
        assert!(srv.command.is_none());
        assert_eq!(srv.url.as_deref(), Some("https://example.com/mcp"));
        assert_eq!(srv.headers.get("Authorization").unwrap(), "Bearer tok");
    }

    #[test]
    fn parse_mcp_server_no_transport_deserializes() {
        // Deserialization succeeds — validation happens at init time
        let json = r#"{
            "api_key": "k", "model": "m",
            "mcpServers": { "bad": {} }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        let srv = &config.mcp_servers["bad"];
        assert!(srv.command.is_none());
        assert!(srv.url.is_none());
    }

    #[test]
    fn parse_lazy_mcp_server() {
        let json = r#"{
            "api_key": "k", "model": "m",
            "mcpServers": {
                "kubectl": { "command": "npx", "args": ["-y", "@kubectl/mcp"], "lazy": true }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        let srv = &config.mcp_servers["kubectl"];
        assert!(srv.lazy, "kubectl server should be lazy");
    }

    #[test]
    fn lazy_defaults_to_false() {
        let json = r#"{
            "api_key": "k", "model": "m",
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "server"] }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        let srv = &config.mcp_servers["fs"];
        assert!(!srv.lazy, "lazy should default to false");
    }

    #[test]
    fn default_config_has_thechat_mcp() {
        let config = default_config(DEFAULT_BACKEND_URL);
        assert_eq!(config.api_key, "");
        assert_eq!(config.model, "openai/gpt-4.1");
        let srv = &config.mcp_servers["thechat"];
        assert_eq!(srv.url.as_deref(), Some("http://localhost:3000/mcp"));
        assert!(srv.command.is_none());
        assert!(srv.requires_auth, "thechat MCP server should require auth");
    }

    #[test]
    fn default_config_uses_custom_backend_url() {
        let config = default_config("https://api.thechat.app");
        let srv = &config.mcp_servers["thechat"];
        assert_eq!(srv.url.as_deref(), Some("https://api.thechat.app/mcp"));
    }

    #[test]
    fn default_config_roundtrips_through_json() {
        let config = default_config(DEFAULT_BACKEND_URL);
        let json = serde_json::to_string_pretty(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.api_key, "");
        assert_eq!(parsed.model, "openai/gpt-4.1");
        assert_eq!(
            parsed.mcp_servers["thechat"].url.as_deref(),
            Some("http://localhost:3000/mcp")
        );
    }
}
