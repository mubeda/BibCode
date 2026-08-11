use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use crate::{
    auth::{ACTIVITY_READ_SCOPE, authorization_error},
    rpc::{
        RpcRegistry, RpcRequest, RpcResponseEnqueueGuard, RpcSessionContext, RpcStreamChunk,
        RpcUnaryResult, ServerMessage,
    },
};

use super::{
    ACTIVITY_ID_MAX_LENGTH, ACTIVITY_PAGE_MAX_LENGTH, ActivityAdmittedRead,
    ActivityCancellationDispatcher, ActivityCancellationError, ActivityCancellationService,
    ActivityControlEvent, ActivityControlRegistry, ActivityDispatchError, ActivityError,
    ActivityProjection, ActivityProjectionEvent, ActivityProjections, ActivityRecordKind,
    ActivityRepositoryError, ActivityResult, ActivityRosterBucket, ActivityRuntimeGeneration,
    ActivityScopeRef, ActivitySection, ActivitySubtreeCancellationDisposition,
    ActivitySubtreeCancellationResult, ActivityTargetDispatchDisposition, AgentActivityAdmission,
    AgentActivityController, ProviderActivityNativeTarget,
};

const DEFAULT_PAGE_LIMIT: usize = 50;
const STREAM_BUFFER_CAPACITY: usize = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListRosterInput {
    scope: ActivityScopeRef,
    scope_id: String,
    section: ActivitySection,
    bucket: ActivityRosterBucket,
    cursor: Option<String>,
    #[serde(default = "default_page_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListDetailInput {
    scope: ActivityScopeRef,
    scope_id: String,
    record_kind: ActivityRecordKind,
    record_id: String,
    cursor: Option<String>,
    #[serde(default = "default_page_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CancelSubtreeInput {
    scope: MutationThreadScopeInput,
    scope_id: String,
    actor_id: String,
    expected_control_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RetrySubtreeCancellationInput {
    scope: MutationThreadScopeInput,
    scope_id: String,
    root_actor_id: String,
    expected_operation_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MutationThreadScopeInput {
    #[serde(rename = "_tag")]
    _tag: MutationThreadScopeTag,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
enum MutationThreadScopeTag {
    #[serde(rename = "thread")]
    Thread,
}

struct ActivityUnaryResponseGuard {
    controller: AgentActivityController,
    admission: AgentActivityAdmission,
}

impl RpcResponseEnqueueGuard for ActivityUnaryResponseGuard {
    fn enqueue(self: Box<Self>, permit: mpsc::OwnedPermit<ServerMessage>, response: ServerMessage) {
        let request_id = response
            .request_id()
            .cloned()
            .expect("guarded unary response has a request id");
        let mut pending = Some((permit, response));
        if !self.controller.publish_if_current(&self.admission, || {
            let (permit, response) = pending.take().expect("guarded response is pending");
            permit.send(response);
        }) {
            let (permit, _) = pending.expect("stale guarded response is pending");
            permit.send(ServerMessage::failure(request_id, feature_disabled_error()));
        }
    }
}

const fn default_page_limit() -> usize {
    DEFAULT_PAGE_LIMIT
}

pub(crate) fn register_activity_rpc(
    registry: &mut RpcRegistry,
    projections: ActivityProjections,
    cancellation: ActivityCancellationService,
) {
    let snapshot_projections = projections.clone();
    registry.register_guarded_unary("activity.getSnapshot", move |request, _cancellation| {
        let projections = snapshot_projections.clone();
        async move {
            let scope = match decode::<ActivityScopeRef>(request.payload) {
                Ok(scope) => scope,
                Err(error) => return RpcUnaryResult::plain(Err(error)),
            };
            let projection = projections.for_scope(&scope);
            encode_admitted_read(projection.snapshot_admitted(&scope).await)
        }
    });

    let roster_projections = projections.clone();
    registry.register_guarded_unary("activity.listRoster", move |request, _cancellation| {
        let projections = roster_projections.clone();
        async move {
            let input = match decode::<ListRosterInput>(request.payload) {
                Ok(input) => input,
                Err(error) => return RpcUnaryResult::plain(Err(error)),
            };
            let projection = projections.for_scope(&input.scope);
            if let Err(error) = validate_limit(input.limit) {
                return RpcUnaryResult::plain(Err(error));
            }
            encode_admitted_read(
                projection
                    .list_roster_admitted(
                        &input.scope,
                        &input.scope_id,
                        input.section,
                        input.bucket,
                        input.cursor.as_deref(),
                        input.limit,
                    )
                    .await,
            )
        }
    });

    let detail_projections = projections.clone();
    registry.register_guarded_unary("activity.listDetail", move |request, _cancellation| {
        let projections = detail_projections.clone();
        async move {
            let input = match decode::<ListDetailInput>(request.payload) {
                Ok(input) => input,
                Err(error) => return RpcUnaryResult::plain(Err(error)),
            };
            let projection = projections.for_scope(&input.scope);
            if let Err(error) = validate_limit(input.limit) {
                return RpcUnaryResult::plain(Err(error));
            }
            encode_admitted_read(
                projection
                    .list_detail_admitted(
                        &input.scope,
                        &input.scope_id,
                        input.record_kind,
                        &input.record_id,
                        input.cursor.as_deref(),
                        input.limit,
                    )
                    .await,
            )
        }
    });

    let cancel_projections = projections.clone();
    let cancel_service = cancellation.clone();
    registry.register_guarded_unary("activity.cancelSubtree", move |request, _cancellation| {
        let projections = cancel_projections.clone();
        let cancellation = cancel_service.clone();
        async move {
            let input = match decode::<CancelSubtreeInput>(request.payload) {
                Ok(input) => input,
                Err(error) => return RpcUnaryResult::plain(Err(error)),
            };
            let (scope, scope_id, actor_id, expected_control_revision) =
                match validate_cancel_subtree_input(input) {
                    Ok(input) => input,
                    Err(error) => return RpcUnaryResult::plain(Err(error)),
                };
            let controller = projections.chat().agent_activity_controller();
            let Some(admission) = controller.admit() else {
                return RpcUnaryResult::plain(Err(feature_disabled_error()));
            };
            let result = cancellation
                .cancel_subtree(scope, &scope_id, &actor_id, expected_control_revision)
                .await
                .map(cancellation_result)
                .map_err(cancellation_error);
            guarded_control_result(result, controller, admission)
        }
    });

    let retry_projections = projections.clone();
    registry.register_guarded_unary(
        "activity.retrySubtreeCancellation",
        move |request, _cancellation| {
            let projections = retry_projections.clone();
            let cancellation = cancellation.clone();
            async move {
                let input = match decode::<RetrySubtreeCancellationInput>(request.payload) {
                    Ok(input) => input,
                    Err(error) => return RpcUnaryResult::plain(Err(error)),
                };
                let (scope, scope_id, root_actor_id, expected_operation_revision) =
                    match validate_retry_subtree_cancellation_input(input) {
                        Ok(input) => input,
                        Err(error) => return RpcUnaryResult::plain(Err(error)),
                    };
                let controller = projections.chat().agent_activity_controller();
                let Some(admission) = controller.admit() else {
                    return RpcUnaryResult::plain(Err(feature_disabled_error()));
                };
                let result = cancellation
                    .retry_subtree_cancellation(
                        scope,
                        &scope_id,
                        &root_actor_id,
                        expected_operation_revision,
                    )
                    .await
                    .map(cancellation_result)
                    .map_err(cancellation_error);
                guarded_control_result(result, controller, admission)
            }
        },
    );

    registry.register_stream_with_context(
        "subscribeActivity",
        move |request, context, cancellation| {
            activity_stream(projections.clone(), request, context, cancellation)
        },
    );
}

fn guarded_control_result(
    result: Result<Value, Value>,
    controller: AgentActivityController,
    admission: AgentActivityAdmission,
) -> RpcUnaryResult {
    RpcUnaryResult::guarded(
        result,
        ActivityUnaryResponseGuard {
            controller,
            admission,
        },
    )
}

fn cancellation_result(result: ActivitySubtreeCancellationResult) -> Value {
    let disposition = match result.disposition {
        ActivitySubtreeCancellationDisposition::Accepted => "accepted",
        ActivitySubtreeCancellationDisposition::InProgress => "inProgress",
        ActivitySubtreeCancellationDisposition::AlreadyTerminal => "alreadyTerminal",
    };
    json!({
        "disposition": disposition,
        "rootActorId": result.root_actor_id,
        "operationRevision": result.operation_revision,
    })
}

fn cancellation_error(error: ActivityCancellationError) -> Value {
    match error {
        ActivityCancellationError::NotFound => json!({
            "_tag": "ActivityError",
            "message": "The requested activity actor was not found.",
            "reason": "notFound",
        }),
        ActivityCancellationError::InvalidScope => invalid_scope_error(),
        ActivityCancellationError::StaleScope => json!({
            "_tag": "ActivityError",
            "message": "The activity scope has changed. Refresh and try again.",
            "reason": "staleScope",
        }),
        ActivityCancellationError::StaleActor => json!({
            "_tag": "ActivityError",
            "message": "The activity actor has changed. Refresh and try again.",
            "reason": "staleActor",
        }),
        ActivityCancellationError::StaleOperation => json!({
            "_tag": "ActivityError",
            "message": "The cancellation operation has changed. Refresh and try again.",
            "reason": "staleOperation",
        }),
        ActivityCancellationError::TargetUnavailable => json!({
            "_tag": "ActivityError",
            "message": "The provider cancellation target is no longer available.",
            "reason": "targetUnavailable",
        }),
        ActivityCancellationError::CapacityExceeded => internal_error(),
    }
}

fn validate_cancel_subtree_input(
    input: CancelSubtreeInput,
) -> Result<(ActivityScopeRef, String, String, u64), Value> {
    Ok((
        validate_mutation_thread_scope(input.scope)?,
        validate_mutation_id(input.scope_id)?,
        validate_mutation_id(input.actor_id)?,
        input.expected_control_revision,
    ))
}

fn validate_retry_subtree_cancellation_input(
    input: RetrySubtreeCancellationInput,
) -> Result<(ActivityScopeRef, String, String, u64), Value> {
    Ok((
        validate_mutation_thread_scope(input.scope)?,
        validate_mutation_id(input.scope_id)?,
        validate_mutation_id(input.root_actor_id)?,
        input.expected_operation_revision,
    ))
}

fn validate_mutation_thread_scope(
    input: MutationThreadScopeInput,
) -> Result<ActivityScopeRef, Value> {
    Ok(ActivityScopeRef::Thread {
        thread_id: validate_mutation_id(input.thread_id)?,
    })
}

fn validate_mutation_id(value: String) -> Result<String, Value> {
    let value = value.trim().to_owned();
    if value.is_empty()
        || value.encode_utf16().count() > ACTIVITY_ID_MAX_LENGTH
        || value.chars().any(char::is_control)
    {
        Err(invalid_scope_error())
    } else {
        Ok(value)
    }
}

#[doc(hidden)]
pub fn register_activity_rpc_for_integration_test(
    registry: &mut RpcRegistry,
    projections: ActivityProjections,
) {
    let cancellation = ActivityCancellationService::new(
        projections.chat().activity_control_registry(),
        Arc::new(UnavailableCancellationDispatcher),
    );
    register_activity_rpc(registry, projections, cancellation);
}

struct UnavailableCancellationDispatcher;

impl ActivityCancellationDispatcher for UnavailableCancellationDispatcher {
    fn cancel_target(
        &self,
        _scope: ActivityScopeRef,
        _generation: ActivityRuntimeGeneration,
        _target: ProviderActivityNativeTarget,
    ) -> BoxFuture<'static, Result<ActivityTargetDispatchDisposition, ActivityDispatchError>> {
        Box::pin(async { Err(ActivityDispatchError::ProviderUnavailable) })
    }
}

fn encode_admitted_read<T: serde::Serialize>(
    admitted: ActivityResult<ActivityAdmittedRead<T>>,
) -> RpcUnaryResult {
    match admitted {
        Ok(admitted) => {
            let (result, controller, admission) = admitted.into_parts();
            RpcUnaryResult::guarded(
                result.map_err(activity_error).and_then(encode),
                ActivityUnaryResponseGuard {
                    controller,
                    admission,
                },
            )
        }
        Err(error) => RpcUnaryResult::plain(Err(activity_error(error))),
    }
}

fn activity_stream(
    projections: ActivityProjections,
    request: RpcRequest,
    context: RpcSessionContext,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_BUFFER_CAPACITY);
    tokio::spawn(async move {
        let scope = match decode::<ActivityScopeRef>(request.payload) {
            Ok(scope) => scope,
            Err(error) => {
                let _ = send(&sender, Err(error), &cancellation).await;
                return;
            }
        };
        let projection = projections.for_scope(&scope);
        let controller = projection.agent_activity_controller();
        if !authorize_activity_read(&context, &sender, &cancellation).await {
            return;
        }
        let mut controller_states = controller.subscribe();
        let Some(_registration) = controller.register_stream() else {
            let _ = send(&sender, Err(feature_disabled_error()), &cancellation).await;
            return;
        };
        let control_registry = projection.activity_control_registry();
        let mut control_deltas = control_registry.subscribe();
        let mut deltas = projection.subscribe();
        let snapshot = tokio::select! {
            biased;
            () = cancellation.cancelled() => return,
            changed = controller_states.changed() => {
                match changed {
                    Ok(()) if !controller_states.borrow_and_update().enabled => {
                        let _ = send(&sender, Err(feature_disabled_error()), &cancellation).await;
                    }
                    Ok(()) | Err(_) => {}
                }
                return;
            }
            snapshot = projection.snapshot(&scope) => snapshot,
        };
        let snapshot = match snapshot {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let _ = send(&sender, Err(activity_error(error)), &cancellation).await;
                return;
            }
        };
        let mut scope_id = snapshot.scope_id.clone();
        let mut streamed_revision = snapshot.revision;
        let mut streamed_control_revision = snapshot.control.revision;
        if !send(
            &sender,
            Ok(vec![json!({ "kind": "snapshot", "snapshot": snapshot })]),
            &cancellation,
        )
        .await
        {
            return;
        }

        loop {
            let received = tokio::select! {
                biased;
                () = cancellation.cancelled() => return,
                changed = controller_states.changed() => {
                    match changed {
                        Ok(()) if !controller_states.borrow_and_update().enabled => {
                            let _ = send(&sender, Err(feature_disabled_error()), &cancellation).await;
                        }
                        Ok(()) | Err(_) => {}
                    }
                    return;
                }
                received = async {
                    tokio::select! {
                        received = deltas.recv() => StreamEvent::Observation(received),
                        received = control_deltas.recv() => StreamEvent::Control(received),
                    }
                } => received,
            };
            match received {
                StreamEvent::Observation(Ok(ActivityProjectionEvent::Delta(delta)))
                    if delta.scope_id != scope_id || delta.revision <= streamed_revision => {}
                StreamEvent::Observation(Ok(ActivityProjectionEvent::Delta(delta)))
                    if delta.previous_revision == streamed_revision =>
                {
                    let revision = delta.revision;
                    if !send(
                        &sender,
                        Ok(vec![json!({ "kind": "delta", "delta": delta })]),
                        &cancellation,
                    )
                    .await
                    {
                        return;
                    }
                    streamed_revision = revision;
                }
                StreamEvent::Observation(Ok(ActivityProjectionEvent::Delta(_))) => {
                    let Some((fresh_scope_id, revision, control_revision)) =
                        send_fresh_snapshot(&projection, &scope, &context, &sender, &cancellation)
                            .await
                    else {
                        return;
                    };
                    scope_id = fresh_scope_id;
                    streamed_revision = revision;
                    streamed_control_revision = control_revision;
                }
                StreamEvent::Observation(Ok(ActivityProjectionEvent::ScopeReplaced {
                    scope: replaced_scope,
                    scope_id: replacement_scope_id,
                })) if replaced_scope != scope || replacement_scope_id == scope_id => {}
                StreamEvent::Observation(Ok(ActivityProjectionEvent::ScopeReplaced { .. })) => {
                    let Some((fresh_scope_id, revision, control_revision)) =
                        send_fresh_snapshot(&projection, &scope, &context, &sender, &cancellation)
                            .await
                    else {
                        return;
                    };
                    scope_id = fresh_scope_id;
                    streamed_revision = revision;
                    streamed_control_revision = control_revision;
                }
                StreamEvent::Observation(Err(broadcast::error::RecvError::Lagged(_))) => {
                    let Some((fresh_scope_id, revision, control_revision)) =
                        send_fresh_snapshot(&projection, &scope, &context, &sender, &cancellation)
                            .await
                    else {
                        return;
                    };
                    scope_id = fresh_scope_id;
                    streamed_revision = revision;
                    streamed_control_revision = control_revision;
                }
                StreamEvent::Observation(Err(broadcast::error::RecvError::Closed)) => return,
                StreamEvent::Control(Ok(ActivityControlEvent::Delta(delta)))
                    if delta.scope_id != scope_id
                        || delta.revision <= streamed_control_revision => {}
                StreamEvent::Control(Ok(ActivityControlEvent::Delta(delta)))
                    if delta.previous_revision == streamed_control_revision =>
                {
                    let revision = delta.revision;
                    if !send(
                        &sender,
                        Ok(vec![json!({ "kind": "control-delta", "delta": delta })]),
                        &cancellation,
                    )
                    .await
                    {
                        return;
                    }
                    streamed_control_revision = revision;
                }
                StreamEvent::Control(Ok(ActivityControlEvent::Delta(_)))
                | StreamEvent::Control(Err(broadcast::error::RecvError::Lagged(_))) => {
                    let Some(revision) = send_fresh_control_snapshot(
                        &control_registry,
                        &scope_id,
                        &context,
                        &sender,
                        &cancellation,
                    )
                    .await
                    else {
                        return;
                    };
                    streamed_control_revision = revision;
                }
                StreamEvent::Control(Err(broadcast::error::RecvError::Closed)) => return,
            }
        }
    });
    receiver
}

async fn send_fresh_snapshot(
    projection: &ActivityProjection,
    scope: &ActivityScopeRef,
    context: &RpcSessionContext,
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
) -> Option<(String, u64, u64)> {
    if !authorize_activity_read(context, sender, cancellation).await {
        return None;
    }
    let snapshot = tokio::select! {
        biased;
        () = cancellation.cancelled() => return None,
        snapshot = projection.snapshot(scope) => snapshot,
    };
    let snapshot = match snapshot {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let _ = send(sender, Err(activity_error(error)), cancellation).await;
            return None;
        }
    };
    let result = (
        snapshot.scope_id.clone(),
        snapshot.revision,
        snapshot.control.revision,
    );
    send(
        sender,
        Ok(vec![json!({ "kind": "snapshot", "snapshot": snapshot })]),
        cancellation,
    )
    .await
    .then_some(result)
}

enum StreamEvent {
    Observation(Result<ActivityProjectionEvent, broadcast::error::RecvError>),
    Control(Result<ActivityControlEvent, broadcast::error::RecvError>),
}

async fn send_fresh_control_snapshot(
    registry: &ActivityControlRegistry,
    scope_id: &str,
    context: &RpcSessionContext,
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
) -> Option<u64> {
    if !authorize_activity_read(context, sender, cancellation).await {
        return None;
    }
    let control = registry.snapshot(scope_id).await;
    if control.scope_id != scope_id {
        let _ = send(sender, Err(internal_error()), cancellation).await;
        return None;
    }
    let revision = control.revision;
    send(
        sender,
        Ok(vec![
            json!({ "kind": "control-snapshot", "control": control }),
        ]),
        cancellation,
    )
    .await
    .then_some(revision)
}

async fn authorize_activity_read(
    context: &RpcSessionContext,
    sender: &mpsc::Sender<RpcStreamChunk>,
    cancellation: &CancellationToken,
) -> bool {
    if context.is_currently_authorized(ACTIVITY_READ_SCOPE).await {
        true
    } else {
        let _ = send(
            sender,
            Err(authorization_error(ACTIVITY_READ_SCOPE)),
            cancellation,
        )
        .await;
        false
    }
}

async fn send(
    sender: &mpsc::Sender<RpcStreamChunk>,
    item: RpcStreamChunk,
    cancellation: &CancellationToken,
) -> bool {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => false,
        result = sender.send(item) => result.is_ok(),
    }
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(|_| invalid_scope_error())
}

fn encode<T: serde::Serialize>(value: T) -> Result<Value, Value> {
    serde_json::to_value(value).map_err(|_| internal_error())
}

fn validate_limit(limit: usize) -> Result<(), Value> {
    if (1..=ACTIVITY_PAGE_MAX_LENGTH).contains(&limit) {
        Ok(())
    } else {
        Err(invalid_scope_error())
    }
}

fn activity_error(error: ActivityError) -> Value {
    match error {
        ActivityRepositoryError::NotFound => json!({
            "_tag": "ActivityError",
            "message": "The activity scope was not found.",
            "reason": "notFound",
        }),
        ActivityRepositoryError::InvalidCursor => json!({
            "_tag": "ActivityError",
            "message": "The activity cursor is invalid.",
            "reason": "invalidCursor",
        }),
        ActivityRepositoryError::InvalidScope(_)
        | ActivityRepositoryError::InvalidModel(_)
        | ActivityRepositoryError::EmptyBatch
        | ActivityRepositoryError::TooManyMutations
        | ActivityRepositoryError::InvalidReference(_)
        | ActivityRepositoryError::InvalidCapabilities(_)
        | ActivityRepositoryError::InvalidLimit => invalid_scope_error(),
        ActivityRepositoryError::FeatureDisabled => feature_disabled_error(),
        ActivityRepositoryError::Persistence(_) | ActivityRepositoryError::Serialization(_) => {
            internal_error()
        }
    }
}

fn feature_disabled_error() -> Value {
    json!({
        "_tag": "ActivityError",
        "message": "Agent activity is disabled for this environment.",
        "reason": "featureDisabled",
    })
}

fn invalid_scope_error() -> Value {
    json!({
        "_tag": "ActivityError",
        "message": "The requested activity scope is invalid.",
        "reason": "invalidScope",
    })
}

fn internal_error() -> Value {
    json!({
        "_tag": "ActivityError",
        "message": "The activity service is temporarily unavailable.",
        "reason": "internal",
    })
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use crate::{
        ServerConfig, ServerRuntime,
        activity::{
            ACTIVITY_ID_MAX_LENGTH, ActivityCancellationDispatcher, ActivityCancellationService,
            ActivityCapabilities, ActivityControlChange, ActivityControlDelta,
            ActivityDispatchError, ActivityRepository, ActivityRuntimeGeneration,
            ActivityScopeSeed, ActivityTargetDispatchDisposition, ProviderActivityControlUpdate,
            ProviderActivityMutation, ProviderActivityNativeTarget,
        },
        auth::{AuthService, ClientMetadata},
        persistence::{Database, run_migrations},
        rpc::RequestId,
    };
    use futures_util::{SinkExt, StreamExt, future::BoxFuture};
    use tokio_tungstenite::{WebSocketStream, connect_async, tungstenite::Message};

    use super::*;

    #[derive(Clone, Default)]
    struct CountingDispatcher {
        calls: Arc<AtomicUsize>,
    }

    impl ActivityCancellationDispatcher for CountingDispatcher {
        fn cancel_target(
            &self,
            _scope: ActivityScopeRef,
            _generation: ActivityRuntimeGeneration,
            _target: ProviderActivityNativeTarget,
        ) -> BoxFuture<'static, Result<ActivityTargetDispatchDisposition, ActivityDispatchError>>
        {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(ActivityTargetDispatchDisposition::Delivered) })
        }
    }

    #[tokio::test]
    async fn mutation_rpc_rejects_non_thread_excess_and_unbounded_inputs_before_dispatch() {
        let database = Database::open_in_memory().await.expect("database");
        let projections = ActivityProjections::new(
            ActivityRepository::new(database),
            AgentActivityController::new(true),
            AgentActivityController::new(true),
        );
        let dispatcher = CountingDispatcher::default();
        let cancellation_service = ActivityCancellationService::new(
            projections.chat().activity_control_registry(),
            Arc::new(dispatcher.clone()),
        );
        let mut registry = RpcRegistry::empty();
        register_activity_rpc(&mut registry, projections, cancellation_service);
        let directory = tempfile::tempdir().expect("temporary server directory");
        let handle = ServerRuntime::start_with_registry(
            ServerConfig::new(directory.path())
                .with_bind("127.0.0.1", 0)
                .with_unsafe_no_auth(),
            registry,
        )
        .await
        .expect("server");
        let mut socket = connect_async(format!("ws://{}/ws", handle.local_addr()))
            .await
            .expect("WebSocket")
            .0;

        let cancel = json!({
            "scope": { "_tag": "thread", "threadId": "thread-1" },
            "scopeId": "thread:thread-1",
            "actorId": "actor-1",
            "expectedControlRevision": 0,
        });
        let retry = json!({
            "scope": { "_tag": "thread", "threadId": "thread-1" },
            "scopeId": "thread:thread-1",
            "rootActorId": "actor-1",
            "expectedOperationRevision": 0,
        });
        let replace = |base: &Value, key: &str, value: Value| {
            let mut payload = base.clone();
            payload
                .as_object_mut()
                .expect("mutation payload object")
                .insert(key.to_owned(), value);
            payload
        };
        let overlong = "x".repeat(ACTIVITY_ID_MAX_LENGTH + 1);
        let mut native_fields = cancel.clone();
        let native_fields_object = native_fields
            .as_object_mut()
            .expect("mutation payload object");
        native_fields_object.insert("nativeThreadId".to_owned(), json!("native-thread"));
        native_fields_object.insert("turnId".to_owned(), json!("native-turn"));
        native_fields_object.insert("taskId".to_owned(), json!("native-task"));
        let malformed = vec![
            (
                "activity.cancelSubtree",
                replace(&cancel, "unexpected", json!(true)),
            ),
            (
                "activity.cancelSubtree",
                json!({
                    "scope": { "_tag": "thread", "threadId": "thread-1", "terminalId": "native-terminal" },
                    "scopeId": "thread:thread-1",
                    "actorId": "actor-1",
                    "expectedControlRevision": 0,
                }),
            ),
            (
                "activity.cancelSubtree",
                json!({
                    "scope": { "_tag": "terminal", "threadId": "thread-1", "terminalId": "terminal-1" },
                    "scopeId": "terminal:thread-1",
                    "actorId": "actor-1",
                    "expectedControlRevision": 0,
                }),
            ),
            (
                "activity.cancelSubtree",
                replace(
                    &cancel,
                    "scope",
                    json!({ "_tag": "thread", "threadId": "" }),
                ),
            ),
            (
                "activity.cancelSubtree",
                replace(&cancel, "scopeId", json!("  ")),
            ),
            (
                "activity.cancelSubtree",
                replace(&cancel, "actorId", json!("\u{0000}")),
            ),
            (
                "activity.cancelSubtree",
                replace(
                    &cancel,
                    "scope",
                    json!({ "_tag": "thread", "threadId": overlong.clone() }),
                ),
            ),
            (
                "activity.cancelSubtree",
                replace(&cancel, "scopeId", json!(overlong.clone())),
            ),
            (
                "activity.cancelSubtree",
                replace(&cancel, "actorId", json!(overlong.clone())),
            ),
            ("activity.cancelSubtree", native_fields),
            (
                "activity.cancelSubtree",
                replace(&cancel, "descendantActorIds", json!(["actor-child"])),
            ),
            (
                "activity.cancelSubtree",
                replace(&cancel, "expectedControlRevision", json!(-1)),
            ),
            (
                "activity.retrySubtreeCancellation",
                replace(&retry, "unexpected", json!(true)),
            ),
            (
                "activity.retrySubtreeCancellation",
                replace(&retry, "rootActorId", json!("actor\nroot")),
            ),
            (
                "activity.retrySubtreeCancellation",
                replace(&retry, "rootActorId", json!(overlong)),
            ),
            (
                "activity.retrySubtreeCancellation",
                replace(&retry, "descendantWorkItemIds", json!(["work-child"])),
            ),
            (
                "activity.retrySubtreeCancellation",
                replace(&retry, "expectedOperationRevision", json!(-1)),
            ),
        ];

        for (index, (method, payload)) in malformed.into_iter().enumerate() {
            let error = rpc_unary(&mut socket, &(index + 1).to_string(), method, payload)
                .await
                .expect_err("malformed mutation must be rejected");
            assert_eq!(error["reason"], "invalidScope", "accepted case {index}");
            assert_eq!(
                dispatcher.calls.load(Ordering::SeqCst),
                0,
                "dispatched malformed case {index}"
            );
        }

        socket.close(None).await.expect("close socket");
        handle.shutdown();
        handle.join().await.expect("server joins");
    }

    #[tokio::test]
    async fn mutation_rpc_validates_before_dispatch_and_redacts_native_targets() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projections = ActivityProjections::new(
            ActivityRepository::new(database),
            AgentActivityController::new(true),
            AgentActivityController::new(true),
        );
        let projection = projections.chat();
        let scope = ActivityScopeSeed::thread(
            "thread:mutation-rpc",
            "mutation-rpc",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(false),
        )
        .expect("scope");
        projection
            .ensure_scope(scope.clone())
            .await
            .expect("scope persistence");
        let control_registry = projection.activity_control_registry();
        let registration = control_registry.register_runtime(
            scope.scope.clone(),
            scope.scope_id.clone(),
            Some("codex".to_owned()),
        );
        let available =
            ProviderActivityMutation::upsert_actor("actor:available", None, "Available", "running")
                .expect("available actor");
        let unsupported = ProviderActivityMutation::upsert_actor(
            "actor:unsupported",
            None,
            "Unsupported",
            "running",
        )
        .expect("unsupported actor");
        let terminal =
            ProviderActivityMutation::upsert_actor("actor:terminal", None, "Terminal", "completed")
                .expect("terminal actor");
        control_registry
            .observe_provider_batch(
                &registration,
                &[available, unsupported, terminal],
                &[
                    ProviderActivityControlUpdate::ActorTarget {
                        actor_id: "actor:available".to_owned(),
                        target: Some(ProviderActivityNativeTarget::codex_turn(
                            "native-thread-secret".to_owned(),
                            "native-turn-secret".to_owned(),
                        )),
                    },
                    ProviderActivityControlUpdate::ActorTarget {
                        actor_id: "actor:terminal".to_owned(),
                        target: Some(ProviderActivityNativeTarget::claude_task(
                            "native-task-secret".to_owned(),
                        )),
                    },
                ],
            )
            .await;
        let dispatcher = CountingDispatcher::default();
        let cancellation_service =
            ActivityCancellationService::new(control_registry, Arc::new(dispatcher.clone()));
        let mut registry = RpcRegistry::empty();
        register_activity_rpc(&mut registry, projections, cancellation_service);
        let directory = tempfile::tempdir().expect("temporary server directory");
        let handle = ServerRuntime::start_with_registry(
            ServerConfig::new(directory.path())
                .with_bind("127.0.0.1", 0)
                .with_unsafe_no_auth(),
            registry,
        )
        .await
        .expect("server");
        let mut socket = connect_async(format!("ws://{}/ws", handle.local_addr()))
            .await
            .expect("WebSocket")
            .0;

        for (id, payload, expected_reason) in [
            (
                "1",
                json!({
                    "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                    "scopeId": "thread:stale",
                    "actorId": "actor:available",
                    "expectedControlRevision": 1,
                }),
                "staleScope",
            ),
            (
                "2",
                json!({
                    "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                    "scopeId": "thread:mutation-rpc",
                    "actorId": "actor:available",
                    "expectedControlRevision": 0,
                }),
                "staleActor",
            ),
            (
                "3",
                json!({
                    "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                    "scopeId": "thread:mutation-rpc",
                    "actorId": "actor:missing",
                    "expectedControlRevision": 0,
                }),
                "notFound",
            ),
            (
                "4",
                json!({
                    "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                    "scopeId": "thread:mutation-rpc",
                    "actorId": "actor:unsupported",
                    "expectedControlRevision": 0,
                }),
                "targetUnavailable",
            ),
            (
                "5",
                json!({
                    "scope": {
                        "_tag": "terminal",
                        "threadId": "mutation-rpc",
                        "terminalId": "terminal-1"
                    },
                    "scopeId": "terminal:mutation-rpc",
                    "actorId": "actor:available",
                    "expectedControlRevision": 1,
                }),
                "invalidScope",
            ),
        ] {
            let error = rpc_unary(&mut socket, id, "activity.cancelSubtree", payload)
                .await
                .expect_err("request must be rejected before dispatch");
            assert_eq!(error["reason"], expected_reason);
            assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 0);
        }

        let terminal_result = rpc_unary(
            &mut socket,
            "6",
            "activity.cancelSubtree",
            json!({
                "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                "scopeId": "thread:mutation-rpc",
                "actorId": "actor:terminal",
                "expectedControlRevision": 0,
            }),
        )
        .await
        .expect("terminal actor result");
        assert_eq!(terminal_result["disposition"], "alreadyTerminal");
        assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 0);

        let accepted = rpc_unary(
            &mut socket,
            "7",
            "activity.cancelSubtree",
            json!({
                "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                "scopeId": "thread:mutation-rpc",
                "actorId": "actor:available",
                "expectedControlRevision": 1,
            }),
        )
        .await
        .expect("accepted cancellation");
        assert_eq!(accepted["disposition"], "accepted");
        assert_eq!(accepted["rootActorId"], "actor:available");
        assert_eq!(accepted["operationRevision"], 1);
        assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);

        let duplicate = rpc_unary(
            &mut socket,
            "8",
            "activity.cancelSubtree",
            json!({
                "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                "scopeId": "thread:mutation-rpc",
                "actorId": "actor:available",
                "expectedControlRevision": 1,
            }),
        )
        .await
        .expect("duplicate cancellation");
        assert_eq!(duplicate["disposition"], "inProgress");
        assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);

        let stale_retry = rpc_unary(
            &mut socket,
            "9",
            "activity.retrySubtreeCancellation",
            json!({
                "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                "scopeId": "thread:mutation-rpc",
                "rootActorId": "actor:available",
                "expectedOperationRevision": 0,
            }),
        )
        .await
        .expect_err("stale retry revision");
        assert_eq!(stale_retry["reason"], "staleOperation");
        assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);

        let retry = rpc_unary(
            &mut socket,
            "10",
            "activity.retrySubtreeCancellation",
            json!({
                "scope": { "_tag": "thread", "threadId": "mutation-rpc" },
                "scopeId": "thread:mutation-rpc",
                "rootActorId": "actor:available",
                "expectedOperationRevision": 1,
            }),
        )
        .await
        .expect("retry cancellation");
        assert_eq!(retry["disposition"], "accepted");
        assert_eq!(retry["operationRevision"], 2);
        assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 2);

        let wire = serde_json::to_string(&(terminal_result, accepted, duplicate, retry))
            .expect("serialize wire results");
        for secret in [
            "native-thread-secret",
            "native-turn-secret",
            "native-task-secret",
        ] {
            assert!(!wire.contains(secret));
        }

        socket.close(None).await.expect("close socket");
        handle.shutdown();
        handle.join().await.expect("server joins");
    }

    async fn rpc_unary(
        socket: &mut WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        id: &str,
        tag: &str,
        payload: Value,
    ) -> Result<Value, Value> {
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": id,
                    "tag": tag,
                    "payload": payload,
                    "headers": [],
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send RPC request");
        let message = loop {
            let message = socket.next().await.expect("RPC response").expect("frame");
            if let Message::Text(text) = message {
                break serde_json::from_str::<Value>(&text).expect("response JSON");
            }
        };
        assert_eq!(message["_tag"], "Exit");
        assert_eq!(message["requestId"], id);
        match message["exit"]["_tag"].as_str() {
            Some("Success") => Ok(message["exit"]["value"].clone()),
            Some("Failure") => Err(message["exit"]["cause"][0]["error"].clone()),
            other => panic!("unexpected RPC exit: {other:?}"),
        }
    }

    #[tokio::test]
    async fn control_stream_revisions_recover_independently_without_native_ids() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projections = ActivityProjections::with_capacity(
            ActivityRepository::new(database),
            AgentActivityController::new(true),
            AgentActivityController::new(true),
            8,
        );
        let projection = projections.chat();
        let scope = ActivityScopeSeed::thread(
            "thread:control-stream",
            "control-stream",
            "codex",
            Some("codex"),
            ActivityCapabilities::structured_full(false),
        )
        .expect("scope");
        projection
            .ensure_scope(scope.clone())
            .await
            .expect("scope persistence");
        let control_registry = projection.activity_control_registry();
        let _registration = control_registry.register_runtime(
            scope.scope.clone(),
            scope.scope_id.clone(),
            Some("codex".to_owned()),
        );

        let cancellation = CancellationToken::new();
        let mut stream = activity_stream(
            projections,
            RpcRequest {
                id: RequestId::try_from("1").expect("request ID"),
                tag: "subscribeActivity".to_owned(),
                payload: json!({ "_tag": "thread", "threadId": "control-stream" }),
                headers: Vec::new(),
                trace_id: None,
                span_id: None,
                sampled: None,
            },
            RpcSessionContext::unauthenticated(),
            cancellation.clone(),
        );
        let initial = stream
            .recv()
            .await
            .expect("initial chunk")
            .expect("initial snapshot");
        assert_eq!(initial[0]["kind"], "snapshot");
        assert_eq!(initial[0]["snapshot"]["protocolVersion"], 2);
        assert_eq!(initial[0]["snapshot"]["control"]["revision"], 0);

        let actor = ProviderActivityMutation::upsert_actor("actor:child", None, "Child", "running")
            .expect("actor");
        projection
            .apply(
                &scope.scope_id,
                "event:actor".to_owned(),
                vec![actor.clone()],
                "2026-08-11T12:00:00Z".to_owned(),
            )
            .await
            .expect("persistent actor");
        let persistent = stream
            .recv()
            .await
            .expect("persistent chunk")
            .expect("persistent delta");
        assert_eq!(persistent[0]["kind"], "delta");

        control_registry
            .observe_provider_batch(
                &_registration,
                &[actor],
                &[ProviderActivityControlUpdate::ActorTarget {
                    actor_id: "actor:child".to_owned(),
                    target: Some(ProviderActivityNativeTarget::codex_turn(
                        "native-thread-secret".to_owned(),
                        "native-turn-secret".to_owned(),
                    )),
                }],
            )
            .await;
        let control = stream
            .recv()
            .await
            .expect("control chunk")
            .expect("control delta");
        assert_eq!(control[0]["kind"], "control-delta");
        assert_eq!(control[0]["delta"]["previousRevision"], 0);
        assert_eq!(control[0]["delta"]["revision"], 1);
        assert_eq!(
            control[0]["delta"]["changes"][0]["actor"]["state"],
            "available"
        );
        let serialized = serde_json::to_string(&control).expect("serialized control delta");
        assert!(!serialized.contains("native-thread-secret"));
        assert!(!serialized.contains("native-turn-secret"));

        control_registry.publish_delta(ActivityControlDelta {
            scope_id: scope.scope_id.clone(),
            previous_revision: 2,
            revision: 3,
            changes: vec![ActivityControlChange::ActorRemoved {
                actor_id: "actor:other".to_owned(),
            }],
        });
        let replacement = stream
            .recv()
            .await
            .expect("control replacement chunk")
            .expect("control replacement");
        assert_eq!(replacement[0]["kind"], "control-snapshot");
        assert_eq!(replacement[0]["control"]["revision"], 1);
        assert_eq!(
            replacement[0]["control"]["actors"][0]["actorId"],
            "actor:child"
        );
        cancellation.cancel();
    }

    #[tokio::test]
    async fn revision_gap_replaces_the_stream_with_an_authoritative_snapshot() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let stream_controller = AgentActivityController::new(true);
        let projections = ActivityProjections::with_capacity(
            ActivityRepository::new(database.clone()),
            stream_controller.clone(),
            AgentActivityController::new(true),
            8,
        );
        let stream_projection = projections.chat();
        let external_projection =
            ActivityProjection::with_capacity(ActivityRepository::new(database), 8);
        stream_projection
            .ensure_scope(
                ActivityScopeSeed::thread(
                    "thread:gap",
                    "gap",
                    "codex",
                    Some("codex"),
                    ActivityCapabilities::structured_full(false),
                )
                .expect("scope"),
            )
            .await
            .expect("scope persistence");

        let cancellation = CancellationToken::new();
        let mut stream = activity_stream(
            projections,
            RpcRequest {
                id: RequestId::try_from("1").expect("request ID"),
                tag: "subscribeActivity".to_owned(),
                payload: json!({ "_tag": "thread", "threadId": "gap" }),
                headers: Vec::new(),
                trace_id: None,
                span_id: None,
                sampled: None,
            },
            RpcSessionContext::unauthenticated(),
            cancellation.clone(),
        );
        stream
            .recv()
            .await
            .expect("initial snapshot chunk")
            .expect("initial snapshot");

        external_projection
            .apply(
                "thread:gap",
                "event:first".to_owned(),
                vec![
                    super::super::ProviderActivityMutation::upsert_actor(
                        "actor:first",
                        None,
                        "First",
                        "running",
                    )
                    .expect("first actor"),
                ],
                "2026-07-22T12:00:00Z".to_owned(),
            )
            .await
            .expect("first apply");
        let second_delta = external_projection
            .apply(
                "thread:gap",
                "event:second".to_owned(),
                vec![
                    super::super::ProviderActivityMutation::upsert_actor(
                        "actor:second",
                        None,
                        "Second",
                        "running",
                    )
                    .expect("second actor"),
                ],
                "2026-07-22T12:00:01Z".to_owned(),
            )
            .await
            .expect("second apply")
            .into_iter()
            .next()
            .expect("second delta");
        stream_projection.publish_delta_for_test(second_delta);

        let replacement = stream
            .recv()
            .await
            .expect("replacement chunk")
            .expect("replacement snapshot");
        assert_eq!(replacement[0]["kind"], "snapshot");
        assert_eq!(replacement[0]["snapshot"]["revision"], 2);
        cancellation.cancel();
    }

    #[tokio::test]
    async fn cancellation_drops_the_stream_subscriber_without_leaking_a_task() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projections = ActivityProjections::with_capacity(
            ActivityRepository::new(database),
            AgentActivityController::new(true),
            AgentActivityController::new(true),
            2,
        );
        let projection = projections.chat();
        projection
            .ensure_scope(
                ActivityScopeSeed::thread(
                    "thread:cancellation",
                    "cancellation",
                    "codex",
                    Some("codex"),
                    ActivityCapabilities::structured_full(false),
                )
                .expect("scope"),
            )
            .await
            .expect("scope persistence");
        let cancellation = CancellationToken::new();
        let mut stream = activity_stream(
            projections,
            RpcRequest {
                id: RequestId::try_from("1").expect("request ID"),
                tag: "subscribeActivity".to_owned(),
                payload: json!({ "_tag": "thread", "threadId": "cancellation" }),
                headers: Vec::new(),
                trace_id: None,
                span_id: None,
                sampled: None,
            },
            RpcSessionContext::unauthenticated(),
            cancellation.clone(),
        );
        stream
            .recv()
            .await
            .expect("snapshot chunk")
            .expect("snapshot succeeds");
        assert_eq!(
            projection.activity_stream_receiver_count_for_integration_test(),
            1
        );

        cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(1), async {
            while projection.activity_stream_receiver_count_for_integration_test() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stream task released subscriber");
    }

    #[tokio::test]
    async fn revoked_session_cannot_receive_a_replacement_activity_snapshot() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projections = ActivityProjections::with_capacity(
            ActivityRepository::new(database),
            AgentActivityController::new(true),
            AgentActivityController::new(true),
            2,
        );
        let projection = projections.terminal();
        projection
            .ensure_scope(
                ActivityScopeSeed::terminal(
                    "terminal:authorization-1",
                    "authorization-1",
                    "authorization-thread",
                    "authorization-terminal",
                    "codex",
                    Some("codex"),
                    ActivityCapabilities::structured_full(true),
                )
                .expect("initial scope"),
            )
            .await
            .expect("initial scope persistence");

        let config = ServerConfig::new(".")
            .with_bind("127.0.0.1", 3773)
            .with_desktop("activity-rpc-test-bootstrap")
            .expect("auth configuration");
        let auth = AuthService::new(&config, vec![7_u8; 32]);
        let issued = auth
            .exchange_bootstrap(
                "activity-rpc-test-bootstrap",
                None,
                ClientMetadata::default(),
                None,
            )
            .await
            .expect("authorized session");
        let context = RpcSessionContext::authenticated(issued.principal.clone(), auth.clone());
        let cancellation = CancellationToken::new();
        let mut stream = activity_stream(
            projections,
            RpcRequest {
                id: RequestId::try_from("1").expect("request ID"),
                tag: "subscribeActivity".to_owned(),
                payload: json!({
                    "_tag": "terminal",
                    "threadId": "authorization-thread",
                    "terminalId": "authorization-terminal",
                }),
                headers: Vec::new(),
                trace_id: None,
                span_id: None,
                sampled: None,
            },
            context,
            cancellation.clone(),
        );
        stream
            .recv()
            .await
            .expect("initial snapshot chunk")
            .expect("initial snapshot succeeds");

        assert!(
            auth.revoke_client("administrator", &issued.principal.session_id)
                .await
                .expect("revoke session")
        );
        projection
            .ensure_scope(
                ActivityScopeSeed::terminal(
                    "terminal:authorization-2",
                    "authorization-2",
                    "authorization-thread",
                    "authorization-terminal",
                    "codex",
                    Some("codex"),
                    ActivityCapabilities::structured_full(true),
                )
                .expect("replacement scope"),
            )
            .await
            .expect("replacement scope persistence");

        assert_eq!(
            stream
                .recv()
                .await
                .expect("authorization failure chunk")
                .expect_err("revoked session must not receive replacement snapshot"),
            authorization_error(ACTIVITY_READ_SCOPE)
        );
        cancellation.cancel();
    }
}
