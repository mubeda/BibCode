use super::*;
use crate::{
    orchestration::{
        CommandAdmission, EngineOptions, NewProviderTurnDelivery, TurnDeliveryMode,
        canonical_command_digest,
    },
    persistence::{Database, run_migrations},
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const TIME: &str = "2026-08-01T00:00:00Z";
fn command(value: Value) -> OrchestrationCommand {
    serde_json::from_value(value).unwrap()
}
async fn engine() -> OrchestrationEngine {
    engine_with_hooks(crate::orchestration::engine::TestHooks::default()).await
}
async fn engine_with_hooks(hooks: crate::orchestration::engine::TestHooks) -> OrchestrationEngine {
    let database = Database::open_in_memory().await.unwrap();
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .unwrap();
    let engine = OrchestrationEngine::start(
        database,
        EngineOptions {
            test_hooks: hooks,
            ..EngineOptions::default()
        },
    )
    .await
    .unwrap();
    for value in [
        json!({"type":"project.create", "commandId":"project", "projectId":"p", "title":"Queue", "workspaceRoot":"C:/repo", "createdAt":TIME}),
        json!({"type":"thread.create", "commandId":"thread", "threadId":"t", "projectId":"p", "title":"Queue", "runtimeMode":"full-access", "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "createdAt":TIME}),
    ] {
        engine.dispatch(command(value)).await.unwrap();
    }
    engine
}
async fn session(engine: &OrchestrationEngine, status: &str, id: &str) {
    engine.dispatch(command(json!({"type":"thread.session.set", "commandId":id, "threadId":"t", "session":{"threadId":"t", "status":status, "providerName":"codex", "activeTurnId":if status == "running" {Some(id)} else {None}, "lastError":null, "updatedAt":TIME}, "createdAt":TIME}))).await.unwrap();
}
async fn enqueue(engine: &OrchestrationEngine, id: &str, queued: bool) {
    let mut value = json!({"type":"thread.turn.start", "commandId":id, "threadId":"t", "message":{"messageId":id, "role":"user", "text":id, "attachments":[]}, "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "createdAt":TIME});
    if queued {
        value["queued"] = json!(true);
    }
    let command = command(value);
    engine
        .dispatch_with_admission(
            command.clone(),
            CommandAdmission {
                payload_digest: canonical_command_digest(&command).unwrap(),
                attachment_refs: Vec::new(),
                provider_turn: Some(NewProviderTurnDelivery {
                    command_id: id.into(),
                    thread_id: "t".into(),
                    message_id: id.into(),
                    provider_instance_id: "codex".into(),
                    provider_kind: "codex".into(),
                    provider_session_id: None,
                    delivery_key: id.into(),
                    payload: serde_json::to_value(&command).unwrap(),
                    state: if queued {
                        TurnDeliveryState::Queued
                    } else {
                        TurnDeliveryState::Pending
                    },
                    mode: TurnDeliveryMode::Start,
                    created_at: TIME.into(),
                }),
            },
            || {},
        )
        .await
        .unwrap();
}
fn service(engine: &OrchestrationEngine) -> (TurnDeliveryService, mpsc::UnboundedReceiver<String>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let router: DeliveryRouter = Arc::new(move |command| {
        sender.send(command.command_id().to_owned()).unwrap();
        Box::pin(async { Ok(()) })
    });
    (
        TurnDeliveryService::start_with_router(engine.clone(), 1, router),
        receiver,
    )
}
async fn quiet(routes: &mut mpsc::UnboundedReceiver<String>) {
    assert!(
        timeout(Duration::from_millis(80), routes.recv())
            .await
            .is_err(),
        "no provider delivery expected"
    );
}
async fn received(routes: &mut mpsc::UnboundedReceiver<String>, id: &str) {
    assert_eq!(
        timeout(Duration::from_secs(3), routes.recv())
            .await
            .expect("delivery wakes")
            .as_deref(),
        Some(id)
    );
}
async fn row(engine: &OrchestrationEngine, id: &str) -> ProviderTurnDelivery {
    engine
        .repositories()
        .get_provider_turn_delivery(id.into())
        .await
        .unwrap()
        .unwrap()
}
async fn activity(engine: &OrchestrationEngine, kind: &str, id: &str) {
    engine.dispatch(command(json!({"type":"thread.activity.append", "commandId":id, "threadId":"t", "activity":{"id":id, "tone":"approval", "kind":kind, "summary":"request", "payload":{"requestId":"request"}, "turnId":null, "createdAt":TIME}, "createdAt":TIME}))).await.unwrap();
}

#[test]
fn claimable_oldest_per_thread_ignores_queued() {
    let mut queued = super::tests::row("queued", "one");
    queued.state = TurnDeliveryState::Queued;
    let pending = super::tests::row("pending", "two");
    let result = claimable_oldest_per_thread(vec![queued, pending]);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].command_id, "pending");
}

#[tokio::test]
async fn queued_rows_are_never_claimed() {
    let engine = engine().await;
    enqueue(&engine, "queued", true).await;
    engine
        .repositories()
        .database()
        .call(|connection| {
            connection.execute("UPDATE provider_turn_outbox SET held = 1", [])?;
            Ok(())
        })
        .await
        .unwrap();
    session(&engine, "ready", "ready").await;
    assert!(
        engine
            .repositories()
            .claim_provider_turn("queued".into(), TIME.into())
            .await
            .unwrap()
            .is_none()
    );
    let (service, mut routes) = service(&engine);
    quiet(&mut routes).await;
    engine.dispatch(command(json!({"type":"thread.turn.promote", "commandId":"send-now", "threadId":"t", "messageId":"queued", "createdAt":TIME}))).await.unwrap();
    received(&mut routes, "queued").await;
    service.shutdown().await;
    assert_eq!(
        row(&engine, "queued").await.state,
        TurnDeliveryState::Delivered
    );
    engine.shutdown().await;
}

#[tokio::test]
async fn settle_promotes_the_oldest_queued_row_once() {
    let engine = engine().await;
    session(&engine, "running", "running-first").await;
    enqueue(&engine, "queued-1", true).await;
    enqueue(&engine, "queued-2", true).await;
    let (service, mut routes) = service(&engine);
    quiet(&mut routes).await;
    session(&engine, "ready", "ready-first").await;
    received(&mut routes, "queued-1").await;
    // Delivery acceptance releases the per-thread worker slot before provider running is published.
    quiet(&mut routes).await;
    assert_eq!(
        row(&engine, "queued-2").await.state,
        TurnDeliveryState::Queued
    );
    session(&engine, "running", "running-second").await;
    session(&engine, "ready", "ready-second").await;
    received(&mut routes, "queued-2").await;
    service.shutdown().await;
    assert_eq!(row(&engine, "queued-1").await.attempts, 1);
    assert_eq!(row(&engine, "queued-2").await.attempts, 1);
    engine.shutdown().await;
}

#[tokio::test]
async fn no_promotion_while_approval_or_user_input_pending() {
    for kind in ["approval", "user-input"] {
        let engine = engine().await;
        session(&engine, "running", "running").await;
        enqueue(&engine, "queued", true).await;
        activity(&engine, &format!("{kind}.requested"), "request-open").await;
        session(&engine, "ready", "ready-blocked").await;
        let (service, mut routes) = service(&engine);
        quiet(&mut routes).await;
        assert!(engine.dispatch(command(json!({"type":"thread.turn.promote", "commandId":"server:blocked-promote", "threadId":"t", "messageId":"queued", "createdAt":TIME}))).await.is_err());
        assert_eq!(
            row(&engine, "queued").await.state,
            TurnDeliveryState::Queued
        );
        activity(&engine, &format!("{kind}.resolved"), "request-resolved").await;
        session(&engine, "ready", "ready-unblocked").await;
        received(&mut routes, "queued").await;
        service.shutdown().await;
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn no_promotion_after_interrupted_or_error_settle() {
    for status in [
        "idle",
        "starting",
        "running",
        "interrupted",
        "stopped",
        "error",
    ] {
        let engine = engine().await;
        enqueue(&engine, "queued", true).await;
        session(&engine, status, "settle").await;
        let (service, mut routes) = service(&engine);
        quiet(&mut routes).await;
        assert_eq!(
            row(&engine, "queued").await.state,
            TurnDeliveryState::Queued
        );
        service.shutdown().await;
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn pending_start_is_not_claimed_while_session_running() {
    for status in ["running", "starting"] {
        let engine = engine().await;
        session(&engine, status, "busy").await;
        enqueue(&engine, "legacy-start", false).await;
        assert_eq!(
            row(&engine, "legacy-start").await.state,
            TurnDeliveryState::Pending
        );
        assert!(
            engine
                .repositories()
                .claim_provider_turn("legacy-start".into(), TIME.into())
                .await
                .unwrap()
                .is_none()
        );
        let (service, mut routes) = service(&engine);
        quiet(&mut routes).await;
        session(&engine, "ready", "ready").await;
        received(&mut routes, "legacy-start").await;
        service.shutdown().await;
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn interrupt_holds_queued_rows_until_client_promotes_only_the_head() {
    let engine = engine().await;
    session(&engine, "running", "running").await;
    enqueue(&engine, "queued-1", true).await;
    enqueue(&engine, "queued-2", true).await;
    let (service, mut routes) = service(&engine);
    engine.dispatch(command(json!({"type":"thread.turn.interrupt", "commandId":"interrupt", "threadId":"t", "createdAt":TIME}))).await.unwrap();
    assert!(row(&engine, "queued-1").await.held);
    assert!(row(&engine, "queued-2").await.held);
    session(&engine, "ready", "ready").await;
    quiet(&mut routes).await;
    engine.dispatch(command(json!({"type":"thread.turn.promote", "commandId":"send-now", "threadId":"t", "messageId":"queued-1", "createdAt":TIME}))).await.unwrap();
    received(&mut routes, "queued-1").await;
    service.shutdown().await;
    assert!(!row(&engine, "queued-1").await.held);
    assert!(row(&engine, "queued-2").await.held);
    engine.shutdown().await;
}

#[tokio::test]
async fn dismissing_a_failed_head_allows_the_next_queued_turn() {
    let engine = engine().await;
    session(&engine, "running", "running").await;
    enqueue(&engine, "queued-1", true).await;
    enqueue(&engine, "queued-2", true).await;
    let (sender, mut routes) = mpsc::unbounded_channel();
    let router: ProviderDeliveryRouter = Arc::new(move |command, _| {
        let id = command.command_id().to_owned();
        sender.send(id.clone()).unwrap();
        Box::pin(async move {
            if id == "queued-1" {
                ProviderDeliveryOutcome::Rejected {
                    detail: "prelaunch rejection".into(),
                }
            } else {
                ProviderDeliveryOutcome::Accepted { turn_id: None }
            }
        })
    });
    let service = TurnDeliveryService::start_with_delivery_router(
        engine.clone(),
        1,
        router,
        unavailable_reconciler(),
    );
    session(&engine, "ready", "ready").await;
    received(&mut routes, "queued-1").await;
    timeout(Duration::from_secs(3), async {
        while row(&engine, "queued-1").await.state != TurnDeliveryState::Failed {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    engine.dispatch(command(json!({"type":"thread.turn-delivery.resolve", "commandId":"dismiss", "threadId":"t", "messageId":"queued-1", "action":"dismiss", "createdAt":TIME}))).await.unwrap();
    received(&mut routes, "queued-2").await;
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn steer_target_lookup_failure_returns_to_pending_without_provider_io() {
    let hooks = crate::orchestration::engine::TestHooks::default();
    let engine = engine_with_hooks(hooks.clone()).await;
    enqueue(&engine, "steer-read-failure", true).await;
    session(&engine, "running", "active").await;
    engine.dispatch(command(json!({"type":"thread.turn.steer","commandId":"steer-request","threadId":"t","messageId":"steer-read-failure","createdAt":TIME}))).await.unwrap();
    let claimed = engine
        .repositories()
        .claim_provider_turn("steer-read-failure".into(), TIME.into())
        .await
        .unwrap()
        .unwrap();
    // Temporarily remove the queried relation to exercise the real database error seam.
    engine
        .repositories()
        .database()
        .call(|connection| {
            connection.execute(
                "ALTER TABLE orchestration_events RENAME TO events_unavailable",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router: ProviderDeliveryRouter = Arc::new({
        let calls = calls.clone();
        move |_, _| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {
                ProviderDeliveryOutcome::Accepted {
                    turn_id: Some("active".into()),
                }
            })
        }
    });
    let worker_engine = engine.clone();
    let mut task = tokio::spawn(async move {
        deliver_claimed(&worker_engine, &router, claimed, &CancellationToken::new()).await
    });
    let early = tokio::select! {
        result = &mut task => Some(result.unwrap()),
        () = async { while hooks.delivery_transition_attempts() == 0 { tokio::task::yield_now().await; } } => None,
    };
    engine
        .repositories()
        .database()
        .call(|connection| {
            connection.execute(
                "ALTER TABLE events_unavailable RENAME TO orchestration_events",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let result = match early {
        Some(result) => result,
        None => timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap(),
    };
    assert_eq!(result.unwrap(), DeliveryTaskOutcome::DefinitelyNotSent);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(
        row(&engine, "steer-read-failure").await.state,
        TurnDeliveryState::Pending
    );
    engine.shutdown().await;
}
