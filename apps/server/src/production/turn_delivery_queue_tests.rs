use super::*;
use crate::{
    orchestration::{
        CommandAdmission, EngineOptions, NewProviderTurnDelivery, TurnDeliveryMode,
        canonical_command_digest,
    },
    persistence::{Database, run_migrations},
    test_support::isolated_git_config::IsolatedGitConfig,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const TIME: &str = "2026-08-01T00:00:00Z";
/// How long a test waits for something to happen. It bounds only a failure: a wait ends the
/// moment its condition holds, and the checkpoint tests spawn Git, which a loaded host can
/// leave waiting for seconds. A deadline the product owns is never widened by this.
const WAKE_WAIT: Duration = Duration::from_secs(30);
fn command(value: Value) -> OrchestrationCommand {
    serde_json::from_value(value).unwrap()
}
async fn engine() -> OrchestrationEngine {
    engine_with_hooks(crate::orchestration::engine::TestHooks::default()).await
}
async fn engine_with_hooks(hooks: crate::orchestration::engine::TestHooks) -> OrchestrationEngine {
    engine_on(Database::open_in_memory().await.unwrap(), hooks).await
}
/// The queue engine (project `p`, thread `t`) on a new `database`.
async fn engine_on(
    database: Database,
    hooks: crate::orchestration::engine::TestHooks,
) -> OrchestrationEngine {
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
    session_as(engine, status, id, "codex").await;
}
async fn session_as(engine: &OrchestrationEngine, status: &str, id: &str, provider: &str) {
    engine.dispatch(command(json!({"type":"thread.session.set", "commandId":id, "threadId":"t", "session":{"threadId":"t", "status":status, "providerName":provider, "activeTurnId":if status == "running" {Some(id)} else {None}, "lastError":null, "updatedAt":TIME}, "createdAt":TIME}))).await.unwrap();
}
async fn enqueue(engine: &OrchestrationEngine, id: &str, queued: bool) {
    enqueue_for(engine, "t", id, queued).await;
}
async fn enqueue_for(engine: &OrchestrationEngine, thread: &str, id: &str, queued: bool) {
    enqueue_as(engine, thread, id, queued, "codex").await;
}
async fn enqueue_as(
    engine: &OrchestrationEngine,
    thread: &str,
    id: &str,
    queued: bool,
    provider: &str,
) {
    let mut value = json!({"type":"thread.turn.start", "commandId":id, "threadId":thread, "message":{"messageId":id, "role":"user", "text":id, "attachments":[]}, "modelSelection":{"instanceId":provider, "model":"gpt-5"}, "createdAt":TIME});
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
                    thread_id: thread.into(),
                    message_id: id.into(),
                    provider_instance_id: provider.into(),
                    provider_kind: provider.into(),
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
        timeout(WAKE_WAIT, routes.recv())
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
async fn a_resumed_session_reading_its_asks_holds_the_follow_up_until_the_read_finishes() {
    // Mutation caught: a resumed OpenCode session turning `ready` sends a queued follow-up
    // before its first read has shown an ask BiBCode never recorded (#187).
    for read_finds_an_ask in [true, false] {
        let engine = engine().await;
        session_as(&engine, "running", "running", "opencode").await;
        enqueue(&engine, "queued", true).await;
        session_as(&engine, "stopped", "suspended", "opencode").await;
        let hold = engine.hold_promotion_for_ask_recovery("t");
        session_as(&engine, "ready", "relaunch", "opencode").await;
        let (service, mut routes) = service(&engine);
        quiet(&mut routes).await;
        if read_finds_an_ask {
            // The read shows the ask, then reports it finished: the ask holds the queue.
            activity(&engine, "approval.requested", "request-recovered").await;
            engine.release_promotion_after_ask_recovery("t");
            quiet(&mut routes).await;
            assert_eq!(
                row(&engine, "queued").await.state,
                TurnDeliveryState::Queued
            );
        } else {
            // The read failed: it releases the queue, today's behavior without a read.
            engine.release_promotion_after_ask_recovery("t");
            received(&mut routes, "queued").await;
        }
        drop(hold);
        service.shutdown().await;
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn an_opencode_ask_holds_the_follow_up_until_a_completed_read_drops_it() {
    // Mutation caught: a relaunch, or a resume whose read of OpenCode's pending lists failed,
    // releasing a follow-up past an ask the OpenCode server may still hold (#187).
    for kind in ["approval", "user-input"] {
        let engine = engine().await;
        session_as(&engine, "running", "running", "opencode").await;
        enqueue(&engine, "queued", true).await;
        activity(&engine, &format!("{kind}.requested"), "request-open").await;
        // The session ends and relaunches; the resume's read failed, so it listed nothing.
        session_as(&engine, "stopped", "suspended", "opencode").await;
        session_as(&engine, "ready", "relaunch", "opencode").await;
        let (service, mut routes) = service(&engine);
        quiet(&mut routes).await;
        assert_eq!(
            row(&engine, "queued").await.state,
            TurnDeliveryState::Queued
        );
        // A completed read that no longer lists the ask expires it, and the follow-up goes.
        let listed = std::collections::HashSet::new();
        assert_eq!(
            engine
                .expire_requests_unlisted_by_provider("t", &listed, "read")
                .await
                .unwrap(),
            1
        );
        received(&mut routes, "queued").await;
        service.shutdown().await;
        engine.shutdown().await;
    }
}

#[tokio::test]
async fn an_interrupted_or_failed_turn_expires_its_request_and_holds_the_queue() {
    for status in ["interrupted", "error"] {
        let engine = engine().await;
        session(&engine, "running", "running").await;
        enqueue(&engine, "queued", true).await;
        activity(&engine, "approval.requested", "request-open").await;
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

/// Starts a queue whose head's delivery is uncertain (OpenCode, whose session status can be read)
/// and dismisses it. `status` answers whether the session is idle; returns the routed ids.
async fn dismissed_uncertain_opencode_head(
    engine: &OrchestrationEngine,
    status: Arc<std::sync::Mutex<ProviderReconciliationOutcome>>,
) -> (TurnDeliveryService, mpsc::UnboundedReceiver<String>) {
    session(engine, "running", "running").await;
    enqueue_as(engine, "t", "queued-1", true, "opencode").await;
    enqueue_as(engine, "t", "queued-2", true, "opencode").await;
    let (sender, mut routes) = mpsc::unbounded_channel();
    let router: ProviderDeliveryRouter = Arc::new(move |command, _| {
        let id = command.command_id().to_owned();
        sender.send(id.clone()).unwrap();
        Box::pin(async move {
            if id == "queued-1" {
                ProviderDeliveryOutcome::Ambiguous {
                    detail: "the answer was lost".into(),
                }
            } else {
                ProviderDeliveryOutcome::Accepted { turn_id: None }
            }
        })
    });
    let reconciler: DeliveryReconciler = Arc::new(move |_| {
        let outcome = status.lock().unwrap().clone();
        Box::pin(async move { outcome })
    });
    let service =
        TurnDeliveryService::start_with_delivery_router(engine.clone(), 1, router, reconciler);
    session(engine, "ready", "ready").await;
    received(&mut routes, "queued-1").await;
    timeout(Duration::from_secs(3), async {
        while row(engine, "queued-1").await.state != TurnDeliveryState::Uncertain {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    engine.dispatch(command(json!({"type":"thread.turn-delivery.resolve", "commandId":"dismiss", "threadId":"t", "messageId":"queued-1", "action":"dismiss", "createdAt":TIME}))).await.unwrap();
    (service, routes)
}

/// A dismissed uncertain OpenCode head blocks the queue only while OpenCode may still process
/// it: once its session status reads idle, the next queued turn runs.
#[tokio::test]
async fn a_dismissed_uncertain_head_releases_the_queue_once_the_session_is_idle() {
    let engine = engine().await;
    let status = Arc::new(std::sync::Mutex::new(
        ProviderReconciliationOutcome::FoundSettled,
    ));
    let (service, mut routes) = dismissed_uncertain_opencode_head(&engine, status).await;
    received(&mut routes, "queued-2").await;
    service.shutdown().await;
    engine.shutdown().await;
}

/// While OpenCode is busy the queue waits; when the session goes idle (signalled by its ready
/// session update) the next queued turn runs.
#[tokio::test]
async fn a_dismissed_uncertain_head_waits_while_busy_then_releases_on_idle() {
    let engine = engine().await;
    let status = Arc::new(std::sync::Mutex::new(
        ProviderReconciliationOutcome::Unavailable {
            detail: "OpenCode is still working on this message".into(),
        },
    ));
    let (service, mut routes) = dismissed_uncertain_opencode_head(&engine, status.clone()).await;
    quiet(&mut routes).await;
    *status.lock().unwrap() = ProviderReconciliationOutcome::FoundSettled;
    session(&engine, "ready", "idle-again").await;
    received(&mut routes, "queued-2").await;
    service.shutdown().await;
    engine.shutdown().await;
}

/// A provider that cannot report its session status keeps the old rule: the queue stays held.
#[tokio::test]
async fn a_dismissed_uncertain_head_stays_blocking_without_a_session_status() {
    let engine = engine().await;
    let status = Arc::new(std::sync::Mutex::new(ProviderReconciliationOutcome::Found));
    let (service, mut routes) = dismissed_uncertain_opencode_head(&engine, status).await;
    session(&engine, "ready", "idle-again").await;
    quiet(&mut routes).await;
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

async fn delete_thread(engine: &OrchestrationEngine, thread: &str) {
    engine
        .dispatch(command(json!({"type":"thread.delete", "commandId":format!("delete-{thread}"), "threadId":thread, "createdAt":TIME})))
        .await
        .unwrap();
}
async fn settled(engine: &OrchestrationEngine, id: &str) -> ProviderTurnDelivery {
    timeout(Duration::from_secs(3), async {
        loop {
            let current = row(engine, id).await;
            if current.state != TurnDeliveryState::Pending {
                return current;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("delivery for a deleted thread settles")
}

#[tokio::test]
async fn pending_delivery_for_a_deleted_thread_is_dismissed_and_never_routed() {
    let engine = engine().await;
    session(&engine, "ready", "ready").await;
    enqueue(&engine, "first", false).await;
    enqueue(&engine, "second", false).await;
    delete_thread(&engine, "t").await;
    let (service, mut routes) = service(&engine);
    for id in ["first", "second"] {
        let settled = settled(&engine, id).await;
        assert_eq!(settled.state, TurnDeliveryState::Dismissed);
        assert_eq!(settled.attempts, 0, "a deleted thread is never attempted");
    }
    quiet(&mut routes).await;
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn row_stuck_retrying_a_deleted_thread_settles_at_startup() {
    let engine = engine().await;
    session(&engine, "ready", "ready").await;
    enqueue(&engine, "stuck", false).await;
    engine
        .repositories()
        .database()
        .call(|connection| {
            connection.execute(
                "UPDATE provider_turn_outbox SET attempts = 36598, last_error = 'BiBCode could not update this thread: Thread is deleted.'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    delete_thread(&engine, "t").await;
    let (service, mut routes) = service(&engine);
    let settled = settled(&engine, "stuck").await;
    assert_eq!(settled.state, TurnDeliveryState::Dismissed);
    assert_eq!(settled.attempts, 36598);
    quiet(&mut routes).await;
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn deleting_a_thread_settles_its_pending_delivery_while_live_threads_still_deliver() {
    let engine = engine().await;
    engine.dispatch(command(json!({"type":"thread.create", "commandId":"thread-live", "threadId":"live", "projectId":"p", "title":"Live", "runtimeMode":"full-access", "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "createdAt":TIME}))).await.unwrap();
    // A running session keeps the doomed thread's start row waiting rather than routed.
    session(&engine, "running", "running").await;
    enqueue(&engine, "doomed", false).await;
    enqueue_for(&engine, "live", "survivor", false).await;
    let (service, mut routes) = service(&engine);
    received(&mut routes, "survivor").await;
    quiet(&mut routes).await;
    assert_eq!(
        row(&engine, "doomed").await.state,
        TurnDeliveryState::Pending
    );
    delete_thread(&engine, "t").await;
    service.wake();
    let settled = settled(&engine, "doomed").await;
    assert_eq!(settled.state, TurnDeliveryState::Dismissed);
    quiet(&mut routes).await;
    assert_eq!(
        row(&engine, "survivor").await.state,
        TurnDeliveryState::Delivered
    );
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn a_closed_chat_panel_never_promotes_its_queue_until_reopened() {
    let engine = engine().await;
    engine.dispatch(command(json!({"type":"thread.create", "commandId":"panel", "threadId":"panel", "projectId":"p", "title":"Panel — Codex", "kind":"panel", "hostThreadId":"t", "runtimeMode":"full-access", "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "createdAt":TIME}))).await.unwrap();
    for thread in ["t", "panel"] {
        engine.dispatch(command(json!({"type":"thread.session.set", "commandId":format!("ready-{thread}"), "threadId":thread, "session":{"threadId":thread, "status":"ready", "providerName":"codex", "activeTurnId":null, "lastError":null, "updatedAt":TIME}, "createdAt":TIME}))).await.unwrap();
        enqueue_for(&engine, thread, &format!("queued-{thread}"), true).await;
    }
    let repositories = engine.repositories();
    let promotable = |thread: &'static str| {
        let repositories = repositories.clone();
        async move {
            repositories
                .can_promote_queued_provider_turn(thread.into(), format!("queued-{thread}"), true)
                .await
                .unwrap()
        }
    };
    assert!(promotable("panel").await);
    for (command_type, thread) in [("thread.archive", "panel"), ("thread.archive", "t")] {
        engine.dispatch(command(json!({"type":command_type, "commandId":format!("{command_type}-{thread}"), "threadId":thread}))).await.unwrap();
    }
    // Closing a panel archives it: its queue waits. Archiving another thread changes nothing.
    assert!(!promotable("panel").await);
    assert!(promotable("t").await);
    assert!(
        repositories
            .can_promote_queued_provider_turn("panel".into(), "queued-panel".into(), false)
            .await
            .unwrap(),
        "Send now still promotes explicitly"
    );
    let (service, mut routes) = service(&engine);
    received(&mut routes, "queued-t").await;
    quiet(&mut routes).await;
    // Reopening wakes delivery, so the panel's queue resumes without another settlement.
    engine
        .dispatch(command(
            json!({"type":"thread.unarchive", "commandId":"reopen", "threadId":"panel"}),
        ))
        .await
        .unwrap();
    // The running service may already have promoted it, so only its delivery is certain.
    received(&mut routes, "queued-panel").await;
    service.shutdown().await;
    engine.shutdown().await;
}

#[tokio::test]
async fn a_closed_chat_panel_does_not_start_a_prompt_sent_before_it_closed() {
    let engine = engine().await;
    engine.dispatch(command(json!({"type":"thread.create", "commandId":"panel", "threadId":"panel", "projectId":"p", "title":"Panel — Codex", "kind":"panel", "hostThreadId":"t", "runtimeMode":"full-access", "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "createdAt":TIME}))).await.unwrap();
    // The prompt was admitted, but the panel closed before delivery claimed it.
    enqueue_for(&engine, "panel", "pending-panel", false).await;
    engine
        .dispatch(command(
            json!({"type":"thread.archive", "commandId":"close", "threadId":"panel"}),
        ))
        .await
        .unwrap();
    let (service, mut routes) = service(&engine);
    quiet(&mut routes).await;
    assert_eq!(
        row(&engine, "pending-panel").await.state,
        TurnDeliveryState::Pending
    );
    // Delivery skips the closed panel instead of retrying its claim in a loop.
    assert_eq!(engine.repositories().provider_turn_claims_for_test(), 0);
    engine
        .dispatch(command(
            json!({"type":"thread.unarchive", "commandId":"reopen", "threadId":"panel"}),
        ))
        .await
        .unwrap();
    received(&mut routes, "pending-panel").await;
    service.shutdown().await;
    engine.shutdown().await;
}

/// The production effects worker reverting thread `t` to turn 1 of 2, with a provider rewind that
/// waits until the test releases it.
struct RevertFixture {
    engine: OrchestrationEngine,
    effects: crate::production::orchestration_effects::OrchestrationEffects,
    rewind: Arc<GatedRewind>,
    events: tokio::sync::broadcast::Receiver<crate::persistence::OrchestrationEvent>,
    _repository: tempfile::TempDir,
}

struct GatedRewind {
    cwd: PathBuf,
    entered: Notify,
    release: Notify,
    rewinds: std::sync::atomic::AtomicUsize,
    /// The session was suspended while idle, so the rewind first reopens it, slowly: until
    /// `reopen_release`. Production reopens in `prepare_provider_rewind` and, if the session is
    /// still gone, in `rollback_provider`.
    suspended: std::sync::atomic::AtomicBool,
    reopen_entered: Notify,
    reopen_release: Notify,
    /// The worker's next workspace lookup waits for `workspace_release`, like Git hung on it.
    hold_workspace: std::sync::atomic::AtomicBool,
    workspace_release: Notify,
    /// The worker's next workspace refresh (after a capture, before its `ready` record) waits for
    /// `refresh_release`, announcing itself on `refresh_entered`.
    hold_refresh: std::sync::atomic::AtomicBool,
    refresh_entered: Notify,
    refresh_release: Notify,
}

impl GatedRewind {
    async fn reopen_if_suspended(&self) {
        if self
            .suspended
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            self.reopen_entered.notify_one();
            self.reopen_release.notified().await;
        }
    }
}

impl crate::production::orchestration_effects::OrchestrationEffectCallbacks for GatedRewind {
    fn workspace_for_thread<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async move {
            if self
                .hold_workspace
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                self.workspace_release.notified().await;
            }
            Ok(Some(self.cwd.clone()))
        })
    }

    fn rollback_provider<'a>(
        &'a self,
        _thread_id: &'a str,
        _turns: i64,
        _rewind_key: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<
        'a,
        crate::production::orchestration_effects::ProviderRewind,
    > {
        Box::pin(async move {
            self.reopen_if_suspended().await;
            self.rewinds
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.entered.notify_one();
            self.release.notified().await;
            Ok(crate::production::orchestration_effects::ProviderRewind::Rewound)
        })
    }

    fn prepare_provider_rewind<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.reopen_if_suspended().await;
            Ok(())
        })
    }

    fn stop_provider<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn close_terminals<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn refresh_workspace<'a>(
        &'a self,
        _cwd: &'a Path,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            if self
                .hold_refresh
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                self.refresh_entered.notify_one();
                self.refresh_release.notified().await;
            }
            Ok(())
        })
    }
}

fn git(config: &IsolatedGitConfig, cwd: &Path, args: &[&str]) {
    let mut command = std::process::Command::new("git");
    config.apply_to_command(&mut command);
    let output = command.args(args).current_dir(cwd).output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A Git checkout with `tracked.txt` committed as `baseline`, for reverts run by production Git.
fn revert_checkout() -> tempfile::TempDir {
    // The checkpoint capture and the revert run production Git, which keeps the inherited
    // environment. Refuse to run rather than let it restore and clean another checkout.
    let discovery = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
    ];
    assert!(
        discovery
            .iter()
            .all(|name| std::env::var_os(name).is_none()),
        "the revert fixture runs production Git: unset {discovery:?} first"
    );
    let repository = tempfile::tempdir().unwrap();
    let cwd = repository.path();
    let config = IsolatedGitConfig::new();
    for args in [
        &["init"][..],
        &["config", "user.name", "BiBCode Test"],
        &["config", "user.email", "bibcode@example.test"],
        // The checkpoint commands are production Git, which keeps its inherited settings.
        &["config", "commit.gpgSign", "false"],
    ] {
        git(&config, cwd, args);
    }
    std::fs::write(cwd.join("tracked.txt"), "baseline\n").unwrap();
    git(&config, cwd, &["add", "."]);
    git(&config, cwd, &["commit", "-m", "baseline"]);
    repository
}

impl RevertFixture {
    async fn new() -> Self {
        Self::with_options(crate::production::orchestration_effects::EffectsOptions::default())
            .await
    }

    async fn with_options(
        options: crate::production::orchestration_effects::EffectsOptions,
    ) -> Self {
        Self::on(Database::open_in_memory().await.unwrap(), options).await
    }

    async fn on(
        database: Database,
        options: crate::production::orchestration_effects::EffectsOptions,
    ) -> Self {
        use crate::production::orchestration_effects::{
            OrchestrationEffects, capture_checkpoint, checkpoint_ref,
        };
        let repository = revert_checkout();
        let cwd = repository.path().to_path_buf();
        let engine = engine_on(database, crate::orchestration::engine::TestHooks::default()).await;
        for (turn_count, content) in [(0, "baseline\n"), (1, "one\n"), (2, "two\n")] {
            std::fs::write(cwd.join("tracked.txt"), content).unwrap();
            capture_checkpoint(&cwd, "t", turn_count).await.unwrap();
            if turn_count > 0 {
                engine.dispatch(command(json!({
                    "type":"thread.turn.diff.complete", "commandId":format!("diff-{turn_count}"),
                    "threadId":"t", "turnId":format!("turn-{turn_count}"),
                    "checkpointTurnCount":turn_count, "checkpointRef":checkpoint_ref("t", turn_count),
                    "status":"ready", "files":[], "assistantMessageId":format!("a-{turn_count}"),
                    "completedAt":TIME, "createdAt":TIME
                }))).await.unwrap();
            }
        }
        session(&engine, "ready", "ready").await;
        let rewind = Arc::new(GatedRewind {
            cwd,
            entered: Notify::new(),
            release: Notify::new(),
            rewinds: std::sync::atomic::AtomicUsize::new(0),
            suspended: std::sync::atomic::AtomicBool::new(false),
            reopen_entered: Notify::new(),
            reopen_release: Notify::new(),
            hold_workspace: std::sync::atomic::AtomicBool::new(false),
            workspace_release: Notify::new(),
            hold_refresh: std::sync::atomic::AtomicBool::new(false),
            refresh_entered: Notify::new(),
            refresh_release: Notify::new(),
        });
        let effects = OrchestrationEffects::start(
            engine.clone(),
            Arc::new(crate::git::GitRepository::default()),
            rewind.clone(),
            options,
        )
        .await
        .unwrap();
        let events = engine.subscribe_events();
        Self {
            engine,
            effects,
            rewind,
            events,
            _repository: repository,
        }
    }

    async fn revert(&self) {
        self.engine.dispatch(command(json!({"type":"thread.checkpoint.revert", "commandId":"revert", "threadId":"t", "turnCount":1, "createdAt":TIME}))).await.unwrap();
    }

    /// Waits for the first event of `event_type` that `matches`.
    async fn event(
        &mut self,
        event_type: &str,
        matches: impl Fn(&Value) -> bool,
    ) -> crate::persistence::OrchestrationEvent {
        timeout(Duration::from_secs(10), async {
            loop {
                let event = self.events.recv().await.unwrap();
                if event.event.event_type == event_type && matches(&event.event.payload) {
                    return event;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no {event_type} event"))
    }

    /// Git's answer for `args` in the fixture checkout, when Git succeeds.
    fn git_output(&self, args: &[&str]) -> Option<String> {
        let config = IsolatedGitConfig::new();
        let mut probe = std::process::Command::new("git");
        config.apply_to_command(&mut probe);
        let output = probe
            .args(args)
            .current_dir(&self.rewind.cwd)
            .output()
            .unwrap();
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n"))
    }

    /// Admits a turn on a second thread `b` and reports whether its checkpoint baseline is
    /// captured within [`WAKE_WAIT`]. The callers hold thread `t`'s reopen or delivery behind a
    /// gate they release only afterwards, so a baseline that waits behind it never arrives.
    async fn other_thread_gets_its_baseline(&self) -> bool {
        self.engine.dispatch(command(json!({"type":"thread.create", "commandId":"thread-b", "threadId":"b", "projectId":"p", "title":"Other", "runtimeMode":"full-access", "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "createdAt":TIME}))).await.unwrap();
        enqueue_for(&self.engine, "b", "b-first", false).await;
        let baseline = crate::production::orchestration_effects::checkpoint_ref("b", 0);
        timeout(WAKE_WAIT, async {
            while self
                .git_output(&["rev-parse", "--verify", "--quiet", &baseline])
                .is_none()
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .is_ok()
    }

    async fn shutdown(self) {
        self.effects.shutdown().await;
        self.engine.shutdown().await;
    }
}

/// A revert that must first reopen a session suspended while idle does not hold the effects
/// worker during that start: another thread's turn still gets its checkpoint baseline.
#[tokio::test]
async fn a_revert_reopening_a_suspended_session_does_not_delay_another_threads_checkpoint() {
    let mut fixture = RevertFixture::new().await;
    fixture
        .rewind
        .suspended
        .store(true, std::sync::atomic::Ordering::SeqCst);
    fixture.rewind.release.notify_one();
    fixture.revert().await;
    fixture.rewind.reopen_entered.notified().await;

    assert!(
        fixture.other_thread_gets_its_baseline().await,
        "thread b's checkpoint baseline waited behind thread t's provider reopen"
    );

    fixture.rewind.reopen_release.notify_one();
    fixture.event("thread.reverted", |_| true).await;
    assert_eq!(
        fixture
            .rewind
            .rewinds
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    fixture.shutdown().await;
}

/// The thread's own effects that arrive while its revert is being prepared wait for it, in
/// order: a checkpoint captured after the revert sees the restored files.
#[tokio::test]
async fn a_reverting_threads_later_effects_run_after_the_revert() {
    let mut fixture = RevertFixture::new().await;
    fixture
        .rewind
        .suspended
        .store(true, std::sync::atomic::Ordering::SeqCst);
    fixture.rewind.release.notify_one();
    fixture.revert().await;
    fixture.rewind.reopen_entered.notified().await;

    // A turn whose checkpoint is missing: the effect captures the checkout as it is then.
    fixture
        .engine
        .dispatch(command(json!({
            "type":"thread.turn.diff.complete", "commandId":"diff-late", "threadId":"t",
            "turnId":"turn-late", "checkpointTurnCount":5,
            "checkpointRef":crate::production::orchestration_effects::checkpoint_ref("t", 5),
            "status":"missing", "files":[], "assistantMessageId":"a-late",
            "completedAt":TIME, "createdAt":TIME
        })))
        .await
        .unwrap();
    fixture.rewind.reopen_release.notify_one();
    fixture.event("thread.reverted", |_| true).await;
    // Turn 5 has no checkpoint before it, so it is never `ready`; its own ref is still captured.
    let captured = format!(
        "{}:tracked.txt",
        crate::production::orchestration_effects::checkpoint_ref("t", 5)
    );
    let contents = timeout(Duration::from_secs(10), async {
        loop {
            if let Some(contents) = fixture.git_output(&["show", &captured]) {
                return contents;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the late checkpoint is captured");
    assert_eq!(
        contents, "one\n",
        "the late checkpoint was captured before the revert restored the files"
    );
    fixture.shutdown().await;
}

/// A message sent while a revert runs is neither started during it nor lost: it waits, then
/// delivers once the revert is recorded.
#[tokio::test]
async fn a_message_sent_during_a_revert_waits_for_it_then_delivers() {
    let mut fixture = RevertFixture::new().await;
    let (service, mut routes) = service(&fixture.engine);
    fixture.revert().await;
    fixture.rewind.entered.notified().await;

    enqueue(&fixture.engine, "during", false).await;
    service.wake();
    quiet(&mut routes).await;
    assert_eq!(
        fixture
            .engine
            .repositories()
            .provider_turn_claims_for_test(),
        0,
        "delivery skips the reverting thread instead of claiming its message"
    );

    fixture.rewind.release.notify_one();
    fixture.event("thread.reverted", |_| true).await;
    received(&mut routes, "during").await;
    service.shutdown().await;
    assert_eq!(
        row(&fixture.engine, "during").await.state,
        TurnDeliveryState::Delivered
    );
    fixture.shutdown().await;
}

/// A revert that reopens a suspended session makes it `starting` and then `ready`. A message
/// queued meanwhile is not promoted by that `ready` while the revert runs, and is delivered
/// after it in queue order.
#[tokio::test]
async fn a_message_queued_while_a_revert_reopens_the_session_delivers_after_it() {
    let mut fixture = RevertFixture::new().await;
    let (service, mut routes) = service(&fixture.engine);
    fixture.revert().await;
    fixture.rewind.entered.notified().await;

    session(&fixture.engine, "starting", "reopening").await;
    enqueue(&fixture.engine, "queued-1", true).await;
    enqueue(&fixture.engine, "queued-2", true).await;
    session(&fixture.engine, "ready", "reopened").await;
    quiet(&mut routes).await;
    assert_eq!(
        row(&fixture.engine, "queued-1").await.state,
        TurnDeliveryState::Queued
    );

    fixture.rewind.release.notify_one();
    fixture.event("thread.reverted", |_| true).await;
    received(&mut routes, "queued-1").await;
    quiet(&mut routes).await;
    session(&fixture.engine, "running", "running-1").await;
    session(&fixture.engine, "ready", "ready-1").await;
    received(&mut routes, "queued-2").await;
    service.shutdown().await;
    fixture.shutdown().await;
}

/// Effects callbacks for chats that all share one checkout, whose rewind preparations (provider
/// reopens) wait until `release` gets a permit. `log` records the rewinds and, from the test's
/// router, the deliveries, in the order they happen.
struct SharedCheckoutReverts {
    cwd: PathBuf,
    prepared: std::sync::Mutex<Vec<String>>,
    release: tokio::sync::Semaphore,
    log: Arc<std::sync::Mutex<Vec<String>>>,
}

impl crate::production::orchestration_effects::OrchestrationEffectCallbacks
    for SharedCheckoutReverts
{
    fn workspace_for_thread<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async move { Ok(Some(self.cwd.clone())) })
    }

    fn prepare_provider_rewind<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.prepared.lock().unwrap().push(thread_id.to_owned());
            // The permit goes back at once, so every preparation passes once one is added.
            drop(self.release.acquire().await.unwrap());
            Ok(())
        })
    }

    fn rollback_provider<'a>(
        &'a self,
        thread_id: &'a str,
        _turns: i64,
        _rewind_key: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<
        'a,
        crate::production::orchestration_effects::ProviderRewind,
    > {
        Box::pin(async move {
            self.log.lock().unwrap().push(format!("rewind {thread_id}"));
            Ok(crate::production::orchestration_effects::ProviderRewind::Rewound)
        })
    }

    fn stop_provider<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn close_terminals<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn refresh_workspace<'a>(
        &'a self,
        _cwd: &'a Path,
    ) -> crate::production::orchestration_effects::BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

/// A turn's end holds its thread's queued follow-up until the effects worker has captured the
/// checkout as that turn left it, so the follow-up's edits never land in its checkpoint. With
/// no effects worker, nothing is held.
#[tokio::test]
async fn a_queued_follow_up_waits_for_the_ended_turns_checkpoint() {
    use crate::production::orchestration_effects::{TurnEnd, record_turn_end};
    let fixture = RevertFixture::new().await;
    let engine = fixture.engine.clone();
    session(&engine, "running", "running-third").await;
    enqueue(&engine, "queued", true).await;
    let (service, mut routes) = service(&engine);
    quiet(&mut routes).await;
    std::fs::write(fixture.rewind.cwd.join("tracked.txt"), "three\n").unwrap();
    record_turn_end(
        &engine,
        "t",
        "turn-3",
        TIME,
        TurnEnd::Live,
        Some(&fixture.rewind.cwd),
    )
    .await
    .unwrap();
    session(&engine, "ready", "ready-third").await;
    received(&mut routes, "queued").await;
    service.shutdown().await;

    let events = engine.read_events(0).await.unwrap();
    let position = |matches: &dyn Fn(&crate::persistence::OrchestrationEvent) -> bool| {
        events
            .iter()
            .find(|event| matches(event))
            .map(|event| event.sequence)
    };
    let recorded = position(&|event| {
        event.event.event_type == "thread.turn-diff-completed"
            && event.event.payload["turnId"] == "turn-3"
            && event.event.payload["status"] == "ready"
    })
    .expect("the ended turn's checkpoint is recorded");
    let promoted = position(&|event| {
        event.event.event_type == "thread.turn-start-requested"
            && event.event.payload["messageId"] == "queued"
    })
    .expect("the follow-up starts");
    assert!(recorded < promoted, "{recorded} >= {promoted}");
    let checkpoint = engine
        .repositories()
        .get_checkpoint("t".to_owned(), 3)
        .await
        .unwrap()
        .expect("checkpoint 3");
    assert_eq!(checkpoint.files[0]["path"], "tracked.txt");

    fixture.shutdown().await;
    assert_eq!(engine.hold_turns_for_checkpoint("t", "turn-4"), None);
    assert!(!engine.turns_held_for_checkpoint("t"));
}

/// Each ended turn holds the thread for itself: when two turns end before the effects worker
/// catches up, capturing the first does not release the second's hold. Deleting the thread
/// releases them all.
#[tokio::test]
async fn each_ended_turn_holds_the_queue_until_its_own_checkpoint() {
    let engine = engine().await;
    engine.set_checkpoint_hold_limit(Some(Duration::from_secs(60)));
    engine.hold_turns_for_checkpoint("t", "turn-1");
    engine.hold_turns_for_checkpoint("t", "turn-2");
    engine.release_checkpoint_hold("t", "turn-1");
    assert!(engine.turns_held_for_checkpoint("t"));
    engine.release_checkpoint_hold("t", "turn-2");
    assert!(!engine.turns_held_for_checkpoint("t"));

    engine.hold_turns_for_checkpoint("t", "turn-3");
    engine.hold_turns_for_checkpoint("other", "turn-1");
    engine.release_thread_checkpoint_holds("t");
    assert!(!engine.turns_held_for_checkpoint("t"));
    assert!(engine.turns_held_for_checkpoint("other"));
    engine.set_checkpoint_hold_limit(None);
    assert!(!engine.turns_held_for_checkpoint("other"));
    engine.shutdown().await;
}

/// A direct start (the composer, MCP `send_message`, `start_thread` and panel messages, which
/// all dispatch `thread.turn.start`) and **Send now** (`thread.turn.promote`) are delivered only
/// once the checkpoint of the thread's last turn is recorded, like a queued follow-up: no turn
/// edits the checkout before it is captured.
#[tokio::test]
async fn direct_starts_and_send_now_wait_for_the_ended_turns_checkpoint() {
    for send_now in [false, true] {
        let engine = engine().await;
        engine.set_checkpoint_hold_limit(Some(Duration::from_secs(60)));
        session(&engine, "running", "running").await;
        let held = engine.hold_turns_for_checkpoint("t", "running");
        assert!(held.is_some());
        session(&engine, "ready", "ready").await;
        let (service, mut routes) = service(&engine);
        if send_now {
            enqueue(&engine, "next", true).await;
            engine.dispatch(command(json!({"type":"thread.turn.promote", "commandId":"send-now", "threadId":"t", "messageId":"next", "createdAt":TIME}))).await.unwrap();
        } else {
            enqueue(&engine, "next", false).await;
        }
        quiet(&mut routes).await;
        assert_eq!(row(&engine, "next").await.attempts, 0);
        engine.release_checkpoint_hold("t", "running");
        received(&mut routes, "next").await;
        service.shutdown().await;
        engine.shutdown().await;
    }
}

/// A capture still pending when its hold expires (Git hung, or a long backlog) is given up:
/// the thread's turns go on, the turn's checkpoint is recorded stale and never `ready`, and the
/// next turn's baseline does not stand in for it, since the checkout may hold the next turn's
/// edits by then.
#[tokio::test]
async fn an_expired_hold_records_the_pending_checkpoint_stale_and_releases_the_thread() {
    use crate::production::orchestration_effects::{
        EffectsOptions, TurnEnd, checkpoint_ref, record_turn_end,
    };
    let fixture = RevertFixture::with_options(EffectsOptions {
        checkpoint_hold_limit: Duration::from_millis(300),
        ..EffectsOptions::default()
    })
    .await;
    let engine = fixture.engine.clone();
    session(&engine, "running", "running-third").await;
    enqueue(&engine, "queued", true).await;
    let (service, mut routes) = service(&engine);
    quiet(&mut routes).await;
    std::fs::write(
        fixture.rewind.cwd.join("tracked.txt"),
        "three
",
    )
    .unwrap();
    fixture
        .rewind
        .hold_workspace
        .store(true, std::sync::atomic::Ordering::SeqCst);
    record_turn_end(
        &engine,
        "t",
        "turn-3",
        TIME,
        TurnEnd::Live,
        Some(&fixture.rewind.cwd),
    )
    .await
    .unwrap();
    session(&engine, "ready", "ready-third").await;
    // The worker is stuck on the capture; the hold expires and the follow-up goes.
    received(&mut routes, "queued").await;
    service.shutdown().await;
    assert!(engine.checkpoint_is_stale("t", "turn-3"));

    // The worker then gets past the capture: it records nothing for the stale turn.
    fixture.rewind.workspace_release.notify_one();
    assert!(fixture.other_thread_gets_its_baseline().await);
    let checkpoint = engine
        .repositories()
        .get_checkpoint("t".to_owned(), 3)
        .await
        .unwrap()
        .expect("checkpoint 3");
    assert_eq!(checkpoint.status, "error");
    assert_eq!(
        fixture.git_output(&["rev-parse", "--verify", "--quiet", &checkpoint_ref("t", 3)]),
        None
    );
    assert_eq!(capture_failures(&engine, "turn-3").await, 1);
    fixture.shutdown().await;
}

/// A stale capture's ref that Git could not delete stays behind its `error` row. The next
/// turn's capture is never read against it: that turn is not `ready`, so it is neither a diff
/// nor a revert target.
#[tokio::test]
async fn a_stale_captures_leftover_ref_never_makes_the_next_turn_ready() {
    use crate::production::orchestration_effects::{
        TurnEnd, capture_checkpoint, checkpoint_ref, record_turn_end,
    };
    let mut fixture = RevertFixture::new().await;
    let engine = fixture.engine.clone();
    let cwd = fixture.rewind.cwd.clone();
    // Turn 3 was given up, and its ref was left behind.
    std::fs::write(cwd.join("tracked.txt"), "stale three\n").unwrap();
    capture_checkpoint(&cwd, "t", 3).await.unwrap();
    engine
        .dispatch(command(json!({
            "type":"thread.turn.diff.complete", "commandId":"diff-stale-3", "threadId":"t",
            "turnId":"turn-3", "checkpointTurnCount":3, "checkpointRef":checkpoint_ref("t", 3),
            "status":"error", "files":[], "assistantMessageId":null,
            "completedAt":TIME, "createdAt":TIME
        })))
        .await
        .unwrap();

    std::fs::write(cwd.join("tracked.txt"), "four\n").unwrap();
    record_turn_end(&engine, "t", "turn-4", TIME, TurnEnd::Live, Some(&cwd))
        .await
        .unwrap();
    timeout(Duration::from_secs(10), async {
        while capture_failures(&engine, "turn-4").await == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("turn 4's checkpoint is reported unreadable");
    let checkpoint = engine
        .repositories()
        .get_checkpoint("t".to_owned(), 4)
        .await
        .unwrap()
        .expect("checkpoint 4");
    assert_eq!(checkpoint.status, "missing");

    engine.dispatch(command(json!({"type":"thread.checkpoint.revert", "commandId":"revert-4", "threadId":"t", "turnCount":4, "createdAt":TIME}))).await.unwrap();
    let refused = fixture
        .event("thread.activity-appended", |payload| {
            payload["activity"]["kind"] == "checkpoint.revert.failed"
        })
        .await;
    assert!(
        refused.event.payload["activity"]["payload"]["detail"]
            .as_str()
            .unwrap()
            .contains("no captured checkpoint"),
        "{}",
        refused.event.payload
    );
    assert_eq!(
        std::fs::read_to_string(cwd.join("tracked.txt")).unwrap(),
        "four\n"
    );
    fixture.shutdown().await;
}

/// The `checkpoint.capture.failed` activities of `turn_id` on thread `t`.
async fn capture_failures(engine: &OrchestrationEngine, turn_id: &str) -> usize {
    crate::orchestration::load_snapshot(&engine.repositories())
        .await
        .unwrap()
        .activities
        .into_iter()
        .filter(|activity| {
            activity.kind == "checkpoint.capture.failed"
                && activity.turn_id.as_deref() == Some(turn_id)
        })
        .count()
}

/// Expiry and completion decide once per turn: a capture the worker has taken is recorded
/// `ready`, and an expiry that falls while the worker still records it (here, while it
/// refreshes the workspace) neither reports a failure nor marks it stale.
#[tokio::test]
async fn an_expiry_during_a_taken_capture_reports_nothing_and_the_turn_is_ready() {
    // Longer than the capture takes under load (it spawns Git), so the worker takes it before
    // the expiry. The expiry is a wall-clock timer from the turn's end that nothing can
    // observe, so the test waits it out and the limit is what its duration is.
    const HOLD_LIMIT: Duration = Duration::from_secs(15);
    use crate::production::orchestration_effects::{EffectsOptions, TurnEnd, record_turn_end};
    let fixture = RevertFixture::with_options(EffectsOptions {
        checkpoint_hold_limit: HOLD_LIMIT,
        ..EffectsOptions::default()
    })
    .await;
    let engine = fixture.engine.clone();
    std::fs::write(fixture.rewind.cwd.join("tracked.txt"), "three\n").unwrap();
    fixture
        .rewind
        .hold_refresh
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let ended = tokio::time::Instant::now();
    record_turn_end(
        &engine,
        "t",
        "turn-3",
        TIME,
        TurnEnd::Live,
        Some(&fixture.rewind.cwd),
    )
    .await
    .unwrap();
    timeout(HOLD_LIMIT, fixture.rewind.refresh_entered.notified())
        .await
        .expect("the worker takes the capture before the hold expires");
    // The capture is taken; the hold limit passes while the worker still records it.
    tokio::time::sleep_until(ended + HOLD_LIMIT + Duration::from_millis(500)).await;
    fixture.rewind.refresh_release.notify_one();
    let ready = timeout(Duration::from_secs(10), async {
        loop {
            let checkpoint = engine
                .repositories()
                .get_checkpoint("t".to_owned(), 3)
                .await
                .unwrap()
                .expect("checkpoint 3");
            if checkpoint.status != "missing" {
                return checkpoint;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the turn's checkpoint is recorded");
    assert_eq!(ready.status, "ready");
    assert!(!engine.checkpoint_is_stale("t", "turn-3"));
    assert_eq!(capture_failures(&engine, "turn-3").await, 0);
    fixture.shutdown().await;
}

/// A turn given up as stale stays so across a restart: rebuilt from persistence, the engine
/// keeps its checkpoint `error`, the next turn's baseline does not write its ref, a missing
/// record of it captures nothing, and a revert to it is refused before anything changes.
#[tokio::test]
async fn a_stale_turn_is_never_a_revert_target_after_a_restart() {
    use crate::production::orchestration_effects::{
        EffectsOptions, OrchestrationEffects, TurnEnd, checkpoint_ref, record_turn_end,
    };
    let state = tempfile::tempdir().unwrap();
    let database_path = state.path().join("stale.sqlite3");
    let options = EffectsOptions {
        checkpoint_hold_limit: Duration::from_millis(200),
        ..EffectsOptions::default()
    };
    let fixture =
        RevertFixture::on(Database::create_new(&database_path).await.unwrap(), options).await;
    let engine = fixture.engine.clone();
    std::fs::write(fixture.rewind.cwd.join("tracked.txt"), "three\n").unwrap();
    fixture
        .rewind
        .hold_workspace
        .store(true, std::sync::atomic::Ordering::SeqCst);
    record_turn_end(
        &engine,
        "t",
        "turn-3",
        TIME,
        TurnEnd::Live,
        Some(&fixture.rewind.cwd),
    )
    .await
    .unwrap();
    timeout(Duration::from_secs(10), async {
        while engine
            .repositories()
            .get_checkpoint("t".to_owned(), 3)
            .await
            .unwrap()
            .is_none_or(|checkpoint| checkpoint.status != "error")
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the stale checkpoint is recorded");
    fixture.rewind.workspace_release.notify_one();
    let RevertFixture {
        engine,
        effects,
        rewind,
        _repository: repository,
        ..
    } = fixture;
    effects.shutdown().await;
    let database = engine.repositories().database().clone();
    engine.shutdown().await;
    database.checkpoint_wal().await.unwrap();
    drop(database);

    // The later checkout, which a restart must not take for turn 3's end state.
    std::fs::write(rewind.cwd.join("tracked.txt"), "later\n").unwrap();
    let engine = OrchestrationEngine::start(
        Database::open_existing(&database_path).await.unwrap(),
        EngineOptions::default(),
    )
    .await
    .unwrap();
    assert!(!engine.checkpoint_is_stale("t", "turn-3"));
    let effects = OrchestrationEffects::start(
        engine.clone(),
        Arc::new(crate::git::GitRepository::default()),
        rewind.clone(),
        options,
    )
    .await
    .unwrap();
    let mut events = engine.subscribe_events();
    session(&engine, "ready", "after-restart").await;
    // A replayed missing record, and the next turn's baseline.
    engine
        .dispatch(command(json!({
            "type":"thread.turn.diff.complete", "commandId":"diff-replayed", "threadId":"t",
            "turnId":"turn-3", "checkpointTurnCount":3, "checkpointRef":checkpoint_ref("t", 3),
            "status":"missing", "files":[], "assistantMessageId":null,
            "completedAt":TIME, "createdAt":TIME
        })))
        .await
        .unwrap();
    engine.dispatch(command(json!({"type":"thread.turn.start", "commandId":"turn-4", "threadId":"t", "message":{"messageId":"m-4", "role":"user", "text":"next", "attachments":[]}, "createdAt":TIME}))).await.unwrap();
    engine.dispatch(command(json!({"type":"thread.checkpoint.revert", "commandId":"revert-stale", "threadId":"t", "turnCount":3, "createdAt":TIME}))).await.unwrap();
    let refused = timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.event.event_type == "thread.activity-appended"
                && event.event.payload["activity"]["kind"] == "checkpoint.revert.failed"
            {
                return event.event.payload["activity"]["payload"]["detail"]
                    .as_str()
                    .unwrap()
                    .to_owned();
            }
        }
    })
    .await
    .expect("the revert is refused");
    assert!(refused.contains("no captured checkpoint"), "{refused}");
    let checkpoint = engine
        .repositories()
        .get_checkpoint("t".to_owned(), 3)
        .await
        .unwrap()
        .expect("checkpoint 3");
    assert_eq!(checkpoint.status, "error");
    let probe = |args: &[&str]| {
        let config = IsolatedGitConfig::new();
        let mut command = std::process::Command::new("git");
        config.apply_to_command(&mut command);
        command
            .args(args)
            .current_dir(&rewind.cwd)
            .output()
            .unwrap()
    };
    assert!(
        !probe(&["rev-parse", "--verify", "--quiet", &checkpoint_ref("t", 3)])
            .status
            .success()
    );
    assert_eq!(
        std::fs::read_to_string(rewind.cwd.join("tracked.txt")).unwrap(),
        "later\n"
    );
    assert_eq!(rewind.rewinds.load(std::sync::atomic::Ordering::SeqCst), 0);
    effects.shutdown().await;
    engine.shutdown().await;
    drop(repository);
}

/// Five chats sharing one checkout revert, one more than are prepared at once, while every
/// provider reopen is slow. They still restore in the order they were asked for, and a message
/// sent to the fifth chat after its revert is delivered only once that revert is done.
#[tokio::test]
async fn reverts_past_the_preparation_bound_restore_in_request_order_before_later_messages() {
    use crate::production::orchestration_effects::{
        EffectsOptions, OrchestrationEffects, capture_checkpoint, checkpoint_ref,
    };
    const THREADS: [&str; 5] = ["t", "b", "c", "d", "e"];
    let repository = revert_checkout();
    let cwd = repository.path().to_path_buf();
    let engine = engine().await;
    for thread in &THREADS[1..] {
        engine.dispatch(command(json!({"type":"thread.create", "commandId":format!("thread-{thread}"), "threadId":thread, "projectId":"p", "title":"Sibling", "runtimeMode":"full-access", "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "createdAt":TIME}))).await.unwrap();
    }
    for thread in THREADS {
        for turn_count in 0..=2 {
            std::fs::write(cwd.join("tracked.txt"), format!("{thread} {turn_count}\n")).unwrap();
            capture_checkpoint(&cwd, thread, turn_count).await.unwrap();
            if turn_count > 0 {
                engine.dispatch(command(json!({
                    "type":"thread.turn.diff.complete", "commandId":format!("diff-{thread}-{turn_count}"),
                    "threadId":thread, "turnId":format!("{thread}-turn-{turn_count}"),
                    "checkpointTurnCount":turn_count, "checkpointRef":checkpoint_ref(thread, turn_count),
                    "status":"ready", "files":[], "assistantMessageId":format!("a-{thread}-{turn_count}"),
                    "completedAt":TIME, "createdAt":TIME
                }))).await.unwrap();
            }
        }
    }
    let log = Arc::new(std::sync::Mutex::new(Vec::new()));
    let callbacks = Arc::new(SharedCheckoutReverts {
        cwd: cwd.clone(),
        prepared: std::sync::Mutex::new(Vec::new()),
        release: tokio::sync::Semaphore::new(0),
        log: log.clone(),
    });
    let effects = OrchestrationEffects::start(
        engine.clone(),
        Arc::new(crate::git::GitRepository::default()),
        callbacks.clone(),
        EffectsOptions::default(),
    )
    .await
    .unwrap();
    let (sender, mut routes) = mpsc::unbounded_channel();
    let router: DeliveryRouter = {
        let log = log.clone();
        Arc::new(move |command| {
            let id = command.command_id().to_owned();
            log.lock().unwrap().push(format!("deliver {id}"));
            sender.send(id).unwrap();
            Box::pin(async { Ok(()) })
        })
    };
    let service = TurnDeliveryService::start_with_router(engine.clone(), 1, router);
    let mut events = engine.subscribe_events();

    for thread in THREADS {
        engine.dispatch(command(json!({"type":"thread.checkpoint.revert", "commandId":format!("revert-{thread}"), "threadId":thread, "turnCount":1, "createdAt":TIME}))).await.unwrap();
    }
    // Four reverts are being prepared, and the fifth already holds its chat.
    timeout(Duration::from_secs(10), async {
        while callbacks.prepared.lock().unwrap().len() < 4 || !engine.thread_turns_reserved("e") {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("four reverts are prepared and the fifth holds its chat");
    enqueue_for(&engine, "e", "e-after", false).await;
    service.wake();
    quiet(&mut routes).await;

    callbacks.release.add_permits(1);
    timeout(Duration::from_secs(10), async {
        let mut reverted = 0;
        while reverted < THREADS.len() {
            let event = events.recv().await.unwrap();
            if event.event.event_type == "thread.reverted" {
                reverted += 1;
            }
        }
    })
    .await
    .expect("every revert is recorded");
    received(&mut routes, "e-after").await;

    assert_eq!(
        log.lock().unwrap().as_slice(),
        [
            "rewind t",
            "rewind b",
            "rewind c",
            "rewind d",
            "rewind e",
            "deliver e-after"
        ],
        "the reverts restored out of request order, or the later message went first"
    );
    assert_eq!(
        std::fs::read_to_string(cwd.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "e 1\n",
        "the last revert asked for did not restore last"
    );
    service.shutdown().await;
    effects.shutdown().await;
    engine.shutdown().await;
}

/// Delivery whose provider accepts thread `t`'s message `in-flight` only when `accept` is
/// notified, and then reports the turn running. Returns once that delivery is in flight.
async fn deliver_in_flight(
    engine: &OrchestrationEngine,
) -> (
    TurnDeliveryService,
    Arc<Notify>,
    mpsc::UnboundedReceiver<String>,
) {
    enqueue(engine, "in-flight", false).await;
    let (sender, mut routes) = mpsc::unbounded_channel();
    let accept = Arc::new(Notify::new());
    let router: DeliveryRouter = {
        let engine = engine.clone();
        let accept = accept.clone();
        Arc::new(move |command| {
            let (engine, accept, sender) = (engine.clone(), accept.clone(), sender.clone());
            Box::pin(async move {
                sender.send(command.command_id().to_owned()).unwrap();
                accept.notified().await;
                session(&engine, "running", "accepted-turn").await;
                Ok(())
            })
        })
    };
    let service = TurnDeliveryService::start_with_router(engine.clone(), 1, router);
    received(&mut routes, "in-flight").await;
    (service, accept, routes)
}

/// A revert waiting on thread `t`'s delivery does not hold the effects worker: another thread's
/// turn still gets its checkpoint baseline meanwhile.
#[tokio::test]
async fn a_revert_waiting_for_a_delivery_does_not_delay_another_threads_checkpoint() {
    let mut fixture = RevertFixture::new().await;
    let (service, accept, _routes) = deliver_in_flight(&fixture.engine).await;
    fixture.revert().await;

    assert!(
        fixture.other_thread_gets_its_baseline().await,
        "thread b's checkpoint baseline waited behind thread t's revert"
    );
    assert_eq!(
        fixture
            .rewind
            .rewinds
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the revert still waits for thread t's delivery"
    );

    accept.notify_one();
    fixture
        .event("thread.activity-appended", |payload| {
            payload["activity"]["kind"] == "checkpoint.revert.failed"
        })
        .await;
    service.shutdown().await;
    fixture.shutdown().await;
}

/// A revert requested while a message is being delivered waits for that delivery instead of
/// rewinding under it, then refuses because the delivered turn is running.
#[tokio::test]
async fn a_revert_waits_for_a_delivery_in_flight_then_refuses_its_running_turn() {
    let mut fixture = RevertFixture::new().await;
    let (service, accept, _routes) = deliver_in_flight(&fixture.engine).await;

    fixture.revert().await;
    assert!(
        timeout(
            Duration::from_millis(200),
            fixture.rewind.entered.notified()
        )
        .await
        .is_err(),
        "the revert rewound the provider while a message was being delivered"
    );

    accept.notify_one();
    let failure = fixture
        .event("thread.activity-appended", |payload| {
            payload["activity"]["kind"] == "checkpoint.revert.failed"
        })
        .await;
    assert!(
        failure.event.payload["activity"]["payload"]["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("Interrupt the current turn")),
        "{failure:?}"
    );
    assert_eq!(
        fixture
            .rewind
            .rewinds
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    service.shutdown().await;
    fixture.shutdown().await;
}
