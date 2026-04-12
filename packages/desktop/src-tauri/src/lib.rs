mod config;
mod db;
mod env;
mod fs;
mod mcp;
mod oauth;
mod shell;
mod stream;

use db::{Conversation, Database, Message};
use mcp::McpManager;
use oauth::OAuthCallbackServer;
use shell::ShellProcesses;
use std::sync::Arc;
use stream::{CodexTransport, StreamCancellers};
use tauri::{Manager, State};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

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

type DbState = Arc<Database>;

pub struct InitialProjectDir(pub Option<String>);

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
    db: State<'_, DbState>,
) -> Result<Conversation, String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.create_conversation(&title, project_dir.as_deref()))
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
    db: State<'_, DbState>,
) -> Result<Vec<Message>, String> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || db.get_messages(&conversation_id))
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

    tracing::info!("app started");

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level_from_env())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

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
        .manage(InitialProjectDir(initial_project_dir))
        .invoke_handler(tauri::generate_handler![
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
            stream::stream_completion,
            stream::cancel_stream,
            oauth::mcp_oauth_start,
            oauth::mcp_oauth_await,
            oauth::mcp_oauth_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

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
            .manage(oauth_state)
            .manage(InitialProjectDir(None))
            .invoke_handler(tauri::generate_handler![
                // Note: get_config, get_config_path, save_config, get_app_config_dir
                // are excluded because they use AppHandle which isn't supported by MockRuntime
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
                stream::stream_completion,
                stream::cancel_stream,
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
        let msgs = db.get_messages(&conv.id).unwrap();
        assert_eq!(msgs.len(), 1);
    }
}
