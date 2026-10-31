//! The outside-agent MCP tools on `/mcp` (#139): one registration table for every tool the
//! endpoint serves, the per-call principal, scope, capability and ceiling checks, admission,
//! and the shared helpers each tool family uses.
//!
//! Tools live in families under [`super::tools`]; each family exports its specs, their text
//! and its dispatch, and [`FAMILIES`] registers it with one line. Tools run inside the server
//! and reach the same RPC handlers the UI uses through [`RpcRegistry::invoke_local`] (or
//! [`RpcRegistry::invoke_local_stream`]), so they share its scope checks, maintenance
//! admission, command-receipt replay and timing. They take ids, never commands; the server
//! resolves a thread's working directory ([`super::target`]). Every result is capped at
//! 80 000 characters and says that thread content is untrusted output from agents and tools.
//! Settings, credentials, the updater and pairing have no tools.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use super::protocol::{tool_descriptor, typed_tool_failure};
use crate::{
    auth::{AuthService, Principal},
    orchestration::OrchestrationEngine,
    persistence::Repositories,
    rpc::{RpcRegistry, RpcSessionContext},
};

/// How long a tool list may be cached: it changes with the access and capability settings.
const LIST_TTL_MS: u64 = 60_000;
/// Concurrency bounds: calls and waits per client session, and waits per environment. Only a
/// tool that idles on an engine subscription holds a wait slot.
const MOST_CALLS_PER_SESSION: usize = 8;
const MOST_WAITS_PER_SESSION: usize = 4;
const MOST_WAITS: usize = 32;
/// Owned mutations (keyed git and pull request work that outlives its MCP call) per client
/// session and per environment. Each holds its slot until its outcome is written.
const MOST_OWNED_PER_SESSION: usize = 2;
const MOST_OWNED: usize = 8;
/// Retry rows older than this are pruned on insert, which ends their retry window.
pub(crate) const REQUEST_ROW_TTL_SECONDS: i64 = 24 * 60 * 60;
/// The longest a stream-only RPC a tool runs may take before its receiver is dropped.
pub(crate) const STREAM_BUDGET: Duration = Duration::from_secs(30 * 60);

pub(crate) const DISABLED_TAG: &str = "McpServerDisabledError";
/// The JSON-RPC error code of a non-tool request while the server is off.
pub(crate) const DISABLED_CODE: i64 = -32001;
pub(crate) const DISABLED_MESSAGE: &str = "The MCP server is turned off for this environment. Turn on Settings → Agents → Agent integrations → MCP server.";
pub(crate) const BUSY_TAG: &str = "McpBusyError";

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

/// A set of tools an environment turns on or off for outside agents (`mcpCapabilities`, C8).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpCapability {
    /// Threads, worktrees, previews and devices, panels, clone.
    Workspace,
    /// Git status and writes, pull requests, Source Control reads.
    SourceControl,
    /// Workspace files.
    Files,
    /// Profiler, logs, traces and process diagnostics.
    Diagnostics,
    /// Terminals; off unless a person turns it on.
    Terminals,
}

impl McpCapability {
    pub const ALL: [Self; 5] = [
        Self::Workspace,
        Self::SourceControl,
        Self::Files,
        Self::Diagnostics,
        Self::Terminals,
    ];

    /// The key under `mcpCapabilities`.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::SourceControl => "sourceControl",
            Self::Files => "files",
            Self::Diagnostics => "diagnostics",
            Self::Terminals => "terminals",
        }
    }

    /// The set's name as Settings shows it.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Workspace => "Workspace",
            Self::SourceControl => "Source control",
            Self::Files => "Files",
            Self::Diagnostics => "Diagnostics",
            Self::Terminals => "Terminals",
        }
    }
}

/// The committed `mcpCapabilities`: which tool sets outside agents may use.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct McpCapabilities {
    pub workspace: bool,
    pub source_control: bool,
    pub files: bool,
    pub diagnostics: bool,
    pub terminals: bool,
}

impl Default for McpCapabilities {
    fn default() -> Self {
        Self {
            workspace: true,
            source_control: true,
            files: true,
            diagnostics: true,
            terminals: false,
        }
    }
}

impl McpCapabilities {
    #[must_use]
    pub const fn allows(self, capability: McpCapability) -> bool {
        match capability {
            McpCapability::Workspace => self.workspace,
            McpCapability::SourceControl => self.source_control,
            McpCapability::Files => self.files,
            McpCapability::Diagnostics => self.diagnostics,
            McpCapability::Terminals => self.terminals,
        }
    }

    /// The sets of a `mcpCapabilities` value; an absent key, or a value that is not a
    /// boolean, takes its default.
    #[must_use]
    pub fn parse(value: Option<&Value>) -> Self {
        let defaults = Self::default();
        let read = |capability: McpCapability| {
            value
                .and_then(|value| value.get(capability.key()))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| defaults.allows(capability))
        };
        Self {
            workspace: read(McpCapability::Workspace),
            source_control: read(McpCapability::SourceControl),
            files: read(McpCapability::Files),
            diagnostics: read(McpCapability::Diagnostics),
            terminals: read(McpCapability::Terminals),
        }
    }
}

/// The committed `enableMcpServer`, `mcpServerAccess` and `mcpCapabilities`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct McpServerSettings {
    pub enabled: bool,
    pub access: McpAccess,
    pub capabilities: McpCapabilities,
}

impl Default for McpServerSettings {
    /// On, Supervised, every set but terminals.
    fn default() -> Self {
        Self {
            enabled: true,
            access: McpAccess::DEFAULT,
            capabilities: McpCapabilities::default(),
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
        capabilities: McpCapabilities::parse(settings.get("mcpCapabilities")),
    }
}

/// Which credential a tool is for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrincipalKind {
    /// A provider BiBCode launched: `preview_*` and `device_*`.
    Provider,
    /// An outside agent's `mcp-client` session.
    Client,
}

/// One registered tool. Registration is the only way to add a tool: the call path looks the
/// spec up by its principal kind and name and checks its scope before the handler runs.
#[derive(Clone, Copy, Debug)]
pub struct ToolSpec {
    pub name: &'static str,
    pub kind: PrincipalKind,
    /// `required_scope` of every RPC method the tool maps to.
    pub scope: &'static str,
    /// The RPC methods the tool dispatches to, for timing and `is_long_running`.
    pub methods: &'static [&'static str],
    /// Its duration says little about the server (network, devices, waiting by design), so
    /// `is_long_running` treats `mcp.<name>` as long-running.
    pub long_running: bool,
    /// It idles on an engine subscription and counts toward the wait limits.
    pub holds_wait_slot: bool,
    pub read_only: bool,
    /// It can lose work or rewrite shared history (`destructiveHint`).
    pub destructive: bool,
    /// A repeat with the same arguments has no further effect, whatever changed in between
    /// (`idempotentHint`). Never set on a destructive tool.
    pub idempotent: bool,
    /// It reaches a remote or hosting service (`openWorldHint`).
    pub open_world: bool,
    /// Each call writes one content-free `MCP destructive tool` log line (C7).
    pub audited: bool,
    /// The `mcpCapabilities` set that turns it on; `None` is always listed.
    pub capability: Option<McpCapability>,
}

impl ToolSpec {
    /// An outside agent's mutating tool in the Workspace set; the builders below adjust it.
    #[must_use]
    pub const fn client(
        name: &'static str,
        scope: &'static str,
        methods: &'static [&'static str],
    ) -> Self {
        Self {
            name,
            kind: PrincipalKind::Client,
            scope,
            methods,
            long_running: false,
            holds_wait_slot: false,
            read_only: false,
            destructive: false,
            idempotent: false,
            open_world: false,
            audited: false,
            capability: Some(McpCapability::Workspace),
        }
    }

    /// A provider's tool: it needs `orchestration:operate`, which a provider credential holds
    /// implicitly, and no capability set gates it.
    #[must_use]
    pub const fn provider(name: &'static str, scope: &'static str) -> Self {
        Self {
            kind: PrincipalKind::Provider,
            capability: None,
            ..Self::client(name, scope, &[])
        }
    }

    /// It changes nothing, so it is also idempotent.
    #[must_use]
    pub const fn reads(self) -> Self {
        Self {
            read_only: true,
            idempotent: true,
            ..self
        }
    }

    #[must_use]
    pub const fn runs_long(self) -> Self {
        Self {
            long_running: true,
            ..self
        }
    }

    /// It waits on the engine by design: long-running, and it holds a wait slot.
    #[must_use]
    pub const fn waits(self) -> Self {
        Self {
            long_running: true,
            holds_wait_slot: true,
            ..self
        }
    }

    /// It can lose work: destructive, audited, and never idempotent.
    #[must_use]
    pub const fn destroys(self) -> Self {
        Self {
            destructive: true,
            audited: true,
            idempotent: false,
            ..self
        }
    }

    /// Logged as destructive without the hint (`git_revert_commit`).
    #[must_use]
    pub const fn audit(self) -> Self {
        Self {
            audited: true,
            ..self
        }
    }

    #[must_use]
    pub const fn repeats_safely(self) -> Self {
        Self {
            idempotent: true,
            ..self
        }
    }

    /// It reaches a remote or hosting service, so its duration is the network's too.
    #[must_use]
    pub const fn open_world(self) -> Self {
        Self {
            open_world: true,
            long_running: true,
            ..self
        }
    }

    #[must_use]
    pub const fn in_set(self, capability: Option<McpCapability>) -> Self {
        Self { capability, ..self }
    }
}

/// A boxed tool call future. Tool futures borrow the call, so they are not `'static`.
pub(crate) type ToolFuture<'a> = Pin<Box<dyn Future<Output = ToolResult> + Send + 'a>>;
/// One family's client dispatch: the tool's name, then its optional progress sink.
pub(crate) type FamilyCall =
    for<'a> fn(&'a ToolCall<'a>, &'a str, Option<(ProgressSink, Value)>) -> ToolFuture<'a>;

/// One family of tools: its specs in `tools/list` order, the description and input schema of
/// each client tool, and its client dispatch.
pub(crate) struct Family {
    pub(crate) tools: &'static [ToolSpec],
    pub(crate) text: fn(&str) -> Option<(&'static str, Value)>,
    pub(crate) call: FamilyCall,
}

/// Every tool family. A slice adds its family with one line here and one in `tools/mod.rs`.
pub(crate) const FAMILIES: &[Family] = &[
    super::tools::threads::FAMILY,
    super::tools::git::FAMILY,
    super::tools::previews::FAMILY,
    super::tools::worktrees::FAMILY,
    super::tools::pull_requests::FAMILY,
    super::tools::terminals::FAMILY,
];

/// The spec and family of `name` for `kind` in `families`.
fn lookup<'f>(
    families: &'f [Family],
    kind: PrincipalKind,
    name: &str,
) -> Option<(&'f Family, ToolSpec)> {
    families.iter().find_map(|family| {
        family
            .tools
            .iter()
            .find(|spec| spec.kind == kind && spec.name == name)
            .map(|spec| (family, *spec))
    })
}

/// The scopes a provider credential holds implicitly.
pub const PROVIDER_SCOPES: &[&str] = &[
    crate::auth::SCOPE_ORCHESTRATION_READ,
    crate::auth::SCOPE_ORCHESTRATION_OPERATE,
];

/// The registered spec of `name` for `kind`, or `None` for a tool that does not exist for it.
/// A client tool and a provider tool may share a name.
#[must_use]
pub fn tool_spec(kind: PrincipalKind, name: &str) -> Option<ToolSpec> {
    lookup(FAMILIES, kind, name).map(|(_, spec)| spec)
}

/// Every registered spec of `kind`, in `tools/list` order.
pub fn tool_specs(kind: PrincipalKind) -> impl Iterator<Item = ToolSpec> {
    FAMILIES
        .iter()
        .flat_map(|family| family.tools.iter().copied())
        .filter(move |spec| spec.kind == kind)
}

/// The per-call check: the tool exists for this kind of credential, and the credential holds
/// its scope. A call to a tool only the other kind has is a scope refusal.
pub fn authorize_call(kind: PrincipalKind, scopes: &[&str], name: &str) -> Result<ToolSpec, Value> {
    authorize_in(FAMILIES, kind, scopes, name).map(|(_, spec)| spec)
}

fn authorize_in<'f>(
    families: &'f [Family],
    kind: PrincipalKind,
    scopes: &[&str],
    name: &str,
) -> Result<(&'f Family, ToolSpec), Value> {
    let refused = || {
        typed_tool_failure(
            "McpScopeError",
            &format!("This MCP credential may not call {name}."),
        )
    };
    match lookup(families, kind, name) {
        Some((family, spec)) if scopes.contains(&spec.scope) => Ok((family, spec)),
        Some(_) => Err(refused()),
        None if families
            .iter()
            .flat_map(|family| family.tools)
            .any(|spec| spec.name == name) =>
        {
            Err(refused())
        }
        None => Err(typed_tool_failure("McpUnknownToolError", "Unknown tool.")),
    }
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
    pub(super) inner: Arc<Inner>,
}

pub(super) struct Inner {
    registry: RpcRegistry,
    auth: AuthService,
    engine: OrchestrationEngine,
    repositories: Repositories,
    settings: watch::Receiver<McpServerSettings>,
    shutdown: CancellationToken,
    sessions: Mutex<HashMap<String, Load>>,
    waits: AtomicUsize,
    owned: AtomicUsize,
    /// The `clientRequestId`s whose recorded call runs in this process (`outcome.rs`).
    pub(super) claims: super::outcome::Claims,
    /// The preview host and devices the client twins of the provider tools use (slice D),
    /// attached by the Connect service that owns them.
    previews: std::sync::OnceLock<super::tools::previews::PreviewServices>,
    /// The terminal manager the terminal tools use (slice T), attached by the runtime.
    terminals: std::sync::OnceLock<super::tools::terminals::TerminalServices>,
}

#[derive(Default)]
struct Load {
    calls: usize,
    waits: usize,
    owned: usize,
}

impl Load {
    const fn idle(&self) -> bool {
        self.calls == 0 && self.owned == 0
    }
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
            if load.idle() {
                sessions.remove(&self.session_id);
            }
        }
        if self.wait {
            self.inner.waits.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

/// Holds one owned mutation's place until its outcome is written, however its MCP call ended.
pub(crate) struct OwnedSlot {
    inner: Arc<Inner>,
    session_id: String,
}

impl Drop for OwnedSlot {
    fn drop(&mut self) {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(load) = sessions.get_mut(&self.session_id) {
            load.owned = load.owned.saturating_sub(1);
            if load.idle() {
                sessions.remove(&self.session_id);
            }
        }
        self.inner.owned.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) type ToolResult = Result<Value, Value>;

pub(crate) fn busy() -> Value {
    typed_tool_failure(
        BUSY_TAG,
        "Too many MCP calls are in flight for this connection; retry when one returns.",
    )
}

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
                owned: AtomicUsize::new(0),
                claims: super::outcome::Claims::default(),
                previews: std::sync::OnceLock::new(),
                terminals: std::sync::OnceLock::new(),
            }),
        }
    }

    /// Refuses new calls, ends every wait in flight and interrupts every owned mutation, which
    /// records `unknown`. The runtime calls this right after the profiler starts stopping,
    /// before the orchestration engine shuts down.
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

    /// The tools this principal may call now: a set that is off hides its tools, and the
    /// operate tools are hidden at read-only.
    #[must_use]
    pub fn tools(&self, principal: &ClientPrincipal) -> Value {
        let read_only = self.effective_ceiling(principal) == McpAccess::ReadOnly;
        let capabilities = self.settings().capabilities;
        Value::Array(
            FAMILIES
                .iter()
                .flat_map(|family| family.tools.iter().map(move |spec| (family, spec)))
                .filter(|(_, spec)| spec.kind == PrincipalKind::Client)
                .filter(|(_, spec)| spec.read_only || !read_only)
                .filter(|(_, spec)| spec.capability.is_none_or(|set| capabilities.allows(set)))
                .map(|(family, spec)| describe(family, spec))
                .collect(),
        )
    }

    #[must_use]
    pub fn list_ttl_ms(&self) -> u64 {
        LIST_TTL_MS
    }

    /// Runs one outside-agent tool. Every refusal or failure is a typed tool result.
    pub async fn call(
        &self,
        principal: &ClientPrincipal,
        name: &str,
        arguments: &Map<String, Value>,
        progress: Option<(ProgressSink, Value)>,
        cancellation: CancellationToken,
    ) -> Value {
        self.call_in(FAMILIES, principal, name, arguments, progress, cancellation)
            .await
    }

    /// [`Self::call`] over `families`, so tests can register a family of their own.
    pub(crate) async fn call_in(
        &self,
        families: &[Family],
        principal: &ClientPrincipal,
        name: &str,
        arguments: &Map<String, Value>,
        progress: Option<(ProgressSink, Value)>,
        cancellation: CancellationToken,
    ) -> Value {
        let settings = self.settings();
        if !settings.enabled {
            return typed_tool_failure(DISABLED_TAG, DISABLED_MESSAGE);
        }
        if self.inner.shutdown.is_cancelled() {
            return typed_tool_failure(
                "McpServerStoppingError",
                "This BiBCode server is shutting down; try again once it is back.",
            );
        }
        let (family, spec) = match authorize_in(
            families,
            PrincipalKind::Client,
            &principal
                .principal
                .scopes
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            name,
        ) {
            Ok(found) => found,
            Err(refusal) => return refusal,
        };
        if let Some(set) = spec.capability
            && !settings.capabilities.allows(set)
        {
            return typed_tool_failure(
                "McpCapabilityDisabledError",
                &format!(
                    "Turn on {} for MCP agents in Settings → Agents → Agent integrations.",
                    set.label()
                ),
            );
        }
        if !spec.read_only && self.effective_ceiling(principal) == McpAccess::ReadOnly {
            return typed_tool_failure(
                "McpAccessCeilingError",
                "This MCP connection is read-only (Settings → Agents → Agent integrations → Agents may).",
            );
        }
        let _admission = match self.admit(&principal.principal.session_id, spec.holds_wait_slot) {
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
        let result = (family.call)(&call, name, progress)
            .await
            .unwrap_or_else(|failure| failure);
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
        let error = (result["isError"] == true).then(|| {
            result["structuredContent"]["error"]["_tag"]
                .as_str()
                .unwrap_or("McpToolError")
        });
        if spec.audited {
            tracing::info!(
                tool = name,
                session_id = principal.principal.session_id.as_str(),
                thread_id,
                outcome = error.unwrap_or("success"),
                duration_ms,
                "MCP destructive tool"
            );
        }
        if let Some(error) = error {
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

    /// One owned-mutation slot for `session_id`, or `McpBusyError` past 2 per session or 8 per
    /// environment.
    pub(crate) fn admit_owned(&self, session_id: &str) -> Result<OwnedSlot, Value> {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let load = sessions.entry(session_id.to_owned()).or_default();
        if load.owned >= MOST_OWNED_PER_SESSION {
            if load.idle() {
                sessions.remove(session_id);
            }
            return Err(busy());
        }
        if self.inner.owned.fetch_add(1, Ordering::AcqRel) >= MOST_OWNED {
            self.inner.owned.fetch_sub(1, Ordering::AcqRel);
            if load.idle() {
                sessions.remove(session_id);
            }
            return Err(busy());
        }
        load.owned += 1;
        Ok(OwnedSlot {
            inner: Arc::clone(&self.inner),
            session_id: session_id.to_owned(),
        })
    }

    pub(crate) fn engine(&self) -> &OrchestrationEngine {
        &self.inner.engine
    }

    pub(crate) fn repositories(&self) -> &Repositories {
        &self.inner.repositories
    }

    pub(crate) fn registry(&self) -> &RpcRegistry {
        &self.inner.registry
    }

    pub(crate) fn auth(&self) -> &AuthService {
        &self.inner.auth
    }

    pub(crate) fn settings_signal(&self) -> watch::Receiver<McpServerSettings> {
        self.inner.settings.clone()
    }

    pub(crate) fn shutdown_token(&self) -> CancellationToken {
        self.inner.shutdown.clone()
    }

    /// Lets the client twins of `preview_*` and `device_*` reach the preview host and the
    /// devices. The first attachment wins.
    pub(crate) fn attach_previews(&self, services: super::tools::previews::PreviewServices) {
        let _ = self.inner.previews.set(services);
    }

    /// The attached preview services; `None` on a server without the Connect service.
    pub(crate) fn previews(&self) -> Option<&super::tools::previews::PreviewServices> {
        self.inner.previews.get()
    }

    /// Lets the terminal tools reach the terminals. The first attachment wins.
    pub fn attach_terminals(&self, manager: crate::terminal::TerminalManager) {
        let _ = self
            .inner
            .terminals
            .set(super::tools::terminals::TerminalServices::new(manager));
    }

    /// The attached terminals; `None` on a server that attached none.
    pub(crate) fn terminals(&self) -> Option<&super::tools::terminals::TerminalServices> {
        self.inner.terminals.get()
    }
}

/// A client tool's descriptor, with the hints its spec declares.
fn describe(family: &Family, spec: &ToolSpec) -> Value {
    let (description, input) =
        (family.text)(spec.name).unwrap_or(("", json!({ "type": "object" })));
    tool_descriptor(
        spec.name,
        description,
        input,
        json!({
            "readOnlyHint": spec.read_only,
            "destructiveHint": spec.destructive,
            "idempotentHint": spec.idempotent && !spec.destructive,
            "openWorldHint": spec.open_world,
        }),
    )
}

pub(crate) const CLIENT_REQUEST_ID: &str = "An id you choose so a retry of this exact call does not repeat it. The same id with any other argument is refused as idempotency_conflict. It is remembered for 24 hours per MCP connection; after that it starts a new request.";

/// The input schema of an object with `properties`, of which `required` must be given.
pub(crate) fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
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
pub(crate) struct RequestKey {
    pub(crate) session_id: String,
    pub(crate) client_request_id: String,
    pub(crate) tool: String,
    pub(crate) digest: String,
}

pub(crate) fn invalid_argument(message: &str) -> Value {
    typed_tool_failure("McpInvalidArgumentError", message)
}

/// Fields of an RPC error a tool failure keeps beside its tag and message: the git manager's
/// `code` and `blocked`, a stacked action's `phase`.
const KEPT_ERROR_FIELDS: &[&str] = &["code", "blocked", "phase", "reason"];

/// An RPC error as a typed tool failure.
pub(crate) fn rpc_failure(error: &Value) -> Value {
    let tag = error
        .get("_tag")
        .and_then(Value::as_str)
        .unwrap_or("McpToolError");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map_or_else(|| error.to_string(), str::to_owned);
    let mut failure = typed_tool_failure(tag, &message);
    for field in KEPT_ERROR_FIELDS {
        if let Some(value) = error.get(*field) {
            failure["structuredContent"]["error"][*field] = value.clone();
        }
    }
    failure
}

pub(crate) fn storage_failure(error: impl std::fmt::Display) -> Value {
    tracing::warn!(%error, "an MCP tool could not read the store");
    typed_tool_failure(
        "McpStorageError",
        "BiBCode could not read its store; try again.",
    )
}

pub(crate) fn now_iso() -> String {
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

    pub(crate) fn boolean(&self, key: &str) -> Result<Option<bool>, Value> {
        match self.arguments.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(value)) => Ok(Some(*value)),
            Some(_) => Err(invalid_argument(&format!("{key} must be true or false"))),
        }
    }

    pub(crate) fn context(&self) -> RpcSessionContext {
        RpcSessionContext::authenticated(
            self.principal.principal.clone(),
            self.control.inner.auth.clone(),
        )
    }

    /// Runs RPC method `tag` with this call's credential: B1, the same handler and checks the
    /// UI's request gets.
    pub(crate) async fn invoke(&self, tag: &str, payload: Value) -> Result<Value, Value> {
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
        super::target::live_thread(self.control, thread_id).await
    }

    /// Refuses work that would advance a thread running above this connection's limit.
    pub(crate) fn check_thread_mode(&self, runtime_mode: &str) -> Result<(), Value> {
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
    /// the existing thread the commands advance. For RPCs that carry a `commandId` receipt;
    /// others use [`ToolCall::recorded`]. See the design's Retries section.
    pub(crate) async fn commands(
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

    pub(crate) fn request_key(&self, tool: &str) -> Result<Option<RequestKey>, Value> {
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
                // A `bibcode thread` run mints a credential of its own and revokes it on the
                // way out, so a retry from a new run could not find the first run's request:
                // those credentials share one scope. Any other client's request belongs to
                // its session.
                let session_id: String = transaction
                    .query_row(
                        "SELECT CASE WHEN client_label = ?1 THEN ?1 ELSE session_id END FROM auth_sessions WHERE session_id = ?2",
                        params![super::thread_cli::LABEL, session_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .unwrap_or(session_id);
                if let Some(fresh_json) = fresh_json {
                    prune_request_rows(&transaction)?;
                    transaction.execute(
                        "INSERT OR IGNORE INTO mcp_tool_requests (session_id, client_request_id, tool, arguments_digest, commands_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        params![session_id, client_request_id, tool, digest, fresh_json, now_iso()],
                    )?;
                }
                let row = transaction
                    .query_row(
                        "SELECT tool, arguments_digest, commands_json, state FROM mcp_tool_requests WHERE session_id = ? AND client_request_id = ?",
                        params![session_id, client_request_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
                    )
                    .optional()?;
                transaction.commit()?;
                Ok(row)
            })
            .await
            .map_err(storage_failure)?;
        let Some((stored_tool, stored_digest, commands, state)) = stored else {
            return Ok(None);
        };
        // A recorded outcome's row is never a command list to replay.
        if stored_tool != key.tool || stored_digest != key.digest || state != "commands" {
            return Err(idempotency_conflict());
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

    pub(crate) async fn dispatch(&self, command: Value) -> Result<Value, Value> {
        self.invoke("orchestration.dispatchCommand", command).await
    }
}

pub(crate) fn idempotency_conflict() -> Value {
    typed_tool_failure(
        "idempotency_conflict",
        "This clientRequestId was already used for a different call; use a new id.",
    )
}

/// Deletes retry rows past their 24-hour window.
pub(crate) fn prune_request_rows(connection: &rusqlite::Connection) -> rusqlite::Result<()> {
    let cutoff = (time::OffsetDateTime::now_utc()
        - time::Duration::seconds(REQUEST_ROW_TTL_SECONDS))
    .format(&time::format_description::well_known::Rfc3339)
    .unwrap_or_default();
    connection.execute(
        "DELETE FROM mcp_tool_requests WHERE created_at < ?",
        [&cutoff],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{SCOPE_ORCHESTRATION_OPERATE, SCOPE_ORCHESTRATION_READ};

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
    fn settings_default_on_supervised_and_every_set_but_terminals() {
        assert_eq!(
            mcp_server_settings(&json!({})),
            McpServerSettings::default()
        );
        let defaults = McpServerSettings::default().capabilities;
        assert!(
            McpCapability::ALL[..4]
                .iter()
                .all(|set| defaults.allows(*set))
        );
        assert!(!defaults.allows(McpCapability::Terminals));
        let off = mcp_server_settings(&json!({
            "enableMcpServer": false,
            "mcpServerAccess": "read-only",
            "mcpCapabilities": { "files": false, "terminals": true, "workspace": "yes" },
        }));
        assert!(!off.enabled);
        assert_eq!(off.access, McpAccess::ReadOnly);
        assert!(!off.capabilities.files);
        assert!(off.capabilities.terminals);
        // A value that is not a boolean keeps its default.
        assert!(off.capabilities.workspace);
    }

    #[test]
    fn each_kind_is_refused_the_other_kinds_tools() {
        let scopes = &[SCOPE_ORCHESTRATION_READ, SCOPE_ORCHESTRATION_OPERATE];
        assert!(authorize_call(PrincipalKind::Provider, scopes, "preview_status").is_ok());
        assert!(authorize_call(PrincipalKind::Provider, scopes, "device_open").is_ok());
        let refused = authorize_call(PrincipalKind::Provider, scopes, "start_thread").unwrap_err();
        assert_eq!(
            refused["structuredContent"]["error"]["_tag"],
            "McpScopeError"
        );
        // An outside agent's `preview_status` is its own twin (slice D), and needs operate.
        let twin = authorize_call(PrincipalKind::Client, scopes, "preview_status").unwrap();
        assert_eq!(twin.kind, PrincipalKind::Client);
        let refused = authorize_call(
            PrincipalKind::Client,
            &[SCOPE_ORCHESTRATION_READ],
            "preview_status",
        )
        .unwrap_err();
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
        let unknown = authorize_call(PrincipalKind::Client, scopes, "preview_nothing").unwrap_err();
        assert_eq!(
            unknown["structuredContent"]["error"]["_tag"],
            "McpUnknownToolError"
        );
    }

    fn no_call<'a>(
        _: &'a ToolCall<'a>,
        _: &'a str,
        _: Option<(ProgressSink, Value)>,
    ) -> ToolFuture<'a> {
        Box::pin(async { Err(json!(null)) })
    }

    fn no_text(_: &str) -> Option<(&'static str, Value)> {
        None
    }

    #[test]
    fn a_client_tool_may_share_a_providers_tool_name() {
        const CLIENT: &[ToolSpec] =
            &[ToolSpec::client("device_list", SCOPE_ORCHESTRATION_READ, &[]).reads()];
        const PROVIDER: &[ToolSpec] =
            &[ToolSpec::provider("device_list", SCOPE_ORCHESTRATION_OPERATE).runs_long()];
        let families = [
            Family {
                tools: CLIENT,
                text: no_text,
                call: no_call,
            },
            Family {
                tools: PROVIDER,
                text: no_text,
                call: no_call,
            },
        ];
        let (_, client) = lookup(&families, PrincipalKind::Client, "device_list").unwrap();
        let (_, provider) = lookup(&families, PrincipalKind::Provider, "device_list").unwrap();
        assert!(client.read_only && !client.long_running);
        assert!(!provider.read_only && provider.long_running);
        // Each kind holds its own scope for its own twin.
        assert!(
            authorize_in(
                &families,
                PrincipalKind::Client,
                &[SCOPE_ORCHESTRATION_READ],
                "device_list"
            )
            .is_ok()
        );
        assert!(
            authorize_in(
                &families,
                PrincipalKind::Provider,
                &[SCOPE_ORCHESTRATION_READ],
                "device_list"
            )
            .is_err()
        );
    }

    #[test]
    fn every_family_registers_unique_names_scoped_by_their_methods() {
        for kind in [PrincipalKind::Client, PrincipalKind::Provider] {
            let names: Vec<&str> = tool_specs(kind).map(|spec| spec.name).collect();
            let mut unique = names.clone();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(unique.len(), names.len(), "duplicate {kind:?} tool names");
        }
        for spec in tool_specs(PrincipalKind::Client).chain(tool_specs(PrincipalKind::Provider)) {
            for method in spec.methods {
                let scope = crate::auth::required_scope(method)
                    .unwrap_or_else(|| panic!("{method} has a scope"));
                // A read tool may map to a read method only; an operate tool's dispatch is
                // operate.
                assert_eq!(scope, spec.scope, "{} -> {method}", spec.name);
            }
            // C7: every destructive tool writes the audit line, and none is idempotent.
            assert!(
                !spec.destructive || spec.audited,
                "{} is audited",
                spec.name
            );
            assert!(
                !(spec.destructive && spec.idempotent),
                "{} is not idempotent",
                spec.name
            );
            assert!(!spec.read_only || !spec.destructive, "{}", spec.name);
            // A tool that holds a wait slot is long-running; a long-running one need not.
            assert!(!spec.holds_wait_slot || spec.long_running, "{}", spec.name);
        }
    }

    #[test]
    fn only_wait_for_thread_holds_a_wait_slot() {
        let waiting: Vec<&str> = tool_specs(PrincipalKind::Client)
            .chain(tool_specs(PrincipalKind::Provider))
            .filter(|spec| spec.holds_wait_slot)
            .map(|spec| spec.name)
            .collect();
        assert_eq!(waiting, ["wait_for_thread"]);
    }

    #[test]
    fn hints_follow_the_spec() {
        const TOOLS: &[ToolSpec] = &[
            ToolSpec::client("remove_it", SCOPE_ORCHESTRATION_OPERATE, &[])
                .repeats_safely()
                .destroys(),
            ToolSpec::client("fetch_it", SCOPE_ORCHESTRATION_OPERATE, &[])
                .open_world()
                .repeats_safely(),
        ];
        let family = Family {
            tools: TOOLS,
            text: no_text,
            call: no_call,
        };
        let removed = describe(&family, &TOOLS[0]);
        assert_eq!(removed["annotations"]["destructiveHint"], true);
        assert_eq!(removed["annotations"]["idempotentHint"], false);
        assert_eq!(removed["annotations"]["readOnlyHint"], false);
        let fetched = describe(&family, &TOOLS[1]);
        assert_eq!(fetched["annotations"]["destructiveHint"], false);
        assert_eq!(fetched["annotations"]["idempotentHint"], true);
        assert_eq!(fetched["annotations"]["openWorldHint"], true);
        assert!(TOOLS[1].long_running);
    }

    #[test]
    fn an_rpc_failure_keeps_its_code_blocked_reason_and_phase() {
        let failure = rpc_failure(&json!({
            "_tag": "GitOperationFailedError", "message": "rejected",
            "code": "non-fast-forward", "blocked": null, "phase": "push", "detail": "long text",
        }));
        let error = &failure["structuredContent"]["error"];
        assert_eq!(error["_tag"], "GitOperationFailedError");
        assert_eq!(error["code"], "non-fast-forward");
        assert_eq!(error["phase"], "push");
        assert!(error.get("blocked").is_some());
        assert!(error.get("detail").is_none());
    }
}
