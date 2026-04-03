use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
pub struct ProviderConfig {
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvidersConfig {
    pub openrouter: ProviderConfig,
    pub codex: ProviderConfig,
    pub anthropic: ProviderConfig,
}

impl Default for ProvidersConfig {
    fn default() -> Self {
        Self {
            openrouter: ProviderConfig {
                model: "openai/gpt-4.1".to_string(),
            },
            codex: ProviderConfig {
                model: "gpt-5.4".to_string(),
            },
            anthropic: ProviderConfig {
                model: "claude-sonnet-4-6".to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_key: String,
    /// Legacy field — migrated into `providers` on load. Not written back.
    #[serde(default, skip_serializing)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default, rename = "reasoningEffort")]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub providers: ProvidersConfig,
    #[serde(default, rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

pub const DEFAULT_BACKEND_URL: &str = "http://localhost:3000";

pub fn backend_url() -> String {
    std::env::var("THECHAT_BACKEND_URL").unwrap_or_else(|_| {
        option_env!("THECHAT_BACKEND_URL")
            .unwrap_or(DEFAULT_BACKEND_URL)
            .to_string()
    })
}

pub fn config_file_path(base: &Path) -> PathBuf {
    base.join("config.json")
}

/// Resolve the config path: in dev mode, prefer a CWD-relative config.json if it exists;
/// otherwise fall back to the provided base config directory.
pub fn resolve_config_path(base: &Path) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev_paths = [
            PathBuf::from("config.json"),
            PathBuf::from("../config.json"),
            PathBuf::from("../../config.json"),
            PathBuf::from("../../../config.json"),
        ];
        for path in &dev_paths {
            if path.exists() {
                return path.clone();
            }
        }
    }
    config_file_path(base)
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
            lazy: true,
        },
    );
    AppConfig {
        api_key: String::new(),
        model: None,
        provider: None,
        reasoning_effort: None,
        providers: ProvidersConfig::default(),
        mcp_servers,
    }
}

fn create_default_config(base: &Path) -> Result<AppConfig, String> {
    let config_path = config_file_path(base);

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let config = default_config(&backend_url());
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize default config: {}", e))?;

    fs::write(&config_path, &json).map_err(|e| format!("Failed to write default config: {}", e))?;

    Ok(config)
}

pub fn save_config(config: &AppConfig, base: &Path) -> Result<(), String> {
    let config_path = resolve_config_path(base);

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(&config_path, &json).map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

pub fn load_config(base: &Path) -> Result<AppConfig, String> {
    let path = resolve_config_path(base);
    if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read config at {}: {}", path.display(), e))?;
        let mut config: AppConfig =
            serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;

        // Migrate legacy `model` field into per-provider config
        if let Some(model) = config.model.take() {
            let provider = config.provider.as_deref().unwrap_or("openrouter");
            match provider {
                "codex" => config.providers.codex.model = model,
                "anthropic" => config.providers.anthropic.model = model,
                _ => config.providers.openrouter.model = model,
            }
        }

        return Ok(config);
    }

    // No config found — create default
    create_default_config(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_new_config_format() {
        let json = r#"{
            "api_key": "sk-test-123",
            "provider": "openrouter",
            "providers": {
                "openrouter": { "model": "openai/gpt-4.1" },
                "codex": { "model": "gpt-5.4" },
                "anthropic": { "model": "claude-sonnet-4-6" }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.api_key, "sk-test-123");
        assert_eq!(config.providers.openrouter.model, "openai/gpt-4.1");
        assert_eq!(config.providers.codex.model, "gpt-5.4");
    }

    #[test]
    fn parse_legacy_config_with_model_field() {
        // Old configs have a top-level "model" — should deserialize and be available for migration
        let json = r#"{"api_key": "sk-test", "model": "gpt-4"}"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.api_key, "sk-test");
        assert_eq!(config.model, Some("gpt-4".to_string()));
        // providers should have defaults since they weren't in the JSON
        assert_eq!(config.providers.openrouter.model, "openai/gpt-4.1");
    }

    #[test]
    fn parse_invalid_json() {
        let result = serde_json::from_str::<AppConfig>("not json");
        assert!(result.is_err());
    }

    #[test]
    fn parse_missing_api_key() {
        let json = r#"{"providers": {"openrouter": {"model": "m"}, "codex": {"model": "m"}, "anthropic": {"model": "m"}}}"#;
        let result = serde_json::from_str::<AppConfig>(json);
        assert!(result.is_err());
    }

    #[test]
    fn legacy_config_migration() {
        // Simulate loading a legacy config with model field
        let json = r#"{"api_key": "key", "model": "my-model", "provider": "anthropic"}"#;
        let mut config: AppConfig = serde_json::from_str(json).unwrap();

        // Apply the same migration as load_config
        if let Some(model) = config.model.take() {
            let provider = config.provider.as_deref().unwrap_or("openrouter");
            match provider {
                "codex" => config.providers.codex.model = model,
                "anthropic" => config.providers.anthropic.model = model,
                _ => config.providers.openrouter.model = model,
            }
        }

        assert_eq!(config.providers.anthropic.model, "my-model");
        // Other providers keep defaults
        assert_eq!(config.providers.openrouter.model, "openai/gpt-4.1");
    }

    #[test]
    fn top_level_model_field_not_serialized() {
        let config = default_config(DEFAULT_BACKEND_URL);
        let json = serde_json::to_string_pretty(&config).unwrap();
        // Parse back as generic JSON and check there's no top-level "model" key
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            value.get("model").is_none(),
            "top-level model field should not be serialized"
        );
    }

    #[test]
    fn reasoning_effort_serialized() {
        let mut config = default_config(DEFAULT_BACKEND_URL);
        config.reasoning_effort = Some("high".to_string());
        let json = serde_json::to_string_pretty(&config).unwrap();
        assert!(json.contains("\"reasoningEffort\": \"high\""));
    }

    #[test]
    fn load_config_from_temp_file() {
        let dir = std::env::temp_dir().join("thechat_config_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            r#"{"api_key": "key", "model": "m", "provider": "openrouter"}"#,
        )
        .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let mut config: AppConfig = serde_json::from_str(&content).unwrap();
        // Apply migration
        if let Some(model) = config.model.take() {
            config.providers.openrouter.model = model;
        }
        assert_eq!(config.api_key, "key");
        assert_eq!(config.providers.openrouter.model, "m");

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn parse_stdio_mcp_server() {
        let json = r#"{
            "api_key": "k",
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
            "api_key": "k",
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
        let json = r#"{
            "api_key": "k",
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
            "api_key": "k",
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
            "api_key": "k",
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
        assert_eq!(config.providers.openrouter.model, "openai/gpt-4.1");
        assert_eq!(config.providers.codex.model, "gpt-5.4");
        assert_eq!(config.providers.anthropic.model, "claude-sonnet-4-6");
        let srv = &config.mcp_servers["thechat"];
        assert_eq!(srv.url.as_deref(), Some("http://localhost:3000/mcp"));
        assert!(srv.command.is_none());
        assert!(srv.requires_auth, "thechat MCP server should require auth");
        assert!(srv.lazy, "thechat MCP server should be lazy");
    }

    #[test]
    fn default_config_uses_custom_backend_url() {
        let config = default_config("https://api.thechat.app");
        let srv = &config.mcp_servers["thechat"];
        assert_eq!(srv.url.as_deref(), Some("https://api.thechat.app/mcp"));
    }

    #[test]
    fn save_config_roundtrip() {
        let dir = std::env::temp_dir().join("thechat_save_config_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");

        let mut config = default_config(DEFAULT_BACKEND_URL);
        config.api_key = "sk-saved".to_string();
        config.provider = Some("codex".to_string());
        config.providers.codex.model = "gpt-5.3-codex".to_string();

        let json = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, &json).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let loaded: AppConfig = serde_json::from_str(&content).unwrap();
        assert_eq!(loaded.api_key, "sk-saved");
        assert_eq!(loaded.providers.codex.model, "gpt-5.3-codex");
        assert_eq!(loaded.provider.as_deref(), Some("codex"));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn default_config_roundtrips_through_json() {
        let config = default_config(DEFAULT_BACKEND_URL);
        let json = serde_json::to_string_pretty(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.api_key, "");
        assert_eq!(parsed.providers.openrouter.model, "openai/gpt-4.1");
        assert_eq!(
            parsed.mcp_servers["thechat"].url.as_deref(),
            Some("http://localhost:3000/mcp")
        );
    }
}
