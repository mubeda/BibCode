//! `agentSessions.scan` and `agentSessions.import`: Claude Code and Codex CLI sessions recorded
//! on this host, offered as project threads whose next turn resumes the CLI conversation.
//! `agentSessions.listForThread` and `agentSessions.openInPanel`: the Claude Code terminal
//! sessions run in one thread's folder, continued (or copied) in a chat panel of that thread.

use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{
    provider_inventory::instance_custom_models,
    provider_runtime::{
        PublishedProviderInventory, native_adapter_key, resolve_provider_route_settings,
    },
    step_gate::StepGate,
};
use crate::{
    agent_sessions::{
        self, AgentSessionProvider, ListingBudget, Liveness, ParsedSession, SessionFolder,
        SessionSource,
    },
    orchestration::{
        CommandAdmission, OrchestrationCommand, OrchestrationEngine, canonical_command_digest,
        engine::{ImportedThreadMessage, MAX_IMPORTED_THREAD_MESSAGES},
    },
    persistence::{ProjectionProject, ProjectionThread, ProviderSessionRuntime},
    provider::{
        claude,
        environment::{claude_config_directory, codex_home_directory},
    },
    rpc::{RpcRegistry, RpcRequest, RpcResult},
    server_settings::ProviderSettingsStore,
    worktree_catalog::WorktreeCatalogService,
};

/// The built-in instance scanned for each driver; other instances are out of scope.
const SOURCES: [(AgentSessionProvider, &str); 2] = [
    (AgentSessionProvider::ClaudeAgent, "claudeAgent"),
    (AgentSessionProvider::Codex, "codex"),
];
/// Mirrors `DEFAULT_MODEL_BY_PROVIDER` in `packages/contracts/src/model.ts`.
const CLAUDE_DEFAULT_MODEL: &str = "claude-sonnet-5";
const CODEX_DEFAULT_MODEL: &str = "gpt-5.4";
const IMPORTED_RUNTIME_MODE: &str = "full-access";
const USED_BEFORE_IMPORT: &str =
    "This session's thread was used before its import finished, so it keeps its own conversation.";
const IMPORTED_INTERACTION_MODE: &str = "default";
/// The only instance History lists: the one a panel's Claude turns run on.
const CLAUDE_INSTANCE: &str = "claudeAgent";
/// The first Claude Code that honors `--session-id` beside `--resume` and `--fork-session`.
pub(crate) const COPY_MINIMUM_CLAUDE_VERSION: [u64; 3] = [2, 0, 73];
/// Separates the fork-ID hash from any other ID derived from the same inputs.
const FORK_ID_DOMAIN: &[u8] = b"bibcode:agentSessions.openInPanel:fork-id:v1\0";
const CLAUDE_TURNED_OFF: &str =
    "Claude Code is turned off on the server. Turn it on in Settings → Providers.";
const COPY_NEEDS_UPDATE: &str =
    "Continue in a copy needs Claude Code 2.0.73 or later. Update it in Settings → Providers.";
const OPEN_IN_A_TERMINAL: &str = "This session is open in a terminal. Choose Continue in a copy.";
const SESSION_CHAT_DELETED: &str = "This session's chat was deleted. Choose Continue in a copy.";
const COPY_CHAT_DELETED: &str = "This copy's chat was deleted.";
const FOLDER_CHANGED: &str = "This thread's folder changed. Try again.";
const THREAD_DELETED: &str = "The thread was deleted.";
const NOT_A_TERMINAL_SESSION: &str = "This session wasn't run in a terminal.";
const OWNED_BY_A_THREAD: &str = "This session already belongs to a BiBCode thread.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanInput {
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListInput {
    thread_id: String,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum OpenMode {
    Resume,
    Fork,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenInPanelInput {
    command_id: String,
    host_thread_id: String,
    session_id: String,
    mode: OpenMode,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    session_id: String,
    title: String,
    last_active_at: String,
    branch: Option<String>,
    liveness: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    imported_thread: Option<ImportedThread>,
    import_deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedThread {
    thread_id: String,
    host_thread_id: Option<String>,
    archived: bool,
    resume_refused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportInput {
    project_id: String,
    sessions: Vec<SessionRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRef {
    provider: AgentSessionProvider,
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    provider: AgentSessionProvider,
    session_id: String,
    title: String,
    message_count: usize,
    last_active_at: String,
    already_imported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    /// The host of a session continued from History, whose thread is a chat panel.
    #[serde(skip_serializing_if = "Option::is_none")]
    host_thread_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Imported {
    session_id: String,
    thread_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Skipped {
    session_id: String,
    reason: String,
}

#[derive(Clone)]
struct Services {
    orchestration: OrchestrationEngine,
    settings_root: PathBuf,
    /// Its project mutation lock orders a panel's creation against worktree changes.
    catalog: WorktreeCatalogService,
    /// The installed Claude Code version decides whether copies are offered.
    inventory: PublishedProviderInventory,
    /// Holds `agentSessions.openInPanel` after it read the transcript, for tests.
    loaded_gate: Option<StepGate>,
}

struct ResolvedSource {
    source: SessionSource,
    instance_id: &'static str,
}

pub fn register_agent_sessions_rpc(
    registry: &mut RpcRegistry,
    orchestration: OrchestrationEngine,
    settings_root: PathBuf,
    catalog: WorktreeCatalogService,
    inventory: PublishedProviderInventory,
) {
    register(
        registry,
        Services {
            orchestration,
            settings_root,
            catalog,
            inventory,
            loaded_gate: None,
        },
    );
}

/// [`register_agent_sessions_rpc`] whose `agentSessions.openInPanel` waits at `loaded_gate`
/// once it has read the transcript, before it takes the project lock.
#[doc(hidden)]
pub fn register_agent_sessions_rpc_with_loaded_gate(
    registry: &mut RpcRegistry,
    orchestration: OrchestrationEngine,
    settings_root: PathBuf,
    catalog: WorktreeCatalogService,
    inventory: PublishedProviderInventory,
    loaded_gate: StepGate,
) {
    register(
        registry,
        Services {
            orchestration,
            settings_root,
            catalog,
            inventory,
            loaded_gate: Some(loaded_gate),
        },
    );
}

fn register(registry: &mut RpcRegistry, services: Services) {
    let scan_services = services.clone();
    registry.register_unary("agentSessions.scan", move |request, cancellation| {
        let services = scan_services.clone();
        async move { cancellable(&cancellation, scan(&services, request, &cancellation)).await }
    });
    let import_services = services.clone();
    registry.register_unary("agentSessions.import", move |request, cancellation| {
        let services = import_services.clone();
        async move { import(&services, request, &cancellation).await }
    });
    let list_services = services.clone();
    registry.register_unary(
        "agentSessions.listForThread",
        move |request, cancellation| {
            let services = list_services.clone();
            async move {
                cancellable(
                    &cancellation,
                    list_for_thread(&services, request, &cancellation),
                )
                .await
            }
        },
    );
    registry.register_unary("agentSessions.openInPanel", move |request, cancellation| {
        let services = services.clone();
        async move { open_in_panel(&services, request, &cancellation).await }
    });
}

fn error(message: impl Into<String>) -> Value {
    json!({ "_tag": "AgentSessionsError", "message": message.into() })
}

fn decode<T: for<'de> Deserialize<'de>>(request: RpcRequest) -> Result<T, Value> {
    serde_json::from_value(request.payload)
        .map_err(|cause| error(format!("The request was invalid: {cause}")))
}

async fn cancellable(
    cancellation: &CancellationToken,
    work: impl Future<Output = RpcResult>,
) -> RpcResult {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(error("The request was cancelled.")),
        result = work => result,
    }
}

fn thread_id(instance_id: &str, session_id: &str) -> String {
    format!("import:{instance_id}:{session_id}")
}

/// A copy's thread. Deliberately not an import ID: once the copy writes its transcript beside the
/// source's, the owner filter pairs `fork_id` with this thread, which [`is_import_of`] rejects,
/// so History and the Import dialog leave the copy out as a conversation BiBCode owns.
fn copy_thread_id(instance_id: &str, fork_id: &str) -> String {
    format!("copy:{instance_id}:{fork_id}")
}

/// The session ID a copy runs under: derived from the command, so a retry reaches the same copy
/// and every other **Continue in a copy** makes a new one. A UUID v4 layout, which Claude takes
/// for `--session-id`.
fn fork_session_id(command_id: &str, session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(FORK_ID_DOMAIN);
    hasher.update(command_id.as_bytes());
    hasher.update([0]);
    hasher.update(session_id.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes)
        .into_uuid()
        .to_string()
}

/// Native sessions that BiBCode threads other than their own import already run. Those
/// transcripts sit in the same homes, and a second thread resuming one would share it.
async fn sessions_owned_by_other_threads(services: &Services) -> Result<HashSet<String>, Value> {
    let owners = services
        .orchestration
        .repositories()
        .list_provider_session_owners()
        .await
        .map_err(|_| error("BiBCode could not read its provider sessions. Try again."))?;
    Ok(owners
        .into_iter()
        .filter(|(session_id, owner)| !is_import_of(owner, session_id))
        .map(|(session_id, _)| session_id)
        .collect())
}

/// Whether `thread_id` is the import of `session_id`, the thread whose own conversation it is.
pub(crate) fn is_import_of(thread_id: &str, session_id: &str) -> bool {
    thread_id
        .strip_prefix("import:")
        .and_then(|rest| rest.split_once(':'))
        .is_some_and(|(_, imported)| imported == session_id)
}

/// The accepted history command is the last step of an import.
async fn history_imported(
    repositories: &crate::persistence::Repositories,
    thread_id: &str,
) -> crate::persistence::Result<bool> {
    Ok(repositories
        .get_command_receipt(format!("{thread_id}:history"))
        .await?
        .is_some_and(|receipt| receipt.status == "accepted"))
}

async fn live_project(services: &Services, project_id: &str) -> Result<ProjectionProject, Value> {
    services
        .orchestration
        .repositories()
        .get_project(project_id.to_owned())
        .await
        .map_err(|_| error("The project could not be read. Try again."))?
        .filter(|project| project.deleted_at.is_none())
        .ok_or_else(|| error("The project no longer exists."))
}

/// The configured home of each built-in instance that is enabled; a disabled driver could not
/// resume an imported session.
async fn resolve_sources(settings_root: &PathBuf) -> Vec<ResolvedSource> {
    let mut sources = Vec::new();
    for (provider, instance_id) in SOURCES {
        let Ok(route) = resolve_provider_route_settings(settings_root, instance_id, None).await
        else {
            continue;
        };
        if route.provider != provider.kind() {
            continue;
        }
        let environment = route
            .environment
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect::<Vec<_>>();
        let home = match (provider, route.codex) {
            (AgentSessionProvider::ClaudeAgent, _) => claude_config_directory(&environment),
            // A configured home (or shadow home) shares its sessions with `shared_home_path`;
            // otherwise the driver sets no CODEX_HOME and Codex resolves its own home from the
            // instance environment.
            (AgentSessionProvider::Codex, Some(codex)) => Some(
                codex
                    .home
                    .effective_home_path
                    .is_none()
                    .then(|| codex_home_directory(&environment))
                    .flatten()
                    .unwrap_or(codex.home.shared_home_path),
            ),
            (AgentSessionProvider::Codex, None) => None,
        };
        if let Some(home) = home {
            sources.push(ResolvedSource {
                source: SessionSource { provider, home },
                instance_id,
            });
        }
    }
    sources
}

fn canonical_workspace_root(project: &ProjectionProject) -> PathBuf {
    let root = PathBuf::from(&project.workspace_root);
    std::fs::canonicalize(&root).unwrap_or(root)
}

async fn scan(
    services: &Services,
    request: RpcRequest,
    cancellation: &CancellationToken,
) -> RpcResult {
    let input = decode::<ScanInput>(request)?;
    let project = live_project(services, &input.project_id).await?;
    let sources = resolve_sources(&services.settings_root).await;
    let imported = services
        .orchestration
        .repositories()
        .list_threads_by_project(project.project_id.clone())
        .await
        .map_err(|_| error("The project's threads could not be read. Try again."))?
        .into_iter()
        .map(|thread| (thread.thread_id.clone(), thread))
        .collect::<HashMap<_, _>>();
    let instances = sources
        .iter()
        .map(|resolved| (resolved.source.provider, resolved.instance_id))
        .collect::<HashMap<_, _>>();
    let session_sources = sources
        .into_iter()
        .map(|resolved| resolved.source)
        .collect::<Vec<_>>();
    let owned = sessions_owned_by_other_threads(services).await?;
    // An interrupted RPC drops this future, so the blocking scan watches the token itself.
    let scan_cancellation = cancellation.clone();
    let result = tokio::task::spawn_blocking(move || {
        let workspace_root = canonical_workspace_root(&project);
        agent_sessions::scan(
            &session_sources,
            &workspace_root,
            SystemTime::now(),
            &owned,
            &scan_cancellation,
        )
    })
    .await
    .map_err(|_| error("The CLI session scan stopped unexpectedly. Try again."))?;
    let repositories = services.orchestration.repositories();
    let mut candidates = Vec::with_capacity(result.candidates.len());
    for candidate in result.candidates {
        let id = thread_id(
            instances[&candidate.provider],
            &candidate.session.session_id,
        );
        // A deleted import cannot be imported again. A live thread whose history never
        // committed (an interrupted import) stays selectable so the import can finish.
        let (already_imported, thread) = match imported.get(&id) {
            None => (false, None),
            Some(thread) if thread.deleted_at.is_some() => (true, None),
            Some(thread) => {
                let completed = history_imported(&repositories, &id)
                    .await
                    .map_err(|_| error("The project's threads could not be read. Try again."))?;
                (completed, completed.then_some(thread))
            }
        };
        candidates.push(Candidate {
            provider: candidate.provider,
            session_id: candidate.session.session_id,
            title: candidate.session.title,
            message_count: candidate.session.message_count,
            last_active_at: candidate.last_active_at,
            already_imported,
            thread_id: thread.map(|thread| thread.thread_id.clone()),
            host_thread_id: thread.and_then(panel_host),
        });
    }
    Ok(json!({ "candidates": candidates, "truncated": result.truncated }))
}

async fn import(
    services: &Services,
    request: RpcRequest,
    cancellation: &CancellationToken,
) -> RpcResult {
    let input = decode::<ImportInput>(request)?;
    if input.sessions.is_empty() || input.sessions.len() > agent_sessions::MAX_CANDIDATES {
        return Err(error(format!(
            "Choose between 1 and {} sessions to import.",
            agent_sessions::MAX_CANDIDATES
        )));
    }
    let project = live_project(services, &input.project_id).await?;
    let sources = resolve_sources(&services.settings_root).await;
    let settings = ProviderSettingsStore::new(&services.settings_root)
        .get_document()
        .await
        .unwrap_or(Value::Null);
    let workspace_root = canonical_workspace_root(&project);
    let folder = SessionFolder::new(Path::new(&project.workspace_root));
    let owned = sessions_owned_by_other_threads(services).await?;
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    for session in input.sessions {
        if cancellation.is_cancelled() {
            return Err(error("The import was cancelled."));
        }
        let outcome = match sources
            .iter()
            .find(|resolved| resolved.source.provider == session.provider)
        {
            Some(_) if owned.contains(&session.session_id) => Err(OWNED_BY_A_THREAD.to_owned()),
            Some(source) => {
                let thread_id = thread_id(source.instance_id, &session.session_id);
                import_session(
                    services,
                    &ImportRequest {
                        project: &project,
                        folder: &folder,
                        workspace_root: &workspace_root,
                        resolved: source,
                        session_id: &session.session_id,
                        thread_id: &thread_id,
                        target: ImportTarget::Sidebar,
                        settings: &settings,
                    },
                    cancellation,
                )
                .await
                .and_then(|outcome| match outcome {
                    ImportOutcome::Created => Ok(thread_id),
                    ImportOutcome::Existing { .. } => Err("Already imported.".to_owned()),
                })
            }
            None => Err(format!(
                "{} is unavailable on the server. Check Settings → Providers.",
                provider_label(session.provider)
            )),
        };
        match outcome {
            Ok(thread_id) => imported.push(Imported {
                session_id: session.session_id,
                thread_id,
            }),
            Err(reason) => skipped.push(Skipped {
                session_id: session.session_id,
                reason,
            }),
        }
    }
    Ok(json!({ "imported": imported, "skipped": skipped }))
}

/// The thread History acts for: `thread_id` itself, or its host when it is a chat panel.
async fn history_host(services: &Services, thread_id: &str) -> Result<ProjectionThread, Value> {
    let thread = live_thread(services, thread_id)
        .await
        .map_err(error)?
        .ok_or_else(|| error("The thread no longer exists."))?;
    let Some(host_id) = panel_host(&thread) else {
        return Ok(thread);
    };
    live_thread(services, &host_id)
        .await
        .map_err(error)?
        .ok_or_else(|| error("The thread no longer exists."))
}

/// The built-in Claude instance, the only one History lists.
async fn claude_source(services: &Services) -> Result<ResolvedSource, Value> {
    resolve_sources(&services.settings_root)
        .await
        .into_iter()
        .find(|resolved| resolved.source.provider == AgentSessionProvider::ClaudeAgent)
        .ok_or_else(|| error(CLAUDE_TURNED_OFF))
}

/// Whether the Claude Code the server last published honors `--session-id` with
/// `--fork-session`; an unknown version does not.
async fn copy_supported(services: &Services) -> bool {
    services
        .inventory
        .read()
        .await
        .iter()
        .find(|snapshot| snapshot["instanceId"].as_str() == Some(CLAUDE_INSTANCE))
        .and_then(|snapshot| snapshot["version"].as_str())
        .is_some_and(|version| {
            claude::model::supports(
                claude::model::semantic_version(version),
                COPY_MINIMUM_CLAUDE_VERSION,
            )
        })
}

async fn resume_refused(services: &Services, thread_id: &str) -> Result<bool, Value> {
    Ok(services
        .orchestration
        .repositories()
        .get_provider_session_runtime(thread_id.to_owned())
        .await
        .map_err(|_| error("BiBCode could not read its provider sessions. Try again."))?
        .and_then(|runtime| runtime.runtime_payload)
        .is_some_and(|payload| payload["resumeRefused"] == Value::Bool(true)))
}

async fn list_for_thread(
    services: &Services,
    request: RpcRequest,
    cancellation: &CancellationToken,
) -> RpcResult {
    let input = decode::<ThreadListInput>(request)?;
    let host = history_host(services, &input.thread_id).await?;
    let project = live_project(services, &host.project_id).await?;
    let folder = SessionFolder::new(Path::new(&host_folder(&host, &project)));
    let source = claude_source(services).await?;
    let owned = sessions_owned_by_other_threads(services).await?;
    let copy_supported = copy_supported(services).await;
    // An interrupted RPC drops this future, so the blocking listing watches the token itself.
    let listing_cancellation = cancellation.clone();
    let home = source.source.home.clone();
    let listing = tokio::task::spawn_blocking(move || {
        agent_sessions::list_terminal_sessions(
            &home,
            &folder,
            SystemTime::now(),
            &owned,
            ListingBudget::default(),
            &listing_cancellation,
        )
    })
    .await
    .map_err(|_| error("The Claude Code session listing stopped unexpectedly. Try again."))?;
    tracing::debug!(
        sessions = listing.sessions.len(),
        opened = listing.opened,
        bytes_read = listing.bytes_read,
        truncated = listing.truncated,
        "listed Claude Code terminal sessions for History"
    );
    let threads = services
        .orchestration
        .repositories()
        .list_threads_by_project(project.project_id.clone())
        .await
        .map_err(|_| error("The project's threads could not be read. Try again."))?
        .into_iter()
        .map(|thread| (thread.thread_id.clone(), thread))
        .collect::<HashMap<_, _>>();
    let repositories = services.orchestration.repositories();
    let mut sessions = Vec::with_capacity(listing.sessions.len());
    for session in listing.sessions {
        let import_id = thread_id(source.instance_id, &session.session_id);
        let (imported_thread, import_deleted) = match threads.get(&import_id) {
            None => (None, false),
            Some(thread) if thread.deleted_at.is_some() => (None, true),
            // An interrupted import offers Continue, which finishes it.
            Some(thread) => {
                let completed = history_imported(&repositories, &import_id)
                    .await
                    .map_err(|_| error("The project's threads could not be read. Try again."))?;
                let imported = if completed {
                    Some(ImportedThread {
                        thread_id: import_id.clone(),
                        host_thread_id: panel_host(thread),
                        archived: thread.archived_at.is_some(),
                        resume_refused: resume_refused(services, &import_id).await?,
                    })
                } else {
                    None
                };
                (imported, false)
            }
        };
        sessions.push(HistoryEntry {
            session_id: session.session_id,
            title: session.title,
            last_active_at: session.last_active_at,
            branch: session.branch,
            liveness: session.liveness.as_str(),
            imported_thread,
            import_deleted,
        });
    }
    Ok(json!({
        "sessions": sessions,
        "truncated": listing.truncated,
        "copySupported": copy_supported,
    }))
}

async fn open_in_panel(
    services: &Services,
    request: RpcRequest,
    cancellation: &CancellationToken,
) -> RpcResult {
    let input = decode::<OpenInPanelInput>(request)?;
    if !agent_sessions::is_resumable(AgentSessionProvider::ClaudeAgent, &input.session_id) {
        return Err(error(agent_sessions::LoadFailure::NotResumable.reason()));
    }
    let host = live_thread(services, &input.host_thread_id)
        .await
        .map_err(error)?
        .filter(|host| host.kind != "panel")
        .ok_or_else(|| error(THREAD_DELETED))?;
    let project = live_project(services, &host.project_id).await?;
    let folder_path = host_folder(&host, &project);
    let source = claude_source(services).await?;
    let fork_id = match input.mode {
        OpenMode::Resume => None,
        OpenMode::Fork if !copy_supported(services).await => return Err(error(COPY_NEEDS_UPDATE)),
        OpenMode::Fork => Some(fork_session_id(&input.command_id, &input.session_id)),
    };
    let owned = sessions_owned_by_other_threads(services).await?;
    if owned.contains(&input.session_id) {
        return Err(error(OWNED_BY_A_THREAD));
    }
    let thread_id = match &fork_id {
        Some(fork_id) => copy_thread_id(source.instance_id, fork_id),
        None => thread_id(source.instance_id, &input.session_id),
    };
    let settings = ProviderSettingsStore::new(&services.settings_root)
        .get_document()
        .await
        .unwrap_or(Value::Null);
    let workspace_root = canonical_workspace_root(&project);
    let folder = SessionFolder::new(Path::new(&folder_path));
    let outcome = import_session(
        services,
        &ImportRequest {
            project: &project,
            folder: &folder,
            workspace_root: &workspace_root,
            resolved: &source,
            session_id: &input.session_id,
            thread_id: &thread_id,
            target: ImportTarget::Panel(PanelTarget {
                host: &host,
                folder: &folder_path,
                fork_id: fork_id.as_deref(),
            }),
            settings: &settings,
        },
        cancellation,
    )
    .await
    .map_err(|reason| {
        tracing::debug!(
            session_id = %input.session_id,
            fork = fork_id.is_some(),
            "a Claude Code session did not open in a panel"
        );
        error(reason)
    })?;
    let (outcome, host_thread_id) = match outcome {
        ImportOutcome::Created => ("created", Some(host.thread_id)),
        ImportOutcome::Existing { host_thread_id } => ("existing", host_thread_id),
    };
    Ok(json!({ "threadId": thread_id, "hostThreadId": host_thread_id, "outcome": outcome }))
}

fn provider_label(provider: AgentSessionProvider) -> &'static str {
    match provider {
        AgentSessionProvider::ClaudeAgent => "Claude Code",
        AgentSessionProvider::Codex => "Codex",
    }
}

/// Where an imported session lands.
#[derive(Clone, Copy)]
enum ImportTarget<'a> {
    /// A sidebar thread of the project in `full-access`, as the Import dialog creates.
    Sidebar,
    /// A chat panel of a History host, in the host's runtime mode.
    Panel(PanelTarget<'a>),
}

#[derive(Clone, Copy)]
struct PanelTarget<'a> {
    host: &'a ProjectionThread,
    /// The folder History resolved for the host; the panel is created only in that folder.
    folder: &'a str,
    /// The copy's session ID for **Continue in a copy**.
    fork_id: Option<&'a str>,
}

struct ImportRequest<'a> {
    project: &'a ProjectionProject,
    folder: &'a SessionFolder,
    /// The canonical workspace root a Codex runtime row records.
    workspace_root: &'a Path,
    resolved: &'a ResolvedSource,
    session_id: &'a str,
    thread_id: &'a str,
    target: ImportTarget<'a>,
    settings: &'a Value,
}

enum ImportOutcome {
    Created,
    /// The import had already finished, or the thread is another host's panel or a sidebar
    /// thread whose import this call finished; `host_thread_id` is its host when it is a panel.
    Existing {
        host_thread_id: Option<String>,
    },
}

/// The host of a panel thread.
fn panel_host(thread: &ProjectionThread) -> Option<String> {
    (thread.kind == "panel")
        .then(|| thread.host_thread_id.clone())
        .flatten()
}

fn thread_was_used(thread: &ProjectionThread) -> bool {
    thread.latest_turn_id.is_some() || thread.latest_user_message_at.is_some()
}

/// Creates the thread, records the CLI session as its suspended runtime, then appends the
/// history. Deterministic command IDs make a retry after a partial failure replay the steps
/// that already committed; the accepted history command marks the import complete. A panel is
/// created under its project's mutation lock, in the folder History resolved, and the engine
/// refuses it once its host is deleted.
async fn import_session(
    services: &Services,
    request: &ImportRequest<'_>,
    cancellation: &CancellationToken,
) -> Result<ImportOutcome, String> {
    let thread_id = request.thread_id;
    let history_command_id = format!("{thread_id}:history");
    let repositories = services.orchestration.repositories();
    let unreadable = |_| "BiBCode could not read its threads. Try again.".to_owned();
    let existing = repositories
        .get_thread(thread_id.to_owned())
        .await
        .map_err(unreadable)?;
    if let Some(thread) = &existing {
        if thread.deleted_at.is_some() {
            return Err(match request.target {
                ImportTarget::Sidebar => {
                    "This session was imported before and its thread was deleted."
                }
                ImportTarget::Panel(PanelTarget { fork_id: None, .. }) => SESSION_CHAT_DELETED,
                ImportTarget::Panel(_) => COPY_CHAT_DELETED,
            }
            .to_owned());
        }
        if thread.project_id != request.project.project_id {
            return Err("This session was already imported into another project.".to_owned());
        }
    }
    if repositories
        .get_command_receipt(history_command_id.clone())
        .await
        .map_err(unreadable)?
        .is_some_and(|receipt| receipt.status == "accepted")
    {
        return Ok(ImportOutcome::Existing {
            host_thread_id: existing.as_ref().and_then(panel_host),
        });
    }
    if existing.as_ref().is_some_and(thread_was_used) {
        return Err(USED_BEFORE_IMPORT.to_owned());
    }

    let source = request.resolved.source.clone();
    let requested = request.session_id.to_owned();
    let folder = request.folder.clone();
    let check_liveness = matches!(
        request.target,
        ImportTarget::Panel(PanelTarget { fork_id: None, .. })
    );
    let (session, liveness) = tokio::task::spawn_blocking(move || {
        let session = agent_sessions::load(&source, &requested, &folder, SystemTime::now())?;
        let liveness =
            check_liveness.then(|| agent_sessions::session_liveness(&source.home, &requested));
        Ok::<_, agent_sessions::LoadFailure>((session, liveness))
    })
    .await
    .map_err(|_| "The session transcript could not be read.".to_owned())?
    .map_err(|failure| failure.reason().to_owned())?;
    if let ImportTarget::Panel(_) = request.target {
        if !agent_sessions::is_terminal_entrypoint(session.entrypoint.as_deref()) {
            return Err(NOT_A_TERMINAL_SESSION.to_owned());
        }
        // Resuming a session a terminal still has open would make BiBCode a second writer.
        if liveness.is_some_and(|liveness| liveness != Liveness::Closed) {
            return Err(OPEN_IN_A_TERMINAL.to_owned());
        }
        if let Some(gate) = &services.loaded_gate {
            gate.pass().await;
        }
    }

    let model_selection = import_model_selection(
        request.resolved.source.provider,
        request.resolved.instance_id,
        session.model.as_deref(),
        request.settings,
        request.project.default_model_selection.as_ref(),
    );
    let (resume_cursor, runtime_payload) = suspended_cursor(
        request.resolved.source.provider,
        &session.session_id,
        match request.target {
            ImportTarget::Panel(panel) => panel.fork_id,
            ImportTarget::Sidebar => None,
        },
        &model_selection,
        request.workspace_root,
    );
    let finish = |runtime_mode: String, session: ParsedSession| {
        let resume_cursor = resume_cursor.clone();
        let runtime_payload = runtime_payload.clone();
        let history_command_id = history_command_id.clone();
        async move {
            write_suspended_runtime(
                services,
                thread_id,
                request.resolved,
                SuspendedRuntime {
                    resume_cursor,
                    runtime_payload,
                    runtime_mode,
                },
            )
            .await?;
            dispatch(
                services,
                OrchestrationCommand::ThreadHistoryImport {
                    command_id: history_command_id,
                    thread_id: thread_id.to_owned(),
                    messages: imported_messages(thread_id, session),
                },
                thread_id,
                cancellation,
            )
            .await
        }
    };
    // An interrupted import already created its thread; finish linking and history.
    if let Some(thread) = existing {
        finish(thread.runtime_mode.clone(), session).await?;
        return Ok(match request.target {
            ImportTarget::Panel(panel)
                if panel_host(&thread).as_deref() != Some(panel.host.thread_id.as_str()) =>
            {
                ImportOutcome::Existing {
                    host_thread_id: panel_host(&thread),
                }
            }
            _ => ImportOutcome::Created,
        });
    }
    let created_at = session
        .messages
        .first()
        .map(|message| message.created_at.clone())
        .unwrap_or_default();
    let create = |kind: Option<String>,
                  host: Option<&ProjectionThread>,
                  title: String,
                  runtime_mode: String| OrchestrationCommand::ThreadCreate {
        command_id: format!("{thread_id}:create"),
        thread_id: thread_id.to_owned(),
        project_id: request.project.project_id.clone(),
        title,
        kind,
        host_thread_id: host.map(|host| host.thread_id.clone()),
        model_selection: model_selection.clone(),
        runtime_mode,
        interaction_mode: IMPORTED_INTERACTION_MODE.to_owned(),
        branch: host.and_then(|host| host.branch.clone()),
        worktree_path: host.and_then(|host| host.worktree_path.clone()),
        created_at: created_at.clone(),
    };
    let ImportTarget::Panel(panel) = request.target else {
        dispatch(
            services,
            create(
                None,
                None,
                session.title.clone(),
                IMPORTED_RUNTIME_MODE.to_owned(),
            ),
            thread_id,
            cancellation,
        )
        .await?;
        finish(IMPORTED_RUNTIME_MODE.to_owned(), session).await?;
        return Ok(ImportOutcome::Created);
    };
    let project_id = request.project.project_id.clone();
    services
        .catalog
        .with_project_mutation_lock_cancellation(&project_id, cancellation, || async {
            // The catalog changes a worktree under this lock, so the folder is still the one
            // History listed. A generic delete takes no lock; the engine orders that one.
            let host = live_thread(services, &panel.host.thread_id)
                .await?
                .filter(|host| host.project_id == project_id)
                .ok_or_else(|| THREAD_DELETED.to_owned())?;
            let project = live_project(services, &project_id)
                .await
                .map_err(|_| THREAD_DELETED.to_owned())?;
            if host_folder(&host, &project) != panel.folder {
                return Err(FOLDER_CHANGED.to_owned());
            }
            let title = if panel.fork_id.is_some() {
                format!("{} (copy)", session.title)
            } else {
                session.title.clone()
            };
            let created = dispatch(
                services,
                create(
                    Some("panel".to_owned()),
                    Some(&host),
                    title,
                    host.runtime_mode.clone(),
                ),
                thread_id,
                cancellation,
            )
            .await;
            if let Err(reason) = created {
                // The host was deleted after the check above: the engine refused its panel.
                return Err(
                    if live_thread(services, &host.thread_id)
                        .await
                        .is_ok_and(|host| host.is_none())
                    {
                        THREAD_DELETED.to_owned()
                    } else {
                        reason
                    },
                );
            }
            finish(host.runtime_mode.clone(), session).await?;
            Ok(ImportOutcome::Created)
        })
        .await
        .unwrap_or_else(|| Err("The import was cancelled.".to_owned()))
}

/// The thread row for `thread_id` unless it was deleted.
async fn live_thread(
    services: &Services,
    thread_id: &str,
) -> Result<Option<ProjectionThread>, String> {
    services
        .orchestration
        .repositories()
        .get_thread(thread_id.to_owned())
        .await
        .map(|thread| thread.filter(|thread| thread.deleted_at.is_none()))
        .map_err(|_| "BiBCode could not read its threads. Try again.".to_owned())
}

/// The folder a host thread works in: its worktree, else its project's workspace root.
fn host_folder(host: &ProjectionThread, project: &ProjectionProject) -> String {
    host.worktree_path
        .clone()
        .unwrap_or_else(|| project.workspace_root.clone())
}

/// The digest binds a step to its thread, so a retry replays it whatever the transcript now
/// says, while a different command reusing the ID conflicts.
async fn dispatch(
    services: &Services,
    command: OrchestrationCommand,
    thread_id: &str,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let command_id = command.command_id().to_owned();
    let payload_digest = canonical_command_digest(&json!({
        "type": command.command_type(),
        "threadId": thread_id,
    }))?;
    let claim = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err("The import was cancelled.".to_owned()),
        claim = services.orchestration.acquire_command_admission(&command_id) => {
            claim.map_err(|failure| failure.to_string())?
        }
    };
    services
        .orchestration
        .dispatch_with_admission_and_command_claim_until_handoff(
            command,
            CommandAdmission {
                payload_digest,
                attachment_refs: Vec::new(),
                provider_turn: None,
            },
            claim,
            cancellation,
        )
        .await
        .map(|_| ())
        .map_err(|failure| match failure {
            // Invariant details explain themselves; the wrapper names internal command types.
            crate::orchestration::OrchestrationError::Invariant { detail, .. } => detail,
            failure => failure.to_string(),
        })
}

/// The cursor and payload a suspended session of this provider leaves, so the thread's next turn
/// resumes the CLI conversation. A copy's cursor names the copy and the session it forks, which
/// the launch reads to fork before the copy's transcript exists.
fn suspended_cursor(
    provider: AgentSessionProvider,
    session_id: &str,
    fork_id: Option<&str>,
    model_selection: &Value,
    workspace_root: &Path,
) -> (Value, Value) {
    match provider {
        // Only `sessionId`: the launch reads `threadId` first.
        AgentSessionProvider::ClaudeAgent => (
            match fork_id {
                Some(fork_id) => json!({ "sessionId": fork_id, "forkedFrom": session_id }),
                None => json!({ "sessionId": session_id }),
            },
            json!({ "transport": "stream-json" }),
        ),
        AgentSessionProvider::Codex => (
            json!({ "threadId": session_id }),
            json!({ "model": model_selection["model"], "cwd": workspace_root }),
        ),
    }
}

struct SuspendedRuntime {
    resume_cursor: Value,
    runtime_payload: Value,
    /// The thread's own mode: `full-access` for a sidebar import, the host's for a panel.
    runtime_mode: String,
}

/// The row a suspended session of this provider leaves, with the CLI session as its cursor,
/// so the thread's next turn resumes the CLI conversation.
async fn write_suspended_runtime(
    services: &Services,
    thread_id: &str,
    resolved: &ResolvedSource,
    runtime: SuspendedRuntime,
) -> Result<(), String> {
    let provider = resolved.source.provider.kind();
    let SuspendedRuntime {
        resume_cursor,
        runtime_payload,
        runtime_mode,
    } = runtime;
    let repositories = services.orchestration.repositories();
    const UNLINKED: &str = "The session could not be linked to its thread. Try again.";
    let unlinked = |_| UNLINKED.to_owned();
    let written = repositories
        .insert_provider_session_runtime_if_absent_for_live_thread(ProviderSessionRuntime {
            thread_id: thread_id.to_owned(),
            provider_name: provider.to_owned(),
            provider_instance_id: Some(resolved.instance_id.to_owned()),
            adapter_key: native_adapter_key(provider).to_owned(),
            runtime_mode,
            status: "suspended".to_owned(),
            last_seen_at: super::control::now_iso(),
            resume_cursor: Some(resume_cursor.clone()),
            runtime_payload: Some(runtime_payload),
        })
        .await
        .map_err(unlinked)?;
    if written {
        return Ok(());
    }
    // A row from an earlier attempt of this import is kept; any other belongs to a
    // conversation the thread started itself.
    let current = repositories
        .get_provider_session_runtime(thread_id.to_owned())
        .await
        .map_err(unlinked)?;
    match current {
        Some(row)
            if row.resume_cursor.as_ref() == Some(&resume_cursor)
                && row.provider_instance_id.as_deref() == Some(resolved.instance_id) =>
        {
            Ok(())
        }
        Some(_) => Err(USED_BEFORE_IMPORT.to_owned()),
        None => {
            // A turn another client admitted during the import may not have launched yet.
            let used = repositories
                .get_thread(thread_id.to_owned())
                .await
                .map_err(unlinked)?
                .is_some_and(|thread| thread_was_used(&thread));
            Err(if used { USED_BEFORE_IMPORT } else { UNLINKED }.to_owned())
        }
    }
}

fn imported_messages(thread_id: &str, session: ParsedSession) -> Vec<ImportedThreadMessage> {
    debug_assert!(session.messages.len() <= MAX_IMPORTED_THREAD_MESSAGES);
    session
        .messages
        .into_iter()
        .enumerate()
        .map(|(index, message)| ImportedThreadMessage {
            message_id: format!("{thread_id}:{index:06}"),
            role: message.role.to_owned(),
            text: message.text,
            created_at: message.created_at,
        })
        .collect()
}

/// The transcript's model when the instance offers it, else the project's default for this
/// instance, the driver's session default, or the built-in default.
fn import_model_selection(
    provider: AgentSessionProvider,
    instance_id: &str,
    transcript_model: Option<&str>,
    settings: &Value,
    project_default: Option<&Value>,
) -> Value {
    let transcript_model = transcript_model.and_then(|model| match provider {
        // Codex reports the model it ran, which it accepts again.
        AgentSessionProvider::Codex => Some(model.to_owned()),
        AgentSessionProvider::ClaudeAgent => {
            known_claude_model(model, &instance_custom_models(settings, instance_id))
        }
    });
    let model = transcript_model
        .or_else(|| {
            project_default
                .filter(|selection| selection["instanceId"] == instance_id)
                .and_then(|selection| selection["model"].as_str())
                .map(str::to_owned)
        })
        .or_else(|| {
            settings["providerSessionDefaults"][provider.kind()]["model"]
                .as_str()
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            match provider {
                AgentSessionProvider::ClaudeAgent => CLAUDE_DEFAULT_MODEL,
                AgentSessionProvider::Codex => CODEX_DEFAULT_MODEL,
            }
            .to_owned()
        });
    json!({ "instanceId": instance_id, "model": model })
}

/// Claude records dated API IDs (`claude-opus-4-5-20251101`); the catalog lists undated slugs.
fn known_claude_model(model: &str, custom_models: &[String]) -> Option<String> {
    let undated = model
        .rsplit_once('-')
        .filter(|(_, date)| date.len() == 8 && date.bytes().all(|byte| byte.is_ascii_digit()))
        .map(|(slug, _)| slug);
    let catalog = claude::model::all_models(custom_models);
    [Some(model), undated]
        .into_iter()
        .flatten()
        .find(|candidate| {
            catalog
                .iter()
                .any(|entry| entry["slug"].as_str() == Some(candidate))
        })
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        orchestration::EngineOptions,
        persistence::{Database, run_migrations},
        production::provider_runtime::launch_request_for_command,
    };

    fn test_services(engine: &OrchestrationEngine, settings_root: &Path) -> Services {
        Services {
            orchestration: engine.clone(),
            settings_root: settings_root.to_path_buf(),
            catalog: WorktreeCatalogService::new(
                std::sync::Arc::new(engine.repositories()),
                std::sync::Arc::new(crate::git::GitRepository::default()),
            ),
            inventory: PublishedProviderInventory::default(),
            loaded_gate: None,
        }
    }

    /// A copy's session ID is a UUID v4 that Claude resumes, the same for a retry of one command
    /// and new for every other command.
    #[test]
    fn a_copy_takes_a_resumable_id_derived_from_its_command() {
        let source = "0f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
        let fork = fork_session_id("command-1", source);
        assert!(agent_sessions::is_resumable(
            AgentSessionProvider::ClaudeAgent,
            &fork
        ));
        assert_eq!(uuid::Uuid::parse_str(&fork).unwrap().get_version_num(), 4);
        assert_eq!(fork, fork_session_id("command-1", source));
        assert_ne!(fork, fork_session_id("command-2", source));
        assert_ne!(fork, source);
        assert!(!is_import_of(&copy_thread_id("claudeAgent", &fork), &fork));
    }

    /// The row an import writes is the one the next turn's launch resumes from.
    #[tokio::test]
    async fn the_next_turn_resumes_the_imported_cli_session() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::open_in_memory().await.unwrap();
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let engine = OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .unwrap();
        let services = test_services(&engine, temp.path());
        engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"project.create","commandId":"project","projectId":"p",
                    "title":"P","workspaceRoot":temp.path(),"createdAt":"2026-10-01T00:00:00Z"
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        for (provider, instance_id, session_id, cursor) in [
            (
                AgentSessionProvider::ClaudeAgent,
                "claudeAgent",
                "0f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40",
                "sessionId",
            ),
            (
                AgentSessionProvider::Codex,
                "codex",
                "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
                "threadId",
            ),
        ] {
            let thread_id = thread_id(instance_id, session_id);
            let selection = import_model_selection(provider, instance_id, None, &Value::Null, None);
            engine
                .dispatch(OrchestrationCommand::ThreadCreate {
                    command_id: format!("{thread_id}:create"),
                    thread_id: thread_id.clone(),
                    project_id: "p".to_owned(),
                    title: "Imported".to_owned(),
                    kind: None,
                    host_thread_id: None,
                    model_selection: selection.clone(),
                    runtime_mode: IMPORTED_RUNTIME_MODE.to_owned(),
                    interaction_mode: IMPORTED_INTERACTION_MODE.to_owned(),
                    branch: None,
                    worktree_path: None,
                    created_at: "2026-10-01T00:00:00Z".to_owned(),
                })
                .await
                .unwrap();
            let resolved = ResolvedSource {
                source: SessionSource {
                    provider,
                    home: temp.path().to_path_buf(),
                },
                instance_id,
            };
            let (resume_cursor, runtime_payload) =
                suspended_cursor(provider, session_id, None, &selection, temp.path());
            write_suspended_runtime(
                &services,
                &thread_id,
                &resolved,
                SuspendedRuntime {
                    resume_cursor,
                    runtime_payload,
                    runtime_mode: IMPORTED_RUNTIME_MODE.to_owned(),
                },
            )
            .await
            .unwrap();
            let turn = serde_json::from_value(json!({
                "type":"thread.turn.start","commandId":format!("{thread_id}:turn"),
                "threadId":thread_id,
                "message":{"messageId":"m","role":"user","text":"continue","attachments":[]},
                "createdAt":"2026-10-02T00:00:00Z"
            }))
            .unwrap();
            let launch = launch_request_for_command(&engine, &services.settings_root, &turn, None)
                .await
                .unwrap();
            assert_eq!(launch.provider, provider.kind());
            assert_eq!(launch.resume_cursor, Some(json!({ cursor: session_id })));
        }
        engine.shutdown().await;
    }

    /// Without `homePath` or `CODEX_HOME`, Codex keeps its sessions under the HOME its instance
    /// sets, not the server's.
    #[tokio::test]
    async fn codex_sessions_are_scanned_in_the_instance_home() {
        if std::env::var_os("CODEX_HOME").is_some() {
            // The server's CODEX_HOME decides for the instance too.
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("instance-home");
        std::fs::write(
            temp.path().join("settings.json"),
            json!({"providerInstances":{"codex":{
                "driver":"codex","environment":[{"name":"HOME","value":home}]
            }}})
            .to_string(),
        )
        .unwrap();
        let sources = resolve_sources(&temp.path().to_path_buf()).await;
        let codex = sources
            .iter()
            .find(|resolved| resolved.source.provider == AgentSessionProvider::Codex)
            .expect("codex source");
        assert_eq!(codex.source.home, home.join(".codex"));
    }

    /// A turn another client admitted while the transcript was read keeps its own conversation.
    #[tokio::test]
    async fn linking_refuses_a_thread_that_started_its_own_turn() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::open_in_memory().await.unwrap();
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let engine = OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .unwrap();
        let services = test_services(&engine, temp.path());
        let session_id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
        let thread_id = thread_id("codex", session_id);
        let selection = import_model_selection(
            AgentSessionProvider::Codex,
            "codex",
            None,
            &Value::Null,
            None,
        );
        for value in [
            json!({"type":"project.create","commandId":"project","projectId":"p","title":"P","workspaceRoot":temp.path(),"createdAt":"2026-10-01T00:00:00Z"}),
            json!({"type":"thread.create","commandId":format!("{thread_id}:create"),"threadId":thread_id,"projectId":"p","title":"Imported","modelSelection":selection,"runtimeMode":IMPORTED_RUNTIME_MODE,"createdAt":"2026-10-01T00:00:00Z"}),
            json!({"type":"thread.turn.start","commandId":"other-client-turn","threadId":thread_id,"message":{"messageId":"m","role":"user","text":"hello","attachments":[]},"createdAt":"2026-10-02T00:00:00Z"}),
        ] {
            engine
                .dispatch(serde_json::from_value(value).unwrap())
                .await
                .unwrap();
        }
        let resolved = ResolvedSource {
            source: SessionSource {
                provider: AgentSessionProvider::Codex,
                home: temp.path().to_path_buf(),
            },
            instance_id: "codex",
        };
        let (resume_cursor, runtime_payload) = suspended_cursor(
            AgentSessionProvider::Codex,
            session_id,
            None,
            &selection,
            temp.path(),
        );
        assert_eq!(
            write_suspended_runtime(
                &services,
                &thread_id,
                &resolved,
                SuspendedRuntime {
                    resume_cursor,
                    runtime_payload,
                    runtime_mode: IMPORTED_RUNTIME_MODE.to_owned(),
                },
            )
            .await,
            Err(USED_BEFORE_IMPORT.to_owned())
        );
        assert!(
            engine
                .repositories()
                .get_provider_session_runtime(thread_id)
                .await
                .unwrap()
                .is_none()
        );
        engine.shutdown().await;
    }

    #[test]
    fn imported_threads_keep_a_model_the_instance_offers() {
        let settings = json!({
            "providerSessionDefaults": { "claudeAgent": { "model": "claude-opus-4-8" } },
            "providerInstances": {
                "claudeAgent": { "driver": "claudeAgent", "config": { "customModels": ["house-model"] } }
            }
        });
        let select = |model: Option<&str>, project: Option<&Value>| {
            import_model_selection(
                AgentSessionProvider::ClaudeAgent,
                "claudeAgent",
                model,
                &settings,
                project,
            )["model"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(
            select(Some("claude-opus-4-5-20251101"), None),
            "claude-opus-4-5"
        );
        assert_eq!(select(Some("house-model"), None), "house-model");
        assert_eq!(select(Some("retired-model"), None), "claude-opus-4-8");
        let project = json!({ "instanceId": "claudeAgent", "model": "claude-haiku-4-5" });
        assert_eq!(select(None, Some(&project)), "claude-haiku-4-5");
        let other = json!({ "instanceId": "codex", "model": "gpt-5.4" });
        assert_eq!(select(None, Some(&other)), "claude-opus-4-8");
        assert_eq!(
            import_model_selection(
                AgentSessionProvider::Codex,
                "codex",
                None,
                &Value::Null,
                None
            ),
            json!({ "instanceId": "codex", "model": CODEX_DEFAULT_MODEL })
        );
    }
}
