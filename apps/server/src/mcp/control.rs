//! The outside-agent MCP tools on `/mcp` (#139): one registration table for every tool the
//! endpoint serves, the per-call principal and scope check, and the first-slice thread tools.
//!
//! Thread tools run inside the server and reach the same RPC handlers the UI uses through
//! [`RpcRegistry::invoke_local`], so they share its scope checks, maintenance admission,
//! command-receipt replay and timing. They take ids, never paths or commands; the server
//! resolves a thread's working directory. Every result is capped at 80 000 characters and says
//! that thread content is untrusted output from agents and tools. Destructive operations,
//! settings, credentials and approvals have no tools: omission is the control, because
//! `orchestration:operate` already covers them.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::protocol::{Cut, fit_list, tool_descriptor, tool_result, typed_tool_failure};
use crate::{
    auth::{AuthService, Principal, SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ},
    orchestration::OrchestrationEngine,
    persistence::Repositories,
    rpc::{RpcRegistry, RpcSessionContext},
};

/// The characters of one message's text a page returns; `textOffset` reads the rest.
pub(crate) const MESSAGE_TEXT_CHARS: i64 = 16_000;
/// The patch characters one `get_turn_diff` page returns. JSON escaping can double a patch's
/// length, so this stays well under the 80 000-character result cap.
const DIFF_PAGE_CHARS: usize = 30_000;
const DEFAULT_THREAD_PAGE: i64 = 20;
const MOST_THREAD_PAGE: i64 = 100;
const MOST_QUEUED: i64 = 20;
const DEFAULT_LIST_LIMIT: usize = 50;
const MOST_LIST_LIMIT: usize = 200;
/// Models a provider lists beyond its custom and default ones.
const EXTRA_MODELS: usize = 8;
/// How long a tool list may be cached: it changes with the access setting.
const LIST_TTL_MS: u64 = 60_000;
/// Concurrency bounds: calls and waits per client session, and waits per environment.
const MOST_CALLS_PER_SESSION: usize = 8;
const MOST_WAITS_PER_SESSION: usize = 4;
const MOST_WAITS: usize = 32;
/// Retry rows older than this are pruned on insert, which ends their retry window.
const REQUEST_ROW_TTL_SECONDS: i64 = 24 * 60 * 60;

pub(crate) const DISABLED_TAG: &str = "McpServerDisabledError";
/// The JSON-RPC error code of a non-tool request while the server is off.
pub(crate) const DISABLED_CODE: i64 = -32001;
pub(crate) const DISABLED_MESSAGE: &str = "The MCP server is turned off for this environment. Turn on Settings → Agents → Agent integrations → MCP server.";

/// The access an outside agent's MCP connection is allowed, lowest first. The three operate
/// levels are the runtime modes the threads it starts or messages may run with.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum McpAccess {
    ReadOnly,
    ApprovalRequired,
    AutoAcceptEdits,
    FullAccess,
}

impl McpAccess {
    pub const DEFAULT: Self = Self::ApprovalRequired;

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "read-only" => Self::ReadOnly,
            "approval-required" => Self::ApprovalRequired,
            "auto-accept-edits" => Self::AutoAcceptEdits,
            "full-access" => Self::FullAccess,
            _ => return None,
        })
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::ApprovalRequired => "approval-required",
            Self::AutoAcceptEdits => "auto-accept-edits",
            Self::FullAccess => "full-access",
        }
    }

    /// The level of a thread running in `runtime_mode`; an unknown mode counts as the highest.
    #[must_use]
    pub fn of_runtime_mode(runtime_mode: &str) -> Self {
        match Self::parse(runtime_mode) {
            Some(Self::ReadOnly) | None => Self::FullAccess,
            Some(level) => level,
        }
    }
}

/// The committed `enableMcpServer` and `mcpServerAccess`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct McpServerSettings {
    pub enabled: bool,
    pub access: McpAccess,
}

impl Default for McpServerSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            access: McpAccess::DEFAULT,
        }
    }
}

/// The MCP settings of a server settings document; absent keys take their defaults.
#[must_use]
pub fn mcp_server_settings(settings: &Value) -> McpServerSettings {
    McpServerSettings {
        enabled: settings
            .get("enableMcpServer")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        access: settings
            .get("mcpServerAccess")
            .and_then(Value::as_str)
            .and_then(McpAccess::parse)
            .unwrap_or(McpAccess::DEFAULT),
    }
}

/// Which credential a tool is for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrincipalKind {
    /// A provider BiBCode launched: `preview_*` and `device_*`.
    Provider,
    /// An outside agent's `mcp-client` session: the thread tools.
    Client,
}

/// One registered tool. Registration is the only way to add a tool: the call path looks the
/// spec up and checks its principal kind and scope before the handler runs.
#[derive(Clone, Copy, Debug)]
pub struct ToolSpec {
    pub name: &'static str,
    pub kind: PrincipalKind,
    /// `required_scope` of the RPC method the tool maps to.
    pub scope: &'static str,
    /// The RPC methods the tool dispatches to, for timing and `is_long_running`.
    pub methods: &'static [&'static str],
    /// The tool waits by design.
    pub waits: bool,
    pub read_only: bool,
}

const fn client(
    name: &'static str,
    scope: &'static str,
    methods: &'static [&'static str],
    read_only: bool,
) -> ToolSpec {
    ToolSpec {
        name,
        kind: PrincipalKind::Client,
        scope,
        methods,
        waits: false,
        read_only,
    }
}

const DISPATCH: &[&str] = &["orchestration.dispatchCommand"];

/// The thread tools, in the order `tools/list` shows them.
pub const CLIENT_TOOLS: &[ToolSpec] = &[
    client(
        "list_projects_and_threads",
        SCOPE_ORCHESTRATION_READ,
        &["orchestration.subscribeShell"],
        true,
    ),
    client(
        "list_providers_and_models",
        SCOPE_ORCHESTRATION_READ,
        &["server.getConfig"],
        true,
    ),
    client("start_thread", SCOPE_ORCHESTRATION_OPERATE, DISPATCH, false),
    client("send_message", SCOPE_ORCHESTRATION_OPERATE, DISPATCH, false),
    ToolSpec {
        name: "wait_for_thread",
        kind: PrincipalKind::Client,
        scope: SCOPE_ORCHESTRATION_READ,
        methods: &["orchestration.subscribeThread"],
        waits: true,
        read_only: true,
    },
    client(
        "read_thread",
        SCOPE_ORCHESTRATION_READ,
        &["orchestration.subscribeThread"],
        true,
    ),
    client(
        "list_pending_requests",
        SCOPE_ORCHESTRATION_READ,
        &["orchestration.subscribeThread"],
        true,
    ),
    client(
        "answer_question",
        SCOPE_ORCHESTRATION_OPERATE,
        DISPATCH,
        false,
    ),
    client(
        "interrupt_turn",
        SCOPE_ORCHESTRATION_OPERATE,
        DISPATCH,
        false,
    ),
    client(
        "get_turn_diff",
        SCOPE_ORCHESTRATION_READ,
        &["orchestration.getTurnDiff"],
        true,
    ),
    client(
        "git_status",
        SCOPE_ORCHESTRATION_READ,
        &["vcs.refreshStatus"],
        true,
    ),
];

/// The provider tools' shared spec: every `preview_*` and `device_*` needs
/// `orchestration:operate`, which a provider credential holds implicitly.
const PROVIDER_TOOL: ToolSpec = ToolSpec {
    name: "preview_* / device_*",
    kind: PrincipalKind::Provider,
    scope: SCOPE_ORCHESTRATION_OPERATE,
    methods: &[],
    // They wait on a page in the preview browser or on an emulator (`device.open` is
    // long-running too), so their duration says little about the server.
    waits: true,
    read_only: false,
};

/// The scopes a provider credential holds implicitly.
pub const PROVIDER_SCOPES: &[&str] = &[SCOPE_ORCHESTRATION_READ, SCOPE_ORCHESTRATION_OPERATE];

/// The registered spec of `name`, or `None` for a tool that does not exist.
#[must_use]
pub fn tool_spec(name: &str) -> Option<ToolSpec> {
    if name.starts_with("preview_") || name.starts_with("device_") {
        return Some(PROVIDER_TOOL);
    }
    CLIENT_TOOLS.iter().copied().find(|spec| spec.name == name)
}

/// The per-call check: the tool exists, is for this kind of credential, and the credential
/// holds its scope. A call to the other kind's tool is a scope refusal.
pub fn authorize_call(kind: PrincipalKind, scopes: &[&str], name: &str) -> Result<ToolSpec, Value> {
    let Some(spec) = tool_spec(name) else {
        return Err(typed_tool_failure("McpUnknownToolError", "Unknown tool."));
    };
    if spec.kind != kind || !scopes.contains(&spec.scope) {
        return Err(typed_tool_failure(
            "McpScopeError",
            &format!("This MCP credential may not call {name}."),
        ));
    }
    Ok(spec)
}

/// The timing name of a tool call.
#[must_use]
pub fn timing_name(tool: &str) -> String {
    format!("mcp.{tool}")
}

/// An outside agent's authenticated credential.
#[derive(Clone, Debug)]
pub struct ClientPrincipal {
    pub principal: Principal,
    /// The ceiling bound to the credential; a session without one is read-only.
    pub ceiling: McpAccess,
}

/// Progress notifications for one `tools/call`, sent on its own response stream.
pub type ProgressSink = mpsc::Sender<Value>;

/// The outside-agent tool service of one environment.
#[derive(Clone)]
pub struct McpControl {
    inner: Arc<Inner>,
}

struct Inner {
    registry: RpcRegistry,
    auth: AuthService,
    engine: OrchestrationEngine,
    repositories: Repositories,
    settings: watch::Receiver<McpServerSettings>,
    shutdown: CancellationToken,
    sessions: Mutex<HashMap<String, Load>>,
    waits: AtomicUsize,
}

#[derive(Default)]
struct Load {
    calls: usize,
    waits: usize,
}

/// Holds one call's (and, for a wait, one wait's) place within the limits.
struct Admission {
    inner: Arc<Inner>,
    session_id: String,
    wait: bool,
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(load) = sessions.get_mut(&self.session_id) {
            load.calls = load.calls.saturating_sub(1);
            if self.wait {
                load.waits = load.waits.saturating_sub(1);
            }
            if load.calls == 0 {
                sessions.remove(&self.session_id);
            }
        }
        if self.wait {
            self.inner.waits.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

type ToolResult = Result<Value, Value>;

impl McpControl {
    #[must_use]
    pub fn new(
        registry: RpcRegistry,
        auth: AuthService,
        engine: OrchestrationEngine,
        settings: watch::Receiver<McpServerSettings>,
    ) -> Self {
        let repositories = engine.repositories();
        Self {
            inner: Arc::new(Inner {
                registry,
                auth,
                engine,
                repositories,
                settings,
                shutdown: CancellationToken::new(),
                sessions: Mutex::new(HashMap::new()),
                waits: AtomicUsize::new(0),
            }),
        }
    }

    /// Refuses new calls and ends every wait in flight. The runtime calls this right after the
    /// profiler starts stopping, before the orchestration engine shuts down.
    pub fn shutdown(&self) {
        self.inner.shutdown.cancel();
    }

    #[must_use]
    pub fn settings(&self) -> McpServerSettings {
        *self.inner.settings.borrow()
    }

    /// The outside agent behind `token`, or `None` for any other credential.
    pub async fn authenticate(&self, token: &str) -> Option<ClientPrincipal> {
        let (principal, access) = self.inner.auth.authenticate_mcp_client(token).await.ok()?;
        let ceiling = access
            .as_deref()
            .and_then(McpAccess::parse)
            .unwrap_or(McpAccess::ReadOnly);
        Some(ClientPrincipal { principal, ceiling })
    }

    /// The lower of the credential's ceiling and the environment's setting.
    #[must_use]
    pub fn effective_ceiling(&self, principal: &ClientPrincipal) -> McpAccess {
        principal.ceiling.min(self.settings().access)
    }

    /// The tools this principal may call now: the operate tools are hidden at read-only.
    #[must_use]
    pub fn tools(&self, principal: &ClientPrincipal) -> Value {
        let read_only = self.effective_ceiling(principal) == McpAccess::ReadOnly;
        Value::Array(
            CLIENT_TOOLS
                .iter()
                .filter(|spec| spec.read_only || !read_only)
                .map(describe)
                .collect(),
        )
    }

    #[must_use]
    pub fn list_ttl_ms(&self) -> u64 {
        LIST_TTL_MS
    }

    /// Runs one thread tool. Every refusal or failure is a typed tool result.
    pub async fn call(
        &self,
        principal: &ClientPrincipal,
        name: &str,
        arguments: &Map<String, Value>,
        progress: Option<(ProgressSink, Value)>,
        cancellation: CancellationToken,
    ) -> Value {
        if !self.settings().enabled {
            return typed_tool_failure(DISABLED_TAG, DISABLED_MESSAGE);
        }
        if self.inner.shutdown.is_cancelled() {
            return typed_tool_failure(
                "McpServerStoppingError",
                "This BiBCode server is shutting down; try again once it is back.",
            );
        }
        let spec = match authorize_call(
            PrincipalKind::Client,
            &principal
                .principal
                .scopes
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            name,
        ) {
            Ok(spec) => spec,
            Err(refusal) => return refusal,
        };
        if !spec.read_only && self.effective_ceiling(principal) == McpAccess::ReadOnly {
            return typed_tool_failure(
                "McpAccessCeilingError",
                "This MCP connection is read-only (Settings → Agents → Agent integrations → Agents may).",
            );
        }
        let _admission = match self.admit(&principal.principal.session_id, spec.waits) {
            Ok(admission) => admission,
            Err(refusal) => return refusal,
        };
        let started = std::time::Instant::now();
        let call = ToolCall {
            control: self,
            principal,
            arguments,
            cancellation,
        };
        let outcome = match name {
            "list_projects_and_threads" => call.list_projects_and_threads().await,
            "list_providers_and_models" => call.list_providers_and_models().await,
            "start_thread" => call.start_thread().await,
            "send_message" => call.send_message().await,
            "wait_for_thread" => super::wait::wait_for_thread(&call, progress).await,
            "read_thread" => call.read_thread().await,
            "list_pending_requests" => call.list_pending_requests().await,
            "answer_question" => call.answer_question().await,
            "interrupt_turn" => call.interrupt_turn().await,
            "get_turn_diff" => call.get_turn_diff().await,
            "git_status" => call.git_status().await,
            _ => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
        };
        let result = outcome.unwrap_or_else(|failure| failure);
        // The tool, the thread and the outcome only: never arguments, prompts or replies.
        let thread_id = arguments
            .get("threadId")
            .and_then(Value::as_str)
            .filter(|id| {
                id.len() <= 64
                    && id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            });
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        if result["isError"] == true {
            let error = result["structuredContent"]["error"]["_tag"]
                .as_str()
                .unwrap_or("McpToolError");
            tracing::warn!(
                tool = name,
                thread_id,
                error,
                duration_ms,
                "MCP tool call failed"
            );
        } else {
            tracing::debug!(tool = name, thread_id, duration_ms, "MCP tool call");
        }
        result
    }

    fn admit(&self, session_id: &str, wait: bool) -> Result<Admission, Value> {
        let busy = || {
            typed_tool_failure(
                "McpBusyError",
                "Too many MCP calls are in flight for this connection; retry when one returns.",
            )
        };
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let load = sessions.entry(session_id.to_owned()).or_default();
        if load.calls >= MOST_CALLS_PER_SESSION || (wait && load.waits >= MOST_WAITS_PER_SESSION) {
            return Err(busy());
        }
        if wait {
            if self.inner.waits.fetch_add(1, Ordering::AcqRel) >= MOST_WAITS {
                self.inner.waits.fetch_sub(1, Ordering::AcqRel);
                return Err(busy());
            }
            load.waits += 1;
        }
        load.calls += 1;
        Ok(Admission {
            inner: Arc::clone(&self.inner),
            session_id: session_id.to_owned(),
            wait,
        })
    }

    pub(crate) fn engine(&self) -> &OrchestrationEngine {
        &self.inner.engine
    }

    pub(crate) fn repositories(&self) -> &Repositories {
        &self.inner.repositories
    }

    pub(crate) fn settings_signal(&self) -> watch::Receiver<McpServerSettings> {
        self.inner.settings.clone()
    }

    pub(crate) fn shutdown_token(&self) -> CancellationToken {
        self.inner.shutdown.clone()
    }
}

fn describe(spec: &ToolSpec) -> Value {
    let (description, input) = tool_text(spec.name);
    tool_descriptor(
        spec.name,
        description,
        input,
        json!({
            "readOnlyHint": spec.read_only,
            "destructiveHint": false,
            "idempotentHint": spec.read_only || spec.name == "interrupt_turn",
            "openWorldHint": false,
        }),
    )
}

const CLIENT_REQUEST_ID: &str = "An id you choose so a retry of this exact call does not repeat it. The same id with any other argument is refused as idempotency_conflict. It is remembered for 24 hours per MCP connection; after that it starts a new request.";

fn tool_text(name: &str) -> (&'static str, Value) {
    let thread = json!({ "type": "string", "description": "A thread id, as list_projects_and_threads returns it." });
    let request_id = json!({ "type": "string", "description": CLIENT_REQUEST_ID });
    let mode = json!({
        "type": "string",
        "enum": ["approval-required", "auto-accept-edits", "full-access"],
        "description": "Supervised (approval-required), Auto-accept edits, or Full access. Never above this connection's limit.",
    });
    let object = |properties: Value, required: &[&str]| json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false });
    match name {
        "list_projects_and_threads" => (
            "BiBCode projects, with their folders, and their threads, newest first, with each thread's status (idle, running, queued, awaiting_approval, awaiting_input, delivery_failed, error, interrupted), pending flags, latest turn, provider and model.",
            object(
                json!({
                    "projectId": { "type": "string", "description": "Only this project's threads." },
                    "includeArchived": { "type": "boolean", "description": "Also archived threads. Off unless set." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MOST_LIST_LIMIT, "description": "Threads per page; 50 unless set." },
                    "cursor": { "type": "string", "description": "nextCursor of the previous page." },
                }),
                &[],
            ),
        ),
        "list_providers_and_models" => (
            "Provider instances on this environment with their availability, and for each its default and custom models plus a few more (omittedModels counts the rest; search narrows them).",
            object(
                json!({ "search": { "type": "string", "description": "Only models whose slug or name contains this, ignoring case." } }),
                &[],
            ),
        ),
        "start_thread" => (
            "Starts a new BiBCode thread in a project with a first prompt, and returns its threadId and messageId. Pass the messageId to wait_for_thread. Without providerInstanceId and model it uses the project's default model, else the Default Agent's.",
            object(
                json!({
                    "projectId": { "type": "string" },
                    "prompt": { "type": "string" },
                    "title": { "type": "string" },
                    "providerInstanceId": { "type": "string", "description": "An instance id from list_providers_and_models." },
                    "model": { "type": "string", "description": "A model slug from list_providers_and_models." },
                    "runtimeMode": mode,
                    "interactionMode": { "type": "string", "enum": ["default", "plan"] },
                    "clientRequestId": request_id,
                }),
                &["projectId", "prompt"],
            ),
        ),
        "send_message" => (
            "Sends a message to a thread. It is queued behind a running turn and never interrupts it; mode steer asks the running turn to take it now and falls back to queued, saying why. Returns the messageId to pass to wait_for_thread.",
            object(
                json!({
                    "threadId": thread,
                    "text": { "type": "string" },
                    "mode": { "type": "string", "enum": ["queue", "steer"], "description": "queue unless set." },
                    "clientRequestId": request_id,
                }),
                &["threadId", "text"],
            ),
        ),
        "wait_for_thread" => (
            "Waits until a thread's turn settles, needs a person (awaiting_approval, awaiting_input), fails, or the timeout passes, and returns the turn's state and reply. With messageId it follows the turn that message started; without, the whole thread until idle. A timeout never stops the work: call again to keep waiting.",
            object(
                json!({
                    "threadId": thread,
                    "messageId": { "type": "string", "description": "The messageId start_thread or send_message returned." },
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": super::wait::MOST_TIMEOUT_MS, "description": "30000 unless set; at most 50000." },
                }),
                &["threadId"],
            ),
        ),
        "read_thread" => (
            "A thread's status and a page of its messages, newest last, with queued messages listed apart. Each message's text is cut at 16000 characters with its full length; pass messageId and textOffset to read the rest. cursor pages back through older messages.",
            object(
                json!({
                    "threadId": thread,
                    "limit": { "type": "integer", "minimum": 1, "maximum": MOST_THREAD_PAGE, "description": "Messages per page; 20 unless set." },
                    "cursor": { "type": "string", "description": "nextCursor of the previous page: older messages." },
                    "messageId": { "type": "string", "description": "Read only this message's text, from textOffset." },
                    "textOffset": { "type": "integer", "minimum": 0 },
                }),
                &["threadId"],
            ),
        ),
        "list_pending_requests" => (
            "A thread's open questions (answer them with answer_question) and approvals. Approvals cannot be answered over MCP: ask the person to answer them in BiBCode.",
            object(json!({ "threadId": thread }), &["threadId"]),
        ),
        "answer_question" => (
            "Answers a thread's open question, as list_pending_requests lists it: answers maps each question id to the chosen option label (or a list of labels, or free text). Approvals are refused.",
            object(
                json!({
                    "threadId": thread,
                    "requestId": { "type": "string" },
                    "answers": { "type": "object" },
                    "clientRequestId": request_id,
                }),
                &["threadId", "requestId", "answers"],
            ),
        ),
        "interrupt_turn" => (
            "Stops a thread's running turn. Calling it again, or on an idle thread, is harmless.",
            object(
                json!({ "threadId": thread, "turnId": { "type": "string", "description": "Only this turn." } }),
                &["threadId"],
            ),
        ),
        "get_turn_diff" => (
            "The file changes one turn made, as a patch: the changed files first, then the patch from cursor. nextCursor continues a long patch.",
            object(
                json!({
                    "threadId": thread,
                    "turnCount": { "type": "integer", "minimum": 1, "description": "The turn's number; the latest unless set." },
                    "cursor": { "type": "string", "description": "nextCursor of the previous page." },
                }),
                &["threadId"],
            ),
        ),
        "git_status" => (
            "Branch, ahead/behind counts and changed files of the folder a thread works in.",
            object(json!({ "threadId": thread }), &["threadId"]),
        ),
        _ => ("", json!({ "type": "object" })),
    }
}

/// One call's inputs and the service it runs on.
pub(crate) struct ToolCall<'a> {
    pub(crate) control: &'a McpControl,
    pub(crate) principal: &'a ClientPrincipal,
    pub(crate) arguments: &'a Map<String, Value>,
    pub(crate) cancellation: CancellationToken,
}

/// One `clientRequestId` of one client session, and the call it names.
#[derive(Clone)]
struct RequestKey {
    session_id: String,
    client_request_id: String,
    tool: String,
    digest: String,
}

pub(crate) fn invalid_argument(message: &str) -> Value {
    typed_tool_failure("McpInvalidArgumentError", message)
}

fn rpc_failure(error: &Value) -> Value {
    let tag = error
        .get("_tag")
        .and_then(Value::as_str)
        .unwrap_or("McpToolError");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map_or_else(|| error.to_string(), str::to_owned);
    typed_tool_failure(tag, &message)
}

fn storage_failure(error: impl std::fmt::Display) -> Value {
    tracing::warn!(%error, "an MCP tool could not read the store");
    typed_tool_failure(
        "McpStorageError",
        "BiBCode could not read its store; try again.",
    )
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

impl ToolCall<'_> {
    pub(crate) fn only(&self, known: &[&str]) -> Result<(), Value> {
        match self
            .arguments
            .keys()
            .find(|key| !known.contains(&key.as_str()))
        {
            Some(key) => Err(invalid_argument(&format!(
                "unknown argument {key}; this tool takes {}",
                known.join(", ")
            ))),
            None => Ok(()),
        }
    }

    pub(crate) fn string(&self, key: &str) -> Result<Option<&str>, Value> {
        match self.arguments.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text)),
            Some(_) => Err(invalid_argument(&format!("{key} must be a string"))),
        }
    }

    pub(crate) fn required(&self, key: &str) -> Result<&str, Value> {
        self.string(key)?
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid_argument(&format!("{key} is required")))
    }

    pub(crate) fn integer(&self, key: &str) -> Result<Option<i64>, Value> {
        match self.arguments.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_i64()
                .filter(|value| *value >= 0)
                .map(Some)
                .ok_or_else(|| invalid_argument(&format!("{key} must be a non-negative integer"))),
        }
    }

    fn boolean(&self, key: &str) -> Result<Option<bool>, Value> {
        match self.arguments.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(value)) => Ok(Some(*value)),
            Some(_) => Err(invalid_argument(&format!("{key} must be true or false"))),
        }
    }

    fn context(&self) -> RpcSessionContext {
        RpcSessionContext::authenticated(
            self.principal.principal.clone(),
            self.control.inner.auth.clone(),
        )
    }

    /// Runs RPC method `tag` with this call's credential: B1, the same handler and checks the
    /// UI's request gets.
    async fn invoke(&self, tag: &str, payload: Value) -> Result<Value, Value> {
        self.control
            .inner
            .registry
            .invoke_local(tag, payload, self.context(), self.cancellation.clone())
            .await
            .map_err(|error| rpc_failure(&error))
    }

    /// The thread row, or a typed failure naming the missing thread.
    pub(crate) async fn thread(
        &self,
        thread_id: &str,
    ) -> Result<crate::persistence::ProjectionThread, Value> {
        self.control
            .repositories()
            .get_thread(thread_id.to_owned())
            .await
            .map_err(storage_failure)?
            .filter(|thread| thread.deleted_at.is_none())
            .ok_or_else(|| {
                typed_tool_failure(
                    "McpThreadNotFoundError",
                    &format!("No thread {thread_id}; list_projects_and_threads lists them."),
                )
            })
    }

    /// Refuses work that would advance a thread running above this connection's limit.
    fn check_thread_mode(&self, runtime_mode: &str) -> Result<(), Value> {
        let ceiling = self.control.effective_ceiling(self.principal);
        if McpAccess::of_runtime_mode(runtime_mode) > ceiling {
            return Err(typed_tool_failure(
                "McpAccessCeilingError",
                &format!(
                    "This thread runs in {runtime_mode}, above this MCP connection's limit ({}). Raise Settings → Agents → Agent integrations → Agents may, then restart the MCP server in your agent.",
                    ceiling.as_str()
                ),
            ));
        }
        Ok(())
    }

    /// The commands to dispatch. A `clientRequestId` already stored is resolved first, before
    /// anything `fresh` would check, so a retry whose first answer was lost replays the stored
    /// commands even after the thread, the question or the setting changed; only the ones the
    /// engine has not accepted yet still meet the current ceiling. Otherwise `fresh` runs the
    /// current checks and builds new commands, stored when there is an id. `thread_id` names
    /// the existing thread the commands advance. See the design's Retries section.
    async fn commands(
        &self,
        tool: &str,
        thread_id: Option<&str>,
        fresh: impl AsyncFnOnce() -> Result<Vec<Value>, Value>,
    ) -> Result<Vec<Value>, Value> {
        let Some(key) = self.request_key(tool)? else {
            return fresh().await;
        };
        if let Some(stored) = self.stored_request(&key, None).await? {
            self.check_unaccepted(&stored, thread_id).await?;
            return Ok(stored);
        }
        let fresh = fresh().await?;
        // Another call with the same id may have stored its commands meanwhile; then those
        // are the ones dispatched.
        self.stored_request(&key, Some(&fresh))
            .await?
            .ok_or_else(|| storage_failure("a stored MCP request is missing"))
    }

    fn request_key(&self, tool: &str) -> Result<Option<RequestKey>, Value> {
        let Some(client_request_id) = self.string("clientRequestId")? else {
            return Ok(None);
        };
        if client_request_id.is_empty() || client_request_id.len() > 256 {
            return Err(invalid_argument(
                "clientRequestId must be 1 to 256 characters",
            ));
        }
        let digest = crate::orchestration::delivery::canonical_command_digest(&Value::Object(
            self.arguments.clone(),
        ))
        .map_err(|error| invalid_argument(&error))?;
        Ok(Some(RequestKey {
            session_id: self.principal.principal.session_id.clone(),
            client_request_id: client_request_id.to_owned(),
            tool: tool.to_owned(),
            digest,
        }))
    }

    /// The commands stored for `key`, after storing `fresh` when nothing is stored yet.
    async fn stored_request(
        &self,
        key: &RequestKey,
        fresh: Option<&[Value]>,
    ) -> Result<Option<Vec<Value>>, Value> {
        let fresh_json = fresh
            .map(serde_json::to_string)
            .transpose()
            .map_err(storage_failure)?;
        let RequestKey {
            session_id,
            client_request_id,
            ..
        } = key.clone();
        let tool = key.tool.clone();
        let digest = key.digest.clone();
        let stored = self
            .control
            .repositories()
            .database()
            .call(move |connection| {
                let transaction = connection.transaction()?;
                if let Some(fresh_json) = fresh_json {
                    let now = time::OffsetDateTime::now_utc();
                    let cutoff = (now - time::Duration::seconds(REQUEST_ROW_TTL_SECONDS))
                        .format(&time::format_description::well_known::Rfc3339)
                        .unwrap_or_default();
                    let created = now
                        .format(&time::format_description::well_known::Rfc3339)
                        .unwrap_or_default();
                    transaction.execute(
                        "DELETE FROM mcp_tool_requests WHERE created_at < ?",
                        [&cutoff],
                    )?;
                    transaction.execute(
                        "INSERT OR IGNORE INTO mcp_tool_requests (session_id, client_request_id, tool, arguments_digest, commands_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        params![session_id, client_request_id, tool, digest, fresh_json, created],
                    )?;
                }
                let row = transaction
                    .query_row(
                        "SELECT tool, arguments_digest, commands_json FROM mcp_tool_requests WHERE session_id = ? AND client_request_id = ?",
                        params![session_id, client_request_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
                    )
                    .optional()?;
                transaction.commit()?;
                Ok(row)
            })
            .await
            .map_err(storage_failure)?;
        let Some((stored_tool, stored_digest, commands)) = stored else {
            return Ok(None);
        };
        if stored_tool != key.tool || stored_digest != key.digest {
            return Err(typed_tool_failure(
                "idempotency_conflict",
                "This clientRequestId was already used for a different call; use a new id.",
            ));
        }
        serde_json::from_str(&commands)
            .map(Some)
            .map_err(storage_failure)
    }

    /// Refuses stored commands the engine has not accepted yet when they would run above the
    /// current ceiling: replaying accepted work changes nothing, but the rest is new work. An
    /// accepted or rejected command is left to the engine's replay, which answers as it did.
    async fn check_unaccepted(
        &self,
        commands: &[Value],
        thread_id: Option<&str>,
    ) -> Result<(), Value> {
        let mut thread_checked = false;
        for command in commands {
            let receipt = self
                .control
                .repositories()
                .get_command_receipt(command["commandId"].as_str().unwrap_or_default().to_owned())
                .await
                .map_err(storage_failure)?;
            if receipt
                .is_some_and(|receipt| !matches!(receipt.status.as_str(), "reserved" | "prepared"))
            {
                continue;
            }
            if let Some(mode) = command["runtimeMode"].as_str() {
                self.check_thread_mode(mode)?;
            }
            if let Some(thread_id) = thread_id
                && !thread_checked
            {
                self.check_thread_mode(&self.thread(thread_id).await?.runtime_mode)?;
                thread_checked = true;
            }
        }
        Ok(())
    }

    async fn dispatch(&self, command: Value) -> Result<Value, Value> {
        self.invoke("orchestration.dispatchCommand", command).await
    }

    async fn list_projects_and_threads(&self) -> ToolResult {
        self.only(&["projectId", "includeArchived", "limit", "cursor"])?;
        let project_id = self.string("projectId")?;
        let include_archived = self.boolean("includeArchived")?.unwrap_or(false);
        let limit = self.integer("limit")?.map_or(DEFAULT_LIST_LIMIT, |limit| {
            usize::try_from(limit)
                .unwrap_or(MOST_LIST_LIMIT)
                .clamp(1, MOST_LIST_LIMIT)
        });
        let offset = match self.string("cursor")? {
            None => 0,
            Some(cursor) => cursor
                .strip_prefix("t:")
                .and_then(|offset| offset.parse::<usize>().ok())
                .ok_or_else(|| invalid_argument("cursor is not one this tool returned"))?,
        };
        let engine = self.control.engine();
        let mut shell = crate::production::orchestration_rpc::shell_snapshot(engine, false)
            .await
            .map_err(|error| rpc_failure(&error))?;
        let mut threads = shell["threads"]
            .as_array_mut()
            .map(std::mem::take)
            .unwrap_or_default();
        if include_archived {
            let archived = crate::production::orchestration_rpc::shell_snapshot(engine, true)
                .await
                .map_err(|error| rpc_failure(&error))?;
            threads.extend(archived["threads"].as_array().cloned().unwrap_or_default());
        }
        let projects: Vec<Value> = shell["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|project| project_id.is_none_or(|id| project["id"] == id))
            .map(|project| {
                json!({
                    "projectId": project["id"],
                    "title": project["title"],
                    // `bibcode thread start .` finds the project that holds the current folder.
                    "workspaceRoot": project["workspaceRoot"],
                    "defaultModelSelection": project.get("defaultModelSelection"),
                })
            })
            .collect();
        let mut threads: Vec<Value> = threads
            .iter()
            .filter(|thread| project_id.is_none_or(|id| thread["projectId"] == id))
            .map(thread_summary)
            .collect();
        threads.sort_by(|left, right| {
            right["updatedAt"]
                .as_str()
                .cmp(&left["updatedAt"].as_str())
                .then_with(|| left["threadId"].as_str().cmp(&right["threadId"].as_str()))
        });
        let total = threads.len();
        let page: Vec<Value> = threads.into_iter().skip(offset).take(limit).collect();
        let mut next = offset + page.len();
        let mut content = json!({
            "projects": projects,
            "threads": page,
            "threadCount": total,
            "nextCursor": null,
        });
        // The cursor continues after the last thread this page returns.
        next -= fit_list(&mut content, "/threads", Cut::Back, 1);
        content["nextCursor"] = (next < total).then(|| format!("t:{next}")).into();
        Ok(tool_result(content, &[("/projects", Cut::Back)]))
    }

    async fn list_providers_and_models(&self) -> ToolResult {
        self.only(&["search"])?;
        let search = self.string("search")?.map(str::to_lowercase);
        let config = self.invoke("server.getConfig", json!({})).await?;
        let defaults = &config["settings"]["providerSessionDefaults"];
        let default_agent = &config["settings"]["defaultAgent"]["instanceId"];
        let providers: Vec<Value> = config["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|provider| {
                let default_model = defaults[provider["driver"].as_str().unwrap_or_default()]
                    ["model"]
                    .as_str()
                    .map(str::to_owned);
                let models = provider["models"].as_array().cloned().unwrap_or_default();
                let matches = |model: &Value| {
                    search.as_deref().is_none_or(|search| {
                        ["slug", "name"].iter().any(|key| {
                            model[*key]
                                .as_str()
                                .is_some_and(|text| text.to_lowercase().contains(search))
                        })
                    })
                };
                let mut listed = Vec::new();
                let mut extra = 0;
                let mut omitted = 0;
                for model in models.iter().filter(|model| matches(model)) {
                    let is_default = default_model.as_deref() == model["slug"].as_str();
                    let custom = model["isCustom"] == true;
                    if is_default || custom || extra < EXTRA_MODELS {
                        if !is_default && !custom {
                            extra += 1;
                        }
                        listed.push(json!({
                            "model": model["slug"],
                            "name": model["name"],
                            "default": is_default,
                            "custom": custom,
                        }));
                    } else {
                        omitted += 1;
                    }
                }
                json!({
                    "providerInstanceId": provider["instanceId"],
                    "driver": provider["driver"],
                    "displayName": provider.get("displayName"),
                    "available": provider["enabled"] == true
                        && provider["installed"] == true
                        && provider.get("availability").and_then(Value::as_str) != Some("unavailable"),
                    "status": provider["status"],
                    "defaultAgent": &provider["instanceId"] == default_agent,
                    "supportsTurnSteer": provider.get("supportsTurnSteer").and_then(Value::as_bool).unwrap_or(false),
                    "models": listed,
                    "omittedModels": omitted,
                })
            })
            .collect();
        Ok(tool_result(
            json!({ "providers": providers }),
            &[("/providers", Cut::Back)],
        ))
    }

    /// The model selection a new thread uses when the caller named none: the project's
    /// default, else the Default Agent's instance with its session-default model.
    async fn default_model_selection(
        &self,
        project: &crate::persistence::ProjectionProject,
        instance: Option<&str>,
        model: Option<&str>,
    ) -> Result<Value, Value> {
        if let (Some(instance), Some(model)) = (instance, model) {
            return Ok(json!({ "instanceId": instance, "model": model }));
        }
        if instance.is_none()
            && model.is_none()
            && let Some(selection) = project
                .default_model_selection
                .as_ref()
                .filter(|selection| selection.is_object())
        {
            return Ok(selection.clone());
        }
        let config = self.invoke("server.getConfig", json!({})).await?;
        let instance = instance
            .map(str::to_owned)
            .or_else(|| {
                config["settings"]["defaultAgent"]["instanceId"]
                    .as_str()
                    .map(str::to_owned)
            })
            .ok_or_else(|| {
                invalid_argument(
                    "providerInstanceId is required: this environment has no Default Agent",
                )
            })?;
        let provider = config["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|provider| provider["instanceId"] == instance.as_str())
            .ok_or_else(|| {
                invalid_argument(&format!(
                    "No provider instance {instance}; list_providers_and_models lists them."
                ))
            })?;
        let model = model
            .map(str::to_owned)
            .or_else(|| {
                config["settings"]["providerSessionDefaults"]
                    [provider["driver"].as_str().unwrap_or_default()]["model"]
                    .as_str()
                    .map(str::to_owned)
            })
            .or_else(|| provider["models"][0]["slug"].as_str().map(str::to_owned))
            .ok_or_else(|| invalid_argument("model is required: this provider lists no models"))?;
        Ok(json!({ "instanceId": instance, "model": model }))
    }

    async fn start_thread(&self) -> ToolResult {
        self.only(&[
            "projectId",
            "prompt",
            "title",
            "providerInstanceId",
            "model",
            "runtimeMode",
            "interactionMode",
            "clientRequestId",
        ])?;
        let project_id = self.required("projectId")?;
        let prompt = self.required("prompt")?;
        if prompt.chars().count() > 120_000 {
            return Err(invalid_argument("prompt is longer than 120000 characters"));
        }
        let asked_mode = match self.string("runtimeMode")? {
            None => None,
            Some(mode) => Some(
                McpAccess::parse(mode)
                    .filter(|level| *level != McpAccess::ReadOnly)
                    .ok_or_else(|| {
                        invalid_argument(
                            "runtimeMode is approval-required, auto-accept-edits or full-access",
                        )
                    })?,
            ),
        };
        let interaction_mode = match self.string("interactionMode")? {
            None | Some("default") => "default",
            Some("plan") => "plan",
            Some(_) => return Err(invalid_argument("interactionMode is default or plan")),
        };
        // A retry with a known clientRequestId dispatches the stored commands instead, so a
        // default that changed since then does not change what it replays.
        let fresh = async || {
            let ceiling = self.control.effective_ceiling(self.principal);
            let runtime_mode = asked_mode.unwrap_or(ceiling);
            if runtime_mode > ceiling {
                return Err(typed_tool_failure(
                    "McpAccessCeilingError",
                    &format!(
                        "runtimeMode {} is above this MCP connection's limit ({}). Raise Settings → Agents → Agent integrations → Agents may, then restart the MCP server in your agent.",
                        runtime_mode.as_str(),
                        ceiling.as_str()
                    ),
                ));
            }
            let project = self
                .control
                .repositories()
                .get_project(project_id.to_owned())
                .await
                .map_err(storage_failure)?
                .filter(|project| project.deleted_at.is_none())
                .ok_or_else(|| {
                    typed_tool_failure(
                        "McpProjectNotFoundError",
                        &format!("No project {project_id}; list_projects_and_threads lists them."),
                    )
                })?;
            let selection = self
                .default_model_selection(
                    &project,
                    self.string("providerInstanceId")?,
                    self.string("model")?,
                )
                .await?;
            let title = self
                .string("title")?
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map_or_else(|| title_from(prompt), str::to_owned);
            let created_at = now_iso();
            let thread_id = Uuid::new_v4().to_string();
            Ok(vec![json!({
                "type": "thread.turn.start",
                "commandId": Uuid::new_v4().to_string(),
                "threadId": thread_id,
                "message": {
                    "messageId": Uuid::new_v4().to_string(),
                    "role": "user",
                    "text": prompt,
                    "attachments": [],
                },
                "modelSelection": selection,
                "titleSeed": title,
                "runtimeMode": runtime_mode.as_str(),
                "interactionMode": interaction_mode,
                "bootstrap": {
                    "createThread": {
                        "projectId": project_id,
                        "title": title,
                        "modelSelection": selection,
                        "runtimeMode": runtime_mode.as_str(),
                        "interactionMode": interaction_mode,
                        "branch": null,
                        "worktreePath": null,
                        "createdAt": created_at,
                    },
                },
                "createdAt": created_at,
            })])
        };
        let commands = self.commands("start_thread", None, fresh).await?;
        let command = commands
            .into_iter()
            .next()
            .ok_or_else(|| storage_failure("a stored start_thread request has no command"))?;
        self.dispatch(command.clone()).await?;
        Ok(tool_result(
            json!({
                "threadId": command["threadId"],
                "messageId": command["message"]["messageId"],
                "runtimeMode": command["runtimeMode"],
                "modelSelection": command["modelSelection"],
            }),
            &[],
        ))
    }

    async fn send_message(&self) -> ToolResult {
        self.only(&["threadId", "text", "mode", "clientRequestId"])?;
        let thread_id = self.required("threadId")?;
        let text = self.required("text")?;
        if text.chars().count() > 120_000 {
            return Err(invalid_argument("text is longer than 120000 characters"));
        }
        let steer = match self.string("mode")? {
            None | Some("queue") => false,
            Some("steer") => true,
            Some(_) => return Err(invalid_argument("mode is queue or steer")),
        };
        let fresh = async || {
            let thread = self.thread(thread_id).await?;
            self.check_thread_mode(&thread.runtime_mode)?;
            let created_at = now_iso();
            let message_id = Uuid::new_v4().to_string();
            let mut fresh = vec![json!({
                "type": "thread.turn.start",
                "commandId": Uuid::new_v4().to_string(),
                "threadId": thread_id,
                "message": { "messageId": message_id, "role": "user", "text": text, "attachments": [] },
                "runtimeMode": thread.runtime_mode,
                "interactionMode": thread.interaction_mode,
                "queued": true,
                "createdAt": created_at,
            })];
            if steer {
                fresh.push(json!({
                    "type": "thread.turn.steer",
                    "commandId": Uuid::new_v4().to_string(),
                    "threadId": thread_id,
                    "messageId": message_id,
                    "createdAt": created_at,
                }));
            }
            Ok(fresh)
        };
        let commands = self
            .commands("send_message", Some(thread_id), fresh)
            .await?;
        let mut commands = commands.into_iter();
        let start = commands
            .next()
            .ok_or_else(|| storage_failure("a stored send_message request has no command"))?;
        self.dispatch(start.clone()).await?;
        let mut steered = None;
        if let Some(steer) = commands.next() {
            steered = Some(match self.dispatch(steer).await {
                Ok(_) => json!({ "steered": true }),
                Err(failure) => json!({
                    "steered": false,
                    "reason": failure["structuredContent"]["error"]["message"],
                }),
            });
        }
        let message_id = start["message"]["messageId"].clone();
        let queued = self
            .control
            .repositories()
            .database()
            .call({
                let message_id = message_id.as_str().unwrap_or_default().to_owned();
                move |connection| {
                    Ok(connection
                        .query_row(
                            "SELECT state FROM provider_turn_outbox WHERE message_id = ?",
                            [message_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?
                        .is_some_and(|state| state == "queued"))
                }
            })
            .await
            .map_err(storage_failure)?;
        let mut result =
            json!({ "threadId": thread_id, "messageId": message_id, "queued": queued });
        if let Some(steered) = steered {
            result["steer"] = steered;
        }
        Ok(tool_result(result, &[]))
    }

    async fn read_thread(&self) -> ToolResult {
        self.only(&["threadId", "limit", "cursor", "messageId", "textOffset"])?;
        let thread_id = self.required("threadId")?.to_owned();
        let thread = self.thread(&thread_id).await?;
        if let Some(message_id) = self.string("messageId")? {
            let offset = self.integer("textOffset")?.unwrap_or(0);
            let message_id = message_id.to_owned();
            let slice = self
                .control
                .repositories()
                .database()
                .call(move |connection| {
                    connection
                        .query_row(
                            "SELECT role, substr(text, ? + 1, ?), length(text) FROM projection_thread_messages WHERE thread_id = ? AND message_id = ?",
                            params![offset, MESSAGE_TEXT_CHARS, thread_id, message_id],
                            |row| Ok(json!({
                                "messageId": message_id,
                                "role": row.get::<_, String>(0)?,
                                "textOffset": offset,
                                "text": row.get::<_, String>(1)?,
                                "textLength": row.get::<_, i64>(2)?,
                            })),
                        )
                        .optional()
                        .map_err(Into::into)
                })
                .await
                .map_err(storage_failure)?
                .ok_or_else(|| invalid_argument("No such message in this thread"))?;
            return Ok(tool_result(json!({ "message": slice }), &[]));
        }
        let limit = self
            .integer("limit")?
            .unwrap_or(DEFAULT_THREAD_PAGE)
            .clamp(1, MOST_THREAD_PAGE);
        let before = match self.string("cursor")? {
            None => None,
            Some(cursor) => Some(
                cursor
                    .split_once('\u{1f}')
                    .map(|(at, id)| (at.to_owned(), id.to_owned()))
                    .ok_or_else(|| invalid_argument("cursor is not one this tool returned"))?,
            ),
        };
        let page = read_message_page(self.control.repositories(), &thread_id, before, limit)
            .await
            .map_err(storage_failure)?;
        let status = derive_status(
            thread.pending_approval_count > 0,
            thread.pending_user_input_count > 0,
            thread.unresolved_delivery_state.is_some(),
            page.session["status"].as_str(),
            page.latest_turn_state.as_deref(),
        );
        let mut content = json!({
            "threadId": thread.thread_id,
            "title": thread.title,
            "status": status,
            "runtimeMode": thread.runtime_mode,
            "hasPendingApprovals": thread.pending_approval_count > 0,
            "hasPendingUserInput": thread.pending_user_input_count > 0,
            "session": page.session,
            "messages": page.messages,
            "queuedMessages": page.queued,
            "queuedCount": page.queued_count,
            "nextCursor": page.next_cursor,
        });
        // Queued messages, which `queuedCount` still counts, give way first. Then the oldest
        // messages do, and the cursor moves to the oldest one returned, so following it reads
        // the ones dropped here.
        fit_list(&mut content, "/queuedMessages", Cut::Back, 0);
        if fit_list(&mut content, "/messages", Cut::Front, 1) > 0 {
            content["nextCursor"] = message_cursor(&content["messages"][0]).into();
        }
        Ok(tool_result(content, &[]))
    }

    async fn list_pending_requests(&self) -> ToolResult {
        self.only(&["threadId"])?;
        let thread_id = self.required("threadId")?.to_owned();
        self.thread(&thread_id).await?;
        let pending = read_pending_requests(self.control.repositories(), &thread_id)
            .await
            .map_err(storage_failure)?;
        Ok(tool_result(
            json!({ "threadId": thread_id, "questions": pending.questions, "approvals": pending.approvals }),
            &[("/questions", Cut::Back), ("/approvals", Cut::Back)],
        ))
    }

    async fn answer_question(&self) -> ToolResult {
        self.only(&["threadId", "requestId", "answers", "clientRequestId"])?;
        let thread_id = self.required("threadId")?.to_owned();
        let request_id = self.required("requestId")?.to_owned();
        let answers = match self.arguments.get("answers") {
            Some(Value::Object(answers)) => Value::Object(answers.clone()),
            _ => return Err(invalid_argument("answers must be an object")),
        };
        let fresh = async || {
            let thread = self.thread(&thread_id).await?;
            let pending = read_pending_requests(self.control.repositories(), &thread_id)
                .await
                .map_err(storage_failure)?;
            if pending
                .approvals
                .iter()
                .any(|approval| approval["requestId"] == request_id.as_str())
            {
                return Err(typed_tool_failure(
                    "McpApprovalNotAnswerableError",
                    "This is an approval. Approvals are answered by a person in BiBCode, never over MCP.",
                ));
            }
            if !pending
                .questions
                .iter()
                .any(|question| question["requestId"] == request_id.as_str())
            {
                return Err(invalid_argument(
                    "No open question with this requestId; list_pending_requests lists them.",
                ));
            }
            self.check_thread_mode(&thread.runtime_mode)?;
            Ok(vec![json!({
                "type": "thread.user-input.respond",
                "commandId": Uuid::new_v4().to_string(),
                "threadId": thread_id,
                "requestId": request_id,
                "answers": answers,
                "createdAt": now_iso(),
            })])
        };
        for command in self
            .commands("answer_question", Some(&thread_id), fresh)
            .await?
        {
            self.dispatch(command).await?;
        }
        Ok(tool_result(
            json!({ "threadId": thread_id, "requestId": request_id, "answered": true }),
            &[],
        ))
    }

    async fn interrupt_turn(&self) -> ToolResult {
        self.only(&["threadId", "turnId"])?;
        let thread_id = self.required("threadId")?.to_owned();
        self.thread(&thread_id).await?;
        let mut command = json!({
            "type": "thread.turn.interrupt",
            "commandId": Uuid::new_v4().to_string(),
            "threadId": thread_id,
            "createdAt": now_iso(),
        });
        if let Some(turn_id) = self.string("turnId")? {
            command["turnId"] = json!(turn_id);
        }
        self.dispatch(command).await?;
        Ok(tool_result(
            json!({ "threadId": thread_id, "interruptRequested": true }),
            &[],
        ))
    }

    async fn get_turn_diff(&self) -> ToolResult {
        self.only(&["threadId", "turnCount", "cursor"])?;
        let thread_id = self.required("threadId")?.to_owned();
        self.thread(&thread_id).await?;
        let turn_count = match self.integer("turnCount")? {
            Some(count) if count >= 1 => count,
            Some(_) => return Err(invalid_argument("turnCount starts at 1")),
            None => {
                let id = thread_id.clone();
                self.control
                    .repositories()
                    .database()
                    .call(move |connection| {
                        connection
                            .query_row(
                                "SELECT MAX(checkpoint_turn_count) FROM projection_turns WHERE thread_id = ?",
                                [id],
                                |row| row.get::<_, Option<i64>>(0),
                            )
                            .map_err(Into::into)
                    })
                    .await
                    .map_err(storage_failure)?
                    .ok_or_else(|| {
                        typed_tool_failure(
                            "McpNoTurnDiffError",
                            "This thread has no turn with recorded changes yet.",
                        )
                    })?
            }
        };
        let (file_index, offset) = match self.string("cursor")? {
            None => (0, 0),
            Some(cursor) => cursor
                .split_once(':')
                .and_then(|(file, offset)| Some((file.parse().ok()?, offset.parse().ok()?)))
                .ok_or_else(|| invalid_argument("cursor is not one this tool returned"))?,
        };
        let diff = self
            .invoke(
                "orchestration.getTurnDiff",
                json!({ "threadId": thread_id, "fromTurnCount": turn_count - 1, "toTurnCount": turn_count }),
            )
            .await?;
        let patch = diff["diff"].as_str().unwrap_or_default();
        let page = diff_page(patch, file_index, offset, DIFF_PAGE_CHARS);
        Ok(tool_result(
            json!({
                "threadId": thread_id,
                "turnCount": turn_count,
                "files": page.files,
                "patch": page.patch,
                "nextCursor": page.next_cursor,
                "serverTruncated": diff.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            }),
            &[("/files", Cut::Back)],
        ))
    }

    async fn git_status(&self) -> ToolResult {
        self.only(&["threadId"])?;
        let thread_id = self.required("threadId")?.to_owned();
        let thread = self.thread(&thread_id).await?;
        let cwd = match thread.worktree_path.filter(|path| !path.is_empty()) {
            Some(path) => path,
            None => {
                self.control
                    .repositories()
                    .get_project(thread.project_id.clone())
                    .await
                    .map_err(storage_failure)?
                    .ok_or_else(|| {
                        typed_tool_failure(
                            "McpProjectNotFoundError",
                            "This thread's project is gone.",
                        )
                    })?
                    .workspace_root
            }
        };
        let status = self
            .invoke("vcs.refreshStatus", json!({ "cwd": cwd }))
            .await?;
        Ok(tool_result(
            json!({
                "threadId": thread_id,
                "isRepo": status.get("isRepo"),
                "branch": status.get("refName"),
                "defaultBranch": status.get("defaultRefName"),
                "hasUpstream": status.get("hasUpstream"),
                "ahead": status.get("aheadCount"),
                "behind": status.get("behindCount"),
                "hasWorkingTreeChanges": status.get("hasWorkingTreeChanges"),
                "files": status.pointer("/workingTree/files").cloned().unwrap_or_else(|| json!([])),
            }),
            &[("/files", Cut::Back)],
        ))
    }
}

fn title_from(prompt: &str) -> String {
    let line = prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("MCP thread");
    let title: String = line.trim().chars().take(80).collect();
    if title.is_empty() {
        "MCP thread".to_owned()
    } else {
        title
    }
}

/// A thread's status for an agent, from its shell or wait state.
#[must_use]
pub(crate) fn derive_status(
    pending_approvals: bool,
    pending_input: bool,
    unresolved_delivery: bool,
    session_status: Option<&str>,
    turn_state: Option<&str>,
) -> &'static str {
    if pending_approvals {
        "awaiting_approval"
    } else if pending_input {
        "awaiting_input"
    } else if unresolved_delivery {
        "delivery_failed"
    } else if matches!(session_status, Some("running" | "starting"))
        || turn_state == Some("running")
    {
        "running"
    } else if session_status == Some("error") || turn_state == Some("error") {
        "error"
    } else if turn_state == Some("interrupted") {
        "interrupted"
    } else {
        "idle"
    }
}

fn thread_summary(thread: &Value) -> Value {
    let session_status = thread["session"]["status"].as_str();
    let turn_state = thread["latestTurn"]["state"].as_str();
    json!({
        "threadId": thread["id"],
        "projectId": thread["projectId"],
        "title": thread["title"],
        "status": derive_status(
            thread["hasPendingApprovals"] == true,
            thread["hasPendingUserInput"] == true,
            !thread["unresolvedDelivery"].is_null(),
            session_status,
            turn_state,
        ),
        "hasPendingApprovals": thread["hasPendingApprovals"],
        "hasPendingUserInput": thread["hasPendingUserInput"],
        "latestTurn": thread["latestTurn"].as_object().map(|turn| json!({
            "turnId": turn.get("turnId"),
            "state": turn.get("state"),
            "completedAt": turn.get("completedAt"),
        })),
        "providerInstanceId": thread["modelSelection"]["instanceId"],
        "model": thread["modelSelection"]["model"],
        "runtimeMode": thread["runtimeMode"],
        "interactionMode": thread["interactionMode"],
        "branch": thread["branch"],
        "hostThreadId": thread.get("hostThreadId"),
        "archived": !thread["archivedAt"].is_null(),
        "updatedAt": thread["updatedAt"],
    })
}

pub(crate) struct MessagePage {
    pub(crate) session: Value,
    pub(crate) messages: Vec<Value>,
    pub(crate) queued: Vec<Value>,
    pub(crate) queued_count: i64,
    pub(crate) next_cursor: Option<String>,
    /// The state of the thread's latest turn, for its status.
    pub(crate) latest_turn_state: Option<String>,
    /// How many message rows the page query stepped over: its `LIMIT` bounds it.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) rows_read: usize,
}

/// The cursor that reads the messages older than `message`.
fn message_cursor(message: &Value) -> String {
    format!(
        "{}\u{1f}{}",
        message["createdAt"].as_str().unwrap_or_default(),
        message["messageId"].as_str().unwrap_or_default()
    )
}

/// One keyset page of a thread's delivered messages, newest `limit` before `before`, in one
/// SQLite job, plus the session and at most 20 queued messages. Each text is cut at
/// [`MESSAGE_TEXT_CHARS`] in SQL.
pub(crate) async fn read_message_page(
    repositories: &Repositories,
    thread_id: &str,
    before: Option<(String, String)>,
    limit: i64,
) -> crate::persistence::Result<MessagePage> {
    let thread_id = thread_id.to_owned();
    repositories
        .database()
        .call(move |connection| {
            let session = connection
                .query_row(
                    "SELECT status, provider_instance_id, runtime_mode, active_turn_id, last_error FROM projection_thread_sessions WHERE thread_id = ?",
                    [&thread_id],
                    |row| Ok(json!({
                        "status": row.get::<_, String>(0)?,
                        "providerInstanceId": row.get::<_, Option<String>>(1)?,
                        "runtimeMode": row.get::<_, String>(2)?,
                        "activeTurnId": row.get::<_, Option<String>>(3)?,
                        "lastError": row.get::<_, Option<String>>(4)?,
                    })),
                )
                .optional()?
                .unwrap_or(Value::Null);
            let (at, id) = before.unwrap_or_else(|| ("\u{10ffff}".to_owned(), String::new()));
            let mut statement = connection.prepare_cached(
                "SELECT message_id, role, turn_id, substr(text, 1, ?), length(text), is_streaming, created_at FROM projection_thread_messages
                 WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND message_id < ?))
                   AND COALESCE(delivery_state, '') <> 'queued'
                 ORDER BY created_at DESC, message_id DESC LIMIT ?",
            )?;
            let mut rows_read = 0;
            let mut messages = statement
                .query_map(params![MESSAGE_TEXT_CHARS, thread_id, at, at, id, limit + 1], |row| {
                    Ok(json!({
                        "messageId": row.get::<_, String>(0)?,
                        "role": row.get::<_, String>(1)?,
                        "turnId": row.get::<_, Option<String>>(2)?,
                        "text": row.get::<_, String>(3)?,
                        "textLength": row.get::<_, i64>(4)?,
                        "streaming": row.get::<_, bool>(5)?,
                        "createdAt": row.get::<_, String>(6)?,
                    }))
                })?
                .inspect(|_| rows_read += 1)
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let more = messages.len() as i64 > limit;
            messages.truncate(usize::try_from(limit).unwrap_or(0));
            messages.reverse();
            let next_cursor = more.then(|| message_cursor(&messages[0]));
            let mut queued_statement = connection.prepare_cached(
                "SELECT message_id, substr(text, 1, ?), length(text), created_at FROM projection_thread_messages
                 WHERE thread_id = ? AND delivery_state = 'queued' ORDER BY created_at ASC, message_id ASC LIMIT ?",
            )?;
            let queued = queued_statement
                .query_map(params![MESSAGE_TEXT_CHARS, thread_id, MOST_QUEUED], |row| {
                    Ok(json!({
                        "messageId": row.get::<_, String>(0)?,
                        "text": row.get::<_, String>(1)?,
                        "textLength": row.get::<_, i64>(2)?,
                        "createdAt": row.get::<_, String>(3)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let queued_count = connection.query_row(
                "SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ? AND delivery_state = 'queued'",
                [&thread_id],
                |row| row.get(0),
            )?;
            let latest_turn_state = connection
                .query_row(
                    "SELECT turn.state FROM projection_threads AS thread
                       JOIN projection_turns AS turn ON turn.thread_id = thread.thread_id AND turn.turn_id = thread.latest_turn_id
                      WHERE thread.thread_id = ?",
                    [&thread_id],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(MessagePage {
                session,
                messages,
                queued,
                queued_count,
                next_cursor,
                latest_turn_state,
                rows_read,
            })
        })
        .await
}

pub(crate) struct PendingRequests {
    pub(crate) questions: Vec<Value>,
    pub(crate) approvals: Vec<Value>,
}

/// A thread's open questions, with their options, and its pending approvals (kind and summary
/// only), read directly from the projection rather than the thread snapshot.
pub(crate) async fn read_pending_requests(
    repositories: &Repositories,
    thread_id: &str,
) -> crate::persistence::Result<PendingRequests> {
    let thread_id = thread_id.to_owned();
    repositories
        .database()
        .call(move |connection| {
            let open = crate::persistence::open_user_input_requests_sql("?1");
            let mut statement = connection.prepare(&format!(
                "SELECT json_extract(payload_json, '$.requestId'), summary, json_extract(payload_json, '$.questions'), created_at
                 FROM projection_thread_activities
                 WHERE thread_id = ?1 AND kind = 'user-input.requested'
                   AND json_extract(payload_json, '$.requestId') IN ({open})
                 ORDER BY created_at ASC LIMIT 50"
            ))?;
            let questions = statement
                .query_map([&thread_id], |row| {
                    let questions = row
                        .get::<_, Option<String>>(2)?
                        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                        .unwrap_or_else(|| json!([]));
                    Ok(json!({
                        "requestId": row.get::<_, String>(0)?,
                        "summary": row.get::<_, Option<String>>(1)?,
                        "questions": questions,
                        "createdAt": row.get::<_, String>(3)?,
                        "answerWith": "answer_question",
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut statement = connection.prepare(
                "SELECT approval.request_id, approval.created_at,
                   (SELECT activity.summary FROM projection_thread_activities AS activity
                     WHERE activity.thread_id = approval.thread_id AND activity.kind = 'approval.requested'
                       AND json_extract(activity.payload_json, '$.requestId') = approval.request_id LIMIT 1),
                   (SELECT json_extract(activity.payload_json, '$.requestKind') FROM projection_thread_activities AS activity
                     WHERE activity.thread_id = approval.thread_id AND activity.kind = 'approval.requested'
                       AND json_extract(activity.payload_json, '$.requestId') = approval.request_id LIMIT 1)
                 FROM projection_pending_approvals AS approval
                 WHERE approval.thread_id = ? AND approval.status = 'pending'
                 ORDER BY approval.created_at ASC LIMIT 50",
            )?;
            let approvals = statement
                .query_map([&thread_id], |row| {
                    Ok(json!({
                        "requestId": row.get::<_, String>(0)?,
                        "createdAt": row.get::<_, String>(1)?,
                        "summary": row.get::<_, Option<String>>(2)?,
                        "kind": row.get::<_, Option<String>>(3)?,
                        "answerWith": "a person, in BiBCode",
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(PendingRequests {
                questions,
                approvals,
            })
        })
        .await
}

struct DiffPage {
    files: Vec<Value>,
    patch: String,
    next_cursor: Option<String>,
}

/// The patch of `patch` from file `file_index`, character `offset`, at most `budget`
/// characters, and the files it holds. `nextCursor` names where the next page starts, so every
/// patch line can be read.
fn diff_page(patch: &str, file_index: usize, offset: usize, budget: usize) -> DiffPage {
    let mut sections: Vec<&str> = Vec::new();
    let mut start = 0;
    for (at, _) in patch.match_indices("diff --git ") {
        if at > 0 && patch.as_bytes()[at - 1] == b'\n' && at > start {
            sections.push(&patch[start..at]);
            start = at;
        }
    }
    if start < patch.len() {
        sections.push(&patch[start..]);
    }
    let files = sections
        .iter()
        .map(|section| {
            let header = section.lines().next().unwrap_or_default();
            let path = header
                .rsplit_once(" b/")
                .map_or(header, |(_, path)| path)
                .to_owned();
            json!({ "path": path, "chars": section.chars().count() })
        })
        .collect();
    let mut text = String::new();
    let mut used = 0;
    let mut next_cursor = None;
    for (index, section) in sections.iter().enumerate().skip(file_index) {
        let skip = if index == file_index { offset } else { 0 };
        for (taken, character) in section.chars().skip(skip).enumerate() {
            if used == budget {
                next_cursor = Some(format!("{index}:{}", skip + taken));
                break;
            }
            text.push(character);
            used += 1;
        }
        if next_cursor.is_some() {
            break;
        }
    }
    DiffPage {
        files,
        patch: text,
        next_cursor,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lower_ceiling_wins_and_raising_the_setting_never_raises_a_credential() {
        let full = McpAccess::FullAccess;
        let supervised = McpAccess::ApprovalRequired;
        assert_eq!(full.min(supervised), supervised);
        assert_eq!(supervised.min(full), supervised);
        assert_eq!(McpAccess::of_runtime_mode("full-access"), full);
        assert_eq!(McpAccess::of_runtime_mode("something-new"), full);
    }

    #[test]
    fn settings_default_on_and_supervised() {
        assert_eq!(
            mcp_server_settings(&json!({})),
            McpServerSettings::default()
        );
        let off = mcp_server_settings(
            &json!({ "enableMcpServer": false, "mcpServerAccess": "read-only" }),
        );
        assert!(!off.enabled);
        assert_eq!(off.access, McpAccess::ReadOnly);
    }

    #[test]
    fn each_kind_is_refused_the_other_kinds_tools() {
        let scopes = PROVIDER_SCOPES;
        assert!(authorize_call(PrincipalKind::Provider, scopes, "preview_status").is_ok());
        let refused = authorize_call(PrincipalKind::Provider, scopes, "start_thread").unwrap_err();
        assert_eq!(
            refused["structuredContent"]["error"]["_tag"],
            "McpScopeError"
        );
        let refused = authorize_call(PrincipalKind::Client, scopes, "preview_status").unwrap_err();
        assert_eq!(
            refused["structuredContent"]["error"]["_tag"],
            "McpScopeError"
        );
        let refused = authorize_call(
            PrincipalKind::Client,
            &[SCOPE_ORCHESTRATION_READ],
            "start_thread",
        )
        .unwrap_err();
        assert_eq!(
            refused["structuredContent"]["error"]["_tag"],
            "McpScopeError"
        );
    }

    #[test]
    fn every_tool_scope_is_its_rpc_methods_scope() {
        for spec in CLIENT_TOOLS {
            for method in spec.methods {
                let scope = crate::auth::required_scope(method)
                    .unwrap_or_else(|| panic!("{method} has a scope"));
                // A read tool may map to a read method only; an operate tool's dispatch is
                // operate.
                assert_eq!(scope, spec.scope, "{} -> {method}", spec.name);
            }
        }
    }

    #[test]
    fn a_long_patch_is_read_in_full_through_its_cursor() {
        let patch: String = (0..5)
            .map(|index| {
                format!(
                    "diff --git a/f{index} b/f{index}\n{}\n",
                    format!("+line {index}\n").repeat(400)
                )
            })
            .collect();
        let mut read = String::new();
        let mut cursor = (0, 0);
        loop {
            let page = diff_page(&patch, cursor.0, cursor.1, 1_000);
            assert_eq!(page.files.len(), 5);
            assert!(page.patch.chars().count() <= 1_000);
            read.push_str(&page.patch);
            match page.next_cursor {
                Some(next) => {
                    let (file, offset) = next.split_once(':').unwrap();
                    cursor = (file.parse().unwrap(), offset.parse().unwrap());
                }
                None => break,
            }
        }
        assert_eq!(read, patch);
    }

    #[test]
    fn statuses_put_a_waiting_person_first() {
        assert_eq!(
            derive_status(true, true, true, Some("running"), Some("running")),
            "awaiting_approval"
        );
        assert_eq!(
            derive_status(false, true, false, Some("running"), None),
            "awaiting_input"
        );
        assert_eq!(
            derive_status(false, false, true, None, None),
            "delivery_failed"
        );
        assert_eq!(
            derive_status(false, false, false, Some("ready"), Some("completed")),
            "idle"
        );
        assert_eq!(
            derive_status(false, false, false, None, Some("interrupted")),
            "interrupted"
        );
    }
}
