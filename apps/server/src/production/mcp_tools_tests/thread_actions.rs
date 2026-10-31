//! Slice A's thread actions end to end: answering approvals, reverting a thread to a checkpoint,
//! and attachments staged through the upload service.

use std::path::{Path, PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD};

use super::*;
use crate::{
    production::orchestration_effects::{
        BoxEffectFuture, EffectsOptions, OrchestrationEffectCallbacks, OrchestrationEffects,
        ProviderRewind, capture_checkpoint, checkpoint_ref,
    },
    test_support::isolated_git_config::IsolatedGitConfig,
};

/// The provider asks for approval `request_id` on `thread_id`.
async fn ask_approval(harness: &Harness, thread_id: &str, request_id: &str) {
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.activity.append", "commandId": format!("approve-{request_id}"),
            "threadId": thread_id,
            "activity": {
                "id": format!("approve-{request_id}"), "tone": "approval", "kind": "approval.requested",
                "summary": "Run ls", "payload": { "requestId": request_id, "requestKind": "command" },
                "turnId": "turn-1", "createdAt": CREATED_AT,
            },
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("approval requested");
}

/// The provider asks question `request_id` on `thread_id`.
async fn ask_question(harness: &Harness, thread_id: &str, request_id: &str) {
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.activity.append", "commandId": format!("ask-{request_id}"),
            "threadId": thread_id,
            "activity": {
                "id": format!("ask-{request_id}"), "tone": "approval", "kind": "user-input.requested",
                "summary": "Needs you",
                "payload": { "requestId": request_id, "questions": [{ "id": "color", "header": "Color", "question": "Which?", "options": [{ "label": "Red", "description": "" }] }] },
                "turnId": "turn-1", "createdAt": CREATED_AT,
            },
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("question asked");
}

/// The status and decision of approval `request_id` in the read model.
async fn approval_state(harness: &Harness, request_id: &str) -> (String, Option<String>) {
    let request_id = request_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection.query_row(
                "SELECT status, decision FROM projection_pending_approvals WHERE request_id = ?",
                [request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .await
        .expect("approval row")
}

/// How many approval answers the engine recorded for `request_id`.
async fn approval_answers(harness: &Harness, request_id: &str) -> i64 {
    let request_id = request_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM orchestration_events WHERE event_type = 'thread.approval-response-requested' AND json_extract(payload_json, '$.requestId') = ?",
                [request_id],
                |row| row.get(0),
            )?)
        })
        .await
        .expect("answer count")
}

/// The tool reached the engine: whatever the faked provider (which has no live session) says,
/// no tool-layer check refused the call.
fn reached_the_engine(result: &Value) {
    if result["isError"] == true {
        let tag = error_tag(result);
        assert!(
            !tag.starts_with("Mcp") && tag != "idempotency_conflict",
            "{result}"
        );
    }
}

fn lower_ceiling(harness: &Harness, access: McpAccess) {
    harness.settings.send_replace(McpServerSettings {
        enabled: true,
        access,
        ..McpServerSettings::default()
    });
}

#[tokio::test]
async fn approvals_are_listed_with_their_tool_and_answered_by_decision() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    harness.provider_turn(&thread_id, "turn-1", "", false).await;
    ask_approval(&harness, &thread_id, "a1").await;
    ask_approval(&harness, &thread_id, "a2").await;
    ask_question(&harness, &thread_id, "q1").await;

    let pending = harness
        .call(
            &agent,
            "list_pending_requests",
            json!({ "threadId": thread_id }),
        )
        .await;
    let pending = structured(&pending);
    let approval = &pending["approvals"][0];
    assert_eq!(approval["requestId"], "a1", "{pending}");
    assert_eq!(approval["answerWith"], "answer_approval");
    assert_eq!(approval["kind"], "command");
    assert_eq!(approval["summary"], "Run ls");
    assert_eq!(
        approval["decisions"],
        json!(["accept", "acceptForSession", "decline", "cancel"])
    );
    assert_eq!(pending["questions"][0]["answerWith"], "answer_question");

    let accepted = harness
        .call(
            &agent,
            "answer_approval",
            json!({ "threadId": thread_id, "requestId": "a1", "decision": "accept" }),
        )
        .await;
    reached_the_engine(&accepted);
    assert_eq!(
        approval_state(&harness, "a1").await,
        ("resolved".to_owned(), Some("accept".to_owned()))
    );
    let declined = harness
        .call(
            &agent,
            "answer_approval",
            json!({ "threadId": thread_id, "requestId": "a2", "decision": "decline" }),
        )
        .await;
    reached_the_engine(&declined);
    assert_eq!(
        approval_state(&harness, "a2").await,
        ("resolved".to_owned(), Some("decline".to_owned()))
    );

    // A question is answered with answer_question, an approval with answer_approval.
    let wrong = harness
        .call(
            &agent,
            "answer_approval",
            json!({ "threadId": thread_id, "requestId": "q1", "decision": "accept" }),
        )
        .await;
    assert_eq!(error_tag(&wrong), "McpRequestKindError");
    assert!(
        wrong["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("answer_question"),
        "{wrong}"
    );
    ask_approval(&harness, &thread_id, "a3").await;
    let wrong = harness
        .call(
            &agent,
            "answer_question",
            json!({ "threadId": thread_id, "requestId": "a3", "answers": {} }),
        )
        .await;
    assert_eq!(error_tag(&wrong), "McpRequestKindError");
    assert!(
        wrong["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("answer_approval"),
        "{wrong}"
    );

    // An approval already answered, an unknown decision, and an unknown argument.
    for arguments in [
        json!({ "threadId": thread_id, "requestId": "a1", "decision": "accept" }),
        json!({ "threadId": thread_id, "requestId": "a3", "decision": "yes" }),
        json!({ "threadId": thread_id, "requestId": "a3", "decision": "accept", "note": "x" }),
    ] {
        let refused = harness.call(&agent, "answer_approval", arguments).await;
        assert_eq!(error_tag(&refused), "McpInvalidArgumentError", "{refused}");
    }
    assert_eq!(approval_state(&harness, "a3").await.0, "pending");
    harness.shutdown().await;
}

/// Accepting resumes the provider, so it meets the ceiling; declining and cancelling stop work
/// and are allowed at any operate level, on the first call and on a retry.
#[tokio::test]
async fn accepting_above_the_ceiling_is_refused_and_declining_is_not() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut full = basic_start();
    full["runtimeMode"] = json!("full-access");
    let (thread_id, _) = start(&harness, &agent, full).await;
    harness.provider_turn(&thread_id, "turn-1", "", false).await;
    ask_approval(&harness, &thread_id, "a1").await;
    ask_approval(&harness, &thread_id, "a2").await;
    let declined_once = json!({ "threadId": thread_id, "requestId": "a2", "decision": "cancel", "clientRequestId": "cancel-a2" });
    reached_the_engine(
        &harness
            .call(&agent, "answer_approval", declined_once.clone())
            .await,
    );
    lower_ceiling(&harness, McpAccess::ApprovalRequired);

    for decision in ["accept", "acceptForSession"] {
        let refused = harness
            .call(
                &agent,
                "answer_approval",
                json!({ "threadId": thread_id, "requestId": "a1", "decision": decision }),
            )
            .await;
        assert_eq!(error_tag(&refused), "McpAccessCeilingError");
    }
    assert_eq!(approval_state(&harness, "a1").await.0, "pending");
    let declined = harness
        .call(
            &agent,
            "answer_approval",
            json!({ "threadId": thread_id, "requestId": "a1", "decision": "decline" }),
        )
        .await;
    reached_the_engine(&declined);
    assert_eq!(
        approval_state(&harness, "a1").await,
        ("resolved".to_owned(), Some("decline".to_owned()))
    );
    // The retried cancel is judged as its first call was, after the ceiling fell.
    reached_the_engine(&harness.call(&agent, "answer_approval", declined_once).await);
    assert_eq!(approval_answers(&harness, "a2").await, 1);
    harness.shutdown().await;
}

/// A retry whose first answer was lost replays the engine's receipt, although the approval is
/// no longer pending: it never answers twice.
#[tokio::test]
async fn a_retry_after_the_approval_resolved_replays_its_receipt() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    harness.provider_turn(&thread_id, "turn-1", "", false).await;
    ask_approval(&harness, &thread_id, "a1").await;
    let arguments = json!({ "threadId": thread_id, "requestId": "a1", "decision": "accept", "clientRequestId": "approve-a1" });
    reached_the_engine(
        &harness
            .call(&agent, "answer_approval", arguments.clone())
            .await,
    );
    assert_eq!(approval_state(&harness, "a1").await.0, "resolved");
    let retried = harness.call(&agent, "answer_approval", arguments).await;
    assert_eq!(
        structured(&retried),
        &json!({ "threadId": thread_id, "requestId": "a1", "decision": "accept", "answered": true })
    );
    assert_eq!(approval_answers(&harness, "a1").await, 1);
    let other = json!({ "threadId": thread_id, "requestId": "a1", "decision": "decline", "clientRequestId": "approve-a1" });
    assert_eq!(
        error_tag(&harness.call(&agent, "answer_approval", other).await),
        "idempotency_conflict"
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn approvals_and_reverts_are_destructive_and_hidden_from_read_only() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let listed = harness.control.tools(&agent);
    for name in ["answer_approval", "revert_thread_to_turn"] {
        let tool = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed"));
        assert_eq!(tool["annotations"]["destructiveHint"], true, "{tool}");
        assert_eq!(tool["annotations"]["idempotentHint"], false, "{tool}");
        assert_eq!(tool["annotations"]["readOnlyHint"], false, "{tool}");
        let spec = crate::mcp::control::tool_spec(crate::mcp::control::PrincipalKind::Client, name)
            .expect("registered");
        assert!(spec.audited && spec.destructive);
    }
    let (reader, _) = harness.agent(McpAccess::ReadOnly).await;
    let names: Vec<Value> = harness
        .control
        .tools(&reader)
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].clone())
        .collect();
    assert!(!names.contains(&json!("answer_approval")));
    assert!(!names.contains(&json!("revert_thread_to_turn")));
    harness.shutdown().await;
}

/// Effect callbacks for a revert in `cwd`: the provider rewinds, nothing else runs. Threads other
/// than `thread_id` work in `elsewhere`, which is not a Git checkout.
struct Rewinds {
    thread_id: String,
    cwd: PathBuf,
    elsewhere: PathBuf,
    /// Runs in the provider rewind, after the revert was planned.
    during_rewind: Option<Box<dyn Fn() -> BoxEffectFuture<'static, ()> + Send + Sync>>,
}

impl Rewinds {
    fn new(thread_id: &str, cwd: &Path, elsewhere: &Path) -> Self {
        Self {
            thread_id: thread_id.to_owned(),
            cwd: cwd.to_path_buf(),
            elsewhere: elsewhere.to_path_buf(),
            during_rewind: None,
        }
    }
}

impl OrchestrationEffectCallbacks for Rewinds {
    fn workspace_for_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async move {
            Ok(Some(if thread_id == self.thread_id {
                self.cwd.clone()
            } else {
                self.elsewhere.clone()
            }))
        })
    }

    fn rollback_provider<'a>(
        &'a self,
        _thread_id: &'a str,
        _turns: i64,
        _rewind_key: &'a str,
    ) -> BoxEffectFuture<'a, ProviderRewind> {
        Box::pin(async {
            if let Some(during_rewind) = &self.during_rewind {
                during_rewind().await?;
            }
            Ok(ProviderRewind::Rewound)
        })
    }

    fn stop_provider<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn close_terminals<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn refresh_workspace<'a>(&'a self, _cwd: &'a Path) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
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

/// A Git checkout of `tracked.txt` with checkpoints for turns 0 to 2 of `thread_id`, recorded
/// in the read model as the effects worker would.
async fn checkpointed_checkout(harness: &Harness, thread_id: &str) -> tempfile::TempDir {
    // The checkpoint capture and the revert run production Git, which keeps the inherited
    // environment. Refuse to run rather than let it restore and clean another checkout.
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
    ] {
        assert!(std::env::var_os(name).is_none(), "unset {name} first");
    }
    let repository = tempfile::tempdir().unwrap();
    let cwd = repository.path();
    let config = IsolatedGitConfig::new();
    for args in [
        &["init"][..],
        &["config", "user.name", "BiBCode Test"],
        &["config", "user.email", "bibcode@example.test"],
        &["config", "commit.gpgSign", "false"],
    ] {
        git(&config, cwd, args);
    }
    std::fs::write(cwd.join("tracked.txt"), "baseline\n").unwrap();
    git(&config, cwd, &["add", "."]);
    git(&config, cwd, &["commit", "-m", "baseline"]);
    for (turn_count, content) in [(0, "baseline\n"), (1, "one\n"), (2, "two\n")] {
        std::fs::write(cwd.join("tracked.txt"), content).unwrap();
        capture_checkpoint(cwd, thread_id, turn_count)
            .await
            .unwrap();
        if turn_count > 0 {
            harness
                .engine
                .dispatch(command(json!({
                    "type": "thread.turn.diff.complete", "commandId": format!("diff-{turn_count}"),
                    "threadId": thread_id, "turnId": format!("turn-{turn_count}"),
                    "checkpointTurnCount": turn_count, "checkpointRef": checkpoint_ref(thread_id, turn_count),
                    "status": "ready", "files": [], "assistantMessageId": format!("a-{turn_count}"),
                    "completedAt": CREATED_AT, "createdAt": CREATED_AT,
                })))
                .await
                .unwrap();
        }
    }
    repository
}

#[tokio::test]
async fn revert_thread_to_turn_restores_the_checkpoint_and_reports_failures() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    let (other_id, _) = start(&harness, &agent, basic_start()).await;
    let checkout = checkpointed_checkout(&harness, &thread_id).await;
    let elsewhere = tempfile::tempdir().unwrap();
    let effects = OrchestrationEffects::start(
        harness.engine.clone(),
        Arc::new(crate::git::GitRepository::default()),
        Arc::new(Rewinds::new(&thread_id, checkout.path(), elsewhere.path())),
        EffectsOptions::default(),
    )
    .await
    .unwrap();

    // Past the latest checkpoint, and a missing turnCount, are refused before any command.
    for arguments in [
        json!({ "threadId": thread_id, "turnCount": 3 }),
        json!({ "threadId": thread_id }),
    ] {
        let refused = harness
            .call(&agent, "revert_thread_to_turn", arguments)
            .await;
        assert_eq!(error_tag(&refused), "McpInvalidArgumentError", "{refused}");
    }

    let reverted = harness
        .call(
            &agent,
            "revert_thread_to_turn",
            json!({ "threadId": thread_id, "turnCount": 1 }),
        )
        .await;
    let reverted = structured(&reverted);
    assert_eq!(reverted["reverted"], true, "{reverted}");
    assert_eq!(reverted["turnCount"], 1);
    assert_eq!(reverted["conversationRewound"], true);
    assert_eq!(
        std::fs::read_to_string(checkout.path().join("tracked.txt")).unwrap(),
        "one\n"
    );

    // The worker's own refusal (no Git checkout) comes back typed, with its detail.
    let failed = harness
        .call(
            &agent,
            "revert_thread_to_turn",
            json!({ "threadId": other_id, "turnCount": 0 }),
        )
        .await;
    assert_eq!(error_tag(&failed), "McpCheckpointRevertError", "{failed}");
    assert!(
        failed["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not a git repository"),
        "{failed}"
    );

    // A running turn is refused before any command, as the UI refuses it.
    harness.provider_turn(&thread_id, "turn-3", "", false).await;
    let running = harness
        .call(
            &agent,
            "revert_thread_to_turn",
            json!({ "threadId": thread_id, "turnCount": 0 }),
        )
        .await;
    assert_eq!(error_tag(&running), "McpTurnRunningError", "{running}");

    effects.shutdown().await;
    harness.shutdown().await;
}

/// A provider that rewound while the files could not be restored is a failed revert, never
/// `reverted: true`: the thread forgot the later turns, but the files are as they were.
#[tokio::test]
async fn a_revert_whose_files_were_not_restored_fails() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    let checkout = checkpointed_checkout(&harness, &thread_id).await;
    let elsewhere = tempfile::tempdir().unwrap();
    let mut rewinds = Rewinds::new(&thread_id, checkout.path(), elsewhere.path());
    // The checkpoint resolved when the revert was planned and is gone when it restores.
    let (cwd, target) = (checkout.path().to_path_buf(), checkpoint_ref(&thread_id, 1));
    rewinds.during_rewind = Some(Box::new(move || {
        git(
            &IsolatedGitConfig::new(),
            &cwd,
            &["update-ref", "-d", &target],
        );
        Box::pin(async { Ok(()) })
    }));
    let effects = OrchestrationEffects::start(
        harness.engine.clone(),
        Arc::new(crate::git::GitRepository::default()),
        Arc::new(rewinds),
        EffectsOptions::default(),
    )
    .await
    .unwrap();

    let failed = harness
        .call(
            &agent,
            "revert_thread_to_turn",
            json!({ "threadId": thread_id, "turnCount": 1 }),
        )
        .await;
    assert_eq!(error_tag(&failed), "McpCheckpointRevertError", "{failed}");
    assert!(
        failed["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("could not be restored"),
        "{failed}"
    );
    assert_eq!(
        std::fs::read_to_string(checkout.path().join("tracked.txt")).unwrap(),
        "two\n"
    );
    // The revert itself was recorded: the thread's latest checkpoint is turn 1 now.
    let refused = harness
        .call(
            &agent,
            "revert_thread_to_turn",
            json!({ "threadId": thread_id, "turnCount": 2 }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpInvalidArgumentError", "{refused}");
    effects.shutdown().await;
    harness.shutdown().await;
}

/// Thread `thread_id`'s revert requests so far.
async fn revert_requests(harness: &Harness, thread_id: &str) -> i64 {
    let thread_id = thread_id.to_owned();
    harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ? AND event_type = 'thread.checkpoint-revert-requested'",
                [thread_id],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap()
}

/// Each revert answers with its own outcome: one that finishes while a second waits behind it
/// does not answer the second.
#[tokio::test]
async fn overlapping_reverts_each_get_their_own_outcome() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    let checkout = checkpointed_checkout(&harness, &thread_id).await;
    let elsewhere = tempfile::tempdir().unwrap();
    let mut rewinds = Rewinds::new(&thread_id, checkout.path(), elsewhere.path());
    let (entered, release) = (
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
    );
    rewinds.during_rewind = Some(Box::new({
        let (entered, release) = (entered.clone(), release.clone());
        move || {
            let (entered, release) = (entered.clone(), release.clone());
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                Ok(())
            })
        }
    }));
    let effects = OrchestrationEffects::start(
        harness.engine.clone(),
        Arc::new(crate::git::GitRepository::default()),
        Arc::new(rewinds),
        EffectsOptions::default(),
    )
    .await
    .unwrap();

    let first = harness.call(
        &agent,
        "revert_thread_to_turn",
        json!({ "threadId": thread_id, "turnCount": 1 }),
    );
    // Asked while the first one rewinds, when turn 2 still has a checkpoint. Once the first has
    // reverted to turn 1, the worker refuses it.
    let second = async {
        entered.notified().await;
        harness
            .call(
                &agent,
                "revert_thread_to_turn",
                json!({ "threadId": thread_id, "turnCount": 2 }),
            )
            .await
    };
    let releaser = async {
        while revert_requests(&harness, &thread_id).await < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        release.notify_one();
    };
    let (first, second, ()) = tokio::join!(first, second, releaser);
    assert_eq!(structured(&first)["reverted"], true, "{first}");
    assert_eq!(error_tag(&second), "McpCheckpointRevertError", "{second}");
    assert!(
        second["structuredContent"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("exceeds current turn count"),
        "{second}"
    );
    effects.shutdown().await;
    harness.shutdown().await;
}

#[tokio::test]
async fn revert_meets_the_ceiling_of_the_thread() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut full = basic_start();
    full["runtimeMode"] = json!("full-access");
    let (thread_id, _) = start(&harness, &agent, full).await;
    lower_ceiling(&harness, McpAccess::ApprovalRequired);
    let refused = harness
        .call(
            &agent,
            "revert_thread_to_turn",
            json!({ "threadId": thread_id, "turnCount": 0 }),
        )
        .await;
    assert_eq!(error_tag(&refused), "McpAccessCeilingError");
    harness.shutdown().await;
}

fn attachment(name: &str, mime_type: &str, bytes: &[u8]) -> Value {
    json!({ "name": name, "mimeType": mime_type, "data": STANDARD.encode(bytes) })
}

/// Files the upload service still holds: a staged upload a turn consumed is gone.
fn staged_files(harness: &Harness) -> usize {
    std::fs::read_dir(harness._state.path().join("uploads"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".upload"))
                .count()
        })
        .unwrap_or(0)
}

/// The attachments of the provider turn message `message_id` delivers.
async fn delivered_attachments(harness: &Harness, message_id: &str) -> Vec<Value> {
    let message_id = message_id.to_owned();
    let payload: String = harness
        .repositories
        .database()
        .call(move |connection| {
            Ok(connection.query_row(
                "SELECT payload_json FROM provider_turn_outbox WHERE message_id = ?",
                [message_id],
                |row| row.get(0),
            )?)
        })
        .await
        .expect("an outbox row");
    let payload: Value = serde_json::from_str(&payload).unwrap();
    payload
        .pointer("/command/message/attachments")
        .or_else(|| payload.pointer("/message/attachments"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| panic!("no attachments in {payload}"))
}

#[tokio::test]
async fn attachments_reach_the_turn_as_staged_uploads() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["attachments"] = json!([
        attachment("notes.txt", "text/plain", b"hello"),
        attachment("pixel.png", "image/png", &[0x89, b'P', b'N', b'G']),
    ]);
    let (thread_id, message_id) = start(&harness, &agent, arguments).await;
    let delivered = delivered_attachments(&harness, &message_id).await;
    assert_eq!(delivered.len(), 2, "{delivered:?}");
    assert_eq!(delivered[0]["type"], "file");
    assert_eq!(delivered[0]["name"], "notes.txt");
    assert_eq!(delivered[0]["sizeBytes"], 5);
    assert_eq!(delivered[1]["type"], "image");
    assert_eq!(delivered[1]["mimeType"], "image/png");
    for attachment in &delivered {
        assert!(attachment.get("uploadId").is_none(), "{attachment}");
        assert!(attachment.get("data").is_none(), "{attachment}");
    }
    assert_eq!(staged_files(&harness), 0, "the turn consumed its uploads");

    let sent = harness
        .call(
            &agent,
            "send_message",
            json!({ "threadId": thread_id, "text": "and this", "attachments": [attachment("more.md", "text/markdown", b"# more")] }),
        )
        .await;
    let sent = structured(&sent);
    let delivered = delivered_attachments(&harness, sent["messageId"].as_str().unwrap()).await;
    assert_eq!(delivered[0]["name"], "more.md", "{delivered:?}");
    harness.shutdown().await;
}

#[tokio::test]
async fn a_retry_with_the_same_key_stages_no_second_upload() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["attachments"] = json!([attachment("notes.txt", "text/plain", b"hello")]);
    arguments["clientRequestId"] = json!("start-with-notes");
    let first = harness
        .call(&agent, "start_thread", arguments.clone())
        .await;
    let retried = harness.call(&agent, "start_thread", arguments).await;
    assert_eq!(structured(&first), structured(&retried));
    assert_eq!(staged_files(&harness), 0, "no upload was staged again");
    harness.shutdown().await;
}

#[tokio::test]
async fn too_many_or_too_large_attachments_are_refused_before_any_upload() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let too_large = vec![0_u8; 3 * 1024 * 1024 + 1];
    for attachments in [
        json!(
            (0..9)
                .map(|index| attachment(&format!("f{index}.txt"), "text/plain", b"x"))
                .collect::<Vec<_>>()
        ),
        json!([
            attachment(
                "a.bin",
                "application/octet-stream",
                &too_large[..2 * 1024 * 1024]
            ),
            attachment(
                "b.bin",
                "application/octet-stream",
                &too_large[2 * 1024 * 1024..]
            ),
        ]),
        json!([attachment("a.bin", "application/octet-stream", &too_large)]),
        json!([{ "name": "a.txt", "mimeType": "text/plain", "data": "not base64!" }]),
        json!([attachment("a.svg", "image/svg+xml", b"<svg/>")]),
        json!([{ "name": "a.txt", "mimeType": "text/plain" }]),
    ] {
        let mut arguments = basic_start();
        arguments["attachments"] = attachments;
        let refused = harness.call(&agent, "start_thread", arguments).await;
        assert_eq!(error_tag(&refused), "McpInvalidArgumentError", "{refused}");
    }
    assert_eq!(staged_files(&harness), 0);
    harness.shutdown().await;
}

/// A stored request whose staged upload expired (or a restart lost it) is refused typed, never
/// sent without its attachment.
#[tokio::test]
async fn a_retry_whose_upload_expired_is_a_typed_error() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let (thread_id, _) = start(&harness, &agent, basic_start()).await;
    let arguments = json!({
        "threadId": thread_id, "text": "see attached",
        "attachments": [attachment("notes.txt", "text/plain", b"hello")],
        "clientRequestId": "expired",
    });
    let stored = json!({
        "type": "thread.turn.start", "commandId": "stored-with-upload", "threadId": thread_id,
        "message": { "messageId": "stored-message", "role": "user", "text": "see attached", "attachments": [
            { "type": "file", "id": "gone", "name": "notes.txt", "mimeType": "text/plain", "sizeBytes": 5, "uploadId": "gone" },
        ]},
        "runtimeMode": "approval-required", "interactionMode": "default", "queued": true,
        "createdAt": CREATED_AT,
    });
    let digest = crate::orchestration::delivery::canonical_command_digest(&arguments).unwrap();
    let session_id = agent.principal.session_id.clone();
    let commands = serde_json::to_string(&[stored]).unwrap();
    harness
        .repositories
        .database()
        .call(move |connection| {
            connection.execute(
                "INSERT INTO mcp_tool_requests (session_id, client_request_id, tool, arguments_digest, commands_json, created_at) VALUES (?, 'expired', 'send_message', ?, ?, '2099-10-30T00:00:00Z')",
                rusqlite::params![session_id, digest, commands],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let refused = harness.call(&agent, "send_message", arguments).await;
    assert_eq!(
        error_tag(&refused),
        "McpAttachmentExpiredError",
        "{refused}"
    );
    harness.shutdown().await;
}

/// A call the engine rejects releases the uploads it staged, so repeating it does not fill the
/// session's upload quota until the uploads expire.
#[tokio::test]
async fn a_rejected_call_releases_its_uploads() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    for key in [None, Some("rejected-start")] {
        let mut arguments = basic_start();
        arguments["providerInstanceId"] = json!("no-such-provider");
        arguments["attachments"] = json!([attachment("notes.txt", "text/plain", b"hello")]);
        if let Some(key) = key {
            arguments["clientRequestId"] = json!(key);
        }
        let refused = harness.call(&agent, "start_thread", arguments).await;
        assert_eq!(refused["isError"], true, "{refused}");
        assert_eq!(staged_files(&harness), 0, "{key:?}: {refused}");
    }
    harness.shutdown().await;
}

/// Two calls with one clientRequestId each stage their attachments, and only one call's commands
/// are stored. The other call's uploads are released.
#[tokio::test]
async fn uploads_that_lose_the_stored_request_race_are_released() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let mut arguments = basic_start();
    arguments["attachments"] = json!([attachment("notes.txt", "text/plain", b"hello")]);
    arguments["clientRequestId"] = json!("raced");
    let (first, second) = tokio::join!(
        harness.call(&agent, "start_thread", arguments.clone()),
        harness.call(&agent, "start_thread", arguments),
    );
    assert_eq!(structured(&first), structured(&second));
    assert_eq!(staged_files(&harness), 0);
    harness.shutdown().await;
}

/// The upload service's quota bounds what an agent can park, and its refusal comes back typed.
#[tokio::test]
async fn the_upload_quota_error_comes_back_typed() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let context =
        crate::rpc::RpcSessionContext::authenticated(agent.principal.clone(), harness.auth.clone());
    for index in 0..16 {
        harness
            .control
            .registry()
            .invoke_local(
                "uploads.begin",
                json!({ "target": { "_tag": "chat-attachment", "type": "file", "name": format!("held-{index}.txt"), "mimeType": "text/plain" }, "sizeBytes": 1 }),
                context.clone(),
                CancellationToken::new(),
            )
            .await
            .expect("an upload begins");
    }
    let mut arguments = basic_start();
    arguments["attachments"] = json!([attachment("notes.txt", "text/plain", b"hello")]);
    let refused = harness.call(&agent, "start_thread", arguments).await;
    assert_eq!(error_tag(&refused), "UploadError", "{refused}");
    assert_eq!(refused["structuredContent"]["error"]["reason"], "quota");
    harness.shutdown().await;
}
