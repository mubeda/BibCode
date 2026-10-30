//! The F0 foundation (#139): stream invocation, recorded outcomes and their live controls,
//! capability sets, wait slots kept for waits, and the `interrupt_turn` fix, end to end.
//!
//! Git and pull request handlers are faked under their real tags, so scope and admission run
//! as they do for the real ones. A fake stream's payload scripts it: `events` to send, an
//! optional `error` chunk, `delayMs` before the first, and `hold` to wait, after the events,
//! until it is cancelled, its receiver closes, or the test releases it (then it finishes).

use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::Notify;

use super::*;
use crate::{
    mcp::{
        control::{Family, ProgressSink, ToolCall, ToolFuture, ToolSpec},
        protocol::tool_result,
        tools::threads,
    },
    rpc::{RpcSessionContext, STREAM_ENDED_TAG},
};

#[derive(Clone, Default)]
struct Fake {
    runs: Arc<AtomicUsize>,
    /// Streams whose receiver closed or whose token fired while they held.
    stopped: Arc<AtomicUsize>,
    release: Arc<Notify>,
}

impl Fake {
    async fn harness(&self) -> Harness {
        let fake = self.clone();
        Harness::with_methods(move |registry| {
            for tag in ["gitManager.runOperation", "git.runStackedAction"] {
                let fake = fake.clone();
                registry.register_stream(tag, move |request, cancellation| {
                    fake.runs.fetch_add(1, Ordering::SeqCst);
                    let (sender, receiver) = tokio::sync::mpsc::channel(8);
                    let fake = fake.clone();
                    tokio::spawn(async move {
                        let payload = request.payload;
                        if let Some(delay) = payload["delayMs"].as_u64() {
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                        for event in payload["events"].as_array().cloned().unwrap_or_default() {
                            if sender.send(Ok(vec![event])).await.is_err() {
                                fake.stopped.fetch_add(1, Ordering::SeqCst);
                                return;
                            }
                        }
                        if !payload["error"].is_null() {
                            let _ = sender.send(Err(payload["error"].clone())).await;
                        }
                        if payload["hold"] == true {
                            tokio::select! {
                                () = cancellation.cancelled() => {
                                    fake.stopped.fetch_add(1, Ordering::SeqCst);
                                }
                                () = sender.closed() => {
                                    fake.stopped.fetch_add(1, Ordering::SeqCst);
                                }
                                () = fake.release.notified() => {
                                    let _ = sender
                                        .send(Ok(vec![json!({ "_tag": "finished", "operation": "push", "message": "Pushed." })]))
                                        .await;
                                }
                            }
                        }
                    });
                    receiver
                });
            }
        })
        .await
    }

    fn runs(&self) -> usize {
        self.runs.load(Ordering::SeqCst)
    }
}

fn finished() -> Value {
    json!({ "_tag": "finished", "operation": "push", "message": "Pushed." })
}

fn context(harness: &Harness, agent: &ClientPrincipal) -> RpcSessionContext {
    RpcSessionContext::authenticated(agent.principal.clone(), harness.auth.clone())
}

async fn stream(
    harness: &Harness,
    agent: &ClientPrincipal,
    tag: &str,
    payload: Value,
) -> Result<crate::rpc::StreamOutcome, Value> {
    harness
        .control
        .registry()
        .invoke_local_stream(
            tag,
            payload,
            context(harness, agent),
            CancellationToken::new(),
            Duration::from_secs(5),
        )
        .await
}

#[tokio::test]
async fn a_stream_ends_in_its_schemas_success_or_typed_failure_never_its_last_chunk() {
    let fake = Fake::default();
    let harness = fake.harness().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let operation = "gitManager.runOperation";
    let stacked = "git.runStackedAction";
    let output = |text: &str| json!({ "_tag": "output", "operation": "push", "stream": "stderr", "text": text });

    let done = stream(&harness, &agent, operation, json!({ "events": [
        { "_tag": "started", "operation": "push" }, output("Counting"), output("Writing"), finished(),
    ] }))
    .await
    .unwrap();
    assert_eq!(done.terminal["_tag"], "finished");
    assert_eq!(done.output, ["Counting", "Writing"]);
    assert_eq!(done.ignored, 1);

    let failed = stream(&harness, &agent, operation, json!({ "events": [
        output("rejected"),
        { "_tag": "failed", "operation": "push", "code": "non-fast-forward", "message": "Rejected.", "blocked": null },
        finished(),
    ] }))
    .await
    .unwrap_err();
    assert_eq!(failed["_tag"], "GitOperationFailedError");
    assert_eq!(failed["code"], "non-fast-forward");
    assert!(failed.get("blocked").is_some());

    let action = |kind: &str| json!({ "actionId": "a", "cwd": "/w", "action": "commit_push_pr", "kind": kind });
    let mut finished_action = action("action_finished");
    finished_action["result"] = json!({ "pr": { "number": 7 } });
    let done = stream(
        &harness,
        &agent,
        stacked,
        json!({ "events": [
        action("action_started"),
        { "kind": "phase_started", "phase": "commit" },
        { "kind": "hook_output", "text": "lint ok" },
        finished_action,
    ] }),
    )
    .await
    .unwrap();
    assert_eq!(done.terminal["result"]["pr"]["number"], 7);
    assert_eq!(
        done.output,
        ["action_started", "phase_started commit", "lint ok"]
    );

    let mut failed_action = action("action_failed");
    failed_action["phase"] = json!("push");
    failed_action["message"] = json!("Push failed.");
    let failed = stream(
        &harness,
        &agent,
        stacked,
        json!({ "events": [failed_action] }),
    )
    .await
    .unwrap_err();
    assert_eq!(failed["_tag"], "GitActionFailedError");
    assert_eq!(failed["phase"], "push");

    // An error chunk is a typed failure too.
    let failed = stream(
        &harness,
        &agent,
        stacked,
        json!({
            "events": [action("action_started")],
            "error": { "_tag": "WorkspaceUnavailableError", "message": "Gone." },
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(failed["_tag"], "WorkspaceUnavailableError");

    // A close before any terminal event is never success.
    for (tag, events) in [
        (operation, json!([output("half")])),
        (stacked, json!([action("action_started")])),
        (operation, json!([])),
    ] {
        let ended = stream(&harness, &agent, tag, json!({ "events": events }))
            .await
            .unwrap_err();
        assert_eq!(ended["_tag"], STREAM_ENDED_TAG, "{tag}");
        assert_eq!(ended["reason"], "closed");
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn an_output_flood_is_capped_and_a_cancel_drops_the_receiver() {
    let fake = Fake::default();
    let harness = fake.harness().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut events: Vec<Value> = (0..300)
        .map(|index| json!({ "_tag": "output", "operation": "fetch", "stream": "stdout", "text": format!("{index}:{}", "x".repeat(400)) }))
        .collect();
    events.push(finished());
    let done = stream(
        &harness,
        &agent,
        "gitManager.runOperation",
        json!({ "events": events }),
    )
    .await
    .unwrap();
    assert!(done.output.len() <= 64);
    assert!(
        done.output
            .iter()
            .map(|line| line.chars().count())
            .sum::<usize>()
            <= 16_000
    );
    assert_eq!(done.output.len() + done.dropped_output, 300);
    assert!(
        done.output.last().unwrap().starts_with("299:"),
        "keeps the newest"
    );

    let cancellation = CancellationToken::new();
    let held = harness.control.registry().invoke_local_stream(
        "gitManager.runOperation",
        json!({ "events": [], "hold": true }),
        context(&harness, &agent),
        cancellation.clone(),
        Duration::from_secs(30),
    );
    let (ended, ()) = tokio::join!(held, async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancellation.cancel();
    });
    let ended = ended.unwrap_err();
    assert_eq!(ended["_tag"], STREAM_ENDED_TAG);
    assert_eq!(ended["reason"], "cancelled");
    tokio::time::timeout(Duration::from_secs(5), async {
        while fake.stopped.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the handler saw the cancel");

    // The budget ends a stream that never finishes the same way.
    let ended = harness
        .control
        .registry()
        .invoke_local_stream(
            "gitManager.runOperation",
            json!({ "hold": true }),
            context(&harness, &agent),
            CancellationToken::new(),
            Duration::from_millis(100),
        )
        .await
        .unwrap_err();
    assert_eq!(ended["reason"], "budget");
    harness.shutdown().await;
}

#[tokio::test]
async fn a_stream_method_without_its_scope_is_refused_before_the_handler_runs() {
    let fake = Fake::default();
    let harness = fake.harness().await;
    let link = crate::auth::issue_mcp_pairing_link(
        &harness.repositories,
        "MCP · reader".into(),
        "read-only",
        &[],
    )
    .await
    .unwrap();
    let session = harness
        .auth
        .exchange_bootstrap(
            &link.credential,
            Some(vec!["orchestration:read".to_owned()]),
            ClientMetadata::default(),
            None,
            SessionTransport::Plain,
        )
        .await
        .expect("a narrower exchange");
    let reader = harness.control.authenticate(&session.token).await.unwrap();
    let refused = stream(
        &harness,
        &reader,
        "gitManager.runOperation",
        json!({ "events": [finished()] }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused["_tag"], "EnvironmentAuthorizationError");
    assert_eq!(fake.runs(), 0);
    // A unary method without a stream end is refused by name.
    let refused = stream(&harness, &reader, "gitManager.commit", json!({}))
        .await
        .unwrap_err();
    assert_eq!(refused["_tag"], "RpcMethodNotFoundError");
    harness.shutdown().await;
}

/// A keyed or unkeyed `git_push` stand-in: one `gitManager.runOperation` stream, recorded.
async fn push(
    harness: &Harness,
    agent: &ClientPrincipal,
    arguments: Value,
    stream: Value,
    cancellation: CancellationToken,
) -> Value {
    let Value::Object(arguments) = arguments else {
        panic!("arguments are an object");
    };
    let call = ToolCall {
        control: &harness.control,
        principal: agent,
        arguments: &arguments,
        cancellation,
    };
    let payload = stream.clone();
    call.recorded("git_push", &stream, move |owned| async move {
        let outcome = owned
            .invoke_stream("gitManager.runOperation", payload)
            .await?;
        Ok(tool_result(
            json!({ "message": outcome.terminal["message"], "output": outcome.output }),
            &[],
        ))
    })
    .await
    .unwrap_or_else(|failure| failure)
}

fn keyed(id: &str) -> Value {
    json!({ "threadId": "t", "remote": "origin", "clientRequestId": id })
}

fn reason(result: &Value) -> &str {
    assert_eq!(error_tag(result), "McpOutcomeUnknownError", "{result}");
    result["structuredContent"]["error"]["reason"]
        .as_str()
        .unwrap_or_default()
}

#[tokio::test]
async fn one_key_runs_once_sequentially_and_concurrently_and_retries_read_the_outcome() {
    let fake = Fake::default();
    let harness = fake.harness().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let ok = json!({ "events": [finished()] });

    let first = push(
        &harness,
        &agent,
        keyed("seq"),
        ok.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(structured(&first)["message"], "Pushed.");
    let second = push(
        &harness,
        &agent,
        keyed("seq"),
        ok.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(first, second);
    assert_eq!(fake.runs(), 1);

    let slow = json!({ "delayMs": 200, "events": [finished()] });
    let (a, b) = tokio::join!(
        push(
            &harness,
            &agent,
            keyed("both"),
            slow.clone(),
            CancellationToken::new()
        ),
        push(
            &harness,
            &agent,
            keyed("both"),
            slow.clone(),
            CancellationToken::new()
        ),
    );
    assert_eq!(structured(&a)["message"], "Pushed.");
    assert_eq!(a, b);
    assert_eq!(fake.runs(), 2);

    // A typed failure is stored as it was.
    let rejected = json!({ "events": [{ "_tag": "failed", "operation": "push", "code": "rejected", "message": "Rejected.", "blocked": null }] });
    let failed = push(
        &harness,
        &agent,
        keyed("fail"),
        rejected.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(error_tag(&failed), "GitOperationFailedError");
    let again = push(
        &harness,
        &agent,
        keyed("fail"),
        rejected,
        CancellationToken::new(),
    )
    .await;
    assert_eq!(failed, again);
    assert_eq!(fake.runs(), 3);

    // A stream that ended early is unknown, and stays unknown.
    let cut = json!({ "events": [{ "_tag": "output", "operation": "push", "stream": "stderr", "text": "half" }] });
    let ended = push(
        &harness,
        &agent,
        keyed("cut"),
        cut.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(reason(&ended), "stream-ended");
    let again = push(
        &harness,
        &agent,
        keyed("cut"),
        cut,
        CancellationToken::new(),
    )
    .await;
    assert_eq!(ended, again);
    assert_eq!(fake.runs(), 4);

    // The same key with other arguments is a conflict, and runs nothing.
    let mut other = keyed("seq");
    other["remote"] = json!("upstream");
    let conflict = push(
        &harness,
        &agent,
        other,
        ok.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(error_tag(&conflict), "idempotency_conflict");
    assert_eq!(fake.runs(), 4);

    // Without a key every call runs.
    let unkeyed = json!({ "threadId": "t", "remote": "origin" });
    push(
        &harness,
        &agent,
        unkeyed.clone(),
        ok.clone(),
        CancellationToken::new(),
    )
    .await;
    push(&harness, &agent, unkeyed, ok, CancellationToken::new()).await;
    assert_eq!(fake.runs(), 6);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_running_row_nobody_owns_is_unknown_and_never_runs() {
    let fake = Fake::default();
    let harness = fake.harness().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let arguments = keyed("crashed");
    let digest = crate::orchestration::delivery::canonical_command_digest(&arguments).unwrap();
    let session_id = agent.principal.session_id.clone();
    harness
        .repositories
        .database()
        .call(move |connection| {
            connection.execute(
                "INSERT INTO mcp_tool_requests (session_id, client_request_id, tool, arguments_digest, commands_json, created_at, state) VALUES (?, 'crashed', 'git_push', ?, '{}', ?, 'running')",
                rusqlite::params![session_id, digest, crate::mcp::control::now_iso()],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let ok = json!({ "events": [finished()] });
    let result = push(
        &harness,
        &agent,
        arguments.clone(),
        ok.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(reason(&result), "restarted");
    let again = push(&harness, &agent, arguments, ok, CancellationToken::new()).await;
    assert_eq!(reason(&again), "restarted");
    assert_eq!(fake.runs(), 0);

    // A slice-1 thread tool's row is not an outcome to return.
    let (_, _) = start(&harness, &agent, {
        let mut arguments = basic_start();
        arguments["clientRequestId"] = json!("thread-key");
        arguments
    })
    .await;
    let conflict = push(
        &harness,
        &agent,
        keyed("thread-key"),
        json!({}),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(error_tag(&conflict), "idempotency_conflict");
    harness.shutdown().await;
}

async fn until(mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("in time");
}

#[tokio::test]
async fn the_off_switch_read_only_and_revocation_interrupt_owned_work_as_unknown() {
    let fake = Fake::default();
    let harness = fake.harness().await;
    let hold = json!({ "hold": true });
    type Flip = Box<
        dyn Fn(
                &Harness,
                &ClientPrincipal,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            + Send
            + Sync,
    >;
    let cases: Vec<(&str, Flip)> = vec![
        (
            "mcp-disabled",
            Box::new(|harness: &Harness, _: &ClientPrincipal| {
                harness.settings.send_replace(McpServerSettings {
                    enabled: false,
                    access: McpAccess::FullAccess,
                    ..McpServerSettings::default()
                });
                Box::pin(async {})
            }),
        ),
        (
            "read-only",
            Box::new(|harness: &Harness, _: &ClientPrincipal| {
                harness.settings.send_replace(McpServerSettings {
                    enabled: true,
                    access: McpAccess::ReadOnly,
                    ..McpServerSettings::default()
                });
                Box::pin(async {})
            }),
        ),
        (
            "revoked",
            Box::new(|harness: &Harness, agent: &ClientPrincipal| {
                let auth = harness.auth.clone();
                let session_id = agent.principal.session_id.clone();
                Box::pin(async move {
                    assert!(
                        auth.revoke_client("someone-else", &session_id)
                            .await
                            .unwrap()
                    );
                })
            }),
        ),
    ];
    for (expected, flip) in cases {
        harness.settings.send_replace(McpServerSettings {
            enabled: true,
            access: McpAccess::FullAccess,
            ..McpServerSettings::default()
        });
        let (agent, _) = harness.agent(McpAccess::FullAccess).await;
        let stopped = fake.stopped.load(Ordering::SeqCst);
        let runs = fake.runs();
        let (result, ()) = tokio::join!(
            push(
                &harness,
                &agent,
                keyed(expected),
                hold.clone(),
                CancellationToken::new()
            ),
            async {
                until(|| fake.runs() == runs + 1).await;
                flip(&harness, &agent).await;
            },
        );
        assert_eq!(reason(&result), expected);
        until(|| fake.stopped.load(Ordering::SeqCst) == stopped + 1).await;
        let again = push(
            &harness,
            &agent,
            keyed(expected),
            hold.clone(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(
            result, again,
            "{expected}: a retry reads the stored outcome"
        );
        assert_eq!(fake.runs(), runs + 1);
    }

    // Shutdown interrupts it the same way.
    harness.settings.send_replace(McpServerSettings {
        enabled: true,
        access: McpAccess::FullAccess,
        ..McpServerSettings::default()
    });
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let runs = fake.runs();
    let (result, ()) = tokio::join!(
        push(
            &harness,
            &agent,
            keyed("stop"),
            hold.clone(),
            CancellationToken::new()
        ),
        async {
            until(|| fake.runs() == runs + 1).await;
            harness.control.shutdown();
        },
    );
    assert_eq!(reason(&result), "shutdown");
    harness.shutdown().await;
}

#[tokio::test]
async fn work_that_finishes_before_the_switch_keeps_its_result() {
    let fake = Fake::default();
    let harness = fake.harness().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let ok = json!({ "events": [finished()] });
    let pushed = push(
        &harness,
        &agent,
        keyed("early"),
        ok.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(structured(&pushed)["message"], "Pushed.");
    harness.settings.send_replace(McpServerSettings {
        enabled: false,
        access: McpAccess::FullAccess,
        ..McpServerSettings::default()
    });
    let again = push(
        &harness,
        &agent,
        keyed("early"),
        ok,
        CancellationToken::new(),
    )
    .await;
    assert_eq!(pushed, again);
    assert_eq!(fake.runs(), 1);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_cancelled_call_leaves_its_work_running_and_holds_its_slot_until_it_settles() {
    let fake = Fake::default();
    let harness = fake.harness().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let hold = json!({ "hold": true });
    for key in ["one", "two"] {
        let cancellation = CancellationToken::new();
        let runs = fake.runs();
        let (result, ()) = tokio::join!(
            push(
                &harness,
                &agent,
                keyed(key),
                hold.clone(),
                cancellation.clone()
            ),
            async {
                until(|| fake.runs() == runs + 1).await;
                cancellation.cancel();
            },
        );
        assert_eq!(error_tag(&result), "McpCancelledError");
    }
    assert_eq!(
        fake.stopped.load(Ordering::SeqCst),
        0,
        "both pushes still run"
    );
    // A third owned mutation for this session waits for a slot.
    let busy = push(
        &harness,
        &agent,
        keyed("three"),
        hold.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(error_tag(&busy), "McpBusyError");
    assert_eq!(fake.runs(), 2);
    // Unkeyed work runs inline and takes no owned slot.
    let inline = push(
        &harness,
        &agent,
        json!({ "threadId": "t" }),
        json!({ "events": [finished()] }),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(structured(&inline)["message"], "Pushed.");
    // Once one settles, its outcome is readable and the slot is free.
    fake.release.notify_one();
    let mut settled = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            for key in ["one", "two"] {
                let result = push(
                    &harness,
                    &agent,
                    keyed(key),
                    hold.clone(),
                    CancellationToken::new(),
                )
                .await;
                if result["isError"] != true {
                    settled = Some(result);
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("one push settles");
    assert_eq!(structured(settled.as_ref().unwrap())["message"], "Pushed.");
    let third = push(
        &harness,
        &agent,
        keyed("three"),
        json!({ "events": [finished()] }),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(structured(&third)["message"], "Pushed.");
    harness.shutdown().await;
}

fn slow<'a>(
    call: &'a ToolCall<'a>,
    _: &'a str,
    _: Option<(ProgressSink, Value)>,
) -> ToolFuture<'a> {
    Box::pin(async move {
        call.cancellation.cancelled().await;
        Ok(tool_result(json!({}), &[]))
    })
}

const SLOW: &[ToolSpec] =
    &[ToolSpec::client("slow_push", crate::auth::SCOPE_ORCHESTRATION_OPERATE, &[]).open_world()];

#[tokio::test]
async fn long_running_tools_take_no_wait_slot() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    harness.provider_turn(&thread_id, "turn-1", "", false).await;
    let families = [
        threads::FAMILY,
        Family {
            tools: SLOW,
            text: |_| None,
            call: slow,
        },
    ];
    let stop = CancellationToken::new();
    let call = |name: &'static str| {
        let arguments: Map<String, Value> = match name {
            "wait_for_thread" => json!({ "threadId": thread_id, "timeoutMs": 50_000 }),
            _ => json!({}),
        }
        .as_object()
        .cloned()
        .unwrap();
        let (harness, agent, families, stop) = (&harness, &agent, &families, stop.clone());
        async move {
            harness
                .control
                .call_in(families, agent, name, &arguments, None, stop)
                .await
        }
    };
    let (slow_a, slow_b, slow_c, wait_a, wait_b, wait_c, wait_d, (fifth, slow_d)) = tokio::join!(
        call("slow_push"),
        call("slow_push"),
        call("slow_push"),
        call("wait_for_thread"),
        call("wait_for_thread"),
        call("wait_for_thread"),
        call("wait_for_thread"),
        async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let fifth = call("wait_for_thread").await;
            let (slow_d, ()) = tokio::join!(call("slow_push"), async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                stop.cancel();
            });
            (fifth, slow_d)
        },
    );
    assert_eq!(error_tag(&fifth), "McpBusyError");
    for result in [
        slow_a, slow_b, slow_c, slow_d, wait_a, wait_b, wait_c, wait_d,
    ] {
        assert_ne!(
            result["structuredContent"]["error"]["_tag"], "McpBusyError",
            "{result}"
        );
    }
    harness.shutdown().await;
}

fn listed(harness: &Harness, agent: &ClientPrincipal) -> Vec<String> {
    harness
        .control
        .tools(agent)
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_capability_set_turned_off_hides_and_refuses_its_tools_live() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    assert_eq!(
        listed(&harness, &agent),
        threads::TOOLS
            .iter()
            .map(|spec| spec.name)
            .collect::<Vec<_>>(),
        "the defaults list every slice-1 tool"
    );
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    let mut settings = McpServerSettings {
        access: McpAccess::FullAccess,
        ..McpServerSettings::default()
    };
    settings.capabilities.source_control = false;
    harness.settings.send_replace(settings);
    assert!(!listed(&harness, &agent).contains(&"git_status".to_owned()));
    let refused = harness
        .call(&agent, "git_status", json!({ "threadId": thread_id }))
        .await;
    assert_eq!(error_tag(&refused), "McpCapabilityDisabledError");
    assert!(
        refused["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Source control")
    );
    settings.capabilities.workspace = false;
    harness.settings.send_replace(settings);
    assert!(listed(&harness, &agent).is_empty());
    let refused = harness
        .call(&agent, "read_thread", json!({ "threadId": thread_id }))
        .await;
    assert_eq!(error_tag(&refused), "McpCapabilityDisabledError");
    settings.capabilities.workspace = true;
    settings.capabilities.source_control = true;
    harness.settings.send_replace(settings);
    assert!(listed(&harness, &agent).contains(&"git_status".to_owned()));
    harness.shutdown().await;
}

async fn event_count(harness: &Harness) -> i64 {
    harness
        .repositories
        .database()
        .call(|connection| {
            Ok(
                connection.query_row("SELECT COUNT(*) FROM orchestration_events", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn interrupt_turn_dispatches_only_for_a_running_turn_and_is_not_idempotent() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let interrupt = harness
        .control
        .tools(&agent)
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "interrupt_turn")
        .cloned()
        .unwrap();
    assert_eq!(interrupt["annotations"]["idempotentHint"], false);

    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    let before = event_count(&harness).await;
    let idle = harness
        .call(&agent, "interrupt_turn", json!({ "threadId": thread_id }))
        .await;
    assert_eq!(structured(&idle)["interruptRequested"], false);
    assert_eq!(structured(&idle)["turnRunning"], false);
    assert_eq!(
        event_count(&harness).await,
        before,
        "nothing was dispatched"
    );

    harness.provider_turn(&thread_id, "turn-1", "", false).await;
    // A named turn that is not this one is not running.
    let other = harness
        .call(
            &agent,
            "interrupt_turn",
            json!({ "threadId": thread_id, "turnId": "turn-0" }),
        )
        .await;
    assert_eq!(structured(&other)["turnRunning"], false);
    // The running turn is resolved and the command dispatched. This harness has no live
    // provider session, so the engine refuses it there: the refusal names the interrupt.
    let running = harness
        .call(&agent, "interrupt_turn", json!({ "threadId": thread_id }))
        .await;
    assert_eq!(error_tag(&running), "OrchestrationDispatchCommandError");
    assert!(
        running["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("thread.turn.interrupt")
    );

    harness.provider_turn(&thread_id, "turn-1", "", true).await;
    let settled = event_count(&harness).await;
    let again = harness
        .call(&agent, "interrupt_turn", json!({ "threadId": thread_id }))
        .await;
    assert_eq!(structured(&again)["turnRunning"], false);
    assert_eq!(
        event_count(&harness).await,
        settled,
        "a repeat holds nothing"
    );
    harness.shutdown().await;
}
