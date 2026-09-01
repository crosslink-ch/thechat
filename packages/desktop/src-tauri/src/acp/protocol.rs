#[cfg(test)]
use crate::acp::process::prepare_process;
use crate::acp::process::{spawn_process, PreparedProcess};
use agent_client_protocol::schema::{
    v1::{
        CancelNotification, ContentBlock, ImageContent, Implementation, InitializeRequest,
        LoadSessionRequest, NewSessionRequest, PermissionOptionId, PermissionOptionKind,
        PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
        RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification, SessionUpdate,
        StopReason, TextContent, ToolKind,
    },
    ProtocolVersion,
};
use agent_client_protocol::{Agent, ByteStreams, ConnectionTo, Responder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::pending;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use uuid::Uuid;

const MAX_ACTIVE_SESSIONS: usize = 8;
const COMMAND_QUEUE_CAPACITY: usize = 32;
const EVENT_QUEUE_CAPACITY: usize = 256;
const MAX_PENDING_PERMISSIONS: usize = 32;
const MAX_PROMPT_TEXT_BYTES: usize = 256 * 1024;
const MAX_PROMPT_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROMPT_BLOCKS: usize = 64;
const MAX_PROMPT_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_EVENT_VALUE_BYTES: usize = 64 * 1024;
const MAX_TURN_EVENTS: usize = 10_000;
const MAX_TURN_EVENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_JSON_LINE_BYTES: usize = 1024 * 1024;
const MAX_TURN_TEXT_BYTES: usize = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Request,
    AllowEdits,
    Bypass,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpPromptContent {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub id: String,
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub options: Vec<AcpPermissionOption>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpEventError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fatal: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpTurnSummary {
    pub stop_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AcpEventPayload {
    Connected {
        session_id: String,
        capabilities: AcpCapabilities,
        resumed: bool,
    },
    TurnStarted,
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCall {
        tool_call: Value,
    },
    ToolCallUpdate {
        tool_call_id: String,
        update: Value,
    },
    PermissionRequest {
        permission: AcpPermissionRequest,
    },
    PermissionResolved {
        request_id: String,
        option_id: Option<String>,
    },
    PlanUpdate {
        entries: Value,
    },
    CommandUpdate {
        commands: Value,
    },
    ModeUpdate {
        mode_id: String,
        label: Option<String>,
    },
    ConfigOptionUpdate {
        options: Value,
    },
    Unknown {
        update_type: String,
        value: Option<Value>,
    },
    TurnCancelled {
        result: AcpTurnSummary,
    },
    TurnFinished {
        result: AcpTurnSummary,
    },
    Error {
        error: AcpEventError,
    },
    Disconnected {
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpEvent {
    pub conversation_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub turn_id: Option<String>,
    #[serde(flatten)]
    pub payload: AcpEventPayload,
}

#[derive(Clone)]
pub struct AcpEventSink {
    send: Arc<dyn Fn(AcpEvent) -> Result<(), String> + Send + Sync>,
}

impl AcpEventSink {
    pub fn new(send: impl Fn(AcpEvent) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self {
            send: Arc::new(send),
        }
    }

    fn send(&self, event: AcpEvent) -> Result<(), String> {
        (self.send)(event)
    }
}

pub struct StartSessionOptions {
    pub conversation_id: String,
    pub generation: u64,
    pub profile_id: String,
    pub prepared: PreparedProcess,
    pub persisted_session_id: Option<String>,
    pub event_sink: AcpEventSink,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptCapabilities {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpCapabilities {
    pub load_session: bool,
    pub prompt: AcpPromptCapabilities,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionInfo {
    pub conversation_id: String,
    pub generation: u64,
    pub session_id: String,
    pub profile_id: String,
    #[serde(skip)]
    pub profile_fingerprint: String,
    #[serde(rename = "resumed")]
    pub loaded: bool,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub capabilities: AcpCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpTurnResult {
    pub turn_id: String,
    pub stop_reason: String,
}

#[derive(Clone)]
pub struct AcpManager {
    inner: Arc<ManagerInner>,
}

struct ManagerInner {
    sessions: tokio::sync::Mutex<HashMap<String, ManagedSession>>,
    high_water: tokio::sync::Mutex<HashMap<String, u64>>,
    runtime_epoch: String,
}

type ReadySender = Arc<Mutex<Option<oneshot::Sender<Result<AcpSessionInfo, String>>>>>;

#[derive(Clone)]
struct ManagedSession {
    generation: u64,
    state: ManagedState,
    cancel_tx: watch::Sender<bool>,
    done_rx: watch::Receiver<bool>,
}

#[derive(Clone)]
enum ManagedState {
    Starting,
    Running(mpsc::Sender<SessionCommand>),
}

impl Default for AcpManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                sessions: tokio::sync::Mutex::new(HashMap::new()),
                high_water: tokio::sync::Mutex::new(HashMap::new()),
                runtime_epoch: Uuid::new_v4().to_string(),
            }),
        }
    }

    pub async fn start_session(
        &self,
        options: StartSessionOptions,
    ) -> Result<AcpSessionInfo, String> {
        let conversation_id = options.conversation_id.clone();
        let generation = options.generation;
        if generation == 0 {
            return Err("ACP generation must be greater than zero".into());
        }
        {
            let mut high_water = self.inner.high_water.lock().await;
            if high_water
                .get(&conversation_id)
                .is_some_and(|latest| *latest >= generation)
            {
                return Err("Stale ACP generation".into());
            }
            high_water.insert(conversation_id.clone(), generation);
        }
        let (command_tx, command_rx) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
        let (ready_tx, ready_rx) = oneshot::channel();
        let ready = Arc::new(Mutex::new(Some(ready_tx)));
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);

        loop {
            let older_generation = {
                let mut sessions = self.inner.sessions.lock().await;
                match sessions.get(&conversation_id) {
                    Some(entry) if entry.generation >= generation => {
                        return Err("Stale ACP generation".into());
                    }
                    Some(entry) => Some(entry.generation),
                    None => {
                        if sessions.len() >= MAX_ACTIVE_SESSIONS {
                            return Err(format!(
                                "ACP session limit reached ({MAX_ACTIVE_SESSIONS})"
                            ));
                        }
                        sessions.insert(
                            conversation_id.clone(),
                            ManagedSession {
                                generation,
                                state: ManagedState::Starting,
                                cancel_tx: cancel_tx.clone(),
                                done_rx: done_rx.clone(),
                            },
                        );
                        None
                    }
                }
            };
            match older_generation {
                Some(older_generation) => {
                    self.stop_session_generation(&conversation_id, older_generation)
                        .await?;
                }
                None => break,
            }
        }

        let manager = self.clone();
        let task_conversation_id = conversation_id.clone();
        tokio::spawn(async move {
            let result = run_session(
                options,
                generation,
                command_rx,
                Arc::clone(&ready),
                cancel_rx,
            )
            .await;
            if result.is_err() {
                send_ready(&ready, Err("ACP adapter failed during startup".into()));
            }
            manager
                .remove_if_generation(&task_conversation_id, generation)
                .await;
            let _ = done_tx.send(true);
        });

        let ready_result = match tokio::time::timeout(CONNECT_TIMEOUT, ready_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("ACP adapter stopped during startup".into()),
            Err(_) => Err("ACP adapter startup timed out".into()),
        };

        match ready_result {
            Ok(info) => {
                let mut sessions = self.inner.sessions.lock().await;
                match sessions.get_mut(&conversation_id) {
                    Some(entry) if entry.generation == generation => {
                        entry.state = ManagedState::Running(command_tx);
                        Ok(info)
                    }
                    _ => Err("ACP session stopped before startup completed".into()),
                }
            }
            Err(error) => {
                if let Err(cleanup_error) = self
                    .stop_session_generation(&conversation_id, generation)
                    .await
                {
                    if cleanup_error != "Stale ACP generation" {
                        return Err(format!("{error}; cleanup failed: {cleanup_error}"));
                    }
                }
                Err(error)
            }
        }
    }

    pub async fn prompt(
        &self,
        conversation_id: &str,
        generation: u64,
        content: Vec<AcpPromptContent>,
        permission_mode: PermissionMode,
        event_sink: AcpEventSink,
    ) -> Result<AcpTurnResult, String> {
        let tx = self.running_sender(conversation_id, generation).await?;
        let (response_tx, response_rx) = oneshot::channel();
        tx.send(SessionCommand::Prompt {
            content,
            permission_mode,
            event_sink,
            response: response_tx,
        })
        .await
        .map_err(|_| "ACP session is no longer running".to_string())?;
        response_rx
            .await
            .map_err(|_| "ACP session stopped before the prompt completed".to_string())?
    }

    pub async fn respond_permission(
        &self,
        conversation_id: &str,
        generation: u64,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let tx = self.running_sender(conversation_id, generation).await?;
        let (response_tx, response_rx) = oneshot::channel();
        tx.send(SessionCommand::RespondPermission {
            request_id,
            option_id,
            response: response_tx,
        })
        .await
        .map_err(|_| "ACP session is no longer running".to_string())?;
        response_rx
            .await
            .map_err(|_| "ACP session stopped before permission was resolved".to_string())?
    }

    pub async fn cancel_session(
        &self,
        conversation_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        let entry = {
            let sessions = self.inner.sessions.lock().await;
            match sessions.get(conversation_id).cloned() {
                Some(entry) if entry.generation == generation => entry,
                Some(_) => return Err("Stale ACP generation".into()),
                None => return Err("ACP session is not running".into()),
            }
        };
        match entry.state {
            ManagedState::Starting => {
                let _ = entry.cancel_tx.send(true);
                wait_for_session_done(entry.done_rx).await
            }
            ManagedState::Running(tx) => {
                let (response_tx, response_rx) = oneshot::channel();
                tx.send(SessionCommand::Cancel {
                    response: response_tx,
                })
                .await
                .map_err(|_| "ACP session is no longer running".to_string())?;
                response_rx
                    .await
                    .map_err(|_| "ACP session stopped while cancellation was sent".to_string())?
            }
        }
    }

    pub async fn stop_session(&self, conversation_id: &str) -> Result<(), String> {
        let entry = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(conversation_id).cloned()
        };
        let Some(entry) = entry else {
            return Ok(());
        };
        self.stop_managed_entry(conversation_id, entry).await
    }

    pub async fn stop_session_generation(
        &self,
        conversation_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        let entry = {
            let sessions = self.inner.sessions.lock().await;
            match sessions.get(conversation_id).cloned() {
                Some(entry) if entry.generation == generation => entry,
                Some(_) => return Err("Stale ACP generation".into()),
                None => return Ok(()),
            }
        };
        self.stop_managed_entry(conversation_id, entry).await
    }

    async fn stop_managed_entry(
        &self,
        _conversation_id: &str,
        entry: ManagedSession,
    ) -> Result<(), String> {
        let mut command_error = None;
        match entry.state {
            ManagedState::Starting => {
                let _ = entry.cancel_tx.send(true);
            }
            ManagedState::Running(tx) => {
                let (response_tx, response_rx) = oneshot::channel();
                if tx
                    .send(SessionCommand::Stop {
                        response: response_tx,
                    })
                    .await
                    .is_err()
                {
                    command_error = Some("ACP session is no longer running".to_string());
                } else {
                    command_error = match tokio::time::timeout(CANCEL_TIMEOUT, response_rx).await {
                        Ok(Ok(())) => None,
                        Ok(Err(_)) => {
                            Some("ACP adapter stopped before acknowledging shutdown".to_string())
                        }
                        Err(_) => Some("ACP adapter stop timed out".to_string()),
                    };
                }
                if command_error.is_some() {
                    let _ = entry.cancel_tx.send(true);
                }
            }
        }

        wait_for_session_done(entry.done_rx).await?;
        match command_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub async fn stop_all_sessions(&self) -> Result<(), String> {
        let conversation_ids: Vec<String> =
            self.inner.sessions.lock().await.keys().cloned().collect();
        let results = futures_util::future::join_all(
            conversation_ids
                .iter()
                .map(|conversation_id| self.stop_session(conversation_id)),
        )
        .await;
        let errors: Vec<String> = results.into_iter().filter_map(Result::err).collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Failed to stop one or more ACP sessions: {}",
                errors.join("; ")
            ))
        }
    }

    pub async fn active_session_count(&self) -> usize {
        self.inner.sessions.lock().await.len()
    }

    pub fn runtime_epoch(&self) -> String {
        self.inner.runtime_epoch.clone()
    }

    pub async fn latest_generation(&self, conversation_id: &str) -> Option<u64> {
        self.inner
            .high_water
            .lock()
            .await
            .get(conversation_id)
            .copied()
    }

    pub async fn assert_current_generation(
        &self,
        conversation_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        if self.latest_generation(conversation_id).await != Some(generation) {
            return Err("Stale ACP generation".into());
        }
        let sessions = self.inner.sessions.lock().await;
        match sessions.get(conversation_id) {
            Some(entry)
                if entry.generation == generation
                    && matches!(entry.state, ManagedState::Running(_)) =>
            {
                Ok(())
            }
            Some(entry) if entry.generation == generation => {
                Err("ACP session is still starting".into())
            }
            Some(_) => Err("Stale ACP generation".into()),
            None => Err("ACP session is not running".into()),
        }
    }

    pub async fn stop_session_up_to_generation(
        &self,
        conversation_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        if self
            .latest_generation(conversation_id)
            .await
            .is_some_and(|latest| latest > generation)
        {
            return Err("Stale ACP generation".into());
        }
        let entry = {
            let sessions = self.inner.sessions.lock().await;
            sessions.get(conversation_id).cloned()
        };
        let Some(entry) = entry else {
            return Ok(());
        };
        if entry.generation > generation {
            return Err("Stale ACP generation".into());
        }
        self.stop_managed_entry(conversation_id, entry).await
    }

    async fn running_sender(
        &self,
        conversation_id: &str,
        generation: u64,
    ) -> Result<mpsc::Sender<SessionCommand>, String> {
        let sessions = self.inner.sessions.lock().await;
        match sessions.get(conversation_id) {
            Some(entry) if entry.generation != generation => Err("Stale ACP generation".into()),
            Some(ManagedSession {
                state: ManagedState::Running(tx),
                ..
            }) => Ok(tx.clone()),
            Some(ManagedSession {
                state: ManagedState::Starting,
                ..
            }) => Err("ACP session is still starting".into()),
            None => Err("ACP session is not running".into()),
        }
    }

    async fn remove_if_generation(&self, conversation_id: &str, generation: u64) {
        let mut sessions = self.inner.sessions.lock().await;
        if sessions
            .get(conversation_id)
            .is_some_and(|entry| entry.generation == generation)
        {
            sessions.remove(conversation_id);
        }
    }
}

async fn wait_for_session_done(mut done_rx: watch::Receiver<bool>) -> Result<(), String> {
    if *done_rx.borrow() {
        return Ok(());
    }
    tokio::time::timeout(CANCEL_TIMEOUT, async {
        loop {
            done_rx
                .changed()
                .await
                .map_err(|_| "ACP session cleanup task stopped unexpectedly".to_string())?;
            if *done_rx.borrow() {
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| "ACP process cleanup timed out".to_string())?
}

enum SessionCommand {
    Prompt {
        content: Vec<AcpPromptContent>,
        permission_mode: PermissionMode,
        event_sink: AcpEventSink,
        response: oneshot::Sender<Result<AcpTurnResult, String>>,
    },
    RespondPermission {
        request_id: String,
        option_id: Option<String>,
        response: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        response: oneshot::Sender<Result<(), String>>,
    },
    Stop {
        response: oneshot::Sender<()>,
    },
}

#[derive(Debug, Clone, Copy)]
enum InternalCancel {
    EventChannelClosed,
    EventLimitExceeded,
}

struct PendingPermission {
    options: HashMap<String, PermissionOptionId>,
    responder: Responder<RequestPermissionResponse>,
}

struct ClientBridge {
    permission_mode: RwLock<PermissionMode>,
    event_sink: Arc<RwLock<AcpEventSink>>,
    session_id: RwLock<Option<String>>,
    forward_updates: AtomicBool,
    event_tx: mpsc::Sender<RawEvent>,
    internal_cancel_tx: mpsc::UnboundedSender<InternalCancel>,
    pending_permissions: Mutex<HashMap<String, PendingPermission>>,
    turn_id: RwLock<Option<String>>,
    turn_text_bytes: AtomicUsize,
    turn_event_count: AtomicUsize,
    turn_event_bytes: AtomicUsize,
}

impl ClientBridge {
    fn new(
        event_sink: Arc<RwLock<AcpEventSink>>,
        event_tx: mpsc::Sender<RawEvent>,
        internal_cancel_tx: mpsc::UnboundedSender<InternalCancel>,
    ) -> Self {
        Self {
            permission_mode: RwLock::new(PermissionMode::Request),
            event_sink,
            session_id: RwLock::new(None),
            forward_updates: AtomicBool::new(false),
            event_tx,
            internal_cancel_tx,
            pending_permissions: Mutex::new(HashMap::new()),
            turn_id: RwLock::new(None),
            turn_text_bytes: AtomicUsize::new(0),
            turn_event_count: AtomicUsize::new(0),
            turn_event_bytes: AtomicUsize::new(0),
        }
    }

    fn set_session_id(&self, session_id: String) {
        *self
            .session_id
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(session_id);
    }

    fn set_forward_updates(&self, forward: bool) {
        self.forward_updates.store(forward, Ordering::Release);
    }

    fn begin_turn(&self, turn_id: String) {
        *self
            .turn_id
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(turn_id);
        self.turn_text_bytes.store(0, Ordering::Release);
        self.turn_event_count.store(0, Ordering::Release);
        self.turn_event_bytes.store(0, Ordering::Release);
    }

    fn configure_turn(&self, permission_mode: PermissionMode, event_sink: AcpEventSink) {
        *self
            .permission_mode
            .write()
            .unwrap_or_else(|error| error.into_inner()) = permission_mode;
        *self
            .event_sink
            .write()
            .unwrap_or_else(|error| error.into_inner()) = event_sink;
    }

    fn end_turn(&self) {
        *self
            .turn_id
            .write()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }

    fn handle_notification(&self, notification: SessionNotification) {
        if !self.forward_updates.load(Ordering::Acquire) {
            return;
        }
        let expected = self
            .session_id
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if expected.as_deref() != Some(notification.session_id.0.as_ref()) {
            return;
        }

        let turn_id = self
            .turn_id
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(payload) = self.translate_update(notification.update) {
            self.queue_event(RawEvent::new(turn_id, payload));
        }
    }

    fn translate_update(&self, update: SessionUpdate) -> Option<AcpEventPayload> {
        match update {
            SessionUpdate::UserMessageChunk(chunk) => {
                Some(self.content_payload("user", chunk.content))
            }
            SessionUpdate::AgentMessageChunk(chunk) => {
                Some(self.content_payload("agent", chunk.content))
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                Some(self.content_payload("thought", chunk.content))
            }
            SessionUpdate::ToolCall(tool_call) => Some(AcpEventPayload::ToolCall {
                tool_call: normalized_tool_call(&tool_call),
            }),
            SessionUpdate::ToolCallUpdate(tool_call) => Some(AcpEventPayload::ToolCallUpdate {
                tool_call_id: tool_call.tool_call_id.to_string(),
                update: bounded_value(&tool_call.fields),
            }),
            SessionUpdate::Plan(plan) => {
                let value = bounded_value(&plan);
                Some(AcpEventPayload::PlanUpdate {
                    entries: take_value_field(value, "entries"),
                })
            }
            SessionUpdate::AvailableCommandsUpdate(commands) => {
                let value = bounded_value(&commands);
                Some(AcpEventPayload::CommandUpdate {
                    commands: take_value_field(value, "availableCommands"),
                })
            }
            SessionUpdate::CurrentModeUpdate(mode) => {
                let value = bounded_value(&mode);
                Some(AcpEventPayload::ModeUpdate {
                    mode_id: value
                        .get("currentModeId")
                        .or_else(|| value.get("modeId"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    label: value
                        .get("label")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            }
            SessionUpdate::ConfigOptionUpdate(option) => {
                let value = bounded_value(&option);
                Some(AcpEventPayload::ConfigOptionUpdate {
                    options: take_value_field(value, "configOptions"),
                })
            }
            SessionUpdate::SessionInfoUpdate(info) => Some(AcpEventPayload::Unknown {
                update_type: "session_info_update".into(),
                value: Some(bounded_value(&info)),
            }),
            SessionUpdate::UsageUpdate(usage) => Some(AcpEventPayload::Unknown {
                update_type: "usage_update".into(),
                value: Some(bounded_value(&usage)),
            }),
            other => {
                let value = bounded_value(&other);
                let update_type = value
                    .get("sessionUpdate")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                Some(AcpEventPayload::Unknown {
                    update_type,
                    value: Some(value),
                })
            }
        }
    }

    fn content_payload(&self, source: &str, content: ContentBlock) -> AcpEventPayload {
        match content {
            ContentBlock::Text(text) => {
                let text = self.bound_text(text.text);
                match source {
                    "thought" => AcpEventPayload::ReasoningDelta { text },
                    "agent" => AcpEventPayload::TextDelta { text },
                    _ => AcpEventPayload::Unknown {
                        update_type: "user_message_chunk".into(),
                        value: Some(serde_json::json!({ "text": text })),
                    },
                }
            }
            content => AcpEventPayload::Unknown {
                update_type: format!("{source}_content"),
                value: Some(bounded_value(&content)),
            },
        }
    }

    fn bound_text(&self, text: String) -> String {
        let next = self
            .turn_text_bytes
            .fetch_add(text.len(), Ordering::AcqRel)
            .saturating_add(text.len());
        if next > MAX_TURN_TEXT_BYTES {
            let _ = self
                .internal_cancel_tx
                .send(InternalCancel::EventLimitExceeded);
            return String::new();
        }
        truncate_utf8(text, MAX_PROMPT_TEXT_BYTES)
    }

    fn queue_event(&self, event: RawEvent) {
        let event_bytes = serde_json::to_vec(&event.payload)
            .map(|encoded| encoded.len())
            .unwrap_or(MAX_EVENT_VALUE_BYTES);
        let event_count = self.turn_event_count.fetch_add(1, Ordering::AcqRel) + 1;
        let total_bytes = self
            .turn_event_bytes
            .fetch_add(event_bytes, Ordering::AcqRel)
            .saturating_add(event_bytes);
        if event_count > MAX_TURN_EVENTS || total_bytes > MAX_TURN_EVENT_BYTES {
            let _ = self
                .internal_cancel_tx
                .send(InternalCancel::EventLimitExceeded);
            return;
        }
        if self.event_tx.try_send(event).is_err() {
            let _ = self
                .internal_cancel_tx
                .send(InternalCancel::EventLimitExceeded);
        }
    }

    async fn flush_event(
        &self,
        turn_id: Option<String>,
        payload: AcpEventPayload,
    ) -> Result<(), String> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.event_tx
            .send(RawEvent {
                turn_id,
                payload,
                ack: Some(ack_tx),
            })
            .await
            .map_err(|_| "ACP event channel closed".to_string())?;
        match tokio::time::timeout(Duration::from_secs(2), ack_rx).await {
            Ok(Ok(result)) => result,
            _ => Err("ACP event channel did not flush".into()),
        }
    }

    async fn finish_turn(&self, turn_id: String, stop_reason: String) -> Result<(), String> {
        let result = AcpTurnSummary {
            stop_reason: stop_reason.clone(),
            session_id: self
                .session_id
                .read()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
        };
        let payload = if stop_reason == "cancelled" {
            AcpEventPayload::TurnCancelled { result }
        } else {
            AcpEventPayload::TurnFinished { result }
        };
        self.flush_event(Some(turn_id), payload).await
    }

    fn handle_permission(
        &self,
        request: RequestPermissionRequest,
        responder: Responder<RequestPermissionResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let permission_mode = *self
            .permission_mode
            .read()
            .unwrap_or_else(|error| error.into_inner());
        match permission_decision(permission_mode, &request) {
            PermissionDecision::Auto(option_id) => {
                return responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
                ));
            }
            PermissionDecision::Cancel => {
                return responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ));
            }
            PermissionDecision::Prompt => {}
        }

        let mut pending = self
            .pending_permissions
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.len() >= MAX_PENDING_PERMISSIONS || request.options.is_empty() {
            return responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        }

        let request_id = Uuid::new_v4().to_string();
        let options: HashMap<_, _> = request
            .options
            .iter()
            .map(|option| (option.option_id.to_string(), option.option_id.clone()))
            .collect();
        let option_dtos = request
            .options
            .iter()
            .map(|option| AcpPermissionOption {
                id: option.option_id.to_string(),
                label: truncate_utf8(option.name.clone(), 512),
                kind: permission_kind_string(option.kind),
            })
            .collect();
        let payload = AcpEventPayload::PermissionRequest {
            permission: AcpPermissionRequest {
                id: request_id.clone(),
                tool_call_id: Some(request.tool_call.tool_call_id.to_string()),
                title: request
                    .tool_call
                    .fields
                    .title
                    .clone()
                    .map(|title| truncate_utf8(title, 512))
                    .unwrap_or_else(|| "ACP tool request".into()),
                description: None,
                options: option_dtos,
            },
        };
        pending.insert(request_id, PendingPermission { options, responder });
        drop(pending);
        let turn_id = self
            .turn_id
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        self.queue_event(RawEvent::new(turn_id, payload));
        Ok(())
    }

    fn respond_permission(&self, request_id: &str, option_id: Option<&str>) -> Result<(), String> {
        let mut pending = self
            .pending_permissions
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let request = pending
            .get(request_id)
            .ok_or_else(|| "Unknown or already resolved ACP permission request".to_string())?;
        let selected =
            match option_id {
                Some(option_id) => {
                    Some(request.options.get(option_id).cloned().ok_or_else(|| {
                        "Permission option was not offered by the agent".to_string()
                    })?)
                }
                None => None,
            };
        let request = pending
            .remove(request_id)
            .expect("pending permission existed while locked");
        drop(pending);
        let selected_id = option_id.map(str::to_string);
        let response = match selected {
            Some(option_id) => RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(option_id),
            )),
            None => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
        };
        request
            .responder
            .respond(response)
            .map_err(|_| "Failed to send ACP permission response".to_string())?;
        let turn_id = self
            .turn_id
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        self.queue_event(RawEvent::new(
            turn_id,
            AcpEventPayload::PermissionResolved {
                request_id: request_id.to_string(),
                option_id: selected_id,
            },
        ));
        Ok(())
    }

    fn cancel_pending_permissions(&self) {
        let pending = {
            let mut pending = self
                .pending_permissions
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            pending
                .drain()
                .map(|(_, request)| request)
                .collect::<Vec<_>>()
        };
        for request in pending {
            let _ = request.responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        }
    }
}

enum PermissionDecision {
    Auto(PermissionOptionId),
    Prompt,
    Cancel,
}

fn permission_decision(
    mode: PermissionMode,
    request: &RequestPermissionRequest,
) -> PermissionDecision {
    let find = |kind| {
        request
            .options
            .iter()
            .find(|option| option.kind == kind)
            .map(|option| option.option_id.clone())
    };
    match mode {
        PermissionMode::Request => PermissionDecision::Prompt,
        PermissionMode::AllowEdits => {
            if matches!(request.tool_call.fields.kind, Some(ToolKind::Edit)) {
                find(PermissionOptionKind::AllowOnce)
                    .map_or(PermissionDecision::Prompt, PermissionDecision::Auto)
            } else {
                PermissionDecision::Prompt
            }
        }
        PermissionMode::Bypass => find(PermissionOptionKind::AllowOnce)
            .map_or(PermissionDecision::Cancel, PermissionDecision::Auto),
    }
}

fn permission_kind_string(kind: PermissionOptionKind) -> String {
    match kind {
        PermissionOptionKind::AllowOnce => "allow_once",
        PermissionOptionKind::AllowAlways => "allow_always",
        PermissionOptionKind::RejectOnce => "reject_once",
        PermissionOptionKind::RejectAlways => "reject_always",
        _ => "unknown",
    }
    .to_string()
}

struct RawEvent {
    turn_id: Option<String>,
    payload: AcpEventPayload,
    ack: Option<oneshot::Sender<Result<(), String>>>,
}

impl RawEvent {
    fn new(turn_id: Option<String>, payload: AcpEventPayload) -> Self {
        Self {
            turn_id,
            payload,
            ack: None,
        }
    }
}

async fn run_event_pump(
    conversation_id: String,
    generation: u64,
    sink: Arc<RwLock<AcpEventSink>>,
    mut rx: mpsc::Receiver<RawEvent>,
    internal_cancel_tx: mpsc::UnboundedSender<InternalCancel>,
) {
    let mut sequence = 0_u64;
    let mut carry = None;
    loop {
        let mut event = match carry.take() {
            Some(event) => event,
            None => match rx.recv().await {
                Some(event) => event,
                None => break,
            },
        };

        while is_chunk(&event.payload) {
            match tokio::time::timeout(Duration::from_millis(3), rx.recv()).await {
                Ok(Some(next)) if merge_chunks(&mut event, &next) => {}
                Ok(Some(next)) => {
                    carry = Some(next);
                    break;
                }
                _ => break,
            }
        }

        sequence = sequence.saturating_add(1);
        let current_sink = sink
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let result = current_sink.send(AcpEvent {
            conversation_id: conversation_id.clone(),
            generation,
            sequence,
            turn_id: event.turn_id,
            payload: event.payload,
        });
        if let Some(ack) = event.ack {
            let _ = ack.send(result.clone());
        }
        if result.is_err() {
            let _ = internal_cancel_tx.send(InternalCancel::EventChannelClosed);
            break;
        }
    }
}

fn is_chunk(payload: &AcpEventPayload) -> bool {
    matches!(
        payload,
        AcpEventPayload::TextDelta { .. } | AcpEventPayload::ReasoningDelta { .. }
    )
}

fn merge_chunks(current: &mut RawEvent, next: &RawEvent) -> bool {
    if current.turn_id != next.turn_id || current.ack.is_some() || next.ack.is_some() {
        return false;
    }
    match (&mut current.payload, &next.payload) {
        (AcpEventPayload::TextDelta { text }, AcpEventPayload::TextDelta { text: next })
        | (
            AcpEventPayload::ReasoningDelta { text },
            AcpEventPayload::ReasoningDelta { text: next },
        ) if text.len().saturating_add(next.len()) <= MAX_EVENT_VALUE_BYTES => {
            text.push_str(next);
            true
        }
        _ => false,
    }
}

struct RawStopCaptureReader<R> {
    inner: R,
    buffer: Vec<u8>,
    line_bytes: usize,
    stop_tx: mpsc::UnboundedSender<String>,
}

impl<R> RawStopCaptureReader<R> {
    fn new(inner: R, stop_tx: mpsc::UnboundedSender<String>) -> Self {
        Self {
            inner,
            buffer: Vec::new(),
            line_bytes: 0,
            stop_tx,
        }
    }

    fn observe(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        for byte in bytes {
            if *byte == b'\n' {
                self.line_bytes = 0;
            } else {
                self.line_bytes = self.line_bytes.saturating_add(1);
                if self.line_bytes > MAX_JSON_LINE_BYTES {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "ACP JSON line exceeds its resource limit",
                    ));
                }
            }
        }
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > MAX_TURN_TEXT_BYTES {
            self.buffer.clear();
            return Ok(());
        }
        while let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<_> = self.buffer.drain(..=position).collect();
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if let Some(stop_reason) = value
                    .get("result")
                    .and_then(|result| result.get("stopReason"))
                    .and_then(Value::as_str)
                {
                    let _ = self.stop_tx.send(stop_reason.to_string());
                }
            }
        }
        Ok(())
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for RawStopCaptureReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        match Pin::new(&mut self.inner).poll_read(context, buffer) {
            Poll::Ready(Ok(())) => {
                let observed = buffer.filled()[before..].to_vec();
                Poll::Ready(self.observe(&observed))
            }
            result => result,
        }
    }
}

async fn run_session(
    options: StartSessionOptions,
    generation: u64,
    command_rx: mpsc::Receiver<SessionCommand>,
    ready: ReadySender,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let profile_id = options.profile_id.clone();
    let fingerprint = options.prepared.profile_fingerprint.clone();
    let cwd = options.prepared.cwd.clone();
    let mut process = spawn_process(options.prepared)?;
    let (stdin, stdout) = process.take_stdio()?;
    let (raw_stop_tx, raw_stop_rx) = mpsc::unbounded_channel();
    let transport = ByteStreams::new(
        stdin.compat_write(),
        RawStopCaptureReader::new(stdout, raw_stop_tx).compat(),
    );
    let (event_tx, event_rx) = mpsc::channel(EVENT_QUEUE_CAPACITY);
    let (internal_cancel_tx, internal_cancel_rx) = mpsc::unbounded_channel();
    let event_sink = Arc::new(RwLock::new(options.event_sink));
    let bridge = Arc::new(ClientBridge::new(
        Arc::clone(&event_sink),
        event_tx,
        internal_cancel_tx.clone(),
    ));
    tokio::spawn(run_event_pump(
        options.conversation_id.clone(),
        generation,
        event_sink,
        event_rx,
        internal_cancel_tx,
    ));

    let notification_bridge = Arc::clone(&bridge);
    let permission_bridge = Arc::clone(&bridge);
    let disconnect_bridge = Arc::clone(&bridge);
    let conversation_id = options.conversation_id.clone();
    let persisted_session_id = options.persisted_session_id.clone();
    let connection = agent_client_protocol::Client
        .builder()
        .name("thechat-desktop")
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                notification_bridge.handle_notification(notification);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                permission_bridge.handle_permission(request, responder)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(transport, move |connection: ConnectionTo<Agent>| {
            let bridge = Arc::clone(&bridge);
            let ready = Arc::clone(&ready);
            let conversation_id = conversation_id.clone();
            let cwd = cwd.clone();
            let persisted_session_id = persisted_session_id.clone();
            let profile_id = profile_id.clone();
            let fingerprint = fingerprint.clone();
            async move {
                let setup = setup_session(
                    &connection,
                    &bridge,
                    conversation_id,
                    generation,
                    profile_id,
                    fingerprint,
                    cwd,
                    persisted_session_id,
                )
                .await;
                let info = match setup {
                    Ok(info) => info,
                    Err(message) => {
                        send_ready(&ready, Err(message.clone()));
                        return Err(agent_client_protocol::Error::new(-32603, message));
                    }
                };
                if let Err(message) = bridge
                    .flush_event(
                        None,
                        AcpEventPayload::Connected {
                            session_id: info.session_id.clone(),
                            capabilities: info.capabilities.clone(),
                            resumed: info.loaded,
                        },
                    )
                    .await
                {
                    send_ready(&ready, Err(message.clone()));
                    return Err(agent_client_protocol::Error::new(-32603, message));
                }
                send_ready(&ready, Ok(info));
                session_command_loop(
                    connection,
                    bridge,
                    command_rx,
                    internal_cancel_rx,
                    raw_stop_rx,
                )
                .await
                .map_err(|message| agent_client_protocol::Error::new(-32603, message))
            }
        });
    tokio::pin!(connection);
    let cancellation = async {
        if *cancel_rx.borrow() {
            return;
        }
        while cancel_rx.changed().await.is_ok() {
            if *cancel_rx.borrow() {
                return;
            }
        }
    };
    tokio::pin!(cancellation);
    let (connection_result, disconnect_reason) = tokio::select! {
        result = &mut connection => (Some(result), "ACP adapter connection closed"),
        _ = &mut cancellation => (None, "ACP adapter session stopped"),
    };

    let _ = disconnect_bridge
        .flush_event(
            None,
            AcpEventPayload::Disconnected {
                reason: Some(disconnect_reason.into()),
            },
        )
        .await;
    let _ = process.terminate().await;
    match connection_result {
        Some(result) => result.map_err(|_| "ACP adapter connection closed".to_string()),
        None => Ok(()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn setup_session(
    connection: &ConnectionTo<Agent>,
    bridge: &ClientBridge,
    conversation_id: String,
    generation: u64,
    profile_id: String,
    profile_fingerprint: String,
    cwd: PathBuf,
    persisted_session_id: Option<String>,
) -> Result<AcpSessionInfo, String> {
    let initialize = tokio::time::timeout(
        CONNECT_TIMEOUT,
        connection
            .send_request(InitializeRequest::new(ProtocolVersion::V1).client_info(
                Implementation::new("thechat-desktop", env!("CARGO_PKG_VERSION")),
            ))
            .block_task(),
    )
    .await
    .map_err(|_| "ACP initialize timed out".to_string())?
    .map_err(|_| "ACP initialize failed".to_string())?;
    if initialize.protocol_version != ProtocolVersion::V1 {
        return Err("ACP adapter did not negotiate stable protocol v1".into());
    }

    let agent_name = initialize
        .agent_info
        .as_ref()
        .map(|agent| truncate_utf8(agent.name.clone(), 256));
    let agent_version = initialize
        .agent_info
        .as_ref()
        .map(|agent| truncate_utf8(agent.version.clone(), 128));
    let capabilities = AcpCapabilities {
        load_session: initialize.agent_capabilities.load_session,
        prompt: AcpPromptCapabilities {
            image: initialize.agent_capabilities.prompt_capabilities.image,
            audio: initialize.agent_capabilities.prompt_capabilities.audio,
            embedded_context: initialize
                .agent_capabilities
                .prompt_capabilities
                .embedded_context,
        },
    };
    let (session_id, loaded) = if let Some(session_id) = persisted_session_id {
        if !initialize.agent_capabilities.load_session {
            return Err(
                "Stored ACP continuity exists, but this adapter does not support session/load"
                    .into(),
            );
        }
        bridge.set_session_id(session_id.clone());
        bridge.set_forward_updates(false);
        tokio::time::timeout(
            CONNECT_TIMEOUT,
            connection
                .send_request(LoadSessionRequest::new(session_id.clone(), cwd))
                .block_task(),
        )
        .await
        .map_err(|_| {
            "ACP session/load timed out; adapter terminated before fresh start".to_string()
        })?
        .map_err(|_| {
            "ACP session/load failed; adapter terminated before fresh start".to_string()
        })?;
        bridge.set_forward_updates(true);
        (session_id, true)
    } else {
        bridge.set_forward_updates(false);
        let response = tokio::time::timeout(
            CONNECT_TIMEOUT,
            connection
                .send_request(NewSessionRequest::new(cwd))
                .block_task(),
        )
        .await
        .map_err(|_| "ACP session/new timed out".to_string())?
        .map_err(|_| "ACP session/new failed".to_string())?;
        let session_id = response.session_id.to_string();
        bridge.set_session_id(session_id.clone());
        bridge.set_forward_updates(true);
        (session_id, false)
    };

    Ok(AcpSessionInfo {
        conversation_id,
        generation,
        session_id,
        profile_id,
        profile_fingerprint,
        loaded,
        agent_name,
        agent_version,
        capabilities,
        warning: None,
    })
}

async fn session_command_loop(
    connection: ConnectionTo<Agent>,
    bridge: Arc<ClientBridge>,
    mut command_rx: mpsc::Receiver<SessionCommand>,
    mut internal_cancel_rx: mpsc::UnboundedReceiver<InternalCancel>,
    mut raw_stop_rx: mpsc::UnboundedReceiver<String>,
) -> Result<(), String> {
    loop {
        tokio::select! {
            command = command_rx.recv() => match command {
                Some(SessionCommand::Prompt { content, permission_mode, event_sink, response }) => {
                    if !run_prompt(
                        &connection,
                        &bridge,
                        content,
                        permission_mode,
                        event_sink,
                        response,
                        &mut command_rx,
                        &mut internal_cancel_rx,
                        &mut raw_stop_rx,
                    ).await? {
                        return Ok(());
                    }
                }
                Some(SessionCommand::RespondPermission { request_id, option_id, response }) => {
                    let _ = response.send(bridge.respond_permission(&request_id, option_id.as_deref()));
                }
                Some(SessionCommand::Cancel { response }) => {
                    let _ = response.send(Ok(()));
                }
                Some(SessionCommand::Stop { response }) => {
                    bridge.cancel_pending_permissions();
                    let _ = response.send(());
                    return Ok(());
                }
                None => return Ok(()),
            },
            reason = internal_cancel_rx.recv() => {
                if reason.is_some() {
                    bridge.cancel_pending_permissions();
                    return Err("ACP event channel closed or exceeded its resource limit".into());
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_prompt(
    connection: &ConnectionTo<Agent>,
    bridge: &ClientBridge,
    content: Vec<AcpPromptContent>,
    permission_mode: PermissionMode,
    event_sink: AcpEventSink,
    response: oneshot::Sender<Result<AcpTurnResult, String>>,
    command_rx: &mut mpsc::Receiver<SessionCommand>,
    internal_cancel_rx: &mut mpsc::UnboundedReceiver<InternalCancel>,
    raw_stop_rx: &mut mpsc::UnboundedReceiver<String>,
) -> Result<bool, String> {
    let prompt = match convert_prompt_content(content) {
        Ok(prompt) => prompt,
        Err(error) => {
            let _ = response.send(Err(error));
            return Ok(true);
        }
    };
    while raw_stop_rx.try_recv().is_ok() {}
    let session_id = bridge
        .session_id
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
        .ok_or_else(|| "ACP session has no protocol session id".to_string())?;
    let turn_id = Uuid::new_v4().to_string();
    bridge.configure_turn(permission_mode, event_sink);
    bridge.begin_turn(turn_id.clone());
    bridge.queue_event(RawEvent::new(
        Some(turn_id.clone()),
        AcpEventPayload::TurnStarted,
    ));
    let prompt_future = connection
        .send_request(PromptRequest::new(session_id.clone(), prompt))
        .block_task();
    tokio::pin!(prompt_future);
    let mut cancel_deadline = None;

    loop {
        tokio::select! {
            result = &mut prompt_future => {
                let raw_stop = tokio::time::timeout(Duration::from_millis(100), raw_stop_rx.recv())
                    .await
                    .ok()
                    .flatten();
                let stop_reason = match (result, raw_stop) {
                    (_, Some(raw)) => raw,
                    (Ok(result), None) => stop_reason_string(result.stop_reason),
                    (Err(_), None) => {
                        bridge.cancel_pending_permissions();
                        bridge.end_turn();
                        let _ = response.send(Err("ACP prompt failed".into()));
                        return Ok(true);
                    }
                };
                bridge.cancel_pending_permissions();
                let finish = bridge.finish_turn(turn_id.clone(), stop_reason.clone()).await;
                bridge.end_turn();
                if let Err(error) = finish {
                    let _ = response.send(Err(error));
                    return Ok(false);
                }
                let _ = response.send(Ok(AcpTurnResult { turn_id, stop_reason }));
                return Ok(true);
            }
            command = command_rx.recv() => match command {
                Some(SessionCommand::Prompt { response, .. }) => {
                    let _ = response.send(Err("An ACP prompt is already in flight".into()));
                }
                Some(SessionCommand::RespondPermission { request_id, option_id, response }) => {
                    let _ = response.send(bridge.respond_permission(&request_id, option_id.as_deref()));
                }
                Some(SessionCommand::Cancel { response: cancel_response }) => {
                    bridge.cancel_pending_permissions();
                    let sent = connection
                        .send_notification(CancelNotification::new(session_id.clone()))
                        .map_err(|_| "Failed to send ACP cancellation".to_string());
                    if sent.is_ok() && cancel_deadline.is_none() {
                        cancel_deadline = Some(tokio::time::Instant::now() + CANCEL_TIMEOUT);
                    }
                    let _ = cancel_response.send(sent);
                }
                Some(SessionCommand::Stop { response: stop_response }) => {
                    bridge.cancel_pending_permissions();
                    let _ = connection.send_notification(CancelNotification::new(session_id.clone()));
                    bridge.end_turn();
                    let _ = response.send(Err("ACP session stopped".into()));
                    let _ = stop_response.send(());
                    return Ok(false);
                }
                None => {
                    bridge.cancel_pending_permissions();
                    let _ = connection.send_notification(CancelNotification::new(session_id.clone()));
                    bridge.end_turn();
                    let _ = response.send(Err("ACP command channel closed".into()));
                    return Ok(false);
                }
            },
            reason = internal_cancel_rx.recv() => {
                if reason.is_some() {
                    bridge.cancel_pending_permissions();
                    let _ = connection.send_notification(CancelNotification::new(session_id.clone()));
                    if cancel_deadline.is_none() {
                        cancel_deadline = Some(tokio::time::Instant::now() + CANCEL_TIMEOUT);
                    }
                }
            }
            _ = wait_for_deadline(cancel_deadline), if cancel_deadline.is_some() => {
                bridge.cancel_pending_permissions();
                bridge.end_turn();
                let _ = response.send(Err("ACP cancellation timed out; adapter terminated".into()));
                return Ok(false);
            }
        }
    }
}

async fn wait_for_deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending::<()>().await,
    }
}

fn convert_prompt_content(content: Vec<AcpPromptContent>) -> Result<Vec<ContentBlock>, String> {
    if content.is_empty() {
        return Err("ACP prompt content cannot be empty".into());
    }
    if content.len() > MAX_PROMPT_BLOCKS {
        return Err("ACP prompt has too many content blocks".into());
    }
    let total_bytes = content.iter().fold(0usize, |total, block| {
        total.saturating_add(match block {
            AcpPromptContent::Text { text } => text.len(),
            AcpPromptContent::Image { data, mime_type } => data.len() + mime_type.len(),
        })
    });
    if total_bytes > MAX_PROMPT_TOTAL_BYTES {
        return Err("ACP prompt exceeds its aggregate resource limit".into());
    }
    content
        .into_iter()
        .map(|content| match content {
            AcpPromptContent::Text { text } => {
                if text.len() > MAX_PROMPT_TEXT_BYTES || text.contains('\0') {
                    return Err("ACP prompt text exceeds its resource limit".into());
                }
                Ok(ContentBlock::Text(TextContent::new(text)))
            }
            AcpPromptContent::Image { data, mime_type } => {
                if data.len() > MAX_PROMPT_IMAGE_BYTES
                    || mime_type.len() > 256
                    || !mime_type.starts_with("image/")
                {
                    return Err("ACP prompt image exceeds its resource limit".into());
                }
                Ok(ContentBlock::Image(ImageContent::new(data, mime_type)))
            }
        })
        .collect()
}

fn stop_reason_string(stop_reason: StopReason) -> String {
    serde_json::to_value(stop_reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

fn normalized_tool_call(value: &impl Serialize) -> Value {
    let raw = serde_json::to_value(value).unwrap_or(Value::Null);
    let id = raw
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(|value| truncate_utf8(value.to_string(), 512))
        .unwrap_or_else(|| "unknown-tool-call".into());
    let title = raw
        .get("title")
        .and_then(Value::as_str)
        .map(|value| truncate_utf8(value.to_string(), 1024));
    let mut object = serde_json::Map::new();
    object.insert("id".into(), Value::String(id));
    if let Some(title) = title {
        object.insert("name".into(), Value::String(title.clone()));
        object.insert("title".into(), Value::String(title));
    }
    for field in [
        "kind",
        "status",
        "content",
        "locations",
        "rawInput",
        "rawOutput",
    ] {
        if let Some(value) = raw.get(field) {
            object.insert(field.into(), bounded_value(value));
        }
    }
    Value::Object(object)
}

fn take_value_field(mut value: Value, field: &str) -> Value {
    if let Value::Object(object) = &mut value {
        object.remove(field).unwrap_or(Value::Array(Vec::new()))
    } else {
        value
    }
}

fn bounded_value(value: &impl Serialize) -> Value {
    match serde_json::to_vec(value) {
        Ok(encoded) if encoded.len() <= MAX_EVENT_VALUE_BYTES => {
            serde_json::from_slice(&encoded).unwrap_or(Value::Null)
        }
        _ => serde_json::json!({ "truncated": true }),
    }
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value
}

fn send_ready(ready: &ReadySender, result: Result<AcpSessionInfo, String>) {
    if let Some(sender) = ready
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        let _ = sender.send(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AcpProfile;
    use agent_client_protocol::schema::v1::{
        PermissionOption, ToolCallUpdate, ToolCallUpdateFields,
    };
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    fn prepared_for_test(
        profile: &AcpProfile,
        cwd: &Path,
        parent_env: &HashMap<String, String>,
    ) -> PreparedProcess {
        prepare_process(profile, cwd, parent_env, None, &[7_u8; 32]).unwrap()
    }

    #[cfg(unix)]
    fn fake_start_options(
        conversation_id: &str,
        generation: u64,
        cwd: &Path,
    ) -> StartSessionOptions {
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_acp_agent.py");
        let profile = AcpProfile {
            id: "fake-agent".into(),
            name: "Fake Agent".into(),
            executable: "python3".into(),
            args: vec![fixture.to_string_lossy().into_owned()],
            inherit_env: Vec::new(),
            disabled: false,
        };
        let parent_env = HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), std::env::var("HOME").unwrap()),
        ]);
        let prepared = prepared_for_test(&profile, cwd, &parent_env);
        StartSessionOptions {
            conversation_id: conversation_id.into(),
            generation,
            profile_id: profile.id,
            prepared,
            persisted_session_id: None,
            event_sink: AcpEventSink::new(|_| Ok(())),
        }
    }

    #[cfg(unix)]
    fn hanging_start_options(
        conversation_id: &str,
        generation: u64,
        cwd: &Path,
    ) -> StartSessionOptions {
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_acp_agent.py");
        let profile = AcpProfile {
            id: "hanging-fake-agent".into(),
            name: "Hanging fake agent".into(),
            executable: "python3".into(),
            args: vec![
                fixture.to_string_lossy().into_owned(),
                "--hang-initialize".into(),
            ],
            inherit_env: Vec::new(),
            disabled: false,
        };
        let parent_env = HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), std::env::var("HOME").unwrap()),
        ]);
        StartSessionOptions {
            conversation_id: conversation_id.into(),
            generation,
            profile_id: profile.id.clone(),
            prepared: prepared_for_test(&profile, cwd, &parent_env),
            persisted_session_id: None,
            event_sink: AcpEventSink::new(|_| Ok(())),
        }
    }

    #[tokio::test]
    async fn stop_all_sessions_is_idempotent_when_empty() {
        let manager = AcpManager::new();
        manager.stop_all_sessions().await.unwrap();
        manager.stop_all_sessions().await.unwrap();
        assert_eq!(manager.active_session_count().await, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn session_replacement_is_monotonic_by_generation() {
        let project = tempfile::tempdir().unwrap();
        let manager = AcpManager::new();

        manager
            .start_session(fake_start_options("generation-test", 2, project.path()))
            .await
            .unwrap();
        let stale = manager
            .start_session(fake_start_options("generation-test", 1, project.path()))
            .await
            .unwrap_err();
        assert_eq!(stale, "Stale ACP generation");
        assert_eq!(manager.active_session_count().await, 1);

        let replacement = manager
            .start_session(fake_start_options("generation-test", 3, project.path()))
            .await
            .unwrap();
        assert_eq!(replacement.generation, 3);
        assert_eq!(manager.active_session_count().await, 1);
        manager
            .stop_session_generation("generation-test", 3)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removed_session_generation_cannot_be_resurrected() {
        let project = tempfile::tempdir().unwrap();
        let manager = AcpManager::new();
        manager
            .start_session(fake_start_options("removed-generation", 2, project.path()))
            .await
            .unwrap();
        manager
            .stop_session_generation("removed-generation", 2)
            .await
            .unwrap();
        let stale = manager
            .start_session(fake_start_options("removed-generation", 1, project.path()))
            .await
            .unwrap_err();
        assert_eq!(stale, "Stale ACP generation");
        assert_eq!(manager.active_session_count().await, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_during_startup_waits_for_process_cleanup() {
        let project = tempfile::tempdir().unwrap();
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_acp_agent.py");
        let profile = AcpProfile {
            id: "hanging-fake-agent".into(),
            name: "Hanging fake agent".into(),
            executable: "python3".into(),
            args: vec![
                fixture.to_string_lossy().into_owned(),
                "--hang-initialize".into(),
            ],
            inherit_env: Vec::new(),
            disabled: false,
        };
        let parent_env = HashMap::from([
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), std::env::var("HOME").unwrap()),
        ]);
        let options = StartSessionOptions {
            conversation_id: "startup-stop".into(),
            generation: 1,
            profile_id: profile.id.clone(),
            prepared: prepared_for_test(&profile, project.path(), &parent_env),
            persisted_session_id: None,
            event_sink: AcpEventSink::new(|_| Ok(())),
        };
        let manager = AcpManager::new();
        let start_manager = manager.clone();
        let start = tokio::spawn(async move { start_manager.start_session(options).await });

        let marker = project.path().join(".fake-acp-initialize-received");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !marker.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        manager
            .stop_session_generation("startup-stop", 1)
            .await
            .unwrap();
        let start_error = tokio::time::timeout(Duration::from_secs(2), start)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(start_error.contains("stopped during startup"));
        assert_eq!(manager.active_session_count().await, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_during_startup_uses_out_of_band_cleanup() {
        let project = tempfile::tempdir().unwrap();
        let manager = AcpManager::new();
        let start_manager = manager.clone();
        let options = hanging_start_options("startup-cancel", 1, project.path());
        let start = tokio::spawn(async move { start_manager.start_session(options).await });

        let marker = project.path().join(".fake-acp-initialize-received");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !marker.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        manager.cancel_session("startup-cancel", 1).await.unwrap();
        let start_error = tokio::time::timeout(Duration::from_secs(2), start)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(start_error.contains("stopped during startup"));
        assert_eq!(manager.active_session_count().await, 0);
    }

    fn permission_request(
        kind: ToolKind,
        option_kinds: &[PermissionOptionKind],
    ) -> RequestPermissionRequest {
        let mut fields = ToolCallUpdateFields::default();
        fields.kind = Some(kind);
        RequestPermissionRequest::new(
            "session",
            ToolCallUpdate::new("tool", fields),
            option_kinds
                .iter()
                .enumerate()
                .map(|(index, kind)| {
                    PermissionOption::new(
                        format!("option-{index}"),
                        format!("Option {index}"),
                        *kind,
                    )
                })
                .collect(),
        )
    }

    fn selected_option(decision: PermissionDecision) -> Option<String> {
        match decision {
            PermissionDecision::Auto(id) => Some(id.to_string()),
            PermissionDecision::Prompt | PermissionDecision::Cancel => None,
        }
    }

    #[test]
    fn automatic_permission_modes_never_persist_or_widen_grants() {
        let offered = [
            PermissionOptionKind::AllowAlways,
            PermissionOptionKind::AllowOnce,
        ];
        assert!(matches!(
            permission_decision(
                PermissionMode::Request,
                &permission_request(ToolKind::Edit, &offered),
            ),
            PermissionDecision::Prompt
        ));
        assert_eq!(
            selected_option(permission_decision(
                PermissionMode::AllowEdits,
                &permission_request(ToolKind::Edit, &offered),
            )),
            Some("option-1".into())
        );
        for kind in [
            ToolKind::Move,
            ToolKind::Delete,
            ToolKind::Execute,
            ToolKind::Fetch,
            ToolKind::Other,
        ] {
            assert!(matches!(
                permission_decision(
                    PermissionMode::AllowEdits,
                    &permission_request(kind, &offered),
                ),
                PermissionDecision::Prompt
            ));
        }
        assert_eq!(
            selected_option(permission_decision(
                PermissionMode::Bypass,
                &permission_request(ToolKind::Execute, &offered),
            )),
            Some("option-1".into())
        );
        assert!(matches!(
            permission_decision(
                PermissionMode::Bypass,
                &permission_request(ToolKind::Execute, &[PermissionOptionKind::AllowAlways],),
            ),
            PermissionDecision::Cancel
        ));
        assert!(matches!(
            permission_decision(
                PermissionMode::AllowEdits,
                &permission_request(ToolKind::Edit, &[PermissionOptionKind::AllowAlways],),
            ),
            PermissionDecision::Prompt
        ));
    }

    #[test]
    fn transport_and_prompt_resource_limits_fail_closed() {
        let (stop_tx, _stop_rx) = mpsc::unbounded_channel();
        let mut reader = RawStopCaptureReader::new(tokio::io::empty(), stop_tx);
        assert!(reader
            .observe(&vec![b'x'; MAX_JSON_LINE_BYTES + 1])
            .is_err());

        let too_many = (0..=MAX_PROMPT_BLOCKS)
            .map(|_| AcpPromptContent::Text { text: "x".into() })
            .collect();
        assert!(convert_prompt_content(too_many).is_err());
        assert!(convert_prompt_content(vec![AcpPromptContent::Image {
            data: "x".repeat(MAX_PROMPT_TOTAL_BYTES + 1),
            mime_type: "image/png".into(),
        }])
        .is_err());
    }

    #[test]
    fn acp_event_serialization_matches_frontend_channel_contract() {
        let event = AcpEvent {
            conversation_id: "conversation-1".into(),
            generation: 7,
            sequence: 3,
            turn_id: Some("turn-1".into()),
            payload: AcpEventPayload::TextDelta {
                text: "delta".into(),
            },
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "conversationId": "conversation-1",
                "generation": 7,
                "sequence": 3,
                "turnId": "turn-1",
                "type": "text_delta",
                "text": "delta"
            })
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_agent_stable_v1_round_trip_streams_and_applies_allow_edits_policy() {
        let project = tempfile::tempdir().unwrap();
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_acp_agent.py");
        let profile = AcpProfile {
            id: "fake-agent".into(),
            name: "Fake Agent".into(),
            executable: "python3".into(),
            args: vec![fixture.to_string_lossy().into_owned()],
            inherit_env: Vec::new(),
            disabled: false,
        };
        let mut parent_env = HashMap::new();
        parent_env.insert("PATH".into(), std::env::var("PATH").unwrap());
        parent_env.insert("HOME".into(), std::env::var("HOME").unwrap());
        let (connect_event_tx, mut connect_event_rx) = tokio::sync::mpsc::unbounded_channel();
        let connect_event_sink = AcpEventSink::new(move |event| {
            connect_event_tx
                .send(event)
                .map_err(|_| "event receiver closed".into())
        });
        let prepared =
            prepare_process(&profile, project.path(), &parent_env, None, &[7_u8; 32]).unwrap();
        let manager = AcpManager::new();

        let started = manager
            .start_session(StartSessionOptions {
                conversation_id: "conversation-1".into(),
                generation: 1,
                profile_id: profile.id,
                prepared,
                persisted_session_id: None,
                event_sink: connect_event_sink,
            })
            .await
            .unwrap();
        assert_eq!(started.session_id, "fake-session");
        assert!(!started.loaded);
        assert!(started.capabilities.load_session);
        assert!(!started.capabilities.prompt.image);
        assert!(!started.capabilities.prompt.audio);
        assert!(!started.capabilities.prompt.embedded_context);

        let (prompt_event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let prompt_event_sink = AcpEventSink::new(move |event| {
            prompt_event_tx
                .send(event)
                .map_err(|_| "event receiver closed".into())
        });
        let prompt = manager.prompt(
            "conversation-1",
            1,
            vec![AcpPromptContent::Text {
                text: "hello".into(),
            }],
            PermissionMode::Request,
            prompt_event_sink,
        );
        let approve = async {
            let mut events = Vec::new();
            while let Some(event) = event_rx.recv().await {
                let permission = match &event.payload {
                    AcpEventPayload::PermissionRequest { permission } => Some(permission.clone()),
                    _ => None,
                };
                events.push(event);
                if let Some(permission) = permission {
                    manager
                        .respond_permission(
                            "conversation-1",
                            1,
                            permission.id,
                            Some("allow-once".into()),
                        )
                        .await
                        .unwrap();
                    break;
                }
            }
            events
        };
        let (turn, mut events) = tokio::join!(prompt, approve);
        let turn = turn.unwrap();
        assert_eq!(turn.stop_reason, "end_turn");

        let connected = tokio::time::timeout(Duration::from_secs(1), connect_event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            connected.payload,
            AcpEventPayload::Connected { resumed: false, .. }
        ));

        while let Ok(event) = event_rx.try_recv() {
            events.push(event);
        }
        assert!(connect_event_rx.try_recv().is_err());
        assert!(events.iter().any(|event| matches!(
            &event.payload,
            AcpEventPayload::TextDelta { text } if text == "hello from fake"
        )));
        assert!(matches!(
            events.last().map(|event| &event.payload),
            Some(AcpEventPayload::TurnFinished { result }) if result.stop_reason == "end_turn"
        ));
        assert!(events
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence));

        manager.stop_session("conversation-1").await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires an explicitly supplied real ACP adapter"]
    async fn real_acp_adapter_round_trip_cancel_and_load_from_env() {
        let executable = std::env::var("THECHAT_ACP_TEST_EXECUTABLE").unwrap();
        let args: Vec<String> = serde_json::from_str(
            &std::env::var("THECHAT_ACP_TEST_ARGS_JSON").unwrap_or_else(|_| "[]".into()),
        )
        .unwrap();
        let cwd = PathBuf::from(
            std::env::var("THECHAT_ACP_TEST_CWD")
                .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").into()),
        );
        let profile = AcpProfile {
            id: "real-adapter".into(),
            name: "Real adapter".into(),
            executable,
            args,
            inherit_env: Vec::new(),
            disabled: false,
        };
        let parent_env: HashMap<String, String> = std::env::vars().collect();
        let prepared = prepared_for_test(&profile, &cwd, &parent_env);
        let manager = AcpManager::new();
        let started = manager
            .start_session(StartSessionOptions {
                conversation_id: "real-conversation".into(),
                generation: 1,
                profile_id: profile.id.clone(),
                prepared,
                persisted_session_id: None,
                event_sink: AcpEventSink::new(|_| Ok(())),
            })
            .await
            .unwrap();

        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let turn = manager
            .prompt(
                "real-conversation",
                1,
                vec![AcpPromptContent::Text {
                    text: "Reply with exactly OK. Do not use tools or change files.".into(),
                }],
                PermissionMode::Request,
                AcpEventSink::new(move |event| {
                    event_tx
                        .send(event)
                        .map_err(|_| "event receiver closed".into())
                }),
            )
            .await
            .unwrap();
        assert_eq!(turn.stop_reason, "end_turn");
        let mut saw_text = false;
        while let Ok(event) = event_rx.try_recv() {
            if matches!(event.payload, AcpEventPayload::TextDelta { .. }) {
                saw_text = true;
            }
        }
        assert!(saw_text, "real adapter produced no text delta");

        let cancel_turn = manager.prompt(
            "real-conversation",
            1,
            vec![AcpPromptContent::Text {
                text: "Explain ACP in several paragraphs without using tools.".into(),
            }],
            PermissionMode::Request,
            AcpEventSink::new(|_| Ok(())),
        );
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            manager.cancel_session("real-conversation", 1).await
        };
        let (cancelled, cancel_result) = tokio::join!(cancel_turn, cancel);
        cancel_result.unwrap();
        assert_eq!(cancelled.unwrap().stop_reason, "cancelled");

        manager.stop_session("real-conversation").await.unwrap();
        let prepared = prepared_for_test(&profile, &cwd, &parent_env);
        let resumed = manager
            .start_session(StartSessionOptions {
                conversation_id: "real-conversation-resumed".into(),
                generation: 2,
                profile_id: profile.id,
                prepared,
                persisted_session_id: Some(started.session_id),
                event_sink: AcpEventSink::new(|_| Ok(())),
            })
            .await
            .unwrap();
        assert!(resumed.loaded);
        manager
            .stop_session("real-conversation-resumed")
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires an explicitly supplied real ACP adapter"]
    async fn real_acp_adapter_connect_only_from_env() {
        let executable = std::env::var("THECHAT_ACP_TEST_EXECUTABLE").unwrap();
        let args: Vec<String> = serde_json::from_str(
            &std::env::var("THECHAT_ACP_TEST_ARGS_JSON").unwrap_or_else(|_| "[]".into()),
        )
        .unwrap();
        let profile = AcpProfile {
            id: "real-connect-adapter".into(),
            name: "Real connect adapter".into(),
            executable,
            args,
            inherit_env: Vec::new(),
            disabled: false,
        };
        let cwd = PathBuf::from(
            std::env::var("THECHAT_ACP_TEST_CWD")
                .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").into()),
        );
        let parent_env = std::env::vars().collect();
        let prepared = prepared_for_test(&profile, &cwd, &parent_env);
        let manager = AcpManager::new();
        let started = manager
            .start_session(StartSessionOptions {
                conversation_id: "real-connect-conversation".into(),
                generation: 1,
                profile_id: profile.id,
                prepared,
                persisted_session_id: None,
                event_sink: AcpEventSink::new(|_| Ok(())),
            })
            .await
            .unwrap();
        assert!(!started.session_id.is_empty());
        manager
            .stop_session("real-connect-conversation")
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires an explicitly supplied real ACP adapter"]
    async fn real_acp_adapter_expected_connect_error_from_env() {
        let expected = std::env::var("THECHAT_ACP_TEST_EXPECT_ERROR").unwrap();
        let executable = std::env::var("THECHAT_ACP_TEST_EXECUTABLE").unwrap();
        let args: Vec<String> = serde_json::from_str(
            &std::env::var("THECHAT_ACP_TEST_ARGS_JSON").unwrap_or_else(|_| "[]".into()),
        )
        .unwrap();
        let profile = AcpProfile {
            id: "real-error-adapter".into(),
            name: "Real error adapter".into(),
            executable,
            args,
            inherit_env: Vec::new(),
            disabled: false,
        };
        let cwd = PathBuf::from(
            std::env::var("THECHAT_ACP_TEST_CWD")
                .unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").into()),
        );
        let parent_env = std::env::vars().collect();
        let prepared = prepared_for_test(&profile, &cwd, &parent_env);
        let manager = AcpManager::new();
        let result = manager
            .start_session(StartSessionOptions {
                conversation_id: "real-error-conversation".into(),
                generation: 1,
                profile_id: profile.id,
                prepared,
                persisted_session_id: None,
                event_sink: AcpEventSink::new(|_| Ok(())),
            })
            .await;
        let error = match result {
            Ok(_) => panic!("real adapter unexpectedly connected"),
            Err(error) => error,
        };
        assert!(
            error
                .to_ascii_lowercase()
                .contains(&expected.to_ascii_lowercase()),
            "unexpected adapter error: {error}"
        );
    }
}
