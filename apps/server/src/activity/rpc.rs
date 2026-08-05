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
    ACTIVITY_PAGE_MAX_LENGTH, ActivityAdmittedRead, ActivityError, ActivityProjection,
    ActivityProjectionEvent, ActivityProjections, ActivityRecordKind, ActivityRepositoryError,
    ActivityResult, ActivityRosterBucket, ActivityScopeRef, ActivitySection,
    AgentActivityAdmission, AgentActivityController,
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

pub fn register_activity_rpc(registry: &mut RpcRegistry, projections: ActivityProjections) {
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

    registry.register_stream_with_context(
        "subscribeActivity",
        move |request, context, cancellation| {
            activity_stream(projections.clone(), request, context, cancellation)
        },
    );
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
                received = deltas.recv() => received,
            };
            match received {
                Ok(ActivityProjectionEvent::Delta(delta))
                    if delta.scope_id != scope_id || delta.revision <= streamed_revision => {}
                Ok(ActivityProjectionEvent::Delta(delta))
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
                Ok(ActivityProjectionEvent::Delta(_)) => {
                    let Some((fresh_scope_id, revision)) =
                        send_fresh_snapshot(&projection, &scope, &context, &sender, &cancellation)
                            .await
                    else {
                        return;
                    };
                    scope_id = fresh_scope_id;
                    streamed_revision = revision;
                }
                Ok(ActivityProjectionEvent::ScopeReplaced {
                    scope: replaced_scope,
                    scope_id: replacement_scope_id,
                }) if replaced_scope != scope || replacement_scope_id == scope_id => {}
                Ok(ActivityProjectionEvent::ScopeReplaced { .. }) => {
                    let Some((fresh_scope_id, revision)) =
                        send_fresh_snapshot(&projection, &scope, &context, &sender, &cancellation)
                            .await
                    else {
                        return;
                    };
                    scope_id = fresh_scope_id;
                    streamed_revision = revision;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let Some((fresh_scope_id, revision)) =
                        send_fresh_snapshot(&projection, &scope, &context, &sender, &cancellation)
                            .await
                    else {
                        return;
                    };
                    scope_id = fresh_scope_id;
                    streamed_revision = revision;
                }
                Err(broadcast::error::RecvError::Closed) => return,
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
) -> Option<(String, u64)> {
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
    let result = (snapshot.scope_id.clone(), snapshot.revision);
    send(
        sender,
        Ok(vec![json!({ "kind": "snapshot", "snapshot": snapshot })]),
        cancellation,
    )
    .await
    .then_some(result)
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
    use std::time::Duration;

    use crate::{
        ServerConfig,
        activity::{ActivityCapabilities, ActivityRepository, ActivityScopeSeed},
        auth::{AuthService, ClientMetadata},
        persistence::{Database, run_migrations},
        rpc::RequestId,
    };

    use super::*;

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
