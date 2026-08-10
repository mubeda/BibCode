use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use bibcode_server::{
    CauseItem, RpcExit, RpcRegistry, ServerConfig, ServerMessage, ServerRuntime,
    git::{
        GitCommandError, GitPrunableWorktree, GitRepository, GitWorktreeInventory,
        GitWorktreeRecord, GitWorktreeRemovalInspection,
    },
    orchestration::{
        EngineOptions, OrchestrationCommand, OrchestrationEngine, OrchestrationError,
        canonical_command_digest, engine::TestHooks,
    },
    persistence::{
        CommandReceipt, Database, OrchestrationEvent, ProjectionProject, ProjectionThread,
        Repositories, run_migrations,
    },
    production::git_vcs::{CatalogMutationObserver, GitVcsRpcServices, register_git_vcs_rpc},
    production::worktree_catalog_rpc::{
        WorktreeCatalogMutationObserver, WorktreeCatalogRpcServices,
        WorktreeRemovalCleanupAdmission, WorktreeRemovalCleanupAdmissionError,
        WorktreeRemovalCleanupAdmissionFuture, WorktreeRemovalGit, WorktreeRemovalGitFuture,
        WorktreeRemovalQuiesceFuture, WorktreeRemovalQuiesceLease, WorktreeRemovalQuiesceRequest,
        WorktreeRemovalQuiescer, compact_eligible_baseline, register_worktree_catalog_rpc,
    },
    worktree_catalog::{
        CatalogScanStatus, WorktreeAdoptionState, WorktreeCatalogService, WorktreeCatalogSnapshot,
        WorktreeDescriptor, WorktreeDirectoryState, WorktreeRegistrationState,
    },
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tempfile::TempDir;
use tokio::{
    sync::{Semaphore, mpsc},
    time::timeout,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;

type TestSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[tokio::test]
async fn stream_delivers_initial_and_latest_snapshots_refreshes_and_cancels() {
    let mut fixture = CatalogRpcFixture::new(false).await;

    request(
        fixture.socket(),
        "1",
        "subscribeWorktreeCatalog",
        json!({ "projectId": "project-1" }),
    )
    .await;
    let initial = next_chunk(fixture.socket(), "1").await;
    let initial_generation = initial["generation"].as_u64().expect("initial generation");
    assert_eq!(initial["authoritative"], true);
    assert_eq!(initial["worktrees"].as_array().expect("worktrees").len(), 1);
    ack(fixture.socket(), "1").await;
    assert!(
        timeout(Duration::from_millis(100), fixture.socket().next())
            .await
            .is_err(),
        "the initial latest value must not be emitted twice"
    );

    fixture.create_external_worktree();
    request(
        fixture.socket(),
        "2",
        "vcs.refreshWorktreeCatalog",
        json!({ "projectId": "project-1" }),
    )
    .await;

    let mut refreshed = None;
    let mut refresh_result = None;
    while refreshed.is_none() || refresh_result.is_none() {
        match next_server_message(fixture.socket()).await {
            ServerMessage::Chunk { request_id, values } if request_id.as_str() == "1" => {
                let value = values.into_iter().next().expect("catalog value");
                ack(fixture.socket(), "1").await;
                if value["authoritative"] == true
                    && value["generation"].as_u64().unwrap_or(0) > initial_generation
                {
                    refreshed = Some(value);
                }
            }
            ServerMessage::Exit {
                request_id,
                exit: RpcExit::Success { value: Some(value) },
            } if request_id.as_str() == "2" => refresh_result = Some(value),
            other => panic!("unexpected catalog refresh message: {other:?}"),
        }
    }
    let refreshed = refreshed.expect("latest replacement");
    let refresh_result = refresh_result.expect("explicit refresh result");
    assert_eq!(refreshed, refresh_result);
    assert_eq!(
        refreshed["worktrees"].as_array().expect("worktrees").len(),
        2
    );

    send_json(
        fixture.socket(),
        json!({ "_tag": "Interrupt", "requestId": "1" }),
    )
    .await;
    let exit = next_server_message(fixture.socket()).await;
    assert!(matches!(
        exit,
        ServerMessage::Exit { request_id, .. } if request_id.as_str() == "1"
    ));

    request(
        fixture.socket(),
        "3",
        "subscribeWorktreeCatalog",
        json!({ "projectId": "project-1" }),
    )
    .await;
    let resubscribed = next_chunk(fixture.socket(), "3").await;
    assert!(
        resubscribed["generation"].as_u64().expect("generation")
            > refreshed["generation"].as_u64().expect("generation"),
        "cancelling the stream must release the catalog subscription so the next subscriber performs a first-subscriber refresh"
    );
    send_json(
        fixture.socket(),
        json!({ "_tag": "Interrupt", "requestId": "3" }),
    )
    .await;
    let _exit = next_server_message(fixture.socket()).await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn project_missing_is_a_typed_stream_and_refresh_failure() {
    let mut fixture = CatalogRpcFixture::new(false).await;

    request(
        fixture.socket(),
        "10",
        "vcs.refreshWorktreeCatalog",
        json!({ "projectId": "missing" }),
    )
    .await;
    assert_typed_catalog_failure(fixture.socket(), "10", "project-not-found").await;

    request(
        fixture.socket(),
        "11",
        "subscribeWorktreeCatalog",
        json!({ "projectId": "missing" }),
    )
    .await;
    assert_typed_catalog_failure(fixture.socket(), "11", "project-not-found").await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn stream_replaces_ack_lagged_updates_with_the_latest_catalog_generation() {
    let mut fixture = CatalogRpcFixture::new(false).await;
    request(
        fixture.socket(),
        "12",
        "subscribeWorktreeCatalog",
        json!({ "projectId": "project-1" }),
    )
    .await;
    let initial = next_chunk(fixture.socket(), "12").await;
    let initial_generation = initial["generation"].as_u64().expect("generation");

    fixture.create_named_external_worktree("lag-one", "feature/lag-one");
    request(
        fixture.socket(),
        "13",
        "vcs.refreshWorktreeCatalog",
        json!({ "projectId": "project-1" }),
    )
    .await;
    let _first_refresh = success_value(fixture.socket(), "13").await;
    fixture.create_named_external_worktree("lag-two", "feature/lag-two");
    request(
        fixture.socket(),
        "14",
        "vcs.refreshWorktreeCatalog",
        json!({ "projectId": "project-1" }),
    )
    .await;
    let latest_refresh = success_value(fixture.socket(), "14").await;

    ack(fixture.socket(), "12").await;
    let delivered = next_chunk(fixture.socket(), "12").await;
    assert_eq!(delivered, latest_refresh);
    assert_eq!(
        delivered["generation"].as_u64().expect("generation"),
        initial_generation + 2
    );
    assert_eq!(
        delivered["worktrees"].as_array().expect("worktrees").len(),
        3
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn interrupt_during_catalog_subscribe_bootstrap_exits_without_a_snapshot() {
    let mut fixture = CatalogRpcFixture::new(false).await;
    send_json(
        fixture.socket(),
        json!([
            {
                "_tag": "Request",
                "id": "15",
                "tag": "subscribeWorktreeCatalog",
                "payload": { "projectId": "project-1" },
                "headers": []
            },
            { "_tag": "Interrupt", "requestId": "15" }
        ]),
    )
    .await;

    let message = next_server_message(fixture.socket()).await;
    let ServerMessage::Exit {
        request_id,
        exit: RpcExit::Failure { cause },
    } = message
    else {
        panic!("expected interrupt exit");
    };
    assert_eq!(request_id.as_str(), "15");
    assert!(
        cause
            .iter()
            .any(|item| matches!(item, CauseItem::Interrupt { .. }))
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), fixture.socket().next())
            .await
            .is_err(),
        "cancelled bootstrap must not publish a late snapshot"
    );
    assert!(
        fixture.catalog.latest("project-1").await.is_none(),
        "cancelled bootstrap must not leave a catalog entry behind"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn policy_rejects_stale_acknowledgement_and_persists_hidden_and_shown_controls() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    request(
        fixture.socket(),
        "20",
        "subscribeWorktreeCatalog",
        json!({ "projectId": "project-1" }),
    )
    .await;
    let snapshot = next_chunk(fixture.socket(), "20").await;
    let generation = snapshot["generation"].as_u64().expect("generation");
    let candidate_path = snapshot["worktrees"]
        .as_array()
        .expect("worktrees")
        .iter()
        .find(|worktree| worktree["eligibleForAdoption"] == true)
        .and_then(|worktree| worktree["path"].as_str())
        .expect("eligible path")
        .to_owned();
    ack(fixture.socket(), "20").await;

    request(
        fixture.socket(),
        "21",
        "worktree.updateDiscoveryPolicy",
        json!({
            "commandId": "policy-stale",
            "projectId": "project-1",
            "acknowledgeGeneration": generation.saturating_sub(1)
        }),
    )
    .await;
    assert_typed_catalog_failure(fixture.socket(), "21", "stale-generation").await;

    request(
        fixture.socket(),
        "22",
        "worktree.updateDiscoveryPolicy",
        json!({
            "commandId": "policy-shown",
            "projectId": "project-1",
            "visibility": "shown",
            "acknowledgeGeneration": generation,
            "dismissInitialPrompt": true
        }),
    )
    .await;
    let shown = success_value(fixture.socket(), "22").await;
    assert_eq!(shown["visibility"], "shown");
    assert!(shown["initialPromptDismissedAt"].as_str().is_some());
    assert_eq!(shown["baselinePaths"], json!([candidate_path]));

    request(
        fixture.socket(),
        "23",
        "worktree.updateDiscoveryPolicy",
        json!({
            "commandId": "policy-hidden",
            "projectId": "project-1",
            "visibility": "hidden",
            "dismissInitialPrompt": false
        }),
    )
    .await;
    let hidden = success_value(fixture.socket(), "23").await;
    assert_eq!(hidden["visibility"], "hidden");
    assert_eq!(hidden["initialPromptDismissedAt"], Value::Null);
    assert_eq!(hidden["baselinePaths"], shown["baselinePaths"]);

    let persisted = fixture
        .repositories
        .get_project("project-1".to_owned())
        .await
        .expect("project read")
        .expect("project exists");
    assert_eq!(persisted.worktree_discovery, hidden);
    fixture.shutdown().await;
}

#[tokio::test]
async fn concurrent_policy_controls_merge_without_losing_a_sibling_update() {
    let mut fixture = CatalogRpcFixture::new(false).await;
    send_json(
        fixture.socket(),
        json!([
            {
                "_tag": "Request",
                "id": "30",
                "tag": "worktree.updateDiscoveryPolicy",
                "payload": {
                    "commandId": "policy-concurrent-visibility",
                    "projectId": "project-1",
                    "visibility": "shown"
                },
                "headers": []
            },
            {
                "_tag": "Request",
                "id": "31",
                "tag": "worktree.updateDiscoveryPolicy",
                "payload": {
                    "commandId": "policy-concurrent-dismiss",
                    "projectId": "project-1",
                    "dismissInitialPrompt": true
                },
                "headers": []
            }
        ]),
    )
    .await;
    let mut responses = std::collections::HashMap::new();
    for _ in 0..2 {
        let message = next_server_message(fixture.socket()).await;
        let ServerMessage::Exit {
            request_id,
            exit: RpcExit::Success { value: Some(value) },
        } = message
        else {
            panic!("expected concurrent policy success: {message:?}");
        };
        responses.insert(request_id.as_str().to_owned(), value);
    }
    let first = responses.get("30").expect("visibility response");
    let second = responses.get("31").expect("dismiss response");
    assert!(first["visibility"] == "shown" || second["visibility"] == "shown");

    let persisted = fixture
        .repositories
        .get_project("project-1".to_owned())
        .await
        .expect("project read")
        .expect("project exists")
        .worktree_discovery;
    assert_eq!(persisted["visibility"], "shown");
    assert!(persisted["initialPromptDismissedAt"].as_str().is_some());
    fixture.shutdown().await;
}

#[tokio::test]
async fn adopt_race_converges_to_one_thread_without_creating_a_git_worktree() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    request(
        fixture.socket(),
        "90",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let snapshot = success_value(fixture.socket(), "90").await;
    let candidate = eligible_candidate(&snapshot);
    let before_inventory = git_output(&fixture.main, &["worktree", "list", "--porcelain"]);
    let payload = |command_id: &str| {
        json!({
            "commandId":command_id,
            "projectId":"project-1",
            "worktreeKey":candidate["worktreeKey"],
            "expectedGeneration":snapshot["generation"],
            "threadDefaults":{
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access",
                "interactionMode":"plan"
            }
        })
    };
    send_json(
        fixture.socket(),
        json!([
            {"_tag":"Request","id":"91","tag":"worktree.adopt","payload":payload("adopt-race-1"),"headers":[]},
            {"_tag":"Request","id":"92","tag":"worktree.adopt","payload":payload("adopt-race-2"),"headers":[]}
        ]),
    )
    .await;

    let mut results = Vec::new();
    for _ in 0..2 {
        let message = next_server_message(fixture.socket()).await;
        let ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } = message
        else {
            panic!("expected adoption success: {message:?}");
        };
        results.push(value);
    }
    assert_eq!(results[0]["threadId"], results[1]["threadId"]);
    let mut dispositions = results
        .iter()
        .map(|result| result["disposition"].as_str().expect("disposition"))
        .collect::<Vec<_>>();
    dispositions.sort_unstable();
    assert_eq!(dispositions, vec!["created", "existing"]);
    let external_path = canonical_string(&fixture.external);
    let threads = fixture
        .repositories
        .list_threads_by_project("project-1".to_owned())
        .await
        .expect("threads");
    assert_eq!(
        threads
            .iter()
            .filter(|thread| {
                thread.kind == "workspace"
                    && thread.deleted_at.is_none()
                    && thread.worktree_path.as_deref() == Some(external_path.as_str())
            })
            .count(),
        1
    );
    assert_eq!(
        git_output(&fixture.main, &["worktree", "list", "--porcelain"]),
        before_inventory
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn adopt_public_admission_replays_exactly_and_conflicts_on_changed_payload() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    request(
        fixture.socket(),
        "900",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let snapshot = success_value(fixture.socket(), "900").await;
    let candidate = eligible_candidate(&snapshot).clone();
    request(
        fixture.socket(),
        "901",
        "worktree.adopt",
        adoption_payload("adopt-admission-owner", &candidate, &snapshot),
    )
    .await;
    let owner = success_value(fixture.socket(), "901").await;
    request(
        fixture.socket(),
        "902",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let owned_snapshot = success_value(fixture.socket(), "902").await;
    let owned_candidate = descriptor_for_key(&owned_snapshot, &candidate["worktreeKey"]);
    let payload = adoption_payload("adopt-admitted", owned_candidate, &owned_snapshot);
    request(fixture.socket(), "903", "worktree.adopt", payload.clone()).await;
    let first = success_value(fixture.socket(), "903").await;
    assert_eq!(first["threadId"], owner["threadId"]);
    assert_eq!(first["disposition"], "existing");
    fixture
        .engine
        .dispatch(OrchestrationCommand::ThreadDelete {
            command_id: "delete-admitted-owner".to_owned(),
            thread_id: first["threadId"].as_str().expect("thread id").to_owned(),
        })
        .await
        .expect("delete accepted owner");
    let event_count = fixture
        .repositories
        .read_events_from_sequence(0, 512)
        .await
        .expect("event read")
        .len();

    request(fixture.socket(), "904", "worktree.adopt", payload.clone()).await;
    assert_eq!(
        success_value(fixture.socket(), "904").await,
        first,
        "an identical public retry must replay the accepted result exactly"
    );

    let mut changed_project = payload.clone();
    changed_project["projectId"] = json!("different-project");
    let mut changed_key = payload.clone();
    changed_key["worktreeKey"] = json!("different-worktree-key");
    let mut changed_generation = payload.clone();
    changed_generation["expectedGeneration"] = json!(
        payload["expectedGeneration"]
            .as_u64()
            .expect("expected generation")
            + 1
    );
    let mut changed_defaults = payload.clone();
    changed_defaults["threadDefaults"]["interactionMode"] = json!("plan");
    let mutations = [
        ("project", changed_project),
        ("worktree-key", changed_key),
        ("expected-generation", changed_generation),
        ("thread-defaults", changed_defaults),
    ];
    let mut outcomes = Vec::new();
    let external_path = canonical_string(&fixture.external);
    for (index, (field, changed_payload)) in mutations.into_iter().enumerate() {
        let request_id = (905 + index).to_string();
        request(
            fixture.socket(),
            &request_id,
            "worktree.adopt",
            changed_payload,
        )
        .await;
        let (outcome, wire_value) = adoption_outcome(fixture.socket(), &request_id).await;
        assert!(
            !wire_value.to_string().contains(&external_path),
            "a command conflict must not expose the server-resolved checkout path"
        );
        outcomes.push((field, outcome));
    }
    assert_eq!(
        outcomes,
        vec![
            ("project", "command-conflict".to_owned()),
            ("worktree-key", "command-conflict".to_owned()),
            ("expected-generation", "command-conflict".to_owned()),
            ("thread-defaults", "command-conflict".to_owned()),
        ]
    );
    assert_eq!(
        fixture
            .repositories
            .read_events_from_sequence(0, 512)
            .await
            .expect("event read")
            .len(),
        event_count,
        "replay and conflicting retries must not append orchestration effects"
    );
    assert!(
        fixture
            .repositories
            .get_command_receipt("adopt-admitted".to_owned())
            .await
            .expect("receipt read")
            .expect("receipt")
            .payload_digest
            .is_some(),
        "the public adoption receipt must retain the canonical public payload digest"
    );
    let changed = fixture
        .repositories
        .database()
        .call(|connection| {
            Ok(connection.execute(
                "UPDATE orchestration_events SET metadata_json = '{\"worktreeKey\":\"corrupt\",\"adoptionResult\":\"malformed\"}' WHERE command_id = 'adopt-admitted' AND event_type = 'project.meta-updated'",
                [],
            )?)
        })
        .await
        .expect("corrupt adoption receipt metadata");
    assert_eq!(changed, 1);
    request(fixture.socket(), "909", "worktree.adopt", payload).await;
    let (outcome, wire_value) = adoption_outcome(fixture.socket(), "909").await;
    assert_eq!(outcome, "internal");
    assert!(!wire_value.to_string().contains(&external_path));
    assert_eq!(
        fixture
            .repositories
            .read_events_from_sequence(0, 512)
            .await
            .expect("event read")
            .len(),
        event_count,
        "a malformed durable result must fail closed without replacement effects"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn adopt_stale_generation_forces_refresh_then_revalidates() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    request(
        fixture.socket(),
        "93",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let stale = success_value(fixture.socket(), "93").await;
    let candidate = eligible_candidate(&stale).clone();
    request(
        fixture.socket(),
        "94",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let current = success_value(fixture.socket(), "94").await;
    assert!(current["generation"].as_u64() > stale["generation"].as_u64());

    request(
        fixture.socket(),
        "95",
        "worktree.adopt",
        adoption_payload("adopt-stale", &candidate, &stale),
    )
    .await;
    let adopted = success_value(fixture.socket(), "95").await;
    assert_eq!(adopted["disposition"], "created");
    assert_eq!(
        fixture
            .catalog
            .latest("project-1")
            .await
            .expect("latest")
            .generation,
        current["generation"].as_u64().expect("current generation") + 1,
        "stale adoption must force exactly a fresh revalidation scan before mutating"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn adopt_external_disappearance_fails_without_creating_a_thread() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    request(
        fixture.socket(),
        "96",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let snapshot = success_value(fixture.socket(), "96").await;
    let candidate = eligible_candidate(&snapshot).clone();
    fs::remove_dir_all(&fixture.external).expect("external checkout disappears");

    request(
        fixture.socket(),
        "97",
        "worktree.adopt",
        adoption_payload("adopt-missing", &candidate, &snapshot),
    )
    .await;
    assert_typed_adoption_failure(fixture.socket(), "97", "workspace-missing").await;
    let threads = fixture
        .repositories
        .list_threads_by_project("project-1".to_owned())
        .await
        .expect("threads");
    assert!(threads.iter().all(|thread| thread.kind != "workspace"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn adopt_restores_archived_then_returns_the_active_thread() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    request(
        fixture.socket(),
        "98",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let initial = success_value(fixture.socket(), "98").await;
    let candidate = eligible_candidate(&initial).clone();
    request(
        fixture.socket(),
        "99",
        "worktree.adopt",
        adoption_payload("adopt-first", &candidate, &initial),
    )
    .await;
    let created = success_value(fixture.socket(), "99").await;
    let thread_id = created["threadId"].as_str().expect("thread id").to_owned();
    fixture
        .engine
        .dispatch(OrchestrationCommand::ThreadArchive {
            command_id: "archive-adopted".to_owned(),
            thread_id: thread_id.clone(),
        })
        .await
        .expect("archive");
    request(
        fixture.socket(),
        "100",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let archived = success_value(fixture.socket(), "100").await;
    let archived_descriptor = descriptor_for_key(&archived, &candidate["worktreeKey"]);
    assert_eq!(archived_descriptor["adoptionState"], "archived");
    request(
        fixture.socket(),
        "101",
        "worktree.adopt",
        adoption_payload("adopt-restore", archived_descriptor, &archived),
    )
    .await;
    let restored = success_value(fixture.socket(), "101").await;
    assert_eq!(
        restored,
        json!({"threadId":thread_id,"disposition":"restored"})
    );

    request(
        fixture.socket(),
        "102",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let active = success_value(fixture.socket(), "102").await;
    let active_descriptor = descriptor_for_key(&active, &candidate["worktreeKey"]);
    request(
        fixture.socket(),
        "103",
        "worktree.adopt",
        adoption_payload("adopt-existing", active_descriptor, &active),
    )
    .await;
    let existing = success_value(fixture.socket(), "103").await;
    assert_eq!(
        existing,
        json!({"threadId":thread_id,"disposition":"existing"})
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn adopted_branch_reconciliation_is_deterministic_and_healthy_only() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    request(
        fixture.socket(),
        "104",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let initial = success_value(fixture.socket(), "104").await;
    let candidate = eligible_candidate(&initial).clone();
    request(
        fixture.socket(),
        "105",
        "worktree.adopt",
        adoption_payload("adopt-for-branch-reconcile", &candidate, &initial),
    )
    .await;
    let adopted = success_value(fixture.socket(), "105").await;
    let thread_id = adopted["threadId"].as_str().expect("thread id").to_owned();

    git(
        &fixture.external,
        &["checkout", "-b", "feature/reconciled"],
        None,
    );
    let head = git_output(&fixture.external, &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    request(
        fixture.socket(),
        "106",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let refreshed = success_value(fixture.socket(), "106").await;
    assert_eq!(
        descriptor_for_key(&refreshed, &candidate["worktreeKey"])["branch"],
        "feature/reconciled"
    );
    let durable = fixture
        .repositories
        .get_thread(thread_id.clone())
        .await
        .expect("thread read")
        .expect("thread exists");
    assert_eq!(durable.branch.as_deref(), Some("feature/reconciled"));
    let reconciliation_events = branch_reconciliation_events(&fixture.repositories).await;
    assert_eq!(reconciliation_events.len(), 1);
    let expected_command_id =
        branch_reconciliation_command_id(&thread_id, Some("feature/reconciled"), Some(&head));
    assert_eq!(
        reconciliation_events[0].event.command_id.as_deref(),
        Some(expected_command_id.as_str())
    );
    assert!(!expected_command_id.contains(&canonical_string(&fixture.external)));

    request(
        fixture.socket(),
        "107",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let _unchanged = success_value(fixture.socket(), "107").await;
    assert_eq!(
        branch_reconciliation_events(&fixture.repositories)
            .await
            .len(),
        1,
        "an unchanged healthy snapshot must not dispatch a second command"
    );

    git(
        &fixture.external,
        &["checkout", "-b", "feature/degraded"],
        None,
    );
    let common_dir = fixture.main.join(".git");
    let unavailable = fixture.main.join(".git-unavailable");
    fs::rename(&common_dir, &unavailable).expect("make Git metadata unavailable");
    request(
        fixture.socket(),
        "108",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let degraded = success_value(fixture.socket(), "108").await;
    assert_eq!(degraded["authoritative"], false);
    assert_eq!(
        fixture
            .repositories
            .get_thread(thread_id)
            .await
            .expect("thread read")
            .expect("thread exists")
            .branch
            .as_deref(),
        Some("feature/reconciled")
    );
    assert_eq!(
        branch_reconciliation_events(&fixture.repositories)
            .await
            .len(),
        1,
        "a degraded retained snapshot must never emit branch metadata"
    );
    fs::rename(&unavailable, &common_dir).expect("restore Git metadata");
    fixture.shutdown().await;
}

#[tokio::test]
async fn successful_legacy_git_mutations_suppress_and_invalidate_the_live_catalog() {
    let mut fixture = CatalogRpcFixture::new(false).await;
    request(
        fixture.socket(),
        "40",
        "subscribeWorktreeCatalog",
        json!({ "projectId": "project-1" }),
    )
    .await;
    let _initial = next_chunk(fixture.socket(), "40").await;
    ack(fixture.socket(), "40").await;

    let created_path = fixture.external.clone();
    let create_payload = json!({
        "cwd": fixture.main,
        "refName": "main",
        "newRefName": "feature/managed",
        "baseRefName": "main",
        "path": created_path
    });
    request(fixture.socket(), "41", "vcs.createWorktree", create_payload).await;
    let created = wait_for_mutation_and_catalog_count(fixture.socket(), "41", "40", 2).await;
    let managed = created["worktrees"]
        .as_array()
        .expect("created worktrees")
        .iter()
        .find(|worktree| worktree["path"] == canonical_string(&created_path))
        .expect("managed worktree");
    assert_eq!(managed["eligibleForAdoption"], false);

    let remove_payload = json!({ "cwd": fixture.main, "path": created_path, "force": true });
    request(fixture.socket(), "42", "vcs.removeWorktree", remove_payload).await;
    let removed = wait_for_mutation_and_catalog_count(fixture.socket(), "42", "40", 1).await;
    assert_eq!(
        removed["worktrees"]
            .as_array()
            .expect("removed worktrees")
            .len(),
        1
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn git_mutation_observation_updates_every_project_view_of_the_verified_repository() {
    let mut fixture = CatalogRpcFixture::new(false).await;
    #[cfg(unix)]
    let alias_root = {
        let alias_root = fixture.root.path().join("primary-symlink");
        std::os::unix::fs::symlink(&fixture.main, &alias_root).expect("primary symlink");
        alias_root
    };
    #[cfg(not(unix))]
    let alias_root = fixture.main.join(".");
    fixture
        .create_project("project-alias", alias_root.clone())
        .await;
    for (request_id, project_id) in [("60", "project-1"), ("61", "project-alias")] {
        request(
            fixture.socket(),
            request_id,
            "subscribeWorktreeCatalog",
            json!({ "projectId": project_id }),
        )
        .await;
        let _initial = next_chunk(fixture.socket(), request_id).await;
        ack(fixture.socket(), request_id).await;
    }

    let created_path = fixture.root.path().join("shared-managed");
    let create_payload = json!({
        "cwd": alias_root,
        "refName": "main",
        "newRefName": "feature/shared-managed",
        "baseRefName": "main",
        "path": created_path
    });
    request(fixture.socket(), "62", "vcs.createWorktree", create_payload).await;
    let mut mutation_succeeded = false;
    let mut updated = std::collections::HashMap::<String, usize>::new();
    while !mutation_succeeded || updated.len() != 2 {
        match next_server_message(fixture.socket()).await {
            ServerMessage::Exit {
                request_id,
                exit: RpcExit::Success { .. },
            } if request_id.as_str() == "62" => mutation_succeeded = true,
            ServerMessage::Chunk { request_id, values }
                if request_id.as_str() == "60" || request_id.as_str() == "61" =>
            {
                let value = values.into_iter().next().expect("catalog value");
                ack(fixture.socket(), request_id.as_str()).await;
                if value["authoritative"] == true
                    && value["worktrees"]
                        .as_array()
                        .is_some_and(|worktrees| worktrees.len() == 2)
                {
                    let managed = value["worktrees"]
                        .as_array()
                        .expect("worktrees")
                        .iter()
                        .find(|worktree| worktree["path"] == canonical_string(&created_path))
                        .expect("managed worktree");
                    assert_eq!(managed["eligibleForAdoption"], false);
                    *updated.entry(request_id.as_str().to_owned()).or_default() += 1;
                }
            }
            other => panic!("unexpected alias observation message: {other:?}"),
        }
    }
    assert_eq!(
        updated,
        std::collections::HashMap::from([("60".to_owned(), 1), ("61".to_owned(), 1),])
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn remove_observation_uses_adopted_cwd_and_removed_target_for_unpinned_association() {
    let mut fixture = CatalogRpcFixture::new(false).await;
    let adopted_cwd = fixture.create_named_external_worktree("adopted-cwd", "feature/adopted-cwd");
    let removed_target =
        fixture.create_named_external_worktree("removed-target", "feature/removed-target");
    fixture
        .create_project_with_thread(
            "project-target",
            removed_target.clone(),
            removed_target.clone(),
        )
        .await;
    let projection = fixture
        .repositories
        .load_worktree_catalog_projection("project-target".to_owned(), 512)
        .await
        .expect("projection read")
        .expect("target project");
    assert_eq!(
        projection.threads[0].worktree_path.as_deref(),
        Some(removed_target.to_string_lossy().as_ref())
    );
    request(
        fixture.socket(),
        "70",
        "subscribeWorktreeCatalog",
        json!({ "projectId": "project-target" }),
    )
    .await;
    let initial = next_chunk(fixture.socket(), "70").await;
    assert_eq!(initial["worktrees"].as_array().expect("worktrees").len(), 3);
    ack(fixture.socket(), "70").await;
    fixture
        .create_project(
            "project-target",
            fixture.root.path().join("missing-primary"),
        )
        .await;
    fixture
        .repositories
        .database()
        .call(|connection| {
            connection.execute(
                "DELETE FROM project_worktree_repository_pins WHERE project_id = 'project-target'",
                [],
            )?;
            Ok(())
        })
        .await
        .expect("remove durable pin for target-only association");

    request(
        fixture.socket(),
        "71",
        "vcs.removeWorktree",
        json!({ "cwd": adopted_cwd, "path": removed_target, "force": true }),
    )
    .await;
    let mut mutation_succeeded = false;
    let mut invalidated = false;
    while !mutation_succeeded || !invalidated {
        match next_server_message(fixture.socket()).await {
            ServerMessage::Exit {
                request_id,
                exit: RpcExit::Success { .. },
            } if request_id.as_str() == "71" => mutation_succeeded = true,
            ServerMessage::Chunk { request_id, values } if request_id.as_str() == "70" => {
                let value = values.into_iter().next().expect("catalog value");
                ack(fixture.socket(), "70").await;
                if value["scanStatus"]["_tag"] == "degraded" {
                    invalidated = true;
                }
            }
            other => panic!("unexpected remove association message: {other:?}"),
        }
    }
    assert!(
        !removed_target.exists(),
        "the association must still use the remove target after Git deletes its directory"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn git_mutation_observation_excludes_a_pinned_unrelated_repository() {
    let mut fixture = CatalogRpcFixture::new(false).await;
    let unrelated = fixture.root.path().join("unrelated-main");
    fs::create_dir(&unrelated).expect("unrelated directory");
    git(&unrelated, &["init", "--initial-branch", "main"], None);
    git(
        &unrelated,
        &["config", "user.email", "rpc@example.invalid"],
        None,
    );
    git(&unrelated, &["config", "user.name", "RPC Test"], None);
    fs::write(unrelated.join("README.md"), "unrelated\n").expect("unrelated file");
    git(&unrelated, &["add", "README.md"], None);
    git(&unrelated, &["commit", "-m", "initial"], None);
    fixture
        .create_project("project-unrelated", unrelated.clone())
        .await;
    for (request_id, project_id) in [("80", "project-1"), ("81", "project-unrelated")] {
        request(
            fixture.socket(),
            request_id,
            "subscribeWorktreeCatalog",
            json!({ "projectId": project_id }),
        )
        .await;
        let _initial = next_chunk(fixture.socket(), request_id).await;
        ack(fixture.socket(), request_id).await;
    }
    let created_path = fixture.root.path().join("main-only-managed");
    let payload = json!({
        "cwd": fixture.main,
        "refName": "main",
        "newRefName": "feature/main-only",
        "baseRefName": "main",
        "path": created_path
    });
    request(fixture.socket(), "82", "vcs.createWorktree", payload).await;
    let _updated = wait_for_mutation_and_catalog_count(fixture.socket(), "82", "80", 2).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(150), fixture.socket().next())
            .await
            .is_err(),
        "the unrelated pinned project must not be invalidated"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn unverifiable_git_identity_fails_observation_closed_without_notifying_a_project() {
    let fixture = CatalogRpcFixture::new(false).await;
    let observer = WorktreeCatalogMutationObserver::new(
        fixture.catalog.clone(),
        fixture.repositories.clone(),
        Arc::new(GitRepository::default()),
    );
    let unrelated = fixture.root.path().join("not-a-repository");
    fs::create_dir(&unrelated).expect("unrelated directory");

    let error = observer
        .note_managed_creation(&unrelated, &unrelated.join("target"))
        .await
        .expect_err("unverifiable identity must fail closed");

    assert!(error.contains("Git"));
    assert!(fixture.catalog.latest("project-1").await.is_none());
    fixture.shutdown().await;
}

#[test]
fn authoritative_baseline_compaction_filters_deduplicates_and_caps_exactly() {
    let mut worktrees = (0..514)
        .map(|index| descriptor(format!("/repo/worktree-{index:03}"), true))
        .collect::<Vec<_>>();
    worktrees.insert(2, descriptor("/repo/worktree-001".to_owned(), true));
    worktrees.insert(3, descriptor("/repo/ineligible".to_owned(), false));
    let snapshot = WorktreeCatalogSnapshot {
        repository_key: "repository-1".to_owned(),
        generation: 9,
        authoritative: true,
        observed_at: "2026-08-09T00:00:00Z".to_owned(),
        scan_status: CatalogScanStatus::Ready,
        worktrees,
        adopted_workspaces: Vec::new(),
    };

    let compacted = compact_eligible_baseline(&snapshot).expect("authoritative baseline");

    assert_eq!(compacted.len(), 512);
    assert_eq!(compacted[0], "/repo/worktree-000");
    assert_eq!(compacted[1], "/repo/worktree-001");
    assert_eq!(compacted[2], "/repo/worktree-002");
    assert_eq!(compacted[511], "/repo/worktree-511");
    assert!(!compacted.iter().any(|path| path == "/repo/ineligible"));
}

fn descriptor(path: String, eligible_for_adoption: bool) -> WorktreeDescriptor {
    WorktreeDescriptor {
        worktree_key: format!("key-{path}"),
        path,
        branch: Some("feature".to_owned()),
        head: Some("abc123".to_owned()),
        is_primary: false,
        is_bare: false,
        locked: false,
        lock_reason: None,
        registration_state: WorktreeRegistrationState::Registered,
        directory_state: WorktreeDirectoryState::Present,
        adoption_state: WorktreeAdoptionState::None,
        adopted_thread_id: None,
        eligible_for_adoption,
    }
}

#[tokio::test]
async fn removal_present_clean_is_verified_detached_branch_preserving_and_idempotent() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-clean").await;
    request(
        fixture.socket(),
        "1202",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1202").await;
    assert_eq!(plan["availability"], "present");
    assert_eq!(plan["trackedChangeCount"], 0);
    assert_eq!(plan["untrackedFileCount"], 0);
    let payload = json!({
        "commandId":"remove-clean",
        "projectId":"project-1",
        "threadId":thread_id,
        "mode":"delete-git-worktree",
        "expectedGeneration":plan["generation"],
        "planToken":plan["planToken"],
        "forceDirty":false,
        "confirmRepositoryWidePrune":false
    });
    request(fixture.socket(), "1203", "worktree.remove", payload.clone()).await;
    let result = success_value(fixture.socket(), "1203").await;
    assert_eq!(result["threadRemoved"], true);
    assert_eq!(result["gitOutcome"], "removed");
    assert_eq!(result["orphanCleanupPending"], false);
    assert!(!fixture.external.exists());
    assert!(
        git_output(&fixture.main, &["branch", "--list", "feature/external"])
            .contains("feature/external"),
        "removal preserves the local branch"
    );
    let thread = fixture
        .repositories
        .get_thread(thread_id.clone())
        .await
        .expect("thread read")
        .expect("thread projection");
    assert!(thread.deleted_at.is_some());

    request(fixture.socket(), "1204", "worktree.remove", payload.clone()).await;
    assert_eq!(success_value(fixture.socket(), "1204").await, result);
    let mut changed = payload;
    changed["forceDirty"] = json!(true);
    request(fixture.socket(), "1205", "worktree.remove", changed).await;
    assert_typed_removal_failure(fixture.socket(), "1205", "command-conflict").await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_command_reservation_allows_only_one_cross_repository_git_mutation() {
    let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let removal_git = Arc::new(BlockingRemovalGit {
        inner: GitRepository::default(),
        entered: entered_tx,
        release: release.clone(),
    });
    let mut fixture = CatalogRpcFixture::new_with_removal_git(true, removal_git).await;
    let first_thread = adopt_external_for_removal(&mut fixture, "reserve-adopt-first").await;

    let second_main = fixture.root.path().join("second-main");
    let second_external = fixture.root.path().join("second-external");
    fs::create_dir(&second_main).expect("second primary directory");
    git(&second_main, &["init", "--initial-branch", "main"], None);
    git(
        &second_main,
        &["config", "user.email", "rpc@example.invalid"],
        None,
    );
    git(&second_main, &["config", "user.name", "RPC Test"], None);
    fs::write(second_main.join("README.md"), "second fixture\n").expect("second fixture file");
    git(&second_main, &["add", "README.md"], None);
    git(&second_main, &["commit", "-m", "initial"], None);
    git(
        &second_main,
        &["worktree", "add", "-b", "feature/second"],
        Some(&second_external),
    );
    fixture
        .engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"project.create",
                "commandId":"reserve-project-second",
                "projectId":"project-2",
                "title":"Second Catalog RPC",
                "workspaceRoot":second_main,
                "defaultModelSelection":null,
                "createdAt":"2026-08-09T00:01:00Z"
            }))
            .expect("second project command"),
        )
        .await
        .expect("second project created");
    let second_thread = adopt_project_worktree_for_removal(
        &mut fixture,
        "project-2",
        "reserve-adopt-second",
        "1260",
    )
    .await;

    let first_plan = removal_plan(&mut fixture, "project-1", &first_thread, "1262").await;
    let second_plan = removal_plan(&mut fixture, "project-2", &second_thread, "1263").await;
    let address = fixture.handle.as_ref().expect("server handle").local_addr();
    let mut first_socket = connect_async(format!("ws://{address}/ws"))
        .await
        .expect("first removal socket")
        .0;
    let mut second_socket = connect_async(format!("ws://{address}/ws"))
        .await
        .expect("second removal socket")
        .0;
    request(
        &mut first_socket,
        "1264",
        "worktree.remove",
        removal_payload(
            "shared-removal-command",
            "project-1",
            &first_thread,
            &first_plan,
        ),
    )
    .await;
    request(
        &mut second_socket,
        "1265",
        "worktree.remove",
        removal_payload(
            "shared-removal-command",
            "project-2",
            &second_thread,
            &second_plan,
        ),
    )
    .await;

    let first_boundary = timeout(Duration::from_secs(5), entered_rx.recv())
        .await
        .expect("one request reaches Git")
        .expect("Git boundary channel");
    let second_boundary = timeout(Duration::from_millis(200), entered_rx.recv()).await;
    release.add_permits(2);
    assert!(
        second_boundary.is_err(),
        "only one command payload may cross Git; first={first_boundary:?}, second={second_boundary:?}"
    );

    let first_exit = next_server_message(&mut first_socket).await;
    let second_exit = next_server_message(&mut second_socket).await;
    let (winner_project, winner_thread, winner_path, loser_thread, loser_path) =
        match (&first_exit, &second_exit) {
            (
                ServerMessage::Exit {
                    exit: RpcExit::Success { .. },
                    ..
                },
                ServerMessage::Exit {
                    exit: RpcExit::Failure { cause },
                    ..
                },
            ) if removal_failure_has_reason(cause, "command-conflict") => (
                "project-1",
                first_thread.as_str(),
                fixture.external.as_path(),
                second_thread.as_str(),
                second_external.as_path(),
            ),
            (
                ServerMessage::Exit {
                    exit: RpcExit::Failure { cause },
                    ..
                },
                ServerMessage::Exit {
                    exit: RpcExit::Success { .. },
                    ..
                },
            ) if removal_failure_has_reason(cause, "command-conflict") => (
                "project-2",
                second_thread.as_str(),
                second_external.as_path(),
                first_thread.as_str(),
                fixture.external.as_path(),
            ),
            exits => panic!("expected one success and one command conflict: {exits:?}"),
        };
    assert!(
        !winner_path.exists(),
        "winner {winner_project} must mutate Git"
    );
    assert!(loser_path.exists(), "loser must not mutate Git");
    assert!(
        fixture
            .repositories
            .get_thread(winner_thread.to_owned())
            .await
            .expect("winner read")
            .expect("winner thread")
            .deleted_at
            .is_some()
    );
    assert!(
        fixture
            .repositories
            .get_thread(loser_thread.to_owned())
            .await
            .expect("loser read")
            .expect("loser thread")
            .deleted_at
            .is_none()
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn generic_command_cannot_overwrite_prepared_removal_receipt_after_git() {
    let hooks = TestHooks::default();
    let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let removal_git = Arc::new(BlockingRemovalGit {
        inner: GitRepository::default(),
        entered: entered_tx,
        release: release.clone(),
    });
    let mut fixture = CatalogRpcFixture::new_with_engine_options_and_removal_git(
        true,
        removal_git,
        EngineOptions {
            queue_capacity: 16,
            test_hooks: hooks.clone(),
        },
    )
    .await;
    let thread_id = adopt_external_for_removal(&mut fixture, "receipt-race-adopt").await;
    let plan = removal_plan(&mut fixture, "project-1", &thread_id, "1266").await;
    let removal = removal_payload(
        "shared-generic-removal-command",
        "project-1",
        &thread_id,
        &plan,
    );
    let generic: OrchestrationCommand = serde_json::from_value(json!({
        "type":"thread.meta.update",
        "commandId":"shared-generic-removal-command",
        "threadId":thread_id,
        "title":"must-roll-back"
    }))
    .expect("generic command");
    let pause = hooks.pause_before_next_command_persist();
    let engine = fixture.engine.clone();
    let generic_task = tokio::spawn(async move { engine.dispatch(generic).await });
    pause.wait_until_entered().await;

    request(fixture.socket(), "1267", "worktree.remove", removal.clone()).await;
    timeout(Duration::from_secs(5), entered_rx.recv())
        .await
        .expect("removal reaches Git")
        .expect("Git boundary");
    release.add_permits(1);
    pause.release();

    assert!(matches!(
        generic_task.await.expect("generic join"),
        Err(OrchestrationError::CommandConflict { .. })
    ));
    let result = success_value(fixture.socket(), "1267").await;
    assert_eq!(result["gitOutcome"], "removed");
    assert_eq!(result["threadRemoved"], true);
    assert!(!fixture.external.exists());
    let receipt = fixture
        .repositories
        .get_command_receipt("shared-generic-removal-command".to_owned())
        .await
        .expect("receipt read")
        .expect("accepted receipt");
    assert_eq!(receipt.status, "accepted");
    assert_eq!(
        receipt.payload_digest.as_deref(),
        Some(
            canonical_command_digest(&removal)
                .expect("removal digest")
                .as_str()
        )
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_fences_cross_project_owner_create_and_retarget_through_detach() {
    let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let removal_git = Arc::new(BlockingRemovalGit {
        inner: GitRepository::default(),
        entered: entered_tx,
        release: release.clone(),
    });
    let mut fixture = CatalogRpcFixture::new_with_removal_git(true, removal_git).await;
    let thread_id = adopt_external_for_removal(&mut fixture, "ownership-fence-adopt").await;
    let plan = removal_plan(&mut fixture, "project-1", &thread_id, "1268").await;
    let second_root = fixture.root.path().join("ownership-project-two");
    let previous_path = second_root.join("previous-worktree");
    fs::create_dir(&second_root).expect("second project root");
    fs::create_dir(&previous_path).expect("previous workspace path");
    fixture
        .engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"project.create",
                "commandId":"ownership-project-two-create",
                "projectId":"ownership-project-two",
                "title":"Ownership Project Two",
                "workspaceRoot":second_root,
                "defaultModelSelection":null,
                "createdAt":"2026-08-10T00:01:00Z"
            }))
            .expect("second project command"),
        )
        .await
        .expect("second project");
    fixture
        .engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create",
                "commandId":"retarget-owner-create",
                "threadId":"retarget-owner",
                "projectId":"ownership-project-two",
                "title":"Retarget Owner",
                "kind":"workspace",
                "modelSelection":{},
                "runtimeMode":"full-access",
                "interactionMode":"default",
                "branch":null,
                "worktreePath":previous_path,
                "createdAt":"2026-08-10T00:01:01Z"
            }))
            .expect("retarget owner command"),
        )
        .await
        .expect("retarget owner");

    request(
        fixture.socket(),
        "1269",
        "worktree.remove",
        removal_payload("ownership-fence-remove", "project-1", &thread_id, &plan),
    )
    .await;
    timeout(Duration::from_secs(5), entered_rx.recv())
        .await
        .expect("removal reaches Git")
        .expect("Git boundary");

    let cancelled_engine = fixture.engine.clone();
    let cancelled_target = fixture.external.clone();
    let mut cancelled = tokio::spawn(async move {
        cancelled_engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"thread.create",
                    "commandId":"cancelled-racing-owner-create-command",
                    "threadId":"cancelled-racing-owner-create",
                    "projectId":"ownership-project-two",
                    "title":"Cancelled Racing Owner",
                    "modelSelection":{},
                    "runtimeMode":"full-access",
                    "interactionMode":"default",
                    "branch":null,
                    "worktreePath":cancelled_target,
                    "createdAt":"2026-08-10T00:01:02Z"
                }))
                .expect("cancelled racing create command"),
            )
            .await
    });
    assert!(
        timeout(Duration::from_millis(100), &mut cancelled)
            .await
            .is_err(),
        "cancelled owner create must first wait behind removal"
    );
    cancelled.abort();
    assert!(
        cancelled
            .await
            .expect_err("cancelled owner waiter stops")
            .is_cancelled()
    );
    assert!(
        fixture
            .repositories
            .get_thread("cancelled-racing-owner-create".to_owned())
            .await
            .expect("cancelled owner read")
            .is_none()
    );

    let create_engine = fixture.engine.clone();
    let target = fixture.external.clone();
    let mut create = tokio::spawn(async move {
        create_engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"thread.create",
                    "commandId":"racing-owner-create-command",
                    "threadId":"racing-owner-create",
                    "projectId":"ownership-project-two",
                    "title":"Racing Owner",
                    "modelSelection":{},
                    "runtimeMode":"full-access",
                    "interactionMode":"default",
                    "branch":null,
                    "worktreePath":target,
                    "createdAt":"2026-08-10T00:01:02Z"
                }))
                .expect("racing create command"),
            )
            .await
    });
    let retarget_engine = fixture.engine.clone();
    let target = fixture.external.clone();
    let mut retarget = tokio::spawn(async move {
        retarget_engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"thread.meta.update",
                    "commandId":"racing-owner-retarget-command",
                    "threadId":"retarget-owner",
                    "worktreePath":target
                }))
                .expect("racing retarget command"),
            )
            .await
    });
    let bootstrap_engine = fixture.engine.clone();
    let alias_segment = fixture
        .external
        .parent()
        .expect("external parent")
        .join("canonical-alias-segment");
    fs::create_dir(&alias_segment).expect("canonical alias segment");
    let target_alias = alias_segment
        .join("..")
        .join(fixture.external.file_name().expect("external file name"));
    let mut bootstrap = tokio::spawn(async move {
        bootstrap_engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"thread.turn.start",
                    "commandId":"racing-bootstrap-owner-command",
                    "threadId":"racing-bootstrap-owner",
                    "message":{
                        "messageId":"racing-bootstrap-message",
                        "role":"user",
                        "text":"bootstrap",
                        "attachments":[]
                    },
                    "modelSelection":{},
                    "runtimeMode":"full-access",
                    "interactionMode":"default",
                    "bootstrap":{"createThread":{
                        "projectId":"ownership-project-two",
                        "title":"Racing Bootstrap Owner",
                        "modelSelection":{},
                        "runtimeMode":"full-access",
                        "interactionMode":"default",
                        "branch":null,
                        "worktreePath":target_alias,
                        "createdAt":"2026-08-10T00:01:03Z"
                    }},
                    "createdAt":"2026-08-10T00:01:03Z"
                }))
                .expect("racing bootstrap command"),
            )
            .await
    });
    let create_early = timeout(Duration::from_millis(100), &mut create).await;
    let retarget_early = timeout(Duration::from_millis(100), &mut retarget).await;
    let bootstrap_early = timeout(Duration::from_millis(100), &mut bootstrap).await;
    let create_early_debug = format!("{create_early:?}");
    let retarget_early_debug = format!("{retarget_early:?}");
    let bootstrap_early_debug = format!("{bootstrap_early:?}");
    let create_waited = create_early.is_err();
    let retarget_waited = retarget_early.is_err();
    let bootstrap_waited = bootstrap_early.is_err();
    release.add_permits(1);
    let removal_result = success_value(fixture.socket(), "1269").await;
    let create_result = match create_early {
        Ok(joined) => joined.expect("create joins"),
        Err(_) => create.await.expect("create joins after removal"),
    };
    let retarget_result = match retarget_early {
        Ok(joined) => joined.expect("retarget joins"),
        Err(_) => retarget.await.expect("retarget joins after removal"),
    };
    let bootstrap_result = match bootstrap_early {
        Ok(joined) => joined.expect("bootstrap joins"),
        Err(_) => bootstrap.await.expect("bootstrap joins after removal"),
    };

    assert!(
        create_waited,
        "owner create must wait behind removal: {create_early_debug}"
    );
    assert!(
        retarget_waited,
        "owner retarget must wait behind removal: {retarget_early_debug}"
    );
    assert!(
        bootstrap_waited,
        "bootstrap owner create through a canonical alias must wait behind removal: {bootstrap_early_debug}"
    );
    assert!(create_result.is_err(), "stale owner create must revalidate");
    assert!(
        retarget_result.is_err(),
        "stale owner retarget must revalidate"
    );
    assert!(
        bootstrap_result.is_err(),
        "stale bootstrap owner create must revalidate"
    );
    assert_eq!(removal_result["gitOutcome"], "removed");
    assert!(
        fixture
            .repositories
            .get_thread("racing-owner-create".to_owned())
            .await
            .expect("racing owner read")
            .is_none()
    );
    let retargeted = fixture
        .repositories
        .get_thread("retarget-owner".to_owned())
        .await
        .expect("retarget owner read")
        .expect("retarget owner remains");
    assert_ne!(
        retargeted.worktree_path.as_deref(),
        Some(fixture.external.to_string_lossy().as_ref())
    );
    assert!(
        fixture
            .repositories
            .get_thread("racing-bootstrap-owner".to_owned())
            .await
            .expect("bootstrap owner read")
            .is_none()
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn owner_mutation_that_wins_the_fence_invalidates_removal_before_git() {
    let hooks = TestHooks::default();
    let remove_calls = Arc::new(AtomicUsize::new(0));
    let mut fixture = CatalogRpcFixture::new_with_engine_options_and_removal_git(
        true,
        Arc::new(CountingRemovalGit {
            inner: GitRepository::default(),
            remove_calls: remove_calls.clone(),
        }),
        EngineOptions {
            queue_capacity: 16,
            test_hooks: hooks.clone(),
        },
    )
    .await;
    let thread_id = adopt_external_for_removal(&mut fixture, "ownership-winner-adopt").await;
    let plan = removal_plan(&mut fixture, "project-1", &thread_id, "1271").await;
    let second_root = fixture.root.path().join("ownership-winner-project");
    let previous_path = second_root.join("previous-worktree");
    fs::create_dir(&second_root).expect("second project root");
    fs::create_dir(&previous_path).expect("previous workspace path");
    fixture
        .engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"project.create",
                "commandId":"ownership-winner-project-create",
                "projectId":"ownership-winner-project",
                "title":"Ownership Winner",
                "workspaceRoot":second_root,
                "defaultModelSelection":null,
                "createdAt":"2026-08-10T00:02:00Z"
            }))
            .expect("second project command"),
        )
        .await
        .expect("second project");
    fixture
        .engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create",
                "commandId":"ownership-winner-thread-create",
                "threadId":"ownership-winner-thread",
                "projectId":"ownership-winner-project",
                "title":"Ownership Winner Thread",
                "kind":"workspace",
                "modelSelection":{},
                "runtimeMode":"full-access",
                "interactionMode":"default",
                "branch":null,
                "worktreePath":previous_path,
                "createdAt":"2026-08-10T00:02:01Z"
            }))
            .expect("owner thread command"),
        )
        .await
        .expect("owner thread");

    let pause = hooks.pause_before_next_command_persist();
    let engine = fixture.engine.clone();
    let target = fixture.external.clone();
    let mutation = tokio::spawn(async move {
        engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"thread.meta.update",
                    "commandId":"ownership-winner-retarget",
                    "threadId":"ownership-winner-thread",
                    "worktreePath":target
                }))
                .expect("retarget command"),
            )
            .await
    });
    pause.wait_until_entered().await;
    request(
        fixture.socket(),
        "1272",
        "worktree.remove",
        removal_payload("ownership-loser-remove", "project-1", &thread_id, &plan),
    )
    .await;
    assert!(
        timeout(Duration::from_millis(100), fixture.socket().next())
            .await
            .is_err(),
        "removal waits behind the owner mutation fence"
    );
    pause.release();
    mutation
        .await
        .expect("owner mutation joins")
        .expect("owner mutation wins");

    assert_typed_removal_failure(fixture.socket(), "1272", "ownership-conflict").await;
    assert_eq!(remove_calls.load(Ordering::SeqCst), 0);
    assert!(fixture.external.exists());
    assert!(
        fixture
            .repositories
            .get_thread(thread_id)
            .await
            .expect("thread read")
            .expect("thread")
            .deleted_at
            .is_none()
    );
    fixture.shutdown().await;
}

#[derive(Clone, Copy)]
enum RacingOwnerCreation {
    OmittedKind,
    TurnBootstrap,
}

async fn assert_owner_creation_that_wins_invalidates_removal(kind: RacingOwnerCreation) {
    let hooks = TestHooks::default();
    let remove_calls = Arc::new(AtomicUsize::new(0));
    let mut fixture = CatalogRpcFixture::new_with_engine_options_and_removal_git(
        true,
        Arc::new(CountingRemovalGit {
            inner: GitRepository::default(),
            remove_calls: remove_calls.clone(),
        }),
        EngineOptions {
            queue_capacity: 16,
            test_hooks: hooks.clone(),
        },
    )
    .await;
    let thread_id = adopt_external_for_removal(&mut fixture, "creation-winner-adopt").await;
    let plan = removal_plan(&mut fixture, "project-1", &thread_id, "1273").await;
    let second_root = fixture.root.path().join("creation-winner-project");
    fs::create_dir(&second_root).expect("second project root");
    fixture
        .engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"project.create",
                "commandId":"creation-winner-project-create",
                "projectId":"creation-winner-project",
                "title":"Creation Winner",
                "workspaceRoot":second_root,
                "defaultModelSelection":null,
                "createdAt":"2026-08-10T00:03:00Z"
            }))
            .expect("second project command"),
        )
        .await
        .expect("second project");
    let owner_id = match kind {
        RacingOwnerCreation::OmittedKind => "creation-winner-omitted",
        RacingOwnerCreation::TurnBootstrap => "creation-winner-bootstrap",
    };
    let target = match kind {
        RacingOwnerCreation::OmittedKind => fixture.external.clone(),
        RacingOwnerCreation::TurnBootstrap => {
            let alias_segment = fixture
                .external
                .parent()
                .expect("external parent")
                .join("winner-alias-segment");
            fs::create_dir(&alias_segment).expect("winner alias segment");
            alias_segment
                .join("..")
                .join(fixture.external.file_name().expect("external file name"))
        }
    };
    let command = match kind {
        RacingOwnerCreation::OmittedKind => serde_json::from_value(json!({
            "type":"thread.create",
            "commandId":"creation-winner-omitted-command",
            "threadId":owner_id,
            "projectId":"creation-winner-project",
            "title":"Omitted Kind Owner",
            "modelSelection":{},
            "runtimeMode":"full-access",
            "interactionMode":"default",
            "branch":null,
            "worktreePath":target,
            "createdAt":"2026-08-10T00:03:01Z"
        })),
        RacingOwnerCreation::TurnBootstrap => serde_json::from_value(json!({
            "type":"thread.turn.start",
            "commandId":"creation-winner-bootstrap-command",
            "threadId":owner_id,
            "message":{
                "messageId":"creation-winner-bootstrap-message",
                "role":"user",
                "text":"bootstrap",
                "attachments":[]
            },
            "modelSelection":{},
            "runtimeMode":"full-access",
            "interactionMode":"default",
            "bootstrap":{"createThread":{
                "projectId":"creation-winner-project",
                "title":"Bootstrap Owner",
                "modelSelection":{},
                "runtimeMode":"full-access",
                "interactionMode":"default",
                "branch":null,
                "worktreePath":target,
                "createdAt":"2026-08-10T00:03:01Z"
            }},
            "createdAt":"2026-08-10T00:03:01Z"
        })),
    }
    .expect("owner creation command");

    let pause = hooks.pause_before_next_command_persist();
    let engine = fixture.engine.clone();
    let owner = tokio::spawn(async move { engine.dispatch(command).await });
    pause.wait_until_entered().await;
    request(
        fixture.socket(),
        "1274",
        "worktree.remove",
        removal_payload("creation-winner-remove", "project-1", &thread_id, &plan),
    )
    .await;
    assert!(
        timeout(Duration::from_millis(100), fixture.socket().next())
            .await
            .is_err(),
        "removal must wait behind the owner creation fence"
    );
    assert_eq!(remove_calls.load(Ordering::SeqCst), 0);
    pause.release();
    owner
        .await
        .expect("owner creation joins")
        .expect("owner creation wins");

    assert_typed_removal_failure(fixture.socket(), "1274", "ownership-conflict").await;
    assert_eq!(remove_calls.load(Ordering::SeqCst), 0);
    assert!(fixture.external.exists());
    let owner = fixture
        .repositories
        .get_thread(owner_id.to_owned())
        .await
        .expect("owner read")
        .expect("owner persists after rejected removal");
    assert_eq!(owner.kind, "workspace");
    assert!(owner.deleted_at.is_none());
    fixture.shutdown().await;
}

#[tokio::test]
async fn omitted_kind_owner_creation_that_wins_invalidates_removal_before_git() {
    assert_owner_creation_that_wins_invalidates_removal(RacingOwnerCreation::OmittedKind).await;
}

#[tokio::test]
async fn turn_bootstrap_owner_creation_that_wins_invalidates_removal_before_git() {
    assert_owner_creation_that_wins_invalidates_removal(RacingOwnerCreation::TurnBootstrap).await;
}

#[tokio::test]
async fn removal_dirty_requires_confirmation_and_detach_only_ignores_quiesce_outcome() {
    let quiescer = Arc::new(RecordingPendingQuiescer::default());
    let mut fixture = CatalogRpcFixture::new_with_quiescer(true, quiescer.clone()).await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-dirty").await;
    fs::write(fixture.external.join("dirty.txt"), "dirty\n").expect("dirty file");
    request(
        fixture.socket(),
        "1202",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1202").await;
    assert_eq!(plan["untrackedFileCount"], 1);
    request(
        fixture.socket(),
        "1203",
        "worktree.remove",
        json!({
            "commandId":"remove-dirty",
            "projectId":"project-1",
            "threadId":thread_id,
            "mode":"delete-git-worktree",
            "expectedGeneration":plan["generation"],
            "planToken":plan["planToken"],
            "forceDirty":false,
            "confirmRepositoryWidePrune":false
        }),
    )
    .await;
    assert_typed_removal_failure(fixture.socket(), "1203", "dirty-confirmation-required").await;
    assert_eq!(quiescer.call_count(), 0);
    assert!(
        fixture
            .repositories
            .get_thread(thread_id.clone())
            .await
            .expect("thread read")
            .expect("thread")
            .deleted_at
            .is_none()
    );

    fs::write(fixture.external.join("drift.txt"), "drift\n").expect("plan drift file");
    request(
        fixture.socket(),
        "1204",
        "worktree.remove",
        json!({
            "commandId":"remove-dirty-drifted",
            "projectId":"project-1",
            "threadId":thread_id,
            "mode":"delete-git-worktree",
            "expectedGeneration":plan["generation"],
            "planToken":plan["planToken"],
            "forceDirty":true,
            "confirmRepositoryWidePrune":false
        }),
    )
    .await;
    assert_typed_removal_failure(fixture.socket(), "1204", "stale-plan").await;
    assert_eq!(quiescer.call_count(), 0);

    request(
        fixture.socket(),
        "1205",
        "worktree.removeFromBibCode",
        json!({
            "commandId":"remove-detach-only",
            "projectId":"project-1",
            "threadId":thread_id
        }),
    )
    .await;
    let result = success_value(fixture.socket(), "1205").await;
    assert_eq!(result["gitOutcome"], "not-requested");
    assert_eq!(result["orphanCleanupPending"], true);
    assert!(!quiescer.last_cancellation().is_cancelled());
    assert!(fixture.external.exists());
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_after_git_succeeded_before_detach_is_safe_missing_unregistered_cleanup() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-crash").await;
    git(
        &fixture.main,
        &["worktree", "remove", "--force", "--"],
        Some(&fixture.external),
    );
    request(
        fixture.socket(),
        "1202",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1202").await;
    assert_eq!(plan["availability"], "missing-unregistered");
    request(
        fixture.socket(),
        "1203",
        "worktree.remove",
        json!({
            "commandId":"remove-after-crash",
            "projectId":"project-1",
            "threadId":thread_id,
            "mode":"cleanup-stale-registration",
            "expectedGeneration":plan["generation"],
            "planToken":plan["planToken"],
            "forceDirty":false,
            "confirmRepositoryWidePrune":false
        }),
    )
    .await;
    assert_eq!(
        success_value(fixture.socket(), "1203").await["gitOutcome"],
        "cleaned"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn reserved_removal_resumes_after_git_succeeded_before_detach() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-reserved-crash").await;
    let plan = removal_plan(&mut fixture, "project-1", &thread_id, "1270").await;
    let payload = removal_payload("remove-reserved-crash", "project-1", &thread_id, &plan);
    fixture
        .repositories
        .reserve_command_receipt(CommandReceipt {
            command_id: "remove-reserved-crash".to_owned(),
            aggregate_kind: "project".to_owned(),
            aggregate_id: "project-1".to_owned(),
            accepted_at: "2026-08-09T00:02:00Z".to_owned(),
            result_sequence: 0,
            status: "prepared".to_owned(),
            error: None,
            payload_digest: Some(canonical_command_digest(&payload).expect("payload digest")),
        })
        .await
        .expect("durable removal reservation");
    git(
        &fixture.main,
        &["worktree", "remove"],
        Some(&fixture.external),
    );

    request(fixture.socket(), "1271", "worktree.remove", payload.clone()).await;
    let result = success_value(fixture.socket(), "1271").await;
    assert_eq!(result["gitOutcome"], "removed");
    assert_eq!(result["threadRemoved"], true);
    assert!(
        fixture
            .repositories
            .get_thread(thread_id)
            .await
            .expect("thread read")
            .expect("thread")
            .deleted_at
            .is_some()
    );

    request(fixture.socket(), "1272", "worktree.remove", payload).await;
    assert_eq!(success_value(fixture.socket(), "1272").await, result);
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_missing_registration_targeted_cleanup_succeeds_without_repository_prune() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-missing").await;
    fs::remove_dir_all(&fixture.external).expect("simulate missing worktree directory");
    request(
        fixture.socket(),
        "1202",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1202").await;
    assert_eq!(plan["availability"], "missing-registered");
    assert!(
        plan["pruneImpact"]
            .as_array()
            .is_some_and(|impact| !impact.is_empty())
    );
    let payload = json!({
        "commandId":"remove-missing-unconfirmed",
        "projectId":"project-1",
        "threadId":thread_id,
        "mode":"cleanup-stale-registration",
        "expectedGeneration":plan["generation"],
        "planToken":plan["planToken"],
        "forceDirty":false,
        "confirmRepositoryWidePrune":false
    });
    request(fixture.socket(), "1203", "worktree.remove", payload).await;
    let result = success_value(fixture.socket(), "1203").await;
    assert_eq!(result["gitOutcome"], "cleaned");
    assert!(
        fixture
            .repositories
            .get_thread(thread_id)
            .await
            .expect("thread read")
            .expect("thread")
            .deleted_at
            .is_some()
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_missing_fallback_prune_requires_confirmation_then_cleans() {
    let mut fixture = CatalogRpcFixture::new_with_removal_git(
        true,
        Arc::new(TargetedFailingGit {
            inner: GitRepository::default(),
        }),
    )
    .await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-prune").await;
    fs::remove_dir_all(&fixture.external).expect("simulate missing worktree directory");
    request(
        fixture.socket(),
        "1202",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1202").await;
    let mut payload = json!({
        "commandId":"remove-prune-unconfirmed",
        "projectId":"project-1",
        "threadId":thread_id,
        "mode":"cleanup-stale-registration",
        "expectedGeneration":plan["generation"],
        "planToken":plan["planToken"],
        "forceDirty":false,
        "confirmRepositoryWidePrune":false
    });
    request(fixture.socket(), "1203", "worktree.remove", payload.clone()).await;
    assert_typed_removal_failure(fixture.socket(), "1203", "prune-confirmation-required").await;
    payload["commandId"] = json!("remove-prune-confirmed");
    payload["confirmRepositoryWidePrune"] = json!(true);
    request(fixture.socket(), "1204", "worktree.remove", payload).await;
    assert_eq!(
        success_value(fixture.socket(), "1204").await["gitOutcome"],
        "cleaned"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_locked_missing_registration_is_protected_but_detach_only_remains_available() {
    let mut fixture = CatalogRpcFixture::new(true).await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-locked").await;
    git(
        &fixture.main,
        &["worktree", "lock", "--reason", "keep", "--"],
        Some(&fixture.external),
    );
    fs::remove_dir_all(&fixture.external).expect("simulate missing locked worktree directory");
    request(
        fixture.socket(),
        "1202",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1202").await;
    assert_eq!(plan["locked"], true);
    request(
        fixture.socket(),
        "1203",
        "worktree.remove",
        json!({
            "commandId":"remove-locked",
            "projectId":"project-1",
            "threadId":thread_id,
            "mode":"cleanup-stale-registration",
            "expectedGeneration":plan["generation"],
            "planToken":plan["planToken"],
            "forceDirty":false,
            "confirmRepositoryWidePrune":true
        }),
    )
    .await;
    assert_typed_removal_failure(fixture.socket(), "1203", "locked").await;
    request(
        fixture.socket(),
        "1204",
        "worktree.removeFromBibCode",
        json!({"commandId":"detach-locked","projectId":"project-1","threadId":thread_id}),
    )
    .await;
    assert_eq!(
        success_value(fixture.socket(), "1204").await["gitOutcome"],
        "not-requested"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_present_verified_mutation_failure_keeps_thread_and_worktree() {
    let mut fixture = CatalogRpcFixture::new_with_removal_git(
        true,
        Arc::new(FailingMutationGit {
            inner: GitRepository::default(),
        }),
    )
    .await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-fail-present").await;
    request(
        fixture.socket(),
        "1202",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1202").await;
    request(
        fixture.socket(),
        "1203",
        "worktree.remove",
        json!({
            "commandId":"remove-fail-present",
            "projectId":"project-1",
            "threadId":thread_id,
            "mode":"delete-git-worktree",
            "expectedGeneration":plan["generation"],
            "planToken":plan["planToken"],
            "forceDirty":false,
            "confirmRepositoryWidePrune":false
        }),
    )
    .await;
    assert_typed_removal_failure(fixture.socket(), "1203", "git-failed").await;
    assert!(fixture.external.exists());
    assert!(
        fixture
            .repositories
            .get_thread(thread_id)
            .await
            .expect("thread read")
            .expect("thread")
            .deleted_at
            .is_none()
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_duplicate_canonical_owner_conflicts_before_git_mutation() {
    let remove_calls = Arc::new(AtomicUsize::new(0));
    let git = Arc::new(CountingRemovalGit {
        inner: GitRepository::default(),
        remove_calls: remove_calls.clone(),
    });
    let mut fixture = CatalogRpcFixture::new_with_removal_git(true, git).await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-owner-conflict").await;
    request(
        fixture.socket(),
        "1250",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1250").await;
    let mut duplicate = fixture
        .repositories
        .get_thread(thread_id.clone())
        .await
        .expect("owner read")
        .expect("canonical owner");
    duplicate.thread_id = "duplicate-workspace-owner".to_owned();
    duplicate.created_at = "2026-08-09T00:00:03Z".to_owned();
    fixture
        .repositories
        .upsert_thread(duplicate)
        .await
        .expect("duplicate owner projection");

    request(
        fixture.socket(),
        "1251",
        "worktree.remove",
        json!({
            "commandId":"remove-owner-conflict",
            "projectId":"project-1",
            "threadId":thread_id,
            "mode":"delete-git-worktree",
            "expectedGeneration":plan["generation"],
            "planToken":plan["planToken"],
            "forceDirty":false,
            "confirmRepositoryWidePrune":false
        }),
    )
    .await;

    assert_typed_removal_failure(fixture.socket(), "1251", "ownership-conflict").await;
    assert_eq!(remove_calls.load(Ordering::SeqCst), 0);
    assert!(fixture.external.exists());
    for owner in [&thread_id, "duplicate-workspace-owner"] {
        assert!(
            fixture
                .repositories
                .get_thread(owner.to_owned())
                .await
                .expect("owner read")
                .expect("owner projection")
                .deleted_at
                .is_none()
        );
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn removal_missing_targeted_and_prune_failure_detaches_with_bounded_failed_outcome() {
    let mut fixture = CatalogRpcFixture::new_with_removal_git(
        true,
        Arc::new(FailingMutationGit {
            inner: GitRepository::default(),
        }),
    )
    .await;
    let thread_id = adopt_external_for_removal(&mut fixture, "remove-adopt-fail-missing").await;
    fs::remove_dir_all(&fixture.external).expect("simulate missing worktree");
    request(
        fixture.socket(),
        "1202",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1202").await;
    request(
        fixture.socket(),
        "1203",
        "worktree.remove",
        json!({
            "commandId":"remove-fail-missing",
            "projectId":"project-1",
            "threadId":thread_id,
            "mode":"cleanup-stale-registration",
            "expectedGeneration":plan["generation"],
            "planToken":plan["planToken"],
            "forceDirty":false,
            "confirmRepositoryWidePrune":true
        }),
    )
    .await;
    let result = success_value(fixture.socket(), "1203").await;
    assert_eq!(result["gitOutcome"], "failed");
    assert!(
        result["detail"]
            .as_str()
            .is_some_and(|detail| detail.len() <= 2_048)
    );
    assert!(
        fixture
            .repositories
            .get_thread(thread_id)
            .await
            .expect("thread read")
            .expect("thread")
            .deleted_at
            .is_some()
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn cleanup_capacity_rejection_has_no_removal_side_effects() {
    let remove_calls = Arc::new(AtomicUsize::new(0));
    let quiesce_calls = Arc::new(AtomicUsize::new(0));
    let mut fixture = CatalogRpcFixture::new_with_removal_services(
        true,
        Arc::new(CapacityRejectingQuiescer {
            quiesce_calls: quiesce_calls.clone(),
        }),
        Some(Arc::new(CountingRemovalGit {
            inner: GitRepository::default(),
            remove_calls: remove_calls.clone(),
        })),
    )
    .await;
    let thread_id = adopt_external_for_removal(&mut fixture, "capacity-adopt").await;
    request(
        fixture.socket(),
        "1204",
        "worktree.getRemovalPlan",
        json!({"projectId":"project-1","threadId":thread_id}),
    )
    .await;
    let plan = success_value(fixture.socket(), "1204").await;
    request(
        fixture.socket(),
        "1205",
        "worktree.remove",
        removal_payload("capacity-remove", "project-1", &thread_id, &plan),
    )
    .await;
    assert_typed_removal_failure(fixture.socket(), "1205", "cleanup-capacity").await;

    assert_eq!(remove_calls.load(Ordering::SeqCst), 0);
    assert_eq!(quiesce_calls.load(Ordering::SeqCst), 0);
    assert!(fixture.external.exists());
    assert!(
        fixture
            .repositories
            .get_command_receipt("capacity-remove".to_owned())
            .await
            .expect("receipt read")
            .is_none(),
        "capacity rejection must happen before durable reservation"
    );
    assert!(
        fixture
            .repositories
            .get_thread(thread_id)
            .await
            .expect("thread read")
            .expect("thread")
            .deleted_at
            .is_none()
    );
    fixture.shutdown().await;
}

struct CapacityRejectingQuiescer {
    quiesce_calls: Arc<AtomicUsize>,
}

impl WorktreeRemovalQuiescer for CapacityRejectingQuiescer {
    fn admit_cleanup(&self) -> WorktreeRemovalCleanupAdmissionFuture {
        Box::pin(async { Err(WorktreeRemovalCleanupAdmissionError::Capacity) })
    }

    fn quiesce(
        &self,
        _admission: WorktreeRemovalCleanupAdmission,
        _request: WorktreeRemovalQuiesceRequest,
    ) -> WorktreeRemovalQuiesceFuture {
        self.quiesce_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { WorktreeRemovalQuiesceLease::complete() })
    }
}

#[derive(Default)]
struct RecordingPendingQuiescer {
    cancellations: std::sync::Mutex<Vec<CancellationToken>>,
}

impl RecordingPendingQuiescer {
    fn call_count(&self) -> usize {
        self.cancellations.lock().expect("cancellation lock").len()
    }

    fn last_cancellation(&self) -> CancellationToken {
        self.cancellations
            .lock()
            .expect("cancellation lock")
            .last()
            .expect("quiesce cancellation")
            .clone()
    }
}

impl WorktreeRemovalQuiescer for RecordingPendingQuiescer {
    fn quiesce(
        &self,
        _admission: WorktreeRemovalCleanupAdmission,
        _request: WorktreeRemovalQuiesceRequest,
    ) -> WorktreeRemovalQuiesceFuture {
        let cancellation = CancellationToken::new();
        self.cancellations
            .lock()
            .expect("cancellation lock")
            .push(cancellation.clone());
        Box::pin(async { WorktreeRemovalQuiesceLease::pending(cancellation) })
    }
}

struct CatalogRpcFixture {
    root: TempDir,
    main: PathBuf,
    external: PathBuf,
    repositories: Repositories,
    catalog: WorktreeCatalogService,
    engine: OrchestrationEngine,
    handle: Option<bibcode_server::ServerHandle>,
    socket: Option<TestSocket>,
}

impl CatalogRpcFixture {
    async fn new(with_external: bool) -> Self {
        Self::new_with_removal_services(with_external, Arc::new(TestNoopQuiescer), None).await
    }

    async fn new_with_quiescer(
        with_external: bool,
        quiescer: Arc<dyn WorktreeRemovalQuiescer>,
    ) -> Self {
        Self::new_with_removal_services(with_external, quiescer, None).await
    }

    async fn new_with_removal_git(with_external: bool, git: Arc<dyn WorktreeRemovalGit>) -> Self {
        Self::new_with_removal_services(with_external, Arc::new(TestNoopQuiescer), Some(git)).await
    }

    async fn new_with_engine_options_and_removal_git(
        with_external: bool,
        git: Arc<dyn WorktreeRemovalGit>,
        options: EngineOptions,
    ) -> Self {
        Self::new_with_removal_services_and_options(
            with_external,
            Arc::new(TestNoopQuiescer),
            Some(git),
            options,
        )
        .await
    }

    async fn new_with_removal_services(
        with_external: bool,
        quiescer: Arc<dyn WorktreeRemovalQuiescer>,
        removal_git: Option<Arc<dyn WorktreeRemovalGit>>,
    ) -> Self {
        Self::new_with_removal_services_and_options(
            with_external,
            quiescer,
            removal_git,
            EngineOptions::default(),
        )
        .await
    }

    async fn new_with_removal_services_and_options(
        with_external: bool,
        quiescer: Arc<dyn WorktreeRemovalQuiescer>,
        removal_git: Option<Arc<dyn WorktreeRemovalGit>>,
        engine_options: EngineOptions,
    ) -> Self {
        let root = tempfile::tempdir().expect("fixture root");
        let main = root.path().join("main");
        let external = root.path().join("external");
        fs::create_dir(&main).expect("primary directory");
        git(&main, &["init", "--initial-branch", "main"], None);
        git(
            &main,
            &["config", "user.email", "rpc@example.invalid"],
            None,
        );
        git(&main, &["config", "user.name", "RPC Test"], None);
        fs::write(main.join("README.md"), "rpc fixture\n").expect("fixture file");
        git(&main, &["add", "README.md"], None);
        git(&main, &["commit", "-m", "initial"], None);
        if with_external {
            git(
                &main,
                &["worktree", "add", "-b", "feature/external"],
                Some(&external),
            );
        }

        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let engine = OrchestrationEngine::start(database, engine_options)
            .await
            .expect("orchestration");
        engine
            .dispatch(
                serde_json::from_value(json!({
                    "type": "project.create",
                    "commandId": "project-create",
                    "projectId": "project-1",
                    "title": "Catalog RPC",
                    "workspaceRoot": main,
                    "defaultModelSelection": null,
                    "createdAt": "2026-08-09T00:00:00Z"
                }))
                .expect("project command"),
            )
            .await
            .expect("project created");
        let repositories = engine.repositories();
        let git_repository = Arc::new(GitRepository::default());
        let catalog =
            WorktreeCatalogService::new(Arc::new(repositories.clone()), git_repository.clone());
        let mut registry = RpcRegistry::empty();
        let removal_services = WorktreeCatalogRpcServices::new(catalog.clone(), engine.clone())
            .with_removal_quiescer(quiescer);
        let removal_services = removal_git.map_or(removal_services.clone(), |git| {
            removal_services.with_removal_git(git)
        });
        register_worktree_catalog_rpc(&mut registry, removal_services);
        register_git_vcs_rpc(
            &mut registry,
            GitVcsRpcServices::with_repository(git_repository.clone())
                .with_catalog_mutation_observer(Arc::new(WorktreeCatalogMutationObserver::new(
                    catalog.clone(),
                    repositories.clone(),
                    git_repository.clone(),
                ))),
        );
        let server_state = root.path().join("server");
        let config = ServerConfig::new(server_state)
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth();
        let handle = ServerRuntime::start_with_registry(config, registry)
            .await
            .expect("server");
        let socket = connect_async(format!("ws://{}/ws", handle.local_addr()))
            .await
            .expect("WebSocket")
            .0;
        Self {
            root,
            main,
            external,
            repositories,
            catalog,
            engine,
            handle: Some(handle),
            socket: Some(socket),
        }
    }

    fn socket(&mut self) -> &mut TestSocket {
        self.socket.as_mut().expect("active socket")
    }

    fn create_external_worktree(&self) {
        git(
            &self.main,
            &["worktree", "add", "-b", "feature/external"],
            Some(&self.external),
        );
    }

    async fn create_project(&self, project_id: &str, workspace_root: PathBuf) {
        self.repositories
            .upsert_project(ProjectionProject {
                project_id: project_id.to_owned(),
                title: project_id.to_owned(),
                workspace_root: workspace_root.to_string_lossy().into_owned(),
                default_model_selection: None,
                scripts: json!([]),
                worktree_discovery: json!({}),
                worktree_repository_key: None,
                created_at: "2026-08-09T00:00:01Z".to_owned(),
                updated_at: "2026-08-09T00:00:01Z".to_owned(),
                deleted_at: None,
            })
            .await
            .expect("project projection created");
    }

    async fn create_project_with_thread(
        &self,
        project_id: &str,
        workspace_root: PathBuf,
        worktree_path: PathBuf,
    ) {
        self.create_project(project_id, workspace_root).await;
        self.repositories
            .upsert_thread(ProjectionThread {
                thread_id: format!("thread-{project_id}"),
                project_id: project_id.to_owned(),
                title: project_id.to_owned(),
                kind: "default".to_owned(),
                model_selection: json!({"instanceId":"codex","model":"gpt-5.4"}),
                runtime_mode: "full-access".to_owned(),
                interaction_mode: "default".to_owned(),
                branch: Some("feature/removed-target".to_owned()),
                worktree_path: Some(worktree_path.to_string_lossy().into_owned()),
                latest_turn_id: None,
                created_at: "2026-08-09T00:00:02Z".to_owned(),
                updated_at: "2026-08-09T00:00:02Z".to_owned(),
                archived_at: None,
                latest_user_message_at: None,
                pending_approval_count: 0,
                pending_user_input_count: 0,
                has_actionable_proposed_plan: 0,
                deleted_at: None,
            })
            .await
            .expect("project thread projection created");
    }

    fn create_named_external_worktree(&self, directory: &str, branch: &str) -> PathBuf {
        let path = self.root.path().join(directory);
        git(&self.main, &["worktree", "add", "-b", branch], Some(&path));
        path
    }

    async fn shutdown(mut self) {
        if let Some(mut socket) = self.socket.take() {
            let _ = socket.close(None).await;
        }
        if let Some(handle) = self.handle.take() {
            handle.shutdown();
            handle.join().await.expect("server shutdown");
        }
        self.engine.shutdown().await;
    }
}

struct TestNoopQuiescer;

impl WorktreeRemovalQuiescer for TestNoopQuiescer {
    fn quiesce(
        &self,
        _admission: WorktreeRemovalCleanupAdmission,
        _request: WorktreeRemovalQuiesceRequest,
    ) -> WorktreeRemovalQuiesceFuture {
        Box::pin(async { WorktreeRemovalQuiesceLease::complete() })
    }
}

#[derive(Clone)]
struct BlockingRemovalGit {
    inner: GitRepository,
    entered: mpsc::UnboundedSender<PathBuf>,
    release: Arc<Semaphore>,
}

impl WorktreeRemovalGit for BlockingRemovalGit {
    fn inventory(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeInventory> {
        WorktreeRemovalGit::inventory(&self.inner, anchor, cancellation)
    }

    fn inspect(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeRemovalInspection> {
        WorktreeRemovalGit::inspect(&self.inner, anchor, record, cancellation)
    }

    fn preview_prune(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<Vec<GitPrunableWorktree>> {
        WorktreeRemovalGit::preview_prune(&self.inner, anchor, cancellation)
    }

    fn remove(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        force_dirty: bool,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        let inner = self.inner.clone();
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.send(anchor.clone()).expect("Git boundary receiver");
            let permit = release.acquire().await.expect("Git boundary release");
            permit.forget();
            WorktreeRemovalGit::remove(&inner, anchor, record, force_dirty, cancellation).await
        })
    }

    fn prune(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        expected_impact_digest: String,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        WorktreeRemovalGit::prune(
            &self.inner,
            anchor,
            record,
            expected_impact_digest,
            cancellation,
        )
    }
}

#[derive(Clone)]
struct CountingRemovalGit {
    inner: GitRepository,
    remove_calls: Arc<AtomicUsize>,
}

impl WorktreeRemovalGit for CountingRemovalGit {
    fn inventory(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeInventory> {
        WorktreeRemovalGit::inventory(&self.inner, anchor, cancellation)
    }

    fn inspect(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeRemovalInspection> {
        WorktreeRemovalGit::inspect(&self.inner, anchor, record, cancellation)
    }

    fn preview_prune(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<Vec<GitPrunableWorktree>> {
        WorktreeRemovalGit::preview_prune(&self.inner, anchor, cancellation)
    }

    fn remove(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        force_dirty: bool,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        self.remove_calls.fetch_add(1, Ordering::SeqCst);
        WorktreeRemovalGit::remove(&self.inner, anchor, record, force_dirty, cancellation)
    }

    fn prune(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        expected_impact_digest: String,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        WorktreeRemovalGit::prune(
            &self.inner,
            anchor,
            record,
            expected_impact_digest,
            cancellation,
        )
    }
}

#[derive(Clone)]
struct FailingMutationGit {
    inner: GitRepository,
}

impl FailingMutationGit {
    fn error(operation: &str) -> GitCommandError {
        GitCommandError {
            tag: "GitCommandError",
            operation: operation.into(),
            command: "git worktree mutation".into(),
            cwd: "<server-resolved>".into(),
            diagnostics: None,
            detail: "Git reported success but the exact registration survived verification.".into(),
        }
    }
}

impl WorktreeRemovalGit for FailingMutationGit {
    fn inventory(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeInventory> {
        WorktreeRemovalGit::inventory(&self.inner, anchor, cancellation)
    }

    fn inspect(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeRemovalInspection> {
        WorktreeRemovalGit::inspect(&self.inner, anchor, record, cancellation)
    }

    fn preview_prune(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<Vec<GitPrunableWorktree>> {
        WorktreeRemovalGit::preview_prune(&self.inner, anchor, cancellation)
    }

    fn remove(
        &self,
        _anchor: PathBuf,
        _record: GitWorktreeRecord,
        _force_dirty: bool,
        _cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        Box::pin(async { Err(Self::error("GitVcsDriver.removeWorktreeVerified.verify")) })
    }

    fn prune(
        &self,
        _anchor: PathBuf,
        _record: GitWorktreeRecord,
        _expected_impact_digest: String,
        _cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        Box::pin(async { Err(Self::error("GitVcsDriver.pruneWorktreesVerified.verify")) })
    }
}

#[derive(Clone)]
struct TargetedFailingGit {
    inner: GitRepository,
}

impl WorktreeRemovalGit for TargetedFailingGit {
    fn inventory(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeInventory> {
        WorktreeRemovalGit::inventory(&self.inner, anchor, cancellation)
    }

    fn inspect(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<GitWorktreeRemovalInspection> {
        WorktreeRemovalGit::inspect(&self.inner, anchor, record, cancellation)
    }

    fn preview_prune(
        &self,
        anchor: PathBuf,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<Vec<GitPrunableWorktree>> {
        WorktreeRemovalGit::preview_prune(&self.inner, anchor, cancellation)
    }

    fn remove(
        &self,
        _anchor: PathBuf,
        _record: GitWorktreeRecord,
        _force_dirty: bool,
        _cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        Box::pin(async { Err(FailingMutationGit::error("targeted-cleanup")) })
    }

    fn prune(
        &self,
        anchor: PathBuf,
        record: GitWorktreeRecord,
        expected_impact_digest: String,
        cancellation: CancellationToken,
    ) -> WorktreeRemovalGitFuture<()> {
        WorktreeRemovalGit::prune(
            &self.inner,
            anchor,
            record,
            expected_impact_digest,
            cancellation,
        )
    }
}

impl Drop for CatalogRpcFixture {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.as_ref() {
            handle.shutdown();
        }
        let _ = &self.root;
    }
}

async fn request(socket: &mut TestSocket, id: &str, tag: &str, payload: Value) {
    send_json(
        socket,
        json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] }),
    )
    .await;
}

async fn ack(socket: &mut TestSocket, request_id: &str) {
    send_json(socket, json!({ "_tag": "Ack", "requestId": request_id })).await;
}

async fn send_json(socket: &mut TestSocket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("send message");
}

async fn next_server_message(socket: &mut TestSocket) -> ServerMessage {
    let message = timeout(Duration::from_secs(10), socket.next())
        .await
        .expect("server response timeout")
        .expect("WebSocket open")
        .expect("WebSocket frame");
    let Message::Text(text) = message else {
        panic!("expected text frame: {message:?}");
    };
    serde_json::from_str(&text).expect("server message")
}

async fn next_chunk(socket: &mut TestSocket, request_id: &str) -> Value {
    let message = next_server_message(socket).await;
    let ServerMessage::Chunk {
        request_id: actual,
        values,
    } = message
    else {
        panic!("expected chunk: {message:?}");
    };
    assert_eq!(actual.as_str(), request_id);
    values.into_iter().next().expect("chunk value")
}

async fn success_value(socket: &mut TestSocket, request_id: &str) -> Value {
    let message = next_server_message(socket).await;
    let ServerMessage::Exit {
        request_id: actual,
        exit: RpcExit::Success { value: Some(value) },
    } = message
    else {
        panic!("expected unary success: {message:?}");
    };
    assert_eq!(actual.as_str(), request_id);
    value
}

async fn assert_typed_removal_failure(
    socket: &mut TestSocket,
    request_id: &str,
    expected_reason: &str,
) {
    let message = next_server_message(socket).await;
    let ServerMessage::Exit {
        request_id: actual,
        exit: RpcExit::Failure { cause },
    } = message
    else {
        panic!("expected typed removal failure: {message:?}");
    };
    assert_eq!(actual.as_str(), request_id);
    assert!(cause.iter().any(|item| matches!(
        item,
        CauseItem::Fail { error }
            if error["_tag"] == "WorktreeRemovalError" && error["reason"] == expected_reason
    )));
}

async fn adopt_external_for_removal(fixture: &mut CatalogRpcFixture, command_id: &str) -> String {
    request(
        fixture.socket(),
        "1200",
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":"project-1"}),
    )
    .await;
    let snapshot = success_value(fixture.socket(), "1200").await;
    let candidate = eligible_candidate(&snapshot).clone();
    request(
        fixture.socket(),
        "1201",
        "worktree.adopt",
        adoption_payload(command_id, &candidate, &snapshot),
    )
    .await;
    success_value(fixture.socket(), "1201").await["threadId"]
        .as_str()
        .expect("adopted thread ID")
        .to_owned()
}

async fn adopt_project_worktree_for_removal(
    fixture: &mut CatalogRpcFixture,
    project_id: &str,
    command_id: &str,
    request_id: &str,
) -> String {
    let adopt_request_id = (request_id.parse::<u64>().expect("numeric request ID") + 1).to_string();
    request(
        fixture.socket(),
        request_id,
        "vcs.refreshWorktreeCatalog",
        json!({"projectId":project_id}),
    )
    .await;
    let snapshot = success_value(fixture.socket(), request_id).await;
    let candidate = eligible_candidate(&snapshot).clone();
    let mut payload = adoption_payload(command_id, &candidate, &snapshot);
    payload["projectId"] = json!(project_id);
    request(
        fixture.socket(),
        &adopt_request_id,
        "worktree.adopt",
        payload,
    )
    .await;
    success_value(fixture.socket(), &adopt_request_id).await["threadId"]
        .as_str()
        .expect("adopted thread ID")
        .to_owned()
}

async fn removal_plan(
    fixture: &mut CatalogRpcFixture,
    project_id: &str,
    thread_id: &str,
    request_id: &str,
) -> Value {
    request(
        fixture.socket(),
        request_id,
        "worktree.getRemovalPlan",
        json!({"projectId":project_id,"threadId":thread_id}),
    )
    .await;
    success_value(fixture.socket(), request_id).await
}

fn removal_payload(command_id: &str, project_id: &str, thread_id: &str, plan: &Value) -> Value {
    json!({
        "commandId":command_id,
        "projectId":project_id,
        "threadId":thread_id,
        "mode":"delete-git-worktree",
        "expectedGeneration":plan["generation"],
        "planToken":plan["planToken"],
        "forceDirty":false,
        "confirmRepositoryWidePrune":false
    })
}

fn removal_failure_has_reason(cause: &[CauseItem], expected_reason: &str) -> bool {
    cause.iter().any(|item| {
        matches!(
            item,
            CauseItem::Fail { error }
                if error["_tag"] == "WorktreeRemovalError" && error["reason"] == expected_reason
        )
    })
}

async fn assert_typed_catalog_failure(
    socket: &mut TestSocket,
    request_id: &str,
    expected_reason: &str,
) {
    let message = next_server_message(socket).await;
    let ServerMessage::Exit {
        request_id: actual,
        exit: RpcExit::Failure { cause },
    } = message
    else {
        panic!("expected typed failure: {message:?}");
    };
    assert_eq!(actual.as_str(), request_id);
    assert!(cause.iter().any(|item| matches!(
        item,
        CauseItem::Fail { error }
            if error["_tag"] == "WorktreeCatalogError"
                && error["reason"] == expected_reason
    )));
}

async fn assert_typed_adoption_failure(
    socket: &mut TestSocket,
    request_id: &str,
    expected_reason: &str,
) {
    let message = next_server_message(socket).await;
    let ServerMessage::Exit {
        request_id: actual,
        exit: RpcExit::Failure { cause },
    } = message
    else {
        panic!("expected typed adoption failure: {message:?}");
    };
    assert_eq!(actual.as_str(), request_id);
    assert!(cause.iter().any(|item| matches!(
        item,
        CauseItem::Fail { error }
            if error["_tag"] == "WorktreeAdoptionError"
                && error["reason"] == expected_reason
                && error["currentGeneration"].as_u64().is_some()
    )));
}

async fn adoption_outcome(socket: &mut TestSocket, request_id: &str) -> (String, Value) {
    let message = next_server_message(socket).await;
    let value = serde_json::to_value(&message).expect("server message value");
    match message {
        ServerMessage::Exit {
            request_id: actual,
            exit: RpcExit::Success { .. },
        } => {
            assert_eq!(actual.as_str(), request_id);
            ("success".to_owned(), value)
        }
        ServerMessage::Exit {
            request_id: actual,
            exit: RpcExit::Failure { cause },
        } => {
            assert_eq!(actual.as_str(), request_id);
            let reason = cause
                .iter()
                .find_map(|item| match item {
                    CauseItem::Fail { error } if error["_tag"] == "WorktreeAdoptionError" => {
                        error["reason"].as_str().map(str::to_owned)
                    }
                    _ => None,
                })
                .unwrap_or_else(|| "untyped-failure".to_owned());
            (reason, value)
        }
        other => panic!("expected adoption exit: {other:?}"),
    }
}

fn eligible_candidate(snapshot: &Value) -> &Value {
    snapshot["worktrees"]
        .as_array()
        .expect("worktrees")
        .iter()
        .find(|worktree| worktree["eligibleForAdoption"] == true)
        .expect("eligible candidate")
}

fn descriptor_for_key<'a>(snapshot: &'a Value, key: &Value) -> &'a Value {
    snapshot["worktrees"]
        .as_array()
        .expect("worktrees")
        .iter()
        .find(|worktree| worktree["worktreeKey"] == *key)
        .expect("worktree descriptor")
}

fn adoption_payload(command_id: &str, descriptor: &Value, snapshot: &Value) -> Value {
    json!({
        "commandId":command_id,
        "projectId":"project-1",
        "worktreeKey":descriptor["worktreeKey"],
        "expectedGeneration":snapshot["generation"],
        "threadDefaults":{
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"full-access",
            "interactionMode":"default"
        }
    })
}

async fn branch_reconciliation_events(repositories: &Repositories) -> Vec<OrchestrationEvent> {
    repositories
        .read_events_from_sequence(0, 512)
        .await
        .expect("event read")
        .into_iter()
        .filter(|event| {
            event.event.event_type == "thread.meta-updated"
                && event
                    .event
                    .command_id
                    .as_deref()
                    .is_some_and(|command_id| command_id.starts_with("worktree-branch-reconcile:"))
        })
        .collect()
}

fn branch_reconciliation_command_id(
    thread_id: &str,
    branch: Option<&str>,
    head: Option<&str>,
) -> String {
    let mut identity = b"bibcode.worktree.branch-reconcile.v1\0".to_vec();
    identity.extend_from_slice(branch.unwrap_or("<detached>").as_bytes());
    identity.push(0);
    identity.extend_from_slice(head.unwrap_or("<unknown>").as_bytes());
    let hash = Sha256::digest(identity);
    let hash = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("worktree-branch-reconcile:{thread_id}:{hash}")
}

async fn wait_for_mutation_and_catalog_count(
    socket: &mut TestSocket,
    mutation_request_id: &str,
    stream_request_id: &str,
    expected_count: usize,
) -> Value {
    let mut mutation_succeeded = false;
    let mut catalog = None;
    while !mutation_succeeded || catalog.is_none() {
        match next_server_message(socket).await {
            ServerMessage::Exit {
                request_id,
                exit: RpcExit::Success { .. },
            } if request_id.as_str() == mutation_request_id => mutation_succeeded = true,
            ServerMessage::Chunk { request_id, values }
                if request_id.as_str() == stream_request_id =>
            {
                let value = values.into_iter().next().expect("catalog value");
                ack(socket, stream_request_id).await;
                if value["authoritative"] == true
                    && value["worktrees"]
                        .as_array()
                        .is_some_and(|worktrees| worktrees.len() == expected_count)
                {
                    catalog = Some(value);
                }
            }
            other => panic!("unexpected mutation/catalog message: {other:?}"),
        }
    }
    catalog.expect("catalog mutation result")
}

fn canonical_string(path: &Path) -> String {
    fs::canonicalize(path)
        .expect("canonical path")
        .to_string_lossy()
        .into_owned()
}

fn git(cwd: &Path, args: &[&str], final_path: Option<&Path>) {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    if let Some(final_path) = final_path {
        command.arg(final_path);
    }
    let output = command.output().expect("run Git");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        command,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_output(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("run Git");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("Git output is UTF-8")
}
