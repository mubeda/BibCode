//! `agentSessions.scan`, `agentSessions.import`, and History's `agentSessions.listForThread` and
//! `agentSessions.openInPanel`, against real transcripts in temporary Claude and Codex homes,
//! through the production RPC registry.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use bibcode_server::{
    CauseItem, RpcExit, RpcRegistry, ServerConfig, ServerHandle, ServerMessage, ServerRuntime,
    orchestration::{EngineOptions, OrchestrationEngine},
    persistence::{Database, ProviderSessionRuntime, run_migrations},
    production::{
        agent_sessions_rpc::{
            register_agent_sessions_rpc, register_agent_sessions_rpc_with_loaded_gate,
        },
        orchestration_rpc::register_orchestration_rpc,
        provider_runtime::PublishedProviderInventory,
        step_gate::StepGate,
        worktree_catalog_rpc::{WorktreeCatalogRpcServices, register_worktree_catalog_rpc},
    },
    worktree_catalog::WorktreeCatalogService,
};
use futures_util::SinkExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

#[path = "support/websocket_frames.rs"]
mod websocket_frames;
use websocket_frames::next_frame_past_heartbeat;

type TestSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const CLAUDE_ID: &str = "0f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const CODEX_ID: &str = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const RESPONSE_DEADLINE: Duration = Duration::from_secs(10);

fn write_jsonl(path: &Path, records: &[Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(path, text + "\n").unwrap();
}

fn catalog(engine: &OrchestrationEngine) -> WorktreeCatalogService {
    WorktreeCatalogService::new(
        Arc::new(engine.repositories()),
        Arc::new(bibcode_server::git::GitRepository::default()),
    )
}

async fn request(socket: &mut TestSocket, id: &str, tag: &str, payload: Value) -> RpcExit {
    send(socket, id, tag, payload).await;
    exit_of(socket, id).await
}

async fn success(socket: &mut TestSocket, id: &str, tag: &str, payload: Value) -> Value {
    match request(socket, id, tag, payload).await {
        RpcExit::Success { value } => value.unwrap_or(Value::Null),
        other => panic!("{tag} failed: {other:?}"),
    }
}

#[tokio::test]
async fn imports_cli_sessions_as_threads_that_resume_them() {
    let temp = TempDir::new().unwrap();
    let workspace = temp.path().join("repo");
    let other = temp.path().join("other");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let workspace = std::fs::canonicalize(workspace).unwrap();
    let claude_home = temp.path().join("claude-home");
    let codex_home = temp.path().join("codex-home");
    // Both homes point into the temporary directory so no test reads the developer's own.
    let settings_root = temp.path().join("state");
    std::fs::create_dir_all(&settings_root).unwrap();
    std::fs::write(
        settings_root.join("settings.json"),
        json!({
            "providerInstances": {
                "claudeAgent": {
                    "driver": "claudeAgent",
                    "environment": [{ "name": "CLAUDE_CONFIG_DIR", "value": claude_home }]
                },
                "codex": { "driver": "codex", "config": { "homePath": codex_home } }
            }
        })
        .to_string(),
    )
    .unwrap();
    write_jsonl(
        &claude_home.join(format!("projects/-repo/{CLAUDE_ID}.jsonl")),
        &[
            json!({"type":"user","sessionId":CLAUDE_ID,"cwd":workspace,"timestamp":"2026-10-07T10:00:00.000Z","message":{"role":"user","content":"Explain the build"}}),
            json!({"type":"user","sessionId":CLAUDE_ID,"isSidechain":true,"message":{"content":"subagent"}}),
            json!({"type":"assistant","sessionId":CLAUDE_ID,"timestamp":"2026-10-07T10:00:05.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"It uses Cargo."}]}}),
        ],
    );
    let elsewhere = "1f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
    write_jsonl(
        &claude_home.join(format!("projects/-other/{elsewhere}.jsonl")),
        &[
            json!({"type":"user","sessionId":elsewhere,"cwd":other,"message":{"content":"Elsewhere"}}),
        ],
    );
    write_jsonl(
        &codex_home.join(format!(
            "sessions/2026/10/07/rollout-2026-10-07T09-00-00-{CODEX_ID}.jsonl"
        )),
        &[
            json!({"type":"session_meta","timestamp":"2026-10-07T09:00:00.000Z","payload":{"id":CODEX_ID,"cwd":workspace}}),
            json!({"type":"turn_context","payload":{"model":"gpt-5.4","cwd":workspace}}),
            json!({"type":"response_item","timestamp":"2026-10-07T09:00:01.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add a test"}]}}),
            json!({"type":"event_msg","timestamp":"2026-10-07T09:00:01.000Z","payload":{"type":"user_message","message":"Add a test"}}),
            json!({"type":"response_item","timestamp":"2026-10-07T09:00:09.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Added."}]}}),
        ],
    );

    let database = Database::open_in_memory().await.unwrap();
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .unwrap();
    let engine = OrchestrationEngine::start(database, EngineOptions::default())
        .await
        .unwrap();
    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"project.create","commandId":"create-project","projectId":"project",
                "title":"Repo","workspaceRoot":workspace,"createdAt":"2026-10-01T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let mut registry = RpcRegistry::empty();
    register_orchestration_rpc(&mut registry, engine.clone());
    register_agent_sessions_rpc(
        &mut registry,
        engine.clone(),
        settings_root,
        catalog(&engine),
        Default::default(),
    );
    let handle = ServerRuntime::start_with_registry(
        ServerConfig::new(temp.path())
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth(),
        registry,
    )
    .await
    .unwrap();
    let mut socket = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .unwrap()
        .0;
    let claude_thread = format!("import:claudeAgent:{CLAUDE_ID}");
    let codex_thread = format!("import:codex:{CODEX_ID}");
    // An import interrupted after it created the Claude thread is not imported yet.
    engine
        .dispatch(
            serde_json::from_value(json!({
                "type":"thread.create","commandId":"interrupted-import","threadId":claude_thread,
                "projectId":"project","title":"Explain the build",
                "modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-4-8"},
                "runtimeMode":"full-access","interactionMode":"default","branch":null,
                "createdAt":"2026-10-07T10:00:00.000Z"
            }))
            .unwrap(),
        )
        .await
        .unwrap();

    let scanned = success(
        &mut socket,
        "1",
        "agentSessions.scan",
        json!({"projectId":"project"}),
    )
    .await;
    assert_eq!(scanned["truncated"], json!(false));
    let mut candidates = scanned["candidates"].as_array().unwrap().clone();
    candidates.iter_mut().for_each(|candidate| {
        candidate.as_object_mut().unwrap().remove("lastActiveAt");
    });
    assert_eq!(candidates.len(), 2, "{candidates:?}");
    for (provider, session_id, title) in [
        ("claudeAgent", CLAUDE_ID, "Explain the build"),
        ("codex", CODEX_ID, "Add a test"),
    ] {
        assert!(
            candidates.contains(&json!({
                "provider":provider,"sessionId":session_id,"title":title,
                "messageCount":2,"alreadyImported":false
            })),
            "{candidates:?}"
        );
    }

    let sessions = json!({"projectId":"project","sessions":[
        {"provider":"claudeAgent","sessionId":CLAUDE_ID},
        {"provider":"codex","sessionId":CODEX_ID},
        {"provider":"claudeAgent","sessionId":elsewhere}
    ]});
    let imported = success(&mut socket, "2", "agentSessions.import", sessions.clone()).await;
    assert_eq!(
        imported["imported"],
        json!([
            {"sessionId":CLAUDE_ID,"threadId":claude_thread},
            {"sessionId":CODEX_ID,"threadId":codex_thread}
        ])
    );
    assert_eq!(
        imported["skipped"],
        json!([{"sessionId":elsewhere,"reason":"The session was not run in this project's folder."}])
    );

    let repositories = engine.repositories();
    for (thread_id, provider, model, adapter, cursor, payload, texts) in [
        (
            &claude_thread,
            "claudeAgent",
            "claude-opus-4-8",
            "claude-stream-json",
            json!({"sessionId":CLAUDE_ID}),
            json!({"transport":"stream-json"}),
            [
                ("user", "Explain the build"),
                ("assistant", "It uses Cargo."),
            ],
        ),
        (
            &codex_thread,
            "codex",
            "gpt-5.4",
            "codex-app-server",
            json!({"threadId":CODEX_ID}),
            json!({"model":"gpt-5.4","cwd":workspace}),
            [("user", "Add a test"), ("assistant", "Added.")],
        ),
    ] {
        let thread = repositories
            .get_thread(thread_id.clone())
            .await
            .unwrap()
            .expect("imported thread");
        assert_eq!(thread.project_id, "project");
        assert_eq!(
            thread.model_selection,
            json!({"instanceId":provider,"model":model})
        );
        let messages = repositories
            .list_messages_by_thread(thread_id.clone())
            .await
            .unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| (message.role.as_str(), message.text.as_str()))
                .collect::<Vec<_>>(),
            texts
        );
        assert!(messages.iter().all(|message| message.turn_id.is_none()));
        let runtime = repositories
            .get_provider_session_runtime(thread_id.clone())
            .await
            .unwrap()
            .expect("runtime row");
        assert_eq!(runtime.status, "suspended");
        assert_eq!(runtime.provider_name, provider);
        assert_eq!(runtime.provider_instance_id.as_deref(), Some(provider));
        assert_eq!(runtime.adapter_key, adapter);
        assert_eq!(runtime.resume_cursor, Some(cursor));
        assert_eq!(runtime.runtime_payload, Some(payload));
    }

    // A session another BiBCode thread runs is neither offered nor imported, and an
    // interrupted import whose thread started its own conversation keeps that conversation.
    let owned_id = "2f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
    let used_id = "3f8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
    for (id, prompt) in [(owned_id, "Owned prompt"), (used_id, "Used prompt")] {
        write_jsonl(
            &claude_home.join(format!("projects/-repo/{id}.jsonl")),
            &[json!({"type":"user","sessionId":id,"cwd":workspace,"message":{"content":prompt}})],
        );
    }
    let used_thread = format!("import:claudeAgent:{used_id}");
    for (command_id, thread) in [
        ("owner-create", "owner-thread"),
        ("used-create", used_thread.as_str()),
    ] {
        engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"thread.create","commandId":command_id,"threadId":thread,
                    "projectId":"project","title":"Thread",
                    "modelSelection":{"instanceId":"claudeAgent","model":"claude-opus-4-8"},
                    "runtimeMode":"full-access","interactionMode":"default","branch":null,
                    "createdAt":"2026-10-07T10:00:00.000Z"
                }))
                .unwrap(),
            )
            .await
            .unwrap();
    }
    for (thread, cursor) in [
        ("owner-thread", owned_id),
        (used_thread.as_str(), "fresh-conversation"),
    ] {
        repositories
            .upsert_provider_session_runtime(ProviderSessionRuntime {
                thread_id: thread.to_owned(),
                provider_name: "claudeAgent".to_owned(),
                provider_instance_id: Some("claudeAgent".to_owned()),
                adapter_key: "claude-stream-json".to_owned(),
                runtime_mode: "full-access".to_owned(),
                status: "suspended".to_owned(),
                last_seen_at: "2026-10-07T10:00:00.000Z".to_owned(),
                resume_cursor: Some(json!({"sessionId":cursor})),
                runtime_payload: None,
            })
            .await
            .unwrap();
    }
    let listed = success(
        &mut socket,
        "8",
        "agentSessions.scan",
        json!({"projectId":"project"}),
    )
    .await;
    let listed_ids = listed["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|candidate| candidate["sessionId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(listed_ids.iter().any(|id| id == used_id), "{listed_ids:?}");
    assert!(
        !listed_ids.iter().any(|id| id == owned_id),
        "{listed_ids:?}"
    );
    let refused = success(
        &mut socket,
        "9",
        "agentSessions.import",
        json!({"projectId":"project","sessions":[
            {"provider":"claudeAgent","sessionId":owned_id},
            {"provider":"claudeAgent","sessionId":used_id}
        ]}),
    )
    .await;
    assert_eq!(refused["imported"], json!([]));
    assert_eq!(
        refused["skipped"],
        json!([
            {"sessionId":owned_id,"reason":"This session already belongs to a BiBCode thread."},
            {"sessionId":used_id,"reason":"This session's thread was used before its import finished, so it keeps its own conversation."}
        ])
    );
    assert_eq!(
        repositories
            .get_provider_session_runtime(used_thread.clone())
            .await
            .unwrap()
            .unwrap()
            .resume_cursor,
        Some(json!({"sessionId":"fresh-conversation"}))
    );

    let repeated = success(&mut socket, "3", "agentSessions.import", sessions).await;
    assert_eq!(repeated["imported"], json!([]));
    assert_eq!(
        repeated["skipped"].as_array().unwrap()[..2],
        [
            json!({"sessionId":CLAUDE_ID,"reason":"Already imported."}),
            json!({"sessionId":CODEX_ID,"reason":"Already imported."})
        ]
    );
    assert_eq!(
        repositories
            .list_messages_by_thread(claude_thread.clone())
            .await
            .unwrap()
            .len(),
        2
    );
    let rescanned = success(
        &mut socket,
        "4",
        "agentSessions.scan",
        json!({"projectId":"project"}),
    )
    .await;
    let claude = rescanned["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["sessionId"] == CLAUDE_ID)
        .unwrap();
    assert_eq!(claude["alreadyImported"], json!(true));
    assert_eq!(claude["threadId"], json!(claude_thread));

    // A deleted import keeps its ID, so it is reported instead of failing thread creation.
    engine
        .dispatch(
            serde_json::from_value(
                json!({"type":"thread.delete","commandId":"delete-import","threadId":claude_thread}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let after_delete = success(
        &mut socket,
        "6",
        "agentSessions.scan",
        json!({"projectId":"project"}),
    )
    .await;
    let claude = after_delete["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["sessionId"] == CLAUDE_ID)
        .unwrap();
    assert_eq!(claude["alreadyImported"], json!(true));
    assert!(claude.get("threadId").is_none());
    let reimported = success(
        &mut socket,
        "7",
        "agentSessions.import",
        json!({"projectId":"project","sessions":[{"provider":"claudeAgent","sessionId":CLAUDE_ID}]}),
    )
    .await;
    assert_eq!(
        reimported["skipped"],
        json!([{"sessionId":CLAUDE_ID,"reason":"This session was imported before and its thread was deleted."}])
    );

    match request(
        &mut socket,
        "5",
        "agentSessions.scan",
        json!({"projectId":"missing"}),
    )
    .await
    {
        RpcExit::Failure { cause } => match &cause[..] {
            [CauseItem::Fail { error }] => {
                assert_eq!(error["_tag"], json!("AgentSessionsError"));
                assert_eq!(error["message"], json!("The project no longer exists."));
            }
            other => panic!("unexpected cause {other:?}"),
        },
        other => panic!("expected a failure, got {other:?}"),
    }

    handle.shutdown();
    handle.join().await.unwrap();
    engine.shutdown().await;
}

const CLOSED_ID: &str = "1a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const LIVE_ID: &str = "2a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const ROOT_ID: &str = "3a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const DOUBTED_ID: &str = "4a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const BRANCH: &str = "feature/history";

/// The name Claude gives a folder's project directory (paths here are ASCII and short).
fn project_directory(home: &Path, folder: &Path) -> PathBuf {
    let name = folder
        .to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    home.join("projects").join(name)
}

/// A terminal session run in `folder`, `replies` answers long, last active `age` ago.
fn write_terminal_session(
    home: &Path,
    folder: &Path,
    session_id: &str,
    title: &str,
    replies: usize,
    age: Duration,
) -> PathBuf {
    let mut records = vec![
        json!({"type":"user","sessionId":session_id,"cwd":folder,"entrypoint":"cli","gitBranch":BRANCH,"timestamp":"2026-10-20T10:00:00.000Z","message":{"role":"user","content":format!("Prompt of {title}")}}),
        json!({"type":"custom-title","customTitle":title,"sessionId":session_id}),
    ];
    for index in 0..replies {
        records.push(json!({"type":"assistant","sessionId":session_id,"timestamp":"2026-10-20T10:00:01.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":format!("Reply {index}")}]}}));
    }
    let path = project_directory(home, folder).join(format!("{session_id}.jsonl"));
    write_jsonl(&path, &records);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - age)
        .unwrap();
    path
}

/// Claude's running-session file for `session_id`, owned by this live test process.
fn write_live_entry(home: &Path, name: &str, session_id: &str) {
    let directory = home.join("sessions");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join(name),
        json!({"pid":std::process::id(),"sessionId":session_id,"entrypoint":"cli","kind":"interactive"})
            .to_string(),
    )
    .unwrap();
}

struct History {
    _temp: TempDir,
    root: PathBuf,
    worktree: PathBuf,
    claude_home: PathBuf,
    engine: OrchestrationEngine,
    inventory: PublishedProviderInventory,
    handle: ServerHandle,
    socket: TestSocket,
}

#[derive(Default)]
struct Gates {
    loaded: Option<StepGate>,
    panel_dispatch: Option<StepGate>,
}

impl History {
    /// A project at `root` with three hosts: `host` in the worktree (with its panel
    /// `host-panel`), and `root-host` in the project root, in different runtime modes.
    async fn start(gates: Gates) -> Self {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("repo");
        let worktree = temp.path().join("repo-wt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let worktree = std::fs::canonicalize(worktree).unwrap();
        let claude_home = temp.path().join("claude-home");
        // A complete running-session directory: sessions without an entry are closed.
        std::fs::create_dir_all(claude_home.join("sessions")).unwrap();
        let settings_root = temp.path().join("state");
        std::fs::create_dir_all(&settings_root).unwrap();
        std::fs::write(
            settings_root.join("settings.json"),
            json!({"providerInstances":{"claudeAgent":{
                "driver":"claudeAgent",
                "environment":[{"name":"CLAUDE_CONFIG_DIR","value":claude_home}]
            }}})
            .to_string(),
        )
        .unwrap();
        let database = Database::open_in_memory().await.unwrap();
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let engine = OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .unwrap();
        let history = |command: Value| engine.dispatch(serde_json::from_value(command).unwrap());
        history(json!({
            "type":"project.create","commandId":"create-project","projectId":"project",
            "title":"Repo","workspaceRoot":root,"createdAt":"2026-10-01T00:00:00.000Z"
        }))
        .await
        .unwrap();
        for (thread_id, kind, host, worktree_path, branch, runtime_mode) in [
            (
                "host",
                "workspace",
                None,
                Some(&worktree),
                Some(BRANCH),
                "approval-required",
            ),
            (
                "host-panel",
                "panel",
                Some("host"),
                Some(&worktree),
                Some(BRANCH),
                "approval-required",
            ),
            (
                "root-host",
                "workspace",
                None,
                None,
                None,
                "auto-accept-edits",
            ),
        ] {
            history(json!({
                "type":"thread.create","commandId":format!("create-{thread_id}"),
                "threadId":thread_id,"projectId":"project","title":thread_id,"kind":kind,
                "hostThreadId":host,"modelSelection":{"instanceId":"codex","model":"gpt-5.4"},
                "runtimeMode":runtime_mode,"interactionMode":"default","branch":branch,
                "worktreePath":worktree_path,"createdAt":"2026-10-01T00:00:00.000Z"
            }))
            .await
            .unwrap();
        }
        let inventory = PublishedProviderInventory::default();
        *inventory.write().await = vec![json!({"instanceId":"claudeAgent","version":"2.1.310"})];
        let catalog = catalog(&engine);
        let mut registry = RpcRegistry::empty();
        register_orchestration_rpc(&mut registry, engine.clone());
        match gates.loaded {
            Some(gate) => register_agent_sessions_rpc_with_loaded_gate(
                &mut registry,
                engine.clone(),
                settings_root,
                catalog.clone(),
                inventory.clone(),
                gate,
            ),
            None => register_agent_sessions_rpc(
                &mut registry,
                engine.clone(),
                settings_root,
                catalog.clone(),
                inventory.clone(),
            ),
        }
        let mut worktrees = WorktreeCatalogRpcServices::new(catalog, engine.clone());
        if let Some(gate) = gates.panel_dispatch {
            worktrees = worktrees.with_panel_dispatch_gate(gate);
        }
        register_worktree_catalog_rpc(&mut registry, worktrees);
        let handle = ServerRuntime::start_with_registry(
            ServerConfig::new(temp.path())
                .with_bind("127.0.0.1", 0)
                .with_unsafe_no_auth(),
            registry,
        )
        .await
        .unwrap();
        let socket = connect_async(format!("ws://{}/ws", handle.local_addr()))
            .await
            .unwrap()
            .0;
        Self {
            _temp: temp,
            root,
            worktree,
            claude_home,
            engine,
            inventory,
            handle,
            socket,
        }
    }

    async fn dispatch(&self, command: Value) {
        self.engine
            .dispatch(serde_json::from_value(command).unwrap())
            .await
            .unwrap();
    }

    async fn list(&mut self, id: &str, thread_id: &str) -> Value {
        success(
            &mut self.socket,
            id,
            "agentSessions.listForThread",
            json!({"threadId":thread_id}),
        )
        .await
    }

    async fn open(
        &mut self,
        id: &str,
        command_id: &str,
        host: &str,
        session: &str,
        mode: &str,
    ) -> RpcExit {
        request(
            &mut self.socket,
            id,
            "agentSessions.openInPanel",
            json!({"commandId":command_id,"hostThreadId":host,"sessionId":session,"mode":mode}),
        )
        .await
    }

    async fn shutdown(self) {
        self.handle.shutdown();
        self.handle.join().await.unwrap();
        self.engine.shutdown().await;
    }
}

fn entry<'a>(listed: &'a Value, session_id: &str) -> Option<&'a Value> {
    listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["sessionId"] == session_id)
}

fn refusal(exit: RpcExit) -> String {
    match exit {
        RpcExit::Failure { cause } => match &cause[..] {
            [CauseItem::Fail { error }] => {
                assert_eq!(error["_tag"], json!("AgentSessionsError"));
                error["message"].as_str().unwrap().to_owned()
            }
            other => panic!("unexpected cause {other:?}"),
        },
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn opened(exit: RpcExit) -> Value {
    match exit {
        RpcExit::Success { value } => value.unwrap_or(Value::Null),
        other => panic!("openInPanel failed: {other:?}"),
    }
}

#[tokio::test]
async fn history_continues_a_terminal_session_in_a_panel_of_its_thread() {
    let mut history = History::start(Gates::default()).await;
    let (home, worktree) = (history.claude_home.clone(), history.worktree.clone());
    write_terminal_session(
        &home,
        &worktree,
        CLOSED_ID,
        "Flaky test",
        250,
        Duration::from_secs(3_600),
    );
    let live_transcript = write_terminal_session(
        &home,
        &worktree,
        LIVE_ID,
        "Live work",
        1,
        Duration::from_secs(60),
    );
    write_live_entry(&home, "41.json", LIVE_ID);
    // The root's sessions are another folder's.
    write_terminal_session(
        &home,
        &history.root.clone(),
        ROOT_ID,
        "Root work",
        1,
        Duration::ZERO,
    );

    // From the host's chat panel, History acts for the host and lists the host's folder.
    let listed = history.list("1", "host-panel").await;
    assert_eq!(listed["truncated"], json!(false));
    assert_eq!(listed["copySupported"], json!(true));
    let ids = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["sessionId"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, [LIVE_ID, CLOSED_ID], "newest first, this folder only");
    let mut closed = entry(&listed, CLOSED_ID).unwrap().clone();
    closed.as_object_mut().unwrap().remove("lastActiveAt");
    assert_eq!(
        closed,
        json!({"sessionId":CLOSED_ID,"title":"Flaky test","branch":BRANCH,"liveness":"closed","importDeleted":false})
    );
    assert_eq!(entry(&listed, LIVE_ID).unwrap()["liveness"], json!("live"));

    // Continue: a panel of the host, in the host's folder and mode, with the session's history.
    let import_thread = format!("import:claudeAgent:{CLOSED_ID}");
    let created = opened(
        history
            .open("2", "open-closed", "host", CLOSED_ID, "resume")
            .await,
    );
    assert_eq!(
        created,
        json!({"threadId":import_thread,"hostThreadId":"host","outcome":"created"})
    );
    let repositories = history.engine.repositories();
    let panel = repositories
        .get_thread(import_thread.clone())
        .await
        .unwrap()
        .expect("panel thread");
    assert_eq!(panel.kind, "panel");
    assert_eq!(panel.host_thread_id.as_deref(), Some("host"));
    assert_eq!(panel.branch.as_deref(), Some(BRANCH));
    assert_eq!(
        panel.worktree_path.as_deref(),
        Some(worktree.to_str().unwrap())
    );
    assert_eq!(panel.runtime_mode, "approval-required");
    assert_eq!(panel.title, "Flaky test");
    assert_eq!(
        panel.model_selection,
        json!({"instanceId":"claudeAgent","model":"claude-opus-4-8"})
    );
    assert_eq!(
        repositories
            .list_messages_by_thread(import_thread.clone())
            .await
            .unwrap()
            .len(),
        200
    );
    let runtime = repositories
        .get_provider_session_runtime(import_thread.clone())
        .await
        .unwrap()
        .expect("runtime row");
    assert_eq!(runtime.status, "suspended");
    assert_eq!(runtime.runtime_mode, "approval-required");
    assert_eq!(runtime.resume_cursor, Some(json!({"sessionId":CLOSED_ID})));

    // A retry of the command, and another client continuing the same session, reach that panel.
    let existing = json!({"threadId":import_thread,"hostThreadId":"host","outcome":"existing"});
    assert_eq!(
        opened(
            history
                .open("3", "open-closed", "host", CLOSED_ID, "resume")
                .await
        ),
        existing
    );
    let mut other_client = connect_async(format!("ws://{}/ws", history.handle.local_addr()))
        .await
        .unwrap()
        .0;
    assert_eq!(
        success(
            &mut other_client,
            "1",
            "agentSessions.openInPanel",
            json!({"commandId":"other-client","hostThreadId":"host","sessionId":CLOSED_ID,"mode":"resume"}),
        )
        .await,
        existing
    );

    // History now offers Open, and reports a refused resume and a closed panel.
    let listed = history.list("4", "host").await;
    assert_eq!(
        entry(&listed, CLOSED_ID).unwrap()["importedThread"],
        json!({"threadId":import_thread,"hostThreadId":"host","archived":false,"resumeRefused":false})
    );
    repositories
        .upsert_provider_session_runtime(ProviderSessionRuntime {
            runtime_payload: Some(json!({"transport":"stream-json","resumeRefused":true})),
            ..runtime
        })
        .await
        .unwrap();
    history
        .dispatch(
            json!({"type":"thread.archive","commandId":"close-panel","threadId":import_thread}),
        )
        .await;
    let listed = history.list("5", "host").await;
    assert_eq!(
        entry(&listed, CLOSED_ID).unwrap()["importedThread"],
        json!({"threadId":import_thread,"hostThreadId":"host","archived":true,"resumeRefused":true})
    );

    // A session a terminal has open is never resumed; a copy leaves its transcript untouched.
    assert_eq!(
        refusal(
            history
                .open("6", "open-live", "host", LIVE_ID, "resume")
                .await
        ),
        "This session is open in a terminal. Choose Continue in a copy."
    );
    let source = std::fs::read(&live_transcript).unwrap();
    let copied = opened(
        history
            .open("7", "copy-live", "host", LIVE_ID, "fork")
            .await,
    );
    assert_eq!(copied["hostThreadId"], json!("host"));
    assert_eq!(copied["outcome"], json!("created"));
    let copy_thread = copied["threadId"].as_str().unwrap().to_owned();
    let fork_id = copy_thread
        .strip_prefix("copy:claudeAgent:")
        .expect("a copy thread")
        .to_owned();
    assert_ne!(fork_id, LIVE_ID);
    let copy = repositories
        .get_thread(copy_thread.clone())
        .await
        .unwrap()
        .expect("copy thread");
    assert_eq!(copy.title, "Live work (copy)");
    assert_eq!(copy.host_thread_id.as_deref(), Some("host"));
    assert_eq!(
        repositories
            .get_provider_session_runtime(copy_thread.clone())
            .await
            .unwrap()
            .expect("copy runtime")
            .resume_cursor,
        Some(json!({"sessionId":fork_id,"forkedFrom":LIVE_ID}))
    );
    assert_eq!(std::fs::read(&live_transcript).unwrap(), source);
    // Each Continue in a copy makes another copy.
    let second = opened(
        history
            .open("8", "copy-live-again", "host", LIVE_ID, "fork")
            .await,
    );
    assert_ne!(second["threadId"], json!(copy_thread));

    // Once the copy's first turn writes its transcript beside the source's, it is not listed.
    write_jsonl(
        &project_directory(&home, &worktree).join(format!("{fork_id}.jsonl")),
        &[
            json!({"type":"user","sessionId":fork_id,"cwd":worktree,"entrypoint":"cli","message":{"content":"Prompt of Live work"}}),
        ],
    );
    let listed = history.list("9", "host").await;
    assert!(entry(&listed, &fork_id).is_none(), "{listed}");
    assert!(entry(&listed, LIVE_ID).is_some());

    // A deleted import can only be copied.
    history
        .dispatch(
            json!({"type":"thread.delete","commandId":"delete-import","threadId":import_thread}),
        )
        .await;
    let listed = history.list("10", "host").await;
    let deleted = entry(&listed, CLOSED_ID).unwrap();
    assert_eq!(deleted["importDeleted"], json!(true));
    assert!(deleted.get("importedThread").is_none());
    assert_eq!(
        refusal(
            history
                .open("11", "reopen-deleted", "host", CLOSED_ID, "resume")
                .await
        ),
        "This session's chat was deleted. Choose Continue in a copy."
    );

    // An unreadable running-session file leaves sessions not found live unknown.
    write_terminal_session(
        &home,
        &worktree,
        DOUBTED_ID,
        "Doubted",
        1,
        Duration::from_secs(30),
    );
    std::fs::write(home.join("sessions/42.json"), "{not json").unwrap();
    let listed = history.list("12", "host").await;
    assert_eq!(
        entry(&listed, DOUBTED_ID).unwrap()["liveness"],
        json!("unknown")
    );
    assert_eq!(entry(&listed, LIVE_ID).unwrap()["liveness"], json!("live"));
    assert_eq!(
        refusal(
            history
                .open("13", "open-doubted", "host", DOUBTED_ID, "resume")
                .await
        ),
        "This session is open in a terminal. Choose Continue in a copy."
    );
    history.shutdown().await;
}

/// A copy's own transcript is a conversation BiBCode owns, so neither History nor the Import
/// dialog offers it, while its source stays offered.
#[tokio::test]
async fn a_copy_is_offered_neither_by_history_nor_by_the_import_dialog() {
    let mut history = History::start(Gates::default()).await;
    let (home, root) = (history.claude_home.clone(), history.root.clone());
    write_terminal_session(
        &home,
        &root,
        ROOT_ID,
        "Root work",
        1,
        Duration::from_secs(60),
    );
    let copied = opened(
        history
            .open("1", "copy-root", "root-host", ROOT_ID, "fork")
            .await,
    );
    let copy_thread = copied["threadId"].as_str().unwrap().to_owned();
    let fork_id = copy_thread
        .strip_prefix("copy:claudeAgent:")
        .unwrap()
        .to_owned();
    // A root host's panel runs in that host's mode and folder.
    let copy = history
        .engine
        .repositories()
        .get_thread(copy_thread)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(copy.runtime_mode, "auto-accept-edits");
    assert_eq!(copy.worktree_path, None);
    write_jsonl(
        &project_directory(&home, &root).join(format!("{fork_id}.jsonl")),
        &[
            json!({"type":"user","sessionId":fork_id,"cwd":root,"entrypoint":"cli","message":{"content":"Prompt of Root work"}}),
        ],
    );
    let listed = history.list("2", "root-host").await;
    assert!(entry(&listed, ROOT_ID).is_some());
    assert!(entry(&listed, &fork_id).is_none(), "{listed}");
    let scanned = success(
        &mut history.socket,
        "3",
        "agentSessions.scan",
        json!({"projectId":"project"}),
    )
    .await;
    let scanned_ids = scanned["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|candidate| candidate["sessionId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(
        scanned_ids.iter().any(|id| id == ROOT_ID),
        "{scanned_ids:?}"
    );
    assert!(!scanned_ids.contains(&fork_id), "{scanned_ids:?}");
    history.shutdown().await;
}

#[tokio::test]
async fn copies_need_a_claude_code_that_takes_their_session_id() {
    let mut history = History::start(Gates::default()).await;
    let (home, worktree) = (history.claude_home.clone(), history.worktree.clone());
    write_terminal_session(
        &home,
        &worktree,
        LIVE_ID,
        "Live work",
        1,
        Duration::from_secs(60),
    );
    for version in [Some("2.0.72"), None] {
        *history.inventory.write().await = version
            .map(|version| json!({"instanceId":"claudeAgent","version":version}))
            .into_iter()
            .collect();
        assert_eq!(
            history.list("1", "host").await["copySupported"],
            json!(false)
        );
        assert_eq!(
            refusal(history.open("2", "copy-old", "host", LIVE_ID, "fork").await),
            "Continue in a copy needs Claude Code 2.0.73 or later. Update it in Settings → Providers."
        );
    }
    *history.inventory.write().await =
        vec![json!({"instanceId":"claudeAgent","version":"2.0.73 (Claude Code)"})];
    assert_eq!(
        history.list("3", "host").await["copySupported"],
        json!(true)
    );
    history.shutdown().await;
}

async fn send(socket: &mut TestSocket, id: &str, tag: &str, payload: Value) {
    socket
        .send(Message::Text(
            json!({"_tag":"Request","id":id,"tag":tag,"payload":payload,"headers":[]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
}

async fn exit_of(socket: &mut TestSocket, id: &str) -> RpcExit {
    let message = timeout(RESPONSE_DEADLINE, next_frame_past_heartbeat(socket))
        .await
        .expect("response before the deadline")
        .expect("socket open")
        .expect("valid frame");
    let Message::Text(text) = message else {
        panic!("expected a text frame, got {message:?}");
    };
    match serde_json::from_str(&text).expect("server message") {
        ServerMessage::Exit { request_id, exit } => {
            assert_eq!(request_id.as_str(), id);
            exit
        }
        other => panic!("expected an exit, got {other:?}"),
    }
}

/// A generic delete takes no project lock, so a host can go while its session loads or after
/// `worktree.createPanel` revalidated it. Neither leaves a panel without its host, and a host
/// deleted after its panel was created takes the panel with it.
#[tokio::test]
async fn no_panel_outlives_its_host() {
    let loaded = StepGate::new();
    let panel_dispatch = StepGate::new();
    let mut history = History::start(Gates {
        loaded: Some(loaded.clone()),
        panel_dispatch: Some(panel_dispatch.clone()),
    })
    .await;
    let (home, root) = (history.claude_home.clone(), history.root.clone());
    write_terminal_session(
        &home,
        &root,
        ROOT_ID,
        "Root work",
        1,
        Duration::from_secs(60),
    );
    let import_thread = format!("import:claudeAgent:{ROOT_ID}");

    send(
        &mut history.socket,
        "1",
        "agentSessions.openInPanel",
        json!({"commandId":"open-root","hostThreadId":"root-host","sessionId":ROOT_ID,"mode":"resume"}),
    )
    .await;
    timeout(RESPONSE_DEADLINE, loaded.wait_until_reached())
        .await
        .expect("the transcript was read");
    history
        .dispatch(
            json!({"type":"thread.delete","commandId":"delete-root-host","threadId":"root-host"}),
        )
        .await;
    loaded.release();
    assert_eq!(
        refusal(exit_of(&mut history.socket, "1").await),
        "The thread was deleted."
    );
    let repositories = history.engine.repositories();
    assert!(
        repositories
            .get_thread(import_thread.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        repositories
            .get_provider_session_runtime(import_thread.clone())
            .await
            .unwrap()
            .is_none()
    );

    // The same order for `worktree.createPanel`, held after it revalidated its host.
    for host in ["second-host", "third-host"] {
        history
            .dispatch(json!({
                "type":"thread.create","commandId":format!("create-{host}"),"threadId":host,
                "projectId":"project","title":host,
                "modelSelection":{"instanceId":"codex","model":"gpt-5.4"},
                "runtimeMode":"full-access","createdAt":"2026-10-01T00:00:00.000Z"
            }))
            .await;
    }
    send(
        &mut history.socket,
        "2",
        "worktree.createPanel",
        json!({
            "commandId":"late-panel-command","hostThreadId":"second-host","threadId":"late-panel",
            "title":"Panel — Codex",
            "threadDefaults":{
                "modelSelection":{"instanceId":"codex","model":"gpt-5.4"},
                "runtimeMode":"full-access","interactionMode":"default"
            }
        }),
    )
    .await;
    timeout(RESPONSE_DEADLINE, panel_dispatch.wait_until_reached())
        .await
        .expect("the host was revalidated");
    history
        .dispatch(json!({"type":"thread.delete","commandId":"delete-second-host","threadId":"second-host"}))
        .await;
    panel_dispatch.release();
    assert!(matches!(
        exit_of(&mut history.socket, "2").await,
        RpcExit::Failure { .. }
    ));
    assert!(
        repositories
            .get_thread("late-panel".to_owned())
            .await
            .unwrap()
            .is_none()
    );

    // A host deleted after its panel was created deletes the panel.
    loaded.release();
    let created = opened(
        history
            .open("3", "open-third", "third-host", ROOT_ID, "resume")
            .await,
    );
    assert_eq!(created["outcome"], json!("created"));
    history
        .dispatch(
            json!({"type":"thread.delete","commandId":"delete-third-host","threadId":"third-host"}),
        )
        .await;
    assert!(
        repositories
            .get_thread(import_thread)
            .await
            .unwrap()
            .expect("panel row")
            .deleted_at
            .is_some()
    );
    history.shutdown().await;
}
