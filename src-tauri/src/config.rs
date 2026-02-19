use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub api_key: String,
    pub model: String,
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
