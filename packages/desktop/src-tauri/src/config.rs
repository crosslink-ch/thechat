use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_ACP_PROFILES: usize = 32;
pub const MAX_ACP_ARGS: usize = 64;
pub const MAX_ACP_ARG_BYTES: usize = 4096;
pub const MAX_ACP_ENV_VARS: usize = 64;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpProfile {
    pub id: String,
    pub name: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub inherit_env: Vec<String>,
    #[serde(default)]
    pub disabled: bool,
}

pub fn default_acp_profiles() -> Vec<AcpProfile> {
    vec![
        AcpProfile {
            id: "claude-agent-acp".into(),
            name: "Claude Agent".into(),
            executable: "npx".into(),
            args: vec![
                "-y".into(),
                "@agentclientprotocol/claude-agent-acp@0.70.0".into(),
            ],
            inherit_env: Vec::new(),
            disabled: false,
        },
        AcpProfile {
            id: "codex-acp".into(),
            name: "Codex".into(),
            executable: "npx".into(),
            args: vec!["-y".into(), "@agentclientprotocol/codex-acp@1.7.0".into()],
            inherit_env: Vec::new(),
            disabled: false,
        },
        AcpProfile {
            id: "opencode-acp".into(),
            name: "OpenCode".into(),
            executable: "opencode".into(),
            args: vec!["acp".into()],
            inherit_env: Vec::new(),
            disabled: false,
        },
    ]
}

fn default_acp_profile_id() -> Option<String> {
    Some("claude-agent-acp".into())
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|ch| matches!(ch, '_' | 'A'..='Z' | 'a'..='z' | '0'..='9'))
}

pub fn validate_config(config: &AppConfig) -> Result<(), String> {
    if config.acp_profiles.len() > MAX_ACP_PROFILES {
        return Err(format!(
            "at most {MAX_ACP_PROFILES} ACP profiles are allowed"
        ));
    }
    let mut ids = HashSet::with_capacity(config.acp_profiles.len());
    for profile in &config.acp_profiles {
        if !ids.insert(profile.id.as_str()) {
            return Err(format!("duplicate ACP profile id: {}", profile.id));
        }
        for name in &profile.inherit_env {
            if !valid_env_name(name) {
                return Err(format!(
                    "invalid environment variable name in ACP profile {}: {name}",
                    profile.id
                ));
            }
        }
        if profile.args.iter().any(|arg| arg.contains('\0')) {
            return Err(format!(
                "ACP profile {} contains a NUL in its literal arguments",
                profile.id
            ));
        }
        if profile.args.len() > MAX_ACP_ARGS
            || profile.args.iter().any(|arg| arg.len() > MAX_ACP_ARG_BYTES)
        {
            return Err(format!(
                "ACP profile {} has an oversized argument list",
                profile.id
            ));
        }
        if profile.inherit_env.len() > MAX_ACP_ENV_VARS {
            return Err(format!(
                "ACP profile {} has oversized environment settings",
                profile.id
            ));
        }
    }

    if config.acp_profiles.is_empty() {
        return if config.default_acp_profile_id.is_none() {
            Ok(())
        } else {
            Err("default ACP profile must be empty when no ACP profiles exist".into())
        };
    }
    let default_id = config
        .default_acp_profile_id
        .as_deref()
        .ok_or_else(|| "default ACP profile is required".to_string())?;
    let default = config
        .acp_profiles
        .iter()
        .find(|profile| profile.id == default_id)
        .ok_or_else(|| format!("default ACP profile does not exist: {default_id}"))?;
    if default.disabled {
        return Err(format!("default ACP profile is disabled: {default_id}"));
    }

    Ok(())
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvidersConfig {
    pub openrouter: ProviderConfig,
    pub codex: ProviderConfig,
    pub glm: ProviderConfig,
    #[serde(default = "default_featherless_provider")]
    pub featherless: ProviderConfig,
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
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<bool>,
    #[serde(default, rename = "apiKey", skip_serializing_if = "Option::is_none")]
    pub api_key: Option<bool>,
    #[serde(
        default,
        rename = "openrouterModel",
        skip_serializing_if = "Option::is_none"
    )]
    pub openrouter_model: Option<bool>,
    #[serde(
        default,
        rename = "codexModel",
        skip_serializing_if = "Option::is_none"
    )]
    pub codex_model: Option<bool>,
    #[serde(default, rename = "glmApiKey", skip_serializing_if = "Option::is_none")]
    pub glm_api_key: Option<bool>,
    #[serde(default, rename = "glmModel", skip_serializing_if = "Option::is_none")]
    pub glm_model: Option<bool>,
    #[serde(
        default,
        rename = "featherlessApiKey",
        skip_serializing_if = "Option::is_none"
    )]
    pub featherless_api_key: Option<bool>,
    #[serde(
        default,
        rename = "featherlessModel",
        skip_serializing_if = "Option::is_none"
    )]
    pub featherless_model: Option<bool>,
    #[serde(
        default,
        rename = "reasoningEffort",
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning_effort: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glm_api_key: Option<String>,
    #[serde(
        default,
        rename = "glmPlanType",
        skip_serializing_if = "Option::is_none"
    )]
    pub glm_plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub featherless_api_key: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default, rename = "reasoningEffort")]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub providers: ProvidersConfig,
    #[serde(default, rename = "mcpServers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
    #[serde(
        default,
        rename = "inheritWorkspaceId",
        skip_serializing_if = "Option::is_none"
    )]
    pub inherit_workspace_id: Option<String>,
    #[serde(
        default,
        rename = "localOverrides",
        skip_serializing_if = "Option::is_none"
    )]
    pub local_overrides: Option<LocalOverrides>,
    #[serde(default = "default_acp_profiles", rename = "acpProfiles")]
    pub acp_profiles: Vec<AcpProfile>,
    #[serde(
        default = "default_acp_profile_id",
        rename = "defaultAcpProfileId",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_acp_profile_id: Option<String>,
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

fn write_config_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Config path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create config directory: {error}"))?;
    #[cfg(unix)]
    if path.exists() {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure existing config: {error}"))?;
    }
    #[allow(unused_mut)]
    let mut options = atomic_write_file::AtomicWriteFile::options();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open config for writing: {error}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("Failed to write config: {error}"))?;
    file.commit()
        .map_err(|error| format!("Failed to atomically replace config: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure config permissions: {error}"))?;
    }
    Ok(())
}

pub fn load_or_create_acp_fingerprint_key(base: &Path) -> Result<Vec<u8>, String> {
    fs::create_dir_all(base)
        .map_err(|error| format!("Failed to create config directory: {error}"))?;
    let path = base.join("acp-fingerprint.key");
    let read_key = || -> Result<Vec<u8>, String> {
        let key = fs::read(&path)
            .map_err(|error| format!("Failed to read ACP fingerprint key: {error}"))?;
        if key.len() != 32 {
            return Err("ACP fingerprint key has an invalid length".into());
        }
        Ok(key)
    };
    if path.exists() {
        return read_key();
    }

    let mut key = Vec::with_capacity(32);
    key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(&key)
                .map_err(|error| format!("Failed to write ACP fingerprint key: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Failed to sync ACP fingerprint key: {error}"))?;
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_key(),
        Err(error) => Err(format!("Failed to create ACP fingerprint key: {error}")),
    }
}

fn effective_config_dir(base: &Path) -> PathBuf {
    if let Ok(dir) = std::env::var("THECHAT_DATA_DIR") {
        PathBuf::from(dir)
    } else {
        base.to_path_buf()
    }
}

/// Resolve the config path: in dev mode, use `config.json` at the monorepo
/// root (derived from `CARGO_MANIFEST_DIR` at compile time); otherwise fall
/// back to the provided base config directory.
///
/// E2E tests set `THECHAT_DATA_DIR` for isolation; in that case we skip the
/// dev-mode lookup so the test never accidentally reads or writes a
/// developer's local `config.json`.
pub fn resolve_config_path(base: &Path) -> PathBuf {
    let effective_base = effective_config_dir(base);
    if std::env::var_os("THECHAT_DATA_DIR").is_some() {
        return config_file_path(&effective_base);
    }
    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = packages/desktop/src-tauri → repo root is 3 levels up
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        return repo_root.join("config.json");
    }
    config_file_path(&effective_base)
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
        provider: None,
        reasoning_effort: None,
        providers: ProvidersConfig::default(),
        mcp_servers,
        inherit_workspace_id: None,
        local_overrides: None,
        acp_profiles: default_acp_profiles(),
        default_acp_profile_id: default_acp_profile_id(),
    }
}

fn create_default_config(base: &Path) -> Result<AppConfig, String> {
    let config_path = resolve_config_path(base);

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let config = default_config(&backend_url());
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize default config: {}", e))?;

    write_config_file(&config_path, &json)?;

    Ok(config)
}

pub fn save_config(config: &AppConfig, base: &Path) -> Result<(), String> {
    validate_config(config)?;
    let config_path = resolve_config_path(base);

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    write_config_file(&config_path, &json)?;

    Ok(())
}

pub fn load_config(base: &Path) -> Result<AppConfig, String> {
    let path = resolve_config_path(base);
    if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read config at {}: {}", path.display(), e))?;
        let config: AppConfig =
            serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;

        validate_config(&config)?;

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
        assert_eq!(config.providers.featherless.model, "zai-org/GLM-5.1");
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
        assert!(
            exa.headers.is_empty(),
            "exa should have no headers by default (free tier)"
        );
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
        config.providers.codex.model = "gpt-5.5".to_string();

        let json = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, &json).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        let loaded: AppConfig = serde_json::from_str(&content).unwrap();
        assert_eq!(loaded.api_key, "sk-saved");
        assert_eq!(loaded.providers.codex.model, "gpt-5.5");
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

    #[test]
    fn old_config_gets_pinned_acp_presets_and_valid_default() {
        let config: AppConfig = serde_json::from_str(r#"{"api_key":"legacy"}"#).unwrap();

        assert_eq!(config.acp_profiles.len(), 3);
        assert_eq!(
            config.default_acp_profile_id.as_deref(),
            Some("claude-agent-acp")
        );
        assert_eq!(
            config.acp_profiles[0].args,
            vec!["-y", "@agentclientprotocol/claude-agent-acp@0.70.0"]
        );
        assert_eq!(
            config.acp_profiles[1].args,
            vec!["-y", "@agentclientprotocol/codex-acp@1.7.0"]
        );
        assert_eq!(config.acp_profiles[2].args, vec!["acp"]);
    }

    #[test]
    fn acp_profile_json_never_contains_environment_values() {
        let profile = default_acp_profiles().remove(0);
        let serialized = serde_json::to_value(profile).unwrap();

        assert!(serialized.get("env").is_none(), "{serialized}");
        assert!(serialized.get("inheritEnv").is_some(), "{serialized}");
    }

    #[test]
    fn config_validation_rejects_duplicate_profile_ids() {
        let mut config = default_config(DEFAULT_BACKEND_URL);
        config.acp_profiles[1].id = config.acp_profiles[0].id.clone();

        let error = validate_config(&config).unwrap_err();
        assert!(error.contains("duplicate ACP profile id"), "{error}");
    }

    #[test]
    fn config_validation_rejects_missing_or_disabled_default_profile() {
        let mut config = default_config(DEFAULT_BACKEND_URL);
        config.default_acp_profile_id = Some("missing".into());
        assert!(validate_config(&config)
            .unwrap_err()
            .contains("default ACP profile"));

        config.default_acp_profile_id = Some(config.acp_profiles[0].id.clone());
        config.acp_profiles[0].disabled = true;
        assert!(validate_config(&config).unwrap_err().contains("disabled"));
    }

    #[test]
    fn config_validation_rejects_invalid_environment_names() {
        let mut config = default_config(DEFAULT_BACKEND_URL);
        config.acp_profiles[0].inherit_env = vec!["GOOD_NAME".into(), "BAD-NAME".into()];

        let error = validate_config(&config).unwrap_err();
        assert!(
            error.contains("invalid environment variable name"),
            "{error}"
        );
    }

    #[test]
    fn config_validation_rejects_nul_in_literal_arguments() {
        let mut config = default_config(DEFAULT_BACKEND_URL);
        config.acp_profiles[0]
            .args
            .push("safe\0still-not-an-argv".into());

        let error = validate_config(&config).unwrap_err();
        assert!(error.contains("NUL"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn config_file_write_uses_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        write_config_file(&path, "{}").unwrap();

        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn config_validation_bounds_literal_arguments() {
        let mut config = default_config(DEFAULT_BACKEND_URL);
        config.acp_profiles[0].args = vec!["x".repeat(MAX_ACP_ARG_BYTES + 1)];

        let error = validate_config(&config).unwrap_err();
        assert!(error.contains("argument"), "{error}");
    }
}
