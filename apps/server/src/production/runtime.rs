use std::{
    collections::HashSet,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use axum::http::StatusCode;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

use crate::{
    ServerConfig,
    activity::{
        ActivityCancellationService, ActivityProjections, ActivityRepository,
        AgentActivityController, AgentActivitySource, register_activity_rpc,
    },
    assets::{AssetAccess, ResolvedAsset},
    auth::AuthService,
    crypto::sha256_hex,
    diagnostic_bundle::DiagnosticBundleService,
    diagnostics::{
        DesktopUiProcessObserver, DiagnosticsMonitor, NativeProcessSampler, NativeResourceSampler,
        ProcessAttributionRegistry, TraceDiagnosticsStore, bound_diagnostic_string,
    },
    git::GitRepository,
    mcp::preview_automation::PreviewAutomationBroker,
    orchestration::{EngineOptions, OrchestrationCommand, OrchestrationEngine, load_snapshot},
    persistence::{Database, Repositories, StatePaths},
    preview::PreviewManager,
    process::configure_background_command,
    production::{
        agent_activity::ProductionAgentActivity,
        connect_mcp::ConnectMcpService,
        control::{NativeServerControl, ProviderUpdateCheckTask},
        git_vcs::{GitVcsRpcServices, WorktreeRemovalTaskTracker, register_git_vcs_rpc},
        http_routes::{
            AssetHttpResponse, DiagnosticLogsHttpResponse, HttpRouteError, JsonOperation,
            JsonRouteResponse, RouteContext,
        },
        operational_logs::{OperationalLogOptions, OperationalLogs},
        orchestration_effects::{
            BoxEffectFuture, EffectsOptions, OrchestrationEffectCallbacks, OrchestrationEffects,
            SetupScriptLaunch, process_compatible_path,
        },
        orchestration_rpc::register_orchestration_rpc_with_delivery,
        provider_runtime::{
            NativeProviderDriverFactory, ProviderRuntimeSupervisor, SupervisorOptions,
            reconcile_abandoned_provider_sessions,
        },
        relay::relay_client_service,
        server_terminal::{
            ProcessTreeCleanup, ServerTerminalServices, register_server_terminal_rpc,
        },
        turn_delivery::TurnDeliveryService,
        workspace_preview::{WorkspacePreviewRpcServices, register_workspace_preview_rpc},
    },
    provider::attachments::{AttachmentMaterializer, MAX_ATTACHMENT_BYTES},
    provider_terminal::{
        ClaudeTerminalObserverFactory, CodexTerminalObserverFactory,
        OpenCodeTerminalObserverFactory, ProviderSettingsInventoryAuthority,
        ProviderTerminalActivitySupervisor, ProviderTerminalObserverFactories,
    },
    provider_usage::{ProviderUsageService, production_fetchers},
    review::{
        ReviewBackend, ReviewDiffPreviewInput, ReviewDiffPreviewResult, ReviewError, ReviewService,
        ReviewSource,
    },
    rpc::RpcRegistry,
    server_settings::ProviderSettingsStore,
    terminal::{PortablePtyBackend, TerminalManager, TerminalManagerOptions},
    workspace::{AssetContextResolver, WorkspaceRpc, WorkspaceRpcDependencies, WorkspaceService},
};

pub struct ProductionRuntime {
    pub registry: RpcRegistry,
    pub orchestration: OrchestrationEngine,
    pub activity_projections: ActivityProjections,
    pub preview_automation: PreviewAutomationBroker,
    asset_access: AssetAccess,
    terminal_services: ServerTerminalServices,
    provider_runtime: Arc<ProviderRuntimeSupervisor>,
    turn_delivery: Arc<TurnDeliveryService>,
    operational_logs: OperationalLogs,
    provider_update_checks: ProviderUpdateCheckTask,
    orchestration_effects: OrchestrationEffects,
    diagnostic_bundle: DiagnosticBundleService,
    worktree_removal_tasks: WorktreeRemovalTaskTracker,
    _resource_sampler: Arc<NativeResourceSampler>,
    update_quiesced: tokio::sync::Mutex<bool>,
}

pub fn finalize_rpc_registry(
    registry: &RpcRegistry,
    control: &NativeServerControl,
) -> Result<(), String> {
    registry.validate_complete()?;
    control.mark_activity_protocol_registered_after_validation();
    Ok(())
}

impl ProductionRuntime {
    pub async fn attach_connect_mcp(&self, service: Arc<ConnectMcpService>) {
        self.provider_runtime.attach_connect_mcp(service).await;
    }

    pub async fn start(
        config: &ServerConfig,
        database: Database,
        auth: AuthService,
        asset_secret: Vec<u8>,
        ui_process_observer: Arc<dyn DesktopUiProcessObserver>,
    ) -> Result<Self, String> {
        Self::start_with_process_tree_cleanup(
            config,
            database,
            auth,
            asset_secret,
            ui_process_observer,
            ProcessTreeCleanup::StandaloneServer,
        )
        .await
    }

    pub(crate) async fn start_with_process_tree_cleanup(
        config: &ServerConfig,
        database: Database,
        auth: AuthService,
        asset_secret: Vec<u8>,
        ui_process_observer: Arc<dyn DesktopUiProcessObserver>,
        process_tree_cleanup: ProcessTreeCleanup,
    ) -> Result<Self, String> {
        let state_paths = StatePaths::from_config(config);
        let trace_diagnostics =
            TraceDiagnosticsStore::new(config.state_dir().join("logs/server.trace.ndjson"));
        let auth_descriptor =
            serde_json::to_value(auth.descriptor()).map_err(|error| error.to_string())?;
        let control = Arc::new(
            NativeServerControl::with_trace_diagnostics(
                config.clone(),
                auth_descriptor,
                trace_diagnostics.clone(),
            )
            .await,
        );
        let provider_update_checks = control.start_provider_update_checks();
        let chat_activity_controller = AgentActivityController::new(
            control
                .agent_activity_enabled(AgentActivitySource::Chat)
                .await,
        );
        let terminal_activity_controller = AgentActivityController::new(
            control
                .agent_activity_enabled(AgentActivitySource::Terminal)
                .await,
        );
        let orchestration = OrchestrationEngine::start(
            database,
            EngineOptions {
                queue_capacity: 128,
                ..EngineOptions::default()
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        let repositories = orchestration.repositories();
        let activity_projections = ActivityProjections::new(
            ActivityRepository::new(repositories.database().clone()),
            chat_activity_controller.clone(),
            terminal_activity_controller.clone(),
        );
        activity_projections
            .terminal()
            .interrupt_unresolved_terminal_scopes()
            .await
            .map_err(|error| error.to_string())?;
        reconcile_abandoned_provider_sessions(&orchestration)
            .await
            .map_err(|error| error.to_string())?;
        let referenced_attachment_ids = repositories
            .list_referenced_attachment_ids()
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .collect::<HashSet<_>>();
        AttachmentMaterializer::new(state_paths.attachments_dir.clone())
            .reconcile_startup(&referenced_attachment_ids)
            .await
            .map_err(|error| error.to_string())?;
        let process_attribution = ProcessAttributionRegistry::new();
        let provider_settings = ProviderSettingsStore::new(&state_paths.state_dir);
        let provider_terminal_preparer = ProviderTerminalActivitySupervisor::new_with_authority(
            Arc::new(ProviderSettingsInventoryAuthority::new(provider_settings)),
            terminal_activity_controller.clone(),
            activity_projections.terminal(),
            process_attribution.clone(),
            state_paths.state_dir.join("runtime/provider-terminal"),
            production_provider_terminal_observer_factories(),
        )
        .map(|supervisor| {
            Arc::new(supervisor) as Arc<dyn crate::provider_terminal::TerminalLaunchPreparer>
        })
        .map_err(|_| {
            tracing::warn!("optional provider terminal observation is unavailable");
        })
        .ok();
        let process_sampler = Arc::new(NativeProcessSampler::default());
        let resource_sampler = Arc::new(NativeResourceSampler::new(
            process_sampler.clone(),
            process_attribution.clone(),
            ui_process_observer,
        ));
        let terminal_manager = TerminalManager::with_process_attribution(
            Arc::new(PortablePtyBackend),
            TerminalManagerOptions {
                launch_preparer: provider_terminal_preparer,
                ..TerminalManagerOptions::default()
            },
            process_attribution.clone(),
        );
        let diagnostic_bundle = DiagnosticBundleService::new(&state_paths.logs_dir);
        let operational_logs = OperationalLogs::start(
            &state_paths,
            &terminal_manager,
            OperationalLogOptions::default(),
        )
        .await?;
        let provider_runtime = Arc::new(ProviderRuntimeSupervisor::start_with_operational_log(
            orchestration.clone(),
            Arc::new(
                NativeProviderDriverFactory::with_process_attribution_and_agent_activity_controller(
                    state_paths.attachments_dir.clone(),
                    process_attribution.clone(),
                    chat_activity_controller.clone(),
                ),
            ),
            activity_projections.chat(),
            SupervisorOptions::default(),
            operational_logs.provider(),
        ));
        let activity_cancellation = ActivityCancellationService::new(
            activity_projections.chat().activity_control_registry(),
            provider_runtime.clone(),
        );
        provider_runtime
            .attach_activity_cancellation(activity_cancellation.clone())
            .await;
        let asset_access = AssetAccess::new(asset_secret, state_paths.attachments_dir.clone());
        let git_repository = Arc::new(GitRepository::with_worktree_settings(control.clone()));
        let git_vcs = GitVcsRpcServices::with_production_dependencies(
            git_repository.clone(),
            terminal_manager.clone(),
            repositories.clone(),
            control.automatic_git_fetch_interval_signal(),
        );
        let worktree_removal_tasks = git_vcs.worktree_removal_tasks();
        let workspace = WorkspaceRpc::with_dependencies(
            WorkspaceService::default(),
            WorkspaceRpcDependencies {
                asset_access: Some(asset_access.clone()),
                asset_context_resolver: Some(Arc::new(ProjectionAssetContext { repositories })),
                review_service: Some(ReviewService::new(Arc::new(GitReviewBackend))),
                mutation_observer: Some(Arc::new(git_vcs.clone())),
            },
        );
        let workspace_for_effects = workspace.clone();
        let preview = PreviewManager::new();
        let preview_automation = PreviewAutomationBroker::new();
        let workspace_preview =
            WorkspacePreviewRpcServices::new(workspace, preview, preview_automation.clone());

        let process_monitor = Arc::new(DiagnosticsMonitor::new(
            resource_sampler.clone(),
            Duration::from_secs(2),
        ));
        let provider_usage =
            ProviderUsageService::new(production_fetchers(), Arc::new(OffsetDateTime::now_utc));
        let relay = relay_client_service(config.state_dir());
        let agent_activity = Arc::new(ProductionAgentActivity::new(
            activity_projections.clone(),
            provider_runtime.clone(),
            terminal_manager.clone(),
            trace_diagnostics.clone(),
            config.environment_id.clone(),
        ));
        agent_activity.record_startup(0).await;
        control.attach_agent_activity_handler(agent_activity).await;
        let terminal_services = ServerTerminalServices::new_with_process_tree_cleanup(
            terminal_manager,
            process_sampler,
            resource_sampler.clone(),
            process_monitor,
            provider_usage,
            relay,
            control.clone(),
            process_tree_cleanup,
        );
        let orchestration_effects = OrchestrationEffects::start(
            orchestration.clone(),
            git_repository.clone(),
            Arc::new(RuntimeEffectCallbacks {
                repositories: orchestration.repositories(),
                provider: provider_runtime.clone(),
                terminals: terminal_services.clone(),
                workspace: workspace_for_effects,
            }),
            EffectsOptions::default(),
        )
        .await
        .map_err(|error| error.to_string())?;
        let turn_delivery = Arc::new(TurnDeliveryService::start(
            orchestration.clone(),
            provider_runtime.clone(),
            config.state_dir(),
        ));

        let mut registry = RpcRegistry::with_trace_diagnostics(trace_diagnostics.clone());
        crate::auth::register_rpc_handlers(&mut registry, auth);
        register_activity_rpc(
            &mut registry,
            activity_projections.clone(),
            activity_cancellation,
        );
        register_orchestration_rpc_with_delivery(
            &mut registry,
            orchestration.clone(),
            provider_runtime.clone(),
            config.state_dir(),
            turn_delivery.clone(),
        );
        register_workspace_preview_rpc(&mut registry, workspace_preview);
        register_git_vcs_rpc(&mut registry, git_vcs);
        register_server_terminal_rpc(&mut registry, terminal_services.clone());
        finalize_rpc_registry(&registry, &control)?;

        Ok(Self {
            registry,
            orchestration,
            activity_projections,
            preview_automation,
            asset_access,
            terminal_services,
            provider_runtime,
            turn_delivery,
            operational_logs,
            provider_update_checks,
            orchestration_effects,
            diagnostic_bundle,
            worktree_removal_tasks,
            _resource_sampler: resource_sampler,
            update_quiesced: tokio::sync::Mutex::new(false),
        })
    }

    pub async fn json(
        &self,
        operation: JsonOperation,
        payload: Option<Value>,
        _context: RouteContext,
    ) -> Result<JsonRouteResponse, HttpRouteError> {
        match operation {
            JsonOperation::OrchestrationSnapshot => {
                let snapshot = load_snapshot(&self.orchestration.repositories())
                    .await
                    .map_err(internal_error)?;
                Ok(JsonRouteResponse::ok(
                    serde_json::to_value(snapshot).map_err(internal_error)?,
                ))
            }
            JsonOperation::OrchestrationDispatch => {
                let command: OrchestrationCommand = serde_json::from_value(
                    payload.ok_or_else(|| bad_request("Request body is required."))?,
                )
                .map_err(bad_request)?;
                if matches!(command, OrchestrationCommand::ThreadTurnStart { .. }) {
                    return Err(bad_request(
                        "thread.turn.start requires the durable orchestration RPC ingress",
                    ));
                }
                let result =
                    self.orchestration
                        .dispatch(command)
                        .await
                        .map_err(|error| match error {
                            crate::orchestration::OrchestrationError::ProjectPreparation {
                                detail,
                            } => bad_request(detail),
                            error => internal_error(error),
                        })?;
                Ok(JsonRouteResponse::ok(
                    serde_json::to_value(result).map_err(internal_error)?,
                ))
            }
            _ => Err(bad_request("Unsupported core HTTP operation.")),
        }
    }

    pub async fn asset(
        &self,
        token: String,
        path: String,
    ) -> Result<AssetHttpResponse, HttpRouteError> {
        let resolved = self
            .asset_access
            .resolve(&token, &path)
            .await
            .ok_or_else(|| {
                HttpRouteError::new(
                    StatusCode::NOT_FOUND,
                    json!({
                        "_tag": "AssetNotFoundError",
                        "message": "Asset was not found or its access token expired."
                    }),
                )
            })?;
        match resolved {
            ResolvedAsset::File(file) => {
                let file_handle = tokio::fs::File::open(&file).await.map_err(internal_error)?;
                let mut bytes = Vec::with_capacity(MAX_ATTACHMENT_BYTES.min(4096));
                file_handle
                    .take((MAX_ATTACHMENT_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(internal_error)?;
                if bytes.len() > MAX_ATTACHMENT_BYTES {
                    return Err(HttpRouteError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        json!({
                            "_tag": "AssetTooLargeError",
                            "message": "Asset exceeds the 10 MiB response limit."
                        }),
                    ));
                }
                let content_type = mime_guess::from_path(&file)
                    .first_or_octet_stream()
                    .essence_str()
                    .to_owned();
                Ok(AssetHttpResponse {
                    content_type,
                    bytes,
                    cache_control: "private, max-age=3600".to_owned(),
                })
            }
            ResolvedAsset::ProjectFaviconFallback => Ok(AssetHttpResponse {
                content_type: "image/svg+xml".to_owned(),
                bytes: FALLBACK_FAVICON.as_bytes().to_vec(),
                cache_control: "private, max-age=3600".to_owned(),
            }),
        }
    }

    pub async fn diagnostic_logs(
        &self,
        frontend_log: String,
    ) -> Result<DiagnosticLogsHttpResponse, HttpRouteError> {
        let bundle = self
            .diagnostic_bundle
            .build(frontend_log, OffsetDateTime::now_utc())
            .await
            .map_err(internal_error)?;
        Ok(DiagnosticLogsHttpResponse {
            filename: bundle.filename,
            bytes: bundle.bytes,
        })
    }

    pub async fn quiesce_for_update(&self) -> Result<(), String> {
        let mut quiesced = self.update_quiesced.lock().await;
        if *quiesced {
            return Ok(());
        }
        let mut first_error = None;
        self.worktree_removal_tasks.close_and_drain().await;
        self.provider_update_checks.shutdown().await;
        self.turn_delivery.shutdown().await;
        self.orchestration_effects.shutdown().await;
        if let Err(error) = self.provider_runtime.shutdown().await {
            let error = bound_diagnostic_string(&error.to_string(), 160);
            tracing::warn!(%error, "provider process-owner cleanup completed with failures");
            first_error = Some(error);
        }
        self.terminal_services.shutdown().await;
        if let Err(error) = self.operational_logs.shutdown().await {
            tracing::warn!(%error, "failed to shut down operational logs cleanly");
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
        self.orchestration.shutdown().await;
        *quiesced = true;
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub async fn shutdown(&self) {
        let _ = self.quiesce_for_update().await;
    }
}

#[derive(Clone)]
struct RuntimeEffectCallbacks {
    repositories: Repositories,
    provider: Arc<ProviderRuntimeSupervisor>,
    terminals: ServerTerminalServices,
    workspace: WorkspaceRpc,
}

impl OrchestrationEffectCallbacks for RuntimeEffectCallbacks {
    fn workspace_for_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async move {
            let Some(thread) = self
                .repositories
                .get_thread(thread_id.to_owned())
                .await
                .map_err(|error| error.to_string())?
            else {
                return Ok(None);
            };
            if let Some(path) = thread.worktree_path {
                return Ok(Some(process_compatible_path(PathBuf::from(path))));
            }
            Ok(self
                .repositories
                .get_project(thread.project_id)
                .await
                .map_err(|error| error.to_string())?
                .map(|project| process_compatible_path(PathBuf::from(project.workspace_root))))
        })
    }

    fn rollback_provider<'a>(&'a self, thread_id: &'a str, turns: i64) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.provider
                .handle_orchestration(OrchestrationCommand::ThreadCheckpointRevert {
                    command_id: format!("effects:provider-rollback:{}", uuid::Uuid::new_v4()),
                    thread_id: thread_id.to_owned(),
                    turn_count: turns,
                    created_at: now_iso(),
                })
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn stop_provider<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            match self
                .provider
                .handle_orchestration(OrchestrationCommand::ThreadSessionStop {
                    command_id: format!("effects:provider-stop:{}", uuid::Uuid::new_v4()),
                    thread_id: thread_id.to_owned(),
                    created_at: now_iso(),
                })
                .await
            {
                Ok(())
                | Err(
                    crate::production::provider_runtime::ProviderRuntimeError::SessionNotFound {
                        ..
                    },
                ) => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        })
    }

    fn close_terminals<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.terminals.close_thread_terminals(thread_id).await;
            Ok(())
        })
    }

    fn refresh_workspace<'a>(&'a self, cwd: &'a std::path::Path) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.workspace.refresh_index(cwd).await;
            Ok(())
        })
    }

    fn setup_script_is_running<'a>(
        &'a self,
        thread_id: &'a str,
        terminal_id: &'a str,
    ) -> BoxEffectFuture<'a, bool> {
        Box::pin(async move { Ok(self.terminals.terminal_exists(thread_id, terminal_id).await) })
    }

    fn launch_setup_script<'a>(&'a self, input: SetupScriptLaunch) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move { self.terminals.launch_setup_script(input).await })
    }
}

#[derive(Clone)]
struct ProjectionAssetContext {
    repositories: Repositories,
}

impl AssetContextResolver for ProjectionAssetContext {
    fn resolve_workspace_root<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<PathBuf>, String>> + Send + 'a>> {
        Box::pin(async move {
            let Some(thread) = self
                .repositories
                .get_thread(thread_id.to_owned())
                .await
                .map_err(|error| error.to_string())?
            else {
                return Ok(None);
            };
            if let Some(worktree) = thread.worktree_path {
                return Ok(Some(process_compatible_path(PathBuf::from(worktree))));
            }
            Ok(self
                .repositories
                .get_project(thread.project_id)
                .await
                .map_err(|error| error.to_string())?
                .map(|project| process_compatible_path(PathBuf::from(project.workspace_root))))
        })
    }
}

struct GitReviewBackend;

const MAX_UNTRACKED_REVIEW_FILES: usize = 500;
const MAX_UNTRACKED_REVIEW_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_UNTRACKED_REVIEW_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

impl ReviewBackend for GitReviewBackend {
    fn get_diff_preview<'a>(
        &'a self,
        input: &'a ReviewDiffPreviewInput,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<ReviewDiffPreviewResult>, ReviewError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let cancellation = CancellationToken::new();
            let status = GitRepository::default()
                .local_status(Path::new(&input.cwd), &cancellation)
                .await
                .map_err(|error| ReviewError::Backend(error.to_string()))?;
            if !status.is_repo {
                return Ok(Some(ReviewDiffPreviewResult {
                    cwd: input.cwd.clone(),
                    generated_at: now_millis(),
                    sources: Vec::new(),
                }));
            }

            let ignore_whitespace = input.ignore_whitespace.unwrap_or(false);
            let tracked_worktree = run_review_diff(
                &input.cwd,
                review_diff_args(ignore_whitespace, Some("HEAD"), false),
            )
            .await?;
            let untracked = untracked_review_diff(&input.cwd).await?;
            let working_tree_diff = join_review_diffs(&tracked_worktree, &untracked.diff);

            let base_ref = input.base_ref.clone().or(status.default_ref_name);
            let branch_diff = match (&base_ref, &status.ref_name) {
                (Some(base_ref), Some(_)) => {
                    let range = format!("{base_ref}...HEAD");
                    run_review_diff(
                        &input.cwd,
                        review_diff_args(ignore_whitespace, Some(&range), true),
                    )
                    .await?
                }
                _ => String::new(),
            };
            let sources = vec![
                review_source(
                    "working-tree",
                    "working-tree",
                    "Dirty worktree",
                    Some("HEAD".to_owned()),
                    None,
                    working_tree_diff,
                    untracked.truncated,
                ),
                review_source(
                    "branch-range",
                    "branch-range",
                    base_ref.as_ref().map_or_else(
                        || "Against base branch".to_owned(),
                        |base| format!("Against {base}"),
                    ),
                    base_ref,
                    Some(status.ref_name.unwrap_or_else(|| "HEAD".to_owned())),
                    branch_diff,
                    false,
                ),
            ];
            Ok(Some(ReviewDiffPreviewResult {
                cwd: input.cwd.clone(),
                generated_at: now_millis(),
                sources,
            }))
        })
    }
}

struct UntrackedReviewDiff {
    diff: String,
    truncated: bool,
}

fn review_diff_args(ignore_whitespace: bool, target: Option<&str>, three_dot: bool) -> Vec<String> {
    let mut args = vec![
        "diff".to_owned(),
        "--no-ext-diff".to_owned(),
        "--patch".to_owned(),
        "--minimal".to_owned(),
    ];
    if ignore_whitespace {
        args.push("--ignore-all-space".to_owned());
    }
    if let Some(target) = target {
        args.push(target.to_owned());
    }
    if !three_dot {
        args.push("--".to_owned());
    }
    args
}

async fn run_review_diff(cwd: &str, args: Vec<String>) -> Result<String, ReviewError> {
    let mut command = Command::new("git");
    configure_background_command(&mut command);
    let output = command
        .args(["-C", cwd])
        .args(args)
        .output()
        .await
        .map_err(|error| ReviewError::Backend(error.to_string()))?;
    Ok(if output.status.success() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        String::new()
    })
}

fn join_review_diffs(left: &str, right: &str) -> String {
    [left.trim_end(), right.trim_end()]
        .into_iter()
        .filter(|diff| !diff.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn review_source(
    id: &str,
    kind: &str,
    title: impl Into<String>,
    base_ref: Option<String>,
    head_ref: Option<String>,
    diff: String,
    truncated: bool,
) -> ReviewSource {
    let diff_hash = sha256_hex(diff.as_bytes());
    ReviewSource {
        id: id.to_owned(),
        kind: kind.to_owned(),
        title: title.into(),
        base_ref,
        head_ref,
        diff,
        diff_hash,
        truncated,
    }
}

async fn untracked_review_diff(cwd: &str) -> Result<UntrackedReviewDiff, ReviewError> {
    let mut command = Command::new("git");
    configure_background_command(&mut command);
    let output = command
        .args(["-C", cwd])
        .args([
            "-c",
            "core.quotePath=false",
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .await
        .map_err(|error| ReviewError::Backend(error.to_string()))?;
    if !output.status.success() {
        return Err(ReviewError::Backend(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }

    let root = PathBuf::from(cwd);
    let mut total_bytes = 0_u64;
    let mut diffs = Vec::new();
    let mut truncated = false;
    for path in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .take(MAX_UNTRACKED_REVIEW_FILES)
    {
        let path = String::from_utf8_lossy(path).into_owned();
        let absolute = root.join(&path);
        let metadata = tokio::fs::symlink_metadata(&absolute)
            .await
            .map_err(|error| ReviewError::Backend(error.to_string()))?;
        if !metadata.file_type().is_file() {
            continue;
        }
        if metadata.len() > MAX_UNTRACKED_REVIEW_FILE_BYTES
            || total_bytes.saturating_add(metadata.len()) > MAX_UNTRACKED_REVIEW_TOTAL_BYTES
        {
            diffs.push(binary_untracked_diff(&path));
            truncated = true;
            continue;
        }
        let contents = tokio::fs::read(&absolute)
            .await
            .map_err(|error| ReviewError::Backend(error.to_string()))?;
        total_bytes = total_bytes.saturating_add(contents.len() as u64);
        diffs.push(if contents.contains(&0) {
            binary_untracked_diff(&path)
        } else {
            text_untracked_diff(&path, &String::from_utf8_lossy(&contents))
        });
    }
    Ok(UntrackedReviewDiff {
        diff: diffs.join("\n"),
        truncated,
    })
}

fn binary_untracked_diff(path: &str) -> String {
    format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\nBinary files /dev/null and b/{path} differ\n"
    )
}

fn text_untracked_diff(path: &str, contents: &str) -> String {
    let line_count = contents.lines().count();
    let mut diff = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in contents.split_inclusive('\n') {
        diff.push('+');
        diff.push_str(line);
    }
    if !contents.is_empty() && !contents.ends_with('\n') {
        diff.push('\n');
        diff.push_str("\\ No newline at end of file\n");
    }
    diff
}

fn bad_request(error: impl std::fmt::Display) -> HttpRouteError {
    HttpRouteError::new(
        StatusCode::BAD_REQUEST,
        json!({
            "_tag": "EnvironmentHttpBadRequestError",
            "message": error.to_string(),
        }),
    )
}

fn production_provider_terminal_observer_factories() -> ProviderTerminalObserverFactories {
    ProviderTerminalObserverFactories {
        codex: Some(Arc::new(CodexTerminalObserverFactory::system())),
        claude: Some(Arc::new(ClaudeTerminalObserverFactory::system())),
        opencode: Some(Arc::new(OpenCodeTerminalObserverFactory::system())),
    }
}

fn internal_error(error: impl std::fmt::Display) -> HttpRouteError {
    HttpRouteError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({
            "_tag": "EnvironmentHttpInternalServerError",
            "message": error.to_string(),
        }),
    )
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

const FALLBACK_FAVICON: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#171717"/><path d="M17 19h30v8H36v22h-8V27H17z" fill="#fafafa"/></svg>"##;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ServerMessage, ServerRuntime,
        activity::{
            ActivityCapabilities, ActivityLifecycle, ActivityProjection, ActivityScopeRef,
            ActivityScopeSeed, ProviderActivityMutation,
        },
        assets::{AssetIssueRequest, AssetResource},
        persistence::run_migrations,
    };
    use axum::http::{HeaderMap, Uri};
    use futures_util::{SinkExt, StreamExt};
    use tempfile::TempDir;
    use tokio::time::timeout;
    use tokio_tungstenite::{connect_async, tungstenite::Message};

    fn route_context() -> RouteContext {
        RouteContext {
            headers: HeaderMap::new(),
            uri: Uri::from_static("/test"),
            cancellation: CancellationToken::new(),
        }
    }

    #[test]
    fn production_terminal_factories_enable_supported_observation() {
        let factories = production_provider_terminal_observer_factories();

        assert!(
            factories.codex.is_some(),
            "production must install the Codex terminal observer factory"
        );
        assert!(
            factories.claude.is_some(),
            "production must install the Claude terminal observer factory"
        );
        assert!(
            factories.opencode.is_some(),
            "production must install the OpenCode terminal observer factory"
        );
    }

    #[tokio::test]
    async fn production_activity_rpc_stream_receives_producer_projection_deltas() {
        // Mutation caught: registering RPC with fresh projections that do not share producer buses.
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let state = TempDir::new().expect("temporary state directory");
        let config = ServerConfig::new(state.path())
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth();
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let runtime = ProductionRuntime::start(
            &config,
            database,
            AuthService::new(&config, vec![7_u8; 32]),
            vec![9_u8; 32],
            Arc::new(crate::diagnostics::NotApplicableUiProcessObserver),
        )
        .await
        .expect("production runtime start");
        let producer_projection = runtime.activity_projections.chat();
        producer_projection
            .ensure_scope(
                ActivityScopeSeed::thread(
                    "thread:production-rpc",
                    "production-rpc",
                    "codex",
                    Some("codex"),
                    ActivityCapabilities::structured_full(false),
                )
                .expect("thread scope"),
            )
            .await
            .expect("scope persistence");
        let handle = ServerRuntime::start_with_registry(config, runtime.registry.clone())
            .await
            .expect("RPC server");
        let mut socket = connect_async(format!("ws://{}/ws", handle.local_addr()))
            .await
            .expect("WebSocket")
            .0;
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": "701",
                    "tag": "subscribeActivity",
                    "payload": { "_tag": "thread", "threadId": "production-rpc" },
                    "headers": []
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("subscribe to activity");
        let initial = next_activity_message(&mut socket).await;
        assert!(matches!(
            initial,
            ServerMessage::Chunk { ref values, .. }
                if values[0]["kind"] == "snapshot"
                    && values[0]["snapshot"]["scopeId"] == "thread:production-rpc"
        ));
        socket
            .send(Message::Text(
                json!({ "_tag": "Ack", "requestId": "701" })
                    .to_string()
                    .into(),
            ))
            .await
            .expect("acknowledge initial snapshot");

        producer_projection
            .apply(
                "thread:production-rpc",
                "event:production-rpc".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor(
                        "actor:production-rpc",
                        None,
                        "Production RPC actor",
                        "running",
                    )
                    .expect("actor mutation"),
                ],
                "2026-08-04T12:00:00Z".to_owned(),
            )
            .await
            .expect("producer mutation");
        let delta = next_activity_message(&mut socket).await;
        assert!(matches!(
            delta,
            ServerMessage::Chunk { ref values, .. }
                if values[0]["kind"] == "delta"
                    && values[0]["delta"]["scopeId"] == "thread:production-rpc"
        ));

        socket.close(None).await.expect("close WebSocket");
        handle.shutdown();
        handle.join().await.expect("RPC server joins");
        runtime.shutdown().await;
    }

    async fn next_activity_message<S>(
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
    ) -> ServerMessage
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let frame = timeout(Duration::from_secs(2), socket.next())
            .await
            .expect("activity message timeout")
            .expect("WebSocket remains open")
            .expect("WebSocket frame");
        let Message::Text(text) = frame else {
            panic!("unexpected WebSocket frame: {frame:?}");
        };
        serde_json::from_str(&text).expect("server message")
    }

    async fn request_settings_update<S>(
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
        request_id: &str,
        patch: Value,
    ) -> Value
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": request_id,
                    "tag": "server.updateSettings",
                    "payload": { "patch": patch },
                    "headers": []
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send settings update");
        let message = next_activity_message(socket).await;
        match message {
            ServerMessage::Exit {
                exit: crate::RpcExit::Success { value: Some(value) },
                ..
            } => value,
            other => panic!("unexpected settings response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn http_turn_start_cannot_bypass_durable_admission() {
        let state = TempDir::new().expect("state");
        let config = ServerConfig::new(state.path()).with_bind("127.0.0.1", 0);
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let runtime = ProductionRuntime::start(
            &config,
            database,
            AuthService::new(&config, vec![7_u8; 32]),
            vec![9_u8; 32],
            Arc::new(crate::diagnostics::NotApplicableUiProcessObserver),
        )
        .await
        .expect("runtime");
        let workspace_root = state.path().join("http-project");
        std::fs::create_dir(&workspace_root).expect("workspace");
        runtime
            .orchestration
            .dispatch(
                serde_json::from_value(json!({
                    "type":"project.create","commandId":"http-project","projectId":"http-project",
                    "title":"Project","workspaceRoot":workspace_root,"defaultModelSelection":null,
                    "createdAt":"2026-08-01T00:00:00Z"
                }))
                .expect("project command"),
            )
            .await
            .expect("project");
        let thread_id = load_snapshot(&runtime.orchestration.repositories())
            .await
            .expect("snapshot")
            .threads
            .into_iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id;

        let result = runtime.json(
            JsonOperation::OrchestrationDispatch,
            Some(json!({
                "type":"thread.turn.start","commandId":"http-turn","threadId":thread_id,
                "message":{"messageId":"http-message","role":"user","text":"hello","attachments":[]},
                "createdAt":"2026-08-01T00:00:01Z"
            })),
            route_context(),
        ).await;

        assert!(result.is_err());
        assert!(
            runtime
                .orchestration
                .repositories()
                .get_command_receipt("http-turn".to_owned())
                .await
                .expect("receipt")
                .is_none()
        );
        assert!(
            runtime
                .orchestration
                .repositories()
                .get_provider_turn_delivery("http-turn".to_owned())
                .await
                .expect("delivery")
                .is_none()
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn startup_interrupts_only_unresolved_terminal_activity() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let state = TempDir::new().expect("temporary state directory");
        let config = ServerConfig::new(state.path()).with_bind("127.0.0.1", 0);
        std::fs::create_dir_all(config.state_dir()).expect("state directory");
        std::fs::write(
            config.state_dir().join("settings.json"),
            br#"{"enableChatAgentActivity":true,"enableTerminalAgentActivity":true}"#,
        )
        .expect("activity settings fixture");
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::new(ActivityRepository::new(database.clone()));
        let terminal_scope = ActivityScopeSeed::terminal(
            "terminal:restart-active",
            "generation-restart-active",
            "thread-restart",
            "terminal-restart",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(true),
        )
        .expect("terminal scope");
        let thread_scope = ActivityScopeSeed::thread(
            "thread:restart-active",
            "thread-restart",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(false),
        )
        .expect("thread scope");
        projection
            .ensure_scope(terminal_scope.clone())
            .await
            .expect("terminal scope persistence");
        projection
            .ensure_scope(thread_scope.clone())
            .await
            .expect("thread scope persistence");
        projection
            .apply(
                &terminal_scope.scope_id,
                "terminal:restart-fixture".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor(
                        "terminal-active",
                        None,
                        "Terminal active",
                        "running",
                    )
                    .expect("terminal active actor"),
                    ProviderActivityMutation::upsert_actor(
                        "terminal-completed",
                        None,
                        "Terminal completed",
                        "completed",
                    )
                    .expect("terminal completed actor"),
                ],
                "2026-07-26T00:00:00Z".to_owned(),
            )
            .await
            .expect("terminal activity persistence");
        projection
            .apply(
                &thread_scope.scope_id,
                "thread:restart-fixture".to_owned(),
                vec![
                    ProviderActivityMutation::upsert_actor(
                        "thread-active",
                        None,
                        "Thread active",
                        "running",
                    )
                    .expect("thread active actor"),
                ],
                "2026-07-26T00:00:00Z".to_owned(),
            )
            .await
            .expect("thread activity persistence");

        let runtime = ProductionRuntime::start(
            &config,
            database,
            AuthService::new(&config, vec![7_u8; 32]),
            vec![9_u8; 32],
            Arc::new(crate::diagnostics::NotApplicableUiProcessObserver),
        )
        .await
        .expect("production runtime start");

        let terminal_snapshot = runtime
            .activity_projections
            .terminal()
            .snapshot(&ActivityScopeRef::Terminal {
                thread_id: "thread-restart".to_owned(),
                terminal_id: "terminal-restart".to_owned(),
            })
            .await
            .expect("terminal snapshot");
        assert_eq!(
            terminal_snapshot
                .actors
                .iter()
                .find(|actor| actor.id == "terminal-active")
                .expect("terminal active actor")
                .status,
            ActivityLifecycle::Interrupted
        );
        assert_eq!(
            terminal_snapshot
                .actors
                .iter()
                .find(|actor| actor.id == "terminal-completed")
                .expect("terminal completed actor")
                .status,
            ActivityLifecycle::Completed
        );
        let thread_snapshot = runtime
            .activity_projections
            .chat()
            .snapshot(&ActivityScopeRef::Thread {
                thread_id: "thread-restart".to_owned(),
            })
            .await
            .expect("thread snapshot");
        assert_eq!(
            thread_snapshot
                .actors
                .iter()
                .find(|actor| actor.id == "thread-active")
                .expect("thread active actor")
                .status,
            ActivityLifecycle::Running
        );
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn agent_activity_startup_migrates_legacy_true_to_chat_enabled_and_terminal_disabled() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let state = TempDir::new().expect("temporary state directory");
        let config = ServerConfig::new(state.path()).with_bind("127.0.0.1", 0);
        std::fs::create_dir_all(config.state_dir()).expect("state directory");
        std::fs::write(
            config.state_dir().join("settings.json"),
            br#"{"enableAgentActivity":true}"#,
        )
        .expect("legacy settings fixture");
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");

        let runtime = ProductionRuntime::start(
            &config,
            database,
            AuthService::new(&config, vec![7_u8; 32]),
            vec![9_u8; 32],
            Arc::new(crate::diagnostics::NotApplicableUiProcessObserver),
        )
        .await
        .expect("production runtime start");

        let chat_state = runtime
            .activity_projections
            .chat()
            .agent_activity_controller_for_integration_test()
            .snapshot();
        let terminal_state = runtime
            .activity_projections
            .terminal()
            .agent_activity_controller_for_integration_test()
            .snapshot();
        assert!(chat_state.enabled);
        assert!(!terminal_state.enabled);
        assert_eq!(chat_state.generation, 0);
        assert_eq!(terminal_state.generation, 0);
        let trace_path = config.state_dir().join("logs/server.trace.ndjson");
        let records = std::fs::read_to_string(trace_path).expect("startup trace");
        let records = records
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("valid trace record"))
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 2);
        assert!(records.iter().any(|record| {
            record["name"] == "agent_activity_enabled"
                && record["events"][0]["attributes"]["cause"] == "startup"
                && record["events"][0]["attributes"]["source"] == "chat"
                && record["events"][0]["attributes"]["enabled"] == true
                && record["events"][0]["attributes"]["observationGeneration"] == 0
        }));
        assert!(records.iter().any(|record| {
            record["name"] == "agent_activity_disabled"
                && record["events"][0]["attributes"]["cause"] == "startup"
                && record["events"][0]["attributes"]["source"] == "terminal"
                && record["events"][0]["attributes"]["enabled"] == false
                && record["events"][0]["attributes"]["observationGeneration"] == 0
        }));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn agent_activity_runtime_settings_updates_change_only_the_selected_source_controller() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let state = TempDir::new().expect("temporary state directory");
        let config = ServerConfig::new(state.path())
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth();
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let runtime = ProductionRuntime::start(
            &config,
            database,
            AuthService::new(&config, vec![7_u8; 32]),
            vec![9_u8; 32],
            Arc::new(crate::diagnostics::NotApplicableUiProcessObserver),
        )
        .await
        .expect("production runtime start");
        let chat_controller = runtime
            .activity_projections
            .chat()
            .agent_activity_controller_for_integration_test();
        let terminal_controller = runtime
            .activity_projections
            .terminal()
            .agent_activity_controller_for_integration_test();
        let initial_chat = chat_controller.snapshot();
        let initial_terminal = terminal_controller.snapshot();
        assert!(initial_chat.enabled);
        assert!(!initial_terminal.enabled);

        let handle = ServerRuntime::start_with_registry(config, runtime.registry.clone())
            .await
            .expect("RPC server");
        let mut socket = connect_async(format!("ws://{}/ws", handle.local_addr()))
            .await
            .expect("WebSocket")
            .0;
        let terminal_settings = request_settings_update(
            &mut socket,
            "801",
            json!({ "enableTerminalAgentActivity": true }),
        )
        .await;
        assert_eq!(terminal_settings["enableTerminalAgentActivity"], true);
        assert_eq!(chat_controller.snapshot(), initial_chat);
        let terminal_enabled = terminal_controller.snapshot();
        assert!(terminal_enabled.enabled);
        assert_eq!(terminal_enabled.generation, initial_terminal.generation + 1);

        let chat_settings = request_settings_update(
            &mut socket,
            "802",
            json!({ "enableChatAgentActivity": false }),
        )
        .await;
        assert_eq!(chat_settings["enableChatAgentActivity"], false);
        assert_eq!(terminal_controller.snapshot(), terminal_enabled);
        let chat_disabled = chat_controller.snapshot();
        assert!(!chat_disabled.enabled);
        assert_eq!(chat_disabled.generation, initial_chat.generation + 1);

        socket.close(None).await.expect("close WebSocket");
        handle.shutdown();
        handle.join().await.expect("RPC server joins");
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn hardening_bootstrap_provider_observation_failure_does_not_abort_production_runtime() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let state = TempDir::new().expect("temporary state directory");
        let config = ServerConfig::new(state.path()).with_bind("127.0.0.1", 0);
        std::fs::create_dir_all(config.state_dir()).expect("state directory");
        std::fs::write(
            config.state_dir().join("runtime"),
            b"blocks private observer directory",
        )
        .expect("blocking file");
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let auth = AuthService::new(&config, vec![7_u8; 32]);

        let runtime = ProductionRuntime::start(
            &config,
            database,
            auth,
            vec![9_u8; 32],
            Arc::new(crate::diagnostics::NotApplicableUiProcessObserver),
        )
        .await
        .expect("optional provider observation must fail open");

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn production_runtime_covers_core_routes_assets_diagnostics_and_shutdown() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let state = TempDir::new().expect("temporary state directory");
        let config = ServerConfig::new(state.path()).with_bind("127.0.0.1", 0);
        let database = Database::open_in_memory()
            .await
            .expect("in-memory database should open");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("database should migrate");
        let auth = AuthService::new(&config, vec![7_u8; 32]);
        let runtime = ProductionRuntime::start(
            &config,
            database,
            auth,
            vec![9_u8; 32],
            Arc::new(crate::diagnostics::NotApplicableUiProcessObserver),
        )
        .await
        .expect("production runtime should start");
        let resources =
            crate::diagnostics::ResourceSampler::sample(runtime._resource_sampler.as_ref())
                .await
                .expect("attributed resources should sample");
        assert_eq!(
            resources.ui_coverage.status,
            crate::diagnostics::UiCoverageStatus::NotApplicable
        );

        let snapshot = runtime
            .json(JsonOperation::OrchestrationSnapshot, None, route_context())
            .await
            .expect("snapshot route should succeed");
        assert_eq!(snapshot.status, StatusCode::OK);
        assert!(snapshot.body.is_object());

        assert!(
            runtime
                .json(JsonOperation::OrchestrationDispatch, None, route_context())
                .await
                .is_err(),
            "missing dispatch payload should fail",
        );

        assert!(
            runtime
                .json(
                    JsonOperation::OrchestrationDispatch,
                    Some(json!({"_tag":"UnknownCommand"})),
                    route_context(),
                )
                .await
                .is_err(),
            "malformed dispatch payload should fail",
        );

        let callback_workspace = state.path().join("callback-workspace");
        tokio::fs::create_dir_all(&callback_workspace)
            .await
            .expect("callback workspace should create");
        runtime
            .json(
                JsonOperation::OrchestrationDispatch,
                Some(json!({
                    "type":"project.create",
                    "commandId":"runtime-project-create",
                    "projectId":"runtime-project",
                    "title":"Runtime project",
                    "workspaceRoot":callback_workspace,
                    "createdAt":"2026-01-01T00:00:00Z"
                })),
                route_context(),
            )
            .await
            .expect("project dispatch should succeed");
        runtime
            .json(
                JsonOperation::OrchestrationDispatch,
                Some(json!({
                    "type":"thread.create",
                    "commandId":"runtime-thread-create",
                    "threadId":"runtime-thread",
                    "projectId":"runtime-project",
                    "title":"Runtime thread",
                    "modelSelection":{"provider":"codex","model":"auto"},
                    "runtimeMode":"approval-required",
                    "interactionMode":"default",
                    "branch":null,
                    "worktreePath":null,
                    "createdAt":"2026-01-01T00:00:00Z"
                })),
                route_context(),
            )
            .await
            .expect("thread dispatch should succeed");

        let callbacks = RuntimeEffectCallbacks {
            repositories: runtime.orchestration.repositories(),
            provider: runtime.provider_runtime.clone(),
            terminals: runtime.terminal_services.clone(),
            workspace: WorkspaceRpc::new(WorkspaceService::default()),
        };
        let canonical_callback_workspace =
            std::fs::canonicalize(&callback_workspace).expect("callback workspace canonical path");
        assert_eq!(
            callbacks
                .workspace_for_thread("runtime-thread")
                .await
                .expect("thread workspace should resolve"),
            Some(process_compatible_path(
                canonical_callback_workspace.clone()
            )),
        );
        assert_eq!(
            callbacks
                .workspace_for_thread("missing-thread")
                .await
                .expect("missing thread should resolve"),
            None,
        );
        assert!(
            callbacks
                .rollback_provider("missing-thread", 1)
                .await
                .is_err()
        );
        callbacks
            .stop_provider("missing-thread")
            .await
            .expect("missing provider session should already be stopped");
        callbacks
            .refresh_workspace(&callback_workspace)
            .await
            .expect("workspace index should refresh");
        callbacks
            .close_terminals("runtime-thread")
            .await
            .expect("thread terminals should close");
        callbacks
            .launch_setup_script(SetupScriptLaunch {
                thread_id: "runtime-thread".to_owned(),
                terminal_id: "runtime-setup-terminal".to_owned(),
                script_id: "runtime-setup".to_owned(),
                script_name: "Runtime setup".to_owned(),
                command: "echo coverage".to_owned(),
                cwd: callback_workspace.clone(),
                worktree_path: callback_workspace.clone(),
                env: Default::default(),
            })
            .await
            .expect("setup script should launch");
        callbacks
            .close_terminals("runtime-thread")
            .await
            .expect("setup terminal should close");

        let asset_context = ProjectionAssetContext {
            repositories: runtime.orchestration.repositories(),
        };
        assert_eq!(
            asset_context
                .resolve_workspace_root("runtime-thread")
                .await
                .expect("asset workspace should resolve"),
            Some(process_compatible_path(canonical_callback_workspace)),
        );
        assert_eq!(
            asset_context
                .resolve_workspace_root("missing-thread")
                .await
                .expect("missing asset workspace should resolve"),
            None,
        );

        assert!(
            runtime
                .json(JsonOperation::ConnectLinkState, None, route_context())
                .await
                .is_err(),
            "connect operation should be owned by its route adapter",
        );
        assert!(
            runtime
                .asset("invalid-token".to_string(), "missing.png".to_string())
                .await
                .is_err(),
            "invalid asset token should fail",
        );

        let attachment_id = "runtime-test-image";
        let attachment_path = config.state_dir().join("attachments").join(attachment_id);
        tokio::fs::create_dir_all(attachment_path.parent().expect("attachment parent"))
            .await
            .expect("attachment directory should create");
        tokio::fs::write(&attachment_path, b"png-bytes")
            .await
            .expect("attachment should write");
        let issued = runtime
            .asset_access
            .issue(AssetIssueRequest {
                resource: AssetResource::Attachment {
                    attachment_id: attachment_id.to_string(),
                },
                workspace_root: None,
            })
            .await
            .expect("attachment URL should issue");
        let mut asset_parts = issued.relative_url.rsplitn(2, '/');
        let asset_path = asset_parts.next().expect("asset filename");
        let asset_token = asset_parts.next().expect("asset token path");
        let asset_token = asset_token.rsplit('/').next().expect("asset token");
        let asset = runtime
            .asset(asset_token.to_string(), asset_path.to_string())
            .await
            .expect("attachment asset should resolve");
        assert_eq!(asset.content_type, "application/octet-stream");
        assert_eq!(asset.bytes, b"png-bytes");

        let oversized_id = "runtime-oversized";
        let oversized_path = config.state_dir().join("attachments").join(oversized_id);
        let oversized_file = std::fs::File::create(&oversized_path).expect("oversized attachment");
        oversized_file
            .set_len((10 * 1024 * 1024 + 1) as u64)
            .expect("oversized attachment length");
        let issued = runtime
            .asset_access
            .issue(AssetIssueRequest {
                resource: AssetResource::Attachment {
                    attachment_id: oversized_id.to_owned(),
                },
                workspace_root: None,
            })
            .await
            .expect("oversized attachment may receive a capability");
        let mut asset_parts = issued.relative_url.rsplitn(2, '/');
        let asset_path = asset_parts.next().expect("asset filename");
        let asset_token = asset_parts.next().expect("asset token path");
        let asset_token = asset_token.rsplit('/').next().expect("asset token");
        assert!(
            runtime
                .asset(asset_token.to_owned(), asset_path.to_owned())
                .await
                .is_err(),
            "the HTTP boundary must not return an oversized attachment body"
        );

        let favicon_root = state.path().join("favicon-project");
        tokio::fs::create_dir_all(&favicon_root)
            .await
            .expect("favicon project should create");
        let issued = runtime
            .asset_access
            .issue(AssetIssueRequest {
                resource: AssetResource::ProjectFavicon {
                    cwd: favicon_root.to_string_lossy().into_owned(),
                },
                workspace_root: None,
            })
            .await
            .expect("fallback favicon URL should issue");
        let mut asset_parts = issued.relative_url.rsplitn(2, '/');
        let asset_path = asset_parts.next().expect("favicon filename");
        let asset_token = asset_parts.next().expect("favicon token path");
        let asset_token = asset_token.rsplit('/').next().expect("favicon token");
        let favicon = runtime
            .asset(asset_token.to_string(), asset_path.to_string())
            .await
            .expect("fallback favicon should resolve");
        assert_eq!(favicon.content_type, "image/svg+xml");
        assert!(favicon.bytes.starts_with(b"<svg"));

        let diagnostics = runtime
            .diagnostic_logs("frontend runtime test".to_string())
            .await
            .expect("diagnostic bundle should build");
        assert!(diagnostics.filename.ends_with(".zip"));
        assert!(diagnostics.bytes.starts_with(b"PK"));

        let callback_database = callbacks.repositories.database().clone();
        callback_database
            .call(|connection| {
                connection.execute_batch(
                    "ALTER TABLE projection_projects RENAME TO projection_projects_unavailable",
                )?;
                Ok(())
            })
            .await
            .expect("project table should become unavailable");
        assert!(
            callbacks
                .workspace_for_thread("runtime-thread")
                .await
                .is_err()
        );
        assert!(
            asset_context
                .resolve_workspace_root("runtime-thread")
                .await
                .is_err()
        );
        callback_database
            .call(|connection| {
                connection.execute_batch(
                    "ALTER TABLE projection_projects_unavailable RENAME TO projection_projects;\
                     ALTER TABLE projection_threads RENAME TO projection_threads_unavailable",
                )?;
                Ok(())
            })
            .await
            .expect("thread table should become unavailable");
        assert!(
            callbacks
                .workspace_for_thread("runtime-thread")
                .await
                .is_err()
        );
        assert!(
            asset_context
                .resolve_workspace_root("runtime-thread")
                .await
                .is_err()
        );
        callback_database
            .call(|connection| {
                connection.execute_batch(
                    "ALTER TABLE projection_threads_unavailable RENAME TO projection_threads",
                )?;
                Ok(())
            })
            .await
            .expect("thread table should restore");

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn git_review_backend_includes_untracked_files() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let repository = TempDir::new().expect("temporary repository");
        assert!(
            std::process::Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(repository.path())
                .status()
                .expect("git starts")
                .success()
        );
        std::fs::write(repository.path().join("untracked.txt"), "first\nsecond\n")
            .expect("write untracked fixture");

        let input = ReviewDiffPreviewInput {
            cwd: repository.path().to_string_lossy().into_owned(),
            base_ref: None,
            ignore_whitespace: Some(false),
        };
        let preview = GitReviewBackend
            .get_diff_preview(&input)
            .await
            .expect("review succeeds")
            .expect("review preview");

        assert_eq!(preview.sources.len(), 2);
        assert_eq!(preview.sources[0].kind, "working-tree");
        assert!(preview.sources[0].diff.contains("+++ b/untracked.txt"));
        assert!(preview.sources[0].diff.contains("+first"));
        assert!(preview.sources[0].diff.contains("+second"));
        assert_eq!(preview.sources[1].kind, "branch-range");
    }

    #[tokio::test]
    async fn git_review_backend_includes_staged_changes_and_branch_range() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let repository = TempDir::new().expect("temporary repository");
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(repository.path())
                .output()
                .expect("git starts");
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["checkout", "--quiet", "-b", "main"]);
        git(&["config", "user.email", "test@bibcode.local"]);
        git(&["config", "user.name", "BiBCode Test"]);
        std::fs::write(repository.path().join("tracked.txt"), "base\n").expect("write base");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "base"]);
        git(&["switch", "--quiet", "-c", "feature"]);
        std::fs::write(repository.path().join("branch.txt"), "feature\n").expect("write branch");
        git(&["add", "branch.txt"]);
        git(&["commit", "--quiet", "-m", "feature"]);
        std::fs::write(repository.path().join("tracked.txt"), "staged\n").expect("write staged");
        git(&["add", "tracked.txt"]);

        let input = ReviewDiffPreviewInput {
            cwd: repository.path().to_string_lossy().into_owned(),
            base_ref: None,
            ignore_whitespace: Some(false),
        };
        let preview = GitReviewBackend
            .get_diff_preview(&input)
            .await
            .expect("review succeeds")
            .expect("review preview");

        assert!(preview.sources[0].diff.contains("+++ b/tracked.txt"));
        assert!(preview.sources[0].diff.contains("+staged"));
        assert_eq!(preview.sources[1].base_ref.as_deref(), Some("main"));
        assert!(preview.sources[1].diff.contains("+++ b/branch.txt"));
        assert!(preview.sources[1].diff.contains("+feature"));
    }

    #[test]
    fn review_diff_helpers_cover_empty_binary_text_and_whitespace_options() {
        assert_eq!(
            review_diff_args(true, Some("main...HEAD"), true),
            vec![
                "diff",
                "--no-ext-diff",
                "--patch",
                "--minimal",
                "--ignore-all-space",
                "main...HEAD",
            ]
        );
        assert_eq!(
            review_diff_args(false, None, false),
            vec!["diff", "--no-ext-diff", "--patch", "--minimal", "--"]
        );
        assert_eq!(join_review_diffs("", ""), "");
        assert_eq!(join_review_diffs("left\n", "right\n"), "left\nright");
        assert!(binary_untracked_diff("image.bin").contains("Binary files"));
        assert!(text_untracked_diff("empty.txt", "").contains("+1,0"));
        assert!(text_untracked_diff("lines.txt", "first\nsecond\n").contains("+second\n"));
        assert!(
            text_untracked_diff("unterminated.txt", "last")
                .contains("\\ No newline at end of file")
        );

        let source = review_source(
            "working-tree",
            "working-tree",
            "Dirty worktree",
            Some("HEAD".to_owned()),
            None,
            "diff".to_owned(),
            true,
        );
        assert_eq!(source.id, "working-tree");
        assert_eq!(source.diff_hash.len(), 64);
        assert!(source.truncated);
        assert!(now_millis() > 0);
        assert!(now_iso().contains('T'));
    }

    #[tokio::test]
    async fn git_review_backend_returns_an_empty_preview_outside_a_repository() {
        let directory = TempDir::new().expect("temporary directory");
        let preview = GitReviewBackend
            .get_diff_preview(&ReviewDiffPreviewInput {
                cwd: directory.path().to_string_lossy().into_owned(),
                base_ref: None,
                ignore_whitespace: None,
            })
            .await
            .expect("review succeeds")
            .expect("review preview");

        assert!(preview.sources.is_empty());
        assert!(preview.generated_at > 0);
    }

    #[tokio::test]
    async fn untracked_review_diff_marks_binary_and_oversized_files() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let repository = TempDir::new().expect("temporary repository");
        assert!(
            std::process::Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(repository.path())
                .status()
                .expect("git starts")
                .success()
        );
        std::fs::write(repository.path().join("binary.dat"), b"binary\0payload")
            .expect("binary fixture");
        std::fs::write(
            repository.path().join("oversized.dat"),
            vec![b'x'; MAX_UNTRACKED_REVIEW_FILE_BYTES as usize + 1],
        )
        .expect("oversized fixture");

        let diff = untracked_review_diff(&repository.path().to_string_lossy())
            .await
            .expect("untracked diff");
        assert!(diff.diff.contains("binary.dat"));
        assert!(diff.diff.contains("oversized.dat"));
        assert!(diff.truncated);
    }

    #[tokio::test]
    async fn git_review_maps_process_detached_head_and_unreadable_file_edges() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        assert!(
            run_review_diff("\0", review_diff_args(false, Some("HEAD"), false))
                .await
                .is_err()
        );
        assert!(untracked_review_diff("\0").await.is_err());
        assert!(
            format!("{:?}", internal_error("injected review error"))
                .contains("injected review error")
        );

        let repository = TempDir::new().expect("temporary repository");
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(repository.path())
                .output()
                .expect("git starts");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["checkout", "--quiet", "-b", "main"]);
        git(&["config", "user.email", "test@bibcode.local"]);
        git(&["config", "user.name", "BiBCode Test"]);
        std::fs::write(repository.path().join("tracked.txt"), "base\n").expect("tracked file");
        git(&["add", "tracked.txt"]);
        git(&["commit", "--quiet", "-m", "base"]);
        git(&["checkout", "--quiet", "--detach", "HEAD"]);

        let detached = GitReviewBackend
            .get_diff_preview(&ReviewDiffPreviewInput {
                cwd: repository.path().to_string_lossy().into_owned(),
                base_ref: Some("main".to_owned()),
                ignore_whitespace: None,
            })
            .await
            .expect("detached review")
            .expect("detached preview");
        assert_eq!(detached.sources[1].head_ref.as_deref(), Some("HEAD"));

        #[cfg(unix)]
        {
            let unreadable = repository.path().join("unreadable.txt");
            std::fs::write(&unreadable, "secret\n").expect("unreadable fixture");
            std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000))
                .expect("remove read permission");
            let result = untracked_review_diff(&repository.path().to_string_lossy()).await;
            std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o600))
                .expect("restore read permission");
            assert!(result.is_err());
        }
    }
}
