use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use crate::{
    json_size::encoded_json_len,
    orchestration::{
        CommandAdmission, NewProviderTurnDelivery, OrchestrationCommand, OrchestrationEngine,
        OrchestrationError, canonical_command_digest,
        engine::{CommandLifetimeGuard, OptionalNullable, TurnDeliveryResolutionAction},
        load_capped_shell_snapshot, load_shell_snapshot, load_thread_snapshot, shell_rows_snapshot,
    },
    persistence::{
        EVENT_PAGE_SIZE, OlderThreadsScope, OrchestrationEvent, PersistenceError, ProjectionThread,
        Repositories, shell_recency_key,
    },
    provider::attachments::{
        AttachmentMaterializationError, AttachmentMaterializer, PreparedAttachmentBatch,
        ReusableAttachments, id_only_attachment_ids,
    },
    rpc::{
        MAX_RECORDED_MESSAGE_BYTES, RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk,
        response_too_large_failure,
    },
    server_settings::ProviderSettingsStore,
    terminal::{TerminalAgentStatusState, TerminalManager, TerminalMetadataEvent, TerminalSummary},
    transfer::staging::{UploadOwner, UploadRegistry},
    worktree_catalog::{
        WorkspaceAdmissionCancellation, WorkspaceAdmissionLease, WorkspaceAvailabilityRegistry,
    },
};

use super::orchestration_effects::install_project_command_effects;
use super::provider_runtime::{
    ProviderRuntimeError, ProviderRuntimeSupervisor, canonical_provider_kind,
    freeze_delivery_route, route_orchestration_command,
};
use super::turn_delivery::TurnDeliveryService;
use super::workspace_availability::{WorkspaceAdmissionController, WorkspaceAdmissionError};

mod thread_history;

const STREAM_CAPACITY: usize = 16;
/// Use the History page target (`COMMIT_PAGE_TARGET_BYTES`): 1 MiB of event JSON.
const REPLAY_PAGE_TARGET_BYTES: usize = 1024 * 1024;

pub fn register_orchestration_rpc(registry: &mut RpcRegistry, engine: OrchestrationEngine) {
    register_orchestration_rpc_inner(registry, engine, None, None, None);
}

pub fn register_orchestration_rpc_with_availability(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    availability: WorkspaceAvailabilityRegistry,
) {
    register_orchestration_rpc_inner(registry, engine, None, Some(availability), None);
}

pub fn register_orchestration_rpc_with_delivery(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>,
    settings_root: PathBuf,
    turn_delivery: Arc<TurnDeliveryService>,
    uploads: UploadRegistry,
) {
    let attachments = AttachmentMaterializer::new(settings_root.join("attachments"));
    register_orchestration_rpc_inner(
        registry,
        engine,
        Some(ProviderRegistration {
            provider,
            settings_root,
            attachments,
            turn_delivery,
            uploads,
        }),
        None,
        None,
    );
}

/// The production registration. `terminals` lets a capped shell keep the hosts of AI
/// Terminals whose agent is working, blocked or waiting (#223).
#[allow(clippy::too_many_arguments)]
pub fn register_orchestration_rpc_with_delivery_and_availability(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>,
    settings_root: PathBuf,
    turn_delivery: Arc<TurnDeliveryService>,
    availability: WorkspaceAvailabilityRegistry,
    uploads: UploadRegistry,
    terminals: Option<TerminalManager>,
) {
    let attachments = AttachmentMaterializer::new(settings_root.join("attachments"));
    register_orchestration_rpc_inner(
        registry,
        engine,
        Some(ProviderRegistration {
            provider,
            settings_root,
            attachments,
            turn_delivery,
            uploads,
        }),
        Some(availability),
        terminals,
    );
}

#[derive(Clone)]
struct ProviderRegistration {
    provider: Arc<ProviderRuntimeSupervisor>,
    settings_root: PathBuf,
    attachments: AttachmentMaterializer,
    turn_delivery: Arc<TurnDeliveryService>,
    uploads: UploadRegistry,
}

fn register_orchestration_rpc_inner(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    provider: Option<ProviderRegistration>,
    availability: Option<WorkspaceAvailabilityRegistry>,
    terminals: Option<TerminalManager>,
) {
    install_project_command_effects(&engine);
    let availability = availability
        .map(|availability| WorkspaceAdmissionController::new(availability, engine.repositories()));
    let query_availability = availability.clone();
    let preview_provider = provider.clone();
    let dispatch = engine.clone();
    registry.register_unary_with_context(
        "orchestration.dispatchCommand",
        move |request, context, _| {
            let dispatch = dispatch.clone();
            let owner = UploadOwner::from_context(&context);
            let provider = provider.clone();
            let availability = availability.clone();
            async move {
                let payload_digest = canonical_command_digest(&request.payload)
                    .map_err(|error| invalid_request(&request.tag, error))?;
                let command = decode_public_orchestration_command(&dispatch, request.payload)
                    .await
                    .map_err(|error| invalid_request(&request.tag, error))?;
                let command_claim = dispatch
                    .acquire_command_admission(command.command_id())
                    .await
                    .map_err(|error| {
                        orchestration_error("OrchestrationDispatchCommandError", error)
                    })?;
                // Who sent it comes from the authenticated principal only (#139, slice X1).
                if let Some(actor) = crate::mcp::activity::principal_actor(&context).await {
                    command_claim.attribute_to(actor);
                }
                if let OrchestrationCommand::ThreadTurnStart { thread_id, .. } = &command {
                    let workspace_admission = if let Some(availability) = &availability {
                        Some(
                            availability
                                .acquire_thread(thread_id, std::iter::empty())
                                .await
                                .map_err(workspace_admission_error)?,
                        )
                    } else {
                        None
                    };
                    let provider = provider.ok_or_else(|| {
                        invalid_request(
                            &request.tag,
                            "thread.turn.start requires durable provider delivery",
                        )
                    })?;
                    return dispatch_turn_command(
                        dispatch,
                        provider,
                        command,
                        payload_digest,
                        request.tag,
                        workspace_admission,
                        command_claim,
                        &owner,
                    )
                    .await;
                }
                dispatch_prepared_command(
                    dispatch,
                    provider,
                    command,
                    payload_digest,
                    request.tag,
                    command_claim,
                )
                .await
            }
        },
    );

    let replay = engine.clone();
    registry.register_unary("orchestration.replayEvents", move |request, _| {
        let replay = replay.clone();
        async move {
            let tag = request.tag.clone();
            let input = decode::<ReplayInput>(request)?;
            if input.from_sequence_exclusive < 0 {
                return Err(invalid_request(
                    &tag,
                    "fromSequenceExclusive must be a non-negative integer",
                ));
            }
            let budget = if input.paged {
                ReplayBudget::Page {
                    target_bytes: REPLAY_PAGE_TARGET_BYTES,
                }
            } else {
                ReplayBudget::Whole {
                    limit_bytes: MAX_RECORDED_MESSAGE_BYTES,
                }
            };
            let read = read_replay(
                &replay.repositories(),
                input.from_sequence_exclusive,
                budget,
            )
            .await
            .map_err(|error| match error {
                ReplayReadError::TooLarge { bytes, limit_bytes } => {
                    response_too_large_failure(&tag, bytes, limit_bytes)
                }
                error => orchestration_error("OrchestrationReplayEventsError", error),
            })?;
            let events = Value::Array(read.events);
            if input.paged {
                let mut page = json!({ "exhausted": read.exhausted });
                // json! uses to_value(&value); move by index to avoid deep-copying the whole page.
                page["events"] = events;
                Ok(page)
            } else {
                Ok(events)
            }
        }
    });

    for method in [
        "orchestration.getArchivedShellSnapshot",
        "orchestration.getTurnDiff",
        "orchestration.getFullThreadDiff",
    ] {
        let engine = engine.clone();
        let availability = query_availability.clone();
        registry.register_unary(method, move |request, cancellation| {
            let engine = engine.clone();
            let availability = availability.clone();
            async move { handle_query(&engine, availability.as_ref(), request, cancellation).await }
        });
    }

    // Runs capture-sized Git reads and asks the supervisor, so it is in `is_long_running`.
    let preview = (engine.clone(), preview_provider);
    registry.register_unary(
        "orchestration.previewCheckpointRevert",
        move |request, cancellation| {
            let (engine, provider) = preview.clone();
            async move { preview_checkpoint_revert(&engine, provider.as_ref(), request, &cancellation).await }
        },
    );

    // A local database read, like `replayEvents`: not in `is_long_running`.
    let pages = engine.clone();
    registry.register_unary("orchestration.getThreadHistoryPage", move |request, _| {
        let pages = pages.clone();
        async move { thread_history::history_page(&pages, decode(request)?).await }
    });

    let older = (engine.clone(), terminals.clone());
    registry.register_unary("orchestration.listOlderThreads", move |request, _| {
        let (engine, terminals) = older.clone();
        async move { list_older_threads(&engine, terminals.as_ref(), request).await }
    });
    let shells = engine.clone();
    registry.register_unary("orchestration.getThreadShells", move |request, _| {
        let engine = shells.clone();
        async move { get_thread_shells(&engine, request).await }
    });
    let shell = engine.clone();
    registry.register_stream(
        "orchestration.subscribeShell",
        move |request, cancellation| {
            subscribe_shell(shell.clone(), terminals.clone(), request, cancellation)
        },
    );
    registry.register_stream(
        "orchestration.subscribeThread",
        move |request, cancellation| thread_stream(engine.clone(), request, cancellation),
    );
}

/// Decodes the public orchestration wire shape and resolves the small amount of
/// server-owned context that ordinary commands need. Worktree policy, identity,
/// lifecycle kind, and adopted-owner deletion are deliberately not part of this
/// generic ingress.
pub(crate) async fn decode_public_orchestration_command(
    engine: &OrchestrationEngine,
    payload: Value,
) -> Result<OrchestrationCommand, String> {
    let supplied_prepare_cwd = payload
        .get("bootstrap")
        .and_then(|bootstrap| bootstrap.get("prepareWorktree"))
        .and_then(Value::as_object)
        .is_some_and(|prepare| prepare.contains_key("projectCwd"));
    let mut command = serde_json::from_value::<OrchestrationCommand>(payload)
        .map_err(|error| error.to_string())?;
    if command.is_server_internal() {
        return Err(
            "server-internal orchestration commands cannot be dispatched by clients".to_owned(),
        );
    }

    const DEDICATED_AUTHORITY: &str = "worktree authority requires a dedicated server-resolved RPC";
    match &command {
        OrchestrationCommand::ProjectMetaUpdate {
            worktree_discovery: Some(_),
            ..
        }
        | OrchestrationCommand::ThreadCreate { kind: Some(_), .. }
        | OrchestrationCommand::ThreadCreate {
            worktree_path: Some(_),
            ..
        }
        | OrchestrationCommand::ThreadCreate {
            host_thread_id: Some(_),
            ..
        }
        | OrchestrationCommand::ThreadMetaUpdate {
            worktree_path: OptionalNullable::Present(_),
            ..
        } => return Err(DEDICATED_AUTHORITY.to_owned()),
        OrchestrationCommand::ThreadTurnStart {
            bootstrap: Some(bootstrap),
            ..
        } if supplied_prepare_cwd
            || bootstrap
                .create_thread
                .as_ref()
                .is_some_and(|create| create.worktree_path.is_some()) =>
        {
            return Err(DEDICATED_AUTHORITY.to_owned());
        }
        OrchestrationCommand::ThreadDelete { thread_id, .. } => {
            if engine
                .repositories()
                .get_thread(thread_id.clone())
                .await
                .map_err(|error| error.to_string())?
                .is_some_and(|thread| {
                    thread.deleted_at.is_none()
                        && thread.kind == "workspace"
                        && thread.worktree_path.is_some()
                })
            {
                return Err(DEDICATED_AUTHORITY.to_owned());
            }
        }
        OrchestrationCommand::ProjectDelete { project_id, .. }
            if engine
                .repositories()
                .list_threads_by_project(project_id.clone())
                .await
                .map_err(|error| error.to_string())?
                .into_iter()
                .any(|thread| {
                    thread.deleted_at.is_none()
                        && thread.kind == "workspace"
                        && thread.worktree_path.is_some()
                }) =>
        {
            return Err(DEDICATED_AUTHORITY.to_owned());
        }
        _ => {}
    }

    if let OrchestrationCommand::ThreadCreate {
        project_id, kind, ..
    } = &mut command
    {
        let has_default = engine
            .repositories()
            .list_threads_by_project(project_id.clone())
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .any(|thread| thread.deleted_at.is_none() && thread.kind == "default");
        *kind = Some(if has_default { "workspace" } else { "default" }.to_owned());
    }

    if let OrchestrationCommand::ThreadTurnStart {
        thread_id,
        bootstrap: Some(bootstrap),
        ..
    } = &mut command
        && let Some(prepare) = bootstrap.prepare_worktree.as_mut()
    {
        let project_id = if let Some(create) = bootstrap.create_thread.as_ref() {
            create.project_id.clone()
        } else {
            engine
                .repositories()
                .get_thread(thread_id.clone())
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("thread '{thread_id}' does not exist"))?
                .project_id
        };
        prepare.project_cwd = engine
            .repositories()
            .get_project(project_id.clone())
            .await
            .map_err(|error| error.to_string())?
            .filter(|project| project.deleted_at.is_none())
            .ok_or_else(|| format!("project '{project_id}' does not exist"))?
            .workspace_root;
    }
    Ok(command)
}

async fn dispatch_prepared_command(
    dispatch: OrchestrationEngine,
    provider: Option<ProviderRegistration>,
    command: OrchestrationCommand,
    payload_digest: String,
    request_tag: String,
    command_claim: crate::orchestration::engine::CommandAdmissionClaim,
) -> RpcResult {
    let delivery_cancellation = match &command {
        OrchestrationCommand::ThreadTurnDeliveryResolve {
            command_id,
            thread_id,
            action: TurnDeliveryResolutionAction::Dismiss,
            created_at,
            ..
        } => Some((command_id.clone(), thread_id.clone(), created_at.clone())),
        // Closing a chat panel archives it. The server stops its work, including a delivery
        // claimed but not yet visible to clients as a running session.
        OrchestrationCommand::ThreadArchive {
            command_id,
            thread_id,
        } => dispatch
            .repositories()
            .get_thread(thread_id.clone())
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?
            .filter(|thread| thread.kind == "panel")
            .map(|_| (command_id.clone(), thread_id.clone(), now_iso())),
        _ => None,
    };
    let is_delivery_resolution = matches!(
        command,
        OrchestrationCommand::ThreadTurnDeliveryResolve { .. }
    );
    let existing_receipt = dispatch
        .repositories()
        .get_command_receipt(command.command_id().to_owned())
        .await
        .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    let legacy_replay = existing_receipt
        .as_ref()
        .is_some_and(|receipt| receipt.payload_digest.is_none());
    let route_before_admission = if !legacy_replay
        && matches!(
            &command,
            OrchestrationCommand::ThreadMetaUpdate {
                model_selection: Some(_),
                ..
            }
        ) {
        dispatch
            .reserve_generic_command_admission(&command_claim, &command, &payload_digest)
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?
    } else {
        false
    };
    if route_before_admission && let Some(provider) = provider.as_ref() {
        #[cfg(test)]
        dispatch
            .test_hooks()
            .note_generic_external_preparation_attempt();
        route_orchestration_command(
            &provider.provider,
            &dispatch,
            &provider.settings_root,
            command.clone(),
        )
        .await
        .map_err(provider_command_error)?;
    }
    let accepted_new = Arc::new(AtomicBool::new(false));
    let result = if legacy_replay {
        dispatch
            .dispatch_with_command_claim(command.clone(), command_claim)
            .await
    } else {
        let turn_delivery = is_delivery_resolution
            .then(|| {
                provider
                    .as_ref()
                    .map(|provider| provider.turn_delivery.clone())
            })
            .flatten();
        let committed = accepted_new.clone();
        dispatch
            .dispatch_with_admission_and_command_claim(
                command.clone(),
                CommandAdmission {
                    payload_digest,
                    attachment_refs: Vec::new(),
                    provider_turn: None,
                },
                command_claim,
                move || {
                    committed.store(true, Ordering::Release);
                    if let Some(turn_delivery) = turn_delivery {
                        turn_delivery.wake();
                    }
                },
            )
            .await
    }
    .map_err(|error| match error {
        OrchestrationError::ProjectPreparation { detail } => invalid_request(&request_tag, detail),
        OrchestrationError::ThreadInUse { ref thread_id } => json!({
            "_tag": "OrchestrationThreadInUseError",
            "message": error.to_string(),
            "threadId": thread_id,
        }),
        error => orchestration_error("OrchestrationDispatchCommandError", error),
    })?;
    let should_route = match (&command, &result.project_id) {
        (OrchestrationCommand::ProjectCreate { project_id, .. }, Some(resolved_project_id)) => {
            project_id == resolved_project_id
        }
        _ => true,
    };
    if let Some(provider) = provider
        && accepted_new.load(Ordering::Acquire)
        && should_route
    {
        if let Some((command_id, thread_id, created_at)) = delivery_cancellation {
            let result = provider
                .provider
                .handle_orchestration(OrchestrationCommand::ThreadTurnInterrupt {
                    command_id: format!("{command_id}:provider-interrupt"),
                    thread_id,
                    turn_id: None,
                    created_at,
                })
                .await;
            if let Err(error) = result
                && !matches!(error, ProviderRuntimeError::SessionNotFound { .. })
            {
                tracing::warn!(%error, "provider interrupt failed after cancelling provider work");
            }
        } else if !is_delivery_resolution && !route_before_admission {
            route_orchestration_command(
                &provider.provider,
                &dispatch,
                &provider.settings_root,
                command,
            )
            .await
            .map_err(provider_command_error)?;
        }
    }
    serde_json::to_value(result).map_err(|error| invalid_request(&request_tag, error.to_string()))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Durable admission explicitly carries the workspace lease, command claim, and authenticated upload owner."
)]
async fn dispatch_turn_command(
    dispatch: OrchestrationEngine,
    provider: ProviderRegistration,
    command: OrchestrationCommand,
    payload_digest: String,
    request_tag: String,
    workspace_admission: Option<crate::worktree_catalog::WorkspaceAdmissionLease>,
    command_claim: crate::orchestration::engine::CommandAdmissionClaim,
    owner: &UploadOwner,
) -> RpcResult {
    let existing_receipt = dispatch
        .repositories()
        .get_command_receipt(command.command_id().to_owned())
        .await
        .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    if existing_receipt
        .as_ref()
        .is_some_and(|receipt| receipt.payload_digest.is_none())
    {
        let result = dispatch
            .dispatch_with_command_claim(command, command_claim)
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
        return serde_json::to_value(result)
            .map_err(|error| invalid_request(&request_tag, error.to_string()));
    }

    let prepare_external = dispatch
        .reserve_generic_command_admission(&command_claim, &command, &payload_digest)
        .await
        .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    if !prepare_external {
        let result = dispatch
            .dispatch_with_admission_and_command_claim(
                command,
                CommandAdmission {
                    payload_digest,
                    attachment_refs: Vec::new(),
                    provider_turn: None,
                },
                command_claim,
                || {},
            )
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
        return serde_json::to_value(result)
            .map_err(|error| invalid_request(&request_tag, error.to_string()));
    }

    let reserved_command = command.clone();
    let reserved_digest = payload_digest.clone();
    let result = dispatch_reserved_turn_command(
        dispatch.clone(),
        provider,
        command,
        payload_digest,
        request_tag.clone(),
        workspace_admission,
        command_claim.clone(),
        owner,
    )
    .await;
    if result.is_err() {
        dispatch
            .release_generic_command_admission(&command_claim, &reserved_command, &reserved_digest)
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    }
    result
}

#[expect(
    clippy::too_many_arguments,
    reason = "Durable admission explicitly carries the workspace lease, command claim, and authenticated upload owner."
)]
async fn dispatch_reserved_turn_command(
    dispatch: OrchestrationEngine,
    provider: ProviderRegistration,
    command: OrchestrationCommand,
    payload_digest: String,
    request_tag: String,
    workspace_admission: Option<crate::worktree_catalog::WorkspaceAdmissionLease>,
    command_claim: crate::orchestration::engine::CommandAdmissionClaim,
    owner: &UploadOwner,
) -> RpcResult {
    let reusable = reusable_thread_attachments(&dispatch, &command, &request_tag).await?;
    let (mut command, prepared_batch) = prepare_attachments(
        &provider.attachments,
        command,
        &reusable,
        owner,
        &provider.uploads,
    )
    .await
    .map_err(|error| match error {
        AttachmentMaterializationError::Upload(upload) => {
            serde_json::to_value(upload).expect("upload error serializes")
        }
        other => invalid_request(&request_tag, other.to_string()),
    })?;
    let attachment_refs = prepared_batch
        .as_ref()
        .map(|batch| batch.references().to_vec())
        .unwrap_or_default();
    let mut delivery_state = crate::orchestration::TurnDeliveryState::Pending;
    if let OrchestrationCommand::ThreadTurnStart {
        thread_id,
        queued,
        model_selection,
        bootstrap,
        ..
    } = &mut command
    {
        // While a compaction is unsettled the thread counts as running, and a start sent without
        // `queued` (an older client, or one that has not seen the compaction yet) is queued too,
        // so nothing is admitted ahead of the copy a recovery sends.
        let compacting = dispatch
            .unsettled_thread_compaction(thread_id)
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?
            .is_some();
        if *queued == Some(true) || compacting {
            let session = dispatch
                .repositories()
                .get_thread_session(thread_id.clone())
                .await
                .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
            let resolved = compacting
                || session.is_some_and(|session| {
                    matches!(session.status.as_str(), "running" | "starting")
                });
            *queued = Some(resolved);
            if resolved {
                delivery_state = crate::orchestration::TurnDeliveryState::Queued;
            }
        }
        // Freeze even an omitted selection before a later thread configuration can change it.
        if model_selection.is_none() {
            *model_selection = bootstrap
                .as_deref()
                .and_then(|bootstrap| bootstrap.create_thread.as_ref())
                .map(|create| create.model_selection.clone());
            if model_selection.is_none() {
                *model_selection = dispatch
                    .repositories()
                    .get_thread(thread_id.clone())
                    .await
                    .map_err(|error| {
                        orchestration_error("OrchestrationDispatchCommandError", error)
                    })?
                    .map(|thread| thread.model_selection);
            }
        }
    }
    let (thread_id, message_id, instance_id, provider_kind, created_at) =
        turn_identity(&dispatch, &provider.settings_root, &command)
            .await
            .map_err(|error| invalid_request(&request_tag, error))?;
    let mut delivery_payload = serde_json::to_value(&command)
        .map_err(|error| invalid_request(&request_tag, error.to_string()))?;
    freeze_delivery_route(
        &dispatch,
        &provider.settings_root,
        &command,
        &mut delivery_payload,
    )
    .await
    .map_err(provider_command_error)?;
    let admission = CommandAdmission {
        payload_digest,
        attachment_refs,
        provider_turn: Some(NewProviderTurnDelivery {
            state: delivery_state,
            mode: crate::orchestration::TurnDeliveryMode::Start,
            command_id: command.command_id().to_owned(),
            thread_id,
            message_id,
            provider_instance_id: instance_id,
            provider_kind,
            provider_session_id: None,
            delivery_key: uuid::Uuid::new_v4().to_string(),
            payload: delivery_payload,
            created_at,
        }),
    };
    let turn_delivery = provider.turn_delivery.clone();
    let on_commit = move || {
        if let Some(batch) = prepared_batch {
            batch.commit();
        }
        turn_delivery.wake();
    };
    let result = if let Some(workspace_admission) = workspace_admission {
        let loss = workspace_admission.loss_cancellation();
        let commit_fence = workspace_admission.commit_fence();
        let lifetime =
            CommandLifetimeGuard::new(workspace_admission, loss.cancellation_token(), commit_fence);
        let dispatch = dispatch.dispatch_with_admission_lifetime_and_command_claim(
            command,
            admission,
            lifetime,
            command_claim,
            on_commit,
        );
        tokio::pin!(dispatch);
        tokio::select! {
            biased;
            () = loss.cancelled() => {
                let unavailable = loss
                    .unavailable()
                    .expect("workspace loss cancellation retains its error");
                return Err(workspace_admission_error(
                    WorkspaceAdmissionError::Unavailable(unavailable),
                ));
            }
            result = &mut dispatch => {
                if matches!(result, Err(OrchestrationError::Cancelled))
                    && let Some(unavailable) = loss.unavailable()
                {
                    return Err(workspace_admission_error(
                        WorkspaceAdmissionError::Unavailable(unavailable),
                    ));
                }
                result
            },
        }
    } else {
        dispatch
            .dispatch_with_admission_and_command_claim(command, admission, command_claim, on_commit)
            .await
    }
    .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    serde_json::to_value(result).map_err(|error| invalid_request(&request_tag, error.to_string()))
}

async fn turn_identity(
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: &OrchestrationCommand,
) -> Result<(String, String, String, String, String), String> {
    let OrchestrationCommand::ThreadTurnStart {
        thread_id,
        message,
        model_selection,
        bootstrap,
        created_at,
        ..
    } = command
    else {
        return Err("only turn starts have durable delivery identity".to_owned());
    };
    let thread = engine
        .repositories()
        .get_thread(thread_id.clone())
        .await
        .map_err(|error| error.to_string())?;
    let bootstrap_selection = bootstrap
        .as_deref()
        .and_then(|bootstrap| bootstrap.create_thread.as_ref())
        .map(|create| &create.model_selection);
    let selection = model_selection
        .as_ref()
        .or(bootstrap_selection)
        .or_else(|| thread.as_ref().map(|thread| &thread.model_selection))
        .ok_or_else(|| format!("turn for thread {thread_id} has no provider identity"))?;
    let instance_id = selection
        .get("instanceId")
        .and_then(Value::as_str)
        .filter(|instance_id| !instance_id.trim().is_empty())
        .ok_or_else(|| format!("turn for thread {thread_id} has no provider instanceId"))?
        .to_owned();
    let settings = ProviderSettingsStore::new(settings_root)
        .get()
        .await
        .map_err(|error| error.to_string())?;
    let driver = settings
        .provider_instances
        .get(&instance_id)
        .map(|instance| instance.driver.as_str())
        .unwrap_or(instance_id.as_str());
    let provider_kind = canonical_provider_kind(driver).map_err(|error| error.to_string())?;
    Ok((
        thread_id.clone(),
        message.message_id.clone(),
        instance_id,
        provider_kind.to_owned(),
        created_at.clone(),
    ))
}

/// The attachments a turn start may send again by id alone: those an accepted command already
/// attached in the same thread. Nothing is looked up when every attachment carries its bytes.
async fn reusable_thread_attachments(
    engine: &OrchestrationEngine,
    command: &OrchestrationCommand,
    request_tag: &str,
) -> Result<ReusableAttachments, Value> {
    let OrchestrationCommand::ThreadTurnStart {
        thread_id, message, ..
    } = command
    else {
        return Ok(ReusableAttachments::new());
    };
    let ids = id_only_attachment_ids(&message.attachments)
        .map_err(|error| invalid_request(request_tag, error.to_string()))?;
    if ids.is_empty() {
        return Ok(ReusableAttachments::new());
    }
    engine
        .repositories()
        .thread_attachment_digests(thread_id.clone(), ids)
        .await
        .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))
}

async fn prepare_attachments(
    attachments: &AttachmentMaterializer,
    mut command: OrchestrationCommand,
    reusable: &ReusableAttachments,
    owner: &UploadOwner,
    uploads: &UploadRegistry,
) -> Result<(OrchestrationCommand, Option<PreparedAttachmentBatch>), AttachmentMaterializationError>
{
    if let OrchestrationCommand::ThreadTurnStart { message, .. } = &mut command {
        if message.attachments.is_empty() {
            return Ok((command, None));
        }
        let prepared = attachments
            .prepare(
                std::mem::take(&mut message.attachments),
                reusable,
                owner,
                uploads,
            )
            .await?;
        message.attachments = prepared.attachments().to_vec();
        return Ok((command, Some(prepared)));
    }
    Ok((command, None))
}

pub(super) async fn handle_query(
    engine: &OrchestrationEngine,
    availability: Option<&WorkspaceAdmissionController>,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> RpcResult {
    match request.tag.as_str() {
        "orchestration.getArchivedShellSnapshot" => shell_snapshot(engine, true).await,
        "orchestration.getTurnDiff" => {
            let input = decode::<TurnDiffInput>(request)?;
            diff(
                engine,
                availability,
                TurnDiffRequest {
                    thread_id: input.thread_id,
                    from_turn_count: input.from_turn_count,
                    to_turn_count: input.to_turn_count,
                    ignore_whitespace: input.ignore_whitespace.unwrap_or(false),
                    context_lines: input.context_lines,
                    error_tag: "OrchestrationGetTurnDiffError",
                },
                &cancellation,
            )
            .await
        }
        "orchestration.getFullThreadDiff" => {
            let input = decode::<FullDiffInput>(request)?;
            diff(
                engine,
                availability,
                TurnDiffRequest {
                    thread_id: input.thread_id,
                    from_turn_count: 0,
                    to_turn_count: input.to_turn_count,
                    ignore_whitespace: input.ignore_whitespace.unwrap_or(false),
                    context_lines: input.context_lines,
                    error_tag: "OrchestrationGetFullThreadDiffError",
                },
                &cancellation,
            )
            .await
        }
        _ => Err(invalid_request(
            &request.tag,
            "unsupported orchestration query",
        )),
    }
}

/// A turn or full-thread patch request, decoded.
struct TurnDiffRequest {
    thread_id: String,
    from_turn_count: i64,
    to_turn_count: i64,
    ignore_whitespace: bool,
    context_lines: Option<u8>,
    /// The method's own error type.
    error_tag: &'static str,
}

/// The patch between two checkpoints, computed live from their refs under the thread's
/// workspace admission. A stored `checkpoint_diff_blobs` row for the exact range serves only
/// when a ref is gone; nothing at this version writes those rows.
async fn diff(
    engine: &OrchestrationEngine,
    availability: Option<&WorkspaceAdmissionController>,
    request: TurnDiffRequest,
    cancellation: &CancellationToken,
) -> RpcResult {
    if request.from_turn_count < 0 || request.to_turn_count < request.from_turn_count {
        return Err(invalid_request(
            "orchestration.diff",
            "turn counts must be non-negative and ordered",
        ));
    }
    crate::review::validate_review_diff_options(None, request.context_lines)
        .map_err(|error| invalid_request("orchestration.diff", error.to_string()))?;
    let tag = request.error_tag;
    // Only a captured checkpoint is a turn's end state, as for revert: a ref of a turn not
    // captured (`missing`) or given up (`error`) may hold a later checkout. Turn 0 is the ref 0
    // baseline. The start of a one-turn range is vouched for only by its end's diff: its end was
    // captured against that start as a trusted baseline.
    let one_turn = request.to_turn_count == request.from_turn_count + 1;
    for turn_count in [request.from_turn_count, request.to_turn_count] {
        if turn_count == 0 || (one_turn && turn_count == request.from_turn_count) {
            continue;
        }
        let Some(checkpoint) = engine
            .repositories()
            .get_checkpoint(request.thread_id.clone(), turn_count)
            .await
            .map_err(|error| orchestration_error(tag, error))?
            .filter(|checkpoint| checkpoint.status == "ready")
        else {
            return Err(orchestration_error(
                tag,
                super::orchestration_effects::uncaptured_diff_detail(turn_count),
            ));
        };
        if one_turn && !checkpoint.diff_available {
            return Err(orchestration_error(
                tag,
                super::orchestration_effects::no_baseline_diff_detail(turn_count),
            ));
        }
    }
    // Held until Git exits, so a removal waits for the read or cancels it.
    let (admission, workspace) = match availability {
        Some(availability) => availability
            .acquire_thread_workspace(&request.thread_id)
            .await
            .map(|(admission, workspace)| (Some(admission), workspace))
            .map_err(|error| turn_diff_admission_error(tag, error))?,
        None => (
            None,
            super::workspace_availability::persisted_workspace_path(
                &engine.repositories(),
                &request.thread_id,
            )
            .await
            .map_err(|error| turn_diff_admission_error(tag, error))?,
        ),
    };
    let live = match workspace {
        Some(workspace) => {
            let cwd = super::orchestration_effects::process_compatible_path(workspace);
            let live = live_turn_diff(&cwd, &request, cancellation);
            match admission
                .as_ref()
                .map(WorkspaceAdmissionLease::loss_cancellation)
            {
                Some(loss) => tokio::select! {
                    result = live => result?,
                    () = loss.cancelled() => {
                        return Err(turn_diff_workspace_lost(tag, &loss));
                    }
                },
                None => live.await?,
            }
        }
        None => LiveTurnDiff::MissingCheckpoint(request.from_turn_count),
    };
    let missing_turn_count = match live {
        LiveTurnDiff::Patch(patch) => {
            return Ok(turn_diff_result(
                &request,
                &patch.diff,
                patch.truncated,
                request.context_lines,
            ));
        }
        LiveTurnDiff::MissingCheckpoint(turn_count) => turn_count,
    };
    let blobs = engine
        .repositories()
        .list_checkpoint_diff_blobs_by_thread(request.thread_id.clone())
        .await
        .map_err(|error| orchestration_error(tag, error))?;
    match blobs.into_iter().find(|blob| {
        blob.from_turn_count == request.from_turn_count
            && blob.to_turn_count == request.to_turn_count
    }) {
        // A legacy row: short object IDs, and it ignores the whitespace and context options.
        Some(blob) => Ok(turn_diff_result(&request, &blob.diff, false, None)),
        None => Err(orchestration_error(
            tag,
            format!("The checkpoint for turn {missing_turn_count} is no longer in the repository."),
        )),
    }
}

/// What the checkpoint refs gave.
enum LiveTurnDiff {
    Patch(super::runtime::BoundedReviewDiff),
    /// The turn count whose checkpoint ref is gone.
    MissingCheckpoint(i64),
}

async fn live_turn_diff(
    cwd: &std::path::Path,
    request: &TurnDiffRequest,
    cancellation: &CancellationToken,
) -> Result<LiveTurnDiff, Value> {
    use super::orchestration_effects::{checkpoint_ref, ref_exists};
    use super::runtime::{ReviewDiffOptions, review_diff_args, run_review_diff};

    let tag = request.error_tag;
    let from_ref = checkpoint_ref(&request.thread_id, request.from_turn_count);
    let to_ref = checkpoint_ref(&request.thread_id, request.to_turn_count);
    for (reference, turn_count) in [
        (&from_ref, request.from_turn_count),
        (&to_ref, request.to_turn_count),
    ] {
        match ref_exists(cwd, reference, cancellation).await {
            Ok(true) => {}
            // A workspace Git cannot read has no checkpoints to compare.
            Ok(false) | Err(_) if !cancellation.is_cancelled() => {
                return Ok(LiveTurnDiff::MissingCheckpoint(turn_count));
            }
            Ok(false) | Err(_) => {
                return Err(orchestration_error(tag, "The request was cancelled."));
            }
        }
    }
    let from = format!("{from_ref}^{{commit}}");
    let to = format!("{to_ref}^{{commit}}");
    let args = review_diff_args(
        ReviewDiffOptions {
            ignore_whitespace: request.ignore_whitespace,
            context_lines: request.context_lines,
        },
        &[&from, &to],
        true,
    );
    let cwd = cwd.to_string_lossy();
    let patch = tokio::select! {
        patch = run_review_diff(&cwd, args) => {
            patch.map_err(|error| orchestration_error(tag, error))?
        }
        () = cancellation.cancelled() => {
            return Err(orchestration_error(tag, "The request was cancelled."));
        }
    };
    if !patch.succeeded && !patch.truncated {
        return Err(orchestration_error(
            tag,
            match patch.exit_code {
                Some(code) => format!("Git couldn't compare these checkpoints (exit {code})."),
                None => "Git couldn't compare these checkpoints (it was stopped).".to_owned(),
            },
        ));
    }
    Ok(LiveTurnDiff::Patch(patch))
}

fn turn_diff_result(
    request: &TurnDiffRequest,
    diff: &str,
    truncated: bool,
    context_lines: Option<u8>,
) -> Value {
    let mut result = json!({
        "threadId": request.thread_id,
        "fromTurnCount": request.from_turn_count,
        "toTurnCount": request.to_turn_count,
        "diff": diff,
        "truncated": truncated,
    });
    if let Some(lines) = context_lines {
        result["contextLines"] = json!(lines);
    }
    result
}

/// A turn read refused before Git starts. A workspace that is being removed, or is gone,
/// keeps its own error type; anything else is the method's.
fn turn_diff_admission_error(tag: &str, error: WorkspaceAdmissionError) -> Value {
    match error {
        WorkspaceAdmissionError::Unavailable(error) => {
            serde_json::to_value(error).expect("workspace unavailable error serializes")
        }
        WorkspaceAdmissionError::Identity(error) => orchestration_error(tag, error.message),
        WorkspaceAdmissionError::Resolution(error) => orchestration_error(tag, error),
    }
}

/// The workspace was fenced while Git ran; dropping its future stopped Git.
fn turn_diff_workspace_lost(tag: &str, loss: &WorkspaceAdmissionCancellation) -> Value {
    loss.unavailable().map_or_else(
        || orchestration_error(tag, "The workspace became unavailable."),
        |unavailable| {
            serde_json::to_value(unavailable).expect("workspace unavailable error serializes")
        },
    )
}

/// An uncapped shell stream for `{}`, as an old client subscribes.
#[cfg(test)]
fn shell_stream(
    engine: OrchestrationEngine,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let events = engine.subscribe_events();
    shell_stream_with_events(engine, events, cancellation)
}

/// `shell_stream` over the given event receiver; tests pass a small one to make it lag.
#[cfg(test)]
fn shell_stream_with_events(
    engine: OrchestrationEngine,
    events: broadcast::Receiver<OrchestrationEvent>,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    shell_stream_with(
        engine,
        None,
        SubscribeShellInput::default(),
        events,
        cancellation,
        default_thread_revision_keys(),
    )
}

/// `orchestration.subscribeShell`.
fn subscribe_shell(
    engine: OrchestrationEngine,
    terminals: Option<TerminalManager>,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    // Subscribe before loading the initial snapshot so an event committed in
    // between is queued for the stream instead of disappearing in that gap.
    let events = engine.subscribe_events();
    let input = if request.payload.is_null() {
        Ok(SubscribeShellInput::default())
    } else {
        decode::<SubscribeShellInput>(request)
    };
    match input {
        Ok(input) => shell_stream_with(
            engine,
            terminals.map(ShellTerminals::Manager),
            input,
            events,
            cancellation,
            default_thread_revision_keys(),
        ),
        Err(error) => {
            let (sender, receiver) = mpsc::channel(1);
            tokio::spawn(async move {
                let _ = sender.send(Err(error)).await;
            });
            receiver
        }
    }
}

/// How many thread ids a capped shell keeps on the client's word (#223).
const SHELL_INCLUDE_LIMIT: usize = 256;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SubscribeShellInput {
    /// Leave finished threads out (#223), keeping these too.
    cap: Option<ShellCapInput>,
    /// The revision and sequence of the shell the client holds.
    resume: Option<ShellResumeInput>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ShellCapInput {
    include: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellResumeInput {
    revision: String,
    snapshot_sequence: i64,
}

/// The live shell stream: a snapshot (or `unchanged` for a client that resumes the shell it
/// holds), then only what changed (#223).
/// Where a capped shell learns which threads host a live AI Terminal.
enum ShellTerminals {
    Manager(TerminalManager),
    #[cfg(test)]
    Attached(crate::terminal::TerminalMetadataAttachment),
}

fn shell_stream_with(
    engine: OrchestrationEngine,
    terminals: Option<ShellTerminals>,
    input: SubscribeShellInput,
    mut events: broadcast::Receiver<OrchestrationEvent>,
    cancellation: CancellationToken,
    keys: &'static ThreadRevisionKeys,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    tokio::spawn(async move {
        // Sending `cap` or `resume` opts into revisions; `{}` gets today's stream.
        let opted = input.cap.is_some() || input.resume.is_some();
        let include = input.cap.map(|cap| {
            cap.include
                .into_iter()
                .take(SHELL_INCLUDE_LIMIT)
                .collect::<HashSet<_>>()
        });
        let mut metadata = match (&include, terminals) {
            (Some(_), Some(ShellTerminals::Manager(terminals))) => {
                Some(terminals.subscribe_metadata().await)
            }
            #[cfg(test)]
            (Some(_), Some(ShellTerminals::Attached(attachment))) => Some(attachment),
            _ => None,
        };
        let mut hosts = TerminalAgentHosts::default();
        if let Some(metadata) = &metadata {
            hosts.reset(&metadata.initial);
        }
        let first = read_live_shell(&engine, forced_ids(include.as_ref(), None, &hosts)).await;
        let mut held = first
            .as_ref()
            .ok()
            .map(|shell| HeldShell::of(shell, &keys.fields));
        let revision_of = |held: &HeldShell| opted.then(|| held.revision(keys));
        let opened = match (&first, &held, &input.resume) {
            // The client holds exactly this shell: everything else would resend it.
            (Ok(shell), Some(current), Some(resume))
                if current.revision(keys) == resume.revision
                    && current.sequence >= resume.snapshot_sequence =>
            {
                sender
                    .send(Ok(vec![json!({
                        "kind": "unchanged",
                        "snapshotSequence": current.sequence,
                        "revision": current.revision(keys),
                        "activityAges": activity_ages(shell),
                    })]))
                    .await
                    .map_err(|_| ())
            }
            _ => {
                let revision = held.as_ref().and_then(revision_of);
                send_snapshot(&sender, first, revision).await
            }
        };
        if opened.is_err() {
            return;
        }
        // A burst of events yields one trailing update: every event changed the shell, but
        // re-sending it per event saturated slow remote links (#89).
        let mut due: Option<tokio::time::Instant> = None;
        // Lost events: send a whole snapshot rather than trust a comparison.
        let mut lagged = false;
        // Threads archived, deleted or unarchived in this window: candidates for a removal
        // item even when this client was never sent them (#223).
        let mut lifecycle = HashSet::<String>::new();
        loop {
            tokio::select! {
                () = cancellation.cancelled() => return,
                () = async { tokio::time::sleep_until(due.expect("guarded")).await }, if due.is_some() => {
                    due = None;
                    let candidates = std::mem::take(&mut lifecycle);
                    let next = read_live_shell(
                        &engine,
                        forced_ids(include.as_ref(), held.as_ref(), &hosts),
                    )
                    .await;
                    let mut next_held = next.as_ref().ok().map(|shell| HeldShell::of(shell, &keys.fields));
                    let removed = match (&held, &next_held) {
                        (Some(before), Some(after)) if include.is_some() => {
                            left_out_removals(&engine, candidates, before, after).await
                        }
                        _ => Ok(Vec::new()),
                    };
                    // Only the projects and threads that changed or left (#223): the whole
                    // list per update re-sent every thread while one streamed.
                    let delta = match (&next, &held, &mut next_held, removed) {
                        (Ok(next), Some(held), Some(next_held), Ok(removed)) if !lagged => {
                            Some(held.delta(next, next_held, &removed))
                        }
                        _ => None,
                    };
                    lagged = false;
                    let sent = match (delta, next) {
                        // Nothing changed: the client keeps what it holds, sequence included.
                        (Some(items), _) if items.is_empty() => continue,
                        (Some(mut items), _) => {
                            // The last item of a chunk carries the revision after it.
                            if let (Some(revision), Some(last)) = (
                                next_held.as_ref().and_then(revision_of),
                                items.last_mut(),
                            ) {
                                last["revision"] = json!(revision);
                            }
                            sender.send(Ok(items)).await.map_err(|_| ())
                        }
                        // A failed re-read would end the stream, and the client does not
                        // resubscribe until its session changes: keep the stream, retry, and
                        // send a whole snapshot once a read succeeds. `held` stays, so its ids
                        // stay sticky in that snapshot.
                        (None, Err(error)) => {
                            let message = error.get("message").and_then(Value::as_str);
                            tracing::warn!(error = message.unwrap_or("unknown"), "shell re-read failed; retrying");
                            due = Some(tokio::time::Instant::now() + SHELL_READ_RETRY);
                            lagged = true;
                            continue;
                        }
                        (None, Ok(next)) => {
                            let revision = next_held.as_ref().and_then(revision_of);
                            send_snapshot(&sender, Ok(next), revision).await
                        }
                    };
                    if sent.is_err() {
                        return;
                    }
                    held = next_held;
                }
                event = events.recv() => match event {
                    Ok(event) => {
                        if include.is_some()
                            && event.event.aggregate_kind == "thread"
                            && matches!(
                                event.event.event_type.as_str(),
                                "thread.archived" | "thread.deleted" | "thread.unarchived"
                            )
                        {
                            lifecycle.insert(event.event.aggregate_id.clone());
                        }
                        due.get_or_insert_with(|| tokio::time::Instant::now() + SHELL_SNAPSHOT_COALESCE);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        lagged = true;
                        due.get_or_insert_with(|| tokio::time::Instant::now() + SHELL_SNAPSHOT_COALESCE);
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                update = async { metadata.as_mut().expect("guarded").recv().await }, if metadata.is_some() => match update {
                    Some(update) => {
                        if hosts.apply(&update) {
                            due.get_or_insert_with(|| tokio::time::Instant::now() + SHELL_SNAPSHOT_COALESCE);
                        }
                    }
                    None => metadata = None,
                },
            }
        }
    });
    receiver
}

/// What a capped read must keep besides its live, card-backing and recent threads: the client's
/// ids, the threads it already holds (a capped shell never drops a thread for leaving the cap),
/// and the hosts of live AI Terminals. `None` reads the whole live shell.
fn forced_ids(
    include: Option<&HashSet<String>>,
    held: Option<&HeldShell>,
    hosts: &TerminalAgentHosts,
) -> Option<HashSet<String>> {
    let mut forced = include?.clone();
    if let Some(held) = held {
        forced.extend(held.threads.keys().cloned());
    }
    forced.extend(hosts.hosts());
    Some(forced)
}

async fn read_live_shell(
    engine: &OrchestrationEngine,
    forced: Option<HashSet<String>>,
) -> RpcResult {
    match forced {
        None => shell_snapshot(engine, false).await,
        Some(forced) => capped_shell_snapshot(engine, forced).await,
    }
}

/// The live shell capped for #223, marked `capped`, with each project's left-out counts.
async fn capped_shell_snapshot(engine: &OrchestrationEngine, forced: HashSet<String>) -> RpcResult {
    let (snapshot, older) = load_capped_shell_snapshot(&engine.repositories(), forced)
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
    let mut shell = shell_snapshot_value(&snapshot, false);
    let mut by_project = HashMap::<&str, (usize, Vec<Value>)>::new();
    for count in &older {
        let entry = by_project.entry(count.project_id.as_str()).or_default();
        match &count.chats_in {
            None => entry.0 += count.count,
            Some(worktree_path) => entry
                .1
                .push(json!({ "worktreePath": worktree_path, "count": count.count })),
        }
    }
    for project in shell["projects"].as_array_mut().into_iter().flatten() {
        let id = project["id"].as_str().unwrap_or_default().to_owned();
        if let Some((count, chats)) = by_project.remove(id.as_str()) {
            project["olderThreads"] = json!({ "count": count, "chats": chats });
        }
    }
    shell["capped"] = json!(true);
    Ok(shell)
}

/// Removal items for the window's archived, deleted or unarchived threads that the delta does
/// not cover, decided by their state now: an archive undone in the same window sends nothing.
async fn left_out_removals(
    engine: &OrchestrationEngine,
    candidates: HashSet<String>,
    before: &HeldShell,
    after: &HeldShell,
) -> Result<Vec<String>, ()> {
    let unknown = candidates
        .into_iter()
        .filter(|id| !before.threads.contains_key(id) && !after.threads.contains_key(id))
        .collect::<Vec<_>>();
    if unknown.is_empty() {
        return Ok(Vec::new());
    }
    let live = engine
        .repositories()
        .live_shell_thread_ids_among(unknown.clone())
        .await
        .map_err(|_| ())?;
    let mut removed = unknown
        .into_iter()
        .filter(|id| !live.contains(id))
        .collect::<Vec<_>>();
    removed.sort();
    Ok(removed)
}

/// Each thread's provider-progress age now, for an `unchanged` answer: a cached shell cannot
/// age what the server no longer sends.
fn activity_ages(shell: &Value) -> Value {
    Value::Object(
        shell["threads"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|thread| {
                Some((
                    thread.get("id")?.as_str()?.to_owned(),
                    thread.get("lastActivityAgeMs")?.clone(),
                ))
            })
            .collect(),
    )
}

/// The threads hosting an AI Terminal whose agent is working, blocked or waiting (#223).
#[derive(Default)]
struct TerminalAgentHosts {
    live: HashSet<(String, String)>,
}

impl TerminalAgentHosts {
    fn is_live(terminal: &TerminalSummary) -> bool {
        matches!(
            terminal.agent_status.as_ref().map(|status| &status.state),
            Some(
                TerminalAgentStatusState::Working
                    | TerminalAgentStatusState::Blocked
                    | TerminalAgentStatusState::Waiting
            )
        )
    }

    fn reset(&mut self, terminals: &[TerminalSummary]) {
        self.live = terminals
            .iter()
            .filter(|terminal| Self::is_live(terminal))
            .map(|terminal| (terminal.thread_id.clone(), terminal.terminal_id.clone()))
            .collect();
    }

    /// Applies a metadata update; true when the host set changed.
    fn apply(&mut self, update: &TerminalMetadataEvent) -> bool {
        let before = self.hosts();
        match update {
            TerminalMetadataEvent::Snapshot { terminals } => self.reset(terminals),
            TerminalMetadataEvent::Upsert { terminal } => {
                let key = (terminal.thread_id.clone(), terminal.terminal_id.clone());
                if Self::is_live(terminal) {
                    self.live.insert(key);
                } else {
                    self.live.remove(&key);
                }
            }
            TerminalMetadataEvent::Remove {
                thread_id,
                terminal_id,
                ..
            } => {
                self.live.remove(&(thread_id.clone(), terminal_id.clone()));
            }
        }
        self.hosts() != before
    }

    fn hosts(&self) -> HashSet<String> {
        self.live
            .iter()
            .map(|(thread_id, _)| thread_id.clone())
            .collect()
    }
}

/// The hosts of live AI Terminals now, for an older-threads page.
async fn terminal_agent_hosts(terminals: Option<&TerminalManager>) -> HashSet<String> {
    let mut hosts = TerminalAgentHosts::default();
    if let Some(terminals) = terminals {
        hosts.reset(&terminals.subscribe_metadata().await.initial);
    }
    hosts.hosts()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListOlderThreadsInput {
    scope: OlderThreadsScopeInput,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum OlderThreadsScopeInput {
    #[serde(rename_all = "camelCase")]
    Project {
        project_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Checkout {
        project_id: String,
        worktree_path: Option<String>,
    },
    Agents,
    Search,
}

/// An older-threads cursor: the scope it pages, and the newest-first key and id of the last
/// thread returned. Timestamps and ids only, never content.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OlderThreadsCursor {
    v: u8,
    scope: String,
    key: String,
    thread_id: String,
}

const OLDER_THREADS_ERROR: &str = "OrchestrationListOlderThreadsError";

/// `orchestration.listOlderThreads`: a page of the threads a capped shell leaves out, or of
/// every unarchived thread matching a title search (#223).
async fn list_older_threads(
    engine: &OrchestrationEngine,
    terminals: Option<&TerminalManager>,
    request: RpcRequest,
) -> RpcResult {
    use base64::Engine as _;

    let input = decode::<ListOlderThreadsInput>(request)?;
    let (scope, scope_name) = match input.scope {
        OlderThreadsScopeInput::Project { project_id } => {
            (OlderThreadsScope::Project(project_id), "project")
        }
        OlderThreadsScopeInput::Checkout {
            project_id,
            worktree_path,
        } => (
            OlderThreadsScope::Checkout(project_id, worktree_path),
            "checkout",
        ),
        OlderThreadsScopeInput::Agents => (OlderThreadsScope::Agents, "agents"),
        OlderThreadsScopeInput::Search => (OlderThreadsScope::Search, "search"),
    };
    let query = input.query.filter(|query| !query.trim().is_empty());
    if scope == OlderThreadsScope::Search && query.is_none() {
        tracing::warn!(
            method = "orchestration.listOlderThreads",
            "search without a query"
        );
        return Err(orchestration_error(
            OLDER_THREADS_ERROR,
            "A search needs a query.",
        ));
    }
    let after = match input.cursor {
        None => None,
        Some(cursor) => {
            let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(cursor.as_bytes())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<OlderThreadsCursor>(&bytes).ok())
                .filter(|cursor| cursor.v == 1 && cursor.scope == scope_name);
            let Some(cursor) = decoded else {
                tracing::warn!(
                    method = "orchestration.listOlderThreads",
                    "malformed cursor"
                );
                return Err(orchestration_error(
                    OLDER_THREADS_ERROR,
                    "The cursor is not valid.",
                ));
            };
            Some((cursor.key, cursor.thread_id))
        }
    };
    let limit = input.limit.unwrap_or(20).clamp(1, 100);
    let forced = terminal_agent_hosts(terminals).await;
    let (rows, more) = engine
        .repositories()
        .list_older_thread_rows(scope, query, after, limit, forced)
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
    let order = rows
        .threads
        .iter()
        .map(|thread| {
            (
                thread.thread_id.clone(),
                shell_recency_key(thread).to_owned(),
            )
        })
        .collect::<Vec<_>>();
    let threads = ordered_thread_shells(&shell_rows_snapshot(rows), &order);
    let cursor = more
        .then(|| order.last())
        .flatten()
        .map(|(thread_id, key)| {
            let cursor = OlderThreadsCursor {
                v: 1,
                scope: scope_name.to_owned(),
                key: key.clone(),
                thread_id: thread_id.clone(),
            };
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&cursor).expect("cursor serializes"))
        });
    Ok(json!({ "threads": threads, "cursor": cursor }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetThreadShellsInput {
    thread_ids: Vec<String>,
}

/// `orchestration.getThreadShells`: the named threads, live or archived, and the ids that are
/// gone, which is the only evidence a capped shell's client has of a deletion (#223).
async fn get_thread_shells(engine: &OrchestrationEngine, request: RpcRequest) -> RpcResult {
    let tag = request.tag.clone();
    let input = decode::<GetThreadShellsInput>(request)?;
    if input.thread_ids.is_empty() || input.thread_ids.len() > 100 {
        return Err(invalid_request(&tag, "threadIds must hold 1 to 100 ids."));
    }
    let mut ids = Vec::new();
    for id in input.thread_ids {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let rows = engine
        .repositories()
        .load_thread_shell_rows(ids.clone())
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
    let found = rows
        .threads
        .iter()
        .map(|thread| thread.thread_id.clone())
        .collect::<HashSet<_>>();
    let order = ids
        .iter()
        .filter(|id| found.contains(*id))
        .map(|id| (id.clone(), String::new()))
        .collect::<Vec<_>>();
    let threads = ordered_thread_shells(&shell_rows_snapshot(rows), &order);
    let missing = ids
        .into_iter()
        .filter(|id| !found.contains(id))
        .collect::<Vec<_>>();
    Ok(json!({ "threads": threads, "missing": missing }))
}

/// The shells of `snapshot`'s threads in `order` (ids first), aged as the shell stream sends
/// them, whether live or archived.
fn ordered_thread_shells(
    snapshot: &crate::orchestration::Snapshot,
    order: &[(String, String)],
) -> Vec<Value> {
    let previews = build_conversation_previews(snapshot);
    let by_id = snapshot
        .threads
        .iter()
        .map(|thread| (thread.thread_id.as_str(), thread))
        .collect::<HashMap<_, _>>();
    order
        .iter()
        .filter_map(|(id, _)| by_id.get(id.as_str()))
        .map(|thread| aged_thread_shell(thread, snapshot, &previews))
        .collect()
}

/// What a shell subscriber keeps of the last shell it sent: a fingerprint of each project and
/// thread by id, never the shell itself, whether it was capped, and the sequence the client
/// then holds.
struct HeldShell {
    projects: HashMap<String, u64>,
    threads: HashMap<String, u64>,
    capped: bool,
    sequence: i64,
}

impl HeldShell {
    fn of(shell: &Value, keys: &std::hash::RandomState) -> Self {
        let held = |list: &str| {
            shell[list]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let id = entry.get("id")?.as_str()?.to_owned();
                    Some((id, shell_entry_fingerprint(keys, entry)))
                })
                .collect()
        };
        Self {
            projects: held("projects"),
            threads: held("threads"),
            capped: shell["capped"] == json!(true),
            sequence: shell["snapshotSequence"].as_i64().unwrap_or(0),
        }
    }

    /// The shell's revision: a 128-bit digest, under the process's keys, of its fingerprints,
    /// ids and cap. A restart draws new keys, so an older revision never matches.
    fn revision(&self, keys: &ThreadRevisionKeys) -> String {
        use std::hash::{BuildHasher, Hasher};

        fn sorted(held: &HashMap<String, u64>) -> Vec<(&String, &u64)> {
            let mut entries = held.iter().collect::<Vec<_>>();
            entries.sort();
            entries
        }
        let (projects, threads) = (sorted(&self.projects), sorted(&self.threads));
        let digest = |state: &std::hash::RandomState| {
            let mut hasher = state.build_hasher();
            hasher.write_u8(u8::from(self.capped));
            for entries in [&projects, &threads] {
                hasher.write_usize(entries.len());
                for (id, fingerprint) in entries {
                    hasher.write_usize(id.len());
                    hasher.write(id.as_bytes());
                    hasher.write_u64(**fingerprint);
                }
            }
            hasher.finish()
        };
        format!("{:016x}{:016x}", digest(&keys.first), digest(&keys.second))
    }

    /// The items that turn this shell into `next` (held as `next_held`): upserts for the
    /// projects and threads that changed or appeared, then removals for those that left and
    /// for the left-out threads in `removed`. They take consecutive sequences ending at
    /// `next`'s, so the client's reducer, which drops an item at or below the sequence it
    /// holds, applies each one; when the window had fewer events than items (a terminal's
    /// agent started working, say), they continue past it instead, and each item past it
    /// carries the engine's sequence as `engineSequence`, which the client compares with the
    /// archived snapshot's and resumes from. `next_held` takes the last one, the sequence the
    /// client then holds.
    fn delta(&self, next: &Value, next_held: &mut Self, removed: &[String]) -> Vec<Value> {
        let mut items = Vec::new();
        // Projects first, so a new thread's project is there when the thread arrives.
        for (list, before, after, kind, field) in [
            (
                "projects",
                &self.projects,
                &next_held.projects,
                "project-upserted",
                "project",
            ),
            (
                "threads",
                &self.threads,
                &next_held.threads,
                "thread-upserted",
                "thread",
            ),
        ] {
            for entry in next[list].as_array().into_iter().flatten() {
                let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
                if before.get(id) != after.get(id) {
                    items.push(json!({ "kind": kind, field: entry }));
                }
            }
        }
        for (before, after, kind, field) in [
            (
                &self.threads,
                &next_held.threads,
                "thread-removed",
                "threadId",
            ),
            (
                &self.projects,
                &next_held.projects,
                "project-removed",
                "projectId",
            ),
        ] {
            items.extend(
                before
                    .keys()
                    .filter(|id| !after.contains_key(*id))
                    .map(|id| json!({ "kind": kind, field: id })),
            );
        }
        items.extend(
            removed
                .iter()
                .map(|id| json!({ "kind": "thread-removed", "threadId": id })),
        );
        let count = i64::try_from(items.len()).unwrap_or(i64::MAX);
        let engine_sequence = next_held.sequence;
        let first = (engine_sequence - count + 1).max(self.sequence + 1);
        for (sequence, item) in (first..).zip(&mut items) {
            item["sequence"] = json!(sequence);
            if sequence > engine_sequence {
                item["engineSequence"] = json!(engine_sequence);
            }
            next_held.sequence = sequence;
        }
        items
    }
}

/// How long a thread stream gathers its events before one update; short enough
/// for streamed assistant text to read smoothly.
const THREAD_UPDATE_COALESCE: std::time::Duration = std::time::Duration::from_millis(100);

/// What a thread subscriber keeps of the last snapshot it sent, to compute the next patch:
/// a fingerprint of each field of `thread`, and of each entry of its arrays, instead of the
/// thread itself (#101). A long session's thread is megabytes of JSON, and every open
/// subscription held its own copy for as long as it stayed open.
struct HeldThread {
    /// A random key, secret to this process: thread content comes from agents and tools, and a
    /// known key would let crafted content collide on purpose to hide an update.
    keys: std::hash::RandomState,
    fields: HashMap<String, HeldField>,
}

/// The process's secret keys for thread fingerprints and revisions. A restart draws new ones, so
/// every revision from before it mismatches and its client gets a whole snapshot.
pub(crate) struct ThreadRevisionKeys {
    fields: std::hash::RandomState,
    first: std::hash::RandomState,
    second: std::hash::RandomState,
}

impl ThreadRevisionKeys {
    fn new() -> Self {
        Self {
            fields: std::hash::RandomState::new(),
            first: std::hash::RandomState::new(),
            second: std::hash::RandomState::new(),
        }
    }
}

fn default_thread_revision_keys() -> &'static ThreadRevisionKeys {
    static KEYS: std::sync::LazyLock<ThreadRevisionKeys> =
        std::sync::LazyLock::new(ThreadRevisionKeys::new);
    &KEYS
}

enum HeldField {
    Value(u64),
    Array(Vec<u64>),
}

impl HeldThread {
    /// `None` for a snapshot without a thread, after which the next update is a snapshot.
    fn of(snapshot: &Value, keys: std::hash::RandomState) -> Option<Self> {
        let thread = snapshot.get("thread")?.as_object()?;
        let fields = thread
            .iter()
            .map(|(key, value)| {
                let held = match value {
                    Value::Array(entries) => HeldField::Array(
                        entries
                            .iter()
                            .map(|entry| fingerprint(&keys, entry))
                            .collect(),
                    ),
                    other => HeldField::Value(fingerprint(&keys, other)),
                };
                (key.clone(), held)
            })
            .collect();
        Some(Self { keys, fields })
    }

    /// The thread's revision: a 128-bit digest, under the process's keys, of the fingerprints
    /// this held state keeps. Two threads with the same revision differ only by a fingerprint
    /// collision (about 1 in 2^64 per entry), the bound patches already accept.
    fn revision(&self, keys: &ThreadRevisionKeys) -> String {
        use std::hash::{BuildHasher, Hasher};

        let mut names = self.fields.keys().collect::<Vec<_>>();
        names.sort();
        let digest = |state: &std::hash::RandomState| {
            let mut hasher = state.build_hasher();
            hasher.write_usize(names.len());
            for name in &names {
                hasher.write_usize(name.len());
                hasher.write(name.as_bytes());
                match &self.fields[*name] {
                    HeldField::Value(value) => {
                        hasher.write_u8(0);
                        hasher.write_u64(*value);
                    }
                    HeldField::Array(entries) => {
                        hasher.write_u8(1);
                        hasher.write_usize(entries.len());
                        entries.iter().for_each(|entry| hasher.write_u64(*entry));
                    }
                }
            }
            hasher.finish()
        };
        format!("{:016x}{:016x}", digest(&keys.first), digest(&keys.second))
    }
}

/// A 64-bit fingerprint of `value` under `keys`, walked like an equality check: no
/// serializing.
// ponytail: a chance collision (about 1 in 2^64 per entry) leaves that entry out of one
// patch, so the client shows it stale until it changes again; keep entries if that matters.
fn fingerprint(keys: &std::hash::RandomState, value: &Value) -> u64 {
    use std::hash::{BuildHasher, Hasher};

    fn walk(value: &Value, hasher: &mut impl Hasher) {
        match value {
            Value::Null => hasher.write_u8(0),
            Value::Bool(flag) => hasher.write_u8(1 + u8::from(*flag)),
            // Each representation its own tag: an integer and a float with the same bits
            // are different values.
            Value::Number(number) => {
                if let Some(integer) = number.as_i64() {
                    hasher.write_u8(3);
                    hasher.write_i64(integer);
                } else if let Some(integer) = number.as_u64() {
                    hasher.write_u8(4);
                    hasher.write_u64(integer);
                } else {
                    hasher.write_u8(5);
                    hasher.write_u64(number.as_f64().unwrap_or(f64::NAN).to_bits());
                }
            }
            Value::String(text) => {
                hasher.write_u8(6);
                hasher.write_usize(text.len());
                hasher.write(text.as_bytes());
            }
            Value::Array(entries) => {
                hasher.write_u8(7);
                hasher.write_usize(entries.len());
                for entry in entries {
                    walk(entry, hasher);
                }
            }
            Value::Object(fields) => {
                hasher.write_u8(8);
                hasher.write_usize(fields.len());
                for (key, field) in fields {
                    hasher.write_usize(key.len());
                    hasher.write(key.as_bytes());
                    walk(field, hasher);
                }
            }
        }
    }
    let mut hasher = keys.build_hasher();
    walk(value, &mut hasher);
    hasher.finish()
}

/// A shell project's or thread's fingerprint, without `lastActivityAgeMs`: that age grows on
/// every rebuild, and the client ages it from its own receipt of the value.
fn shell_entry_fingerprint(keys: &std::hash::RandomState, entry: &Value) -> u64 {
    use std::hash::{BuildHasher, Hasher};

    let mut hasher = keys.build_hasher();
    for (key, field) in entry.as_object().into_iter().flatten() {
        if key != "lastActivityAgeMs" {
            hasher.write_usize(key.len());
            hasher.write(key.as_bytes());
            hasher.write_u64(fingerprint(keys, field));
        }
    }
    hasher.finish()
}

/// The change from the thread snapshot a subscriber holds to `next`
/// (`{snapshotSequence, thread}`), as a `patch` stream item, or `None` when nothing changed.
/// Changed fields are replaced whole, except arrays: they send their new length and only the
/// entries that differ, by index. The client rebuilds exactly the server's next snapshot.
fn thread_patch(held: &HeldThread, next: &Value) -> Option<Value> {
    let Some(new) = next.get("thread").and_then(Value::as_object) else {
        return Some(json!({ "kind": "snapshot", "snapshot": next }));
    };
    let mut set = serde_json::Map::new();
    let mut arrays = serde_json::Map::new();
    for (key, value) in new {
        match (held.fields.get(key), value) {
            (Some(HeldField::Array(before)), Value::Array(after)) => {
                // Only the entries that differ: an appended activity or a message
                // updated in place costs one entry, wherever it sorts.
                let changes = after
                    .iter()
                    .enumerate()
                    .filter(|(index, entry)| {
                        before.get(*index) != Some(&fingerprint(&held.keys, entry))
                    })
                    .map(|(index, entry)| json!([index, entry]))
                    .collect::<Vec<_>>();
                if changes.is_empty() && before.len() == after.len() {
                    continue;
                }
                arrays.insert(
                    key.clone(),
                    json!({ "length": after.len(), "changes": changes }),
                );
            }
            (Some(HeldField::Value(before)), value)
                if !value.is_array() && *before == fingerprint(&held.keys, value) => {}
            _ => {
                set.insert(key.clone(), value.clone());
            }
        }
    }
    let unset = held
        .fields
        .keys()
        .filter(|key| !new.contains_key(*key))
        .cloned()
        .collect::<Vec<_>>();
    if set.is_empty() && arrays.is_empty() && unset.is_empty() {
        return None;
    }
    Some(json!({
        "kind": "patch",
        "snapshotSequence": next.get("snapshotSequence"),
        "patch": { "set": set, "unset": unset, "arrays": arrays },
    }))
}

/// How long the shell stream gathers events before sending one update.
const SHELL_SNAPSHOT_COALESCE: std::time::Duration = std::time::Duration::from_millis(500);
/// How long the shell stream waits to re-read after a failed read, events or not.
const SHELL_READ_RETRY: std::time::Duration = std::time::Duration::from_secs(2);

fn thread_stream(
    engine: OrchestrationEngine,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    thread_stream_with_keys(
        engine,
        request,
        cancellation,
        default_thread_revision_keys(),
    )
}

/// `thread_stream` under the given revision keys; tests pass fresh ones to stand for a restart.
fn thread_stream_with_keys(
    engine: OrchestrationEngine,
    request: RpcRequest,
    cancellation: CancellationToken,
    keys: &'static ThreadRevisionKeys,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    let input = match decode::<SubscribeThreadInput>(request) {
        Ok(input) => input,
        Err(error) => {
            tokio::spawn(async move {
                let _ = sender.send(Err(error)).await;
            });
            return receiver;
        }
    };
    // Match the shell stream's subscribe-before-snapshot ordering. Provider
    // startup can publish a session update while this snapshot is loading.
    let mut events = engine.subscribe_events();
    tokio::spawn(async move {
        // Without `history` the stream is today's, byte for byte.
        let mut window = input
            .history
            .as_ref()
            .map(thread_history::HistoryWindow::new);
        let first = match window.as_mut() {
            Some(window) => window.read(&engine, &input.thread_id).await.0,
            None => thread_snapshot(&engine, &input.thread_id).await,
        };
        // What the subscriber holds of the last snapshot, for a client that applies patches.
        let hold = |snapshot: &RpcResult| {
            snapshot
                .as_ref()
                .ok()
                .filter(|_| input.patches)
                .and_then(|snapshot| HeldThread::of(snapshot, keys.fields.clone()))
        };
        let mut held = hold(&first);
        let revision = held.as_ref().map(|held| held.revision(keys));
        // An error ends the stream; a deleted thread has no events to end the loop by (#113).
        let failed = first.is_err();
        let opened = match (&first, &revision, &input.resume) {
            // The client holds exactly this thread: everything else would resend it (#96).
            (Ok(snapshot), Some(revision), Some(resume))
                if resume.revision == *revision
                    && snapshot.get("snapshotSequence").and_then(Value::as_i64)
                        >= Some(resume.snapshot_sequence) =>
            {
                sender
                    .send(Ok(vec![json!({
                        "kind": "unchanged",
                        "snapshotSequence": snapshot.get("snapshotSequence"),
                        "revision": revision,
                    })]))
                    .await
                    .map_err(|_| ())
            }
            _ => send_snapshot(&sender, first, revision).await,
        };
        if opened.is_err() || failed {
            return;
        }
        let mut due: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                () = cancellation.cancelled() => return,
                () = async { tokio::time::sleep_until(due.expect("guarded")).await }, if due.is_some() => {
                    due = None;
                    // Every re-read, whatever woke it, checks the window's history epoch: a
                    // revert, seen or lost to `Lagged`, re-windows and sends a snapshot.
                    let (next, rewindowed) = match window.as_mut() {
                        Some(window) => window.read(&engine, &input.thread_id).await,
                        None => (thread_snapshot(&engine, &input.thread_id).await, false),
                    };
                    let next_held = hold(&next);
                    let revision = next_held.as_ref().map(|held| held.revision(keys));
                    // A whole thread per update re-sent megabytes for long threads and
                    // saturated slow remote links (#89): a client that applies patches
                    // gets only what changed since the snapshot it holds.
                    let patch = match (&next, &held) {
                        (Ok(next), Some(held)) if input.patches && !rewindowed => {
                            Some(thread_patch(held, next))
                        }
                        _ => None,
                    };
                    let sent = match patch {
                        Some(None) => Ok(()),
                        Some(Some(mut item)) => {
                            if let (Some(revision), Some(fields)) = (&revision, item.as_object_mut()) {
                                fields.insert("revision".to_owned(), json!(revision));
                            }
                            sender.send(Ok(vec![item])).await.map_err(|_| ())
                        }
                        None => send_snapshot(&sender, next.clone(), revision).await,
                    };
                    if sent.is_err() || next.is_err() {
                        return;
                    }
                    held = next_held;
                }
                event = events.recv() => match event {
                    // Lost events need no special handling: every update re-reads the
                    // projection, so the next one is exact either way.
                    Ok(event) if event.event.aggregate_kind == "thread" && event.event.aggregate_id == input.thread_id => {
                        due.get_or_insert_with(|| tokio::time::Instant::now() + THREAD_UPDATE_COALESCE);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        due.get_or_insert_with(|| tokio::time::Instant::now() + THREAD_UPDATE_COALESCE);
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
    receiver
}

/// Sends a whole-thread snapshot item, with the thread's revision for a client that resumes.
async fn send_snapshot(
    sender: &mpsc::Sender<RpcStreamChunk>,
    snapshot: RpcResult,
    revision: Option<String>,
) -> Result<(), ()> {
    sender
        .send(snapshot.map(|snapshot| {
            let mut item = json!({ "kind": "snapshot", "snapshot": snapshot });
            if let Some(revision) = revision {
                item["revision"] = json!(revision);
            }
            vec![item]
        }))
        .await
        .map_err(|_| ())
}

pub async fn shell_snapshot(engine: &OrchestrationEngine, archived: bool) -> RpcResult {
    let snapshot = load_shell_snapshot(&engine.repositories(), archived)
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
    Ok(shell_snapshot_value(&snapshot, archived))
}

/// Builds the shell wire value from any snapshot that holds the shown threads' rows.
fn shell_snapshot_value(snapshot: &crate::orchestration::Snapshot, archived: bool) -> Value {
    let sequence = snapshot
        .states
        .iter()
        .map(|state| state.last_applied_sequence)
        .max()
        .unwrap_or(0);
    let projects = snapshot
        .projects
        .iter()
        .filter(|project| project.deleted_at.is_none())
        .map(project_shell)
        .collect::<Vec<_>>();
    let previews = build_conversation_previews(snapshot);
    let threads = snapshot
        .threads
        .iter()
        .filter(|thread| thread.deleted_at.is_none() && (thread.archived_at.is_some()) == archived)
        .map(|thread| aged_thread_shell(thread, snapshot, &previews))
        .collect::<Vec<_>>();
    json!({
        "snapshotSequence": sequence,
        "projects": projects,
        "threads": threads,
        "updatedAt": now_iso(),
    })
}

/// A thread's shell as the shell stream sends it, aged on this server's clock.
fn aged_thread_shell(
    thread: &ProjectionThread,
    snapshot: &crate::orchestration::Snapshot,
    previews: &HashMap<&str, ConversationPreview>,
) -> Value {
    let mut shell = thread_shell(thread, snapshot, previews.get(thread.thread_id.as_str()));
    if let Some(age_ms) = last_activity_age_ms(thread.last_activity_at.as_deref()) {
        shell["lastActivityAgeMs"] = json!(age_ms);
    }
    shell
}

/// How old a thread's provider-progress time is on this server's clock as its shell is built,
/// so a client ages the left panel's status from its own receipt of that value instead of
/// comparing clocks with this server (#187).
fn last_activity_age_ms(last_activity_at: Option<&str>) -> Option<u64> {
    let at = OffsetDateTime::parse(last_activity_at?, &Rfc3339).ok()?;
    let age_ms = (OffsetDateTime::now_utc() - at).whole_milliseconds().max(0);
    Some(u64::try_from(age_ms).unwrap_or(u64::MAX))
}

async fn thread_snapshot(engine: &OrchestrationEngine, thread_id: &str) -> RpcResult {
    let snapshot = load_thread_snapshot(&engine.repositories(), thread_id)
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
    thread_snapshot_value(&snapshot, thread_id)
}

/// Builds the thread wire value from any snapshot that holds the thread's rows.
fn thread_snapshot_value(snapshot: &crate::orchestration::Snapshot, thread_id: &str) -> RpcResult {
    let thread = snapshot
        .threads
        .iter()
        .find(|thread| thread.thread_id == thread_id && thread.deleted_at.is_none())
        .ok_or_else(|| {
            json!({
                "_tag": "OrchestrationGetSnapshotError",
                "message": format!("Thread {thread_id} was not found"),
            })
        })?;
    let sequence = snapshot
        .states
        .iter()
        .map(|state| state.last_applied_sequence)
        .max()
        .unwrap_or(0);
    let rows = thread_detail_rows(snapshot, thread);
    let mut detail = thread_detail(thread, &rows);
    cap_checkpoint_files(&mut detail);
    // Only the thread stream carries reasoning; a client that does not know the field drops it.
    detail
        .as_object_mut()
        .expect("thread detail is an object")
        .insert(
            "reasoning".to_owned(),
            Value::Array(
                snapshot
                    .reasoning
                    .iter()
                    .filter(|row| row.thread_id == thread.thread_id)
                    .map(|row| {
                        json!({
                            "id": row.reasoning_id,
                            "turnId": row.turn_id,
                            "text": row.text,
                            "streaming": row.is_streaming,
                            "createdAt": row.created_at,
                            "updatedAt": row.updated_at,
                        })
                    })
                    .collect(),
            ),
        );
    Ok(json!({ "snapshotSequence": sequence, "thread": detail }))
}

/// The most changed files one checkpoint sends in the thread stream (#227). A turn that touched
/// thousands of files (a formatter run, a lockfile, a generated folder) made every open of its
/// thread carry all of them; the turn diff has the full list.
const CHECKPOINT_FILES_LIMIT: usize = 200;

/// Keeps the first [`CHECKPOINT_FILES_LIMIT`] files of each checkpoint, in their stored (path)
/// order so patches do not churn, and says how many there are in `filesTotal`. The HTTP read
/// model keeps every file.
fn cap_checkpoint_files(detail: &mut Value) {
    let Some(checkpoints) = detail.get_mut("checkpoints").and_then(Value::as_array_mut) else {
        return;
    };
    for checkpoint in checkpoints {
        let Some(files) = checkpoint.get_mut("files").and_then(Value::as_array_mut) else {
            continue;
        };
        let total = files.len();
        files.truncate(CHECKPOINT_FILES_LIMIT);
        checkpoint["filesTotal"] = json!(total);
    }
}

fn thread_detail(thread: &ProjectionThread, rows: &ThreadDetailRows<'_>) -> Value {
    let mut detail = thread_shell_with_records(thread, rows.latest_turn, rows.session, None);
    let object = detail.as_object_mut().expect("thread shell is an object");
    object.insert("deletedAt".to_owned(), json!(thread.deleted_at));
    object.insert(
        "messages".to_owned(),
        Value::Array(
            rows.messages
                .iter()
                .map(|row| {
                    let mut message = json!({
                        "id": row.message_id,
                        "turnId": row.turn_id,
                        "role": row.role,
                        "text": row.text,
                        "attachments": row.attachments.clone().unwrap_or_else(|| json!([])),
                        "streaming": row.is_streaming,
                        "createdAt": row.created_at,
                        "updatedAt": row.updated_at,
                    });
                    if let (Some(state), Some(provider)) =
                        (&row.delivery_state, &row.delivery_provider)
                    {
                        let mut delivery = json!({"state": state, "provider": provider});
                        if let Some(provider_instance_id) = &row.delivery_provider_instance_id {
                            delivery["providerInstanceId"] = json!(provider_instance_id);
                        }
                        if let Some(mode) = &row.delivery_mode {
                            delivery["mode"] = json!(mode);
                        }
                        if let Some(held) = row.delivery_held {
                            delivery["held"] = json!(held);
                        }
                        if let Some(detail) = &row.delivery_detail {
                            delivery["detail"] = json!(detail);
                        }
                        if let Some(reason) = &row.delivery_reason {
                            delivery["reason"] = json!(reason);
                        }
                        message["delivery"] = delivery;
                    }
                    if let Some(resend_of) = &row.resend_of_message_id {
                        message["resendOf"] = json!(resend_of);
                    }
                    // Who sent it and where from (#139, slices X1 and X4).
                    if let Some(actor) = &row.actor {
                        message["actor"] = actor.clone();
                    }
                    if let Some(source_thread_id) = &row.source_thread_id {
                        message["sourceThreadId"] = json!(source_thread_id);
                    }
                    message
                })
                .collect(),
        ),
    );
    object.insert(
        "activities".to_owned(),
        Value::Array(
            rows.activities
                .iter()
                .map(|row| {
                    json!({
                        "id": row.activity_id,
                        "turnId": row.turn_id,
                        "tone": thread_activity_tone(&row.tone),
                        "kind": row.kind,
                        "summary": row.summary,
                        "payload": row.payload,
                        "sequence": row.sequence,
                        "createdAt": row.created_at,
                    })
                })
                .collect(),
        ),
    );
    object.insert(
        "proposedPlans".to_owned(),
        Value::Array(
            rows.proposed_plans
                .iter()
                .map(|row| {
                    json!({
                        "id": row.plan_id,
                        "turnId": row.turn_id,
                        "planMarkdown": row.plan_markdown,
                        "implementedAt": row.implemented_at,
                        "implementationThreadId": row.implementation_thread_id,
                        "createdAt": row.created_at,
                        "updatedAt": row.updated_at,
                    })
                })
                .collect(),
        ),
    );
    object.insert(
        "checkpoints".to_owned(),
        Value::Array(
            rows.checkpoints
                .iter()
                .map(|row| {
                    let mut checkpoint = json!({
                        "turnId": row.turn_id,
                        "checkpointTurnCount": row.checkpoint_turn_count,
                        "checkpointRef": row.checkpoint_ref,
                        "status": row.status,
                        "files": row.files,
                        "assistantMessageId": row.assistant_message_id,
                        "completedAt": row.completed_at,
                    });
                    // Absent means true, so older clients and fixtures read it unchanged.
                    if !row.diff_available {
                        checkpoint["diffAvailable"] = json!(false);
                    }
                    checkpoint
                })
                .collect(),
        ),
    );
    detail
}

#[derive(Default)]
struct ThreadDetailRows<'a> {
    messages: Vec<&'a crate::persistence::ProjectionThreadMessage>,
    activities: Vec<&'a crate::persistence::ProjectionThreadActivity>,
    proposed_plans: Vec<&'a crate::persistence::ProjectionThreadProposedPlan>,
    checkpoints: Vec<&'a crate::orchestration::engine::ProjectionCheckpointRow>,
    session: Option<&'a crate::persistence::ProjectionThreadSession>,
    latest_turn: Option<&'a crate::persistence::ProjectionTurn>,
}

fn thread_detail_rows<'a>(
    snapshot: &'a crate::orchestration::Snapshot,
    thread: &ProjectionThread,
) -> ThreadDetailRows<'a> {
    ThreadDetailRows {
        messages: snapshot
            .messages
            .iter()
            .filter(|row| row.thread_id == thread.thread_id)
            .collect(),
        activities: snapshot
            .activities
            .iter()
            .filter(|row| row.thread_id == thread.thread_id)
            .collect(),
        proposed_plans: snapshot
            .proposed_plans
            .iter()
            .filter(|row| row.thread_id == thread.thread_id)
            .collect(),
        checkpoints: snapshot
            .checkpoints
            .iter()
            .filter(|row| row.thread_id == thread.thread_id)
            .collect(),
        session: snapshot
            .sessions
            .iter()
            .find(|row| row.thread_id == thread.thread_id),
        latest_turn: thread.latest_turn_id.as_ref().and_then(|latest_id| {
            snapshot.turns.iter().find(|row| {
                row.thread_id == thread.thread_id && row.turn_id.as_ref() == Some(latest_id)
            })
        }),
    }
}

/// Borrow each row once; an HTTP snapshot must not reload or rescan the full history per thread.
fn all_thread_detail_rows(
    snapshot: &crate::orchestration::Snapshot,
) -> HashMap<&str, ThreadDetailRows<'_>> {
    let mut rows: HashMap<&str, ThreadDetailRows<'_>> = HashMap::new();
    for row in &snapshot.messages {
        rows.entry(&row.thread_id).or_default().messages.push(row);
    }
    for row in &snapshot.activities {
        rows.entry(&row.thread_id).or_default().activities.push(row);
    }
    for row in &snapshot.proposed_plans {
        rows.entry(&row.thread_id)
            .or_default()
            .proposed_plans
            .push(row);
    }
    for row in &snapshot.checkpoints {
        rows.entry(&row.thread_id)
            .or_default()
            .checkpoints
            .push(row);
    }
    for row in &snapshot.sessions {
        let group = rows.entry(&row.thread_id).or_default();
        if group.session.is_none() {
            group.session = Some(row);
        }
    }
    let latest_ids: HashMap<&str, &str> = snapshot
        .threads
        .iter()
        .filter_map(|thread| {
            thread
                .latest_turn_id
                .as_deref()
                .map(|id| (thread.thread_id.as_str(), id))
        })
        .collect();
    for row in &snapshot.turns {
        if let Some(id) = latest_ids.get(row.thread_id.as_str())
            && row.turn_id.as_deref() == Some(*id)
        {
            let group = rows.entry(&row.thread_id).or_default();
            if group.latest_turn.is_none() {
                group.latest_turn = Some(row);
            }
        }
    }
    rows
}

fn project_shell(project: &crate::persistence::ProjectionProject) -> Value {
    json!({
        "id": project.project_id,
        "title": project.title,
        "workspaceRoot": project.workspace_root,
        "defaultModelSelection": project.default_model_selection,
        "scripts": project.scripts,
        "worktreeDiscovery": project.worktree_discovery,
        "repositoryIdentity": project.repository_identity,
        "createdAt": project.created_at,
        "updatedAt": project.updated_at,
    })
}

/// The already-declared HTTP read model includes archived/deleted records and full thread details.
/// Legacy WS null optionals stay unchanged; HTTP omits only fields declared optional, not nullable.
pub(crate) fn read_model_snapshot(
    snapshot: &crate::orchestration::Snapshot,
    updated_at: &str,
) -> Value {
    let mut grouped = all_thread_detail_rows(snapshot);
    let projects = snapshot
        .projects
        .iter()
        .map(|project| {
            let mut wire = project_shell(project);
            wire["deletedAt"] = json!(project.deleted_at);
            wire
        })
        .collect::<Vec<_>>();
    let threads = snapshot
        .threads
        .iter()
        .map(|thread| {
            let rows = grouped
                .remove(thread.thread_id.as_str())
                .unwrap_or_default();
            let mut wire = thread_detail(thread, &rows);
            if let Some(turn) = wire.get_mut("latestTurn").and_then(Value::as_object_mut)
                && turn.get("sourceProposedPlan").is_some_and(Value::is_null)
            {
                turn.remove("sourceProposedPlan");
            }
            if let Some(session) = wire.get_mut("session").and_then(Value::as_object_mut)
                && session
                    .get("providerInstanceId")
                    .is_some_and(Value::is_null)
            {
                session.remove("providerInstanceId");
            }
            wire
        })
        .collect::<Vec<_>>();
    json!({
        "snapshotSequence": snapshot.states.iter().map(|state| state.last_applied_sequence).max().unwrap_or(0),
        "projects": projects,
        "threads": threads,
        "updatedAt": updated_at,
    })
}

fn thread_activity_tone(tone: &str) -> &str {
    match tone {
        // `warning` must be listed: this whitelist is the last hop before the
        // client, so omitting it silently downgraded provider warnings to
        // `info` and the new tone never arrived.
        "info" | "tool" | "approval" | "warning" | "error" => tone,
        _ => "info",
    }
}

const PREVIEW_PROMPT_MAX_CHARS: usize = 200;
const PREVIEW_TOOL_MAX_CHARS: usize = 160;
const PREVIEW_ASSISTANT_MAX_CHARS: usize = 320;

#[derive(Debug, Default)]
struct ConversationPreview {
    prompt: Option<String>,
    tool: Option<String>,
    assistant_message: Option<String>,
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

/// One pass over messages and activities so shell building stays
/// O(messages + activities + threads) even though every coalesced shell update
/// re-reads the whole live shell.
fn build_conversation_previews(
    snapshot: &crate::orchestration::Snapshot,
) -> HashMap<&str, ConversationPreview> {
    let mut previews: HashMap<&str, ConversationPreview> = HashMap::new();
    let mut newest_user: HashMap<&str, &crate::persistence::ProjectionThreadMessage> =
        HashMap::new();
    let mut newest_assistant: HashMap<&str, &crate::persistence::ProjectionThreadMessage> =
        HashMap::new();
    for message in &snapshot.messages {
        let bucket = match message.role.as_str() {
            "user" => &mut newest_user,
            "assistant" => &mut newest_assistant,
            _ => continue,
        };
        match bucket.get(message.thread_id.as_str()) {
            Some(existing) if existing.created_at > message.created_at => {}
            _ => {
                bucket.insert(message.thread_id.as_str(), message);
            }
        }
    }
    let turn_states: HashMap<(&str, &str), &str> = snapshot
        .turns
        .iter()
        .filter_map(|turn| {
            Some((
                (turn.thread_id.as_str(), turn.turn_id.as_deref()?),
                turn.state.as_str(),
            ))
        })
        .collect();
    let running_latest_turn: HashMap<&str, &str> = snapshot
        .threads
        .iter()
        .filter_map(|thread| {
            let latest_id = thread.latest_turn_id.as_deref()?;
            (turn_states.get(&(thread.thread_id.as_str(), latest_id)) == Some(&"running"))
                .then_some((thread.thread_id.as_str(), latest_id))
        })
        .collect();
    let mut newest_tool: HashMap<&str, &crate::persistence::ProjectionThreadActivity> =
        HashMap::new();
    for activity in &snapshot.activities {
        if activity.tone != "tool" {
            continue;
        }
        let Some(latest_id) = running_latest_turn.get(activity.thread_id.as_str()) else {
            continue;
        };
        if activity.turn_id.as_deref() != Some(latest_id) {
            continue;
        }
        match newest_tool.get(activity.thread_id.as_str()) {
            Some(existing) if existing.created_at > activity.created_at => {}
            _ => {
                newest_tool.insert(activity.thread_id.as_str(), activity);
            }
        }
    }
    for (thread_id, message) in newest_user {
        let text = message.text.trim();
        if text.is_empty() {
            continue;
        }
        previews.entry(thread_id).or_default().prompt =
            Some(truncate_preview(text, PREVIEW_PROMPT_MAX_CHARS));
    }
    for (thread_id, message) in newest_assistant {
        let text = message.text.trim();
        if text.is_empty() {
            continue;
        }
        previews.entry(thread_id).or_default().assistant_message =
            Some(truncate_preview(text, PREVIEW_ASSISTANT_MAX_CHARS));
    }
    for (thread_id, activity) in newest_tool {
        let summary = activity.summary.trim();
        if summary.is_empty() {
            continue;
        }
        previews.entry(thread_id).or_default().tool =
            Some(truncate_preview(summary, PREVIEW_TOOL_MAX_CHARS));
    }
    previews
}

fn thread_shell(
    thread: &ProjectionThread,
    snapshot: &crate::orchestration::Snapshot,
    preview: Option<&ConversationPreview>,
) -> Value {
    let latest_turn = thread.latest_turn_id.as_ref().and_then(|latest_id| {
        snapshot.turns.iter().find(|turn| {
            turn.thread_id == thread.thread_id && turn.turn_id.as_ref() == Some(latest_id)
        })
    });
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.thread_id == thread.thread_id);
    thread_shell_with_records(thread, latest_turn, session, preview)
}

/// The thread's unsettled compaction on the wire: its trigger, state and the message a recovery
/// sends again.
fn thread_compaction_value(thread: &ProjectionThread) -> Option<Value> {
    let compaction = thread.compaction.as_ref()?;
    let mut value = json!({
        "trigger": compaction.get("trigger")?,
        "state": compaction.get("state")?,
    });
    if let Some(failed_message_id) = compaction
        .get("failedMessageId")
        .filter(|value| value.is_string())
    {
        value["failedMessageId"] = failed_message_id.clone();
    }
    Some(value)
}

fn thread_shell_with_records(
    thread: &ProjectionThread,
    latest_turn: Option<&crate::persistence::ProjectionTurn>,
    session: Option<&crate::persistence::ProjectionThreadSession>,
    preview: Option<&ConversationPreview>,
) -> Value {
    let latest_turn = latest_turn.map(|turn| json!({
                "turnId": turn.turn_id,
                "state": turn.state,
                "requestedAt": turn.requested_at,
                "startedAt": turn.started_at,
                "completedAt": turn.completed_at,
                "assistantMessageId": turn.assistant_message_id,
                "sourceProposedPlan": match (&turn.source_proposed_plan_thread_id, &turn.source_proposed_plan_id) {
                    (Some(thread_id), Some(plan_id)) => Some(json!({ "threadId": thread_id, "planId": plan_id })),
                    _ => None,
                },
            }))
    ;
    let session = session.map(|session| {
        json!({
            "threadId": session.thread_id,
            "status": session.status,
            "providerName": session.provider_name,
            "providerInstanceId": session.provider_instance_id,
            "runtimeMode": session.runtime_mode,
            "activeTurnId": session.active_turn_id,
            "lastError": session.last_error,
            "lastErrorClass": session.last_error_class,
            "updatedAt": session.updated_at,
        })
    });
    let mut shell = json!({
        "id": thread.thread_id,
        "projectId": thread.project_id,
        "title": thread.title,
        "modelSelection": thread.model_selection,
        "runtimeMode": thread.runtime_mode,
        "interactionMode": thread.interaction_mode,
        "kind": thread.kind,
        "branch": thread.branch,
        "worktreePath": thread.worktree_path,
        "latestTurn": latest_turn,
        "createdAt": thread.created_at,
        "updatedAt": thread.updated_at,
        "archivedAt": thread.archived_at,
        "session": session,
        "latestUserMessageAt": thread.latest_user_message_at,
        "hasPendingApprovals": thread.pending_approval_count > 0,
        "hasPendingUserInput": thread.pending_user_input_count > 0,
        "hasActionableProposedPlan": thread.has_actionable_proposed_plan != 0,
        "unresolvedDelivery": thread.unresolved_delivery_state.as_ref().map(|state| {
            json!({ "state": state, "detail": thread.unresolved_delivery_detail })
        }),
    });
    if let Some(compaction) = thread_compaction_value(thread) {
        shell["compaction"] = compaction;
    }
    if let Some(host_thread_id) = &thread.host_thread_id {
        shell["hostThreadId"] = json!(host_thread_id);
    }
    if thread.side_chat {
        shell["sideChat"] = json!(true);
    }
    if let Some(requester) = &thread.requester {
        shell["requester"] = requester.clone();
    }
    if let Some(last_activity_at) = &thread.last_activity_at {
        shell["lastActivityAt"] = json!(last_activity_at);
    }
    if let Some(preview) = preview {
        shell["conversationPreview"] = json!({
            "prompt": preview.prompt,
            "tool": preview.tool,
            "assistantMessage": preview.assistant_message,
        });
    }
    shell
}

pub fn wire_event(row: &OrchestrationEvent) -> Value {
    json!({
        "sequence": row.sequence,
        "eventId": row.event.event_id,
        "type": row.event.event_type,
        "aggregateKind": row.event.aggregate_kind,
        "aggregateId": row.event.aggregate_id,
        "occurredAt": row.event.occurred_at,
        "commandId": row.event.command_id,
        "causationEventId": row.event.causation_event_id,
        "correlationId": row.event.correlation_id,
        "payload": row.event.payload,
        "metadata": row.event.metadata,
    })
}

/// Controls byte limits for paged and whole-tail replay reads.
enum ReplayBudget {
    /// Stops before an event would exceed `target_bytes`, always keeping the first event.
    Page { target_bytes: usize },
    /// Returns the whole tail or fails as soon as counted bytes exceed `limit_bytes`.
    Whole { limit_bytes: usize },
}

#[derive(Debug)]
struct ReplayRead {
    events: Vec<Value>,
    exhausted: bool,
}

#[derive(Debug, thiserror::Error)]
enum ReplayReadError {
    #[error(transparent)]
    Persistence(#[from] PersistenceError),
    #[error(transparent)]
    Count(#[from] serde_json::Error),
    #[error("encoded replay JSON is too large to count")]
    CountOverflow,
    #[error("replay events exceed {limit_bytes} bytes ({bytes} bytes read)")]
    TooLarge { bytes: usize, limit_bytes: usize },
}

/// Reads one batch at a time and counts only event JSON, array brackets and commas.
/// Unpaged oversize bytes are the running total at the crossing, a lower bound;
/// the session's size check remains the backstop for the uncounted Exit envelope.
/// Paged reads always retain their first event, even over the target. A single
/// event over the connection's message limit is left to `send_server_message`'s
/// own size check and `RpcResponseTooLargeError`.
async fn read_replay(
    repositories: &Repositories,
    from_sequence_exclusive: i64,
    budget: ReplayBudget,
) -> Result<ReplayRead, ReplayReadError> {
    let mut pages = repositories.event_pages(from_sequence_exclusive);
    let mut events = Vec::new();
    let mut total = 2_usize; // JSON array brackets
    while let Some(batch) = pages.next_page().await? {
        let last_batch = batch.len() < EVENT_PAGE_SIZE;
        for row in batch {
            let event = wire_event(&row);
            let event_bytes = encoded_json_len(&event)?;
            let next_total = total
                .checked_add(event_bytes)
                .and_then(|bytes| bytes.checked_add(usize::from(!events.is_empty())))
                .ok_or(ReplayReadError::CountOverflow)?;
            match budget {
                ReplayBudget::Page { target_bytes }
                    if !events.is_empty() && next_total > target_bytes =>
                {
                    return Ok(ReplayRead {
                        events,
                        exhausted: false,
                    });
                }
                ReplayBudget::Whole { limit_bytes } if next_total > limit_bytes => {
                    return Err(ReplayReadError::TooLarge {
                        bytes: next_total,
                        limit_bytes,
                    });
                }
                _ => {}
            }
            total = next_total;
            events.push(event);
        }
        if last_batch {
            break;
        }
    }
    Ok(ReplayRead {
        events,
        exhausted: true,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCheckpointRevertInput {
    thread_id: String,
    turn_count: i64,
}

/// `orchestration.previewCheckpointRevert` (#279): what a revert would do in a checkout other
/// chats may share, read before the dialog. Advisory; the effects worker checks again.
async fn preview_checkpoint_revert(
    engine: &OrchestrationEngine,
    provider: Option<&ProviderRegistration>,
    request: RpcRequest,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Value, Value> {
    let input = decode::<PreviewCheckpointRevertInput>(request)?;
    let probe =
        provider.map(
            |provider| crate::production::provider_runtime::SupervisorRevertProbe {
                supervisor: &provider.provider,
                settings_root: &provider.settings_root,
                engine,
            },
        );
    crate::production::orchestration_effects::preview_checkpoint_revert(
        engine,
        probe
            .as_ref()
            .map(|probe| probe as &dyn crate::production::orchestration_effects::RevertProbe),
        &input.thread_id,
        input.turn_count,
        cancellation,
    )
    .await
    .map_err(|error| orchestration_error("OrchestrationPreviewCheckpointRevertError", error))
}

fn decode<T: for<'de> Deserialize<'de>>(request: RpcRequest) -> Result<T, Value> {
    serde_json::from_value(request.payload)
        .map_err(|error| invalid_request(&request.tag, error.to_string()))
}

fn invalid_request(method: &str, message: impl Into<String>) -> Value {
    json!({ "_tag": "InvalidRequest", "method": method, "message": message.into() })
}

fn orchestration_error(tag: &str, error: impl std::fmt::Display) -> Value {
    json!({ "_tag": tag, "message": error.to_string() })
}

fn workspace_admission_error(error: WorkspaceAdmissionError) -> Value {
    match error {
        WorkspaceAdmissionError::Unavailable(error) => {
            serde_json::to_value(error).expect("workspace unavailable error serializes")
        }
        WorkspaceAdmissionError::Identity(error) => {
            serde_json::to_value(error).expect("workspace identity error serializes")
        }
        WorkspaceAdmissionError::Resolution(error) => {
            orchestration_error("OrchestrationDispatchCommandError", error)
        }
    }
}

fn provider_command_error(error: impl std::fmt::Display) -> Value {
    orchestration_error("OrchestrationDispatchCommandError", error)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayInput {
    from_sequence_exclusive: i64,
    #[serde(default)]
    paged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeThreadInput {
    thread_id: String,
    /// The client applies `patch` items; without it every update is a snapshot.
    #[serde(default)]
    patches: bool,
    /// The last revision the client applied; older clients omit it.
    #[serde(default)]
    resume: Option<ResumeThreadInput>,
    /// The client opens a history window (#226); older clients omit it and get the whole thread.
    #[serde(default)]
    history: Option<thread_history::HistoryInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeThreadInput {
    revision: String,
    snapshot_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnDiffInput {
    thread_id: String,
    from_turn_count: i64,
    to_turn_count: i64,
    #[serde(default)]
    ignore_whitespace: Option<bool>,
    /// `-U<N>` for the patch, from 0 to 99; omitted, Git's own default applies.
    #[serde(default)]
    context_lines: Option<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullDiffInput {
    thread_id: String,
    to_turn_count: i64,
    #[serde(default)]
    ignore_whitespace: Option<bool>,
    #[serde(default)]
    context_lines: Option<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #101: a subscriber keeps fingerprints; a number that changes representation, but not
    /// its bits, is still a change.
    #[test]
    fn a_patch_sees_a_number_change_its_representation() {
        let held = json!({ "snapshotSequence": 1, "thread": { "activities": [
            { "id": "a", "payload": { "n": 4_609_434_218_613_702_656_i64 } },
        ] } });
        let next = json!({ "snapshotSequence": 2, "thread": { "activities": [
            { "id": "a", "payload": { "n": 1.5 } },
        ] } });
        let patch = thread_patch(
            &HeldThread::of(&held, std::hash::RandomState::new()).expect("a thread"),
            &next,
        )
        .expect("the number changed");
        assert_eq!(
            patch["patch"]["arrays"]["activities"]["changes"],
            json!([[0, next["thread"]["activities"][0]]])
        );
        assert_eq!(
            thread_patch(
                &HeldThread::of(&next, std::hash::RandomState::new()).expect("a thread"),
                &next
            ),
            None
        );
    }
    fn test_upload_registry() -> UploadRegistry {
        UploadRegistry::new(
            std::env::temp_dir().join(format!("bibcode-test-uploads-{}", uuid::Uuid::new_v4())),
            crate::transfer::staging::UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        )
    }

    use crate::{
        RequestId, RpcExit, ServerConfig, ServerMessage, ServerRuntime,
        activity::{ActivityProjection, ActivityRepository},
        orchestration::{
            AttachmentReference, NewProviderTurnDelivery, Snapshot, TurnDeliveryState,
            TurnDeliveryTransition,
            engine::{EngineOptions, TestHooks},
            load_snapshot,
        },
        persistence::{
            Database, NewOrchestrationEvent, ProjectionThreadActivity, ProjectionThreadMessage,
            ProjectionTurn, run_migrations,
        },
        production::{
            provider_runtime::{
                BoxRuntimeFuture, ProviderDriver, ProviderDriverFactory, ProviderEvent,
                ProviderLaunchRequest, ProviderRuntimeError, StartedSession, SupervisorOptions,
            },
            turn_delivery::DeliveryRouter,
        },
        provider::attachments::AttachmentPrepareTestPause,
        worktree_catalog::{
            AdoptedWorktreeAvailability, WorkspaceAvailabilityRegistry, WorkspaceLossTransition,
        },
    };
    use futures_util::SinkExt;
    use std::sync::atomic::AtomicUsize;
    use tokio_tungstenite::tungstenite::Message;

    use crate::test_support::websocket_frames::next_frame_past_heartbeat;

    const CREATED_AT: &str = "2026-07-11T00:00:00.000Z";

    fn preview_snapshot_fixture(latest_turn_state: &str) -> Snapshot {
        Snapshot {
            projects: Vec::new(),
            threads: vec![ProjectionThread {
                thread_id: "thread-1".to_owned(),
                project_id: "project-1".to_owned(),
                title: "Preview thread".to_owned(),
                kind: "default".to_owned(),
                model_selection: json!({"instanceId": "codex", "model": "gpt-5"}),
                runtime_mode: "full-access".to_owned(),
                interaction_mode: "default".to_owned(),
                branch: None,
                worktree_path: None,
                latest_turn_id: Some("turn-2".to_owned()),
                created_at: "2026-07-11T00:00:00.000Z".to_owned(),
                updated_at: "2026-07-11T00:00:00.007Z".to_owned(),
                archived_at: None,
                latest_user_message_at: Some("2026-07-11T00:00:00.004Z".to_owned()),
                pending_approval_count: 0,
                pending_user_input_count: 0,
                last_activity_at: None,
                requester: None,
                side_chat: false,
                has_actionable_proposed_plan: 0,
                unresolved_delivery_state: None,
                unresolved_delivery_detail: None,
                deleted_at: None,
                host_thread_id: None,
                compaction: None,
            }],
            messages: vec![
                ProjectionThreadMessage {
                    message_id: "message-user-older".to_owned(),
                    thread_id: "thread-1".to_owned(),
                    turn_id: Some("turn-1".to_owned()),
                    role: "user".to_owned(),
                    text: "older prompt".to_owned(),
                    attachments: None,
                    is_streaming: false,
                    delivery_state: None,
                    delivery_provider: None,
                    delivery_provider_instance_id: None,
                    delivery_detail: None,
                    delivery_reason: None,
                    delivery_mode: None,
                    delivery_held: None,
                    resend_of_message_id: None,
                    actor: None,
                    source_thread_id: None,
                    created_at: "2026-07-11T00:00:00.000Z".to_owned(),
                    updated_at: "2026-07-11T00:00:00.000Z".to_owned(),
                },
                ProjectionThreadMessage {
                    message_id: "message-assistant-older".to_owned(),
                    thread_id: "thread-1".to_owned(),
                    turn_id: Some("turn-1".to_owned()),
                    role: "assistant".to_owned(),
                    text: "older assistant".to_owned(),
                    attachments: None,
                    is_streaming: false,
                    delivery_state: None,
                    delivery_provider: None,
                    delivery_provider_instance_id: None,
                    delivery_detail: None,
                    delivery_reason: None,
                    delivery_mode: None,
                    delivery_held: None,
                    resend_of_message_id: None,
                    actor: None,
                    source_thread_id: None,
                    created_at: "2026-07-11T00:00:00.001Z".to_owned(),
                    updated_at: "2026-07-11T00:00:00.001Z".to_owned(),
                },
                ProjectionThreadMessage {
                    message_id: "message-user-newer".to_owned(),
                    thread_id: "thread-1".to_owned(),
                    turn_id: Some("turn-2".to_owned()),
                    role: "user".to_owned(),
                    text: "newest user prompt".to_owned(),
                    attachments: None,
                    is_streaming: false,
                    delivery_state: None,
                    delivery_provider: None,
                    delivery_provider_instance_id: None,
                    delivery_detail: None,
                    delivery_reason: None,
                    delivery_mode: None,
                    delivery_held: None,
                    resend_of_message_id: None,
                    actor: None,
                    source_thread_id: None,
                    created_at: "2026-07-11T00:00:00.002Z".to_owned(),
                    updated_at: "2026-07-11T00:00:00.002Z".to_owned(),
                },
                ProjectionThreadMessage {
                    message_id: "message-assistant-newer".to_owned(),
                    thread_id: "thread-1".to_owned(),
                    turn_id: Some("turn-2".to_owned()),
                    role: "assistant".to_owned(),
                    text: "newest assistant text".to_owned(),
                    attachments: None,
                    is_streaming: false,
                    delivery_state: None,
                    delivery_provider: None,
                    delivery_provider_instance_id: None,
                    delivery_detail: None,
                    delivery_reason: None,
                    delivery_mode: None,
                    delivery_held: None,
                    resend_of_message_id: None,
                    actor: None,
                    source_thread_id: None,
                    created_at: "2026-07-11T00:00:00.003Z".to_owned(),
                    updated_at: "2026-07-11T00:00:00.003Z".to_owned(),
                },
                ProjectionThreadMessage {
                    message_id: "message-user-newest".to_owned(),
                    thread_id: "thread-1".to_owned(),
                    turn_id: Some("turn-2".to_owned()),
                    role: "user".to_owned(),
                    text: "  padded prompt \n".to_owned(),
                    attachments: None,
                    is_streaming: false,
                    delivery_state: None,
                    delivery_provider: None,
                    delivery_provider_instance_id: None,
                    delivery_detail: None,
                    delivery_reason: None,
                    delivery_mode: None,
                    delivery_held: None,
                    resend_of_message_id: None,
                    actor: None,
                    source_thread_id: None,
                    created_at: "2026-07-11T00:00:00.004Z".to_owned(),
                    updated_at: "2026-07-11T00:00:00.004Z".to_owned(),
                },
                ProjectionThreadMessage {
                    message_id: "message-assistant-newest".to_owned(),
                    thread_id: "thread-1".to_owned(),
                    turn_id: Some("turn-2".to_owned()),
                    role: "assistant".to_owned(),
                    text: " \n\t".to_owned(),
                    attachments: None,
                    is_streaming: true,
                    delivery_state: None,
                    delivery_provider: None,
                    delivery_provider_instance_id: None,
                    delivery_detail: None,
                    delivery_reason: None,
                    delivery_mode: None,
                    delivery_held: None,
                    resend_of_message_id: None,
                    actor: None,
                    source_thread_id: None,
                    created_at: "2026-07-11T00:00:00.005Z".to_owned(),
                    updated_at: "2026-07-11T00:00:00.005Z".to_owned(),
                },
            ],
            reasoning: Vec::new(),
            activities: vec![ProjectionThreadActivity {
                activity_id: "activity-tool".to_owned(),
                thread_id: "thread-1".to_owned(),
                turn_id: Some("turn-2".to_owned()),
                tone: "tool".to_owned(),
                kind: "tool".to_owned(),
                summary: "Edit: src/main.rs".to_owned(),
                payload: json!({}),
                sequence: Some(1),
                created_at: "2026-07-11T00:00:00.006Z".to_owned(),
            }],
            sessions: Vec::new(),
            approvals: Vec::new(),
            proposed_plans: Vec::new(),
            turns: vec![ProjectionTurn {
                thread_id: "thread-1".to_owned(),
                turn_id: Some("turn-2".to_owned()),
                pending_message_id: None,
                source_proposed_plan_thread_id: None,
                source_proposed_plan_id: None,
                assistant_message_id: None,
                state: latest_turn_state.to_owned(),
                requested_at: "2026-07-11T00:00:00.002Z".to_owned(),
                started_at: Some("2026-07-11T00:00:00.003Z".to_owned()),
                completed_at: None,
                checkpoint_turn_count: None,
                checkpoint_ref: None,
                checkpoint_status: None,
                checkpoint_files: json!([]),
            }],
            checkpoints: Vec::new(),
            states: Vec::new(),
            receipts: Vec::new(),
            diffs: Vec::new(),
        }
    }

    #[test]
    fn conversation_preview_truncates_on_char_boundary() {
        let text = "é".repeat(300);
        let truncated = truncate_preview(&text, 200);
        assert_eq!(truncated.chars().count(), 201);
        assert!(truncated.ends_with('…'));
        assert_eq!(truncate_preview("short", 200), "short");
    }

    #[test]
    fn conversation_preview_picks_newest_rows_and_gates_tool_on_running_turn() {
        let snapshot = preview_snapshot_fixture("running");
        let previews = build_conversation_previews(&snapshot);
        let preview = previews.get("thread-1").expect("preview for thread-1");
        assert_eq!(preview.prompt.as_deref(), Some("padded prompt"));
        assert_eq!(preview.assistant_message, None);
        assert_eq!(preview.tool.as_deref(), Some("Edit: src/main.rs"));

        let done = preview_snapshot_fixture("completed");
        let previews = build_conversation_previews(&done);
        assert_eq!(previews.get("thread-1").expect("preview").tool, None);
    }

    #[test]
    fn shell_snapshot_ages_provider_progress_on_the_server_clock() {
        // Mutation caught: the shell dropping `lastActivityAgeMs`, or aging it from a clock the
        // client does not share, so the left panel's freshness compares two clocks (#187).
        let mut snapshot = preview_snapshot_fixture("running");
        let shell = shell_snapshot_value(&snapshot, false);
        assert!(
            shell["threads"][0].get("lastActivityAgeMs").is_none(),
            "a thread with no provider progress carries no age"
        );

        let at = OffsetDateTime::now_utc() - time::Duration::seconds(90);
        snapshot.threads[0].last_activity_at = Some(at.format(&Rfc3339).unwrap());
        let shell = shell_snapshot_value(&snapshot, false);
        let age_ms = shell["threads"][0]["lastActivityAgeMs"]
            .as_u64()
            .expect("an age in whole milliseconds");
        assert!((90_000..120_000).contains(&age_ms), "{age_ms}");

        let future = OffsetDateTime::now_utc() + time::Duration::minutes(5);
        snapshot.threads[0].last_activity_at = Some(future.format(&Rfc3339).unwrap());
        assert_eq!(
            shell_snapshot_value(&snapshot, false)["threads"][0]["lastActivityAgeMs"],
            0,
            "a time ahead of this clock is fresh, never negative"
        );
        snapshot.threads[0].last_activity_at = Some("not a time".to_owned());
        assert!(
            shell_snapshot_value(&snapshot, false)["threads"][0]
                .get("lastActivityAgeMs")
                .is_none()
        );
    }

    #[test]
    fn thread_shell_embeds_preview_and_detail_omits_it() {
        let snapshot = preview_snapshot_fixture("running");
        let previews = build_conversation_previews(&snapshot);
        let thread = &snapshot.threads[0];
        let with = thread_shell(thread, &snapshot, previews.get(thread.thread_id.as_str()));
        assert_eq!(
            with["conversationPreview"]["prompt"],
            serde_json::json!("padded prompt")
        );
        let without = thread_shell(thread, &snapshot, None);
        assert!(without.get("conversationPreview").is_none());
    }

    #[test]
    fn thread_shell_marks_only_a_side_chat() {
        let snapshot = preview_snapshot_fixture("running");
        let mut thread = snapshot.threads[0].clone();
        assert!(
            thread_shell(&thread, &snapshot, None)
                .get("sideChat")
                .is_none()
        );
        thread.side_chat = true;
        assert_eq!(
            thread_shell(&thread, &snapshot, None)["sideChat"],
            serde_json::json!(true)
        );
    }

    fn store_thread(
        thread_id: &str,
        project_id: &str,
        latest_turn_id: Option<&str>,
    ) -> ProjectionThread {
        let mut thread = preview_snapshot_fixture("running").threads.remove(0);
        thread.thread_id = thread_id.to_owned();
        thread.project_id = project_id.to_owned();
        thread.title = thread_id.to_owned();
        thread.latest_turn_id = latest_turn_id.map(str::to_owned);
        thread
    }

    fn store_message(
        message_id: &str,
        thread_id: &str,
        role: &str,
        text: &str,
        created_at: &str,
    ) -> ProjectionThreadMessage {
        ProjectionThreadMessage {
            message_id: message_id.to_owned(),
            thread_id: thread_id.to_owned(),
            turn_id: None,
            role: role.to_owned(),
            text: text.to_owned(),
            attachments: None,
            is_streaming: false,
            delivery_state: None,
            delivery_provider: None,
            delivery_provider_instance_id: None,
            delivery_detail: None,
            delivery_reason: None,
            delivery_mode: None,
            delivery_held: None,
            resend_of_message_id: None,
            actor: None,
            source_thread_id: None,
            created_at: created_at.to_owned(),
            updated_at: created_at.to_owned(),
        }
    }

    fn store_activity(
        activity_id: &str,
        thread_id: &str,
        turn_id: &str,
        tone: &str,
        sequence: Option<i64>,
        created_at: &str,
    ) -> ProjectionThreadActivity {
        ProjectionThreadActivity {
            activity_id: activity_id.to_owned(),
            thread_id: thread_id.to_owned(),
            turn_id: Some(turn_id.to_owned()),
            tone: tone.to_owned(),
            kind: "tool.completed".to_owned(),
            summary: format!("summary {activity_id}"),
            payload: json!({ "activity": activity_id }),
            sequence,
            created_at: created_at.to_owned(),
        }
    }

    fn store_turn(
        thread_id: &str,
        turn_id: &str,
        state: &str,
    ) -> crate::persistence::ProjectionTurnById {
        crate::persistence::ProjectionTurnById {
            thread_id: thread_id.to_owned(),
            turn_id: turn_id.to_owned(),
            pending_message_id: None,
            source_proposed_plan_thread_id: None,
            source_proposed_plan_id: None,
            assistant_message_id: None,
            state: state.to_owned(),
            requested_at: "2026-07-11T00:00:01.000Z".to_owned(),
            started_at: Some("2026-07-11T00:00:01.000Z".to_owned()),
            completed_at: None,
            checkpoint_turn_count: None,
            checkpoint_ref: None,
            checkpoint_status: None,
            checkpoint_files: json!([]),
        }
    }

    /// A store with every shape the shell and thread snapshots distinguish: live, archived,
    /// deleted, panel and project-less threads, a deleted project, tied timestamps, queued
    /// messages, a running turn with tool activities, and history the shell must not read.
    async fn seeded_snapshot_store() -> Repositories {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let repositories = Repositories::new(database);
        let mut fixture = http_read_model_fixture();
        for project in fixture.projects.drain(..) {
            repositories.upsert_project(project).await.unwrap();
        }
        let mut archived = store_thread("t-archived", "project-live", Some("turn-archived"));
        archived.archived_at = Some(CREATED_AT.to_owned());
        let mut deleted = store_thread("t-deleted", "project-live", None);
        deleted.deleted_at = Some(CREATED_AT.to_owned());
        let mut panel = store_thread("t-panel", "project-live", None);
        panel.kind = "panel".to_owned();
        panel.host_thread_id = Some("t-running".to_owned());
        for thread in [
            store_thread("t-running", "project-live", Some("turn-run")),
            store_thread("t-ties", "project-live", Some("turn-done")),
            store_thread("t-under-deleted-project", "project-deleted", None),
            store_thread("t-orphan", "project-missing", None),
            archived,
            deleted,
            panel,
        ] {
            repositories.upsert_thread(thread).await.unwrap();
        }
        let mut queued = store_message(
            "m-queued",
            "t-running",
            "user",
            "queued prompt",
            "2026-07-11T00:00:05.000Z",
        );
        queued.delivery_state = Some("queued".to_owned());
        let messages = [
            store_message(
                "m-old",
                "t-running",
                "user",
                "older prompt",
                "2026-07-11T00:00:02.000Z",
            ),
            store_message(
                "m-tie-a",
                "t-running",
                "user",
                "tied prompt",
                "2026-07-11T00:00:05.000Z",
            ),
            queued,
            store_message(
                "m-reply",
                "t-running",
                "assistant",
                "an answer",
                "2026-07-11T00:00:03.000Z",
            ),
            store_message(
                "m-blank",
                "t-running",
                "assistant",
                "   ",
                "2026-07-11T00:00:04.000Z",
            ),
            store_message("m-b", "t-ties", "user", "bravo", "2026-07-11T00:00:05.000Z"),
            store_message("m-a", "t-ties", "user", "alpha", "2026-07-11T00:00:05.000Z"),
            store_message(
                "m-system",
                "t-ties",
                "system",
                "ignored",
                "2026-07-11T00:00:09.000Z",
            ),
            store_message(
                "m-archived",
                "t-archived",
                "assistant",
                "archived answer",
                "2026-07-11T00:00:05.000Z",
            ),
            store_message(
                "m-deleted",
                "t-deleted",
                "user",
                "deleted prompt",
                "2026-07-11T00:00:05.000Z",
            ),
        ];
        for message in messages {
            repositories.upsert_message(message).await.unwrap();
        }
        let mut activities = vec![
            // Tied newest tool rows: the one later in sequence order wins.
            store_activity(
                "act-y",
                "t-running",
                "turn-run",
                "tool",
                Some(5),
                "2026-07-11T00:00:09.000Z",
            ),
            store_activity(
                "act-x",
                "t-running",
                "turn-run",
                "tool",
                Some(3),
                "2026-07-11T00:00:09.000Z",
            ),
            store_activity(
                "act-null",
                "t-running",
                "turn-run",
                "tool",
                None,
                "2026-07-11T00:00:09.000Z",
            ),
            store_activity(
                "act-info",
                "t-running",
                "turn-run",
                "info",
                Some(6),
                "2026-07-11T00:00:10.000Z",
            ),
            store_activity(
                "act-old-turn",
                "t-running",
                "turn-old",
                "tool",
                Some(7),
                "2026-07-11T00:00:11.000Z",
            ),
            store_activity(
                "act-done",
                "t-ties",
                "turn-done",
                "tool",
                Some(1),
                "2026-07-11T00:00:09.000Z",
            ),
        ];
        activities.extend((0..40).map(|index| {
            store_activity(
                &format!("history-{index:02}"),
                if index % 2 == 0 {
                    "t-running"
                } else {
                    "t-archived"
                },
                "turn-history",
                "tool",
                Some(100 + index),
                "2026-07-11T00:00:01.000Z",
            )
        }));
        for activity in activities {
            repositories.upsert_activity(activity).await.unwrap();
        }
        for (thread_id, turn_id, state) in [
            ("t-running", "turn-run", "running"),
            ("t-running", "turn-old", "completed"),
            ("t-ties", "turn-done", "completed"),
            ("t-archived", "turn-archived", "running"),
        ] {
            repositories
                .upsert_turn_by_id(store_turn(thread_id, turn_id, state))
                .await
                .unwrap();
        }
        repositories
            .upsert_checkpoint(crate::persistence::ProjectionCheckpoint {
                thread_id: "t-ties".to_owned(),
                turn_id: "turn-done".to_owned(),
                checkpoint_turn_count: 1,
                checkpoint_ref: "refs/checkpoint/1".to_owned(),
                status: "ready".to_owned(),
                files: json!([]),
                diff_available: true,
                assistant_message_id: None,
                completed_at: "2026-07-11T00:00:06.000Z".to_owned(),
            })
            .await
            .unwrap();
        repositories
            .upsert_proposed_plan(crate::persistence::ProjectionThreadProposedPlan {
                plan_id: "plan-1".to_owned(),
                thread_id: "t-running".to_owned(),
                turn_id: Some("turn-old".to_owned()),
                plan_markdown: "# Plan".to_owned(),
                implemented_at: None,
                implementation_thread_id: None,
                created_at: CREATED_AT.to_owned(),
                updated_at: CREATED_AT.to_owned(),
            })
            .await
            .unwrap();
        for thread_id in ["t-running", "t-archived"] {
            repositories
                .upsert_thread_session(crate::persistence::ProjectionThreadSession {
                    thread_id: thread_id.to_owned(),
                    status: "running".to_owned(),
                    provider_name: Some("codex".to_owned()),
                    provider_instance_id: Some("codex".to_owned()),
                    runtime_mode: "full-access".to_owned(),
                    active_turn_id: Some("turn-run".to_owned()),
                    last_error: None,
                    last_error_class: None,
                    updated_at: CREATED_AT.to_owned(),
                })
                .await
                .unwrap();
        }
        for (projector, sequence) in [("projector-a", 7), ("projector-b", 9)] {
            repositories
                .upsert_projection_state(crate::persistence::ProjectionState {
                    projector: projector.to_owned(),
                    last_applied_sequence: sequence,
                    updated_at: CREATED_AT.to_owned(),
                })
                .await
                .unwrap();
        }
        repositories
    }

    fn without_updated_at(mut value: Value) -> Value {
        value
            .as_object_mut()
            .expect("snapshot object")
            .remove("updatedAt");
        value
    }

    #[tokio::test]
    async fn targeted_snapshots_match_the_full_store_load_without_reading_history() {
        let repositories = seeded_snapshot_store().await;
        let full = load_snapshot(&repositories).await.unwrap();
        assert_eq!(full.activities.len(), 46, "fixture history is in the store");

        for archived in [false, true] {
            let targeted = load_shell_snapshot(&repositories, archived).await.unwrap();
            assert_eq!(
                without_updated_at(shell_snapshot_value(&targeted, archived)),
                without_updated_at(shell_snapshot_value(&full, archived)),
                "archived = {archived}"
            );
            // Only preview candidates are read: every row tied for the newest user and
            // assistant message of a returned thread, and for the newest tool activity of
            // a running latest turn. History, plans and checkpoints stay unread.
            let mut message_ids = targeted
                .messages
                .iter()
                .map(|row| row.message_id.as_str())
                .collect::<Vec<_>>();
            message_ids.sort_unstable();
            let mut activity_ids = targeted
                .activities
                .iter()
                .map(|row| row.activity_id.as_str())
                .collect::<Vec<_>>();
            activity_ids.sort_unstable();
            let (expected_messages, expected_activities): (&[&str], &[&str]) = if archived {
                (&["m-archived"], &[])
            } else {
                (
                    &["m-a", "m-b", "m-blank", "m-queued", "m-tie-a"],
                    &["act-null", "act-x", "act-y"],
                )
            };
            assert_eq!(message_ids, expected_messages, "archived = {archived}");
            assert_eq!(activity_ids, expected_activities, "archived = {archived}");
            assert!(targeted.proposed_plans.is_empty() && targeted.checkpoints.is_empty());
            assert!(targeted.approvals.is_empty() && targeted.receipts.is_empty());
            assert!(targeted.diffs.is_empty());
        }
        let live = shell_snapshot_value(
            &load_shell_snapshot(&repositories, false).await.unwrap(),
            false,
        );
        let running = live["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|thread| thread["id"] == "t-running")
            .unwrap();
        assert_eq!(running["conversationPreview"]["prompt"], "queued prompt");
        assert_eq!(running["conversationPreview"]["tool"], "summary act-y");
        assert_eq!(
            running["conversationPreview"]["assistantMessage"],
            Value::Null
        );
        assert_eq!(live["snapshotSequence"], 9);

        for thread_id in [
            "t-running",
            "t-ties",
            "t-archived",
            "t-deleted",
            "t-panel",
            "t-under-deleted-project",
            "t-orphan",
            "t-missing",
        ] {
            let targeted = load_thread_snapshot(&repositories, thread_id)
                .await
                .unwrap();
            assert_eq!(
                thread_snapshot_value(&targeted, thread_id),
                thread_snapshot_value(&full, thread_id),
                "thread {thread_id}"
            );
        }
        // A view of a deleted thread keeps asking for it; its history stays unread (#113).
        let deleted = load_thread_snapshot(&repositories, "t-deleted")
            .await
            .unwrap();
        assert!(deleted.threads.is_empty() && deleted.messages.is_empty());
    }

    /// Bytes this process has passed to `write(2)` so far: SQLite temporary files included.
    fn written_bytes() -> u64 {
        std::fs::read_to_string("/proc/self/io")
            .ok()
            .and_then(|io| {
                io.lines()
                    .find_map(|line| line.strip_prefix("wchar: ")?.trim().parse().ok())
            })
            .unwrap_or(0)
    }

    async fn timed<F: std::future::Future<Output = Value>>(
        label: &str,
        run: impl Fn() -> F,
    ) -> Value {
        let mut samples = Vec::new();
        let mut written = 0;
        let mut value = Value::Null;
        for _ in 0..3 {
            let before = written_bytes();
            let started = std::time::Instant::now();
            value = run().await;
            samples.push(started.elapsed());
            written = written.max(written_bytes().saturating_sub(before));
        }
        samples.sort();
        println!(
            "{label}: median {:?} (min {:?}, max {:?}), up to {:.1} MB written",
            samples[1],
            samples[0],
            samples[2],
            written as f64 / 1e6
        );
        value
    }

    /// #78 timings on a synthetic store shaped like the reporting machine's: 15 projects,
    /// 50 threads (2 archived), 1,300 messages and 170,000 activities of about 1.5 KB.
    /// `BIBCODE_ISSUE78_BENCH_DIR` sets where the database file goes; run with
    /// `cargo test -p bibcode-server --lib shell_snapshot_timing -- --ignored --nocapture`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "builds a store of about 300 MB; run by hand for timings"]
    async fn shell_snapshot_timing_on_a_large_store() {
        let directory = std::env::var_os("BIBCODE_ISSUE78_BENCH_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("issue-78-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = Database::create_new(directory.join("state.sqlite"))
            .await
            .unwrap();
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                connection.execute_batch("PRAGMA synchronous = OFF; BEGIN")?;
                Ok(())
            })
            .await
            .unwrap();
        let repositories = Repositories::new(database.clone());
        let mut fixture = http_read_model_fixture();
        let template = fixture.projects.remove(0);
        for project in 0..15 {
            let mut row = template.clone();
            row.project_id = format!("project-{project:02}");
            row.workspace_root = format!("/bench/{project:02}");
            repositories.upsert_project(row).await.unwrap();
        }
        let payload = "x".repeat(1_500);
        let mut activity = 0_i64;
        for thread in 0..50 {
            let thread_id = format!("thread-{thread:02}");
            let mut row = store_thread(
                &thread_id,
                &format!("project-{:02}", thread % 15),
                Some("turn-12"),
            );
            if thread >= 48 {
                row.archived_at = Some(CREATED_AT.to_owned());
            }
            repositories.upsert_thread(row).await.unwrap();
            for turn in 0..13 {
                let state = if thread == 0 && turn == 12 {
                    "running"
                } else {
                    "completed"
                };
                repositories
                    .upsert_turn_by_id(store_turn(&thread_id, &format!("turn-{turn:02}"), state))
                    .await
                    .unwrap();
            }
            for message in 0..26 {
                let role = if message % 2 == 0 {
                    "user"
                } else {
                    "assistant"
                };
                let created_at =
                    format!("2026-07-11T00:{:02}:{:02}.000Z", message / 60, message % 60);
                repositories
                    .upsert_message(store_message(
                        &format!("{thread_id}-message-{message:02}"),
                        &thread_id,
                        role,
                        &format!("message {message} of {thread_id}"),
                        &created_at,
                    ))
                    .await
                    .unwrap();
            }
            for index in 0..3_400 {
                activity += 1;
                let mut row = store_activity(
                    &format!("{thread_id}-activity-{index:04}"),
                    &thread_id,
                    &format!("turn-{:02}", index * 13 / 3_400),
                    if index % 3 == 0 { "tool" } else { "info" },
                    Some(activity),
                    &format!(
                        "2026-07-11T01:{:02}:{:02}.{:03}Z",
                        index / 3_600,
                        (index / 60) % 60,
                        index % 1_000
                    ),
                );
                row.payload = json!({ "detail": payload, "index": index });
                repositories.upsert_activity(row).await.unwrap();
            }
            repositories
                .upsert_thread_session(crate::persistence::ProjectionThreadSession {
                    thread_id: thread_id.clone(),
                    status: "ready".to_owned(),
                    provider_name: Some("codex".to_owned()),
                    provider_instance_id: Some("codex".to_owned()),
                    runtime_mode: "full-access".to_owned(),
                    active_turn_id: None,
                    last_error: None,
                    last_error_class: None,
                    updated_at: CREATED_AT.to_owned(),
                })
                .await
                .unwrap();
        }
        repositories
            .upsert_projection_state(crate::persistence::ProjectionState {
                projector: "bench".to_owned(),
                last_applied_sequence: activity,
                updated_at: CREATED_AT.to_owned(),
            })
            .await
            .unwrap();
        database
            .call(|connection| {
                connection.execute_batch(
                    "COMMIT; PRAGMA synchronous = FULL; PRAGMA wal_checkpoint(TRUNCATE)",
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let size = std::fs::metadata(directory.join("state.sqlite"))
            .unwrap()
            .len();
        println!(
            "store: 50 threads, {activity} activities, {:.0} MB",
            size as f64 / 1e6
        );

        for archived in [true, false] {
            let label = if archived {
                "getArchivedShellSnapshot"
            } else {
                "subscribeShell snapshot"
            };
            let legacy = timed(&format!("{label}, full load"), || async {
                shell_snapshot_value(&load_snapshot(&repositories).await.unwrap(), archived)
            })
            .await;
            let targeted = timed(&format!("{label}, targeted load"), || async {
                shell_snapshot_value(
                    &load_shell_snapshot(&repositories, archived).await.unwrap(),
                    archived,
                )
            })
            .await;
            assert_eq!(without_updated_at(targeted), without_updated_at(legacy));
        }
        let legacy = timed("subscribeThread snapshot, full load", || async {
            thread_snapshot_value(&load_snapshot(&repositories).await.unwrap(), "thread-00")
                .unwrap()
        })
        .await;
        let targeted = timed("subscribeThread snapshot, targeted load", || async {
            thread_snapshot_value(
                &load_thread_snapshot(&repositories, "thread-00")
                    .await
                    .unwrap(),
                "thread-00",
            )
            .unwrap()
        })
        .await;
        assert_eq!(targeted, legacy);
        database.close().await;
        std::fs::remove_dir_all(&directory).unwrap();
    }

    fn http_read_model_fixture() -> Snapshot {
        let mut snapshot = preview_snapshot_fixture("completed");
        let mut live = snapshot.threads.remove(0);
        live.thread_id = "thread-live".to_owned();
        live.project_id = "project-live".to_owned();
        live.title = "thread-live".to_owned();
        live.latest_turn_id = Some("turn-live".to_owned());
        live.created_at = CREATED_AT.to_owned();
        live.updated_at = CREATED_AT.to_owned();
        live.latest_user_message_at = Some(CREATED_AT.to_owned());
        let mut archived = live.clone();
        archived.thread_id = "thread-archived".to_owned();
        archived.title = "thread-archived".to_owned();
        archived.kind = "workspace".to_owned();
        archived.archived_at = Some(CREATED_AT.to_owned());
        archived.latest_turn_id = None;
        archived.latest_user_message_at = None;
        let mut deleted = archived.clone();
        deleted.thread_id = "thread-deleted".to_owned();
        deleted.project_id = "project-deleted".to_owned();
        deleted.title = "thread-deleted".to_owned();
        deleted.archived_at = None;
        deleted.deleted_at = Some(CREATED_AT.to_owned());
        snapshot.threads = vec![live, archived, deleted];
        let project = crate::persistence::ProjectionProject {
            project_id: "project-live".to_owned(),
            title: "Owned live".to_owned(),
            workspace_root: "/owned/live".to_owned(),
            default_model_selection: None,
            scripts: json!([]),
            worktree_discovery: json!({ "visibility": "hidden", "initialPromptDismissedAt": null, "baselinePaths": [] }),
            worktree_repository_key: None,
            created_at: CREATED_AT.to_owned(),
            updated_at: CREATED_AT.to_owned(),
            deleted_at: None,
            repository_identity: None,
        };
        let mut deleted_project = project.clone();
        deleted_project.project_id = "project-deleted".to_owned();
        deleted_project.title = "Owned deleted".to_owned();
        deleted_project.workspace_root = "/owned/deleted".to_owned();
        deleted_project.deleted_at = Some(CREATED_AT.to_owned());
        snapshot.projects = vec![project, deleted_project];
        let mut message = snapshot.messages.remove(0);
        message.message_id = "message-live".to_owned();
        message.thread_id = "thread-live".to_owned();
        message.turn_id = Some("turn-live".to_owned());
        message.text = "Owned message".to_owned();
        let mut deleted_message = message.clone();
        deleted_message.message_id = "message-deleted".to_owned();
        deleted_message.thread_id = "thread-deleted".to_owned();
        deleted_message.turn_id = None;
        deleted_message.role = "assistant".to_owned();
        deleted_message.text = "Owned deleted message".to_owned();
        snapshot.messages = vec![message, deleted_message];
        let mut activity = snapshot.activities.remove(0);
        activity.activity_id = "activity-live".to_owned();
        activity.thread_id = "thread-live".to_owned();
        activity.turn_id = Some("turn-live".to_owned());
        activity.tone = "warning".to_owned();
        activity.kind = "status".to_owned();
        activity.summary = "Owned status".to_owned();
        activity.created_at = CREATED_AT.to_owned();
        snapshot.activities = vec![activity];
        let mut turn = snapshot.turns.remove(0);
        turn.thread_id = "thread-live".to_owned();
        turn.turn_id = Some("turn-live".to_owned());
        turn.requested_at = CREATED_AT.to_owned();
        turn.started_at = Some(CREATED_AT.to_owned());
        turn.completed_at = Some(CREATED_AT.to_owned());
        snapshot.turns = vec![turn];
        snapshot.sessions = vec![crate::persistence::ProjectionThreadSession {
            thread_id: "thread-live".to_owned(),
            status: "ready".to_owned(),
            provider_name: Some("codex".to_owned()),
            provider_instance_id: None,
            runtime_mode: "full-access".to_owned(),
            active_turn_id: None,
            last_error: None,
            last_error_class: None,
            updated_at: CREATED_AT.to_owned(),
        }];
        snapshot.proposed_plans = vec![crate::persistence::ProjectionThreadProposedPlan {
            plan_id: "plan-live".to_owned(),
            thread_id: "thread-live".to_owned(),
            turn_id: Some("turn-live".to_owned()),
            plan_markdown: "Owned plan".to_owned(),
            implemented_at: None,
            implementation_thread_id: None,
            created_at: CREATED_AT.to_owned(),
            updated_at: CREATED_AT.to_owned(),
        }];
        snapshot.checkpoints = vec![crate::orchestration::engine::ProjectionCheckpointRow {
            thread_id: "thread-live".to_owned(),
            turn_id: "turn-live".to_owned(),
            checkpoint_turn_count: 1,
            checkpoint_ref: "refs/checkpoints/owned".to_owned(),
            status: "ready".to_owned(),
            files: json!([]),
            diff_available: true,
            assistant_message_id: None,
            completed_at: CREATED_AT.to_owned(),
        }];
        snapshot.states = vec![crate::persistence::ProjectionState {
            projector: "owned".to_owned(),
            last_applied_sequence: 42,
            updated_at: CREATED_AT.to_owned(),
        }];
        snapshot
    }

    #[test]
    fn http_read_model_matches_public_fixture_and_preserves_ws_detail() {
        let snapshot = http_read_model_fixture();
        let expected: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/http-orchestration/full-read-model.json"
        ))
        .expect("public full-read-model fixture");
        let model = read_model_snapshot(&snapshot, CREATED_AT);
        assert_eq!(model, expected);
        assert!(model.get("states").is_none());
        assert!(model.get("receipts").is_none());
        let thread = &snapshot.threads[0];
        let ws_detail = thread_detail(thread, &thread_detail_rows(&snapshot, thread));
        let mut expected_ws = expected["threads"][0].clone();
        expected_ws["latestTurn"]["sourceProposedPlan"] = Value::Null;
        expected_ws["session"]["providerInstanceId"] = Value::Null;
        assert_eq!(ws_detail, expected_ws);
        let shell = thread_shell(thread, &snapshot, None);
        let mut detail_shell = ws_detail;
        for field in [
            "deletedAt",
            "messages",
            "activities",
            "proposedPlans",
            "checkpoints",
        ] {
            detail_shell
                .as_object_mut()
                .expect("detail object")
                .remove(field);
        }
        assert_eq!(shell, detail_shell);
    }

    #[test]
    fn http_read_model_keeps_present_optionals_and_first_matching_ws_rows() {
        let mut snapshot = http_read_model_fixture();
        snapshot.sessions[0].provider_instance_id = Some("codex-custom".to_owned());
        snapshot.turns[0].source_proposed_plan_thread_id = Some("thread-source".to_owned());
        snapshot.turns[0].source_proposed_plan_id = Some("plan-source".to_owned());
        let mut later_session = snapshot.sessions[0].clone();
        later_session.status = "error".to_owned();
        snapshot.sessions.push(later_session);
        let mut later_turn = snapshot.turns[0].clone();
        later_turn.state = "error".to_owned();
        snapshot.turns.push(later_turn);
        let model = read_model_snapshot(&snapshot, CREATED_AT);
        let thread = &snapshot.threads[0];
        let ws = thread_detail(thread, &thread_detail_rows(&snapshot, thread));
        assert_eq!(model["threads"][0], ws);
        assert_eq!(ws["session"]["providerInstanceId"], "codex-custom");
        assert_eq!(ws["session"]["status"], "ready");
        assert_eq!(ws["latestTurn"]["state"], "completed");
        assert_eq!(
            ws["latestTurn"]["sourceProposedPlan"],
            json!({ "threadId": "thread-source", "planId": "plan-source" })
        );
    }

    fn checkpoint_with_files(
        turn: usize,
        count: usize,
    ) -> crate::orchestration::engine::ProjectionCheckpointRow {
        crate::orchestration::engine::ProjectionCheckpointRow {
            thread_id: "thread-live".to_owned(),
            turn_id: format!("turn-{turn}"),
            checkpoint_turn_count: i64::try_from(turn).unwrap(),
            checkpoint_ref: format!("refs/checkpoints/{turn}"),
            status: "ready".to_owned(),
            diff_available: true,
            files: Value::Array(
                (0..count)
                    .map(|index| {
                        json!({"path": format!("src/{index:05}.rs"), "kind": "modified", "additions": 1, "deletions": 0})
                    })
                    .collect(),
            ),
            assistant_message_id: None,
            completed_at: CREATED_AT.to_owned(),
        }
    }

    /// A turn that touched thousands of files sends 200 of them and the total (#227).
    #[test]
    fn thread_snapshots_cap_checkpoint_files_and_send_the_total() {
        let mut snapshot = http_read_model_fixture();
        snapshot.checkpoints = vec![
            checkpoint_with_files(1, 2_000),
            checkpoint_with_files(2, 50),
        ];
        let first = thread_snapshot_value(&snapshot, "thread-live").expect("thread snapshot");
        let checkpoints = first["thread"]["checkpoints"]
            .as_array()
            .expect("checkpoints");
        let big = checkpoints[0]["files"].as_array().expect("files");
        assert_eq!(big.len(), 200);
        assert_eq!(checkpoints[0]["filesTotal"], 2_000);
        // The first 200 in stored (path) order, the same in every snapshot.
        assert_eq!(
            &big[..],
            &snapshot.checkpoints[0].files.as_array().unwrap()[..200]
        );
        assert_eq!(checkpoints[1]["files"], snapshot.checkpoints[1].files);
        assert_eq!(checkpoints[1]["filesTotal"], 50);

        let again = thread_snapshot_value(&snapshot, "thread-live").expect("thread snapshot");
        let held = HeldThread::of(&first, std::hash::RandomState::new()).expect("a thread");
        assert!(
            thread_patch(&held, &again).is_none(),
            "an unchanged thread sends no patch"
        );
        snapshot.checkpoints.push(checkpoint_with_files(3, 1));
        let next = thread_snapshot_value(&snapshot, "thread-live").expect("thread snapshot");
        let patch = thread_patch(&held, &next).expect("a new checkpoint");
        assert_eq!(
            patch["patch"]["arrays"]["checkpoints"],
            json!({"length": 3, "changes": [[2, next["thread"]["checkpoints"][2]]]}),
            "only the new checkpoint is sent"
        );

        // The HTTP read model keeps every file and no total.
        let model = read_model_snapshot(&snapshot, CREATED_AT);
        let checkpoint = &model["threads"][0]["checkpoints"][0];
        assert_eq!(checkpoint["files"].as_array().map(Vec::len), Some(2_000));
        assert!(checkpoint.get("filesTotal").is_none());
    }

    struct NeverFactory;

    impl ProviderDriverFactory for NeverFactory {
        fn create(
            &self,
            request: ProviderLaunchRequest,
        ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
            Box::pin(async move {
                Err(ProviderRuntimeError::UnsupportedProvider {
                    provider: request.provider,
                })
            })
        }
    }

    #[derive(Default)]
    struct ModelMutationProbe {
        set_model_calls: AtomicUsize,
        interrupt_calls: AtomicUsize,
        fail_set_model_calls: AtomicUsize,
        pause_next_set_model: std::sync::Mutex<Option<Arc<ModelMutationPause>>>,
    }

    #[derive(Default)]
    struct ModelMutationPause {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    impl ModelMutationProbe {
        fn pause_next_set_model(&self) -> Arc<ModelMutationPause> {
            let pause = Arc::new(ModelMutationPause::default());
            *self
                .pause_next_set_model
                .lock()
                .expect("model mutation pause mutex") = Some(pause.clone());
            pause
        }
    }

    impl ProviderDriver for ModelMutationProbe {
        fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
            Box::pin(async { Ok(StartedSession::default()) })
        }

        fn send(
            &self,
            _text: String,
            _attachments: Vec<Value>,
            _interaction_mode: String,
        ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
            Box::pin(async { Ok(None) })
        }

        fn interrupt(
            &self,
            _turn_id: Option<String>,
        ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
            self.interrupt_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }

        fn approve(
            &self,
            _request_id: String,
            _decision: String,
        ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
            Box::pin(async { Ok(()) })
        }

        fn answer(
            &self,
            _request_id: String,
            _answers: Value,
        ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
            Box::pin(async { Ok(()) })
        }

        fn set_mode(
            &self,
            _mode: String,
        ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
            Box::pin(async { Ok(()) })
        }

        fn set_model(
            &self,
            _model: String,
        ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
            self.set_model_calls.fetch_add(1, Ordering::SeqCst);
            let pause = self
                .pause_next_set_model
                .lock()
                .expect("model mutation pause mutex")
                .take();
            let fail = self
                .fail_set_model_calls
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok();
            Box::pin(async move {
                if let Some(pause) = pause {
                    pause.entered.notify_one();
                    pause.release.notified().await;
                }
                if fail {
                    Err(ProviderRuntimeError::Provider {
                        provider: "probe".to_owned(),
                        detail: "injected model mutation failure".to_owned(),
                    })
                } else {
                    Ok(())
                }
            })
        }

        fn set_options(
            &self,
            _options: Vec<Value>,
        ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
            Box::pin(async { Ok(()) })
        }

        fn rollback(
            &self,
            _turn_count: i64,
            _rewind_key: String,
        ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
            Box::pin(async { Ok(()) })
        }

        fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
            Box::pin(std::future::pending())
        }

        fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
            Box::pin(async { Ok(()) })
        }
    }

    struct ModelMutationProbeFactory(Arc<ModelMutationProbe>);

    impl ProviderDriverFactory for ModelMutationProbeFactory {
        fn create(
            &self,
            _request: ProviderLaunchRequest,
        ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
            let probe: Arc<dyn ProviderDriver> = self.0.clone();
            Box::pin(async move { Ok(probe) })
        }
    }

    async fn migrated_engine() -> OrchestrationEngine {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .expect("engine starts")
    }

    async fn append_replay_events(
        engine: &OrchestrationEngine,
        count: usize,
        text: &str,
    ) -> Vec<Value> {
        let repositories = engine.repositories();
        let mut events = Vec::with_capacity(count);
        for index in 0..count {
            let row = repositories
                .append_event(NewOrchestrationEvent {
                    event_id: format!("replay-event-{index:04}"),
                    event_type: "thread.message-sent".to_owned(),
                    aggregate_kind: "thread".to_owned(),
                    aggregate_id: "replay-thread".to_owned(),
                    occurred_at: CREATED_AT.to_owned(),
                    command_id: None,
                    causation_event_id: None,
                    correlation_id: None,
                    payload: json!({
                        "threadId": "replay-thread",
                        "messageId": format!("replay-message-{index:04}"),
                        "role": "assistant",
                        "text": text,
                        "turnId": null,
                        "streaming": false,
                        "createdAt": CREATED_AT,
                        "updatedAt": CREATED_AT,
                    }),
                    metadata: json!({}),
                })
                .await
                .expect("append replay event");
            events.push(wire_event(&row));
        }
        events
    }

    fn replay_array_bytes(events: &[Value]) -> usize {
        serde_json::to_vec(events)
            .expect("encode event array")
            .len()
    }

    /// Clients cannot set the server-authored identity: serde drops the unknown field, so the
    /// command decodes, applies its other fields, and leaves the stored identity untouched.
    #[tokio::test]
    async fn a_client_project_meta_update_cannot_change_the_repository_identity() {
        let engine = migrated_engine().await;
        engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"project.create","commandId":"create","projectId":"p","title":"P",
                    "workspaceRoot":"/work/p","defaultModelSelection":null,"createdAt":CREATED_AT
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let identity = json!({"canonicalKey":"github.com/acme/repo","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"git@github.com:acme/repo.git"},"name":"repo"});
        engine
            .dispatch(OrchestrationCommand::ProjectRepositoryIdentitySet {
                command_id: "identity".to_owned(),
                project_id: "p".to_owned(),
                repository_identity: Some(identity.clone()),
            })
            .await
            .unwrap();
        let before = engine.repositories().max_event_sequence().await.unwrap();

        let command = decode_public_orchestration_command(
            &engine,
            json!({
                "type":"project.meta.update","commandId":"client-meta","projectId":"p",
                "title":"Renamed",
                "repositoryIdentity":{"canonicalKey":"evil.example/x","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"https://evil.example/x.git"},"name":"x"}
            }),
        )
        .await
        .expect("the unknown field is ignored, not an error");
        engine.dispatch(command).await.unwrap();

        let project = engine
            .repositories()
            .get_project("p".to_owned())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(project.title, "Renamed");
        assert_eq!(project.repository_identity, Some(identity));
        let page = read_replay(
            &engine.repositories(),
            before,
            ReplayBudget::Page {
                target_bytes: 100_000,
            },
        )
        .await
        .unwrap();
        assert!(!page.events.is_empty());
        for event in &page.events {
            assert!(
                event["payload"].get("repositoryIdentity").is_none(),
                "{event}"
            );
        }
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_page_stops_before_large_event_exceeds_target() {
        let engine = migrated_engine().await;
        let events = append_replay_events(&engine, 9, &"x".repeat(1_500)).await;
        let target_bytes = replay_array_bytes(&events[..3]);
        let page = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Page { target_bytes },
        )
        .await
        .expect("replay page");
        assert_eq!(page.events, events[..3]);
        assert!(!page.exhausted);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_page_keeps_one_oversized_event() {
        let engine = migrated_engine().await;
        let events = append_replay_events(&engine, 2, &"x".repeat(2_000)).await;
        let page = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Page { target_bytes: 100 },
        )
        .await
        .expect("oversized first event");
        assert_eq!(page.events, events[..1]);
        assert!(!page.exhausted);
        let final_page = read_replay(
            &engine.repositories(),
            events[0]["sequence"].as_i64().unwrap(),
            ReplayBudget::Page { target_bytes: 100 },
        )
        .await
        .expect("oversized final event");
        assert_eq!(final_page.events, events[1..]);
        assert!(final_page.exhausted);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_page_returns_all_small_events_at_tail() {
        let engine = migrated_engine().await;
        let events = append_replay_events(&engine, 20, "small").await;
        let page = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Page {
                target_bytes: 100_000,
            },
        )
        .await
        .expect("small events");
        assert_eq!(page.events, events);
        assert!(page.exhausted);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_page_counts_escaped_json_bytes_exactly() {
        let engine = migrated_engine().await;
        let text = "\"\\\u{1}é🙂".repeat(20);
        let events = append_replay_events(&engine, 4, &text).await;
        let encoded_text_bytes = serde_json::to_vec(&text).expect("encode text").len() - 2;
        let escape_overhead = encoded_text_bytes - text.len();
        assert!(escape_overhead > 0);
        let escaped_pair_bytes = replay_array_bytes(&events[..2]);
        let unescaped_pair_bytes = escaped_pair_bytes - 2 * escape_overhead;
        let target_bytes = unescaped_pair_bytes + escape_overhead;
        assert!(unescaped_pair_bytes < target_bytes && target_bytes < escaped_pair_bytes);
        let page = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Page { target_bytes },
        )
        .await
        .expect("escaped page");
        assert_eq!(page.events, events[..1]);
        assert!(!page.exhausted);
        let exact_page = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Page {
                target_bytes: escaped_pair_bytes,
            },
        )
        .await
        .expect("exact escaped boundary");
        assert_eq!(exact_page.events, events[..2]);
        assert_eq!(replay_array_bytes(&exact_page.events), escaped_pair_bytes);
        assert!(!exact_page.exhausted);
        for page in [page, exact_page] {
            let accounted_bytes =
                page.events
                    .iter()
                    .enumerate()
                    .fold(2, |total, (index, event)| {
                        total
                            + encoded_json_len(event).expect("count event")
                            + usize::from(index > 0)
                    });
            assert_eq!(replay_array_bytes(&page.events), accounted_bytes);
        }
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_page_probes_tail_at_full_batch() {
        let engine = migrated_engine().await;
        let events = append_replay_events(&engine, 128, "boundary").await;
        let page = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Page {
                target_bytes: 1_000_000,
            },
        )
        .await
        .expect("full final batch");
        assert_eq!(page.events, events);
        assert!(page.exhausted);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_page_resumes_into_short_final_batch() {
        let engine = migrated_engine().await;
        let events = append_replay_events(&engine, 129, "boundary").await;
        let target_bytes = replay_array_bytes(&events[..128]);
        let first = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Page { target_bytes },
        )
        .await
        .expect("first page");
        assert_eq!(first.events, events[..128]);
        assert!(!first.exhausted);
        let last = read_replay(
            &engine.repositories(),
            first.events.last().unwrap()["sequence"].as_i64().unwrap(),
            ReplayBudget::Page { target_bytes },
        )
        .await
        .expect("last page");
        assert_eq!(last.events, events[128..]);
        assert!(last.exhausted);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_page_at_full_batch_resumes_without_skipping() {
        let engine = migrated_engine().await;
        let events = append_replay_events(&engine, 256, "boundary").await;
        // Later sequences use more digits; this budget fits either batch but
        // cannot fit the first event of the next batch alongside the first 128.
        let target_bytes = replay_array_bytes(&events[128..]);
        assert!(target_bytes < replay_array_bytes(&events[..129]));
        let first = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Page { target_bytes },
        )
        .await
        .expect("exact first batch");
        assert_eq!(first.events, events[..128]);
        assert!(!first.exhausted);
        let last = read_replay(
            &engine.repositories(),
            first.events.last().unwrap()["sequence"].as_i64().unwrap(),
            ReplayBudget::Page { target_bytes },
        )
        .await
        .expect("exact final batch");
        assert_eq!(last.events, events[128..]);
        assert!(last.exhausted);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_pages_equal_whole_replay_and_engine_events() {
        let engine = migrated_engine().await;
        let seeded = append_replay_events(&engine, 270, "page \"text\" é").await;
        let mut cursor = 0;
        let mut events = Vec::new();
        let target_bytes = replay_array_bytes(&seeded[..7]);
        for _ in 0..=seeded.len() {
            let page = read_replay(
                &engine.repositories(),
                cursor,
                ReplayBudget::Page { target_bytes },
            )
            .await
            .expect("next replay page");
            assert!(!page.events.is_empty());
            assert!(replay_array_bytes(&page.events) <= target_bytes);
            for event in &page.events {
                let sequence = event["sequence"].as_i64().unwrap();
                assert!(sequence > cursor);
                cursor = sequence;
            }
            events.extend(page.events);
            assert_eq!(page.exhausted, events.len() == seeded.len());
            if page.exhausted {
                break;
            }
        }
        let whole = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Whole {
                limit_bytes: replay_array_bytes(&seeded),
            },
        )
        .await
        .expect("whole replay at exact ceiling");
        assert!(whole.exhausted);
        assert_eq!(events, whole.events);
        assert_eq!(events, seeded);
        assert_eq!(
            events,
            engine
                .read_events(0)
                .await
                .expect("engine events")
                .iter()
                .map(wire_event)
                .collect::<Vec<_>>()
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_whole_fails_when_limit_is_crossed_in_first_batch() {
        let engine = migrated_engine().await;
        let events = append_replay_events(&engine, 300, &"x".repeat(200)).await;
        let limit_bytes = replay_array_bytes(&events[..10]);
        let error = read_replay(
            &engine.repositories(),
            0,
            ReplayBudget::Whole { limit_bytes },
        )
        .await
        .expect_err("whole replay exceeds ceiling");
        let ReplayReadError::TooLarge {
            bytes,
            limit_bytes: actual_limit,
        } = error
        else {
            panic!("expected size error, got {error:?}");
        };
        assert_eq!(actual_limit, limit_bytes);
        assert!(limit_bytes < bytes && bytes <= replay_array_bytes(&events[..128]));
        assert_eq!(bytes, replay_array_bytes(&events[..11]));
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn replay_past_tail_is_empty_in_both_modes() {
        let engine = migrated_engine().await;
        append_replay_events(&engine, 2, "tail").await;
        for cursor in [2, 100] {
            for budget in [
                ReplayBudget::Page {
                    target_bytes: 1_000,
                },
                ReplayBudget::Whole { limit_bytes: 1_000 },
            ] {
                let replay = read_replay(&engine.repositories(), cursor, budget)
                    .await
                    .expect("empty tail");
                assert!(replay.events.is_empty());
                assert!(replay.exhausted);
            }
        }
        engine.shutdown().await;
    }

    async fn delivery_engine(hooks: TestHooks) -> (Database, OrchestrationEngine, String) {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let engine = OrchestrationEngine::start(
            database.clone(),
            EngineOptions {
                test_hooks: hooks,
                ..EngineOptions::default()
            },
        )
        .await
        .expect("engine starts");
        engine
            .dispatch(decode_command(json!({
                "type": "project.create",
                "commandId": "delivery-project-create",
                "projectId": "delivery-project",
                "title": "Delivery project",
                "workspaceRoot": "C:/delivery-project",
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        let thread_id = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot")
            .threads
            .into_iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id;
        (database, engine, thread_id)
    }

    fn decode_command(value: Value) -> OrchestrationCommand {
        serde_json::from_value(value).expect("command decodes")
    }

    fn delivery_resolution(
        command_id: &str,
        thread_id: &str,
        message_id: &str,
        action: &str,
    ) -> OrchestrationCommand {
        decode_command(json!({
            "type": "thread.turn-delivery.resolve",
            "commandId": command_id,
            "threadId": thread_id,
            "messageId": message_id,
            "action": action,
            "createdAt": CREATED_AT,
        }))
    }

    async fn seed_delivery(
        engine: &OrchestrationEngine,
        command_id: &str,
        thread_id: &str,
        message_id: &str,
        state: TurnDeliveryState,
    ) {
        let queued = state == TurnDeliveryState::Queued;
        let command = decode_command(json!({
            "type": "thread.turn.start",
            "commandId": command_id,
            "threadId": thread_id,
            "message": {
                "messageId": message_id,
                "role": "user",
                "text": command_id,
                "attachments": [],
            },
            "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "queued": queued,
            "createdAt": CREATED_AT,
        }));
        engine
            .dispatch_with_admission(
                command.clone(),
                CommandAdmission {
                    payload_digest: canonical_command_digest(&command).expect("command digest"),
                    attachment_refs: Vec::<AttachmentReference>::new(),
                    provider_turn: Some(NewProviderTurnDelivery {
                        state: if queued {
                            TurnDeliveryState::Queued
                        } else {
                            TurnDeliveryState::Pending
                        },
                        mode: crate::orchestration::TurnDeliveryMode::Start,
                        command_id: command_id.to_owned(),
                        thread_id: thread_id.to_owned(),
                        message_id: message_id.to_owned(),
                        provider_instance_id: "codex".to_owned(),
                        provider_kind: "codex".to_owned(),
                        provider_session_id: None,
                        delivery_key: format!("delivery-key-{command_id}"),
                        payload: serde_json::to_value(&command).expect("command payload"),
                        created_at: CREATED_AT.to_owned(),
                    }),
                },
                || {},
            )
            .await
            .expect("delivery admitted");
        // Queued starts are admitted directly; requeue transitions are reserved for steers.
        if !queued && state != TurnDeliveryState::Pending {
            assert!(
                engine
                    .transition_turn_delivery(TurnDeliveryTransition {
                        turn_id: None,
                        command_id: command_id.to_owned(),
                        expected_states: vec![TurnDeliveryState::Pending],
                        expected_attempt: 0,
                        next_state: state,
                        detail: Some("delivery outcome is uncertain".to_owned()),
                        updated_at: CREATED_AT.to_owned(),
                    })
                    .await
                    .expect("delivery transition")
            );
        }
    }

    async fn dispatch_prepared_for_test(
        engine: &OrchestrationEngine,
        provider: Option<ProviderRegistration>,
        command: OrchestrationCommand,
    ) -> RpcResult {
        let payload_digest = canonical_command_digest(&command).expect("command digest");
        let command_claim = engine
            .acquire_command_admission(command.command_id())
            .await
            .expect("test command claim");
        dispatch_prepared_command(
            engine.clone(),
            provider,
            command,
            payload_digest,
            "orchestration.dispatchCommand".to_owned(),
            command_claim,
        )
        .await
    }

    async fn dispatch_turn_for_test(
        engine: OrchestrationEngine,
        provider: ProviderRegistration,
        command: OrchestrationCommand,
        payload_digest: String,
        request_tag: String,
        workspace_admission: Option<crate::worktree_catalog::WorkspaceAdmissionLease>,
        owner: &UploadOwner,
    ) -> RpcResult {
        let command_claim = engine
            .acquire_command_admission(command.command_id())
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
        dispatch_turn_command(
            engine,
            provider,
            command,
            payload_digest,
            request_tag,
            workspace_admission,
            command_claim,
            owner,
        )
        .await
    }

    fn provider_registration(
        database: Database,
        engine: &OrchestrationEngine,
        settings_root: PathBuf,
        turn_delivery: Arc<TurnDeliveryService>,
    ) -> (ProviderRegistration, Arc<ProviderRuntimeSupervisor>) {
        let provider = Arc::new(ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(NeverFactory),
            ActivityProjection::new(ActivityRepository::new(database)),
            SupervisorOptions::default(),
        ));
        (
            ProviderRegistration {
                provider: provider.clone(),
                settings_root: settings_root.clone(),
                attachments: AttachmentMaterializer::new(settings_root.join("attachments")),
                turn_delivery,
                uploads: test_upload_registry(),
            },
            provider,
        )
    }

    #[tokio::test]
    async fn queued_admission_resolves_status_and_preserves_original_receipt_digest() {
        for (status, requested, expected) in [
            ("running", Some(true), TurnDeliveryState::Queued),
            ("starting", Some(true), TurnDeliveryState::Queued),
            ("ready", Some(true), TurnDeliveryState::Pending),
            ("idle", Some(true), TurnDeliveryState::Pending),
            ("stopped", Some(true), TurnDeliveryState::Pending),
            ("error", Some(true), TurnDeliveryState::Pending),
            ("running", None, TurnDeliveryState::Pending),
            ("running", Some(false), TurnDeliveryState::Pending),
        ] {
            let (database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
            engine.dispatch(decode_command(json!({"type":"thread.session.set", "commandId":"session", "threadId":thread_id, "session":{"threadId":thread_id, "status":status, "providerName":"codex", "activeTurnId":null, "lastError":null, "updatedAt":CREATED_AT}, "createdAt":CREATED_AT}))).await.unwrap();
            let service = Arc::new(TurnDeliveryService::start_with_router(
                engine.clone(),
                1,
                Arc::new(|_| Box::pin(async { Ok(()) })),
            ));
            service.shutdown().await;
            let state = tempfile::tempdir().unwrap();
            let (registration, provider) =
                provider_registration(database, &engine, state.path().to_path_buf(), service);
            let mut payload = json!({"type":"thread.turn.start", "commandId":"queued-admission", "threadId":thread_id, "message":{"messageId":"queued-admission-message", "role":"user", "text":"saved", "attachments":[]}, "createdAt":CREATED_AT});
            if let Some(queued) = requested {
                payload["queued"] = json!(queued);
            }
            let command = decode_command(payload);
            let digest = canonical_command_digest(&command).unwrap();
            let before = engine
                .read_events(0)
                .await
                .unwrap()
                .last()
                .unwrap()
                .sequence;
            dispatch_turn_for_test(
                engine.clone(),
                registration.clone(),
                command.clone(),
                digest.clone(),
                "orchestration.dispatchCommand".into(),
                None,
                &UploadOwner::Unauthenticated,
            )
            .await
            .unwrap();
            let row = engine
                .repositories()
                .get_provider_turn_delivery("queued-admission".into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                row.state, expected,
                "status {status}, requested {requested:?}"
            );
            assert_eq!(
                row.payload["queued"],
                requested
                    .map(|_| json!(expected == TurnDeliveryState::Queued))
                    .unwrap_or(Value::Null)
            );
            assert_eq!(
                row.payload["modelSelection"],
                json!({"instanceId":"codex", "model":"gpt-5"})
            );
            let events = engine.read_events(before).await.unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.event.event_type == "thread.turn-start-requested")
                    .count(),
                usize::from(expected == TurnDeliveryState::Pending)
            );
            let snapshot = thread_snapshot(&engine, &thread_id).await.unwrap();
            assert_eq!(
                snapshot["thread"]["messages"][0]["delivery"]["state"],
                if expected == TurnDeliveryState::Queued {
                    "queued"
                } else {
                    "pending"
                }
            );
            assert_eq!(
                snapshot["thread"]["messages"][0]["delivery"]["mode"],
                "start"
            );
            assert_eq!(snapshot["thread"]["messages"][0]["delivery"]["held"], false);
            assert_eq!(
                engine
                    .repositories()
                    .get_command_receipt("queued-admission".into())
                    .await
                    .unwrap()
                    .unwrap()
                    .payload_digest,
                Some(digest.clone())
            );
            dispatch_turn_for_test(
                engine.clone(),
                registration,
                command,
                digest,
                "orchestration.dispatchCommand".into(),
                None,
                &UploadOwner::Unauthenticated,
            )
            .await
            .unwrap();
            assert_eq!(
                engine.read_events(before).await.unwrap().len(),
                events.len()
            );
            provider.shutdown().await.unwrap();
            engine.shutdown().await;
        }
    }

    #[tokio::test]
    async fn thread_snapshot_keeps_queued_messages_in_admission_order() {
        let (_, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        seed_delivery(
            &engine,
            "z-first",
            &thread_id,
            "z-message",
            TurnDeliveryState::Queued,
        )
        .await;
        seed_delivery(
            &engine,
            "a-second",
            &thread_id,
            "a-message",
            TurnDeliveryState::Queued,
        )
        .await;
        let snapshot = thread_snapshot(&engine, &thread_id).await.unwrap();
        let messages = snapshot["thread"]["messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["z-message", "a-message"]
        );
        engine.shutdown().await;
    }

    async fn wait_for_delivery_state(
        engine: &OrchestrationEngine,
        command_id: &str,
        expected: TurnDeliveryState,
    ) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let delivery = engine
                    .repositories()
                    .get_provider_turn_delivery(command_id.to_owned())
                    .await
                    .expect("delivery read")
                    .expect("delivery row");
                if delivery.state == expected {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("delivery reaches expected state");
    }

    fn request(tag: &str, payload: Value) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").unwrap(),
            tag: tag.to_owned(),
            payload,
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }

    fn assert_empty_thread_contract(thread: &Value, expected_kind: &str) {
        let object = thread.as_object().expect("thread object");
        assert!(object.contains_key("deletedAt"));
        assert!(object.contains_key("latestTurn"));
        assert!(object.contains_key("session"));
        assert_eq!(thread["deletedAt"], Value::Null);
        assert_eq!(thread["latestTurn"], Value::Null);
        assert_eq!(thread["session"], Value::Null);
        assert_eq!(thread["kind"], expected_kind);
        for field in ["messages", "activities", "proposedPlans", "checkpoints"] {
            assert_eq!(thread[field], json!([]), "{field} is empty");
        }
    }

    async fn dispatch_registered_command(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        id: &str,
        payload: Value,
    ) -> Result<Value, Value> {
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": id,
                    "tag": "orchestration.dispatchCommand",
                    "payload": payload,
                    "headers": [],
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send registered orchestration request");
        let frame = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            next_frame_past_heartbeat(socket),
        )
        .await
        .expect("registered orchestration response timeout")
        .expect("registered orchestration socket remains open")
        .expect("registered orchestration frame");
        let Message::Text(text) = frame else {
            panic!("expected registered orchestration text frame, got {frame:?}");
        };
        match serde_json::from_str::<ServerMessage>(&text).expect("registered RPC response") {
            ServerMessage::Exit {
                request_id,
                exit: RpcExit::Success { value },
            } if request_id == RequestId::try_from(id).unwrap() => Ok(value.unwrap_or(Value::Null)),
            ServerMessage::Exit {
                request_id,
                exit: RpcExit::Failure { cause },
            } if request_id == RequestId::try_from(id).unwrap() => {
                Err(serde_json::to_value(cause).unwrap())
            }
            message => panic!("unexpected registered orchestration response: {message:?}"),
        }
    }

    #[tokio::test]
    async fn prepared_rpc_replays_legacy_accepted_receipt_without_digest() {
        let engine = migrated_engine().await;
        let command = decode_command(json!({
            "type": "project.create",
            "commandId": "legacy-project-create",
            "projectId": "legacy-project",
            "title": "Legacy project",
            "workspaceRoot": "C:/legacy-project",
            "defaultModelSelection": null,
            "createdAt": CREATED_AT,
        }));
        let original = engine
            .dispatch(command.clone())
            .await
            .expect("historical command accepted");
        let historical_receipt = engine
            .repositories()
            .get_command_receipt("legacy-project-create".to_owned())
            .await
            .expect("historical receipt read")
            .expect("historical receipt");
        assert_eq!(historical_receipt.status, "accepted");
        assert_eq!(historical_receipt.payload_digest, None);
        let event_count = engine
            .read_events(0)
            .await
            .expect("events before replay")
            .len();

        let replay = dispatch_prepared_for_test(&engine, None, command)
            .await
            .expect("identical historical command replays its original receipt");

        assert_eq!(
            replay,
            serde_json::to_value(original).expect("original result")
        );
        assert_eq!(
            engine
                .read_events(0)
                .await
                .expect("events after replay")
                .len(),
            event_count,
            "an accepted replay cannot append events"
        );
        assert_eq!(
            engine
                .repositories()
                .get_command_receipt("legacy-project-create".to_owned())
                .await
                .expect("replayed receipt read")
                .expect("replayed receipt")
                .payload_digest,
            None,
            "legacy replay must not rewrite the historical receipt"
        );
        engine.shutdown().await;
    }

    /// The contract's own `thread.delete` with `onlyIfUnused` decodes, and a used thread is
    /// refused with its own error type, so the client can archive instead (#265).
    #[tokio::test]
    async fn unused_delete_of_a_used_thread_is_refused_with_its_own_type() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../packages/contracts/fixtures/rpc-wire/contract-shapes/orchestration__thread__delete-only-if-unused-request.json",
        );
        let request: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(matches!(
            decode_command(request["payload"].clone()),
            OrchestrationCommand::ThreadDelete {
                only_if_unused: true,
                ..
            }
        ));

        let engine = migrated_engine().await;
        for command in [
            json!({"type":"project.create","commandId":"project","projectId":"project-1",
                "title":"Project","workspaceRoot":"C:/repo","createdAt":CREATED_AT}),
            json!({"type":"thread.create","commandId":"create","threadId":"thread-1",
                "projectId":"project-1","title":"Thread",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access","createdAt":CREATED_AT}),
            json!({"type":"thread.turn.start","commandId":"send","threadId":"thread-1",
                "message":{"messageId":"m-1","role":"user","text":"hello","attachments":[]},
                "createdAt":CREATED_AT}),
        ] {
            engine
                .dispatch(decode_command(command))
                .await
                .expect("setup");
        }
        let refusal = dispatch_prepared_for_test(
            &engine,
            None,
            decode_command(json!({"type":"thread.delete","commandId":"close",
                "threadId":"thread-1","onlyIfUnused":true})),
        )
        .await
        .expect_err("a used thread is not deleted");
        assert_eq!(refusal["_tag"], "OrchestrationThreadInUseError");
        assert_eq!(refusal["threadId"], "thread-1");
        assert!(
            engine
                .repositories()
                .get_thread("thread-1".to_owned())
                .await
                .expect("thread read")
                .is_some_and(|thread| thread.deleted_at.is_none())
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn prepared_rpc_replays_legacy_rejected_receipt_without_digest() {
        let engine = migrated_engine().await;
        let command = decode_command(json!({
            "type": "project.delete",
            "commandId": "legacy-project-delete-rejected",
            "projectId": "missing-project",
            "force": true,
        }));
        engine
            .dispatch(command.clone())
            .await
            .expect_err("historical command rejected");
        let historical_receipt = engine
            .repositories()
            .get_command_receipt("legacy-project-delete-rejected".to_owned())
            .await
            .expect("historical rejected receipt read")
            .expect("historical rejected receipt");
        assert_eq!(historical_receipt.status, "rejected");
        assert_eq!(historical_receipt.payload_digest, None);
        let historical_detail = historical_receipt.error.expect("rejection detail");
        let event_count = engine
            .read_events(0)
            .await
            .expect("events before rejected replay")
            .len();

        let replay = dispatch_prepared_for_test(&engine, None, command)
            .await
            .expect_err("historical rejection remains rejected");

        assert_eq!(replay["_tag"], "OrchestrationDispatchCommandError");
        let message = replay["message"].as_str().expect("replay error message");
        assert!(message.to_ascii_lowercase().contains("previously rejected"));
        assert!(message.contains(&historical_detail));
        assert!(!message.to_ascii_lowercase().contains("conflict"));
        assert_eq!(
            engine
                .read_events(0)
                .await
                .expect("events after rejected replay")
                .len(),
            event_count,
            "a rejected replay cannot append events"
        );
        assert_eq!(
            engine
                .repositories()
                .get_command_receipt("legacy-project-delete-rejected".to_owned())
                .await
                .expect("replayed rejected receipt read")
                .expect("replayed rejected receipt")
                .payload_digest,
            None,
            "legacy rejected replay must not rewrite the historical receipt"
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn turn_rpc_replays_legacy_receipts_before_attachment_or_delivery_work() {
        let (database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        let accepted = decode_command(json!({
            "type": "thread.turn.start",
            "commandId": "legacy-turn-accepted",
            "threadId": thread_id,
            "message": {
                "messageId": "legacy-turn-message",
                "role": "user",
                "text": "historical turn",
                "attachments": [{
                    "type": "file",
                    "id": "legacy-file",
                    "name": "legacy.txt",
                    "mimeType": "text/plain",
                    "sizeBytes": 6,
                    "dataUrl": "data:text/plain;base64,bGVnYWN5"
                }]
            },
            "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "createdAt": CREATED_AT,
        }));
        let original = engine
            .dispatch(accepted.clone())
            .await
            .expect("historical turn accepted");
        let rejected = decode_command(json!({
            "type": "thread.turn.start",
            "commandId": "legacy-turn-rejected",
            "threadId": "missing-legacy-thread",
            "message": {
                "messageId": "legacy-rejected-message",
                "role": "user",
                "text": "historical rejected turn",
                "attachments": []
            },
            "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "createdAt": CREATED_AT,
        }));
        engine
            .dispatch(rejected.clone())
            .await
            .expect_err("historical missing-thread turn rejected");
        for command_id in ["legacy-turn-accepted", "legacy-turn-rejected"] {
            assert_eq!(
                engine
                    .repositories()
                    .get_command_receipt(command_id.to_owned())
                    .await
                    .expect("legacy turn receipt read")
                    .expect("legacy turn receipt")
                    .payload_digest,
                None
            );
        }

        let state = tempfile::tempdir().expect("provider state");
        std::fs::write(state.path().join("attachments"), b"blocked attachment root")
            .expect("block attachment materialization");
        let router: DeliveryRouter =
            Arc::new(|_| Box::pin(async { panic!("legacy replay must not route provider work") }));
        let service = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            router,
        ));
        let (registration, provider) = provider_registration(
            database,
            &engine,
            state.path().to_path_buf(),
            service.clone(),
        );
        let event_count = engine
            .read_events(0)
            .await
            .expect("events before replay")
            .len();

        let replay = dispatch_turn_for_test(
            engine.clone(),
            registration.clone(),
            accepted,
            "ignored legacy digest".to_owned(),
            "orchestration.dispatchCommand".to_owned(),
            None,
            &UploadOwner::Unauthenticated,
        )
        .await
        .expect("legacy accepted turn replays its stored result");
        assert_eq!(
            replay,
            serde_json::to_value(original).expect("original result")
        );
        let rejection = dispatch_turn_for_test(
            engine.clone(),
            registration,
            rejected,
            "different ignored legacy digest".to_owned(),
            "orchestration.dispatchCommand".to_owned(),
            None,
            &UploadOwner::Unauthenticated,
        )
        .await
        .expect_err("legacy rejected turn remains rejected");
        assert!(
            rejection["message"].as_str().is_some_and(|message| message
                .to_ascii_lowercase()
                .contains("previously rejected"))
        );
        assert_eq!(
            engine
                .read_events(0)
                .await
                .expect("events after replay")
                .len(),
            event_count
        );
        for command_id in ["legacy-turn-accepted", "legacy-turn-rejected"] {
            assert!(
                engine
                    .repositories()
                    .get_provider_turn_delivery(command_id.to_owned())
                    .await
                    .expect("legacy outbox read")
                    .is_none(),
                "legacy replay cannot synthesize delivery work"
            );
        }

        service.shutdown().await;
        provider.shutdown().await.expect("provider shutdown");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn losing_turn_admission_never_prepares_external_attachments() {
        let hooks = TestHooks::default();
        let (database, engine, thread_id) = delivery_engine(hooks.clone()).await;
        let state = tempfile::tempdir().expect("provider state");
        let delivery = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            Arc::new(|_| Box::pin(async { Ok(()) })),
        ));
        let (registration, provider) = provider_registration(
            database,
            &engine,
            state.path().to_path_buf(),
            delivery.clone(),
        );
        let command = decode_command(json!({
            "type":"thread.turn.start",
            "commandId":"attachment-admission-race",
            "threadId":thread_id,
            "message":{
                "messageId":"attachment-admission-message",
                "role":"user",
                "text":"review",
                "attachments":[{
                    "type":"file",
                    "id":"attachment-admission-file",
                    "name":"notes.txt",
                    "mimeType":"text/plain",
                    "sizeBytes":5,
                    "dataUrl":"data:text/plain;base64,bm90ZXM="
                }]
            },
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "createdAt":CREATED_AT
        }));
        let payload_digest = canonical_command_digest(&command).expect("turn digest");
        let removal_claim = engine
            .acquire_command_admission("attachment-admission-race")
            .await
            .expect("removal owns absent turn identity");
        engine
            .reserve_worktree_removal_admission(
                &removal_claim,
                "attachment-admission-race",
                "removal-project",
                "removal-payload",
            )
            .await
            .expect("removal reserves the absent turn identity");
        let dispatch_engine = engine.clone();
        let mut dispatch = tokio::spawn(async move {
            dispatch_turn_for_test(
                dispatch_engine,
                registration,
                command,
                payload_digest,
                "orchestration.dispatchCommand".to_owned(),
                None,
                &UploadOwner::Unauthenticated,
            )
            .await
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut dispatch)
                .await
                .is_err(),
            "turn must wait while removal owns the command ID"
        );
        drop(removal_claim);

        let error = dispatch
            .await
            .expect("turn dispatch joins")
            .expect_err("losing turn conflicts");
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|message| message.to_ascii_lowercase().contains("conflict"))
        );
        assert!(
            !state.path().join("attachments").exists(),
            "losing admission must not initialize or publish the attachment store"
        );

        delivery.shutdown().await;
        provider.shutdown().await.expect("provider shutdown");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_matching_turn_replays_without_repreparing_attachments() {
        let (database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        let state = tempfile::tempdir().expect("provider state");
        let delivery = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            Arc::new(|_| Box::pin(async { Ok(()) })),
        ));
        let (mut registration, provider) = provider_registration(
            database,
            &engine,
            state.path().to_path_buf(),
            delivery.clone(),
        );
        let publication = Arc::new(AttachmentPrepareTestPause::default());
        registration.attachments = AttachmentMaterializer::new(state.path().join("attachments"))
            .with_pause_after_final_publication(publication.clone());
        let command = decode_command(json!({
            "type":"thread.turn.start",
            "commandId":"concurrent-attachment-command",
            "threadId":thread_id,
            "message":{
                "messageId":"concurrent-attachment-message",
                "role":"user",
                "text":"review",
                "attachments":[{
                    "type":"file",
                    "id":"concurrent-attachment-file",
                    "name":"notes.txt",
                    "mimeType":"text/plain",
                    "sizeBytes":5,
                    "dataUrl":"data:text/plain;base64,bm90ZXM="
                }]
            },
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "createdAt":CREATED_AT
        }));
        let digest = canonical_command_digest(&command).expect("turn digest");
        let first_engine = engine.clone();
        let first_registration = registration.clone();
        let first_command = command.clone();
        let first_digest = digest.clone();
        let first = tokio::spawn(async move {
            dispatch_turn_for_test(
                first_engine,
                first_registration,
                first_command,
                first_digest,
                "orchestration.dispatchCommand".to_owned(),
                None,
                &UploadOwner::Unauthenticated,
            )
            .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            publication.wait_until_reached(),
        )
        .await
        .expect("first claimant publishes attachment");
        let second_engine = engine.clone();
        let mut second = tokio::spawn(async move {
            dispatch_turn_for_test(
                second_engine,
                registration,
                command,
                digest,
                "orchestration.dispatchCommand".to_owned(),
                None,
                &UploadOwner::Unauthenticated,
            )
            .await
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut second)
                .await
                .is_err(),
            "matching turn must wait for the live claimant"
        );
        std::fs::write(
            state
                .path()
                .join("attachments")
                .join("concurrent-attachment-file"),
            b"other",
        )
        .expect("corrupt the published file to expose duplicate preparation");
        publication.release();
        let first_result = first
            .await
            .expect("first turn joins")
            .expect("first turn accepts");
        let second_result = second
            .await
            .expect("second turn joins")
            .expect("matching turn replays without attachment preparation");
        assert_eq!(second_result, first_result);

        delivery.shutdown().await;
        provider.shutdown().await.expect("provider shutdown");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn ordinary_rpc_receipts_store_and_validate_the_canonical_digest() {
        let engine = migrated_engine().await;
        let accepted = decode_command(json!({
            "type": "project.create",
            "commandId": "digested-project-create",
            "projectId": "digested-project",
            "title": "Digested project",
            "workspaceRoot": "C:/digested-project",
            "defaultModelSelection": null,
            "createdAt": CREATED_AT,
        }));
        let accepted_digest = canonical_command_digest(&accepted).expect("accepted digest");
        dispatch_prepared_for_test(&engine, None, accepted)
            .await
            .expect("ordinary accepted command");
        assert_eq!(
            engine
                .repositories()
                .get_command_receipt("digested-project-create".to_owned())
                .await
                .expect("accepted receipt read")
                .expect("accepted receipt")
                .payload_digest,
            Some(accepted_digest)
        );

        let rejected = decode_command(json!({
            "type": "project.delete",
            "commandId": "digested-project-delete-rejected",
            "projectId": "missing-digested-project",
            "force": true,
        }));
        let rejected_digest = canonical_command_digest(&rejected).expect("rejected digest");
        dispatch_prepared_for_test(&engine, None, rejected)
            .await
            .expect_err("ordinary rejected command");
        assert_eq!(
            engine
                .repositories()
                .get_command_receipt("digested-project-delete-rejected".to_owned())
                .await
                .expect("rejected receipt read")
                .expect("rejected receipt")
                .payload_digest,
            Some(rejected_digest)
        );

        let conflict = dispatch_prepared_for_test(
            &engine,
            None,
            decode_command(json!({
                "type": "project.delete",
                "commandId": "digested-project-delete-rejected",
                "projectId": "different-project",
                "force": true,
            })),
        )
        .await
        .expect_err("changed ordinary replay conflicts");
        assert!(
            conflict["message"]
                .as_str()
                .is_some_and(|message| message.to_ascii_lowercase().contains("conflict"))
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn archiving_a_chat_panel_interrupts_its_provider_work_on_the_server() {
        let engine = migrated_engine().await;
        let state = tempfile::tempdir().expect("provider state");
        let mut commands = vec![json!({
            "type":"project.create",
            "commandId":"panel-close-project",
            "projectId":"panel-close-project",
            "title":"Panel Close Project",
            "workspaceRoot":state.path(),
            "defaultModelSelection":null,
            "createdAt":CREATED_AT
        })];
        for (thread_id, kind, host) in [
            ("host", "workspace", None),
            ("side", "workspace", None),
            ("panel", "panel", Some("host")),
        ] {
            commands.push(json!({
                "type":"thread.create",
                "commandId":format!("create-{thread_id}"),
                "threadId":thread_id,
                "projectId":"panel-close-project",
                "title":thread_id,
                "kind":kind,
                "hostThreadId":host,
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access",
                "interactionMode":"default",
                "branch":null,
                "worktreePath":null,
                "createdAt":CREATED_AT
            }));
        }
        for command in commands {
            engine
                .dispatch(decode_command(command))
                .await
                .expect("fixture command");
        }
        let probe = Arc::new(ModelMutationProbe::default());
        let provider = Arc::new(ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(ModelMutationProbeFactory(probe.clone())),
            ActivityProjection::new(ActivityRepository::new(
                engine.repositories().database().clone(),
            )),
            SupervisorOptions::default(),
        ));
        for thread_id in ["side", "panel"] {
            provider
                .launch(ProviderLaunchRequest {
                    thread_id: thread_id.to_owned(),
                    activity_causal_revision: 0,
                    provider: "codex".to_owned(),
                    provider_label: "Codex".to_owned(),
                    provider_instance_id: Some("codex".to_owned()),
                    binary_path: "probe".to_owned(),
                    cwd: state.path().to_path_buf(),
                    runtime_mode: "full-access".to_owned(),
                    interaction_mode: "default".to_owned(),
                    model: Some("gpt-5".to_owned()),
                    options: Vec::new(),
                    custom_models: Vec::new(),
                    service_tier: None,
                    effort: None,
                    agent: None,
                    resume_cursor: None,
                    environment: Default::default(),
                    endpoint: None,
                    server_password: None,
                    mcp: None,
                    codex_home: None,
                    open_url: None,
                    host_thread_id: None,
                    side_chat_host_thread_id: None,
                })
                .await
                .expect("provider launches");
        }
        let registration = ProviderRegistration {
            provider: provider.clone(),
            settings_root: state.path().to_path_buf(),
            attachments: AttachmentMaterializer::new(state.path().join("attachments")),
            turn_delivery: Arc::new(TurnDeliveryService::start_with_router(
                engine.clone(),
                1,
                Arc::new(|_| Box::pin(async { Ok(()) })),
            )),
            uploads: test_upload_registry(),
        };

        // Archiving an ordinary thread leaves its provider work alone.
        dispatch_prepared_for_test(
            &engine,
            Some(registration.clone()),
            decode_command(
                json!({"type":"thread.archive","commandId":"archive-side","threadId":"side"}),
            ),
        )
        .await
        .expect("side thread archives");
        assert_eq!(probe.interrupt_calls.load(Ordering::SeqCst), 0);

        // Closing a chat panel stops its work even when no client saw a running session.
        dispatch_prepared_for_test(
            &engine,
            Some(registration),
            decode_command(
                json!({"type":"thread.archive","commandId":"archive-panel","threadId":"panel"}),
            ),
        )
        .await
        .expect("panel archives");
        assert_eq!(probe.interrupt_calls.load(Ordering::SeqCst), 1);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn losing_generic_admission_never_reaches_the_provider() {
        let hooks = TestHooks::default();
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let engine = OrchestrationEngine::start(
            database.clone(),
            EngineOptions {
                test_hooks: hooks.clone(),
                ..EngineOptions::default()
            },
        )
        .await
        .expect("engine starts");
        engine
            .dispatch(decode_command(json!({
                "type":"project.create",
                "commandId":"provider-race-project-create",
                "projectId":"provider-race-project",
                "title":"Provider Race Project",
                "workspaceRoot":"C:/provider-race-project",
                "defaultModelSelection":null,
                "createdAt":CREATED_AT
            })))
            .await
            .expect("project created");
        engine
            .dispatch(decode_command(json!({
                "type":"thread.create",
                "commandId":"provider-race-thread-create",
                "threadId":"provider-race-thread",
                "projectId":"provider-race-project",
                "title":"Provider Race Thread",
                "kind":"workspace",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access",
                "interactionMode":"default",
                "branch":null,
                "worktreePath":null,
                "createdAt":CREATED_AT
            })))
            .await
            .expect("thread created");

        let probe = Arc::new(ModelMutationProbe::default());
        let provider = Arc::new(ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(ModelMutationProbeFactory(probe.clone())),
            ActivityProjection::new(ActivityRepository::new(database)),
            SupervisorOptions::default(),
        ));
        let state = tempfile::tempdir().expect("provider state");
        provider
            .launch(ProviderLaunchRequest {
                thread_id: "provider-race-thread".to_owned(),
                activity_causal_revision: 0,
                provider: "codex".to_owned(),
                provider_label: "Codex".to_owned(),
                provider_instance_id: Some("codex".to_owned()),
                binary_path: "probe".to_owned(),
                cwd: state.path().to_path_buf(),
                runtime_mode: "full-access".to_owned(),
                interaction_mode: "default".to_owned(),
                model: Some("gpt-5".to_owned()),
                options: Vec::new(),
                custom_models: Vec::new(),
                service_tier: None,
                effort: None,
                agent: None,
                resume_cursor: None,
                environment: Default::default(),
                endpoint: None,
                server_password: None,
                mcp: None,
                codex_home: None,
                open_url: None,
                host_thread_id: None,
                side_chat_host_thread_id: None,
            })
            .await
            .expect("provider launches");
        let delivery = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            Arc::new(|_| Box::pin(async { Ok(()) })),
        ));
        let registration = ProviderRegistration {
            provider: provider.clone(),
            settings_root: state.path().to_path_buf(),
            attachments: AttachmentMaterializer::new(state.path().join("attachments")),
            turn_delivery: delivery.clone(),
            uploads: test_upload_registry(),
        };
        let command = decode_command(json!({
            "type":"thread.meta.update",
            "commandId":"provider-race-command",
            "threadId":"provider-race-thread",
            "modelSelection":{"instanceId":"codex","model":"gpt-5.1"}
        }));
        let removal_claim = engine
            .acquire_command_admission("provider-race-command")
            .await
            .expect("removal owns absent provider command identity");
        let reserved = engine
            .reserve_worktree_removal_admission(
                &removal_claim,
                "provider-race-command",
                "provider-race-project",
                "removal-payload",
            )
            .await
            .expect("removal reserves the absent command identity");
        assert!(reserved.0.is_none());
        let generic_engine = engine.clone();
        let racing_registration = registration.clone();
        let mut generic = tokio::spawn(async move {
            dispatch_prepared_for_test(&generic_engine, Some(racing_registration), command).await
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut generic)
                .await
                .is_err(),
            "generic provider command must wait while removal owns the command ID"
        );
        drop(removal_claim);

        let error = generic
            .await
            .expect("generic dispatch joins")
            .expect_err("losing generic admission conflicts");
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|message| message.to_ascii_lowercase().contains("conflict"))
        );
        assert_eq!(
            probe.set_model_calls.load(Ordering::SeqCst),
            0,
            "a losing generic command must not mutate the provider"
        );
        let receipt = engine
            .repositories()
            .get_command_receipt("provider-race-command".to_owned())
            .await
            .expect("receipt read")
            .expect("removal receipt");
        assert_eq!(receipt.status, "reserved");
        assert_eq!(receipt.payload_digest.as_deref(), Some("removal-payload"));

        probe.fail_set_model_calls.store(1, Ordering::SeqCst);
        let resumable = decode_command(json!({
            "type":"thread.meta.update",
            "commandId":"provider-resume-command",
            "threadId":"provider-race-thread",
            "modelSelection":{"instanceId":"codex","model":"gpt-5.1"}
        }));
        dispatch_prepared_for_test(&engine, Some(registration.clone()), resumable.clone())
            .await
            .expect_err("injected provider failure leaves exact admission resumable");
        let calls_after_failure = probe.set_model_calls.load(Ordering::SeqCst);
        assert!(calls_after_failure > 0);
        let reserved = engine
            .repositories()
            .get_command_receipt("provider-resume-command".to_owned())
            .await
            .expect("resumable receipt read")
            .expect("resumable receipt");
        assert_eq!(reserved.status, "reserved");
        assert_eq!(
            reserved.payload_digest.as_deref(),
            Some(
                canonical_command_digest(&resumable)
                    .expect("resume digest")
                    .as_str()
            )
        );

        let accepted =
            dispatch_prepared_for_test(&engine, Some(registration.clone()), resumable.clone())
                .await
                .expect("same-digest retry resumes provider mutation and durable admission");
        let calls_after_retry = probe.set_model_calls.load(Ordering::SeqCst);
        assert!(calls_after_retry > calls_after_failure);
        assert_eq!(
            dispatch_prepared_for_test(&engine, Some(registration.clone()), resumable)
                .await
                .expect("accepted retry replays"),
            accepted
        );
        assert_eq!(
            probe.set_model_calls.load(Ordering::SeqCst),
            calls_after_retry,
            "accepted replay must not repeat provider mutation"
        );
        let changed = decode_command(json!({
            "type":"thread.meta.update",
            "commandId":"provider-resume-command",
            "threadId":"provider-race-thread",
            "modelSelection":{"instanceId":"codex","model":"gpt-5.2"}
        }));
        dispatch_prepared_for_test(&engine, Some(registration.clone()), changed)
            .await
            .expect_err("changed payload conflicts before provider mutation");
        assert_eq!(
            probe.set_model_calls.load(Ordering::SeqCst),
            calls_after_retry
        );

        let concurrent = decode_command(json!({
            "type":"thread.meta.update",
            "commandId":"provider-concurrent-command",
            "threadId":"provider-race-thread",
            "modelSelection":{"instanceId":"codex","model":"gpt-5.3"}
        }));
        let calls_before_concurrent = probe.set_model_calls.load(Ordering::SeqCst);
        let preparations_before_concurrent = hooks.generic_external_preparation_attempts();
        let provider_pause = probe.pause_next_set_model();
        let first_engine = engine.clone();
        let first_registration = registration.clone();
        let first_command = concurrent.clone();
        let first = tokio::spawn(async move {
            dispatch_prepared_for_test(&first_engine, Some(first_registration), first_command).await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            provider_pause.entered.notified(),
        )
        .await
        .expect("first matching claimant reaches provider mutation");
        let second_engine = engine.clone();
        let second_registration = registration.clone();
        let mut second = tokio::spawn(async move {
            dispatch_prepared_for_test(&second_engine, Some(second_registration), concurrent).await
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut second)
                .await
                .is_err(),
            "the matching waiter must not complete while the live claimant owns preparation"
        );
        assert_eq!(
            probe.set_model_calls.load(Ordering::SeqCst),
            calls_before_concurrent + 1,
            "matching live claimants must coalesce to one provider mutation"
        );
        assert_eq!(
            hooks.generic_external_preparation_attempts(),
            preparations_before_concurrent + 1,
            "the matching waiter must replay without entering provider preparation"
        );
        provider_pause.release.notify_one();
        let first_result = first
            .await
            .expect("first matching claimant joins")
            .expect("first matching claimant succeeds");
        let second_result = second
            .await
            .expect("second matching claimant joins")
            .expect("second matching claimant replays");
        assert_eq!(second_result, first_result);
        assert_eq!(
            probe.set_model_calls.load(Ordering::SeqCst),
            calls_before_concurrent + 1,
            "accepted replay must not reroute after waiting"
        );

        delivery.shutdown().await;
        provider.shutdown().await.expect("provider shutdown");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn registered_turn_rpc_atomically_admits_the_first_local_draft_turn() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let engine = OrchestrationEngine::start(database.clone(), EngineOptions::default())
            .await
            .expect("engine starts");
        let state = tempfile::tempdir().expect("provider state");
        engine
            .dispatch(decode_command(json!({
                "type": "project.create",
                "commandId": "local-draft-project-create",
                "projectId": "local-draft-project",
                "title": "Local draft project",
                "workspaceRoot": state.path(),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        let provider = Arc::new(ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(NeverFactory),
            ActivityProjection::new(ActivityRepository::new(database)),
            SupervisorOptions::default(),
        ));
        let router: DeliveryRouter = Arc::new(|_| Box::pin(async { Ok(()) }));
        let delivery = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            router,
        ));
        let mut registry = RpcRegistry::empty();
        register_orchestration_rpc_with_delivery(
            &mut registry,
            engine.clone(),
            provider.clone(),
            state.path().to_path_buf(),
            delivery.clone(),
            test_upload_registry(),
        );
        let handle = ServerRuntime::start_with_registry(
            ServerConfig::new(state.path())
                .with_bind("127.0.0.1", 0)
                .with_unsafe_no_auth(),
            registry,
        )
        .await
        .expect("registered RPC server starts");
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{}/ws", handle.local_addr()))
                .await
                .expect("registered RPC socket connects");
        let selection = json!({"instanceId": "codex", "model": "gpt-5"});
        dispatch_registered_command(
            &mut socket,
            "1",
            json!({
                "type": "thread.turn.start",
                "commandId": "local-draft-turn",
                "threadId": "local-draft-thread",
                "message": {
                    "messageId": "local-draft-message",
                    "role": "user",
                    "text": "first local draft message",
                    "attachments": []
                },
                "modelSelection": selection,
                "titleSeed": "First local draft",
                "runtimeMode": "full-access",
                "interactionMode": "default",
                "bootstrap": {
                    "createThread": {
                        "projectId": "local-draft-project",
                        "title": "First local draft",
                        "modelSelection": selection,
                        "runtimeMode": "full-access",
                        "interactionMode": "default",
                        "branch": null,
                        "worktreePath": null,
                        "createdAt": CREATED_AT
                    }
                },
                "createdAt": CREATED_AT
            }),
        )
        .await
        .expect("ChatView local draft shape is admitted");
        assert!(
            engine
                .repositories()
                .get_thread("local-draft-thread".to_owned())
                .await
                .expect("thread read")
                .is_some(),
            "the composite admission creates the draft thread"
        );
        let outbox = engine
            .repositories()
            .get_provider_turn_delivery("local-draft-turn".to_owned())
            .await
            .expect("outbox read")
            .expect("outbox row");
        assert_eq!(outbox.thread_id, "local-draft-thread");
        assert_eq!(outbox.message_id, "local-draft-message");
        assert_eq!(outbox.provider_instance_id, "codex");
        let frozen_fingerprint = outbox.payload["_bibcodeProviderRouteFingerprint"]
            .as_str()
            .expect("admission persists a provider route fingerprint");
        assert_eq!(frozen_fingerprint.len(), 64);
        let frozen_command = serde_json::from_value::<OrchestrationCommand>(outbox.payload.clone())
            .expect("the internal route field does not alter provider command decoding");
        let mut repeated_payload =
            serde_json::to_value(&frozen_command).expect("repeat route payload");
        freeze_delivery_route(
            &engine,
            &state.path().to_path_buf(),
            &frozen_command,
            &mut repeated_payload,
        )
        .await
        .expect("unchanged settings refreeze deterministically");
        assert_eq!(
            repeated_payload["_bibcodeProviderRouteFingerprint"],
            outbox.payload["_bibcodeProviderRouteFingerprint"]
        );

        socket
            .close(None)
            .await
            .expect("close registered RPC socket");
        handle.shutdown();
        handle.join().await.expect("registered RPC server joins");
        delivery.shutdown().await;
        provider.shutdown().await.expect("provider shutdown");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn interrupted_turn_cannot_commit_after_authoritative_workspace_loss() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let hooks = TestHooks::default();
        let engine = OrchestrationEngine::start(
            database.clone(),
            EngineOptions {
                test_hooks: hooks.clone(),
                ..EngineOptions::default()
            },
        )
        .await
        .expect("engine starts");
        let state = tempfile::tempdir().expect("provider state");
        engine
            .dispatch(decode_command(json!({
                "type": "project.create",
                "commandId": "loss-project-create",
                "projectId": "loss-project",
                "title": "Loss project",
                "workspaceRoot": state.path(),
                "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        let thread_id = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot")
            .threads
            .into_iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id;
        let provider = Arc::new(ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(NeverFactory),
            ActivityProjection::new(ActivityRepository::new(database)),
            SupervisorOptions::default(),
        ));
        let router: DeliveryRouter = Arc::new(|_| Box::pin(async { Ok(()) }));
        let delivery = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            router,
        ));
        let availability = WorkspaceAvailabilityRegistry::new();
        let mut registry = RpcRegistry::empty();
        register_orchestration_rpc_with_delivery_and_availability(
            &mut registry,
            engine.clone(),
            provider.clone(),
            state.path().to_path_buf(),
            delivery.clone(),
            availability.clone(),
            test_upload_registry(),
            None,
        );
        let handle = ServerRuntime::start_with_registry(
            ServerConfig::new(state.path())
                .with_bind("127.0.0.1", 0)
                .with_unsafe_no_auth(),
            registry,
        )
        .await
        .expect("registered RPC server starts");
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{}/ws", handle.local_addr()))
                .await
                .expect("registered RPC socket connects");
        let durable_after_disconnect = json!({
            "type": "thread.turn.start",
            "commandId": "disconnect-only-turn",
            "threadId": thread_id,
            "message": {
                "messageId": "disconnect-only-message",
                "role": "user",
                "text": "must retain durable handoff",
                "attachments": []
            },
            "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "createdAt": CREATED_AT
        });
        let disconnect_pause = hooks.pause_before_next_command_persist();
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": "6",
                    "tag": "orchestration.dispatchCommand",
                    "payload": durable_after_disconnect,
                    "headers": []
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send disconnect-only turn request");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            disconnect_pause.wait_until_entered(),
        )
        .await
        .expect("disconnect-only turn reaches persistence");
        socket
            .send(Message::Text(
                json!({"_tag": "Interrupt", "requestId": "6"})
                    .to_string()
                    .into(),
            ))
            .await
            .expect("interrupt disconnect-only request");
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            next_frame_past_heartbeat(&mut socket),
        )
        .await
        .expect("disconnect-only interrupt response timeout")
        .expect("disconnect-only interrupt response")
        .expect("disconnect-only interrupt frame");
        disconnect_pause.release();
        let disconnect_scope = WorkspaceLossTransition {
            thread_id: thread_id.clone(),
            repository_key: "loss-repository".to_owned(),
            generation: 0,
            path: state.path().to_path_buf(),
            availability: AdoptedWorktreeAvailability::MissingRegistered,
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            availability.wait_for_transition_admissions(&disconnect_scope),
        )
        .await
        .expect("queued command retains and then releases its admission lease");
        assert!(
            engine
                .repositories()
                .get_command_receipt("disconnect-only-turn".to_owned())
                .await
                .expect("disconnect-only receipt")
                .is_some(),
            "RPC interruption alone preserves durable command handoff"
        );
        dispatch_registered_command(&mut socket, "9", durable_after_disconnect)
            .await
            .expect("interrupted durable command replays exactly");
        let event_count_before_loss_turn = engine
            .read_events(0)
            .await
            .expect("events before loss turn")
            .len();

        let pause = hooks.pause_before_next_command_finalization();
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": "7",
                    "tag": "orchestration.dispatchCommand",
                    "payload": {
                        "type": "thread.turn.start",
                        "commandId": "loss-turn",
                        "threadId": thread_id,
                        "message": {
                            "messageId": "loss-message",
                            "role": "user",
                            "text": "must not commit after loss",
                            "attachments": []
                        },
                        "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
                        "createdAt": CREATED_AT
                    },
                    "headers": []
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send turn request");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::select! {
                () = pause.wait_until_entered() => {}
                frame = next_frame_past_heartbeat(&mut socket) => {
                    panic!("turn exited before persistence: {frame:?}")
                }
            }
        })
        .await
        .expect("turn reaches the SQLite pre-finalization barrier");
        socket
            .send(Message::Text(
                json!({"_tag": "Interrupt", "requestId": "7"})
                    .to_string()
                    .into(),
            ))
            .await
            .expect("interrupt turn request");
        let interrupted = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            next_frame_past_heartbeat(&mut socket),
        )
        .await
        .expect("interrupt response timeout")
        .expect("interrupt response")
        .expect("interrupt frame");
        assert!(matches!(interrupted, Message::Text(_)));

        let loss = WorkspaceLossTransition {
            thread_id: thread_id.clone(),
            repository_key: "loss-repository".to_owned(),
            generation: 1,
            path: state.path().to_path_buf(),
            availability: AdoptedWorktreeAvailability::MissingRegistered,
        };
        assert!(
            availability
                .mark_unavailable(loss.clone())
                .await
                .expect("physical identity resolves")
        );
        pause.release();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            availability.wait_for_transition_admissions(&loss),
        )
        .await
        .expect("workspace admission drains after the SQLite barrier releases");

        let receipt = engine
            .repositories()
            .get_command_receipt("loss-turn".to_owned())
            .await
            .expect("receipt lookup");
        let outbox = engine
            .repositories()
            .get_provider_turn_delivery("loss-turn".to_owned())
            .await
            .expect("outbox lookup");
        let event_count_after_loss_turn = engine
            .read_events(0)
            .await
            .expect("events after loss turn")
            .len();
        let messages = thread_snapshot(&engine, &thread_id)
            .await
            .expect("thread snapshot")["thread"]["messages"]
            .as_array()
            .expect("messages")
            .clone();
        assert!(
            messages
                .iter()
                .any(|message| { message["id"] == "disconnect-only-message" })
        );
        assert!(
            receipt.is_none()
                && outbox.is_none()
                && event_count_after_loss_turn == event_count_before_loss_turn
                && !messages
                    .iter()
                    .any(|message| message["id"] == "loss-message"),
            "loss-before-finalization must roll back every artifact; receipt={}, outbox={}, events_before={event_count_before_loss_turn}, events_after={event_count_after_loss_turn}, message={} ",
            receipt.is_some(),
            outbox.is_some(),
            messages
                .iter()
                .any(|message| message["id"] == "loss-message"),
        );

        availability
            .clear_recovered_in_repository(&thread_id, state.path(), "loss-repository")
            .await
            .expect("physical identity resolves");
        for (suffix, generation, source_plan) in [
            ("accepted", 2_u64, None),
            ("rejected", 3_u64, Some("missing-forced-order-plan")),
        ] {
            let finalization_pause = hooks.pause_before_next_command_finalization();
            let rejection_pause = availability.pause_after_next_finalization_rejection();
            let mut payload = json!({
                "type": "thread.turn.start",
                "commandId": format!("forced-order-{suffix}-turn"),
                "threadId": thread_id,
                "message": {
                    "messageId": format!("forced-order-{suffix}-message"),
                    "role": "user",
                    "text": "loss must retain its exact public error",
                    "attachments": []
                },
                "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "createdAt": CREATED_AT
            });
            if let Some(plan_id) = source_plan {
                payload["sourceProposedPlan"] = json!({
                    "threadId": thread_id,
                    "planId": plan_id,
                });
            }
            let request = dispatch_registered_command(&mut socket, "12", payload);
            tokio::pin!(request);
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                tokio::select! {
                    () = finalization_pause.wait_until_entered() => {}
                    result = &mut request => panic!("forced-order turn exited before finalization: {result:?}"),
                }
            })
            .await
            .expect("forced-order turn reaches pre-finalization barrier");

            let forced_loss = WorkspaceLossTransition {
                thread_id: thread_id.clone(),
                repository_key: "loss-repository".to_owned(),
                generation,
                path: state.path().to_path_buf(),
                availability: AdoptedWorktreeAvailability::MissingRegistered,
            };
            let loss_availability = availability.clone();
            let loss_transition = forced_loss.clone();
            let runtime = tokio::runtime::Handle::current();
            let loss_task = tokio::task::spawn_blocking(move || {
                runtime.block_on(loss_availability.mark_unavailable(loss_transition))
            });
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                rejection_pause.wait_until_entered(),
            )
            .await
            .expect("loss rejects finalization before publishing cancellation");
            finalization_pause.release();

            let error = request
                .await
                .expect_err("loss-wins RPC returns a typed failure");
            rejection_pause.release();
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(5), loss_task)
                    .await
                    .expect("forced-order loss completes")
                    .expect("forced-order loss joins")
                    .expect("physical identity resolves")
            );
            assert_eq!(
                error[0]["error"]["_tag"], "WorkspaceUnavailableError",
                "accepted and rejected persistence must not expose generic cancellation"
            );
            assert_eq!(error[0]["error"]["threadId"], thread_id);
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                availability.wait_for_transition_admissions(&forced_loss),
            )
            .await
            .expect("forced-order admission drains");
            assert!(
                engine
                    .repositories()
                    .get_command_receipt(format!("forced-order-{suffix}-turn"))
                    .await
                    .expect("forced-order receipt lookup")
                    .is_none()
            );
            availability
                .clear_recovered_in_repository(&thread_id, state.path(), "loss-repository")
                .await
                .expect("physical identity resolves");
        }
        let commit_wins_pause = hooks.pause_after_next_command_finalization();
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": "8",
                    "tag": "orchestration.dispatchCommand",
                    "payload": {
                        "type": "thread.turn.start",
                        "commandId": "commit-wins-turn",
                        "threadId": thread_id,
                        "message": {
                            "messageId": "commit-wins-message",
                            "role": "user",
                            "text": "commit finalization wins before loss",
                            "attachments": []
                        },
                        "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
                        "createdAt": CREATED_AT
                    },
                    "headers": []
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send commit-wins turn request");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            commit_wins_pause.wait_until_entered(),
        )
        .await
        .expect("turn acquires finalization fence before SQLite commit");
        let commit_wins_loss = WorkspaceLossTransition {
            thread_id: thread_id.clone(),
            repository_key: "loss-repository".to_owned(),
            generation: 4,
            path: state.path().to_path_buf(),
            availability: AdoptedWorktreeAvailability::MissingRegistered,
        };
        let (loss_started_tx, loss_started_rx) = tokio::sync::oneshot::channel();
        let commit_wins_availability = availability.clone();
        let commit_wins_transition = commit_wins_loss.clone();
        let runtime = tokio::runtime::Handle::current();
        let loss_task = tokio::task::spawn_blocking(move || {
            let _ = loss_started_tx.send(());
            runtime.block_on(commit_wins_availability.mark_unavailable(commit_wins_transition))
        });
        loss_started_rx.await.expect("loss task starts");
        tokio::task::yield_now().await;
        assert!(
            !loss_task.is_finished(),
            "loss cannot linearize while the SQLite commit permit is held"
        );
        commit_wins_pause.release();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), loss_task)
                .await
                .expect("loss completes after commit")
                .expect("loss task joins")
                .expect("physical identity resolves")
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            availability.wait_for_transition_admissions(&commit_wins_loss),
        )
        .await
        .expect("commit-wins admission drains");
        assert!(
            engine
                .repositories()
                .get_command_receipt("commit-wins-turn".to_owned())
                .await
                .expect("commit-wins receipt lookup")
                .is_some(),
            "a command that owns finalization must commit before loss"
        );
        assert!(
            engine
                .repositories()
                .get_provider_turn_delivery("commit-wins-turn".to_owned())
                .await
                .expect("commit-wins outbox lookup")
                .is_some(),
            "the provider outbox commits in the same transaction"
        );

        availability
            .clear_recovered_in_repository(&thread_id, state.path(), "loss-repository")
            .await
            .expect("physical identity resolves");
        let rejected_loss_wins_pause = hooks.pause_before_next_command_finalization();
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": "10",
                    "tag": "orchestration.dispatchCommand",
                    "payload": {
                        "type": "thread.turn.start",
                        "commandId": "rejected-loss-wins-turn",
                        "threadId": thread_id,
                        "message": {
                            "messageId": "rejected-loss-wins-message",
                            "role": "user",
                            "text": "missing source plan must reject",
                            "attachments": []
                        },
                        "sourceProposedPlan": {
                            "threadId": thread_id,
                            "planId": "missing-plan"
                        },
                        "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
                        "createdAt": CREATED_AT
                    },
                    "headers": []
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send rejected loss-wins request");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            rejected_loss_wins_pause.wait_until_entered(),
        )
        .await
        .expect("rejection reaches the SQLite pre-finalization barrier");
        let rejected_loss = WorkspaceLossTransition {
            thread_id: thread_id.clone(),
            repository_key: "loss-repository".to_owned(),
            generation: 5,
            path: state.path().to_path_buf(),
            availability: AdoptedWorktreeAvailability::MissingRegistered,
        };
        assert!(
            availability
                .mark_unavailable(rejected_loss.clone())
                .await
                .expect("physical identity resolves")
        );
        rejected_loss_wins_pause.release();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            availability.wait_for_transition_admissions(&rejected_loss),
        )
        .await
        .expect("rejected loss-wins admission drains");
        assert!(
            engine
                .repositories()
                .get_command_receipt("rejected-loss-wins-turn".to_owned())
                .await
                .expect("rejected loss-wins receipt lookup")
                .is_none(),
            "loss-before-finalization must roll back a rejected receipt"
        );

        availability
            .clear_recovered_in_repository(&thread_id, state.path(), "loss-repository")
            .await
            .expect("physical identity resolves");
        let rejected_commit_wins_pause = hooks.pause_after_next_command_finalization();
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": "11",
                    "tag": "orchestration.dispatchCommand",
                    "payload": {
                        "type": "thread.turn.start",
                        "commandId": "rejected-commit-wins-turn",
                        "threadId": thread_id,
                        "message": {
                            "messageId": "rejected-commit-wins-message",
                            "role": "user",
                            "text": "rejection finalization wins before loss",
                            "attachments": []
                        },
                        "sourceProposedPlan": {
                            "threadId": thread_id,
                            "planId": "still-missing-plan"
                        },
                        "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
                        "createdAt": CREATED_AT
                    },
                    "headers": []
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send rejected commit-wins request");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            rejected_commit_wins_pause.wait_until_entered(),
        )
        .await
        .expect("rejection owns finalization before SQLite commit");
        let rejected_commit_wins_loss = WorkspaceLossTransition {
            thread_id: thread_id.clone(),
            repository_key: "loss-repository".to_owned(),
            generation: 6,
            path: state.path().to_path_buf(),
            availability: AdoptedWorktreeAvailability::MissingRegistered,
        };
        let (rejected_loss_started_tx, rejected_loss_started_rx) = tokio::sync::oneshot::channel();
        let rejected_commit_wins_availability = availability.clone();
        let rejected_commit_wins_transition = rejected_commit_wins_loss.clone();
        let runtime = tokio::runtime::Handle::current();
        let rejected_loss_task = tokio::task::spawn_blocking(move || {
            let _ = rejected_loss_started_tx.send(());
            runtime.block_on(
                rejected_commit_wins_availability.mark_unavailable(rejected_commit_wins_transition),
            )
        });
        rejected_loss_started_rx
            .await
            .expect("rejected loss task starts");
        tokio::task::yield_now().await;
        assert!(
            !rejected_loss_task.is_finished(),
            "loss cannot linearize while rejected-receipt finalization is held"
        );
        rejected_commit_wins_pause.release();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), rejected_loss_task,)
                .await
                .expect("rejected loss completes after commit")
                .expect("rejected loss task joins")
                .expect("physical identity resolves")
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            availability.wait_for_transition_admissions(&rejected_commit_wins_loss),
        )
        .await
        .expect("rejected commit-wins admission drains");
        let rejected_receipt = engine
            .repositories()
            .get_command_receipt("rejected-commit-wins-turn".to_owned())
            .await
            .expect("rejected commit-wins receipt lookup")
            .expect("rejected receipt commits before loss");
        assert_eq!(rejected_receipt.status, "rejected");
        assert!(
            engine
                .repositories()
                .get_provider_turn_delivery("rejected-commit-wins-turn".to_owned())
                .await
                .expect("rejected commit-wins outbox lookup")
                .is_none(),
            "a rejected turn cannot create provider delivery"
        );

        socket.close(None).await.expect("close socket");
        handle.shutdown();
        handle.join().await.expect("server joins");
        delivery.shutdown().await;
        provider.shutdown().await.expect("provider shutdown");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn delivery_resolution_command_id_conflicts_on_changed_payload() {
        let (_, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        seed_delivery(
            &engine,
            "delivery-first",
            &thread_id,
            "message-first",
            TurnDeliveryState::Uncertain,
        )
        .await;
        seed_delivery(
            &engine,
            "delivery-second",
            &thread_id,
            "message-second",
            TurnDeliveryState::Uncertain,
        )
        .await;
        let command_id = "resolve-delivery-once";
        dispatch_prepared_for_test(
            &engine,
            None,
            delivery_resolution(command_id, &thread_id, "message-first", "retry"),
        )
        .await
        .expect("first resolution commits");
        let event_count = engine
            .read_events(0)
            .await
            .expect("events before conflict")
            .len();

        let conflict = dispatch_prepared_for_test(
            &engine,
            None,
            delivery_resolution(command_id, &thread_id, "message-second", "dismiss"),
        )
        .await
        .expect_err("changed resolution payload must conflict");

        assert_eq!(conflict["_tag"], "OrchestrationDispatchCommandError");
        assert!(conflict["message"].as_str().is_some_and(|message| {
            message.contains(command_id) && message.to_ascii_lowercase().contains("conflict")
        }));
        assert_eq!(
            engine
                .read_events(0)
                .await
                .expect("events after conflict")
                .len(),
            event_count,
            "a conflicting replay cannot append a second transition"
        );
        assert_eq!(
            engine
                .repositories()
                .get_provider_turn_delivery("delivery-first".to_owned())
                .await
                .expect("first row")
                .expect("first delivery")
                .state,
            TurnDeliveryState::Pending
        );
        assert_eq!(
            engine
                .repositories()
                .get_provider_turn_delivery("delivery-second".to_owned())
                .await
                .expect("second row")
                .expect("second delivery")
                .state,
            TurnDeliveryState::Uncertain
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn delivery_resolution_receipts_keep_canonical_digest_when_accepted_or_rejected() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        seed_delivery(
            &engine,
            "receipt-target",
            &thread_id,
            "receipt-target-message",
            TurnDeliveryState::Uncertain,
        )
        .await;

        let accepted = delivery_resolution(
            "accepted-resolution-receipt",
            &thread_id,
            "receipt-target-message",
            "retry",
        );
        let accepted_digest = canonical_command_digest(&accepted).expect("accepted digest");
        dispatch_prepared_for_test(&engine, None, accepted)
            .await
            .expect("resolution accepted");
        let accepted_receipt = engine
            .repositories()
            .get_command_receipt("accepted-resolution-receipt".to_owned())
            .await
            .expect("accepted receipt read")
            .expect("accepted receipt");
        assert_eq!(accepted_receipt.status, "accepted");
        assert_eq!(accepted_receipt.payload_digest, Some(accepted_digest));

        let rejected = delivery_resolution(
            "rejected-resolution-receipt",
            &thread_id,
            "missing-message",
            "dismiss",
        );
        let rejected_digest = canonical_command_digest(&rejected).expect("rejected digest");
        dispatch_prepared_for_test(&engine, None, rejected)
            .await
            .expect_err("resolution without a delivery is rejected");
        let rejected_receipt = engine
            .repositories()
            .get_command_receipt("rejected-resolution-receipt".to_owned())
            .await
            .expect("rejected receipt read")
            .expect("rejected receipt");
        assert_eq!(rejected_receipt.status, "rejected");
        assert_eq!(rejected_receipt.payload_digest, Some(rejected_digest));

        let conflict = dispatch_prepared_for_test(
            &engine,
            None,
            delivery_resolution(
                "rejected-resolution-receipt",
                &thread_id,
                "receipt-target-message",
                "retry",
            ),
        )
        .await
        .expect_err("changed replay of a rejected command conflicts");
        assert!(
            conflict["message"]
                .as_str()
                .is_some_and(|message| message.to_ascii_lowercase().contains("conflict"))
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn committed_resolution_wakes_idle_delivery_once_and_conflict_does_not_rewake() {
        let (database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        seed_delivery(
            &engine,
            "wake-target",
            &thread_id,
            "wake-target-message",
            TurnDeliveryState::Uncertain,
        )
        .await;
        let initial_read = engine
            .repositories()
            .pause_after_next_provider_turn_read_for_test();
        let (route_sender, mut routes) = mpsc::unbounded_channel();
        let route_release = Arc::new(tokio::sync::Notify::new());
        let router: DeliveryRouter = Arc::new({
            let route_release = route_release.clone();
            move |command| {
                let route_sender = route_sender.clone();
                let route_release = route_release.clone();
                Box::pin(async move {
                    let _ = route_sender.send(command);
                    route_release.notified().await;
                    Ok(())
                })
            }
        });
        let service = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            router,
        ));
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            initial_read.wait_until_entered(),
        )
        .await
        .expect("dispatcher captures uncertain idle snapshot");

        let state = tempfile::tempdir().expect("provider state");
        let (registration, provider) = provider_registration(
            database,
            &engine,
            state.path().to_path_buf(),
            service.clone(),
        );
        let resolution = delivery_resolution(
            "wake-resolution",
            &thread_id,
            "wake-target-message",
            "retry",
        );
        dispatch_prepared_for_test(&engine, Some(registration.clone()), resolution.clone())
            .await
            .expect("retry resolution commits");
        assert_eq!(
            engine
                .repositories()
                .get_provider_turn_delivery("wake-target".to_owned())
                .await
                .expect("target delivery")
                .expect("target row")
                .state,
            TurnDeliveryState::Pending,
            "retry must commit before the wake is observable"
        );
        initial_read.release();
        let routed = tokio::time::timeout(std::time::Duration::from_secs(5), routes.recv())
            .await
            .expect("committed retry wakes dispatcher")
            .expect("routed command");
        assert!(matches!(
            routed,
            OrchestrationCommand::ThreadTurnStart { ref command_id, .. }
                if command_id == "wake-target"
        ));
        let post_delivery_read = engine
            .repositories()
            .pause_after_next_provider_turn_read_for_test();
        route_release.notify_one();
        wait_for_delivery_state(&engine, "wake-target", TurnDeliveryState::Delivered).await;
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            post_delivery_read.wait_until_entered(),
        )
        .await
        .expect("dispatcher captures empty post-delivery snapshot");

        seed_delivery(
            &engine,
            "must-stay-idle",
            &thread_id,
            "must-stay-idle-message",
            TurnDeliveryState::Pending,
        )
        .await;
        post_delivery_read.release();
        let event_count = engine
            .read_events(0)
            .await
            .expect("events before conflict")
            .len();
        let conflict = dispatch_prepared_for_test(
            &engine,
            Some(registration),
            delivery_resolution(
                "wake-resolution",
                &thread_id,
                "must-stay-idle-message",
                "dismiss",
            ),
        )
        .await;
        let unexpected_route =
            tokio::time::timeout(std::time::Duration::from_millis(250), routes.recv()).await;
        if unexpected_route.is_ok() {
            route_release.notify_one();
        }
        service.shutdown().await;
        provider.shutdown().await.expect("provider shutdown");

        assert!(
            unexpected_route.is_err(),
            "a conflicting resolution must not wake or forward work to the provider router: {unexpected_route:?}"
        );
        let conflict = conflict.expect_err("changed resolution payload must conflict");
        assert!(
            conflict["message"]
                .as_str()
                .is_some_and(|message| message.to_ascii_lowercase().contains("conflict"))
        );
        assert_eq!(
            engine
                .read_events(0)
                .await
                .expect("events after conflict")
                .len(),
            event_count
        );
        assert_eq!(
            engine
                .repositories()
                .get_provider_turn_delivery("must-stay-idle".to_owned())
                .await
                .expect("idle delivery")
                .expect("idle row")
                .state,
            TurnDeliveryState::Pending
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn rolled_back_resolution_does_not_wake_idle_delivery() {
        let hooks = TestHooks::default();
        let (database, engine, thread_id) = delivery_engine(hooks.clone()).await;
        seed_delivery(
            &engine,
            "rollback-target",
            &thread_id,
            "rollback-target-message",
            TurnDeliveryState::Uncertain,
        )
        .await;
        let initial_read = engine
            .repositories()
            .pause_after_next_provider_turn_read_for_test();
        let router: DeliveryRouter = Arc::new(|_| Box::pin(async { Ok(()) }));
        let service = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            router,
        ));
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            initial_read.wait_until_entered(),
        )
        .await
        .expect("dispatcher captures uncertain idle snapshot");

        let state = tempfile::tempdir().expect("provider state");
        let (registration, provider) = provider_registration(
            database,
            &engine,
            state.path().to_path_buf(),
            service.clone(),
        );
        hooks.fail_next_projector(
            "projection.thread-messages",
            Some("thread.turn-delivery-updated"),
        );
        let result = dispatch_prepared_for_test(
            &engine,
            Some(registration),
            delivery_resolution(
                "rollback-resolution",
                &thread_id,
                "rollback-target-message",
                "retry",
            ),
        )
        .await;
        assert!(result.is_err(), "projector failure rejects the resolution");
        let post_failure_read = engine
            .repositories()
            .pause_after_next_provider_turn_read_for_test();
        initial_read.release();
        let unexpected_read = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            post_failure_read.wait_until_entered(),
        )
        .await;
        service.shutdown().await;
        provider.shutdown().await.expect("provider shutdown");

        assert!(
            unexpected_read.is_err(),
            "a rolled-back resolution must not notify the idle dispatcher"
        );
        assert_eq!(
            engine
                .repositories()
                .get_provider_turn_delivery("rollback-target".to_owned())
                .await
                .expect("rollback delivery")
                .expect("rollback row")
                .state,
            TurnDeliveryState::Uncertain
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn attachment_preparation_sanitizes_before_dispatch_and_rejects_before_events() {
        let engine = migrated_engine().await;
        engine
            .dispatch(decode_command(json!({
                "type": "project.create", "commandId": "create-project", "projectId": "project-1",
                "title": "Project", "workspaceRoot": "C:/repo", "defaultModelSelection": null,
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        let thread_id = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot")
            .threads
            .into_iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id;
        let state = tempfile::tempdir().expect("state directory");
        let attachments = AttachmentMaterializer::new(state.path().join("attachments"));
        let command = decode_command(json!({
            "type": "thread.turn.start", "commandId": "start-with-upload", "threadId": thread_id.clone(),
            "message": {"messageId":"message-1", "role":"user", "text":"review", "attachments":[{
                "type":"file", "id":"notes-1", "name":"notes.txt", "mimeType":"text/plain",
                "sizeBytes":5, "dataUrl":"data:text/plain;base64,bm90ZXM="
            }]}, "createdAt": CREATED_AT,
        }));
        let (command, prepared) = prepare_attachments(
            &attachments,
            command,
            &ReusableAttachments::new(),
            &UploadOwner::Unauthenticated,
            &test_upload_registry(),
        )
        .await
        .expect("upload prepares");
        engine.dispatch(command).await.expect("turn dispatches");
        prepared.expect("attachment batch").commit();
        let snapshot = thread_snapshot(&engine, &thread_id)
            .await
            .expect("thread snapshot");
        let message = snapshot["thread"]["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .find(|message| message["id"] == "message-1")
            .expect("user message");
        assert_eq!(
            message["attachments"],
            json!([{
                "type":"file", "id":"notes-1", "name":"notes.txt", "mimeType":"text/plain", "sizeBytes":5
            }])
        );
        let event_count = engine.read_events(0).await.expect("events").len();
        let rejected = prepare_attachments(
            &attachments,
            decode_command(json!({
                "type": "thread.turn.start", "commandId": "reject-upload", "threadId": thread_id.clone(),
                "message": {"messageId":"message-2", "role":"user", "text":"review", "attachments":[{
                    "type":"file", "id":"notes-2", "name":"notes.txt", "mimeType":"text/plain",
                    "sizeBytes":5, "dataUrl":"data:text/plain,notes"
                }]}, "createdAt": CREATED_AT,
            })),
            &ReusableAttachments::new(), &UploadOwner::Unauthenticated, &test_upload_registry())
        .await
        .expect_err("malformed upload rejects before dispatch");
        assert_eq!(
            invalid_request("orchestration.dispatchCommand", rejected.to_string())["_tag"],
            "InvalidRequest"
        );
        assert_eq!(
            engine.read_events(0).await.expect("events").len(),
            event_count,
            "preparation failure cannot persist a message or turn"
        );
        engine.shutdown().await;
    }

    #[test]
    fn provider_failures_use_the_declared_dispatch_error_contract() {
        assert_eq!(
            provider_command_error("provider failed"),
            json!({
                "_tag": "OrchestrationDispatchCommandError",
                "message": "provider failed",
            })
        );
    }

    #[tokio::test]
    async fn empty_default_and_workspace_snapshots_match_the_thread_contract() {
        let engine = migrated_engine().await;
        engine
            .dispatch(decode_command(json!({
                "type": "project.create",
                "commandId": "create-project",
                "projectId": "project-1",
                "title": "Project",
                "workspaceRoot": "C:/repo",
                "defaultModelSelection": null,
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");

        let projection = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot");
        let default_id = projection
            .threads
            .iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id
            .clone();
        let default_snapshot = thread_snapshot(&engine, &default_id)
            .await
            .expect("default snapshot");
        assert_empty_thread_contract(&default_snapshot["thread"], "default");

        engine
            .dispatch(decode_command(json!({
                "type": "thread.create",
                "commandId": "create-workspace",
                "threadId": "workspace-1",
                "projectId": "project-1",
                "title": "Workspace",
                "kind": "workspace",
                "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "runtimeMode": "full-access",
                "interactionMode": "default",
                "branch": "feature",
                "worktreePath": "C:/repo-worktrees/feature",
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("workspace thread created");
        let workspace_snapshot = thread_snapshot(&engine, "workspace-1")
            .await
            .expect("workspace snapshot");
        assert_empty_thread_contract(&workspace_snapshot["thread"], "workspace");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn populated_thread_snapshot_uses_the_message_wire_contract() {
        let engine = migrated_engine().await;
        engine
            .dispatch(decode_command(json!({
                "type": "project.create",
                "commandId": "create-project",
                "projectId": "project-1",
                "title": "Project",
                "workspaceRoot": "C:/repo",
                "defaultModelSelection": null,
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        let projection = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot");
        let default_id = projection
            .threads
            .iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id
            .clone();
        engine
            .dispatch(decode_command(json!({
                "type": "thread.turn.start",
                "commandId": "start-turn",
                "threadId": default_id,
                "message": {
                    "messageId": "message-1",
                    "role": "user",
                    "text": "hello",
                    "attachments": []
                },
                "modelSelection": {"instanceId": "codex", "model": "gpt-5"},
                "runtimeMode": "full-access",
                "interactionMode": "default",
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("turn started");
        engine
            .dispatch(decode_command(json!({
                "type": "thread.activity.append",
                "commandId": "legacy-activity",
                "threadId": default_id,
                "activity": {
                    "id": "activity-1",
                    "tone": "status",
                    "kind": "provider.session",
                    "summary": "session.ready",
                    "payload": {},
                    "turnId": null,
                    "createdAt": CREATED_AT
                },
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("legacy activity stored");
        for command in [
            json!({"type":"thread.session.set","commandId":"session","threadId":default_id,"session":{"threadId":default_id,"status":"running","providerName":"codex","providerInstanceId":"codex","runtimeMode":"full-access","activeTurnId":"turn-1","lastError":null,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
            json!({"type":"thread.message.assistant.delta","commandId":"assistant-delta","threadId":default_id,"messageId":"assistant-1","delta":"working","turnId":"turn-1","createdAt":CREATED_AT}),
            json!({"type":"thread.proposed-plan.upsert","commandId":"plan","threadId":default_id,"proposedPlan":{"id":"plan-1","turnId":"turn-1","planMarkdown":"# Plan","createdAt":CREATED_AT,"updatedAt":CREATED_AT},"createdAt":CREATED_AT}),
            json!({"type":"thread.turn.diff.complete","commandId":"checkpoint","threadId":default_id,"turnId":"turn-1","completedAt":CREATED_AT,"checkpointRef":"checkpoint-1","status":"ready","files":[],"assistantMessageId":"assistant-1","checkpointTurnCount":1,"createdAt":CREATED_AT}),
        ] {
            engine
                .dispatch(decode_command(command))
                .await
                .expect("populated snapshot fixture command");
        }

        let mut persisted = engine
            .repositories()
            .get_message("message-1".to_owned())
            .await
            .expect("message lookup")
            .expect("message exists");
        persisted.delivery_state = Some("uncertain".to_owned());
        persisted.delivery_provider = Some("claudeAgent".to_owned());
        persisted.delivery_detail = Some("connection lost after write".to_owned());
        engine
            .repositories()
            .upsert_message(persisted)
            .await
            .expect("delivery projection stored");

        let snapshot = thread_snapshot(&engine, &default_id)
            .await
            .expect("thread snapshot");
        let message = snapshot["thread"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "user")
            .unwrap();
        assert_eq!(message["streaming"], json!(false));
        assert!(message.get("isStreaming").is_none());
        assert_eq!(
            message["delivery"],
            json!({
                "state": "uncertain",
                "provider": "claudeAgent",
                "detail": "connection lost after write",
            })
        );
        assert_eq!(snapshot["thread"]["activities"][0]["tone"], json!("info"));
        assert_eq!(
            snapshot["thread"]["proposedPlans"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            snapshot["thread"]["checkpoints"].as_array().unwrap().len(),
            1
        );
        assert_eq!(snapshot["thread"]["session"]["status"], "running");
        assert_eq!(snapshot["thread"]["latestTurn"]["turnId"], "turn-1");
        for provider_instance_id in [Some("claude-personal"), None] {
            let mut message = engine
                .repositories()
                .get_message("message-1".to_owned())
                .await
                .expect("message lookup")
                .expect("message");
            message.delivery_provider_instance_id = provider_instance_id.map(str::to_owned);
            engine
                .repositories()
                .upsert_message(message)
                .await
                .expect("store delivery instance");
            let snapshot = thread_snapshot(&engine, &default_id)
                .await
                .expect("snapshot with delivery instance");
            let message = snapshot["thread"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["id"] == "message-1")
                .unwrap();
            assert_eq!(
                message["delivery"].get("providerInstanceId"),
                provider_instance_id.map(|value| json!(value)).as_ref()
            );
        }
        for (state, reason) in [
            ("failed", Some("modelSelectionRefused")),
            ("delivered", Some("startedNewConversation")),
            ("delivered", None),
        ] {
            let mut message = engine
                .repositories()
                .get_message("message-1".to_owned())
                .await
                .expect("message lookup")
                .expect("message");
            message.delivery_state = Some(state.to_owned());
            message.delivery_reason = reason.map(str::to_owned);
            engine
                .repositories()
                .upsert_message(message)
                .await
                .expect("store reason");
            let snapshot = thread_snapshot(&engine, &default_id)
                .await
                .expect("snapshot with reason");
            let message = snapshot["thread"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|message| message["id"] == "message-1")
                .unwrap();
            assert_eq!(
                message["delivery"].get("reason"),
                reason.map(|value| json!(value)).as_ref()
            );
        }
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn query_and_stream_boundaries_cover_registered_orchestration_adapters() {
        let engine = migrated_engine().await;
        let mut registry = RpcRegistry::empty();
        register_orchestration_rpc(&mut registry, engine.clone());
        assert!(
            registry
                .validate_complete()
                .expect_err("focused registry is incomplete")
                .contains("server.getConfig")
        );

        let query = |request| handle_query(&engine, None, request, CancellationToken::new());
        assert!(
            query(request("orchestration.unknown", json!({})))
                .await
                .is_err()
        );
        assert!(
            query(request(
                "orchestration.getTurnDiff",
                json!({"threadId":"t1"})
            ))
            .await
            .is_err()
        );
        assert!(
            query(request(
                "orchestration.getTurnDiff",
                json!({"threadId":"t1","fromTurnCount":2,"toTurnCount":1}),
            ))
            .await
            .is_err(),
            "reversed turn bounds must fail"
        );
        assert_eq!(
            query(request(
                "orchestration.getFullThreadDiff",
                json!({"threadId":"t1","toTurnCount":0}),
            ))
            .await
            .unwrap_err(),
            json!({
                "_tag": "OrchestrationGetFullThreadDiffError",
                "message": "The checkpoint for turn 0 is no longer in the repository.",
            }),
            "an unknown thread has no checkpoints, which is not an empty patch"
        );

        let cancellation = CancellationToken::new();
        let mut shell = shell_stream(engine.clone(), cancellation.clone());
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), shell.recv())
                .await
                .unwrap()
                .unwrap()
                .is_ok()
        );
        cancellation.cancel();

        let mut malformed = thread_stream(
            engine.clone(),
            request("orchestration.subscribeThread", json!({})),
            CancellationToken::new(),
        );
        assert!(malformed.recv().await.unwrap().is_err());

        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        assert!(send_snapshot(&sender, Ok(json!({})), None).await.is_err());
        engine.shutdown().await;
    }

    async fn created_project_thread(engine: &OrchestrationEngine) -> String {
        engine
            .dispatch(decode_command(json!({
                "type": "project.create",
                "commandId": "project",
                "projectId": "project",
                "title": "Project",
                "workspaceRoot": "C:/repo",
                "defaultModelSelection": null,
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        load_snapshot(&engine.repositories())
            .await
            .expect("snapshot")
            .threads
            .into_iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id
    }

    async fn rename(engine: &OrchestrationEngine, thread_id: &str, index: usize) {
        engine
            .dispatch(decode_command(json!({
                "type": "thread.meta.update",
                "commandId": format!("rename-{index}"),
                "threadId": thread_id,
                "title": format!("Title {index}"),
            })))
            .await
            .expect("thread renamed");
    }

    async fn next_items(stream: &mut mpsc::Receiver<RpcStreamChunk>) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(5), stream.recv())
            .await
            .expect("a stream chunk")
            .expect("an open stream")
            .expect("a successful chunk")
    }

    /// A client that applies patches gets only what changed: re-sending the whole
    /// thread per update saturated slow links (#89). Older clients keep snapshots.
    #[tokio::test]
    async fn thread_stream_sends_patches_to_clients_that_apply_them() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let cancellation = CancellationToken::new();
        let subscribe = |patches: bool| {
            thread_stream(
                engine.clone(),
                request(
                    "orchestration.subscribeThread",
                    json!({ "threadId": thread_id, "patches": patches }),
                ),
                cancellation.clone(),
            )
        };
        let mut patched = subscribe(true);
        let mut legacy = subscribe(false);
        assert_eq!(next_items(&mut patched).await[0]["kind"], "snapshot");
        assert_eq!(next_items(&mut legacy).await[0]["kind"], "snapshot");

        rename(&engine, &thread_id, 1).await;
        let items = next_items(&mut patched).await;
        assert_eq!(items[0]["kind"], "patch", "{items:?}");
        assert_eq!(items[0]["patch"]["set"]["title"], "Title 1");
        assert!(items[0]["patch"]["set"].get("messages").is_none());
        assert_eq!(next_items(&mut legacy).await[0]["kind"], "snapshot");
        cancellation.cancel();
        engine.shutdown().await;
    }

    fn subscribe_thread(
        engine: &OrchestrationEngine,
        payload: Value,
        keys: &'static ThreadRevisionKeys,
        cancellation: &CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        thread_stream_with_keys(
            engine.clone(),
            request("orchestration.subscribeThread", payload),
            cancellation.clone(),
            keys,
        )
    }

    fn resume(thread_id: &str, item: &Value) -> Value {
        let sequence = item
            .get("snapshotSequence")
            .or_else(|| item["snapshot"].get("snapshotSequence"))
            .cloned()
            .expect("a sequence");
        json!({
            "threadId": thread_id,
            "patches": true,
            "resume": { "revision": item["revision"], "snapshotSequence": sequence },
        })
    }

    /// A resubscribe that names the revision the client holds gets `unchanged` instead of the
    /// whole thread, and later updates patch that same thread.
    #[tokio::test]
    async fn resubscribing_at_the_current_revision_sends_unchanged() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut first = subscribe_thread(
            &engine,
            json!({ "threadId": thread_id, "patches": true }),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut first).await.remove(0);
        assert_eq!(opened["kind"], "snapshot");
        assert!(opened["revision"].is_string(), "{opened}");
        drop(first);

        let mut resumed =
            subscribe_thread(&engine, resume(&thread_id, &opened), keys, &cancellation);
        let unchanged = next_items(&mut resumed).await.remove(0);
        assert_eq!(unchanged["kind"], "unchanged", "{unchanged}");
        assert_eq!(unchanged["revision"], opened["revision"]);
        assert!(unchanged.get("snapshot").is_none());

        rename(&engine, &thread_id, 1).await;
        let patch = next_items(&mut resumed).await.remove(0);
        assert_eq!(patch["kind"], "patch", "{patch}");
        assert_eq!(patch["patch"]["set"]["title"], "Title 1");
        assert!(patch["revision"].is_string());
        assert_ne!(patch["revision"], opened["revision"]);
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// Mixed versions: a client without `resume` (or without patches) keeps today's full
    /// snapshot, and only clients that apply patches see revisions.
    #[tokio::test]
    async fn clients_without_resume_keep_full_snapshots() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut patched = subscribe_thread(
            &engine,
            json!({ "threadId": thread_id, "patches": true }),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut patched).await.remove(0);
        let mut legacy = subscribe_thread(
            &engine,
            json!({ "threadId": thread_id }),
            keys,
            &cancellation,
        );
        let legacy_first = next_items(&mut legacy).await.remove(0);
        assert_eq!(legacy_first["kind"], "snapshot");
        assert!(legacy_first.get("revision").is_none(), "{legacy_first}");

        // A resume from a client that does not apply patches still gets the whole thread.
        let mut payload = resume(&thread_id, &opened);
        payload["patches"] = json!(false);
        let mut unpatched = subscribe_thread(&engine, payload, keys, &cancellation);
        assert_eq!(next_items(&mut unpatched).await[0]["kind"], "snapshot");
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// Fault injection: anything but the server's current revision at or before its current
    /// sequence falls back to a full snapshot, never to `unchanged`.
    #[tokio::test]
    async fn a_stale_unknown_or_newer_revision_gets_a_full_snapshot() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut first = subscribe_thread(
            &engine,
            json!({ "threadId": thread_id, "patches": true }),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut first).await.remove(0);
        drop(first);

        // A gap: the thread changed after the client's last applied item.
        rename(&engine, &thread_id, 1).await;
        let mut stale = subscribe_thread(&engine, resume(&thread_id, &opened), keys, &cancellation);
        let snapshot = next_items(&mut stale).await.remove(0);
        assert_eq!(snapshot["kind"], "snapshot", "{snapshot}");
        assert_eq!(snapshot["snapshot"]["thread"]["title"], "Title 1");

        // A revision this server never produced.
        let mut unknown_payload = resume(&thread_id, &snapshot);
        unknown_payload["resume"]["revision"] = json!("00000000000000000000000000000000");
        let mut unknown = subscribe_thread(&engine, unknown_payload, keys, &cancellation);
        assert_eq!(next_items(&mut unknown).await[0]["kind"], "snapshot");

        // The current revision with a sequence newer than the server's: the server went back.
        let mut newer_payload = resume(&thread_id, &snapshot);
        newer_payload["resume"]["snapshotSequence"] =
            json!(snapshot["snapshot"]["snapshotSequence"].as_i64().unwrap() + 1);
        let mut newer = subscribe_thread(&engine, newer_payload, keys, &cancellation);
        assert_eq!(next_items(&mut newer).await[0]["kind"], "snapshot");
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// Fault injection: a server restart draws new revision keys, so a revision from before it
    /// gets a full snapshot even for an unchanged thread.
    #[tokio::test]
    async fn a_revision_from_before_a_restart_gets_a_full_snapshot() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let cancellation = CancellationToken::new();
        let before: &'static ThreadRevisionKeys = Box::leak(Box::new(ThreadRevisionKeys::new()));
        let after: &'static ThreadRevisionKeys = Box::leak(Box::new(ThreadRevisionKeys::new()));
        let mut first = subscribe_thread(
            &engine,
            json!({ "threadId": thread_id, "patches": true }),
            before,
            &cancellation,
        );
        let opened = next_items(&mut first).await.remove(0);
        drop(first);

        let mut restarted =
            subscribe_thread(&engine, resume(&thread_id, &opened), after, &cancellation);
        let snapshot = next_items(&mut restarted).await.remove(0);
        assert_eq!(snapshot["kind"], "snapshot", "{snapshot}");
        assert_ne!(snapshot["revision"], opened["revision"]);
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// Fault injection: a reconnect storm. Many concurrent resumes all get `unchanged`, each then
    /// patches the same change, and a resume racing changes never gets `unchanged` for a thread
    /// it does not hold.
    #[tokio::test]
    async fn a_reconnect_storm_of_resumes_stays_exact() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut first = subscribe_thread(
            &engine,
            json!({ "threadId": thread_id, "patches": true }),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut first).await.remove(0);
        drop(first);

        let mut storm = (0..32)
            .map(|_| subscribe_thread(&engine, resume(&thread_id, &opened), keys, &cancellation))
            .collect::<Vec<_>>();
        for stream in &mut storm {
            assert_eq!(next_items(stream).await[0]["kind"], "unchanged");
        }
        rename(&engine, &thread_id, 1).await;
        let mut revisions = std::collections::HashSet::new();
        for stream in &mut storm {
            let patch = next_items(stream).await.remove(0);
            assert_eq!(patch["patch"]["set"]["title"], "Title 1");
            revisions.insert(patch["revision"].to_string());
        }
        assert_eq!(
            revisions.len(),
            1,
            "every subscriber reached the same thread"
        );
        drop(storm);

        let mut held = opened;
        for index in 2..8 {
            rename(&engine, &thread_id, index).await;
            let mut stream =
                subscribe_thread(&engine, resume(&thread_id, &held), keys, &cancellation);
            let item = next_items(&mut stream).await.remove(0);
            assert_eq!(
                item["kind"], "snapshot",
                "a stale resume must not be unchanged: {item}"
            );
            assert_eq!(
                item["snapshot"]["thread"]["title"],
                format!("Title {index}")
            );
            held = item;
        }
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// The resume wire contract: a `resume` input, the snapshot and `unchanged` items with their
    /// revisions, and a later patch. Revisions are per process, so they become placeholders.
    /// `threadStreamParity.test.ts` decodes and applies it. Regenerate with
    /// `BIBCODE_UPDATE_THREAD_STREAM_FIXTURE=1`.
    #[tokio::test]
    async fn thread_stream_resume_fixture_matches_the_wire() {
        const AT: &str = "2026-07-10T10:00:00.000Z";
        let engine = migrated_engine().await;
        for command in [
            json!({"type":"project.create","commandId":"c01","projectId":"p1","title":"Project","workspaceRoot":"C:/repo","defaultModelSelection":null,"createdAt":AT}),
            json!({"type":"thread.create","commandId":"c02","threadId":"t1","projectId":"p1","title":"Thread","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","branch":null,"worktreePath":null,"createdAt":AT}),
        ] {
            engine
                .dispatch(decode_command(command))
                .await
                .expect("setup");
        }
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut first = subscribe_thread(
            &engine,
            json!({ "threadId": "t1", "patches": true }),
            keys,
            &cancellation,
        );
        let snapshot = next_items(&mut first).await.remove(0);
        drop(first);
        let input = resume("t1", &snapshot);
        let mut resumed = subscribe_thread(&engine, input.clone(), keys, &cancellation);
        let unchanged = next_items(&mut resumed).await.remove(0);
        engine
            .dispatch(decode_command(json!({"type":"thread.meta.update","commandId":"c03","threadId":"t1","title":"Renamed"})))
            .await
            .expect("rename");
        let patch = next_items(&mut resumed).await.remove(0);
        cancellation.cancel();

        let mut fixture = stable_ids_and_clock_times(
            json!({ "input": input, "items": [snapshot, unchanged, patch] }),
            AT,
        );
        let mut revisions = Vec::<Value>::new();
        let mut placeholder = |revision: &mut Value| {
            let index = revisions
                .iter()
                .position(|seen| seen == revision)
                .unwrap_or_else(|| {
                    revisions.push(revision.clone());
                    revisions.len() - 1
                });
            *revision = json!(format!("revision-{}", index + 1));
        };
        placeholder(&mut fixture["input"]["resume"]["revision"]);
        for item in fixture["items"].as_array_mut().expect("items") {
            placeholder(&mut item["revision"]);
        }
        assert_eq!(revisions.len(), 2, "the patch moves the revision once");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/fixtures/thread-stream/resume.json");
        if std::env::var_os("BIBCODE_UPDATE_THREAD_STREAM_FIXTURE").is_some() {
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&fixture).unwrap() + "\n",
            )
            .unwrap();
        }
        let committed: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("committed fixture"))
                .expect("fixture JSON");
        assert_eq!(
            fixture, committed,
            "regenerate the thread stream resume fixture"
        );
        engine.shutdown().await;
    }

    /// The thread stream's wire contract: a client that applies these patches to
    /// the first snapshot must reach the server's final snapshot. The TypeScript
    /// side decodes and applies this fixture (`threadStreamParity.test.ts`).
    /// Regenerate with `BIBCODE_UPDATE_THREAD_STREAM_FIXTURE=1`.
    #[tokio::test]
    async fn thread_stream_lifecycle_fixture_matches_the_wire() {
        const AT: &str = "2026-07-10T10:00:00.000Z";
        let engine = migrated_engine().await;
        for command in [
            json!({"type":"project.create","commandId":"c01","projectId":"p1","title":"Project","workspaceRoot":"C:/repo","defaultModelSelection":null,"createdAt":AT}),
            json!({"type":"thread.create","commandId":"c02","threadId":"t1","projectId":"p1","title":"Thread","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","branch":null,"worktreePath":null,"createdAt":AT}),
        ] {
            engine
                .dispatch(decode_command(command))
                .await
                .expect("setup");
        }
        let initial = thread_snapshot(&engine, "t1")
            .await
            .expect("initial snapshot");
        let mut held = initial.clone();
        let mut patches = Vec::new();
        let at = |second: u32| format!("2026-07-10T10:01:{second:02}.000Z");
        for command in [
            json!({"type":"thread.meta.update","commandId":"c03","threadId":"t1","title":"Renamed","branch":"main","worktreePath":null}),
            json!({"type":"thread.runtime-mode.set","commandId":"c04","threadId":"t1","runtimeMode":"approval-required","createdAt":at(1)}),
            json!({"type":"thread.interaction-mode.set","commandId":"c05","threadId":"t1","interactionMode":"plan","createdAt":at(2)}),
            json!({"type":"thread.turn.start","commandId":"c06","threadId":"t1","message":{"messageId":"m-user","role":"user","text":"hello","attachments":[]},"createdAt":at(3)}),
            json!({"type":"thread.session.set","commandId":"c07","threadId":"t1","session":{"threadId":"t1","status":"running","providerName":"codex","providerInstanceId":"codex","runtimeMode":"approval-required","activeTurnId":"turn-1","lastError":null,"updatedAt":at(4)},"createdAt":at(4)}),
            json!({"type":"thread.activity.append","commandId":"c08","threadId":"t1","activity":{"id":"a1","tone":"tool","kind":"command","summary":"ran","payload":{"step":1},"turnId":"turn-1","createdAt":at(5)},"createdAt":at(5)}),
            // Reasoning (#173): a streamed thought settled without text, then a summary
            // that arrives whole and replaces nothing.
            json!({"type":"thread.reasoning.delta","commandId":"c08r1","threadId":"t1","reasoningId":"reasoning:t1:item:r1","delta":"Weighing ","turnId":"turn-1","createdAt":at(16)}),
            json!({"type":"thread.reasoning.delta","commandId":"c08r2","threadId":"t1","reasoningId":"reasoning:t1:item:r1","delta":"options","turnId":"turn-1","createdAt":at(17)}),
            json!({"type":"thread.reasoning.complete","commandId":"c08r3","threadId":"t1","reasoningId":"reasoning:t1:item:r1","turnId":"turn-1","createdAt":at(18)}),
            json!({"type":"thread.reasoning.complete","commandId":"c08r4","threadId":"t1","reasoningId":"reasoning:t1:item:r2","text":"**Plan**\n\nRead the file","turnId":"turn-1","createdAt":at(19)}),
            json!({"type":"thread.message.assistant.delta","commandId":"c09","threadId":"t1","messageId":"m-assistant","delta":"hel","turnId":"turn-1","createdAt":at(6)}),
            json!({"type":"thread.message.assistant.delta","commandId":"c10","threadId":"t1","messageId":"m-assistant","delta":"lo","turnId":"turn-1","createdAt":at(7)}),
            json!({"type":"thread.activity.append","commandId":"c11","threadId":"t1","activity":{"id":"a2","tone":"info","kind":"status","summary":"working","payload":{"step":2},"turnId":"turn-1","createdAt":at(8)},"createdAt":at(8)}),
            json!({"type":"thread.message.assistant.complete","commandId":"c12","threadId":"t1","messageId":"m-assistant","turnId":"turn-1","createdAt":at(9)}),
            json!({"type":"thread.proposed-plan.upsert","commandId":"c13","threadId":"t1","proposedPlan":{"id":"plan-1","turnId":"turn-1","planMarkdown":"Do it","createdAt":at(10),"updatedAt":at(10)},"createdAt":at(10)}),
            json!({"type":"thread.turn.diff.complete","commandId":"c14","threadId":"t1","turnId":"turn-1","completedAt":at(11),"checkpointRef":"ref-1","status":"ready","files":[{"path":"a.rs","kind":"modified","additions":2,"deletions":1}],"assistantMessageId":"m-assistant","checkpointTurnCount":1,"createdAt":at(11)}),
            json!({"type":"thread.turn.start","commandId":"c15","threadId":"t1","message":{"messageId":"m-queued","role":"user","text":"next","attachments":[]},"runtimeMode":"approval-required","interactionMode":"plan","queued":true,"createdAt":at(12)}),
            json!({"type":"thread.turn.steer","commandId":"c16","threadId":"t1","messageId":"m-queued","createdAt":at(13)}),
            json!({"type":"thread.session.set","commandId":"c17","threadId":"t1","session":{"threadId":"t1","status":"ready","providerName":"codex","providerInstanceId":"codex","runtimeMode":"approval-required","activeTurnId":null,"lastError":null,"updatedAt":at(14)},"createdAt":at(14)}),
            json!({"type":"thread.archive","commandId":"c18","threadId":"t1"}),
            json!({"type":"thread.unarchive","commandId":"c19","threadId":"t1"}),
            json!({"type":"thread.session.stop","commandId":"c20","threadId":"t1","createdAt":at(15)}),
        ] {
            // A command the thread's state refuses still exercises the stream.
            let _ = engine.dispatch(decode_command(command)).await;
            let next = thread_snapshot(&engine, "t1").await.expect("snapshot");
            if let Some(patch) = thread_patch(
                &HeldThread::of(&held, std::hash::RandomState::new()).expect("a thread"),
                &next,
            ) {
                patches.push(patch);
            }
            held = next;
        }
        let fixture = stable_ids_and_clock_times(
            json!({ "initial": initial, "patches": patches, "final": held }),
            AT,
        );
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/fixtures/thread-stream/lifecycle.json");
        if std::env::var_os("BIBCODE_UPDATE_THREAD_STREAM_FIXTURE").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&fixture).unwrap() + "\n",
            )
            .unwrap();
        }
        let committed: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("committed fixture"))
                .expect("fixture JSON");
        assert_eq!(fixture, committed, "regenerate the thread stream fixture");
        engine.shutdown().await;
    }

    /// Event ids and times the engine takes from the clock (rather than from a
    /// command) differ per run; they become stable placeholders in first-seen order,
    /// so references between them and their order survive.
    fn stable_ids_and_clock_times(fixture: Value, day_of_commands: &str) -> Value {
        fn collect(value: &Value, day: &str, seen: &mut Vec<String>) {
            match value {
                Value::String(text) => {
                    let event_id = uuid::Uuid::parse_str(text).is_ok();
                    // An ISO-8601 instant such as 2026-10-13T12:00:00.000Z.
                    let bytes = text.as_bytes();
                    let clock_time = bytes.len() >= 20
                        && bytes[4] == b'-'
                        && bytes[10] == b'T'
                        && text.ends_with('Z')
                        && bytes[..4].iter().all(u8::is_ascii_digit)
                        && !text.starts_with(&day[..10]);
                    if (event_id || clock_time) && !seen.contains(text) {
                        seen.push(text.clone());
                    }
                }
                Value::Array(items) => items.iter().for_each(|item| collect(item, day, seen)),
                Value::Object(map) => map.values().for_each(|item| collect(item, day, seen)),
                _ => {}
            }
        }
        fn replace(value: Value, stable: &HashMap<String, String>) -> Value {
            match value {
                Value::String(text) => Value::String(stable.get(&text).cloned().unwrap_or(text)),
                Value::Array(items) => Value::Array(
                    items
                        .into_iter()
                        .map(|item| replace(item, stable))
                        .collect(),
                ),
                Value::Object(map) => Value::Object(
                    map.into_iter()
                        .map(|(key, item)| (key, replace(item, stable)))
                        .collect(),
                ),
                other => other,
            }
        }
        let mut seen = Vec::new();
        collect(&fixture, day_of_commands, &mut seen);
        let stable = seen
            .into_iter()
            .enumerate()
            .map(|(index, original)| {
                let placeholder = if uuid::Uuid::parse_str(&original).is_ok() {
                    format!("event-{index:02}")
                } else {
                    format!("2026-07-11T00:00:{index:02}.000Z")
                };
                (original, placeholder)
            })
            .collect::<HashMap<_, _>>();
        replace(fixture, &stable)
    }

    /// A burst of events yields one shell update, not one per event.
    #[tokio::test]
    async fn shell_stream_coalesces_event_bursts() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let cancellation = CancellationToken::new();
        let mut stream = shell_stream(engine.clone(), cancellation.clone());
        assert_eq!(next_items(&mut stream).await[0]["kind"], "snapshot");

        for index in 0..10 {
            rename(&engine, &thread_id, index).await;
        }
        let latest = next_items(&mut stream).await;
        assert_eq!(latest[0]["kind"], "thread-upserted");
        tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 3).await;
        let mut updates = 1;
        while let Ok(Some(_)) = stream.try_recv().map(Some) {
            updates += 1;
        }
        assert!(updates <= 2, "{updates} shell updates for one burst");
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// Creates a live thread in the `project` of `created_project_thread`.
    async fn create_thread(engine: &OrchestrationEngine, thread_id: &str) {
        engine
            .dispatch(decode_command(json!({
                "type": "thread.create",
                "commandId": format!("create-{thread_id}"),
                "threadId": thread_id,
                "projectId": "project",
                "title": thread_id,
                "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
                "runtimeMode": "full-access",
                "branch": null,
                "worktreePath": null,
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("thread created");
    }

    /// Waits past one coalesce window, then asserts the stream sent nothing.
    async fn assert_shell_quiet(stream: &mut mpsc::Receiver<RpcStreamChunk>) {
        tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 3).await;
        let sent = stream.try_recv().ok();
        assert!(sent.is_none(), "unexpected shell items: {sent:?}");
    }

    /// The shell a client holds after applying `items` to `shell`, as `applyShellStreamEvent`
    /// does: a snapshot replaces it; an event applies only above the held sequence.
    fn apply_shell_items(mut shell: Value, items: &[Value]) -> Value {
        for item in items {
            let kind = item["kind"].as_str().expect("item kind");
            if kind == "snapshot" {
                shell = item["snapshot"].clone();
                continue;
            }
            let sequence = item["sequence"].as_i64().expect("item sequence");
            if sequence <= shell["snapshotSequence"].as_i64().expect("held sequence") {
                continue;
            }
            let (list, id, entry) = match kind {
                "project-upserted" => ("projects", &item["project"]["id"], Some(&item["project"])),
                "thread-upserted" => ("threads", &item["thread"]["id"], Some(&item["thread"])),
                "project-removed" => ("projects", &item["projectId"], None),
                "thread-removed" => ("threads", &item["threadId"], None),
                other => panic!("unknown shell item {other}"),
            };
            let entries = shell[list].as_array_mut().expect("shell list");
            let position = entries.iter().position(|held| held["id"] == *id);
            match (position, entry) {
                (Some(position), Some(entry)) => entries[position] = entry.clone(),
                (None, Some(entry)) => entries.push(entry.clone()),
                (Some(position), None) => {
                    entries.remove(position);
                }
                (None, None) => {}
            }
            shell["snapshotSequence"] = json!(sequence);
        }
        shell
    }

    /// A shell without the fields that change with the clock, its lists sorted by id.
    fn comparable_shell(mut shell: Value) -> Value {
        shell.as_object_mut().expect("shell").remove("updatedAt");
        for list in ["projects", "threads"] {
            let entries = shell[list].as_array_mut().expect("shell list");
            entries.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
            for entry in entries {
                entry
                    .as_object_mut()
                    .expect("entry")
                    .remove("lastActivityAgeMs");
            }
        }
        shell
    }

    /// After the first snapshot, renaming one thread sends that thread alone (#223): the
    /// whole list per update re-sent every thread while only one changed.
    #[tokio::test]
    async fn shell_stream_sends_one_upsert_for_a_renamed_thread() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        create_thread(&engine, "other").await;
        let cancellation = CancellationToken::new();
        let mut stream = shell_stream(engine.clone(), cancellation.clone());
        let first = next_items(&mut stream).await;
        assert_eq!(first[0]["kind"], "snapshot");
        let held = first[0]["snapshot"]["snapshotSequence"].as_i64().unwrap();

        rename(&engine, &thread_id, 1).await;
        let items = next_items(&mut stream).await;
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0]["kind"], "thread-upserted");
        assert_eq!(items[0]["thread"]["id"], json!(thread_id));
        assert_eq!(items[0]["thread"]["title"], "Title 1");
        assert!(items[0]["sequence"].as_i64().unwrap() > held);
        assert_shell_quiet(&mut stream).await;
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// Archiving or deleting a thread takes it out of the live shell with `thread-removed`.
    #[tokio::test]
    async fn shell_stream_removes_archived_and_deleted_threads() {
        let engine = migrated_engine().await;
        created_project_thread(&engine).await;
        create_thread(&engine, "archived").await;
        create_thread(&engine, "deleted").await;
        let cancellation = CancellationToken::new();
        let mut stream = shell_stream(engine.clone(), cancellation.clone());
        assert_eq!(next_items(&mut stream).await[0]["kind"], "snapshot");

        for (command, thread_id) in [("thread.archive", "archived"), ("thread.delete", "deleted")] {
            engine
                .dispatch(decode_command(json!({
                    "type": command,
                    "commandId": format!("{command}-{thread_id}"),
                    "threadId": thread_id,
                })))
                .await
                .expect("thread leaves the live shell");
            let items = next_items(&mut stream).await;
            assert_eq!(
                items,
                [json!({
                    "kind": "thread-removed",
                    "sequence": items[0]["sequence"],
                    "threadId": thread_id,
                })]
            );
        }
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// An event that changes nothing the live shell shows sends nothing: here a rename of an
    /// archived thread, which only the archived shell lists.
    #[tokio::test]
    async fn shell_stream_sends_nothing_for_an_event_outside_the_shell() {
        let engine = migrated_engine().await;
        created_project_thread(&engine).await;
        create_thread(&engine, "archived").await;
        engine
            .dispatch(decode_command(
                json!({"type":"thread.archive","commandId":"archive","threadId":"archived"}),
            ))
            .await
            .expect("thread archived");
        let cancellation = CancellationToken::new();
        let mut stream = shell_stream(engine.clone(), cancellation.clone());
        assert_eq!(next_items(&mut stream).await[0]["kind"], "snapshot");

        rename(&engine, "archived", 1).await;
        assert_shell_quiet(&mut stream).await;
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// Thread shells that differ only by `lastActivityAgeMs`, which grows with the clock,
    /// are unchanged: the client ages that value from its own receipt.
    #[test]
    fn shell_entry_fingerprints_ignore_the_activity_age() {
        let keys = std::hash::RandomState::new();
        let shell =
            json!({ "id": "thread", "lastActivityAt": CREATED_AT, "lastActivityAgeMs": 10 });
        let older =
            json!({ "id": "thread", "lastActivityAt": CREATED_AT, "lastActivityAgeMs": 900 });
        let moved = json!({ "id": "thread", "lastActivityAt": "2026-07-12T00:00:00.000Z", "lastActivityAgeMs": 10 });
        assert_eq!(
            shell_entry_fingerprint(&keys, &shell),
            shell_entry_fingerprint(&keys, &older)
        );
        assert_ne!(
            shell_entry_fingerprint(&keys, &shell),
            shell_entry_fingerprint(&keys, &moved)
        );
    }

    /// A receiver that lagged lost events; the stream answers with a whole snapshot instead
    /// of trusting a comparison.
    #[tokio::test]
    async fn shell_stream_answers_a_lagged_receiver_with_a_snapshot() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let mut tap = engine.subscribe_events();
        let (events, receiver) = broadcast::channel(1);
        let cancellation = CancellationToken::new();
        let mut stream = shell_stream_with_events(engine.clone(), receiver, cancellation.clone());
        assert_eq!(next_items(&mut stream).await[0]["kind"], "snapshot");

        rename(&engine, &thread_id, 1).await;
        let event = tap.recv().await.expect("rename event");
        // Two sends into a channel of one: the stream's receiver lags by one.
        events.send(event.clone()).expect("send");
        events.send(event).expect("send");
        let items = next_items(&mut stream).await;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "snapshot");
        assert_eq!(
            items[0]["snapshot"]["threads"][0]["title"], "Title 1",
            "{items:?}"
        );
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// A failed re-read keeps the stream open: the client would not resubscribe until its
    /// session changed. The stream retries on its own and resyncs with a whole snapshot.
    #[tokio::test]
    async fn shell_stream_recovers_from_a_failed_re_read_with_a_snapshot() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        let cancellation = CancellationToken::new();
        let mut stream = shell_stream(engine.clone(), cancellation.clone());
        assert_eq!(next_items(&mut stream).await[0]["kind"], "snapshot");
        let rename_table = |from: &'static str, to: &'static str| {
            let database = engine.repositories().database().clone();
            async move {
                database
                    .call(move |connection| {
                        connection.execute_batch(&format!("ALTER TABLE {from} RENAME TO {to}"))?;
                        Ok(())
                    })
                    .await
                    .expect("rename table");
            }
        };

        rename(&engine, &thread_id, 1).await;
        // The shell read now fails until the table comes back.
        rename_table("projection_projects", "projection_projects_hidden").await;
        tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 2).await;
        assert!(
            matches!(stream.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
            "a failed read neither sends nor ends the stream"
        );
        rename_table("projection_projects_hidden", "projection_projects").await;
        let items = tokio::time::timeout(SHELL_READ_RETRY * 3, stream.recv())
            .await
            .expect("a retry")
            .expect("an open stream")
            .expect("a successful chunk");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "snapshot");
        assert_eq!(items[0]["snapshot"]["threads"][0]["title"], "Title 1");
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// Items carry strictly increasing sequences above the snapshot's, so the client's reducer
    /// applies each one and drops a duplicate, and applying them rebuilds exactly the shell a
    /// new subscriber would get.
    #[tokio::test]
    async fn shell_stream_item_sequences_increase_and_rebuild_the_shell() {
        let engine = migrated_engine().await;
        let thread_id = created_project_thread(&engine).await;
        create_thread(&engine, "second").await;
        create_thread(&engine, "removed").await;
        let cancellation = CancellationToken::new();
        let mut stream = shell_stream(engine.clone(), cancellation.clone());
        let first = next_items(&mut stream).await;
        let mut held = first[0]["snapshot"].clone();
        let mut last = held["snapshotSequence"].as_i64().unwrap();

        // One burst: two renames, a new thread and a deletion.
        rename(&engine, &thread_id, 1).await;
        rename(&engine, "second", 2).await;
        create_thread(&engine, "added").await;
        engine
            .dispatch(decode_command(
                json!({"type":"thread.delete","commandId":"delete","threadId":"removed"}),
            ))
            .await
            .expect("thread deleted");
        tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 3).await;
        let mut items = Vec::new();
        while let Ok(chunk) = stream.try_recv() {
            items.extend(chunk.expect("a successful chunk"));
        }
        assert!(items.len() >= 4, "{items:?}");
        assert!(
            items.iter().all(|item| item["kind"] != "snapshot"),
            "{items:?}"
        );
        for item in &items {
            let sequence = item["sequence"].as_i64().unwrap();
            assert!(sequence > last, "{items:?}");
            last = sequence;
        }
        held = apply_shell_items(held, &items);
        // Delivered twice, as after a duplicate: the second copy changes nothing.
        assert_eq!(apply_shell_items(held.clone(), &items), held);
        let fresh = shell_snapshot(&engine, false).await.unwrap();
        assert_eq!(held["snapshotSequence"], fresh["snapshotSequence"]);
        assert_eq!(comparable_shell(held), comparable_shell(fresh));
        cancellation.cancel();
        engine.shutdown().await;
    }

    // --- #223 addendum: the capped shell, older threads, getThreadShells and shell resume.

    /// A timestamp `index` seconds into the fixture day, so a higher index is newer.
    fn cap_at(index: usize) -> String {
        format!(
            "2026-07-11T{:02}:{:02}:{:02}.000Z",
            index / 3_600,
            (index / 60) % 60,
            index % 60
        )
    }

    async fn seed_cap_project(repositories: &Repositories, project_id: &str) {
        let mut project = http_read_model_fixture().projects.remove(0);
        project.project_id = project_id.to_owned();
        project.workspace_root = format!("/cap/{project_id}");
        repositories.upsert_project(project).await.unwrap();
    }

    /// A finished thread of `kind` whose newest-first key is `cap_at(index)`.
    async fn seed_cap_thread(
        repositories: &Repositories,
        thread_id: &str,
        project_id: &str,
        kind: &str,
        worktree_path: Option<&str>,
        index: usize,
    ) -> ProjectionThread {
        let mut thread = store_thread(thread_id, project_id, None);
        thread.kind = kind.to_owned();
        thread.worktree_path = worktree_path.map(str::to_owned);
        thread.latest_user_message_at = Some(cap_at(index));
        thread.updated_at = cap_at(index);
        repositories.upsert_thread(thread.clone()).await.unwrap();
        thread
    }

    async fn seed_cap_session(repositories: &Repositories, thread_id: &str, status: &str) {
        repositories
            .upsert_thread_session(crate::persistence::ProjectionThreadSession {
                thread_id: thread_id.to_owned(),
                status: status.to_owned(),
                provider_name: Some("codex".to_owned()),
                provider_instance_id: Some("codex".to_owned()),
                runtime_mode: "full-access".to_owned(),
                active_turn_id: None,
                last_error: None,
                last_error_class: None,
                updated_at: CREATED_AT.to_owned(),
            })
            .await
            .unwrap();
    }

    fn ids(threads: &[ProjectionThread]) -> HashSet<String> {
        threads
            .iter()
            .map(|thread| thread.thread_id.clone())
            .collect()
    }

    /// With 150 finished threads in five projects the capped rows hold the newest 25, the
    /// newest 3 of each project, and every live, card-backing and named thread; the rest are
    /// counted per project.
    #[tokio::test]
    async fn shell_rows_keep_live_card_included_and_recent_threads_of_150() {
        let repositories = seeded_cap_repositories().await;
        let mut expected = HashSet::new();
        let mut finished = Vec::new();
        for project in 0..5 {
            let project_id = format!("p{project}");
            seed_cap_project(&repositories, &project_id).await;
            seed_cap_thread(
                &repositories,
                &format!("default-{project}"),
                &project_id,
                "default",
                None,
                0,
            )
            .await;
            expected.insert(format!("default-{project}"));
        }
        for index in 0..150 {
            let project_id = format!("p{}", index % 5);
            // p4 gets only the oldest threads, so only its own newest 3 keep it visible.
            let index_key = if index % 5 == 4 {
                index / 50
            } else {
                200 + index
            };
            let id = format!("t{index:03}");
            finished.push((index_key, id.clone(), project_id.clone()));
            seed_cap_thread(
                &repositories,
                &id,
                &project_id,
                "workspace",
                None,
                index_key,
            )
            .await;
        }
        seed_cap_thread(
            &repositories,
            "worktree",
            "p0",
            "workspace",
            Some("/cap/p0/wt"),
            1,
        )
        .await;
        seed_cap_thread(&repositories, "live", "p0", "workspace", None, 1).await;
        seed_cap_session(&repositories, "live", "running").await;
        seed_cap_thread(&repositories, "named", "p1", "workspace", None, 1).await;
        expected.extend(["worktree", "live", "named"].map(str::to_owned));
        finished.sort_by(|left, right| (right.0, &right.1).cmp(&(left.0, &left.1)));
        let mut per_project = HashMap::<String, usize>::new();
        for (position, (_, id, project_id)) in finished.iter().enumerate() {
            let seen = per_project.entry(project_id.clone()).or_default();
            *seen += 1;
            if position < 25 || *seen <= 3 {
                expected.insert(id.clone());
            }
        }

        let (rows, older) = repositories
            .load_capped_shell_snapshot_rows(HashSet::from(["named".to_owned()]))
            .await
            .unwrap();

        assert_eq!(ids(&rows.threads), expected);
        let mut left_out = HashMap::<String, usize>::new();
        for (_, id, project_id) in &finished {
            if !expected.contains(id) {
                *left_out.entry(project_id.clone()).or_default() += 1;
            }
        }
        let counted = older
            .iter()
            .map(|count| {
                assert_eq!(count.chats_in, None);
                (count.project_id.clone(), count.count)
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(counted, left_out);
        assert!(
            rows.threads
                .iter()
                .all(|thread| thread.thread_id != "t004" || expected.contains("t004"))
        );
    }

    async fn seeded_cap_repositories() -> Repositories {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        Repositories::new(database)
    }

    /// Chat panels are counted by checkout, as the left panel groups them: pathless panels of
    /// two hosts share the main checkout's entry, and a worktree's panels have their own.
    #[tokio::test]
    async fn shell_rows_count_main_checkout_chats_of_every_host() {
        let repositories = seeded_cap_repositories().await;
        seed_cap_project(&repositories, "p").await;
        for index in 0..30 {
            seed_cap_thread(
                &repositories,
                &format!("recent-{index:02}"),
                "p",
                "workspace",
                None,
                100 + index,
            )
            .await;
        }
        for (id, worktree) in [
            ("panel-a", None),
            ("panel-b", None),
            ("panel-c", Some("/cap/p/wt")),
        ] {
            let mut panel = seed_cap_thread(&repositories, id, "p", "panel", worktree, 1).await;
            panel.host_thread_id = Some(
                if id == "panel-b" {
                    "recent-01"
                } else {
                    "recent-00"
                }
                .to_owned(),
            );
            repositories.upsert_thread(panel).await.unwrap();
        }

        let (_, older) = repositories
            .load_capped_shell_snapshot_rows(HashSet::new())
            .await
            .unwrap();

        let chats = older
            .iter()
            .filter(|count| count.chats_in.is_some())
            .map(|count| (count.chats_in.clone().unwrap(), count.count))
            .collect::<Vec<_>>();
        assert_eq!(chats, [(None, 2), (Some("/cap/p/wt".to_owned()), 1)]);
    }

    /// The per-thread reads cover kept threads only.
    #[tokio::test]
    async fn shell_rows_read_no_sessions_or_messages_for_left_out_threads() {
        let repositories = seeded_cap_repositories().await;
        seed_cap_project(&repositories, "p").await;
        for index in 0..40 {
            let id = format!("t{index:02}");
            seed_cap_thread(&repositories, &id, "p", "workspace", None, index).await;
            seed_cap_session(&repositories, &id, "ready").await;
            repositories
                .upsert_message(store_message(
                    &format!("{id}-m"),
                    &id,
                    "user",
                    "hi",
                    &cap_at(index),
                ))
                .await
                .unwrap();
        }

        let (rows, _) = repositories
            .load_capped_shell_snapshot_rows(HashSet::new())
            .await
            .unwrap();

        let kept = ids(&rows.threads);
        assert_eq!(kept.len(), 25);
        assert!(
            rows.sessions
                .iter()
                .all(|session| kept.contains(&session.thread_id))
        );
        assert!(
            rows.preview_messages
                .iter()
                .all(|message| kept.contains(&message.thread_id))
        );
        assert_eq!(rows.sessions.len(), 25);
    }

    /// "Newest" is the last user message, else the last update, then the id.
    #[tokio::test]
    async fn shell_rows_order_recent_finished_by_last_user_message_then_update() {
        let repositories = seeded_cap_repositories().await;
        seed_cap_project(&repositories, "p").await;
        for index in 0..30 {
            seed_cap_thread(
                &repositories,
                &format!("t{index:02}"),
                "p",
                "panel",
                None,
                100 + index,
            )
            .await;
        }
        // No user message, but updated after every other thread: newest of all.
        let mut silent = seed_cap_thread(&repositories, "silent", "p", "panel", None, 0).await;
        silent.latest_user_message_at = None;
        silent.updated_at = cap_at(500);
        repositories.upsert_thread(silent).await.unwrap();
        // Ties at the cut: the larger id wins.
        for id in ["tie-a", "tie-b"] {
            seed_cap_thread(&repositories, id, "p", "panel", None, 105).await;
        }

        let (rows, _) = repositories
            .load_capped_shell_snapshot_rows(HashSet::new())
            .await
            .unwrap();

        let kept = ids(&rows.threads);
        assert!(kept.contains("silent"));
        // Panels get no per-project slots: exactly the newest 25.
        assert_eq!(kept.len(), 25);
        // 1 silent + t29..t06 (24 threads, keys 129..106) fill the cap before any key-105 tie.
        assert!(!kept.contains("tie-a") && !kept.contains("tie-b") && !kept.contains("t05"));
        assert!(kept.contains("t06"));
    }

    /// Creates a thread whose newest-first key is `cap_at(index)`.
    async fn create_keyed_thread(engine: &OrchestrationEngine, thread_id: &str, index: usize) {
        create_thread(engine, thread_id).await;
        let repositories = engine.repositories();
        let mut thread = repositories
            .load_thread_shell_rows(vec![thread_id.to_owned()])
            .await
            .unwrap()
            .threads
            .remove(0);
        thread.latest_user_message_at = Some(cap_at(index));
        repositories.upsert_thread(thread).await.unwrap();
    }

    /// The engine of `created_project_thread` with `count` more threads, created in order so
    /// that each is newer than the one before.
    async fn capped_engine(count: usize) -> (OrchestrationEngine, Vec<String>) {
        let engine = migrated_engine().await;
        created_project_thread(&engine).await;
        let mut created = Vec::new();
        for index in 0..count {
            let id = format!("t{index:03}");
            create_keyed_thread(&engine, &id, index + 1).await;
            created.push(id);
        }
        (engine, created)
    }

    fn capped_request(payload: Value) -> RpcRequest {
        request("orchestration.subscribeShell", payload)
    }

    fn thread_ids_of(snapshot: &Value) -> HashSet<String> {
        snapshot["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|thread| thread["id"].as_str().unwrap().to_owned())
            .collect()
    }

    /// An old client's `{}` gets every thread, with no cap marker and no revision.
    #[tokio::test]
    async fn shell_stream_without_cap_sends_every_thread() {
        let (engine, created) = capped_engine(30).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({})),
            CancellationToken::new(),
        );
        let item = next_items(&mut stream).await.remove(0);
        assert_eq!(item["kind"], "snapshot");
        assert!(item.get("revision").is_none());
        assert!(item["snapshot"].get("capped").is_none());
        assert_eq!(thread_ids_of(&item["snapshot"]).len(), created.len() + 1);
        assert!(
            item["snapshot"]["projects"][0]
                .get("olderThreads")
                .is_none()
        );
        engine.shutdown().await;
    }

    /// A client that asks for the cap gets the kept set, `capped`, a revision and the count.
    #[tokio::test]
    async fn shell_stream_cap_sends_kept_set_counts_and_capped() {
        let (engine, created) = capped_engine(30).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": { "include": ["t000"] } })),
            CancellationToken::new(),
        );
        let item = next_items(&mut stream).await.remove(0);
        assert_eq!(item["kind"], "snapshot");
        assert!(
            item["revision"]
                .as_str()
                .is_some_and(|revision| revision.len() == 32)
        );
        assert_eq!(item["snapshot"]["capped"], true);
        let kept = thread_ids_of(&item["snapshot"]);
        // The default thread, the newest 25 (t029..t005), and the named t000.
        assert_eq!(kept.len(), 27, "{kept:?}");
        assert!(kept.contains("t000") && kept.contains("t005") && !kept.contains("t004"));
        assert_eq!(
            item["snapshot"]["projects"][0]["olderThreads"],
            json!({ "count": 4, "chats": [] })
        );
        assert_eq!(created.len(), 30);
        engine.shutdown().await;
    }

    fn terminal_summary(thread_id: &str, state: &str) -> TerminalSummary {
        serde_json::from_value(json!({
            "threadId": thread_id,
            "terminalId": "agent",
            "cwd": "C:/repo",
            "worktreePath": null,
            "status": "running",
            "pid": null,
            "exitCode": null,
            "exitSignal": null,
            "hasRunningSubprocess": true,
            "label": "Claude",
            "updatedAt": CREATED_AT,
            "agentStatus": { "state": state, "failed": false },
        }))
        .expect("terminal summary")
    }

    /// An old pathless workspace with no session but a working AI Terminal is kept, and one
    /// whose terminal starts working is sent when it does.
    #[tokio::test]
    async fn shell_stream_keeps_a_live_terminal_host() {
        let (engine, _) = capped_engine(30).await;
        let (updates, receiver) = broadcast::channel(8);
        let attachment = crate::terminal::TerminalMetadataAttachment::for_test(
            vec![terminal_summary("t000", "working")],
            receiver,
        );
        let mut stream = shell_stream_with(
            engine.clone(),
            Some(ShellTerminals::Attached(attachment)),
            SubscribeShellInput {
                cap: Some(ShellCapInput::default()),
                resume: None,
            },
            engine.subscribe_events(),
            CancellationToken::new(),
            default_thread_revision_keys(),
        );
        let first = next_items(&mut stream).await.remove(0);
        let kept = thread_ids_of(&first["snapshot"]);
        assert!(kept.contains("t000") && !kept.contains("t001"));

        updates
            .send(TerminalMetadataEvent::Upsert {
                terminal: Box::new(terminal_summary("t001", "waiting")),
            })
            .unwrap();
        let items = next_items(&mut stream).await;
        assert!(
            items
                .iter()
                .any(|item| item["kind"] == "thread-upserted" && item["thread"]["id"] == "t001"),
            "{items:?}"
        );
        engine.shutdown().await;
    }

    /// A left-out thread that starts a turn is sent as an upsert.
    #[tokio::test]
    async fn shell_stream_upserts_a_left_out_thread_that_starts_a_turn() {
        let (engine, _) = capped_engine(30).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        assert!(!thread_ids_of(&next_items(&mut stream).await[0]["snapshot"]).contains("t000"));
        seed_cap_session(&engine.repositories(), "t000", "running").await;
        // Any engine event triggers the re-read, as the provider runtime's would.
        rename(&engine, "t010", 1).await;
        let items = next_items(&mut stream).await;
        assert!(
            items
                .iter()
                .any(|item| item["kind"] == "thread-upserted" && item["thread"]["id"] == "t000"),
            "{items:?}"
        );
        engine.shutdown().await;
    }

    /// A thread that newer ones push out of the newest 25 stays: the client can't tell leaving
    /// the cap from a deletion.
    #[tokio::test]
    async fn shell_stream_keeps_a_thread_pushed_out_of_the_cap() {
        let (engine, _) = capped_engine(25).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        assert!(thread_ids_of(&next_items(&mut stream).await[0]["snapshot"]).contains("t000"));
        for index in 0..3 {
            create_keyed_thread(&engine, &format!("new-{index}"), 1_000 + index).await;
        }
        tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 3).await;
        let mut items = Vec::new();
        while let Ok(chunk) = stream.try_recv() {
            items.extend(chunk.unwrap());
        }
        assert!(
            items.iter().all(|item| item["kind"] != "thread-removed"),
            "{items:?}"
        );
        assert_eq!(
            items
                .iter()
                .filter(|item| item["kind"] == "thread-upserted")
                .count(),
            3,
            "{items:?}"
        );
        engine.shutdown().await;
    }

    /// Archiving or deleting a thread the client was never sent still names it, so a page
    /// copy can't outlive it.
    #[tokio::test]
    async fn shell_stream_sends_removal_for_a_left_out_thread_deleted_or_archived() {
        let (engine, _) = capped_engine(30).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        let kept = thread_ids_of(&next_items(&mut stream).await[0]["snapshot"]);
        assert!(!kept.contains("t000") && !kept.contains("t001"));
        for (command, thread_id) in [("thread.archive", "t000"), ("thread.delete", "t001")] {
            engine
                .dispatch(decode_command(json!({
                    "type": command,
                    "commandId": format!("{command}-{thread_id}"),
                    "threadId": thread_id,
                })))
                .await
                .unwrap();
            let items = next_items(&mut stream).await;
            assert!(
                items
                    .iter()
                    .any(|item| item["kind"] == "thread-removed" && item["threadId"] == thread_id),
                "{items:?}"
            );
        }
        engine.shutdown().await;
    }

    /// An archive undone in the same window sends no removal: removals come from final state.
    #[tokio::test]
    async fn shell_stream_sends_no_removal_for_archive_then_unarchive_in_one_window() {
        let (engine, _) = capped_engine(30).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        next_items(&mut stream).await;
        for command in ["thread.archive", "thread.unarchive"] {
            engine
                .dispatch(decode_command(json!({
                    "type": command,
                    "commandId": format!("{command}-t000"),
                    "threadId": "t000",
                })))
                .await
                .unwrap();
        }
        tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 3).await;
        let mut items = Vec::new();
        while let Ok(chunk) = stream.try_recv() {
            items.extend(chunk.unwrap());
        }
        assert!(
            items.iter().all(|item| item["kind"] != "thread-removed"),
            "{items:?}"
        );
        engine.shutdown().await;
    }

    /// A fallback snapshot after `Lagged` keeps every thread the client holds, even one the
    /// cap would now leave out.
    #[tokio::test]
    async fn shell_stream_fallback_snapshot_keeps_held_threads() {
        let (engine, _) = capped_engine(25).await;
        let mut tap = engine.subscribe_events();
        let (events, receiver) = broadcast::channel(1);
        let mut stream = shell_stream_with(
            engine.clone(),
            None,
            SubscribeShellInput {
                cap: Some(ShellCapInput::default()),
                resume: None,
            },
            receiver,
            CancellationToken::new(),
            default_thread_revision_keys(),
        );
        let held = thread_ids_of(&next_items(&mut stream).await[0]["snapshot"]);
        assert!(held.contains("t000"));
        create_keyed_thread(&engine, "new-0", 1_000).await;
        let event = tap.recv().await.unwrap();
        events.send(event.clone()).unwrap();
        events.send(event).unwrap();
        let item = next_items(&mut stream).await.remove(0);
        assert_eq!(item["kind"], "snapshot");
        let after = thread_ids_of(&item["snapshot"]);
        assert!(held.is_subset(&after), "{held:?} {after:?}");
        engine.shutdown().await;
    }

    /// A re-read keeps the cap: the threads the stream holds keep their places among the
    /// newest, so they never hand their slots to older threads.
    #[tokio::test]
    async fn shell_stream_re_read_sends_only_what_changed_under_the_cap() {
        let (engine, _) = capped_engine(30).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        next_items(&mut stream).await;
        rename(&engine, "t010", 1).await;
        let items = next_items(&mut stream).await;
        let kinds = items
            .iter()
            .map(|item| {
                format!(
                    "{} {}",
                    item["kind"].as_str().unwrap(),
                    item["thread"]["id"].as_str().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(kinds, ["thread-upserted t010"], "{items:?}");
        engine.shutdown().await;
    }

    /// A failed re-read keeps the ids the client holds: the snapshot that recovers it still has
    /// a thread newer ones pushed out of the cap.
    #[tokio::test]
    async fn shell_stream_recovery_snapshot_after_a_failed_read_keeps_held_threads() {
        let (engine, _) = capped_engine(25).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        assert!(thread_ids_of(&next_items(&mut stream).await[0]["snapshot"]).contains("t000"));
        for index in 0..3 {
            create_keyed_thread(&engine, &format!("new-{index}"), 1_000 + index).await;
        }
        tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 3).await;
        while stream.try_recv().is_ok() {}
        let database = engine.repositories().database().clone();
        let rename_table = |from: &'static str, to: &'static str| {
            let database = database.clone();
            async move {
                database
                    .call(move |connection| {
                        connection.execute_batch(&format!("ALTER TABLE {from} RENAME TO {to}"))?;
                        Ok(())
                    })
                    .await
                    .expect("rename table");
            }
        };
        rename(&engine, "t010", 1).await;
        rename_table("projection_projects", "projection_projects_hidden").await;
        tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 2).await;
        rename_table("projection_projects_hidden", "projection_projects").await;
        let items = tokio::time::timeout(SHELL_READ_RETRY * 3, stream.recv())
            .await
            .expect("a retry")
            .expect("an open stream")
            .expect("a successful chunk");
        assert_eq!(items[0]["kind"], "snapshot");
        assert!(
            thread_ids_of(&items[0]["snapshot"]).contains("t000"),
            "{:?}",
            thread_ids_of(&items[0]["snapshot"])
        );
        engine.shutdown().await;
    }

    /// Items past the engine's sequence (a terminal's agent started working; no event) carry
    /// that sequence, and a client resuming from it gets `unchanged`.
    #[tokio::test]
    async fn shell_stream_items_past_the_engine_carry_its_sequence() {
        let (engine, _) = capped_engine(30).await;
        let (updates, receiver) = broadcast::channel(8);
        let attachment =
            crate::terminal::TerminalMetadataAttachment::for_test(Vec::new(), receiver);
        let mut stream = shell_stream_with(
            engine.clone(),
            Some(ShellTerminals::Attached(attachment)),
            SubscribeShellInput {
                cap: Some(ShellCapInput::default()),
                resume: None,
            },
            engine.subscribe_events(),
            CancellationToken::new(),
            default_thread_revision_keys(),
        );
        let first = next_items(&mut stream).await.remove(0);
        let engine_sequence = first["snapshot"]["snapshotSequence"].clone();
        updates
            .send(TerminalMetadataEvent::Upsert {
                terminal: Box::new(terminal_summary("t001", "working")),
            })
            .unwrap();
        let items = next_items(&mut stream).await;
        assert!(!items.is_empty());
        for item in &items {
            assert!(
                item["sequence"].as_i64() > engine_sequence.as_i64(),
                "{items:?}"
            );
            assert_eq!(item["engineSequence"], engine_sequence, "{items:?}");
        }
        // A client resuming at the engine's sequence, with the same live terminal, holds the
        // current shell.
        let (_updates, receiver) = broadcast::channel(8);
        let attachment = crate::terminal::TerminalMetadataAttachment::for_test(
            vec![terminal_summary("t001", "working")],
            receiver,
        );
        let mut resumed = shell_stream_with(
            engine.clone(),
            Some(ShellTerminals::Attached(attachment)),
            SubscribeShellInput {
                cap: Some(ShellCapInput::default()),
                resume: Some(ShellResumeInput {
                    revision: items.last().unwrap()["revision"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    snapshot_sequence: engine_sequence.as_i64().unwrap(),
                }),
            },
            engine.subscribe_events(),
            CancellationToken::new(),
            default_thread_revision_keys(),
        );
        assert_eq!(next_items(&mut resumed).await[0]["kind"], "unchanged");
        engine.shutdown().await;
    }

    /// A resubscribe with the revision the client holds is answered `unchanged`, with each
    /// kept thread's activity age now.
    #[tokio::test]
    async fn shell_stream_resume_with_current_revision_answers_unchanged_with_ages() {
        let (engine, _) = capped_engine(3).await;
        engine
            .repositories()
            .database()
            .call(|connection| {
                connection.execute(
                    "UPDATE projection_threads SET last_activity_at = '2026-07-11T00:00:00.000Z'                      WHERE thread_id = 't000'",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let mut first = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        let item = next_items(&mut first).await.remove(0);
        let revision = item["revision"].as_str().unwrap().to_owned();
        let sequence = item["snapshot"]["snapshotSequence"].clone();

        let mut resumed = subscribe_shell(
            engine.clone(),
            None,
            capped_request(
                json!({ "cap": {}, "resume": { "revision": revision, "snapshotSequence": sequence } }),
            ),
            CancellationToken::new(),
        );
        let answer = next_items(&mut resumed).await.remove(0);
        assert_eq!(answer["kind"], "unchanged");
        assert_eq!(answer["revision"], json!(revision));
        assert_eq!(answer["snapshotSequence"], sequence);
        assert!(
            answer["activityAges"]["t000"]
                .as_u64()
                .is_some_and(|age| age > 0)
        );
        assert!(answer["activityAges"].get("t001").is_none());
        engine.shutdown().await;
    }

    /// Anything but the current revision gets the snapshot: a missed change, new keys (a
    /// restart), an unknown revision, or a sequence newer than the server's.
    #[tokio::test]
    async fn shell_stream_resume_with_stale_revision_or_new_keys_sends_snapshot() {
        let (engine, _) = capped_engine(3).await;
        let mut first = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        let item = next_items(&mut first).await.remove(0);
        let revision = item["revision"].as_str().unwrap().to_owned();
        let sequence = item["snapshot"]["snapshotSequence"].as_i64().unwrap();
        let resume = |revision: &str, sequence: i64| SubscribeShellInput {
            cap: Some(ShellCapInput::default()),
            resume: Some(ShellResumeInput {
                revision: revision.to_owned(),
                snapshot_sequence: sequence,
            }),
        };
        let restarted: &'static ThreadRevisionKeys = Box::leak(Box::new(ThreadRevisionKeys::new()));
        for (input, keys) in [
            (
                resume("0123456789abcdef0123456789abcdef", sequence),
                default_thread_revision_keys(),
            ),
            (
                resume(&revision, sequence + 1),
                default_thread_revision_keys(),
            ),
            (resume(&revision, sequence), restarted),
        ] {
            let mut stream = shell_stream_with(
                engine.clone(),
                None,
                input,
                engine.subscribe_events(),
                CancellationToken::new(),
                keys,
            );
            assert_eq!(next_items(&mut stream).await[0]["kind"], "snapshot");
        }
        rename(&engine, "t000", 1).await;
        let mut missed = shell_stream_with(
            engine.clone(),
            None,
            resume(&revision, sequence),
            engine.subscribe_events(),
            CancellationToken::new(),
            default_thread_revision_keys(),
        );
        assert_eq!(next_items(&mut missed).await[0]["kind"], "snapshot");
        engine.shutdown().await;
    }

    /// A delta chunk carries the revision after it on its last item only, and resuming from
    /// it is `unchanged`.
    #[tokio::test]
    async fn shell_stream_delta_chunks_carry_the_revision_on_their_last_item() {
        let (engine, _) = capped_engine(3).await;
        let mut stream = subscribe_shell(
            engine.clone(),
            None,
            capped_request(json!({ "cap": {} })),
            CancellationToken::new(),
        );
        next_items(&mut stream).await;
        rename(&engine, "t000", 1).await;
        rename(&engine, "t001", 2).await;
        let items = next_items(&mut stream).await;
        assert_eq!(items.len(), 2, "{items:?}");
        assert!(items[0].get("revision").is_none());
        let revision = items[1]["revision"].as_str().unwrap().to_owned();
        let mut resumed = subscribe_shell(
            engine.clone(),
            None,
            capped_request(
                json!({ "cap": {}, "resume": { "revision": revision, "snapshotSequence": items[1]["sequence"] } }),
            ),
            CancellationToken::new(),
        );
        assert_eq!(next_items(&mut resumed).await[0]["kind"], "unchanged");
        engine.shutdown().await;
    }

    async fn older_page(engine: &OrchestrationEngine, payload: Value) -> RpcResult {
        list_older_threads(
            engine,
            None,
            request("orchestration.listOlderThreads", payload),
        )
        .await
    }

    fn page_ids(page: &Value) -> Vec<String> {
        page["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|thread| thread["id"].as_str().unwrap().to_owned())
            .collect()
    }

    /// Paging the project returns every left-out thread once, newest first.
    #[tokio::test]
    async fn list_older_threads_pages_every_left_out_thread_once_newest_first() {
        let (engine, _) = capped_engine(40).await;
        let mut seen = Vec::new();
        let mut cursor = Value::Null;
        loop {
            let mut payload =
                json!({ "scope": { "kind": "project", "projectId": "project" }, "limit": 4 });
            if !cursor.is_null() {
                payload["cursor"] = cursor.clone();
            }
            let page = older_page(&engine, payload).await.unwrap();
            seen.extend(page_ids(&page));
            cursor = page["cursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        // The cap keeps t039..t015; t014..t000 are left out.
        let expected = (0..15)
            .rev()
            .map(|index| format!("t{index:03}"))
            .collect::<Vec<_>>();
        assert_eq!(seen, expected);
        engine.shutdown().await;
    }

    /// The checkout scope lists left-out panels grouped as the shell counts them.
    #[tokio::test]
    async fn list_older_threads_checkout_scope_matches_the_chat_grouping() {
        let (engine, _) = capped_engine(30).await;
        let repositories = engine.repositories();
        seed_cap_thread(&repositories, "panel-main", "project", "panel", None, 0).await;
        seed_cap_thread(
            &repositories,
            "panel-wt",
            "project",
            "panel",
            Some("C:/repo/wt"),
            0,
        )
        .await;
        let main = older_page(&engine, json!({ "scope": { "kind": "checkout", "projectId": "project", "worktreePath": null } })).await.unwrap();
        assert_eq!(page_ids(&main), ["panel-main"]);
        let worktree = older_page(&engine, json!({ "scope": { "kind": "checkout", "projectId": "project", "worktreePath": "C:/repo/wt" } })).await.unwrap();
        assert_eq!(page_ids(&worktree), ["panel-wt"]);
        let project = older_page(
            &engine,
            json!({ "scope": { "kind": "project", "projectId": "project" } }),
        )
        .await
        .unwrap();
        assert!(!page_ids(&project).iter().any(|id| id.starts_with("panel")));
        engine.shutdown().await;
    }

    /// The agents scope lists every left-out thread with a session, panels included.
    #[tokio::test]
    async fn list_older_threads_agents_scope_includes_panels() {
        let (engine, _) = capped_engine(30).await;
        let repositories = engine.repositories();
        seed_cap_thread(&repositories, "panel-agent", "project", "panel", None, 0).await;
        seed_cap_session(&repositories, "panel-agent", "ready").await;
        seed_cap_session(&repositories, "t000", "ready").await;
        let page = older_page(&engine, json!({ "scope": { "kind": "agents" } }))
            .await
            .unwrap();
        assert_eq!(page_ids(&page), ["t000", "panel-agent"]);
        engine.shutdown().await;
    }

    /// The search scope finds any unarchived thread by title, with or without a session.
    #[tokio::test]
    async fn list_older_threads_search_scope_finds_threads_without_sessions() {
        let (engine, _) = capped_engine(30).await;
        rename(&engine, "t000", 7).await;
        let page = older_page(
            &engine,
            json!({ "scope": { "kind": "search" }, "query": "title 7" }),
        )
        .await
        .unwrap();
        assert_eq!(page_ids(&page), ["t000"]);
        assert!(page["threads"][0]["session"].is_null());
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn list_older_threads_search_scope_requires_a_query() {
        let (engine, _) = capped_engine(1).await;
        let error = older_page(&engine, json!({ "scope": { "kind": "search" } }))
            .await
            .unwrap_err();
        assert_eq!(error["_tag"], "OrchestrationListOlderThreadsError");
        engine.shutdown().await;
    }

    /// `%` and `_` are literal: the search is a substring match, never a pattern.
    #[tokio::test]
    async fn list_older_threads_searches_titles_case_insensitively_with_escaped_wildcards() {
        let (engine, _) = capped_engine(3).await;
        for (thread_id, title) in [
            ("t000", "Fix 100% CPU"),
            ("t001", "fix 1000 cpu"),
            ("t002", "FIX_A"),
        ] {
            engine
                .dispatch(decode_command(json!({
                    "type": "thread.meta.update",
                    "commandId": format!("title-{thread_id}"),
                    "threadId": thread_id,
                    "title": title,
                })))
                .await
                .unwrap();
        }
        let percent = older_page(
            &engine,
            json!({ "scope": { "kind": "search" }, "query": "100%" }),
        )
        .await
        .unwrap();
        assert_eq!(page_ids(&percent), ["t000"]);
        let underscore = older_page(
            &engine,
            json!({ "scope": { "kind": "search" }, "query": "x_" }),
        )
        .await
        .unwrap();
        assert_eq!(page_ids(&underscore), ["t002"]);
        let case = older_page(
            &engine,
            json!({ "scope": { "kind": "search" }, "query": "FIX 1" }),
        )
        .await
        .unwrap();
        assert_eq!(page_ids(&case), ["t001", "t000"]);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn list_older_threads_rejects_a_malformed_cursor() {
        let (engine, _) = capped_engine(1).await;
        for cursor in ["not-base64!", "e30"] {
            let error = older_page(
                &engine,
                json!({ "scope": { "kind": "agents" }, "cursor": cursor }),
            )
            .await
            .unwrap_err();
            assert_eq!(
                error["_tag"], "OrchestrationListOlderThreadsError",
                "{cursor}"
            );
        }
        engine.shutdown().await;
    }

    /// The authority on whether a thread exists: live and archived threads come back, deleted
    /// and unknown ids are `missing`.
    #[tokio::test]
    async fn get_thread_shells_returns_live_and_archived_and_lists_missing() {
        let (engine, _) = capped_engine(3).await;
        for (command, thread_id) in [("thread.archive", "t001"), ("thread.delete", "t002")] {
            engine
                .dispatch(decode_command(json!({ "type": command, "commandId": format!("{command}-{thread_id}"), "threadId": thread_id })))
                .await
                .unwrap();
        }
        let answer = get_thread_shells(
            &engine,
            request(
                "orchestration.getThreadShells",
                json!({ "threadIds": ["t000", "t001", "t002", "nope"] }),
            ),
        )
        .await
        .unwrap();
        assert_eq!(page_ids(&answer), ["t000", "t001"]);
        assert!(answer["threads"][0]["archivedAt"].is_null());
        assert!(answer["threads"][1]["archivedAt"].is_string());
        assert_eq!(answer["missing"], json!(["t002", "nope"]));
        let error = get_thread_shells(
            &engine,
            request("orchestration.getThreadShells", json!({ "threadIds": [] })),
        )
        .await
        .unwrap_err();
        assert_eq!(error["_tag"], "InvalidRequest");
        engine.shutdown().await;
    }

    /// #223 baseline and result: what the shell stream sends while one thread streams a turn,
    /// at 30 and 150 threads, uncapped and capped. Every thread has a finished turn, a session, a prompt and a reply,
    /// so each shell carries previews; the streaming thread has a running session and turn, and
    /// every 50 ms its reply grows by a delta, its provider progress time moves, and every
    /// fourth tick it adds a tool activity, each followed by an engine event as the provider
    /// runtime's would be. Prints counts, bytes and durations only; run with
    /// `cargo test -p bibcode-server --lib shell_stream_traffic -- --ignored --nocapture`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "simulates a 10 s turn per store size; run by hand for numbers"]
    async fn shell_stream_traffic_during_a_streaming_turn() {
        const TURN: Duration = Duration::from_secs(10);
        const EVENT_INTERVAL: Duration = Duration::from_millis(50);
        const DELTA: &str = "streamed words of an assistant reply, more ";
        for threads in [30_usize, 150] {
            let engine = migrated_engine().await;
            let mut tap = engine.subscribe_events();
            created_project_thread(&engine).await;
            let event = tap.recv().await.expect("an engine event");
            let repositories = engine.repositories();
            let reply = "A finished reply that explains what changed and why. ".repeat(24);
            let prompt = "Please look at the failing test and fix the cause. ".repeat(6);
            let mut streaming = None;
            // The project's default thread is one of them.
            for index in 0..threads - 1 {
                let thread_id = format!("thread-{index:03}");
                let live = index == 0;
                let turn_id = if live { "turn-live" } else { "turn-done" };
                let mut thread = store_thread(&thread_id, "project", Some(turn_id));
                // Workspace threads without a worktree: what a capped shell may leave out.
                thread.kind = "workspace".to_owned();
                thread.last_activity_at = Some(CREATED_AT.to_owned());
                repositories.upsert_thread(thread.clone()).await.unwrap();
                let mut turn = store_turn(
                    &thread_id,
                    turn_id,
                    if live { "running" } else { "completed" },
                );
                if !live {
                    turn.completed_at = Some("2026-07-11T00:00:09.000Z".to_owned());
                }
                repositories.upsert_turn_by_id(turn).await.unwrap();
                repositories
                    .upsert_thread_session(crate::persistence::ProjectionThreadSession {
                        thread_id: thread_id.clone(),
                        status: if live { "running" } else { "ready" }.to_owned(),
                        provider_name: Some("codex".to_owned()),
                        provider_instance_id: Some("codex".to_owned()),
                        runtime_mode: "full-access".to_owned(),
                        active_turn_id: live.then(|| "turn-live".to_owned()),
                        last_error: None,
                        last_error_class: None,
                        updated_at: CREATED_AT.to_owned(),
                    })
                    .await
                    .unwrap();
                let mut user = store_message(
                    &format!("{thread_id}-user"),
                    &thread_id,
                    "user",
                    &prompt,
                    "2026-07-11T00:00:01.000Z",
                );
                user.turn_id = Some(turn_id.to_owned());
                repositories.upsert_message(user).await.unwrap();
                let mut assistant = store_message(
                    &format!("{thread_id}-assistant"),
                    &thread_id,
                    "assistant",
                    if live { "" } else { &reply },
                    "2026-07-11T00:00:02.000Z",
                );
                assistant.turn_id = Some(turn_id.to_owned());
                assistant.is_streaming = live;
                repositories
                    .upsert_message(assistant.clone())
                    .await
                    .unwrap();
                if live {
                    streaming = Some((thread, assistant));
                }
            }
            let (mut thread, mut assistant) = streaming.expect("the streaming thread");
            let rebuilds = 5_u32;
            let started = std::time::Instant::now();
            for _ in 0..rebuilds {
                shell_snapshot(&engine, false).await.expect("shell");
            }
            let rebuild = started.elapsed() / rebuilds;

            // Each turn is measured twice: as an older client subscribes (`{}`, every thread)
            // and as the app does since #223 (`cap`, the kept set).
            let mut applied = 0;
            for capped in [false, true] {
                let (events, receiver) = broadcast::channel(1_024);
                let cancellation = CancellationToken::new();
                let mut stream = shell_stream_with(
                    engine.clone(),
                    None,
                    SubscribeShellInput {
                        cap: capped.then(ShellCapInput::default),
                        resume: None,
                    },
                    receiver,
                    cancellation.clone(),
                    default_thread_revision_keys(),
                );
                let first = serde_json::to_vec(&next_items(&mut stream).await[0])
                    .unwrap()
                    .len();
                let counter = tokio::spawn(async move {
                    let (mut items, mut bytes) = (0_usize, 0_usize);
                    while let Some(Ok(chunk)) = stream.recv().await {
                        items += chunk.len();
                        bytes += chunk
                            .iter()
                            .map(|item| serde_json::to_vec(item).unwrap().len())
                            .sum::<usize>();
                    }
                    (items, bytes)
                });
                let started = std::time::Instant::now();
                let mut ticks = 0;
                while started.elapsed() < TURN {
                    assistant.text.push_str(DELTA);
                    assistant.updated_at = now_iso();
                    repositories
                        .upsert_message(assistant.clone())
                        .await
                        .unwrap();
                    if ticks % 4 == 0 {
                        let mut activity = store_activity(
                            &format!("tool-{applied:04}"),
                            &thread.thread_id,
                            "turn-live",
                            "tool",
                            Some(applied),
                            &now_iso(),
                        );
                        activity.summary = format!("Ran cargo test, step {applied}");
                        repositories.upsert_activity(activity).await.unwrap();
                    }
                    thread.last_activity_at = Some(now_iso());
                    repositories.upsert_thread(thread.clone()).await.unwrap();
                    // Each provider event is a durable event the projection applies.
                    applied += 1;
                    repositories
                        .upsert_projection_state(crate::persistence::ProjectionState {
                            projector: "streaming-turn".to_owned(),
                            last_applied_sequence: event.sequence + applied,
                            updated_at: now_iso(),
                        })
                        .await
                        .unwrap();
                    events.send(event.clone()).expect("the stream listens");
                    ticks += 1;
                    tokio::time::sleep(EVENT_INTERVAL).await;
                }
                let elapsed = started.elapsed();
                tokio::time::sleep(SHELL_SNAPSHOT_COALESCE * 2).await;
                cancellation.cancel();
                let (items, bytes) = counter.await.unwrap();
                println!(
                    "{threads} threads{}: first snapshot {first} B; {ticks} events in {:.1} s sent {items} items ({:.2}/s), {bytes} B ({} B/item); rebuild {:.1} ms",
                    if capped { ", capped" } else { "" },
                    elapsed.as_secs_f64(),
                    items as f64 / elapsed.as_secs_f64(),
                    bytes.checked_div(items).unwrap_or(0),
                    rebuild.as_secs_f64() * 1e3,
                );
            }
            engine.shutdown().await;
        }
    }

    /// Creates a thread and deletes it: a view that still shows it keeps subscribing.
    async fn deleted_thread(engine: &OrchestrationEngine) -> &'static str {
        created_project_thread(engine).await;
        for command in [
            json!({"type":"thread.create","commandId":"create","threadId":"gone","projectId":"project","title":"Gone","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","branch":null,"worktreePath":null,"createdAt":CREATED_AT}),
            json!({"type":"thread.delete","commandId":"delete","threadId":"gone"}),
        ] {
            engine
                .dispatch(decode_command(command))
                .await
                .expect("setup");
        }
        "gone"
    }

    /// The producer ends with its error instead of waiting for a cancellation or for an
    /// event of its thread, which a deleted thread never gets (#113).
    #[tokio::test]
    async fn thread_stream_ends_after_its_error() {
        let engine = migrated_engine().await;
        let thread_id = deleted_thread(&engine).await;
        let mut stream = thread_stream(
            engine.clone(),
            request(
                "orchestration.subscribeThread",
                json!({ "threadId": thread_id, "patches": true }),
            ),
            CancellationToken::new(),
        );
        assert!(stream.recv().await.expect("an item").is_err());
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stream.recv())
                .await
                .expect("the stream ends")
                .is_none()
        );
        assert_eq!(engine.event_subscriber_count_for_test(), 0);
        engine.shutdown().await;
    }

    /// A failed subscription must end with its request (#113). A client retried a deleted
    /// thread every 250 ms; each failed attempt left a task holding an engine event receiver,
    /// so every later event was cloned into tens of thousands of receivers until restart.
    #[tokio::test]
    async fn failed_thread_subscriptions_release_their_event_receivers() {
        const ATTEMPTS: usize = 20;
        let engine = migrated_engine().await;
        let thread_id = deleted_thread(&engine).await;
        let state = tempfile::tempdir().expect("state directory");
        let mut registry = RpcRegistry::empty();
        register_orchestration_rpc(&mut registry, engine.clone());
        let handle = ServerRuntime::start_with_registry(
            ServerConfig::new(state.path())
                .with_bind("127.0.0.1", 0)
                .with_unsafe_no_auth(),
            registry,
        )
        .await
        .expect("server starts");
        let (mut socket, _) =
            tokio_tungstenite::connect_async(format!("ws://{}/ws", handle.local_addr()))
                .await
                .expect("socket connects");
        let baseline = engine.event_subscriber_count_for_test();

        for attempt in 1..=ATTEMPTS {
            let id = attempt.to_string();
            let request = json!({
                "_tag": "Request",
                "id": id,
                "tag": "orchestration.subscribeThread",
                "payload": { "threadId": thread_id, "patches": true },
                "headers": [],
            });
            socket
                .send(Message::Text(request.to_string().into()))
                .await
                .expect("send subscription");
            let frame = tokio::time::timeout(
                Duration::from_secs(5),
                next_frame_past_heartbeat(&mut socket),
            )
            .await
            .expect("subscription answers")
            .expect("socket open")
            .expect("frame");
            let Message::Text(text) = frame else {
                panic!("expected a text frame, got {frame:?}");
            };
            assert!(
                matches!(
                    serde_json::from_str::<ServerMessage>(&text).expect("server message"),
                    ServerMessage::Exit { request_id, exit: RpcExit::Failure { .. } }
                        if request_id == RequestId::try_from(id.as_str()).unwrap()
                ),
                "a deleted thread's subscription fails: {text}"
            );
        }

        // The connection stays open, as the client's does between retries.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while engine.event_subscriber_count_for_test() > baseline
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let leaked = engine.event_subscriber_count_for_test() - baseline;
        assert_eq!(
            leaked, 0,
            "{leaked} of {ATTEMPTS} failed subscriptions still hold an event receiver"
        );
        drop(socket);
        handle.shutdown();
        handle.join().await.expect("server joins");
        engine.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn thread_stream_subscribes_before_returning_to_concurrent_dispatchers() {
        let engine = migrated_engine().await;
        engine
            .dispatch(decode_command(json!({
                "type": "project.create",
                "commandId": "project",
                "projectId": "project",
                "title": "Project",
                "workspaceRoot": "C:/repo",
                "defaultModelSelection": null,
                "createdAt": CREATED_AT,
            })))
            .await
            .expect("project created");
        let thread_id = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot")
            .threads
            .into_iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id;
        let cancellation = CancellationToken::new();

        let stream = thread_stream(
            engine.clone(),
            request(
                "orchestration.subscribeThread",
                json!({ "threadId": thread_id }),
            ),
            cancellation.clone(),
        );

        assert_eq!(
            engine.event_subscriber_count_for_test(),
            1,
            "the event receiver must exist before a concurrent post-snapshot update can publish",
        );
        cancellation.cancel();
        drop(stream);
        engine.shutdown().await;
    }
    use crate::transfer::staging::{
        UploadAppendInput, UploadBeginInput, UploadErrorReason, UploadLimits, UploadTarget,
    };
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::time::Duration;
    async fn stage_notes(uploads: &UploadRegistry, owner: &UploadOwner, complete: bool) -> Value {
        let begun = uploads
            .begin(
                owner,
                UploadBeginInput {
                    target: UploadTarget::ChatAttachment {
                        attachment_type: "file".into(),
                        name: "notes.txt".into(),
                        mime_type: "text/plain".into(),
                    },
                    size_bytes: 5,
                    sha256: None,
                },
            )
            .await
            .unwrap();
        if complete {
            uploads
                .append(
                    owner,
                    UploadAppendInput {
                        upload_id: begun.upload_id.clone(),
                        offset: 0,
                        data: STANDARD.encode(b"notes"),
                        sha256: Some(crate::crypto::sha256_hex(b"notes")),
                    },
                )
                .await
                .unwrap();
        }
        json!({"type":"file", "id":"notes-1", "name":"notes.txt", "mimeType":"text/plain",
        "sizeBytes":5, "uploadId":begun.upload_id})
    }
    #[tokio::test]
    async fn failed_staged_turn_retries_the_same_command_without_appending_again() {
        let hooks = TestHooks::default();
        let (database, engine, thread_id) = delivery_engine(hooks.clone()).await;
        let state = tempfile::tempdir().unwrap();
        let uploads = UploadRegistry::new(
            state.path().join("attachment-uploads"),
            UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        );
        let owner = UploadOwner::Session("sender".into());
        let input = stage_notes(&uploads, &owner, true).await;
        let upload_id = input["uploadId"].as_str().unwrap().to_owned();
        let (sent, mut received) = tokio::sync::mpsc::channel(1);
        let root = state.path().join("attachments");
        let delivery = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            Arc::new(move |command| {
                let sent = sent.clone();
                let root = root.clone();
                Box::pin(async move {
                    let OrchestrationCommand::ThreadTurnStart { message, .. } = command else {
                        panic!("expected turn start");
                    };
                    let images = AttachmentMaterializer::new(root)
                        .materialize(message.attachments)
                        .await
                        .unwrap();
                    sent.send(images[0].base64_data.clone()).await.unwrap();
                    Ok(())
                })
            }),
        ));
        let (mut registration, provider) = provider_registration(
            database,
            &engine,
            state.path().to_path_buf(),
            delivery.clone(),
        );
        registration.uploads = uploads.clone();
        let command = decode_command(
            json!({"type":"thread.turn.start", "commandId":"staged-retry",
        "threadId":thread_id, "message":{"messageId":"m-staged", "role":"user", "text":"review",
        "attachments":[input]}, "modelSelection":{"instanceId":"codex","model":"gpt-5"},
        "createdAt":CREATED_AT}),
        );
        let digest = canonical_command_digest(&command).unwrap();
        hooks.fail_next_projector("projection.thread-messages", Some("thread.message-sent"));
        let failed = dispatch_turn_for_test(
            engine.clone(),
            registration.clone(),
            command.clone(),
            digest.clone(),
            "orchestration.dispatchCommand".into(),
            None,
            &owner,
        )
        .await;
        assert!(failed.is_err());
        assert!(uploads.get(&owner, &upload_id).await.unwrap().complete);
        assert!(!state.path().join("attachments/notes-1").exists());
        assert!(received.try_recv().is_err());
        dispatch_turn_for_test(
            engine.clone(),
            registration,
            command,
            digest,
            "orchestration.dispatchCommand".into(),
            None,
            &owner,
        )
        .await
        .unwrap();
        let encoded = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(STANDARD.decode(encoded).unwrap(), b"notes");
        assert_eq!(
            uploads.get(&owner, &upload_id).await.unwrap_err().reason,
            UploadErrorReason::NotFound
        );
        delivery.shutdown().await;
        provider.shutdown().await.unwrap();
        engine.shutdown().await;
    }
    #[tokio::test]
    async fn queued_staged_turn_binds_before_enqueue_and_keeps_only_durable_metadata() {
        let (database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        engine
            .dispatch(decode_command(
                json!({"type":"thread.session.set", "commandId":"session",
        "threadId":thread_id, "session":{"threadId":thread_id,"status":"running",
        "providerName":"codex","activeTurnId":null,"lastError":null,"updatedAt":CREATED_AT},
        "createdAt":CREATED_AT}),
            ))
            .await
            .unwrap();
        let state = tempfile::tempdir().unwrap();
        let uploads = UploadRegistry::new(
            state.path().join("attachment-uploads"),
            UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        );
        let owner = UploadOwner::Session("sender".into());
        let input = stage_notes(&uploads, &owner, true).await;
        let id = input["uploadId"].as_str().unwrap().to_owned();
        let service = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            Arc::new(|_| Box::pin(async { Ok(()) })),
        ));
        service.shutdown().await; // inspect durable admission before any delivery worker
        let (mut registration, provider) =
            provider_registration(database, &engine, state.path().to_path_buf(), service);
        registration.uploads = uploads.clone();
        let command = decode_command(
            json!({"type":"thread.turn.start","commandId":"queued-stage",
        "threadId":thread_id,"queued":true,"message":{"messageId":"queued-stage-message",
        "role":"user","text":"later","attachments":[input]},"createdAt":CREATED_AT}),
        );
        let digest = canonical_command_digest(&command).unwrap();
        dispatch_turn_for_test(
            engine.clone(),
            registration,
            command,
            digest,
            "orchestration.dispatchCommand".into(),
            None,
            &owner,
        )
        .await
        .unwrap();
        let row = engine
            .repositories()
            .get_provider_turn_delivery("queued-stage".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, TurnDeliveryState::Queued);
        let attachments = row.payload["message"]["attachments"].as_array().unwrap();
        assert!(attachments[0].get("uploadId").is_none());
        assert!(attachments[0].get("dataUrl").is_none());
        assert_eq!(
            uploads.get(&owner, &id).await.unwrap_err().reason,
            UploadErrorReason::NotFound
        );
        let ready = AttachmentMaterializer::new(state.path().join("attachments"))
            .materialize(attachments.clone())
            .await
            .unwrap();
        assert_eq!(STANDARD.decode(&ready[0].base64_data).unwrap(), b"notes");
        provider.shutdown().await.unwrap();
        engine.shutdown().await;
    }
    #[tokio::test]
    async fn vanished_staged_dispatch_returns_typed_not_found_and_releases_the_command_claim() {
        let (database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        let state = tempfile::tempdir().unwrap();
        let uploads = UploadRegistry::new(
            state.path().join("attachment-uploads"),
            UploadLimits::default(),
            Arc::new(tokio::time::Instant::now),
        );
        let owner = UploadOwner::Session("sender".into());
        let input = stage_notes(&uploads, &owner, true).await;
        uploads
            .cancel(&owner, input["uploadId"].as_str().unwrap())
            .await
            .unwrap();
        let service = Arc::new(TurnDeliveryService::start_with_router(
            engine.clone(),
            1,
            Arc::new(|_| Box::pin(async { Ok(()) })),
        ));
        let (mut registration, provider) = provider_registration(
            database,
            &engine,
            state.path().to_path_buf(),
            service.clone(),
        );
        registration.uploads = uploads;
        let command = decode_command(
            json!({"type":"thread.turn.start","commandId":"missing-stage","threadId":thread_id,"message":{"messageId":"missing-stage-message","role":"user","text":"review","attachments":[input]},"modelSelection":{"instanceId":"codex","model":"gpt-5"},"createdAt":CREATED_AT}),
        );
        let digest = canonical_command_digest(&command).unwrap();
        let error = dispatch_turn_for_test(
            engine.clone(),
            registration,
            command,
            digest,
            "orchestration.dispatchCommand".into(),
            None,
            &owner,
        )
        .await
        .unwrap_err();
        assert_eq!(error["_tag"], "UploadError");
        assert_eq!(error["reason"], "not_found");
        assert!(
            engine
                .repositories()
                .get_command_receipt("missing-stage".into())
                .await
                .unwrap()
                .is_none()
        );
        service.shutdown().await;
        provider.shutdown().await.unwrap();
        engine.shutdown().await;
    }

    // The thread history window (#226) through the real stream, engine and projections.

    /// Imports `turns` turns (a user message and its reply) a minute apart after `CREATED_AT`.
    async fn import_turns(engine: &OrchestrationEngine, thread_id: &str, turns: usize) {
        let messages = (0..turns)
            .flat_map(|turn| {
                let at = |second: usize| format!("2026-07-12T{:02}:{:02}:{second:02}.000Z", turn / 60, turn % 60);
                [
                    json!({"messageId": format!("u{turn:03}"), "role": "user", "text": format!("question {turn}"), "createdAt": at(0)}),
                    json!({"messageId": format!("a{turn:03}"), "role": "assistant", "text": format!("answer {turn}"), "createdAt": at(30)}),
                ]
            })
            .collect::<Vec<_>>();
        engine
            .dispatch(decode_command(json!({
                "type": "thread.history.import", "commandId": "import", "threadId": thread_id,
                "messages": messages,
            })))
            .await
            .expect("history imported");
    }

    async fn dispatch_all(engine: &OrchestrationEngine, commands: Vec<Value>) {
        for command in commands {
            engine
                .dispatch(decode_command(command))
                .await
                .expect("command accepted");
        }
    }

    fn windowed(thread_id: &str, floor: Option<&Value>, resume_from: Option<&Value>) -> Value {
        let mut payload = match resume_from {
            Some(item) => resume(thread_id, item),
            None => json!({ "threadId": thread_id, "patches": true }),
        };
        payload["history"] = match floor {
            Some(floor) => json!({ "floor": floor }),
            None => json!({}),
        };
        payload
    }

    fn thread_of(item: &Value) -> &Value {
        &item["snapshot"]["thread"]
    }

    fn floor_of(thread: &Value) -> Value {
        thread["history"]["floor"].clone()
    }

    fn ids_of(thread: &Value, name: &str) -> Vec<String> {
        thread[name]
            .as_array()
            .expect("an array")
            .iter()
            .map(|row| row["id"].as_str().expect("an id").to_owned())
            .collect()
    }

    /// Applies a `patch` item to the thread a subscriber holds, as the client does.
    fn apply_patch(thread: &mut Value, item: &Value) {
        assert_eq!(item["kind"], "patch", "{item}");
        let patch = &item["patch"];
        for (key, value) in patch["set"].as_object().expect("set") {
            thread[key] = value.clone();
        }
        for key in patch["unset"].as_array().expect("unset") {
            thread
                .as_object_mut()
                .unwrap()
                .remove(key.as_str().unwrap());
        }
        for (key, array) in patch["arrays"].as_object().expect("arrays") {
            let entries = thread[key].as_array_mut().expect("a held array");
            let length = array["length"].as_u64().unwrap() as usize;
            entries.resize(length, Value::Null);
            for change in array["changes"].as_array().unwrap() {
                entries[change[0].as_u64().unwrap() as usize] = change[1].clone();
            }
        }
    }

    /// Applies stream items to the held thread until `until` holds.
    async fn follow(
        stream: &mut mpsc::Receiver<RpcStreamChunk>,
        thread: &mut Value,
        until: impl Fn(&Value) -> bool,
    ) {
        loop {
            let item = next_items(stream).await.remove(0);
            if item["kind"] == "snapshot" {
                *thread = thread_of(&item).clone();
            } else {
                apply_patch(thread, &item);
            }
            if until(thread) {
                return;
            }
        }
    }

    #[tokio::test]
    async fn clients_without_the_history_flag_get_the_full_thread_byte_identical() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let expected = thread_snapshot(&engine, &thread_id)
            .await
            .expect("snapshot");
        for payload in [
            json!({ "threadId": thread_id, "patches": true }),
            json!({ "threadId": thread_id, "patches": true, "history": null }),
            json!({ "threadId": thread_id }),
        ] {
            let mut stream = subscribe_thread(&engine, payload, keys, &cancellation);
            let item = next_items(&mut stream).await.remove(0);
            assert_eq!(
                serde_json::to_vec(&item["snapshot"]).unwrap(),
                serde_json::to_vec(&expected).unwrap()
            );
            assert!(thread_of(&item).get("history").is_none());
        }
        cancellation.cancel();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn windowed_stream_patches_a_new_message_and_never_removes_rows_outside_the_window() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut stream = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut stream).await.remove(0);
        let mut held = thread_of(&opened).clone();
        assert_eq!(held["history"]["hasOlder"], true);
        assert_eq!(
            held["messages"].as_array().unwrap().len(),
            20,
            "ten whole turns"
        );
        assert_eq!(held["history"]["olderRows"], 40);
        let before = ids_of(&held, "messages");

        dispatch_all(&engine, vec![
            json!({"type":"thread.message.assistant.delta","commandId":"new-1","threadId":thread_id,"messageId":"a-new","delta":"more","turnId":"turn-new","createdAt":"2026-07-13T00:00:00.000Z"}),
            json!({"type":"thread.message.assistant.complete","commandId":"new-2","threadId":thread_id,"messageId":"a-new","turnId":"turn-new","createdAt":"2026-07-13T00:00:01.000Z"}),
        ])
        .await;
        let mut lengths = vec![held["messages"].as_array().unwrap().len()];
        follow(&mut stream, &mut held, |thread| {
            thread["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["id"] == "a-new" && row["streaming"] == false)
        })
        .await;
        lengths.push(held["messages"].as_array().unwrap().len());
        assert_eq!(lengths, [20, 21], "one row entered and none left");
        let after = ids_of(&held, "messages");
        assert!(before.iter().all(|id| after.contains(id)));
        assert_eq!(held["history"]["olderRows"], 40);
        cancellation.cancel();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn a_backdated_message_after_a_withdrawn_queued_message_joins_the_window() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut stream = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &cancellation,
        );
        let mut held = thread_of(&next_items(&mut stream).await.remove(0)).clone();
        let has =
            |thread: &Value, id: &str| ids_of(thread, "messages").iter().any(|held| held == id);

        // Queued at `CREATED_AT`, a day before the imported history: live, so in the window.
        seed_delivery(
            &engine,
            "queued",
            &thread_id,
            "queued-message",
            TurnDeliveryState::Queued,
        )
        .await;
        follow(&mut stream, &mut held, |thread| {
            has(thread, "queued-message")
        })
        .await;
        engine
            .dispatch(delivery_resolution(
                "withdraw",
                &thread_id,
                "queued-message",
                "cancel",
            ))
            .await
            .expect("withdrawn");
        follow(&mut stream, &mut held, |thread| {
            !has(thread, "queued-message")
        })
        .await;

        // SQLite may hand the withdrawn row's rowid to the next insert; the write sequence
        // still says this backdated row was written after the window opened.
        dispatch_all(&engine, vec![
            json!({"type":"thread.message.assistant.delta","commandId":"late-1","threadId":thread_id,"messageId":"backdated","delta":"late","turnId":"turn-late","createdAt":CREATED_AT}),
            json!({"type":"thread.message.assistant.complete","commandId":"late-2","threadId":thread_id,"messageId":"backdated","turnId":"turn-late","createdAt":CREATED_AT}),
        ])
        .await;
        follow(&mut stream, &mut held, |thread| {
            thread["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["id"] == "backdated" && row["streaming"] == false)
        })
        .await;
        assert_eq!(held["history"]["olderRows"], 40);
        cancellation.cancel();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn a_settled_row_below_the_floor_that_changes_moves_into_the_window() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let old = "2026-07-12T00:00:10.000Z";
        let failure = |summary: &str, command: &str| json!({"type":"thread.activity.append","commandId":command,"threadId":thread_id,"activity":{"id":"old-failure","tone":"error","kind":"runtime.error","summary":summary,"payload":{},"turnId":null,"createdAt":old},"createdAt":old});
        dispatch_all(&engine, vec![failure("Failed", "fail-1")]).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut stream = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &cancellation,
        );
        let mut held = thread_of(&next_items(&mut stream).await.remove(0)).clone();
        assert!(ids_of(&held, "activities").is_empty(), "below the floor");

        dispatch_all(&engine, vec![failure("Dismissed", "fail-2")]).await;
        follow(&mut stream, &mut held, |thread| {
            !ids_of(thread, "activities").is_empty()
        })
        .await;
        assert_eq!(held["activities"][0]["summary"], "Dismissed");
        cancellation.cancel();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn a_streaming_row_below_the_floor_stays_in_the_window_through_deltas_and_settlement() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let delta = |command: &str, text: &str| json!({"type":"thread.message.assistant.delta","commandId":command,"threadId":thread_id,"messageId":"long-reply","delta":text,"turnId":"turn-long","createdAt":"2026-07-12T00:00:05.000Z"});
        dispatch_all(&engine, vec![delta("d1", "one ")]).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut stream = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &cancellation,
        );
        let mut held = thread_of(&next_items(&mut stream).await.remove(0)).clone();
        let reply = |thread: &Value| {
            thread["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == "long-reply")
                .cloned()
        };
        assert_eq!(reply(&held).expect("live at open")["text"], "one ");
        dispatch_all(&engine, vec![delta("d2", "two")]).await;
        follow(&mut stream, &mut held, |thread| {
            reply(thread).is_some_and(|row| row["text"] == "one two")
        })
        .await;
        dispatch_all(&engine, vec![json!({"type":"thread.message.assistant.complete","commandId":"d3","threadId":thread_id,"messageId":"long-reply","turnId":"turn-long","createdAt":"2026-07-12T00:00:06.000Z"})]).await;
        follow(&mut stream, &mut held, |thread| {
            reply(thread).is_some_and(|row| row["streaming"] == false)
        })
        .await;
        rename(&engine, &thread_id, 1).await;
        follow(&mut stream, &mut held, |thread| {
            thread["title"] == "Title 1"
        })
        .await;
        assert!(reply(&held).is_some(), "settled, it stays in the window");
        cancellation.cancel();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn windowed_resubscribe_at_the_current_revision_sends_unchanged() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut first = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut first).await.remove(0);
        drop(first);
        let floor = floor_of(thread_of(&opened));
        let mut resumed = subscribe_thread(
            &engine,
            windowed(&thread_id, Some(&floor), Some(&opened)),
            keys,
            &cancellation,
        );
        let unchanged = next_items(&mut resumed).await.remove(0);
        assert_eq!(unchanged["kind"], "unchanged", "{unchanged}");
        assert_eq!(unchanged["revision"], opened["revision"]);
        // Without its floor, a resubscribe gets a fresh window: the same one while nothing changed.
        let mut other = subscribe_thread(
            &engine,
            windowed(&thread_id, None, Some(&opened)),
            keys,
            &cancellation,
        );
        let item = next_items(&mut other).await.remove(0);
        assert_eq!(item["kind"], "unchanged", "the same fresh window: {item}");
        cancellation.cancel();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn windowed_resubscribe_with_its_floor_keeps_the_floor_after_a_change() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut first = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut first).await.remove(0);
        drop(first);
        let floor = floor_of(thread_of(&opened));
        // Ten more turns: a fresh window would start higher.
        dispatch_all(&engine, (0..10).flat_map(|turn| {
            let at = format!("2026-07-14T00:{turn:02}:00.000Z");
            [
                json!({"type":"thread.message.assistant.delta","commandId":format!("more-{turn}"),"threadId":thread_id,"messageId":format!("more-{turn}"),"delta":"more","turnId":format!("turn-more-{turn}"),"createdAt":at}),
                json!({"type":"thread.message.assistant.complete","commandId":format!("done-{turn}"),"threadId":thread_id,"messageId":format!("more-{turn}"),"turnId":format!("turn-more-{turn}"),"createdAt":at}),
            ]
        }).collect()).await;
        let mut resumed = subscribe_thread(
            &engine,
            windowed(&thread_id, Some(&floor), Some(&opened)),
            keys,
            &cancellation,
        );
        let item = next_items(&mut resumed).await.remove(0);
        assert_eq!(item["kind"], "snapshot");
        assert_eq!(
            floor_of(thread_of(&item)),
            floor,
            "the pages the client holds stay contiguous"
        );
        assert_eq!(thread_of(&item)["messages"].as_array().unwrap().len(), 30);
        cancellation.cancel();
        engine.shutdown().await;
    }

    fn revert(thread_id: &str, command: &str) -> Value {
        json!({"type":"thread.revert.complete","commandId":command,"threadId":thread_id,"turnCount":0,"createdAt":"2026-07-15T00:00:00.000Z"})
    }

    #[tokio::test]
    async fn a_live_revert_rewindows_the_subscription() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut stream = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut stream).await.remove(0);
        dispatch_all(&engine, vec![revert(&thread_id, "revert")]).await;
        let item = next_items(&mut stream).await.remove(0);
        assert_eq!(
            item["kind"], "snapshot",
            "a revert sends a new window, never a patch: {item}"
        );
        assert_ne!(floor_of(thread_of(&item)), floor_of(thread_of(&opened)));
        cancellation.cancel();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn a_revert_lost_to_lag_rewindows_on_the_next_read() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let mut stream = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &cancellation,
        );
        let opened = next_items(&mut stream).await.remove(0);
        // Unread patches fill the stream until its task waits to send, and stops reading events.
        for index in 0..(STREAM_CAPACITY + 2) {
            rename(&engine, &thread_id, index).await;
            tokio::time::sleep(THREAD_UPDATE_COALESCE + Duration::from_millis(40)).await;
        }
        // More events than the event channel holds, the revert among them: the receiver lags.
        dispatch_all(&engine, vec![revert(&thread_id, "revert")]).await;
        dispatch_all(&engine, (0..200).map(|index| json!({"type":"thread.activity.append","commandId":format!("flood-{index}"),"threadId":thread_id,"activity":{"id":format!("flood-{index}"),"tone":"info","kind":"status","summary":"flood","payload":{},"turnId":null,"createdAt":"2026-07-16T00:00:00.000Z"},"createdAt":"2026-07-16T00:00:00.000Z"})).collect()).await;
        loop {
            let item = next_items(&mut stream).await.remove(0);
            if item["kind"] == "snapshot" {
                assert_ne!(floor_of(thread_of(&item)), floor_of(thread_of(&opened)));
                break;
            }
            assert_eq!(item["kind"], "patch");
        }
        cancellation.cancel();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn a_resubscribe_after_a_missed_revert_gets_a_fresh_window() {
        let (_database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let cancellation = CancellationToken::new();
        let keys = default_thread_revision_keys();
        let subscription = CancellationToken::new();
        let mut first = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            keys,
            &subscription,
        );
        let opened = next_items(&mut first).await.remove(0);
        subscription.cancel();
        drop(first);
        let floor = floor_of(thread_of(&opened));
        dispatch_all(&engine, vec![revert(&thread_id, "revert")]).await;
        let mut resumed = subscribe_thread(
            &engine,
            windowed(&thread_id, Some(&floor), Some(&opened)),
            keys,
            &cancellation,
        );
        let item = next_items(&mut resumed).await.remove(0);
        assert_eq!(item["kind"], "snapshot");
        assert_ne!(floor_of(thread_of(&item)), floor);
        // A page from the old window answers stale.
        let stale = thread_history::history_page(
            &engine,
            serde_json::from_value(json!({ "threadId": thread_id, "cursor": floor })).unwrap(),
        )
        .await
        .unwrap_err();
        assert_eq!(stale["_tag"], "OrchestrationThreadHistoryStaleError");
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// An OpenCode ask survives a restart of either side (#187); recovered without a turn, it
    /// still reaches the composer of a windowed thread.
    #[tokio::test]
    async fn a_recovered_turnless_opencode_ask_below_the_floor_is_carried() {
        let (database, engine, thread_id) = delivery_engine(TestHooks::default()).await;
        import_turns(&engine, &thread_id, 30).await;
        let old = "2026-07-12T00:00:10.000Z";
        dispatch_all(&engine, vec![
            json!({"type":"thread.session.set","commandId":"session","threadId":thread_id,"session":{"threadId":thread_id,"status":"ready","providerName":"opencode","providerInstanceId":"opencode","runtimeMode":"full-access","activeTurnId":null,"lastError":null,"updatedAt":old},"createdAt":old}),
            json!({"type":"thread.activity.append","commandId":"ask","threadId":thread_id,"activity":{"id":"recovered-ask","tone":"approval","kind":"user-input.requested","summary":"Question","payload":{"requestId":"ask-1","questions":[]},"turnId":null,"createdAt":old},"createdAt":old}),
        ])
        .await;
        engine.shutdown().await;
        let engine = OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .expect("engine restarts");
        let cancellation = CancellationToken::new();
        let mut stream = subscribe_thread(
            &engine,
            windowed(&thread_id, None, None),
            default_thread_revision_keys(),
            &cancellation,
        );
        let thread = thread_of(&next_items(&mut stream).await.remove(0)).clone();
        assert!(!ids_of(&thread, "activities").contains(&"recovered-ask".to_owned()));
        assert_eq!(
            ids_of(&thread["history"]["carried"], "activities"),
            ["recovered-ask"]
        );
        cancellation.cancel();
        engine.shutdown().await;
    }

    /// The window wire contract: a subscribe with `history`, the windowed snapshot with a live
    /// and a carried row, a patch, every page, a stale page, and the whole thread the client
    /// merges them back into. `threadStreamParity.test.ts` decodes and merges it. Regenerate
    /// with `BIBCODE_UPDATE_THREAD_STREAM_FIXTURE=1`.
    #[tokio::test]
    async fn thread_stream_window_fixture_matches_the_wire() {
        const AT: &str = "2026-07-10T10:00:00.000Z";
        let engine = migrated_engine().await;
        dispatch_all(&engine, vec![
            json!({"type":"project.create","commandId":"c01","projectId":"p1","title":"Project","workspaceRoot":"C:/repo","defaultModelSelection":null,"createdAt":AT}),
            json!({"type":"thread.create","commandId":"c02","threadId":"t1","projectId":"p1","title":"Thread","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","branch":null,"worktreePath":null,"createdAt":AT}),
        ])
        .await;
        import_turns(&engine, "t1", 100).await;
        let old = "2026-07-12T00:00:10.000Z";
        dispatch_all(&engine, vec![
            json!({"type":"thread.activity.append","commandId":"c03","threadId":"t1","activity":{"id":"ask","tone":"approval","kind":"user-input.requested","summary":"Question","payload":{"requestId":"ask-1","questions":[]},"turnId":null,"createdAt":old},"createdAt":old}),
            json!({"type":"thread.message.assistant.delta","commandId":"c04","threadId":"t1","messageId":"streaming","delta":"still ","turnId":"turn-old","createdAt":old}),
        ])
        .await;
        let cancellation = CancellationToken::new();
        let input = windowed("t1", None, None);
        let mut stream = subscribe_thread(
            &engine,
            input.clone(),
            default_thread_revision_keys(),
            &cancellation,
        );
        let snapshot = next_items(&mut stream).await.remove(0);
        dispatch_all(&engine, vec![
            json!({"type":"thread.message.assistant.delta","commandId":"c05","threadId":"t1","messageId":"streaming","delta":"going","turnId":"turn-old","createdAt":old}),
        ])
        .await;
        let patch = next_items(&mut stream).await.remove(0);
        cancellation.cancel();
        let mut pages = Vec::new();
        let mut cursor = floor_of(thread_of(&snapshot));
        while let Some(text) = cursor.as_str().map(str::to_owned) {
            let page = thread_history::history_page(
                &engine,
                serde_json::from_value(json!({ "threadId": "t1", "cursor": text })).unwrap(),
            )
            .await
            .expect("a page");
            cursor = page["cursor"].clone();
            pages.push(page);
        }
        let whole = thread_snapshot(&engine, "t1")
            .await
            .expect("the whole thread");
        dispatch_all(&engine, vec![revert("t1", "c06")]).await;
        let stale = thread_history::history_page(
            &engine,
            serde_json::from_value(
                json!({ "threadId": "t1", "cursor": floor_of(thread_of(&snapshot)) }),
            )
            .unwrap(),
        )
        .await
        .unwrap_err();
        let mut fixture = stable_ids_and_clock_times(
            json!({ "input": input, "items": [snapshot, patch], "pages": pages, "stalePage": stale, "whole": whole }),
            AT,
        );
        for item in fixture["items"].as_array_mut().unwrap() {
            item["revision"] = json!("revision");
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/fixtures/thread-stream/window.json");
        if std::env::var_os("BIBCODE_UPDATE_THREAD_STREAM_FIXTURE").is_some() {
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&fixture).unwrap() + "\n",
            )
            .unwrap();
        }
        let committed: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("committed fixture"))
                .expect("fixture JSON");
        assert_eq!(
            fixture, committed,
            "regenerate the thread stream window fixture"
        );
        assert!(fixture["pages"].as_array().unwrap().len() >= 2);
        engine.shutdown().await;
    }
}

/// Turn and full-thread patches computed live from checkpoint refs (#140).
#[cfg(test)]
mod turn_diff_tests {
    use std::path::Path;
    #[cfg(unix)]
    use std::time::Duration;

    use super::*;
    use crate::{
        orchestration::engine::EngineOptions,
        persistence::{CheckpointDiffBlob, Database, run_migrations},
        production::orchestration_effects::capture_checkpoint,
        rpc::RequestId,
    };

    const CREATED_AT: &str = "2026-10-24T00:00:00.000Z";

    async fn engine() -> OrchestrationEngine {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .expect("engine starts")
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git starts");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// A repository with a committed twenty-line file, and a project whose default thread
    /// works in it.
    async fn project_thread(engine: &OrchestrationEngine) -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().expect("repository");
        let root = std::fs::canonicalize(directory.path()).expect("canonical repository");
        git(&root, &["init", "--quiet"]);
        git(&root, &["config", "user.email", "test@bibcode.local"]);
        git(&root, &["config", "user.name", "BiBCode Test"]);
        std::fs::write(root.join("lines.txt"), twenty_lines()).expect("lines");
        std::fs::write(root.join("space.txt"), "a b\n").expect("spaced file");
        git(&root, &["add", "."]);
        git(&root, &["commit", "--quiet", "-m", "base"]);
        let command = serde_json::from_value::<OrchestrationCommand>(json!({
            "type": "project.create",
            "commandId": "project",
            "projectId": "project",
            "title": "Project",
            "workspaceRoot": root.to_string_lossy(),
            "defaultModelSelection": null,
            "createdAt": CREATED_AT,
        }))
        .expect("project command");
        engine.dispatch(command).await.expect("project created");
        let thread_id = crate::orchestration::load_snapshot(&engine.repositories())
            .await
            .expect("snapshot")
            .threads
            .into_iter()
            .find(|thread| thread.kind == "default")
            .expect("default thread")
            .thread_id;
        (directory, thread_id)
    }

    fn twenty_lines() -> String {
        (1..=20).map(|line| format!("line {line}\n")).collect()
    }

    /// Records turns `turn_counts` of `thread_id` as captured (`ready`), as the effects worker
    /// does: the diff reads serve only captured turns.
    async fn record_captured(engine: &OrchestrationEngine, thread_id: &str, turn_counts: &[i64]) {
        for &turn_count in turn_counts {
            let command = serde_json::from_value::<OrchestrationCommand>(json!({
                "type": "thread.turn.diff.complete",
                "commandId": format!("captured-{turn_count}"),
                "threadId": thread_id,
                "turnId": format!("turn-{turn_count}"),
                "checkpointTurnCount": turn_count,
                "checkpointRef": super::super::orchestration_effects::checkpoint_ref(thread_id, turn_count),
                "status": "ready",
                "files": [],
                "assistantMessageId": null,
                "completedAt": CREATED_AT,
                "createdAt": CREATED_AT,
            }))
            .expect("checkpoint command");
            engine.dispatch(command).await.expect("captured checkpoint");
        }
    }

    /// Checkpoint 0 is the committed state; checkpoint 1, captured, changes line 10 and only the
    /// spacing of `space.txt`.
    async fn two_checkpoints(engine: &OrchestrationEngine, root: &Path, thread_id: &str) {
        capture_checkpoint(root, thread_id, 0)
            .await
            .expect("checkpoint 0");
        std::fs::write(
            root.join("lines.txt"),
            twenty_lines().replace("line 10\n", "line ten\n"),
        )
        .expect("changed line");
        std::fs::write(root.join("space.txt"), "a   b\n").expect("spacing change");
        capture_checkpoint(root, thread_id, 1)
            .await
            .expect("checkpoint 1");
        record_captured(engine, thread_id, &[1]).await;
    }

    fn request(tag: &str, payload: Value) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").unwrap(),
            tag: tag.to_owned(),
            payload,
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }

    async fn turn_diff(
        engine: &OrchestrationEngine,
        availability: Option<&WorkspaceAdmissionController>,
        payload: Value,
    ) -> RpcResult {
        handle_query(
            engine,
            availability,
            request("orchestration.getTurnDiff", payload),
            CancellationToken::new(),
        )
        .await
    }

    fn root_of(directory: &tempfile::TempDir) -> std::path::PathBuf {
        std::fs::canonicalize(directory.path()).expect("canonical repository")
    }

    #[tokio::test]
    async fn turn_patches_are_live_with_full_ids_whitespace_and_context() {
        let engine = engine().await;
        let (directory, thread_id) = project_thread(&engine).await;
        let root = root_of(&directory);
        two_checkpoints(&engine, &root, &thread_id).await;

        let patch = turn_diff(
            &engine,
            None,
            json!({"threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 1}),
        )
        .await
        .expect("turn patch");
        let diff = patch["diff"].as_str().expect("diff text");
        assert!(diff.contains("+line ten"), "{diff}");
        assert!(diff.contains("space.txt"), "{diff}");
        let index_line = diff
            .lines()
            .find(|line| line.starts_with("index "))
            .expect("index line");
        let ids = index_line["index ".len()..].split(' ').next().unwrap();
        let (from, to) = ids.split_once("..").expect("two ids");
        assert!(from.len() >= 40 && to.len() >= 40, "{index_line}");
        assert_eq!(patch["truncated"], json!(false));
        assert!(patch.get("contextLines").is_none());

        let full = handle_query(
            &engine,
            None,
            request(
                "orchestration.getFullThreadDiff",
                json!({"threadId": thread_id, "toTurnCount": 1}),
            ),
            CancellationToken::new(),
        )
        .await
        .expect("full-thread patch");
        assert_eq!(full, patch);

        let ignoring = turn_diff(
            &engine,
            None,
            json!({
                "threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 1,
                "ignoreWhitespace": true,
            }),
        )
        .await
        .expect("whitespace-insensitive patch");
        assert!(!ignoring["diff"].as_str().unwrap().contains("space.txt"));

        let narrow = turn_diff(
            &engine,
            None,
            json!({
                "threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 1,
                "contextLines": 0,
            }),
        )
        .await
        .expect("zero-context patch");
        assert!(narrow["diff"].as_str().unwrap().contains("@@ -10 +10 @@"));
        assert_eq!(narrow["contextLines"], json!(0));
        let wide = turn_diff(
            &engine,
            None,
            json!({
                "threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 1,
                "contextLines": 7,
            }),
        )
        .await
        .expect("wide patch");
        assert!(wide["diff"].as_str().unwrap().contains("@@ -3,15 +3,15 @@"));
        assert_eq!(wide["contextLines"], json!(7));

        for lines in [json!(100), json!(-1)] {
            assert_eq!(
                turn_diff(
                    &engine,
                    None,
                    json!({
                        "threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 1,
                        "contextLines": lines,
                    }),
                )
                .await
                .unwrap_err()["_tag"],
                json!("InvalidRequest"),
                "{lines} context lines"
            );
        }
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn turn_patches_report_truncation_at_the_cap() {
        let engine = engine().await;
        let (directory, thread_id) = project_thread(&engine).await;
        let root = root_of(&directory);
        two_checkpoints(&engine, &root, &thread_id).await;
        let line = "x".repeat(99);
        let large = (0..(super::super::runtime::MAX_REVIEW_SOURCE_DIFF_BYTES / 100 + 1))
            .map(|_| format!("{line}\n"))
            .collect::<String>();
        std::fs::write(root.join("large.txt"), large).expect("large file");
        capture_checkpoint(&root, &thread_id, 2)
            .await
            .expect("checkpoint 2");
        record_captured(&engine, &thread_id, &[2]).await;

        let patch = turn_diff(
            &engine,
            None,
            json!({"threadId": thread_id, "fromTurnCount": 1, "toTurnCount": 2}),
        )
        .await
        .expect("capped patch");
        assert_eq!(patch["truncated"], json!(true));
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn missing_checkpoints_serve_a_stored_row_or_say_the_checkpoint_is_gone() {
        let engine = engine().await;
        let (directory, thread_id) = project_thread(&engine).await;
        two_checkpoints(&engine, &root_of(&directory), &thread_id).await;
        engine
            .repositories()
            .upsert_checkpoint_diff_blob(CheckpointDiffBlob {
                thread_id: thread_id.clone(),
                from_turn_count: 3,
                to_turn_count: 4,
                diff: "--- a/old\n+++ b/old\n@@ -1 +1 @@\n-old\n+stored\n".to_owned(),
                created_at: CREATED_AT.to_owned(),
            })
            .await
            .expect("stored row");
        // Captured turns whose refs are gone.
        record_captured(&engine, &thread_id, &[4, 5]).await;

        let stored = turn_diff(
            &engine,
            None,
            json!({
                "threadId": thread_id, "fromTurnCount": 3, "toTurnCount": 4,
                "contextLines": 7,
            }),
        )
        .await
        .expect("stored patch");
        assert!(stored["diff"].as_str().unwrap().contains("+stored"));
        assert_eq!(stored["truncated"], json!(false));
        assert!(
            stored.get("contextLines").is_none(),
            "a stored row ignores the context count"
        );

        assert_eq!(
            turn_diff(
                &engine,
                None,
                json!({"threadId": thread_id, "fromTurnCount": 1, "toTurnCount": 5}),
            )
            .await
            .unwrap_err(),
            json!({
                "_tag": "OrchestrationGetTurnDiffError",
                "message": "The checkpoint for turn 5 is no longer in the repository.",
            })
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn a_git_failure_is_an_error_not_an_empty_patch() {
        let engine = engine().await;
        let (directory, thread_id) = project_thread(&engine).await;
        let root = root_of(&directory);
        two_checkpoints(&engine, &root, &thread_id).await;
        let blob = git(&root, &["rev-parse", "HEAD:lines.txt"]);
        let reference = super::super::orchestration_effects::checkpoint_ref(&thread_id, 2);
        git(&root, &["update-ref", &reference, &blob]);
        record_captured(&engine, &thread_id, &[2]).await;

        assert_eq!(
            turn_diff(
                &engine,
                None,
                json!({"threadId": thread_id, "fromTurnCount": 1, "toTurnCount": 2}),
            )
            .await
            .unwrap_err(),
            json!({
                "_tag": "OrchestrationGetTurnDiffError",
                "message": "Git couldn't compare these checkpoints (exit 128).",
            })
        );
        engine.shutdown().await;
    }

    #[cfg(unix)]
    fn process_is_gone(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) != 0 }
    }

    /// Git reads its text conversion before it prints a file, so a converter that records
    /// Git's pid and then sleeps holds Git mid-read.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn removal_cancels_a_paused_turn_read_and_refuses_the_next() {
        let engine = engine().await;
        let (directory, thread_id) = project_thread(&engine).await;
        let root = root_of(&directory);
        two_checkpoints(&engine, &root, &thread_id).await;
        let pids = tempfile::tempdir().expect("pid directory");
        let pid_file = pids.path().join("git.pid");
        std::fs::write(root.join(".git/info/attributes"), "lines.txt diff=pause\n")
            .expect("attributes");
        git(
            &root,
            &[
                "config",
                "diff.pause.textconv",
                &format!("echo $PPID $$ > '{}'; exec sleep 20 #", pid_file.display()),
            ],
        );
        let registry = WorkspaceAvailabilityRegistry::new();
        let availability =
            WorkspaceAdmissionController::new(registry.clone(), engine.repositories());

        let reading = tokio::spawn({
            let engine = engine.clone();
            let availability = availability.clone();
            let thread_id = thread_id.clone();
            async move {
                turn_diff(
                    &engine,
                    Some(&availability),
                    json!({"threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 1}),
                )
                .await
            }
        });
        let started = std::time::Instant::now();
        let pids_text = loop {
            if let Ok(text) = std::fs::read_to_string(&pid_file)
                && text.trim().split(' ').count() == 2
            {
                break text;
            }
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "git never reached the text conversion"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let mut parsed = pids_text
            .split_whitespace()
            .map(|pid| pid.parse::<i32>().expect("pid"));
        let (git_pid, sleeper_pid) = (parsed.next().unwrap(), parsed.next().unwrap());

        let removal = registry
            .mark_removing(&thread_id, &root)
            .await
            .expect("removal begins");
        let read = tokio::time::timeout(Duration::from_secs(10), reading)
            .await
            .expect("the read stops when removal begins")
            .expect("read task joins");
        assert_eq!(
            read.unwrap_err()["_tag"],
            json!("WorkspaceUnavailableError")
        );
        let started = std::time::Instant::now();
        while !process_is_gone(git_pid) {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "git {git_pid} still runs"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // SAFETY: the converter's own process; it outlived Git by design of this fixture.
        unsafe { libc::kill(sleeper_pid, libc::SIGKILL) };

        std::fs::remove_file(&pid_file).expect("pid file");
        assert_eq!(
            turn_diff(
                &engine,
                Some(&availability),
                json!({"threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 1}),
            )
            .await
            .unwrap_err()["_tag"],
            json!("WorkspaceUnavailableError")
        );
        assert!(!pid_file.exists(), "the refused read never started Git");
        drop(removal);
        engine.shutdown().await;
    }

    /// Records turn `turn_count` of `thread_id` as the effects worker does with `status`, and
    /// with `diffAvailable: false` when `diff_available` is false.
    async fn record_turn(
        engine: &OrchestrationEngine,
        thread_id: &str,
        turn_count: i64,
        status: &str,
        diff_available: bool,
        files: Value,
    ) {
        let mut command = json!({
            "type": "thread.turn.diff.complete",
            "commandId": format!("recorded-{turn_count}"),
            "threadId": thread_id,
            "turnId": format!("turn-{turn_count}"),
            "checkpointTurnCount": turn_count,
            "checkpointRef": super::super::orchestration_effects::checkpoint_ref(thread_id, turn_count),
            "status": status,
            "files": files,
            "assistantMessageId": null,
            "completedAt": CREATED_AT,
            "createdAt": CREATED_AT,
        });
        if !diff_available {
            command["diffAvailable"] = json!(false);
        }
        engine
            .dispatch(serde_json::from_value(command).expect("checkpoint command"))
            .await
            .expect("recorded checkpoint");
    }

    /// Captures `lines.txt` with line 20 replaced by `line` as checkpoint `turn_count`.
    async fn capture_line_twenty(root: &Path, thread_id: &str, turn_count: i64, line: &str) {
        std::fs::write(
            root.join("lines.txt"),
            twenty_lines()
                .replace("line 10\n", "line ten\n")
                .replace("line 20\n", &format!("{line}\n")),
        )
        .expect("changed line");
        capture_checkpoint(root, thread_id, turn_count)
            .await
            .expect("checkpoint");
    }

    #[tokio::test]
    async fn a_one_turn_diff_without_a_baseline_is_refused_but_a_wider_range_is_served() {
        let engine = engine().await;
        let (directory, thread_id) = project_thread(&engine).await;
        let root = root_of(&directory);
        two_checkpoints(&engine, &root, &thread_id).await;
        capture_line_twenty(&root, &thread_id, 2, "line twenty").await;
        record_turn(&engine, &thread_id, 2, "ready", false, json!([])).await;

        let refused = turn_diff(
            &engine,
            None,
            json!({"threadId": thread_id, "fromTurnCount": 1, "toTurnCount": 2}),
        )
        .await
        .expect_err("a turn without a baseline has no one-turn patch");
        assert_eq!(refused["_tag"], "OrchestrationGetTurnDiffError");
        assert_eq!(
            refused["message"],
            super::super::orchestration_effects::no_baseline_diff_detail(2)
        );

        // Both ends of a wider range are end states, so it is still served.
        let wider = turn_diff(
            &engine,
            None,
            json!({"threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 2}),
        )
        .await
        .expect("a wider range");
        let diff = wider["diff"].as_str().expect("diff text");
        assert!(diff.contains("+line ten"), "{diff}");
        assert!(diff.contains("+line twenty"), "{diff}");
        let full = handle_query(
            &engine,
            None,
            request(
                "orchestration.getFullThreadDiff",
                json!({"threadId": thread_id, "toTurnCount": 2}),
            ),
            CancellationToken::new(),
        )
        .await
        .expect("full-thread patch");
        assert_eq!(full, wider);
    }

    #[tokio::test]
    async fn an_upgraded_ready_turn_after_a_missing_one_has_no_one_turn_diff() {
        let engine = engine().await;
        let (directory, thread_id) = project_thread(&engine).await;
        let root = root_of(&directory);
        two_checkpoints(&engine, &root, &thread_id).await;
        capture_line_twenty(&root, &thread_id, 2, "line two").await;
        record_turn(&engine, &thread_id, 2, "ready", true, json!([])).await;
        // Turn 3 was never captured; its ref is a leftover that old code read turn 4 against.
        capture_line_twenty(&root, &thread_id, 3, "leftover").await;
        record_turn(&engine, &thread_id, 3, "missing", true, json!([])).await;
        capture_line_twenty(&root, &thread_id, 4, "line four").await;
        record_turn(
            &engine,
            &thread_id,
            4,
            "ready",
            true,
            json!([{"path": "lines.txt", "kind": "modified", "additions": 1, "deletions": 1}]),
        )
        .await;
        // Back to the ledger a v0.14 server wrote (migration 62), then upgraded. Every later
        // migration is guarded, so the columns they added can stay; only the ledger must end at
        // 62, since pending migrations are the ones above its highest id.
        engine
            .repositories()
            .database()
            .call(|connection| {
                let has_column = connection.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('projection_turns') \
                     WHERE name = 'checkpoint_diff_available'",
                    [],
                    |row| row.get::<_, i64>(0),
                )? == 1;
                if has_column {
                    connection.execute_batch(
                        "ALTER TABLE projection_turns DROP COLUMN checkpoint_diff_available;
                         DELETE FROM effect_sql_migrations WHERE migration_id > 62;",
                    )?;
                }
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("upgraded");

        let refused = turn_diff(
            &engine,
            None,
            json!({"threadId": thread_id, "fromTurnCount": 3, "toTurnCount": 4}),
        )
        .await
        .expect_err("an upgraded turn after a missing one has no one-turn patch");
        assert_eq!(
            refused["message"],
            super::super::orchestration_effects::no_baseline_diff_detail(4)
        );
        let served = turn_diff(
            &engine,
            None,
            json!({"threadId": thread_id, "fromTurnCount": 2, "toTurnCount": 4}),
        )
        .await
        .expect("a range between two captured turns");
        assert!(
            served["diff"].as_str().unwrap().contains("+line four"),
            "{served}"
        );
        let snapshot = thread_snapshot(&engine, &thread_id)
            .await
            .expect("thread snapshot");
        let checkpoint = |turn_count: i64| {
            snapshot["thread"]["checkpoints"]
                .as_array()
                .unwrap()
                .iter()
                .find(|checkpoint| checkpoint["checkpointTurnCount"] == turn_count)
                .cloned()
                .unwrap()
        };
        assert_eq!(checkpoint(4)["diffAvailable"], false);
        assert_eq!(checkpoint(4)["files"], json!([]));
        assert!(checkpoint(2).get("diffAvailable").is_none());
    }
}
