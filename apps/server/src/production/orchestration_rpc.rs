use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use crate::{
    orchestration::{
        CommandAdmission, NewProviderTurnDelivery, OrchestrationCommand, OrchestrationEngine,
        OrchestrationError, canonical_command_digest,
        engine::{CommandLifetimeGuard, TurnDeliveryResolutionAction},
        load_snapshot,
    },
    persistence::{OrchestrationEvent, ProjectionThread},
    provider::attachments::{
        AttachmentMaterializationError, AttachmentMaterializer, PreparedAttachmentBatch,
    },
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
    server_settings::ProviderSettingsStore,
    worktree_catalog::WorkspaceAvailabilityRegistry,
};

use super::orchestration_effects::install_project_command_effects;
use super::provider_runtime::{
    ProviderRuntimeError, ProviderRuntimeSupervisor, canonical_provider_kind,
    freeze_delivery_route, route_orchestration_command,
};
use super::turn_delivery::TurnDeliveryService;
use super::workspace_availability::{WorkspaceAdmissionController, WorkspaceAdmissionError};

const STREAM_CAPACITY: usize = 16;

pub fn register_orchestration_rpc(registry: &mut RpcRegistry, engine: OrchestrationEngine) {
    register_orchestration_rpc_inner(registry, engine, None, None);
}

pub fn register_orchestration_rpc_with_availability(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    availability: WorkspaceAvailabilityRegistry,
) {
    register_orchestration_rpc_inner(registry, engine, None, Some(availability));
}

pub fn register_orchestration_rpc_with_delivery(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>,
    settings_root: PathBuf,
    turn_delivery: Arc<TurnDeliveryService>,
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
        }),
        None,
    );
}

pub fn register_orchestration_rpc_with_delivery_and_availability(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>,
    settings_root: PathBuf,
    turn_delivery: Arc<TurnDeliveryService>,
    availability: WorkspaceAvailabilityRegistry,
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
        }),
        Some(availability),
    );
}

#[derive(Clone)]
struct ProviderRegistration {
    provider: Arc<ProviderRuntimeSupervisor>,
    settings_root: PathBuf,
    attachments: AttachmentMaterializer,
    turn_delivery: Arc<TurnDeliveryService>,
}

fn register_orchestration_rpc_inner(
    registry: &mut RpcRegistry,
    engine: OrchestrationEngine,
    provider: Option<ProviderRegistration>,
    availability: Option<WorkspaceAvailabilityRegistry>,
) {
    install_project_command_effects(&engine);
    let availability = availability
        .map(|availability| WorkspaceAdmissionController::new(availability, engine.repositories()));
    let dispatch = engine.clone();
    registry.register_unary("orchestration.dispatchCommand", move |request, _| {
        let dispatch = dispatch.clone();
        let provider = provider.clone();
        let availability = availability.clone();
        async move {
            let payload_digest = canonical_command_digest(&request.payload)
                .map_err(|error| invalid_request(&request.tag, error))?;
            let command = serde_json::from_value::<OrchestrationCommand>(request.payload)
                .map_err(|error| invalid_request(&request.tag, error.to_string()))?;
            if command.is_server_internal() {
                return Err(invalid_request(
                    &request.tag,
                    "server-internal orchestration commands cannot be dispatched by clients",
                ));
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
                )
                .await;
            }
            dispatch_prepared_command(dispatch, provider, command, payload_digest, request.tag)
                .await
        }
    });

    let replay = engine.clone();
    registry.register_unary("orchestration.replayEvents", move |request, _| {
        let replay = replay.clone();
        async move {
            let input = decode::<ReplayInput>(request)?;
            replay
                .read_events(input.from_sequence_exclusive.max(0))
                .await
                .map(|events| Value::Array(events.iter().map(wire_event).collect()))
                .map_err(|error| orchestration_error("OrchestrationReplayEventsError", error))
        }
    });

    for method in [
        "orchestration.getArchivedShellSnapshot",
        "orchestration.getTurnDiff",
        "orchestration.getFullThreadDiff",
    ] {
        let engine = engine.clone();
        registry.register_unary(method, move |request, _| {
            let engine = engine.clone();
            async move { handle_query(&engine, request).await }
        });
    }

    let shell = engine.clone();
    registry.register_stream(
        "orchestration.subscribeShell",
        move |_request, cancellation| shell_stream(shell.clone(), cancellation),
    );
    registry.register_stream(
        "orchestration.subscribeThread",
        move |request, cancellation| thread_stream(engine.clone(), request, cancellation),
    );
}

async fn dispatch_prepared_command(
    dispatch: OrchestrationEngine,
    provider: Option<ProviderRegistration>,
    command: OrchestrationCommand,
    payload_digest: String,
    request_tag: String,
) -> RpcResult {
    let delivery_cancellation = match &command {
        OrchestrationCommand::ThreadTurnDeliveryResolve {
            command_id,
            thread_id,
            action: TurnDeliveryResolutionAction::Dismiss,
            created_at,
            ..
        } => Some((command_id.clone(), thread_id.clone(), created_at.clone())),
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
    #[cfg(test)]
    dispatch
        .test_hooks()
        .maybe_pause_after_command_receipt_preflight()
        .await;
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
            .reserve_generic_command_admission(&command, &payload_digest)
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?
    } else {
        false
    };
    if route_before_admission && let Some(provider) = provider.as_ref() {
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
        dispatch.dispatch(command.clone()).await
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
            .dispatch_with_admission(
                command.clone(),
                CommandAdmission {
                    payload_digest,
                    attachment_refs: Vec::new(),
                    provider_turn: None,
                },
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
                tracing::warn!(%error, "provider interrupt failed after cancelling message delivery");
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

async fn dispatch_turn_command(
    dispatch: OrchestrationEngine,
    provider: ProviderRegistration,
    command: OrchestrationCommand,
    payload_digest: String,
    request_tag: String,
    workspace_admission: Option<crate::worktree_catalog::WorkspaceAdmissionLease>,
) -> RpcResult {
    if let Some(replay) = preflight_turn_replay(
        &dispatch,
        command.clone(),
        payload_digest.clone(),
        &request_tag,
    )
    .await?
    {
        return replay;
    }

    let prepare_external = dispatch
        .reserve_generic_command_admission(&command, &payload_digest)
        .await
        .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    if !prepare_external {
        let result = dispatch
            .dispatch_with_admission(
                command,
                CommandAdmission {
                    payload_digest,
                    attachment_refs: Vec::new(),
                    provider_turn: None,
                },
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
    )
    .await;
    if result.is_err() {
        dispatch
            .release_generic_command_admission(&reserved_command, &reserved_digest)
            .await
            .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    }
    result
}

async fn dispatch_reserved_turn_command(
    dispatch: OrchestrationEngine,
    provider: ProviderRegistration,
    command: OrchestrationCommand,
    payload_digest: String,
    request_tag: String,
    workspace_admission: Option<crate::worktree_catalog::WorkspaceAdmissionLease>,
) -> RpcResult {
    let (command, prepared_batch) = prepare_attachments(&provider.attachments, command)
        .await
        .map_err(|error| invalid_request(&request_tag, error.to_string()))?;
    let attachment_refs = prepared_batch
        .as_ref()
        .map(|batch| batch.references().to_vec())
        .unwrap_or_default();
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
        let dispatch =
            dispatch.dispatch_with_admission_and_lifetime(command, admission, lifetime, on_commit);
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
            .dispatch_with_admission(command, admission, on_commit)
            .await
    }
    .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    serde_json::to_value(result).map_err(|error| invalid_request(&request_tag, error.to_string()))
}

async fn preflight_turn_replay(
    dispatch: &OrchestrationEngine,
    command: OrchestrationCommand,
    payload_digest: String,
    request_tag: &str,
) -> Result<Option<RpcResult>, Value> {
    let receipt = dispatch
        .repositories()
        .get_command_receipt(command.command_id().to_owned())
        .await
        .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
    #[cfg(test)]
    dispatch
        .test_hooks()
        .maybe_pause_after_command_receipt_preflight()
        .await;
    if let Some(receipt) = receipt {
        let aggregate = command.aggregate_ref();
        if receipt.status == "reserved"
            && receipt.payload_digest.as_deref() == Some(payload_digest.as_str())
            && receipt.aggregate_kind == aggregate.0
            && receipt.aggregate_id == aggregate.1
        {
            return Ok(None);
        }
        let result = if receipt.payload_digest.is_none() {
            dispatch.dispatch(command).await
        } else {
            dispatch
                .dispatch_with_admission(
                    command,
                    CommandAdmission {
                        payload_digest,
                        attachment_refs: Vec::new(),
                        provider_turn: None,
                    },
                    || {},
                )
                .await
        }
        .map_err(|error| orchestration_error("OrchestrationDispatchCommandError", error))?;
        return Ok(Some(
            serde_json::to_value(result)
                .map_err(|error| invalid_request(request_tag, error.to_string())),
        ));
    }
    Ok(None)
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

async fn prepare_attachments(
    attachments: &AttachmentMaterializer,
    mut command: OrchestrationCommand,
) -> Result<(OrchestrationCommand, Option<PreparedAttachmentBatch>), AttachmentMaterializationError>
{
    if let OrchestrationCommand::ThreadTurnStart { message, .. } = &mut command {
        if message.attachments.is_empty() {
            return Ok((command, None));
        }
        let prepared = attachments
            .prepare(std::mem::take(&mut message.attachments))
            .await?;
        message.attachments = prepared.attachments().to_vec();
        return Ok((command, Some(prepared)));
    }
    Ok((command, None))
}

async fn handle_query(engine: &OrchestrationEngine, request: RpcRequest) -> RpcResult {
    match request.tag.as_str() {
        "orchestration.getArchivedShellSnapshot" => shell_snapshot(engine, true).await,
        "orchestration.getTurnDiff" => {
            let input = decode::<TurnDiffInput>(request)?;
            diff(
                engine,
                input.thread_id,
                input.from_turn_count,
                input.to_turn_count,
            )
            .await
        }
        "orchestration.getFullThreadDiff" => {
            let input = decode::<FullDiffInput>(request)?;
            diff(engine, input.thread_id, 0, input.to_turn_count).await
        }
        _ => Err(invalid_request(
            &request.tag,
            "unsupported orchestration query",
        )),
    }
}

async fn diff(
    engine: &OrchestrationEngine,
    thread_id: String,
    from_turn_count: i64,
    to_turn_count: i64,
) -> RpcResult {
    if from_turn_count < 0 || to_turn_count < from_turn_count {
        return Err(invalid_request(
            "orchestration.diff",
            "turn counts must be non-negative and ordered",
        ));
    }
    let blobs = engine
        .repositories()
        .list_checkpoint_diff_blobs_by_thread(thread_id.clone())
        .await
        .map_err(|error| orchestration_error("OrchestrationGetTurnDiffError", error))?;
    let diff = blobs
        .into_iter()
        .find(|blob| blob.from_turn_count == from_turn_count && blob.to_turn_count == to_turn_count)
        .map(|blob| blob.diff)
        .unwrap_or_default();
    Ok(json!({
        "threadId": thread_id,
        "fromTurnCount": from_turn_count,
        "toTurnCount": to_turn_count,
        "diff": diff,
    }))
}

fn shell_stream(
    engine: OrchestrationEngine,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    tokio::spawn(async move {
        if send_snapshot(&sender, shell_snapshot(&engine, false).await)
            .await
            .is_err()
        {
            return;
        }
        let mut events = engine.subscribe_events();
        loop {
            tokio::select! {
                () = cancellation.cancelled() => return,
                event = events.recv() => match event {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        if send_snapshot(&sender, shell_snapshot(&engine, false).await).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
    receiver
}

fn thread_stream(
    engine: OrchestrationEngine,
    request: RpcRequest,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    tokio::spawn(async move {
        let input = match decode::<SubscribeThreadInput>(request) {
            Ok(input) => input,
            Err(error) => {
                let _ = sender.send(Err(error)).await;
                return;
            }
        };
        if send_snapshot(&sender, thread_snapshot(&engine, &input.thread_id).await)
            .await
            .is_err()
        {
            return;
        }
        let mut events = engine.subscribe_events();
        loop {
            tokio::select! {
                () = cancellation.cancelled() => return,
                event = events.recv() => match event {
                    Ok(event) if event.event.aggregate_kind == "thread" && event.event.aggregate_id == input.thread_id => {
                        if send_snapshot(&sender, thread_snapshot(&engine, &input.thread_id).await).await.is_err() {
                            return;
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });
    receiver
}

async fn send_snapshot(
    sender: &mpsc::Sender<RpcStreamChunk>,
    snapshot: RpcResult,
) -> Result<(), ()> {
    sender
        .send(snapshot.map(|snapshot| vec![json!({ "kind": "snapshot", "snapshot": snapshot })]))
        .await
        .map_err(|_| ())
}

pub async fn shell_snapshot(engine: &OrchestrationEngine, archived: bool) -> RpcResult {
    let snapshot = load_snapshot(&engine.repositories())
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
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
        .map(|project| {
            json!({
                "id": project.project_id,
                "title": project.title,
                "workspaceRoot": project.workspace_root,
                "defaultModelSelection": project.default_model_selection,
                "scripts": project.scripts,
                "worktreeDiscovery": project.worktree_discovery,
                "createdAt": project.created_at,
                "updatedAt": project.updated_at,
            })
        })
        .collect::<Vec<_>>();
    let threads = snapshot
        .threads
        .iter()
        .filter(|thread| thread.deleted_at.is_none() && (thread.archived_at.is_some()) == archived)
        .map(|thread| thread_shell(thread, &snapshot))
        .collect::<Vec<_>>();
    Ok(json!({
        "snapshotSequence": sequence,
        "projects": projects,
        "threads": threads,
        "updatedAt": now_iso(),
    }))
}

async fn thread_snapshot(engine: &OrchestrationEngine, thread_id: &str) -> RpcResult {
    let snapshot = load_snapshot(&engine.repositories())
        .await
        .map_err(|error| orchestration_error("OrchestrationGetSnapshotError", error))?;
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
    let mut detail = thread_shell(thread, &snapshot);
    let object = detail.as_object_mut().expect("thread shell is an object");
    object.insert("deletedAt".to_owned(), json!(thread.deleted_at));
    object.insert(
        "messages".to_owned(),
        Value::Array(
            snapshot
                .messages
                .iter()
                .filter(|row| row.thread_id == thread_id)
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
                        if let Some(detail) = &row.delivery_detail {
                            delivery["detail"] = json!(detail);
                        }
                        message["delivery"] = delivery;
                    }
                    message
                })
                .collect(),
        ),
    );
    object.insert(
        "activities".to_owned(),
        Value::Array(
            snapshot
                .activities
                .iter()
                .filter(|row| row.thread_id == thread_id)
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
            snapshot
                .proposed_plans
                .iter()
                .filter(|row| row.thread_id == thread_id)
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
            snapshot
                .checkpoints
                .iter()
                .filter(|row| row.thread_id == thread_id)
                .map(|row| {
                    json!({
                        "turnId": row.turn_id,
                        "checkpointTurnCount": row.checkpoint_turn_count,
                        "checkpointRef": row.checkpoint_ref,
                        "status": row.status,
                        "files": row.files,
                        "assistantMessageId": row.assistant_message_id,
                        "completedAt": row.completed_at,
                    })
                })
                .collect(),
        ),
    );
    Ok(json!({ "snapshotSequence": sequence, "thread": detail }))
}

fn thread_activity_tone(tone: &str) -> &str {
    match tone {
        "info" | "tool" | "approval" | "error" => tone,
        _ => "info",
    }
}

fn thread_shell(thread: &ProjectionThread, snapshot: &crate::orchestration::Snapshot) -> Value {
    let latest_turn = thread.latest_turn_id.as_ref().and_then(|latest_id| {
        snapshot
            .turns
            .iter()
            .find(|turn| turn.thread_id == thread.thread_id && turn.turn_id.as_ref() == Some(latest_id))
            .map(|turn| json!({
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
    });
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.thread_id == thread.thread_id)
        .map(|session| {
            json!({
                "threadId": session.thread_id,
                "status": session.status,
                "providerName": session.provider_name,
                "providerInstanceId": session.provider_instance_id,
                "runtimeMode": session.runtime_mode,
                "activeTurnId": session.active_turn_id,
                "lastError": session.last_error,
                "updatedAt": session.updated_at,
            })
        });
    json!({
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
    })
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeThreadInput {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnDiffInput {
    thread_id: String,
    from_turn_count: i64,
    to_turn_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullDiffInput {
    thread_id: String,
    to_turn_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RequestId, RpcExit, ServerConfig, ServerMessage, ServerRuntime,
        activity::{ActivityProjection, ActivityRepository},
        orchestration::{
            AttachmentReference, NewProviderTurnDelivery, TurnDeliveryState,
            TurnDeliveryTransition,
            engine::{EngineOptions, TestHooks},
        },
        persistence::{Database, run_migrations},
        production::{
            provider_runtime::{
                BoxRuntimeFuture, ProviderDriver, ProviderDriverFactory, ProviderEvent,
                ProviderLaunchRequest, ProviderRuntimeError, StartedSession, SupervisorOptions,
            },
            turn_delivery::DeliveryRouter,
        },
        worktree_catalog::{
            AdoptedWorktreeAvailability, WorkspaceAvailabilityRegistry, WorkspaceLossTransition,
        },
    };
    use futures_util::{SinkExt, StreamExt};
    use std::sync::atomic::AtomicUsize;
    use tokio_tungstenite::tungstenite::Message;

    const CREATED_AT: &str = "2026-07-11T00:00:00.000Z";

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
        fail_set_model_calls: AtomicUsize,
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
            let fail = self
                .fail_set_model_calls
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok();
            Box::pin(async move {
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
            "createdAt": CREATED_AT,
        }));
        engine
            .dispatch_with_admission(
                command.clone(),
                CommandAdmission {
                    payload_digest: canonical_command_digest(&command).expect("command digest"),
                    attachment_refs: Vec::<AttachmentReference>::new(),
                    provider_turn: Some(NewProviderTurnDelivery {
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
        if state != TurnDeliveryState::Pending {
            assert!(
                engine
                    .transition_turn_delivery(TurnDeliveryTransition {
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
        dispatch_prepared_command(
            engine.clone(),
            provider,
            command,
            payload_digest,
            "orchestration.dispatchCommand".to_owned(),
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
            },
            provider,
        )
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
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), socket.next())
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

        let replay = dispatch_turn_command(
            engine.clone(),
            registration.clone(),
            accepted,
            "ignored legacy digest".to_owned(),
            "orchestration.dispatchCommand".to_owned(),
            None,
        )
        .await
        .expect("legacy accepted turn replays its stored result");
        assert_eq!(
            replay,
            serde_json::to_value(original).expect("original result")
        );
        let rejection = dispatch_turn_command(
            engine.clone(),
            registration,
            rejected,
            "different ignored legacy digest".to_owned(),
            "orchestration.dispatchCommand".to_owned(),
            None,
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
        let pause = hooks.pause_after_next_command_receipt_preflight();
        let dispatch_engine = engine.clone();
        let dispatch = tokio::spawn(async move {
            dispatch_turn_command(
                dispatch_engine,
                registration,
                command,
                payload_digest,
                "orchestration.dispatchCommand".to_owned(),
                None,
            )
            .await
        });
        pause.wait_until_entered().await;
        engine
            .reserve_worktree_removal_admission(
                "attachment-admission-race",
                "removal-project",
                "removal-payload",
            )
            .await
            .expect("removal reserves the absent turn identity");
        pause.release();

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
                service_tier: None,
                effort: None,
                agent: None,
                resume_cursor: None,
                environment: Default::default(),
                endpoint: None,
                server_password: None,
                mcp: None,
                codex_home: None,
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
        };
        let command = decode_command(json!({
            "type":"thread.meta.update",
            "commandId":"provider-race-command",
            "threadId":"provider-race-thread",
            "modelSelection":{"instanceId":"codex","model":"gpt-5.1"}
        }));
        let pause = hooks.pause_after_next_command_receipt_preflight();
        let generic_engine = engine.clone();
        let racing_registration = registration.clone();
        let generic = tokio::spawn(async move {
            dispatch_prepared_for_test(&generic_engine, Some(racing_registration), command).await
        });
        pause.wait_until_entered().await;
        let reserved = engine
            .reserve_worktree_removal_admission(
                "provider-race-command",
                "provider-race-project",
                "removal-payload",
            )
            .await
            .expect("removal reserves the absent command identity");
        assert!(reserved.0.is_none());
        pause.release();

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
        dispatch_prepared_for_test(&engine, Some(registration), changed)
            .await
            .expect_err("changed payload conflicts before provider mutation");
        assert_eq!(
            probe.set_model_calls.load(Ordering::SeqCst),
            calls_after_retry
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
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
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
                frame = socket.next() => panic!("turn exited before persistence: {frame:?}"),
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
        let interrupted = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
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
        assert!(availability.mark_unavailable(loss.clone()).await);
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
            .await;
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
                .await;
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
            .await;
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
        assert!(availability.mark_unavailable(rejected_loss.clone()).await);
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
            .await;
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
        let (command, prepared) = prepare_attachments(&attachments, command)
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
        )
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

        assert!(
            handle_query(&engine, request("orchestration.unknown", json!({})))
                .await
                .is_err()
        );
        assert!(
            handle_query(
                &engine,
                request("orchestration.getTurnDiff", json!({"threadId":"t1"})),
            )
            .await
            .is_err()
        );
        assert!(
            diff(&engine, "t1".to_owned(), 2, 1).await.is_err(),
            "reversed turn bounds must fail"
        );
        assert_eq!(
            handle_query(
                &engine,
                request(
                    "orchestration.getFullThreadDiff",
                    json!({"threadId":"t1","toTurnCount":0}),
                ),
            )
            .await
            .unwrap()["diff"],
            json!("")
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
        assert!(send_snapshot(&sender, Ok(json!({}))).await.is_err());
        engine.shutdown().await;
    }
}
