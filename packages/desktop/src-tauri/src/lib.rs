pub mod acp;
mod attachment_download;
mod config;
mod db;
mod env;
mod file_drop;
mod fs;
mod mcp;
mod oauth;
mod shell;
mod stream;

use db::{Conversation, Database, Message};
use mcp::McpManager;
use oauth::OAuthCallbackServer;
use serde::Serialize;
use shell::ShellProcesses;
use std::sync::Arc;
use stream::{CodexTransport, StreamCancellers};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[cfg(desktop)]
const DEVELOPMENT_IDENTIFIER: &str = "com.bruno.thechat.dev";
#[cfg(desktop)]
const DEVELOPMENT_WINDOW_TITLE: &str = "TheChat Dev";

#[cfg(desktop)]
fn flavor_window_title(identifier: &str) -> Option<&'static str> {
    (identifier == DEVELOPMENT_IDENTIFIER).then_some(DEVELOPMENT_WINDOW_TITLE)
}

#[cfg(feature = "otel")]
static OTEL_PROVIDER: std::sync::OnceLock<opentelemetry_sdk::trace::SdkTracerProvider> =
    std::sync::OnceLock::new();

fn log_level_from_env() -> log::LevelFilter {
    let val = std::env::var("THECHAT_LOG_LEVEL")
        .unwrap_or_default()
        .to_lowercase();
    match val.as_str() {
        "trace" => log::LevelFilter::Trace,
        "debug" => log::LevelFilter::Debug,
        "info" => log::LevelFilter::Info,
        "warn" | "warning" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        "off" | "none" => log::LevelFilter::Off,
        _ => {
            if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            }
        }
    }
}

/// Initialize the tracing subscriber stack.
///
/// The stderr fmt layer is only enabled when `THECHAT_TRACING` is explicitly set,
/// so the app can detach from the console during normal usage. tokio-console
/// and OTel layers are always active when their features are enabled.
///
/// `THECHAT_TRACING` uses `tracing` EnvFilter syntax: `target=level` pairs
/// separated by commas. The target is typically the crate name. A bare level
/// (no target) sets the default for all crates.
///
/// Examples:
///   THECHAT_TRACING=thechat=trace          — our code at trace, others at default
///   THECHAT_TRACING=thechat=trace,warn     — our code at trace, everything else at warn
///   THECHAT_TRACING=thechat=debug,reqwest=info,warn  — per-crate control
///   THECHAT_TRACING=trace                  — everything at trace (very noisy)
fn init_tracing() {
    // Only enable the stderr fmt layer when THECHAT_TRACING is explicitly set.
    // This lets the app detach from the console during normal usage.
    let fmt_layer = std::env::var("THECHAT_TRACING").ok().map(|val| {
        let env_filter = EnvFilter::new(val);
        let fmt = fmt::layer().with_target(true).with_thread_ids(true);
        fmt.with_filter(env_filter)
    });

    let registry = tracing_subscriber::registry().with(fmt_layer);

    #[cfg(feature = "tokio-console")]
    let registry = registry.with(console_subscriber::spawn());

    #[cfg(feature = "otel")]
    let registry = {
        use opentelemetry::trace::TracerProvider as _;
        use opentelemetry_otlp::SpanExporter;
        use opentelemetry_sdk::trace::SdkTracerProvider;
        use opentelemetry_sdk::Resource;

        let exporter = SpanExporter::builder()
            .with_http()
            .build()
            .expect("failed to create OTLP span exporter");

        let provider = SdkTracerProvider::builder()
            .with_resource(Resource::builder().with_service_name("thechat").build())
            .with_batch_exporter(exporter)
            .build();

        opentelemetry::global::set_tracer_provider(provider.clone());
        let tracer = provider.tracer("thechat");
        let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

        OTEL_PROVIDER
            .set(provider)
            .expect("OTel provider already set");

        registry.with(otel_layer)
    };

    // Use set_global_default instead of .init() to avoid calling
    // tracing_log::LogTracer::init(), which would conflict with tauri-plugin-log
    // setting the global `log` logger.
    tracing::subscriber::set_global_default(registry).expect("failed to set tracing subscriber");
}

/// Directory watched by the local Promtail/Grafana dev stack (see compose.yml).
///
/// Honors `THECHAT_DEV_LOGS_DIR` when set. Dev builds fall back to the repo's
/// `.tmp/dev` directory — the same default as `scripts/dev.py` — so desktop
/// logs show up in local Grafana without extra configuration. Release builds
/// return `None` unless the env var is set explicitly.
fn dev_logs_dir() -> Option<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("THECHAT_DEV_LOGS_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Some(std::path::PathBuf::from(dir));
        }
    }
    if cfg!(debug_assertions) {
        return Some(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.tmp/dev"),
        );
    }
    None
}

/// Format a log record as the single-line JSON shape the local Promtail
/// pipeline expects: `level` as a lowercase string, `time` in unix
/// milliseconds, message in `msg` (see deployment/local/promtail.yml).
fn dev_log_json_line(time_ms: u128, level: log::Level, target: &str, message: &str) -> String {
    serde_json::json!({
        "time": time_ms as u64,
        "level": level.as_str().to_lowercase(),
        "target": target,
        "msg": message,
    })
    .to_string()
}

/// Replica of tauri-plugin-log's default human-readable format. Formats are
/// applied per-target (the root dispatch is a passthrough) because the
/// dev-logs target uses JSON while stdout and the platform log dir keep this
/// shape.
fn human_log_target(kind: tauri_plugin_log::TargetKind) -> tauri_plugin_log::Target {
    tauri_plugin_log::Target::new(kind).format(|out, message, record| {
        out.finish(format_args!(
            "{}[{}][{}] {}",
            chrono::Utc::now().format("[%Y-%m-%d][%H:%M:%S]"),
            record.target(),
            record.level(),
            message
        ));
    })
}

/// Log target that mirrors records as Promtail-compatible JSON into
/// `<dir>/desktop.log` so the desktop app shows up in local Grafana.
fn dev_log_target(dir: std::path::PathBuf) -> tauri_plugin_log::Target {
    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
        path: dir,
        file_name: Some("desktop".into()),
    })
    .format(|out, message, record| {
        let time_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        out.finish(format_args!(
            "{}",
            dev_log_json_line(
                time_ms,
                record.level(),
                record.target(),
                &message.to_string()
            )
        ));
    })
}

/// The configured tauri-plugin-log builder used by `run()`. Public so the
/// integration test can exercise the exact logging pipeline.
#[doc(hidden)]
pub fn log_plugin_builder() -> tauri_plugin_log::Builder {
    // The root dispatch is a passthrough and each target formats itself —
    // fern applies the root format before per-target formats, so a formatted
    // root would feed already-formatted lines into the JSON target below.
    let mut log_builder = tauri_plugin_log::Builder::new()
        .level(log_level_from_env())
        .format(|out, message, _record| out.finish(format_args!("{message}")))
        .targets([
            human_log_target(tauri_plugin_log::TargetKind::Stdout),
            human_log_target(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
        ]);
    if let Some(dir) = dev_logs_dir() {
        // Mirror logs as JSON into the Promtail-watched dev logs dir so the
        // desktop app shows up in local Grafana (job=thechat-desktop).
        log_builder = log_builder
            .max_file_size(10 * 1024 * 1024)
            .target(dev_log_target(dir));
    }
    log_builder
}

type DbState = Arc<Database>;
type AcpState = Arc<acp::AcpManager>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpPromptCommandResult {
    conversation_id: String,
    generation: u64,
    turn_id: String,
    stop_reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpProbeResult {
    profile_id: String,
    resolved_executable: String,
    protocol_version: String,
    agent_name: Option<String>,
    agent_version: Option<String>,
    capabilities: acp::AcpCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpConversationMetadata {
    conversation_id: String,
    agent_profile_id: Option<String>,
    project_dir: Option<String>,
    acp_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpTurnStartResult {
    message: Message,
    turn_token: String,
}

pub struct InitialProjectDir(pub Option<String>);

/// Resolve the DB path using the same logic as the Tauri setup.
/// Used by CLI flags that need to read the DB without starting the app.
fn release_db_path(data_dir: &std::path::Path, app_identifier: &str) -> std::path::PathBuf {
    data_dir.join(app_identifier).join("thechat.db")
}

pub fn resolve_db_path(app_identifier: &str) -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("THECHAT_DATA_DIR") {
        let dir = std::path::PathBuf::from(dir);
        dir.join("thechat.db")
    } else if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dev.db")
    } else {
        let data_dir = dirs::data_dir().expect("Failed to resolve data directory");
        release_db_path(&data_dir, app_identifier)
    }
}

/// Read the API token from the database without starting the Tauri app.
pub fn get_api_token(app_identifier: &str) -> Result<Option<String>, String> {
    let db_path = resolve_db_path(app_identifier);
    let db = Database::new(db_path.to_str().unwrap())?;
    db.kv_get("auth_access_token")
}

/// Resolve the directory used for config.json, skills lookup, etc.
///
/// E2E tests set `THECHAT_DATA_DIR` to a tmp path so each run is isolated
/// and never touches the developer's real `~/.config/com.bruno.thechat/`.
/// When the env var is set we use it directly (creating it if needed);
/// otherwise we fall back to Tauri's platform-specific app config dir.
fn resolve_config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(dir) = std::env::var("THECHAT_DATA_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create THECHAT_DATA_DIR: {}", e))?;
        return Ok(dir);
    }
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn acp_event_sink(channel: Channel<acp::AcpEvent>) -> acp::AcpEventSink {
    acp::AcpEventSink::new(move |event| channel.send(event).map_err(|error| error.to_string()))
}

fn validated_acp_resume_session_id(
    saved_session_id: Option<String>,
    saved_fingerprint: Option<&str>,
    current_fingerprint: &str,
) -> Result<Option<String>, String> {
    match (saved_session_id, saved_fingerprint) {
        (Some(session_id), Some(saved)) if saved == current_fingerprint => Ok(Some(session_id)),
        (Some(_), _) => Err(
            "The ACP profile changed since this conversation was created. Start a new Agent Chat to use the changed profile."
                .into(),
        ),
        (None, _) => Ok(None),
    }
}

fn clear_failed_acp_resume_metadata(
    database: &db::Database,
    conversation: &db::Conversation,
) -> Result<(), String> {
    let cleared = database.clear_acp_session_metadata_if_matches(
        &conversation.id,
        conversation.acp_session_id.as_deref(),
        conversation.acp_profile_fingerprint.as_deref(),
        conversation.acp_runtime_epoch.as_deref(),
        conversation.acp_generation,
    )?;
    if cleared {
        Ok(())
    } else {
        Err("ACP resume metadata changed before failed-resume cleanup".into())
    }
}

fn bundled_node_bin_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let resource = app
        .path()
        .resource_dir()
        .ok()
        .map(|directory| directory.join("resources/node"));
    let development = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/node");
    resource
        .filter(|directory| directory.is_dir())
        .or_else(|| development.is_dir().then_some(development))
}

async fn configured_acp_profile(
    app: &tauri::AppHandle,
    profile_id: &str,
) -> Result<config::AcpProfile, String> {
    let config_dir = resolve_config_dir(app)?;
    let profile_id = profile_id.to_string();
    tokio::task::spawn_blocking(move || {
        let config = config::load_config(&config_dir)?;
        let profile = config
            .acp_profiles
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| "ACP profile not found".to_string())?;
        if profile.disabled {
            return Err("ACP profile is disabled".into());
        }
        Ok(profile)
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))?
}

#[tauri::command]
#[tracing::instrument(skip(app))]
async fn get_config(app: tauri::AppHandle) -> Result<config::AppConfig, String> {
    let config_dir = resolve_config_dir(&app)?;
    tokio::task::spawn_blocking(move || config::load_config(&config_dir))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(app))]
fn get_config_path(app: tauri::AppHandle) -> Result<String, String> {
    let config_dir = resolve_config_dir(&app)?;
    Ok(config::resolve_config_path(&config_dir)
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
#[tracing::instrument(skip(config, app))]
async fn save_config(config: config::AppConfig, app: tauri::AppHandle) -> Result<(), String> {
    let config_dir = resolve_config_dir(&app)?;
    tokio::task::spawn_blocking(move || config::save_config(&config, &config_dir))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(app))]
fn get_app_config_dir(app: tauri::AppHandle) -> Result<String, String> {
    let config_dir = resolve_config_dir(&app)?;
    Ok(config_dir.to_string_lossy().into_owned())
}

#[tauri::command]
#[tracing::instrument(skip(db))]
async fn create_conversation(
    title: String,
    project_dir: Option<String>,
    agent_profile_id: Option<String>,
    db: State<'_, DbState>,
) -> Result<Conversation, String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || {
        db.create_conversation_with_agent(
            &title,
            project_dir.as_deref(),
            agent_profile_id.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(db))]
async fn get_conversation(
    id: String,
    db: State<'_, DbState>,
) -> Result<Option<Conversation>, String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.get_conversation(&id))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(db))]
async fn list_conversations(db: State<'_, DbState>) -> Result<Vec<Conversation>, String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.list_conversations())
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(db))]
async fn update_conversation_title(
    id: String,
    title: String,
    db: State<'_, DbState>,
) -> Result<(), String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.update_conversation_title(&id, &title))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(db, content, reasoning_content))]
async fn save_message(
    conversation_id: String,
    role: String,
    content: String,
    reasoning_content: Option<String>,
    db: State<'_, DbState>,
) -> Result<Message, String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || {
        db.save_message(
            &conversation_id,
            &role,
            &content,
            reasoning_content.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(db))]
async fn get_messages(
    conversation_id: String,
    limit: Option<u32>,
    before: Option<String>,
    db: State<'_, DbState>,
) -> Result<Vec<Message>, String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.get_messages(&conversation_id, limit, before.as_deref()))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(db))]
async fn kv_get(key: String, db: State<'_, DbState>) -> Result<Option<String>, String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.kv_get(&key))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(db, value))]
async fn kv_set(key: String, value: String, db: State<'_, DbState>) -> Result<(), String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.kv_set(&key, &value))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(db))]
async fn kv_delete(key: String, db: State<'_, DbState>) -> Result<(), String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.kv_delete(&key))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
#[tracing::instrument(skip(content, reasoning_content, db, manager))]
async fn acp_begin_turn(
    conversation_id: String,
    generation: u64,
    content: String,
    reasoning_content: Option<String>,
    db: State<'_, DbState>,
    manager: State<'_, AcpState>,
) -> Result<AcpTurnStartResult, String> {
    manager
        .assert_current_generation(&conversation_id, generation)
        .await?;
    if content.len() > 20 * 1024 * 1024
        || reasoning_content
            .as_ref()
            .is_some_and(|reasoning| reasoning.len() > 2 * 1024 * 1024)
    {
        return Err("ACP transcript message exceeds the resource limit".into());
    }
    let db = Arc::clone(&db);
    let result = tokio::task::spawn_blocking(move || {
        db.begin_acp_turn(
            &conversation_id,
            generation,
            &content,
            reasoning_content.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))??;
    Ok(AcpTurnStartResult {
        message: result.0,
        turn_token: result.1,
    })
}

#[tauri::command]
#[tracing::instrument(skip(turn_token, db, manager))]
async fn acp_abort_turn(
    conversation_id: String,
    generation: u64,
    turn_token: String,
    db: State<'_, DbState>,
    manager: State<'_, AcpState>,
) -> Result<(), String> {
    if manager.latest_generation(&conversation_id).await != Some(generation) {
        return Err("Stale ACP generation".into());
    }
    let db = Arc::clone(&db);
    let aborted = tokio::task::spawn_blocking(move || {
        db.abort_pending_acp_turn(&conversation_id, generation, &turn_token)
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))??;
    if !aborted {
        return Err("ACP turn was already dispatched or its token is stale".into());
    }
    Ok(())
}

#[tauri::command]
#[tracing::instrument(skip(turn_token, content, reasoning_content, db, manager))]
async fn acp_complete_turn(
    conversation_id: String,
    generation: u64,
    turn_token: String,
    content: String,
    reasoning_content: Option<String>,
    db: State<'_, DbState>,
    manager: State<'_, AcpState>,
) -> Result<Message, String> {
    if manager.latest_generation(&conversation_id).await != Some(generation) {
        return Err("Stale ACP generation".into());
    }
    if content.len() > 20 * 1024 * 1024
        || reasoning_content
            .as_ref()
            .is_some_and(|reasoning| reasoning.len() > 2 * 1024 * 1024)
    {
        return Err("ACP transcript message exceeds the resource limit".into());
    }
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || {
        db.complete_acp_turn(
            &conversation_id,
            &turn_token,
            &content,
            reasoning_content.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))?
}

#[tauri::command]
#[tracing::instrument(skip(app, db, manager, shell_env, on_event))]
async fn acp_connect(
    conversation_id: String,
    generation: u64,
    on_event: Channel<acp::AcpEvent>,
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, AcpState>,
    shell_env: State<'_, Arc<env::ShellEnv>>,
) -> Result<acp::AcpSessionInfo, String> {
    let db_for_read = Arc::clone(&db);
    let lookup_id = conversation_id.clone();
    let conversation =
        tokio::task::spawn_blocking(move || db_for_read.get_conversation(&lookup_id))
            .await
            .map_err(|error| format!("Task join error: {error}"))??
            .ok_or_else(|| "Conversation not found".to_string())?;
    let dirty_key = format!("acp_dirty_turn:{conversation_id}");
    let db_for_dirty = Arc::clone(&db);
    let has_dirty_turn = tokio::task::spawn_blocking(move || db_for_dirty.kv_get(&dirty_key))
        .await
        .map_err(|error| format!("Task join error: {error}"))??
        .is_some();
    if has_dirty_turn {
        manager
            .stop_session_up_to_generation(&conversation_id, generation)
            .await?;
        return Err(
            "The previous ACP turn may not have been fully persisted. Start a new Agent Chat before resuming this agent session."
                .into(),
        );
    }
    let profile_id = conversation
        .agent_profile_id
        .clone()
        .ok_or_else(|| "Conversation has no ACP profile".to_string())?;
    let cwd = conversation
        .project_dir
        .clone()
        .ok_or_else(|| "ACP conversation has no project directory".to_string())?;
    let profile = configured_acp_profile(&app, &profile_id).await?;
    let fingerprint_key_dir = resolve_config_dir(&app)?;
    let fingerprint_key: Arc<[u8]> = tokio::task::spawn_blocking(move || {
        config::load_or_create_acp_fingerprint_key(&fingerprint_key_dir)
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))??
    .into();
    let bundled_node_bin = bundled_node_bin_dir(&app);
    let prepared = acp::process::prepare_process(
        &profile,
        std::path::Path::new(&cwd),
        &shell_env.vars,
        bundled_node_bin.as_deref(),
        &fingerprint_key,
    )?;
    let persisted_session_id = validated_acp_resume_session_id(
        conversation.acp_session_id.clone(),
        conversation.acp_profile_fingerprint.as_deref(),
        &prepared.profile_fingerprint,
    )?;
    let attempted_resume = persisted_session_id.is_some();
    let start = manager
        .start_session(acp::StartSessionOptions {
            conversation_id: conversation_id.clone(),
            generation,
            profile_id,
            prepared,
            persisted_session_id,
            event_sink: acp_event_sink(on_event),
        })
        .await;
    let info = match start {
        Ok(info) => info,
        Err(error) if attempted_resume && error.to_ascii_lowercase().contains("load") => {
            if manager.latest_generation(&conversation_id).await == Some(generation) {
                let db = Arc::clone(&db);
                let stale_conversation = conversation.clone();
                let cleanup_result = tokio::task::spawn_blocking(move || {
                    clear_failed_acp_resume_metadata(&db, &stale_conversation)
                })
                .await
                .map_err(|cleanup_error| format!("Task join error: {cleanup_error}"))?;
                if let Err(cleanup_error) = cleanup_result {
                    return Err(format!(
                        "Saved ACP continuity could not be loaded, and its stale metadata could not be cleared: {cleanup_error}. {error}"
                    ));
                }
            }
            return Err(format!(
                "Saved ACP continuity could not be loaded; the adapter was terminated. Retry to start fresh. {error}"
            ));
        }
        Err(error) => return Err(error),
    };
    let db_for_write = Arc::clone(&db);
    let metadata_id = conversation_id.clone();
    let session_id = info.session_id.clone();
    let profile_fingerprint = info.profile_fingerprint.clone();
    let runtime_epoch = manager.runtime_epoch();
    let metadata_generation = i64::try_from(generation)
        .map_err(|_| "ACP generation exceeds the database range".to_string())?;
    let persist_result = tokio::task::spawn_blocking(move || {
        db_for_write.set_acp_session_metadata(
            &metadata_id,
            &session_id,
            &profile_fingerprint,
            &runtime_epoch,
            metadata_generation,
        )
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))?;
    match persist_result {
        Ok(true) => {}
        Ok(false) => {
            let _ = manager
                .stop_session_generation(&conversation_id, generation)
                .await;
            return Err("Stale ACP generation lost the metadata update race".into());
        }
        Err(error) => {
            let _ = manager
                .stop_session_generation(&conversation_id, generation)
                .await;
            return Err(error);
        }
    }
    Ok(info)
}

#[tauri::command]
#[tracing::instrument(skip(manager))]
async fn acp_disconnect(
    conversation_id: String,
    generation: u64,
    manager: State<'_, AcpState>,
) -> Result<(), String> {
    manager
        .stop_session_generation(&conversation_id, generation)
        .await
}

#[tauri::command]
#[tracing::instrument(skip(turn_token, content_blocks, on_event, db, manager))]
async fn acp_prompt(
    conversation_id: String,
    generation: u64,
    turn_token: String,
    content_blocks: Vec<acp::AcpPromptContent>,
    permission_mode: acp::PermissionMode,
    on_event: Channel<acp::AcpEvent>,
    db: State<'_, DbState>,
    manager: State<'_, AcpState>,
) -> Result<AcpPromptCommandResult, String> {
    manager
        .assert_current_generation(&conversation_id, generation)
        .await?;
    let db_for_token = Arc::clone(&db);
    let claim_conversation_id = conversation_id.clone();
    let claim_token = turn_token.clone();
    let claimed = tokio::task::spawn_blocking(move || {
        db_for_token.claim_acp_turn(&claim_conversation_id, &claim_token)
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))??;
    if !claimed {
        return Err("ACP turn token was already dispatched or is stale".into());
    }
    let result = manager
        .prompt(
            &conversation_id,
            generation,
            content_blocks,
            permission_mode,
            acp_event_sink(on_event),
        )
        .await?;
    Ok(AcpPromptCommandResult {
        conversation_id,
        generation,
        turn_id: result.turn_id,
        stop_reason: result.stop_reason,
    })
}

#[tauri::command]
#[tracing::instrument(skip(manager))]
async fn acp_respond_permission(
    conversation_id: String,
    generation: u64,
    request_id: String,
    option_id: Option<String>,
    manager: State<'_, AcpState>,
) -> Result<(), String> {
    manager
        .respond_permission(&conversation_id, generation, request_id, option_id)
        .await
}

#[tauri::command]
#[tracing::instrument(skip(manager))]
async fn acp_cancel(
    conversation_id: String,
    generation: u64,
    manager: State<'_, AcpState>,
) -> Result<(), String> {
    manager.cancel_session(&conversation_id, generation).await
}

#[tauri::command]
#[tracing::instrument(skip(app, shell_env, manager))]
async fn acp_probe_profile(
    profile_id: String,
    cwd: Option<String>,
    app: tauri::AppHandle,
    shell_env: State<'_, Arc<env::ShellEnv>>,
    manager: State<'_, AcpState>,
) -> Result<AcpProbeResult, String> {
    let profile = configured_acp_profile(&app, &profile_id).await?;
    let fingerprint_key_dir = resolve_config_dir(&app)?;
    let fingerprint_key: Arc<[u8]> = tokio::task::spawn_blocking(move || {
        config::load_or_create_acp_fingerprint_key(&fingerprint_key_dir)
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))??
    .into();
    let cwd = cwd
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|_| "Failed to resolve current directory")?);
    let prepared = acp::process::prepare_process(
        &profile,
        &cwd,
        &shell_env.vars,
        bundled_node_bin_dir(&app).as_deref(),
        &fingerprint_key,
    )?;
    let resolved_executable = prepared.executable.to_string_lossy().into_owned();
    let probe_conversation_id = format!("probe-{}", uuid::Uuid::new_v4());
    let info = manager
        .start_session(acp::StartSessionOptions {
            conversation_id: probe_conversation_id.clone(),
            generation: 1,
            profile_id: profile.id.clone(),
            prepared,
            persisted_session_id: None,
            event_sink: acp::AcpEventSink::new(|_| Ok(())),
        })
        .await?;
    manager.stop_session(&probe_conversation_id).await?;
    Ok(AcpProbeResult {
        profile_id,
        resolved_executable,
        protocol_version: "1".into(),
        agent_name: info.agent_name,
        agent_version: info.agent_version,
        capabilities: info.capabilities,
    })
}

#[tauri::command]
#[tracing::instrument(skip(app))]
async fn acp_list_profiles(app: tauri::AppHandle) -> Result<Vec<config::AcpProfile>, String> {
    let config_dir = resolve_config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let config = config::load_config(&config_dir)?;
        Ok(config.acp_profiles)
    })
    .await
    .map_err(|error| format!("Task join error: {error}"))?
}

#[tauri::command]
#[tracing::instrument(skip(db))]
async fn acp_get_conversation_metadata(
    conversation_id: String,
    db: State<'_, DbState>,
) -> Result<AcpConversationMetadata, String> {
    let lookup_id = conversation_id.clone();
    let db = Arc::clone(&db);
    let conversation = tokio::task::spawn_blocking(move || db.get_conversation(&lookup_id))
        .await
        .map_err(|error| format!("Task join error: {error}"))??
        .ok_or_else(|| "Conversation not found".to_string())?;
    Ok(AcpConversationMetadata {
        conversation_id,
        agent_profile_id: conversation.agent_profile_id,
        project_dir: conversation.project_dir,
        acp_session_id: conversation.acp_session_id,
    })
}

#[tauri::command]
fn get_initial_project_dir(state: State<InitialProjectDir>) -> Option<String> {
    state.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_project_dir = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .and_then(|arg| match std::fs::canonicalize(&arg) {
            Ok(path) if path.is_dir() => Some(path.to_string_lossy().into_owned()),
            Ok(path) => {
                eprintln!("Warning: '{}' is not a directory", path.display());
                None
            }
            Err(e) => {
                eprintln!("Warning: cannot resolve '{}': {}", arg, e);
                None
            }
        });
    init_tracing();

    let shell_env: Arc<env::ShellEnv> = Arc::new(env::ShellEnv::resolve());
    let mcp_state: Arc<McpManager> = Arc::new(McpManager::new());
    let shell_state: Arc<ShellProcesses> = Arc::new(ShellProcesses::new());
    let stream_state: Arc<StreamCancellers> = Arc::new(StreamCancellers::new());
    let codex_transport_state: Arc<CodexTransport> = Arc::new(CodexTransport::new());
    let oauth_state: Arc<OAuthCallbackServer> = Arc::new(OAuthCallbackServer::new());
    let acp_state: AcpState = Arc::new(acp::AcpManager::new());
    let acp_shutdown = Arc::clone(&acp_state);

    tracing::info!("app started");

    tauri::Builder::default()
        .plugin(log_plugin_builder().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            #[cfg(desktop)]
            if let Some(title) = flavor_window_title(&app.config().identifier) {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_title(title)?;
                }
            }

            let db_path = if let Ok(dir) = std::env::var("THECHAT_DATA_DIR") {
                // Explicit override (used by E2E tests for isolation)
                let dir = std::path::PathBuf::from(dir);
                std::fs::create_dir_all(&dir).expect("Failed to create data directory");
                dir.join("thechat.db")
            } else if cfg!(debug_assertions) {
                // In development, store the database inside the project directory
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dev.db")
            } else {
                let dir = app
                    .path()
                    .app_data_dir()
                    .expect("Failed to resolve app data dir");
                std::fs::create_dir_all(&dir).expect("Failed to create data directory");
                dir.join("thechat.db")
            };

            let database =
                Database::new(db_path.to_str().unwrap()).expect("Failed to initialize database");

            app.manage(Arc::new(database) as DbState);

            Ok(())
        })
        .manage(shell_env)
        .manage(mcp_state)
        .manage(shell_state)
        .manage(stream_state)
        .manage(codex_transport_state)
        .manage(oauth_state)
        .manage(acp_state)
        .manage(InitialProjectDir(initial_project_dir))
        .invoke_handler(tauri::generate_handler![
            attachment_download::download_attachment_to_file,
            file_drop::read_dropped_file,
            get_config,
            get_config_path,
            save_config,
            get_app_config_dir,
            get_initial_project_dir,
            create_conversation,
            get_conversation,
            list_conversations,
            update_conversation_title,
            save_message,
            get_messages,
            kv_get,
            kv_set,
            kv_delete,
            acp_begin_turn,
            acp_abort_turn,
            acp_complete_turn,
            acp_connect,
            acp_disconnect,
            acp_prompt,
            acp_respond_permission,
            acp_cancel,
            acp_probe_profile,
            acp_list_profiles,
            acp_get_conversation_metadata,
            mcp::mcp_initialize,
            mcp::mcp_initialize_authed,
            mcp::mcp_initialize_servers,
            mcp::mcp_call_tool,
            mcp::mcp_shutdown,
            shell::execute_shell_command,
            shell::kill_shell_process,
            fs::get_project_info,
            fs::get_cwd,
            fs::fs_read_file_raw,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_edit_file,
            fs::fs_glob,
            fs::fs_grep,
            fs::fs_list_dir,
            fs::save_image,
            fs::load_image_base64,
            fs::fs_truncation_write,
            fs::fs_format_file,
            fs::fs_delete_file,
            stream::stream_completion,
            stream::cancel_stream,
            oauth::mcp_oauth_start,
            oauth::mcp_oauth_await,
            oauth::mcp_oauth_cancel,
            oauth::codex_oauth_start,
            oauth::codex_oauth_await,
            oauth::codex_oauth_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Err(error) = tauri::async_runtime::block_on(acp_shutdown.stop_all_sessions())
                {
                    eprintln!("ACP shutdown error: {error}");
                }
            }
        });

    #[cfg(feature = "otel")]
    if let Some(provider) = OTEL_PROVIDER.get() {
        if let Err(e) = provider.shutdown() {
            eprintln!("OTel shutdown error: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_log_json_line_is_promtail_compatible() {
        let line = dev_log_json_line(
            1_717_000_000_123,
            log::Level::Warn,
            "webview",
            "boom \"quoted\"\nsecond line",
        );

        // Must stay a single line so Promtail treats it as one entry.
        assert!(!line.contains('\n'));

        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["time"], 1_717_000_000_123u64);
        assert_eq!(parsed["level"], "warn");
        assert_eq!(parsed["target"], "webview");
        assert_eq!(parsed["msg"], "boom \"quoted\"\nsecond line");
    }

    #[test]
    fn app_builds_with_mock_runtime() {
        let database = Database::new(":memory:").unwrap();
        let db_state: DbState = Arc::new(database);
        let shell_env: Arc<env::ShellEnv> = Arc::new(env::ShellEnv {
            vars: std::env::vars().collect(),
            shell: "/bin/bash".into(),
        });
        let mcp_state: Arc<McpManager> = Arc::new(McpManager::new());
        let shell_state: Arc<ShellProcesses> = Arc::new(ShellProcesses::new());
        let stream_state: Arc<StreamCancellers> = Arc::new(StreamCancellers::new());
        let acp_state: Arc<acp::AcpManager> = Arc::new(acp::AcpManager::new());

        let oauth_state: Arc<OAuthCallbackServer> = Arc::new(OAuthCallbackServer::new());

        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_log::Builder::new().build())
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_process::init())
            .manage(db_state)
            .manage(shell_env)
            .manage(mcp_state)
            .manage(shell_state)
            .manage(stream_state)
            .manage(acp_state)
            .manage(oauth_state)
            .manage(InitialProjectDir(None))
            .invoke_handler(tauri::generate_handler![
                // Note: get_config, get_config_path, save_config, get_app_config_dir
                // are excluded because they use AppHandle which isn't supported by MockRuntime
                file_drop::read_dropped_file,
                get_initial_project_dir,
                create_conversation,
                get_conversation,
                list_conversations,
                update_conversation_title,
                save_message,
                get_messages,
                kv_get,
                kv_set,
                kv_delete,
                mcp::mcp_initialize,
                mcp::mcp_initialize_servers,
                mcp::mcp_call_tool,
                mcp::mcp_shutdown,
                shell::execute_shell_command,
                shell::kill_shell_process,
                fs::get_project_info,
                fs::get_cwd,
                fs::fs_read_file_raw,
                fs::fs_read_file,
                fs::fs_write_file,
                fs::fs_edit_file,
                fs::fs_glob,
                fs::fs_grep,
                fs::fs_list_dir,
                fs::fs_format_file,
                fs::fs_delete_file,
                stream::stream_completion,
                stream::cancel_stream,
                acp_disconnect,
                acp_prompt,
                acp_respond_permission,
                acp_cancel,
                acp_get_conversation_metadata,
            ])
            .build(tauri::generate_context!())
            .expect("failed to build app with mock runtime");

        // Verify managed state is accessible
        let state = app.state::<DbState>();
        let convs = state.list_conversations().unwrap();
        assert!(convs.is_empty());
    }

    #[test]
    fn managed_db_operations_through_app_state() {
        let database = Database::new(":memory:").unwrap();
        let db_state: DbState = Arc::new(database);

        let app = tauri::test::mock_builder()
            .manage(db_state)
            .build(tauri::generate_context!())
            .expect("failed to build app");

        let db = app.state::<DbState>();
        let conv = db.create_conversation("Test", None).unwrap();
        assert_eq!(conv.title, "Test");

        db.save_message(&conv.id, "user", "Hello", None).unwrap();
        let msgs = db.get_messages(&conv.id, None, None).unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn failed_resume_cleanup_reports_a_lost_compare_and_set() {
        let database = Database::new(":memory:").unwrap();
        let conversation = database.create_conversation("ACP", None).unwrap();
        assert!(database
            .set_acp_session_metadata(
                &conversation.id,
                "session-1",
                "fingerprint-1",
                "runtime-a",
                1,
            )
            .unwrap());
        let stale = database
            .get_conversation(&conversation.id)
            .unwrap()
            .unwrap();
        assert!(database
            .set_acp_session_metadata(
                &conversation.id,
                "session-1",
                "fingerprint-1",
                "runtime-a",
                2,
            )
            .unwrap());

        let error = clear_failed_acp_resume_metadata(&database, &stale).unwrap_err();
        assert!(error.contains("changed"), "{error}");
        let current = database
            .get_conversation(&conversation.id)
            .unwrap()
            .unwrap();
        assert_eq!(current.acp_generation, Some(2));
        clear_failed_acp_resume_metadata(&database, &current).unwrap();
        assert!(database
            .get_conversation(&conversation.id)
            .unwrap()
            .unwrap()
            .acp_session_id
            .is_none());
    }

    #[test]
    fn development_flavor_gets_a_distinct_window_title() {
        assert_eq!(
            flavor_window_title(DEVELOPMENT_IDENTIFIER),
            Some(DEVELOPMENT_WINDOW_TITLE)
        );
        assert_eq!(flavor_window_title("com.bruno.thechat"), None);
    }

    #[test]
    fn release_database_path_uses_the_resolved_identifier() {
        let data_dir = std::path::PathBuf::from("app-data");
        assert_eq!(
            release_db_path(&data_dir, DEVELOPMENT_IDENTIFIER),
            data_dir.join(DEVELOPMENT_IDENTIFIER).join("thechat.db")
        );
        assert_eq!(
            release_db_path(&data_dir, "com.bruno.thechat"),
            data_dir.join("com.bruno.thechat").join("thechat.db")
        );
    }

    #[test]
    fn acp_profile_drift_requires_an_explicit_fresh_conversation() {
        let error = validated_acp_resume_session_id(
            Some("saved-session".into()),
            Some("old-fingerprint"),
            "new-fingerprint",
        )
        .unwrap_err();

        assert!(error.contains("profile changed"));
        assert!(error.contains("new Agent Chat"));
    }
}
