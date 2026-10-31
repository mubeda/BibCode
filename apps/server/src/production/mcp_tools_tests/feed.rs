//! `server_capabilities` and `changes_since` (#139 slice X3) end to end: the real tool
//! registration and checks, the real engine on SQLite, and the real activity log. The feed is
//! proven content-free by markers the prompt and the reply hold and no result does.

use serde_json::{Value, json};
use tokio::sync::watch;

use super::{CREATED_AT, Harness, basic_start, command, error_tag, start, structured};
use crate::{
    ServerConfig,
    auth::{AuthService, ClientMetadata, SecretStore, SessionTransport, issue_mcp_pairing_link},
    mcp::{
        activity::NewActivity,
        control::{ClientPrincipal, McpAccess, McpControl, McpServerSettings},
    },
    orchestration::{OrchestrationEngine, engine::EngineOptions},
    persistence::{Database, NewOrchestrationEvent, Repositories, run_migrations},
    rpc::RpcRegistry,
};

const PROMPT_MARKER: &str = "PROMPT-MARKER-x3-ignore-previous-instructions";
const REPLY_MARKER: &str = "REPLY-MARKER-x3";

async fn feed(harness: &Harness, agent: &ClientPrincipal, arguments: Value) -> Value {
    let result = harness.call(agent, "changes_since", arguments).await;
    structured(&result).clone()
}

async fn head(harness: &Harness, agent: &ClientPrincipal) -> String {
    let page = feed(harness, agent, json!({})).await;
    assert_eq!(page["entries"], json!([]), "no cursor starts from now");
    page["cursor"].as_str().unwrap().to_owned()
}

/// A cursor as its two positions; panics on a malformed one.
fn positions(cursor: &str) -> (i64, i64) {
    let mut parts = cursor.split('.');
    assert_eq!(parts.next(), Some("v1"), "{cursor}");
    let sequence = parts.next().unwrap().parse().unwrap();
    let activity = parts.next().unwrap().parse().unwrap();
    assert!(parts.next().is_none(), "{cursor}");
    (sequence, activity)
}

fn kinds(page: &Value) -> Vec<&str> {
    page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["kind"].as_str().unwrap())
        .collect()
}

/// Every entry's cursor is strictly past the one before it, componentwise, and the page's
/// cursor is not behind its last entry's.
fn assert_increasing(from: &str, page: &Value) {
    let mut previous = positions(from);
    for entry in page["entries"].as_array().unwrap() {
        let next = positions(entry["cursor"].as_str().unwrap());
        assert!(
            next.0 >= previous.0 && next.1 >= previous.1 && next != previous,
            "{previous:?} then {next:?}"
        );
        previous = next;
    }
    let end = positions(page["cursor"].as_str().unwrap());
    assert!(end.0 >= previous.0 && end.1 >= previous.1, "{page}");
}

async fn create_thread(harness: &Harness, thread_id: &str) {
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.create", "commandId": format!("create-{thread_id}"),
            "threadId": thread_id, "projectId": "p1", "title": thread_id,
            "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdAt": CREATED_AT,
        })))
        .await
        .expect("thread created");
}

async fn archive(harness: &Harness, thread_id: &str) {
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.archive", "commandId": format!("archive-{thread_id}"),
            "threadId": thread_id,
        })))
        .await
        .expect("thread archived");
}

async fn activity_row(harness: &Harness, thread_id: Option<&str>) {
    harness
        .control
        .activity()
        .record(NewActivity {
            session_id: "s-other".into(),
            label: Some("MCP · Other".into()),
            tool: "git_commit".into(),
            thread_id: thread_id.map(str::to_owned),
            outcome: "success".into(),
            target: json!({ "sha": "0123456789abcdef0123456789abcdef01234567" }),
        })
        .await;
}

#[tokio::test]
async fn both_tools_are_listed_and_called_at_read_only_with_every_set_off() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::ReadOnly).await;
    let mut settings = McpServerSettings::default();
    settings.capabilities.workspace = false;
    settings.capabilities.source_control = false;
    settings.capabilities.files = false;
    settings.capabilities.diagnostics = false;
    harness.settings.send_replace(settings);
    let tools = harness.control.tools(&agent);
    for name in ["server_capabilities", "changes_since"] {
        let tool = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed: {tools}"));
        assert_eq!(tool["annotations"]["readOnlyHint"], true, "{name}");
        assert_eq!(tool["annotations"]["idempotentHint"], true, "{name}");
        assert_eq!(tool["annotations"]["destructiveHint"], false, "{name}");
        assert_eq!(tool["annotations"]["openWorldHint"], false, "{name}");
    }
    let description = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "changes_since")
        .unwrap()["description"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        description.contains("Git operations a person ran"),
        "{description}"
    );
    structured(&harness.call(&agent, "server_capabilities", json!({})).await);
    structured(&harness.call(&agent, "changes_since", json!({})).await);
    harness.shutdown().await;
}

#[tokio::test]
async fn server_capabilities_describes_the_server_this_connection_and_every_error() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::AutoAcceptEdits).await;
    let result = harness.call(&agent, "server_capabilities", json!({})).await;
    let capabilities = structured(&result).clone();
    assert_eq!(capabilities["serverVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(
        capabilities["protocolVersions"],
        json!(crate::mcp::protocol::VERSIONS)
    );
    assert_eq!(
        capabilities["remoteProtocolVersion"],
        crate::http::REMOTE_PROTOCOL_VERSION
    );
    // The lower of the credential's ceiling and the environment's (Full access here).
    assert_eq!(capabilities["ceiling"], "auto-accept-edits");
    assert_eq!(
        capabilities["capabilities"],
        json!({ "workspace": true, "sourceControl": true, "files": true, "diagnostics": true, "terminals": false })
    );
    let scopes: Vec<&str> = capabilities["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|scope| scope.as_str().unwrap())
        .collect();
    assert!(scopes.contains(&crate::auth::SCOPE_ORCHESTRATION_READ));
    assert!(scopes.contains(&crate::auth::SCOPE_ORCHESTRATION_OPERATE));
    let errors = capabilities["errors"].as_array().unwrap();
    for tag in [
        "McpServerDisabledError",
        "McpCapabilityDisabledError",
        "McpScopeError",
        "McpBusyError",
        "McpOutcomeUnknownError",
        "idempotency_conflict",
        "McpPartialOutcomeError",
        "McpCredentialRefusedError",
        "McpServerUnreachableError",
    ] {
        let error = errors
            .iter()
            .find(|error| error["tag"] == tag)
            .unwrap_or_else(|| panic!("{tag} is in the table"));
        assert!(
            !error["meaning"].as_str().unwrap().is_empty(),
            "{tag} says what it means"
        );
        assert!(
            !error["fix"].as_str().unwrap().is_empty(),
            "{tag} says what fixes it"
        );
    }

    // The same list keeps its version; a set turned off changes the list and the version.
    let version = capabilities["toolsVersion"].as_str().unwrap().to_owned();
    assert!(version.len() >= 16, "{version}");
    let again = harness.call(&agent, "server_capabilities", json!({})).await;
    assert_eq!(structured(&again)["toolsVersion"], version.as_str());
    let mut settings = McpServerSettings {
        access: McpAccess::FullAccess,
        ..McpServerSettings::default()
    };
    settings.capabilities.source_control = false;
    harness.settings.send_replace(settings);
    let changed = harness.call(&agent, "server_capabilities", json!({})).await;
    assert_ne!(structured(&changed)["toolsVersion"], version.as_str());
    assert_eq!(structured(&changed)["capabilities"]["sourceControl"], false);
    // A read-only environment lowers the ceiling and hides the operate tools.
    harness.settings.send_replace(McpServerSettings {
        access: McpAccess::ReadOnly,
        ..McpServerSettings::default()
    });
    let read_only = harness.call(&agent, "server_capabilities", json!({})).await;
    assert_eq!(structured(&read_only)["ceiling"], "read-only");
    assert_ne!(structured(&read_only)["toolsVersion"], version.as_str());
    harness.shutdown().await;
}

#[tokio::test]
async fn with_no_cursor_the_feed_starts_from_now() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    create_thread(&harness, "before").await;
    activity_row(&harness, Some("before")).await;
    let cursor = head(&harness, &agent).await;
    let quiet = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    assert_eq!(quiet["entries"], json!([]));
    assert_eq!(quiet["cursor"], cursor.as_str());
    assert_eq!(quiet["more"], false);
    assert_eq!(quiet["activityDropped"], false);
    archive(&harness, "before").await;
    let next = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    assert_eq!(kinds(&next), ["thread.archived"]);
    assert_increasing(&cursor, &next);
    harness.shutdown().await;
}

#[tokio::test]
async fn transitions_hold_no_text_and_their_cursors_increase_strictly() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let cursor = head(&harness, &agent).await;
    let mut arguments = basic_start();
    arguments["prompt"] = json!(PROMPT_MARKER);
    arguments["purpose"] = json!("PURPOSE-MARKER-x3");
    let (thread_id, _) = start(&harness, &agent, arguments).await;
    harness
        .provider_turn(&thread_id, "turn-1", REPLY_MARKER, true)
        .await;
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.activity.append", "commandId": "ask-1", "threadId": thread_id,
            "activity": {
                "id": "ask-1", "tone": "approval", "kind": "approval.requested",
                "summary": "SUMMARY-MARKER-x3", "payload": { "requestId": "req-1", "requestKind": "command" },
                "turnId": "turn-1", "createdAt": CREATED_AT,
            },
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("approval asked");

    let page = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    let text = page.to_string();
    for marker in [
        PROMPT_MARKER,
        REPLY_MARKER,
        "SUMMARY-MARKER-x3",
        "PURPOSE-MARKER-x3",
    ] {
        assert!(!text.contains(marker), "{marker} leaked: {text}");
    }
    assert_eq!(
        kinds(&page),
        [
            "thread.created",
            "turn.requested",
            "turn.started",
            "turn.completed",
            "approval.requested",
            "agent.call",
        ],
        "{page}"
    );
    assert_increasing(&cursor, &page);
    let entries = page["entries"].as_array().unwrap();
    let allowed = [
        "cursor",
        "at",
        "kind",
        "threadId",
        "status",
        "requestId",
        "actor",
        "tool",
        "target",
    ];
    for entry in entries {
        for key in entry.as_object().unwrap().keys() {
            assert!(allowed.contains(&key.as_str()), "{key} in {entry}");
        }
        assert_eq!(entry["threadId"], thread_id.as_str(), "{entry}");
    }
    // The agent's own work names it; the provider's does not.
    let actor = &entries[0]["actor"];
    assert_eq!(actor["kind"], "mcp-client");
    assert_eq!(actor["clientId"], agent.principal.session_id.as_str());
    assert_eq!(actor["label"], "MCP · test");
    assert_eq!(entries[1]["actor"], *actor);
    assert!(entries[2].get("actor").is_none(), "{}", entries[2]);
    assert_eq!(entries[2]["status"], "running");
    assert_eq!(entries[3]["status"], "ready");
    assert_eq!(entries[4]["requestId"], "req-1");
    let call = &entries[5];
    assert_eq!(call["tool"], "start_thread");
    assert_eq!(call["status"], "success");
    assert_eq!(call["actor"], *actor);

    // A cursor taken from the middle of the page continues after that entry.
    let middle = entries[2]["cursor"].as_str().unwrap();
    let rest = feed(&harness, &agent, json!({ "cursor": middle })).await;
    assert_eq!(
        kinds(&rest),
        ["turn.completed", "approval.requested", "agent.call"]
    );
    // A limit pages the same entries, each page resuming where the last stopped.
    let mut seen = Vec::new();
    let mut at = cursor.clone();
    loop {
        let page = feed(&harness, &agent, json!({ "cursor": at, "limit": 2 })).await;
        assert_increasing(&at, &page);
        seen.extend(kinds(&page).into_iter().map(str::to_owned));
        at = page["cursor"].as_str().unwrap().to_owned();
        if page["more"] == false {
            break;
        }
    }
    assert_eq!(seen, kinds(&page));
    harness.shutdown().await;
}

#[tokio::test]
async fn a_thread_id_filters_both_logs() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    let cursor = head(&harness, &agent).await;
    create_thread(&harness, "mine").await;
    create_thread(&harness, "theirs").await;
    activity_row(&harness, Some("theirs")).await;
    activity_row(&harness, Some("mine")).await;
    archive(&harness, "theirs").await;
    let page = feed(
        &harness,
        &agent,
        json!({ "cursor": cursor, "threadId": "mine" }),
    )
    .await;
    assert_eq!(kinds(&page), ["thread.created", "agent.call"], "{page}");
    assert!(
        page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["threadId"] == "mine")
    );
    let all = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    assert_eq!(
        kinds(&all),
        [
            "thread.created",
            "thread.created",
            "thread.archived",
            "agent.call",
            "agent.call"
        ]
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn one_call_scans_at_most_5000_events_and_returns_its_progress() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    create_thread(&harness, "busy").await;
    let cursor = head(&harness, &agent).await;
    let (start_sequence, _) = positions(&cursor);
    // 5,000 events no transition maps, then one that does.
    harness
        .repositories
        .database()
        .call(|connection| {
            let transaction = connection.transaction()?;
            for version in 0..5_000 {
                transaction.execute(
                    "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, 'thread', 'busy', ?, 'thread.meta-updated', ?, NULL, NULL, NULL, 'server', '{}', '{}')",
                    rusqlite::params![format!("filler-{version}"), 1_000 + version, CREATED_AT],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
        .await
        .unwrap();
    archive(&harness, "busy").await;
    let first = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    assert_eq!(first["entries"], json!([]), "{first}");
    assert_eq!(first["more"], true);
    let (scanned, _) = positions(first["cursor"].as_str().unwrap());
    assert_eq!(scanned, start_sequence + 5_000, "the last scanned position");
    let second = feed(&harness, &agent, json!({ "cursor": first["cursor"] })).await;
    assert_eq!(kinds(&second), ["thread.archived"]);
    assert_eq!(second["more"], false);
    harness.shutdown().await;
}

async fn ask(harness: &Harness, thread_id: &str, kind: &str, request_id: &str) {
    harness
        .engine
        .dispatch(command(json!({
            "type": "thread.activity.append", "commandId": format!("ask-{kind}"),
            "threadId": thread_id,
            "activity": {
                "id": format!("ask-{kind}"), "tone": "approval", "kind": kind,
                "summary": "Asked", "payload": { "requestId": request_id, "requestKind": "command" },
                "turnId": null, "createdAt": CREATED_AT,
            },
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("request asked");
}

#[tokio::test]
async fn a_request_id_that_is_not_a_plain_id_is_left_out() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    create_thread(&harness, "asks").await;
    let cursor = head(&harness, &agent).await;
    // A provider's request id is passed through as it gave it: a path and words here.
    ask(
        &harness,
        "asks",
        "approval.requested",
        "/Users/someone/secret plan.txt",
    )
    .await;
    ask(&harness, "asks", "user-input.requested", "per_01J:abc-9.x").await;
    let page = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    let text = page.to_string();
    assert!(!text.contains("secret"), "{text}");
    assert!(!text.contains("/Users/someone"), "{text}");
    let entries = page["entries"].as_array().unwrap();
    assert_eq!(kinds(&page), ["approval.requested", "input.requested"]);
    assert!(entries[0].get("requestId").is_none(), "{}", entries[0]);
    assert_eq!(entries[1]["requestId"], "per_01J:abc-9.x");
    harness.shutdown().await;
}

#[tokio::test]
async fn one_call_parses_a_bounded_number_of_payload_bytes() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    create_thread(&harness, "loud").await;
    let cursor = head(&harness, &agent).await;
    // Three tool activities of 3 MiB each: each is a candidate type, so its payload would be
    // parsed to learn its kind.
    harness
        .repositories
        .database()
        .call(|connection| {
            let output = "x".repeat(3 * 1024 * 1024);
            for version in 0..3 {
                let payload = json!({
                    "threadId": "loud",
                    "activity": {
                        "id": format!("tool-{version}"), "tone": "tool", "kind": "tool.completed",
                        "summary": "Ran", "payload": { "output": output }, "turnId": null,
                        "createdAt": CREATED_AT,
                    },
                });
                connection.execute(
                    "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, 'thread', 'loud', ?, 'thread.activity-appended', ?, NULL, NULL, NULL, 'provider', ?, '{}')",
                    rusqlite::params![format!("tool-{version}"), 1_000 + version, CREATED_AT, payload.to_string()],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
    ask(&harness, "loud", "approval.requested", "req-loud").await;
    // At most one large payload is parsed per call: each call returns its progress, and the
    // approval behind them is still found.
    let first = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    assert_eq!(first["entries"], json!([]), "{first}");
    assert_eq!(first["more"], true);
    let (start, _) = positions(&cursor);
    let (after_first, _) = positions(first["cursor"].as_str().unwrap());
    assert_eq!(after_first, start + 1, "one large payload per call");
    let mut at = first["cursor"].as_str().unwrap().to_owned();
    let mut calls = 1;
    let found = loop {
        let page = feed(&harness, &agent, json!({ "cursor": at })).await;
        calls += 1;
        assert_increasing(&at, &page);
        at = page["cursor"].as_str().unwrap().to_owned();
        if !page["entries"].as_array().unwrap().is_empty() || page["more"] == false {
            break page;
        }
        assert!(calls < 10, "the feed makes progress");
    };
    assert_eq!(kinds(&found), ["approval.requested"]);
    assert_eq!(found["entries"][0]["requestId"], "req-loud");
    harness.shutdown().await;
}

/// The worst case of one page, measured: 5,000 approval-shaped candidates of 100 KiB each
/// in a file database. Run with `--ignored --nocapture`.
#[tokio::test]
#[ignore = "a measurement, not a check: it writes about 500 MB"]
async fn measure_one_page_over_5000_large_events() {
    let folder = tempfile::tempdir().expect("folder");
    let path = folder.path().join("state.sqlite");
    Database::create_new(&path)
        .await
        .expect("database")
        .close()
        .await;
    let database = Database::open_existing(&path).await.expect("database");
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            let transaction = connection.transaction()?;
            let output = "x".repeat(100 * 1024);
            for version in 0..5_000 {
                let payload = json!({
                    "threadId": "loud",
                    "activity": {
                        "id": format!("tool-{version}"), "tone": "tool", "kind": "tool.completed",
                        "summary": "Ran", "payload": { "output": output }, "turnId": null,
                        "createdAt": CREATED_AT,
                    },
                });
                transaction.execute(
                    "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, 'thread', 'loud', ?, 'thread.activity-appended', ?, NULL, NULL, NULL, 'provider', ?, '{}')",
                    rusqlite::params![format!("tool-{version}"), version, CREATED_AT, payload.to_string()],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
        .await
        .unwrap();
    // Reopened, so SQLite's own page cache starts empty.
    database.close().await;
    let database = Database::open_existing(&path).await.expect("database");
    let repositories = Repositories::new(database.clone());
    // Bounded first, on a cold cache, so its window read is not helped by the full read.
    for (name, budget) in [
        ("bounded", crate::mcp::tools::feed::PARSE_BUDGET),
        ("unbounded (before)", usize::MAX),
        ("bounded", crate::mcp::tools::feed::PARSE_BUDGET),
    ] {
        let started = std::time::Instant::now();
        let read = repositories
            .read_change_feed(crate::persistence::ChangeFeedQuery {
                after_sequence: 0,
                after_activity: 0,
                thread_id: None,
                scan_limit: crate::mcp::tools::feed::SCAN_LIMIT,
                parse_budget: budget,
                activity_limit: 101,
            })
            .await
            .unwrap();
        println!(
            "{name}: {} events scanned in {:?}",
            read.scanned,
            started.elapsed()
        );
    }
    database.close().await;
}

#[tokio::test]
async fn a_cursor_older_than_the_oldest_activity_row_reports_it_dropped() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    activity_row(&harness, None).await;
    let cursor = head(&harness, &agent).await;
    activity_row(&harness, None).await;
    activity_row(&harness, None).await;
    let kept = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    assert_eq!(kept["activityDropped"], false);
    assert_eq!(kinds(&kept), ["agent.call", "agent.call"]);
    // Pruning removes the row right after the cursor.
    let (_, after) = positions(&cursor);
    harness
        .repositories
        .database()
        .call(move |connection| {
            connection.execute(
                "DELETE FROM mcp_activity WHERE activity_id <= ?",
                [after + 1],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let dropped = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    assert_eq!(dropped["activityDropped"], true, "{dropped}");
    assert_eq!(kinds(&dropped), ["agent.call"]);
    // Every row pruned: the log's own sequence still shows the gap.
    harness
        .repositories
        .database()
        .call(|connection| {
            connection.execute("DELETE FROM mcp_activity", [])?;
            Ok(())
        })
        .await
        .unwrap();
    let empty = feed(&harness, &agent, json!({ "cursor": cursor })).await;
    assert_eq!(empty["activityDropped"], true, "{empty}");
    // A cursor from now on reports nothing dropped.
    let fresh = head(&harness, &agent).await;
    let fresh = feed(&harness, &agent, json!({ "cursor": fresh })).await;
    assert_eq!(fresh["activityDropped"], false);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_bad_cursor_or_limit_is_refused() {
    let harness = Harness::new().await;
    let (agent, _) = harness.agent(McpAccess::FullAccess).await;
    for arguments in [
        json!({ "cursor": "nonsense" }),
        json!({ "cursor": "v2.1.1" }),
        json!({ "cursor": "v1.-1.0" }),
        json!({ "cursor": "v1.999999.0" }),
        json!({ "limit": 0 }),
        json!({ "limit": 501 }),
        json!({ "since": "now" }),
    ] {
        let refused = harness
            .call(&agent, "changes_since", arguments.clone())
            .await;
        assert_eq!(
            error_tag(&refused),
            "McpInvalidArgumentError",
            "{arguments}"
        );
    }
    harness.shutdown().await;
}

/// One server's worth of the parts `changes_since` reads, on the database at `path`.
struct Server {
    engine: OrchestrationEngine,
    control: McpControl,
    agent: ClientPrincipal,
    database: Database,
    _settings: watch::Sender<McpServerSettings>,
}

impl Server {
    async fn start(path: &std::path::Path, secrets: &std::path::Path) -> Self {
        let database = Database::open_existing(path).await.expect("database");
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
        let repositories = Repositories::new(database.clone());
        let auth = AuthService::new_with_persistence(
            &ServerConfig::new(".").with_bind("127.0.0.1", 3773),
            vec![7_u8; 32],
            SecretStore::new(secrets).await.expect("secret store"),
            repositories.clone(),
        )
        .await
        .expect("auth");
        let (settings, receiver) = watch::channel(McpServerSettings::default());
        let control = McpControl::new(RpcRegistry::empty(), auth.clone(), engine.clone(), receiver);
        let link = issue_mcp_pairing_link(&repositories, "MCP · test".into(), "read-only", &[])
            .await
            .expect("link");
        let session = auth
            .exchange_bootstrap(
                &link.credential,
                None,
                ClientMetadata::default(),
                None,
                SessionTransport::Plain,
            )
            .await
            .expect("exchange");
        let agent = control
            .authenticate(&session.token)
            .await
            .expect("an MCP credential");
        Self {
            engine,
            control,
            agent,
            database,
            _settings: settings,
        }
    }

    async fn feed(&self, arguments: Value) -> Value {
        let Value::Object(arguments) = arguments else {
            unreachable!()
        };
        let result = self
            .control
            .call(
                &self.agent,
                "changes_since",
                &arguments,
                None,
                tokio_util::sync::CancellationToken::new(),
            )
            .await;
        structured(&result).clone()
    }

    async fn stop(self) {
        self.engine.shutdown().await;
        drop(self.control);
        self.database.close().await;
    }
}

#[tokio::test]
async fn a_transition_written_while_the_server_was_stopped_is_returned_after_a_restart() {
    let folder = tempfile::tempdir().expect("folder");
    let secrets = tempfile::tempdir().expect("secrets");
    let path = folder.path().join("state.sqlite");
    Database::create_new(&path)
        .await
        .expect("database")
        .close()
        .await;
    let server = Server::start(&path, secrets.path()).await;
    let cursor = server.feed(json!({})).await["cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    server
        .engine
        .dispatch(command(json!({
            "type": "project.create", "commandId": "project-create", "projectId": "p1",
            "title": "Project", "workspaceRoot": folder.path(),
            "defaultModelSelection": {"instanceId": "codex", "model": "gpt-5"},
            "createdAt": CREATED_AT,
        })))
        .await
        .expect("project");
    server
        .engine
        .dispatch(command(json!({
            "type": "thread.create", "commandId": "create-t1", "threadId": "t1",
            "projectId": "p1", "title": "t1",
            "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdAt": CREATED_AT,
        })))
        .await
        .expect("thread");
    server.stop().await;

    // Written by another process while no server runs.
    let database = Database::open_existing(&path).await.expect("database");
    Repositories::new(database.clone())
        .append_event(NewOrchestrationEvent {
            event_id: "archived-offline".into(),
            aggregate_kind: "thread".into(),
            aggregate_id: "t1".into(),
            event_type: "thread.archived".into(),
            occurred_at: CREATED_AT.into(),
            command_id: Some("archive-offline".into()),
            causation_event_id: None,
            correlation_id: None,
            payload: json!({ "threadId": "t1", "archivedAt": CREATED_AT, "updatedAt": CREATED_AT }),
            metadata: json!({}),
        })
        .await
        .expect("event");
    database.close().await;

    let server = Server::start(&path, secrets.path()).await;
    let page = server.feed(json!({ "cursor": cursor })).await;
    // The project's own first thread, then `t1` created before the stop and archived while
    // stopped.
    let t1: Vec<&str> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["threadId"] == "t1")
        .map(|entry| entry["kind"].as_str().unwrap())
        .collect();
    assert_eq!(t1, ["thread.created", "thread.archived"], "{page}");
    assert_eq!(page["more"], false);
    assert_increasing(&cursor, &page);
    server.stop().await;
}
