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
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub model: String,
}

fn default_featherless_provider() -> ProviderConfig {
    ProviderConfig {
        model: "zai-org/GLM-5.1".to_string(),
    }
}

fn default_azulai_provider() -> ProviderConfig {
    ProviderConfig {
        model: "meta-llama/Meta-Llama-3.1-8B-Instruct".to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvidersConfig {
    pub openrouter: ProviderConfig,
    pub codex: ProviderConfig,
    pub glm: ProviderConfig,
    #[serde(default = "default_featherless_provider")]
    pub featherless: ProviderConfig,
    #[serde(default = "default_azulai_provider")]
    pub azulai: ProviderConfig,
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
            glm: ProviderConfig {
                model: "glm-5.1".to_string(),
            },
            featherless: default_featherless_provider(),
            azulai: default_azulai_provider(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<bool>,
    #[serde(default, rename = "apiKey", skip_serializing_if = "Option::is_none")]
    pub api_key: Option<bool>,
    #[serde(default, rename = "openrouterModel", skip_serializing_if = "Option::is_none")]
    pub openrouter_model: Option<bool>,
    #[serde(default, rename = "codexModel", skip_serializing_if = "Option::is_none")]
    pub codex_model: Option<bool>,
    #[serde(default, rename = "glmApiKey", skip_serializing_if = "Option::is_none")]
    pub glm_api_key: Option<bool>,
    #[serde(default, rename = "glmModel", skip_serializing_if = "Option::is_none")]
    pub glm_model: Option<bool>,
    #[serde(default, rename = "featherlessApiKey", skip_serializing_if = "Option::is_none")]
    pub featherless_api_key: Option<bool>,
    #[serde(default, rename = "featherlessModel", skip_serializing_if = "Option::is_none")]
    pub featherless_model: Option<bool>,
    #[serde(default, rename = "azulaiApiUrl", skip_serializing_if = "Option::is_none")]
    pub azulai_api_url: Option<bool>,
    #[serde(default, rename = "azulaiApiKey", skip_serializing_if = "Option::is_none")]
    pub azulai_api_key: Option<bool>,
    #[serde(default, rename = "azulaiModel", skip_serializing_if = "Option::is_none")]
    pub azulai_model: Option<bool>,
    #[serde(default, rename = "reasoningEffort", skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glm_api_key: Option<String>,
    #[serde(default, rename = "glmPlanType", skip_serializing_if = "Option::is_none")]
    pub glm_plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub featherless_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub azulai_api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub azulai_api_key: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default, rename = "reasoningEffort")]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub providers: ProvidersConfig,
    #[serde(default, rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
    #[serde(default, rename = "inheritWorkspaceId", skip_serializing_if = "Option::is_none")]
    pub inherit_workspace_id: Option<String>,
    #[serde(default, rename = "localOverrides", skip_serializing_if = "Option::is_none")]
    pub local_overrides: Option<LocalOverrides>,
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

/// Resolve the config path: in dev mode, use `config.json` at the monorepo
/// root (derived from `CARGO_MANIFEST_DIR` at compile time); otherwise fall
/// back to the provided base config directory.
///
/// E2E tests set `THECHAT_DATA_DIR` for isolation; in that case we skip the
/// dev-mode lookup so the test never accidentally reads or writes a
/// developer's local `config.json`.
pub fn resolve_config_path(base: &Path) -> PathBuf {
    if std::env::var_os("THECHAT_DATA_DIR").is_some() {
        return config_file_path(base);
    }
    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = packages/desktop/src-tauri → repo root is 3 levels up
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..");
        return repo_root.join("config.json");
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
            disabled: false,
        },
    );
    mcp_servers.insert(
        "exa".to_string(),
        McpServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some("https://mcp.exa.ai/mcp".to_string()),
            headers: HashMap::new(),
            requires_auth: false,
            lazy: false,
            disabled: false,
        },
    );
    AppConfig {
        api_key: String::new(),
        glm_api_key: None,
        glm_plan_type: None,
        featherless_api_key: None,
        azulai_api_url: None,
        azulai_api_key: None,
        provider: None,
        reasoning_effort: None,
        providers: ProvidersConfig::default(),
        mcp_servers,
        inherit_workspace_id: None,
        local_overrides: None,
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
        let config: AppConfig =
            serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;

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
                "glm": { "model": "glm-5.1" }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.api_key, "sk-test-123");
        assert_eq!(config.providers.openrouter.model, "openai/gpt-4.1");
        assert_eq!(config.providers.codex.model, "gpt-5.4");
        assert_eq!(config.providers.glm.model, "glm-5.1");
        // azulai defaults when not in JSON
        assert_eq!(config.providers.azulai.model, "meta-llama/Meta-Llama-3.1-8B-Instruct");
    }

    #[test]
    fn parse_azulai_provider() {
        let json = r#"{
            "api_key": "sk-test",
            "provider": "azulai",
            "azulai_api_url": "https://api.azulai.example.com",
            "azulai_api_key": "az-key-123",
            "providers": {
                "openrouter": { "model": "openai/gpt-4.1" },
                "codex": { "model": "gpt-5.4" },
                "glm": { "model": "glm-5.1" },
                "azulai": { "model": "custom-model" }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.provider.as_deref(), Some("azulai"));
        assert_eq!(config.azulai_api_url.as_deref(), Some("https://api.azulai.example.com"));
        assert_eq!(config.azulai_api_key.as_deref(), Some("az-key-123"));
        assert_eq!(config.providers.azulai.model, "custom-model");
    }

    #[test]
    fn parse_invalid_json() {
        let result = serde_json::from_str::<AppConfig>("not json");
        assert!(result.is_err());
    }

    #[test]
    fn parse_missing_api_key() {
        let json = r#"{"providers": {"openrouter": {"model": "m"}, "codex": {"model": "m"}, "glm": {"model": "m"}}}"#;
        let result = serde_json::from_str::<AppConfig>(json);
        assert!(result.is_err());
    }

    #[test]
    fn reasoning_effort_serialized() {
        let mut config = default_config(DEFAULT_BACKEND_URL);
        config.reasoning_effort = Some("high".to_string());
        let json = serde_json::to_string_pretty(&config).unwrap();
        assert!(json.contains("\"reasoningEffort\": \"high\""));
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
    fn parse_http_mcp_server_custom_headers() {
        let json = r#"{
            "api_key": "k",
            "mcpServers": {
                "exa": { "url": "https://mcp.exa.ai/mcp", "headers": {"x-api-key": "exa-key-123"} }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        let srv = &config.mcp_servers["exa"];
        assert_eq!(srv.url.as_deref(), Some("https://mcp.exa.ai/mcp"));
        assert_eq!(srv.headers.get("x-api-key").unwrap(), "exa-key-123");
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
        assert_eq!(config.providers.glm.model, "glm-5.1");
        assert_eq!(
            config.providers.featherless.model,
            "zai-org/GLM-5.1"
        );
        assert_eq!(
            config.providers.azulai.model,
            "meta-llama/Meta-Llama-3.1-8B-Instruct"
        );
        assert!(config.azulai_api_url.is_none());
        assert!(config.azulai_api_key.is_none());
        let srv = &config.mcp_servers["thechat"];
        assert_eq!(srv.url.as_deref(), Some("http://localhost:3000/mcp"));
        assert!(srv.command.is_none());
        assert!(srv.requires_auth, "thechat MCP server should require auth");
        assert!(srv.lazy, "thechat MCP server should be lazy");

        let exa = &config.mcp_servers["exa"];
        assert_eq!(exa.url.as_deref(), Some("https://mcp.exa.ai/mcp"));
        assert!(exa.command.is_none());
        assert!(!exa.requires_auth, "exa should not require auth");
        assert!(!exa.lazy, "exa should not be lazy");
        assert!(!exa.disabled, "exa should be enabled by default");
        assert!(exa.headers.is_empty(), "exa should have no headers by default (free tier)");
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
        assert_eq!(
            parsed.mcp_servers["exa"].url.as_deref(),
            Some("https://mcp.exa.ai/mcp")
        );
    }
}
