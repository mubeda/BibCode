//! The shared-checkout restore guard and the conversation-only rewind (#279), through the
//! effects worker with production Git and a fake provider side.

use super::*;
use crate::{
    orchestration::{
        CommandAdmission, EngineOptions, NewProviderTurnDelivery, TurnDeliveryMode,
        TurnDeliveryState, canonical_command_digest,
    },
    persistence::{Database, run_migrations},
    production::turn_delivery::{DeliveryRouter, TurnDeliveryService},
    test_support::isolated_git_config::IsolatedGitConfig,
};
use std::sync::{
    Mutex as StdMutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::{sync::Notify, time::timeout};

const WAIT: Duration = Duration::from_secs(30);
const T0: &str = "2026-08-01T00:00:00Z";
const T1: &str = "2026-08-01T00:00:01Z";
const T2: &str = "2026-08-01T00:00:02Z";
const T3: &str = "2026-08-01T00:00:03Z";

fn command(value: Value) -> OrchestrationCommand {
    serde_json::from_value(value).unwrap()
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let config = IsolatedGitConfig::new();
    let mut command = std::process::Command::new("git");
    config.apply_to_command(&mut command);
    let output = command.args(args).current_dir(cwd).output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Where a test holds the provider side of a revert.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Stage {
    /// Step 5, under the checkout gate: a sibling is being made quiet.
    Quiet,
    /// Step 5: the reverting thread's provider is reopened (a cold start).
    Prepare,
    /// Step 7: the provider rewinds.
    Rollback,
}

#[derive(Default)]
struct Gate {
    entered: Notify,
    release: Notify,
}

/// The provider side: rewinds, the siblings' sessions and the rewind support, with a pause.
#[derive(Default)]
struct Provider {
    rewinds: AtomicUsize,
    files_only: AtomicBool,
    writing: StdMutex<HashMap<String, WritingReason>>,
    quieted: StdMutex<Vec<String>>,
    rewind_support: StdMutex<Option<ConversationRewind>>,
    pause: StdMutex<Option<(Stage, Arc<Gate>)>>,
}

impl Provider {
    /// Pauses the next `stage` until the returned gate is released.
    fn pause_at(&self, stage: Stage) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        *self.pause.lock().unwrap() = Some((stage, gate.clone()));
        gate
    }

    async fn at(&self, stage: Stage) {
        let gate = {
            let mut pause = self.pause.lock().unwrap();
            match pause.as_ref() {
                Some((paused, _)) if *paused == stage => pause.take().map(|(_, gate)| gate),
                _ => None,
            }
        };
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
    }

    fn rewinds(&self) -> usize {
        self.rewinds.load(Ordering::SeqCst)
    }
}

impl OrchestrationEffectCallbacks for Provider {
    fn workspace_for_thread<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }

    fn rollback_provider<'a>(
        &'a self,
        _thread_id: &'a str,
        _turns: i64,
        _rewind_key: &'a str,
    ) -> BoxEffectFuture<'a, ProviderRewind> {
        Box::pin(async move {
            self.at(Stage::Rollback).await;
            self.rewinds.fetch_add(1, Ordering::SeqCst);
            Ok(if self.files_only.load(Ordering::SeqCst) {
                ProviderRewind::FilesOnly {
                    provider_label: "Claude".to_owned(),
                }
            } else {
                ProviderRewind::Rewound
            })
        })
    }

    fn prepare_provider_rewind<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async move {
            self.at(Stage::Prepare).await;
            Ok(())
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

    fn revert_probe(&self) -> Option<Box<dyn RevertProbe + '_>> {
        Some(Box::new(ProbeOf(self)))
    }
}

struct ProbeOf<'a>(&'a Provider);

impl RevertProbe for ProbeOf<'_> {
    fn thread_writes_checkout<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<WritingReason>> {
        Box::pin(async move { Ok(self.0.writing.lock().unwrap().get(thread_id).copied()) })
    }

    fn quiet_sibling<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<WritingReason>> {
        Box::pin(async move {
            self.0.at(Stage::Quiet).await;
            let writing = self.0.writing.lock().unwrap().get(thread_id).copied();
            if writing.is_none() {
                self.0.quieted.lock().unwrap().push(thread_id.to_owned());
            }
            Ok(writing)
        })
    }

    fn conversation_rewind<'a>(
        &'a self,
        _thread_id: &'a str,
    ) -> BoxEffectFuture<'a, ConversationRewind> {
        Box::pin(async move {
            Ok(self
                .0
                .rewind_support
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(ConversationRewind::Available))
        })
    }
}

/// A Git checkout shared by project `p`'s host thread `a` (turns 1 and 2 checkpointed,
/// `tracked.txt` holding `one` then `two`) and panel `b`, with the effects worker running.
struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    repo: PathBuf,
    engine: OrchestrationEngine,
    effects: OrchestrationEffects,
    provider: Arc<Provider>,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_options(EffectsOptions::default()).await
    }

    async fn with_options(options: EffectsOptions) -> Self {
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
            "the restore fixture runs production Git: unset {discovery:?} first"
        );
        let temp = tempfile::tempdir().unwrap();
        // Git cannot create worktrees under Windows' `\\?\` spelling of a canonical path (#264).
        let root = crate::git::without_verbatim_prefix(std::fs::canonicalize(temp.path()).unwrap());
        let repo = root.join("repo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
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
        let provider = Arc::new(Provider::default());
        let effects = OrchestrationEffects::start(
            engine.clone(),
            Arc::new(crate::git::GitRepository::default()),
            provider.clone(),
            options,
        )
        .await
        .unwrap();
        let fixture = Self {
            _root: temp,
            root,
            repo,
            engine,
            effects,
            provider,
        };
        fixture.project("p", &fixture.repo.clone()).await;
        fixture.thread("a", "p", "Host", None).await;
        fixture.thread("b", "p", "Panel, Codex", None).await;
        fixture
            .checkpoints("a", &[(1, "one\n", T1), (2, "two\n", T2)])
            .await;
        fixture.session("a", "ready").await;
        // A chat that never started cannot have written a file and is not a sibling (#279 Q1).
        fixture.session("b", "ready").await;
        fixture
    }

    async fn project(&self, project: &str, root: &Path) {
        self.engine.dispatch(command(json!({"type":"project.create", "commandId":format!("project-{project}"), "projectId":project, "title":project, "workspaceRoot":root, "createdAt":T0}))).await.unwrap();
    }

    async fn thread(&self, thread: &str, project: &str, title: &str, worktree: Option<&Path>) {
        self.engine.dispatch(command(json!({"type":"thread.create", "commandId":format!("thread-{thread}"), "threadId":thread, "projectId":project, "title":title, "runtimeMode":"full-access", "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "branch":null, "worktreePath":worktree, "createdAt":T0}))).await.unwrap();
    }

    async fn session(&self, thread: &str, status: &str) {
        self.engine.dispatch(command(json!({"type":"thread.session.set", "commandId":format!("session-{thread}-{status}-{}", Uuid::new_v4()), "threadId":thread, "session":{"threadId":thread, "status":status, "providerName":"codex", "activeTurnId":if status == "running" {Some(format!("{thread}-running"))} else {None}, "lastError":null, "updatedAt":T0}, "createdAt":T0}))).await.unwrap();
    }

    /// Captures `thread`'s ref 0 from the checkout now, then each turn after writing its
    /// `tracked.txt` content, as the effects worker records them.
    async fn checkpoints(&self, thread: &str, turns: &[(i64, &str, &str)]) {
        self.checkpoints_in(&self.repo.clone(), thread, turns).await;
    }

    async fn checkpoints_in(&self, cwd: &Path, thread: &str, turns: &[(i64, &str, &str)]) {
        capture_checkpoint(cwd, thread, 0).await.unwrap();
        for (turn_count, content, at) in turns {
            std::fs::write(cwd.join("tracked.txt"), content).unwrap();
            capture_checkpoint(cwd, thread, *turn_count).await.unwrap();
            self.diff_complete(thread, *turn_count, &[], at).await;
        }
    }

    async fn diff_complete(&self, thread: &str, turn_count: i64, files: &[&str], at: &str) {
        let files = files
            .iter()
            .map(|path| json!({"path":path, "kind":"modified", "additions":1, "deletions":1}))
            .collect::<Vec<_>>();
        self.engine.dispatch(command(json!({
            "type":"thread.turn.diff.complete", "commandId":format!("diff-{thread}-{turn_count}-{}", Uuid::new_v4()),
            "threadId":thread, "turnId":format!("{thread}-turn-{turn_count}"),
            "checkpointTurnCount":turn_count, "checkpointRef":checkpoint_ref(thread, turn_count),
            "status":"ready", "files":files, "assistantMessageId":null,
            "completedAt":at, "createdAt":at
        }))).await.unwrap();
    }

    /// A thread `z` alone in a linked worktree of the repository, with turn 1 checkpointed
    /// (`one`). A thread on the project root is never alone: the project's default thread is
    /// there too.
    async fn alone(&self) -> PathBuf {
        let linked = self.root.join("alone");
        git(
            &self.repo,
            &["worktree", "add", "--detach", linked.to_str().unwrap()],
        );
        self.thread("z", "p", "Alone", Some(&linked)).await;
        self.checkpoints_in(&linked, "z", &[(1, "one\n", T1)]).await;
        self.session("z", "ready").await;
        linked
    }

    fn tracked(&self) -> String {
        std::fs::read_to_string(self.repo.join("tracked.txt")).unwrap()
    }

    /// Requests a revert of `thread` to `turn_count` and returns how it ended: `Ok` when the
    /// thread was reverted, `Err` with the failure activity's payload otherwise.
    async fn revert(
        &self,
        thread: &str,
        turn_count: i64,
        mode: &str,
        token: Option<&str>,
    ) -> Result<(), Value> {
        let outcome = self.request_revert(thread, turn_count, mode, token).await;
        outcome.await.unwrap()
    }

    /// Requests a revert and returns a task that resolves to its outcome.
    async fn request_revert(
        &self,
        thread: &str,
        turn_count: i64,
        mode: &str,
        token: Option<&str>,
    ) -> tokio::task::JoinHandle<Result<(), Value>> {
        let mut events = self.engine.subscribe_events();
        let id = format!("revert-{}", Uuid::new_v4());
        let mut value = json!({"type":"thread.checkpoint.revert", "commandId":id, "threadId":thread, "turnCount":turn_count, "mode":mode, "createdAt":T3});
        if let Some(token) = token {
            value["siblingChangesToken"] = json!(token);
        }
        self.engine.dispatch(command(value)).await.unwrap();
        let thread = thread.to_owned();
        tokio::spawn(async move {
            timeout(WAIT, async {
                loop {
                    let event = events.recv().await.unwrap();
                    if event.event.payload.get("threadId").and_then(Value::as_str)
                        != Some(thread.as_str())
                    {
                        continue;
                    }
                    if event.event.event_type == "thread.reverted" {
                        return Ok(());
                    }
                    if event.event.event_type == "thread.activity-appended"
                        && event
                            .event
                            .payload
                            .pointer("/activity/kind")
                            .and_then(Value::as_str)
                            == Some("checkpoint.revert.failed")
                    {
                        return Err(event.event.payload["activity"]["payload"].clone());
                    }
                }
            })
            .await
            .expect("the revert ends")
        })
    }

    async fn preview(&self, thread: &str, turn_count: i64) -> Value {
        let provider = self.provider.clone();
        let probe = ProbeOf(&provider);
        preview_checkpoint_revert(
            &self.engine,
            Some(&probe),
            thread,
            turn_count,
            &CancellationToken::new(),
        )
        .await
        .unwrap()
    }

    async fn shutdown(self) {
        self.effects.shutdown().await;
        self.engine.shutdown().await;
    }
}

fn init_repo(cwd: &Path) {
    for args in [
        &["init"][..],
        &["config", "user.name", "BiBCode Test"],
        &["config", "user.email", "bibcode@example.test"],
        &["config", "commit.gpgSign", "false"],
        &["config", "core.autocrlf", "false"],
    ] {
        git(cwd, args);
    }
    std::fs::write(cwd.join("tracked.txt"), "baseline\n").unwrap();
    git(cwd, &["add", "."]);
    git(cwd, &["commit", "-m", "baseline"]);
}

fn detail(failure: &Value) -> &str {
    failure["detail"].as_str().unwrap_or_default()
}

/// A turn delivery service whose router reports each delivered thread, and holds the
/// threads in `hold` until released.
fn delivery(
    engine: &OrchestrationEngine,
    hold: Arc<StdMutex<HashMap<String, Arc<Notify>>>>,
) -> (
    TurnDeliveryService,
    tokio::sync::mpsc::UnboundedReceiver<String>,
) {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let router: DeliveryRouter = Arc::new(move |command| {
        let thread = command.aggregate_ref().1.to_owned();
        let sender = sender.clone();
        let held = hold.lock().unwrap().get(&thread).cloned();
        Box::pin(async move {
            if let Some(release) = held {
                release.notified().await;
            }
            let _ = sender.send(thread);
            Ok(())
        })
    });
    (
        TurnDeliveryService::start_with_router(engine.clone(), 4, router),
        receiver,
    )
}

async fn send_message(engine: &OrchestrationEngine, thread: &str, id: &str) {
    let command = command(
        json!({"type":"thread.turn.start", "commandId":id, "threadId":thread, "message":{"messageId":id, "role":"user", "text":id, "attachments":[]}, "modelSelection":{"instanceId":"codex", "model":"gpt-5"}, "createdAt":T3}),
    );
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
                    provider_instance_id: "codex".into(),
                    provider_kind: "codex".into(),
                    provider_session_id: None,
                    delivery_key: id.into(),
                    payload: serde_json::to_value(&command).unwrap(),
                    state: TurnDeliveryState::Pending,
                    mode: TurnDeliveryMode::Start,
                    created_at: T3.into(),
                }),
            },
            || {},
        )
        .await
        .unwrap();
}

async fn not_delivered(routes: &mut tokio::sync::mpsc::UnboundedReceiver<String>) {
    assert!(
        timeout(Duration::from_millis(300), routes.recv())
            .await
            .is_err(),
        "no delivery expected while the restore holds the checkout"
    );
}

async fn delivered(routes: &mut tokio::sync::mpsc::UnboundedReceiver<String>, thread: &str) {
    assert_eq!(
        timeout(WAIT, routes.recv())
            .await
            .expect("delivery wakes")
            .as_deref(),
        Some(thread)
    );
}

async fn entered(gate: &Gate) {
    timeout(WAIT, gate.entered.notified())
        .await
        .expect("the revert reaches the paused stage");
}

/// Acceptance 1 (tests 1 to 3): a panel message sent while the restore is planned, reopening
/// its provider, or restoring waits, and is delivered only after the restore completed.
async fn a_sibling_turn_waits_at(stage: Stage) {
    let fixture = Fixture::new().await;
    let gate = fixture.provider.pause_at(stage);
    let (service, mut routes) = delivery(&fixture.engine, Arc::default());
    let outcome = fixture.request_revert("a", 1, "full", None).await;
    entered(&gate).await;
    send_message(&fixture.engine, "b", "b-message").await;
    service.wake();
    not_delivered(&mut routes).await;
    gate.release.notify_one();
    outcome.await.unwrap().expect("the restore completes");
    assert_eq!(fixture.tracked(), "one\n");
    delivered(&mut routes, "b").await;
    service.shutdown().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_sibling_turn_waits_while_restore_planning_holds_the_checkout() {
    a_sibling_turn_waits_at(Stage::Quiet).await;
}

#[tokio::test]
async fn a_sibling_turn_waits_during_the_cold_start() {
    a_sibling_turn_waits_at(Stage::Prepare).await;
}

#[tokio::test]
async fn a_sibling_turn_waits_until_the_restore_itself_completes() {
    a_sibling_turn_waits_at(Stage::Rollback).await;
}

#[tokio::test]
async fn a_sibling_delivery_in_flight_makes_the_restore_wait_then_refuse() {
    let fixture = Fixture::new().await;
    let release = Arc::new(Notify::new());
    let hold = Arc::new(StdMutex::new(HashMap::from([(
        "b".to_owned(),
        release.clone(),
    )])));
    let (service, mut routes) = delivery(&fixture.engine, hold);
    send_message(&fixture.engine, "b", "b-message").await;
    service.wake();
    // The panel's delivery is admitted and its provider has not accepted yet.
    timeout(WAIT, async {
        while !fixture.engine.thread_turn_admitted("b") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let outcome = fixture.request_revert("a", 1, "full", None).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!outcome.is_finished(), "the restore waits for the delivery");
    // The provider accepts: the panel now runs its turn.
    fixture.session("b", "running").await;
    release.notify_one();
    delivered(&mut routes, "b").await;
    let failure = outcome.await.unwrap().expect_err("the restore is refused");
    assert!(detail(&failure).contains("Panel, Codex"), "{failure}");
    assert!(detail(&failure).contains("rewind only the conversation"));
    assert_eq!(fixture.tracked(), "two\n");
    assert_eq!(fixture.provider.rewinds(), 0);
    service.shutdown().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_restore_gives_up_after_the_admission_wait() {
    // shortcut: a short real wait instead of a paused clock, which production Git's child
    // processes would let advance mid-read.
    let fixture = Fixture::with_options(EffectsOptions {
        checkout_restore_admission_wait: Duration::from_millis(300),
        ..EffectsOptions::default()
    })
    .await;
    fixture.thread("c", "p", "Side", None).await;
    let release = Arc::new(Notify::new());
    let hold = Arc::new(StdMutex::new(HashMap::from([(
        "b".to_owned(),
        release.clone(),
    )])));
    let (service, mut routes) = delivery(&fixture.engine, hold);
    send_message(&fixture.engine, "b", "b-never").await;
    service.wake();
    timeout(WAIT, async {
        while !fixture.engine.thread_turn_admitted("b") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let failure = fixture
        .revert("a", 1, "full", None)
        .await
        .expect_err("the restore gives up");
    assert!(detail(&failure).contains("is starting a turn"), "{failure}");
    assert_eq!(fixture.tracked(), "two\n");
    assert_eq!(fixture.provider.rewinds(), 0);
    // The restore's place in line is gone: another chat's turn is admitted at once.
    send_message(&fixture.engine, "c", "c-message").await;
    service.wake();
    delivered(&mut routes, "c").await;
    release.notify_one();
    service.shutdown().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn reverts_of_one_checkout_still_restore_in_request_order_under_the_gate() {
    let fixture = Fixture::new().await;
    fixture.thread("c", "p", "Second", None).await;
    fixture.checkpoints("c", &[(1, "one\n", T1)]).await;
    std::fs::write(fixture.repo.join("tracked.txt"), "two\n").unwrap();
    let gate = fixture.provider.pause_at(Stage::Rollback);
    let (service, mut routes) = delivery(&fixture.engine, Arc::default());
    let mut events = fixture.engine.subscribe_events();
    let first = fixture.request_revert("a", 1, "full", None).await;
    entered(&gate).await;
    let second = fixture.request_revert("c", 0, "full", None).await;
    send_message(&fixture.engine, "b", "b-message").await;
    service.wake();
    not_delivered(&mut routes).await;
    assert!(!second.is_finished());
    gate.release.notify_one();
    first.await.unwrap().expect("the first restore completes");
    let _ = second.await.unwrap();
    // The first revert's outcome comes before the second's.
    let mut order = Vec::new();
    while let Ok(event) = events.try_recv() {
        let thread = event.event.payload.get("threadId").and_then(Value::as_str);
        let ended = event.event.event_type == "thread.reverted"
            || event
                .event
                .payload
                .pointer("/activity/kind")
                .and_then(Value::as_str)
                == Some("checkpoint.revert.failed");
        if ended && let Some(thread) = thread {
            order.push(thread.to_owned());
        }
    }
    assert_eq!(order, ["a", "c"]);
    delivered(&mut routes, "b").await;
    service.shutdown().await;
    fixture.shutdown().await;
}

/// Whether the file system under `dir` ignores case: create `a`, look for `A`.
#[cfg(unix)]
fn case_insensitive(dir: &Path) -> bool {
    let probe = dir.join("case-probe-a");
    std::fs::write(&probe, "").unwrap();
    let insensitive = dir.join("CASE-PROBE-A").exists();
    std::fs::remove_file(probe).unwrap();
    insensitive
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_or_second_project_path_is_the_same_checkout() {
    let fixture = Fixture::new().await;
    let link = fixture.root.join("link");
    std::os::unix::fs::symlink(&fixture.repo, &link).unwrap();
    // A linked worktree of the same repository is a checkout of its own.
    let linked = fixture.root.join("linked");
    git(
        &fixture.repo,
        &["worktree", "add", "--detach", linked.to_str().unwrap()],
    );
    fixture
        .thread("w", "p", "Worktree chat", Some(&linked))
        .await;
    fixture.session("w", "running").await;
    fixture
        .revert("a", 2, "full", None)
        .await
        .expect("a linked worktree is not a sibling");
    // A chat whose folder is a symlink to the checkout. (A second project on the same directory
    // is the same project: creating it returns the existing one.)
    fixture
        .thread("s", "p", "Symlinked chat", Some(&link))
        .await;
    fixture.session("s", "running").await;
    let failure = fixture
        .revert("a", 1, "full", None)
        .await
        .expect_err("the symlinked chat shares the checkout");
    assert!(detail(&failure).contains("Symlinked chat"), "{failure}");
    fixture.session("s", "ready").await;
    if case_insensitive(&fixture.root) {
        let spelled = fixture.root.join("REPO");
        fixture.thread("u", "p", "Case chat", Some(&spelled)).await;
        fixture.session("u", "running").await;
        let failure = fixture
            .revert("a", 1, "full", None)
            .await
            .expect_err("a differently cased spelling shares the checkout");
        assert!(detail(&failure).contains("Case chat"), "{failure}");
    } else {
        println!("skipped the case spelling: this file system is case-sensitive");
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_project_on_a_subdirectory_shares_the_worktree_gate() {
    let fixture = Fixture::new().await;
    let subdir = fixture.repo.join("subdir");
    std::fs::create_dir(&subdir).unwrap();
    std::fs::write(subdir.join("keep.txt"), "kept\n").unwrap();
    fixture.project("p2", &subdir).await;
    fixture.thread("d", "p2", "Subdir chat", None).await;
    fixture.session("d", "running").await;
    let failure = fixture
        .revert("a", 2, "full", None)
        .await
        .expect_err("a project on a subdirectory shares the checkout");
    assert!(detail(&failure).contains("Subdir chat"), "{failure}");
    // Held by the same gate: its delivery waits while the restore is planned.
    fixture.session("d", "ready").await;
    let gate = fixture.provider.pause_at(Stage::Quiet);
    let (service, mut routes) = delivery(&fixture.engine, Arc::default());
    let outcome = fixture.request_revert("a", 2, "full", None).await;
    entered(&gate).await;
    send_message(&fixture.engine, "d", "d-message").await;
    service.wake();
    not_delivered(&mut routes).await;
    gate.release.notify_one();
    let _ = outcome.await.unwrap();
    delivered(&mut routes, "d").await;
    service.shutdown().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn removing_a_nested_git_dir_makes_the_subdir_a_sibling_without_metadata_change() {
    let fixture = Fixture::new().await;
    let nested = fixture.repo.join("nested");
    std::fs::create_dir(&nested).unwrap();
    init_repo(&nested);
    fixture.project("p2", &nested).await;
    fixture.thread("n", "p2", "Nested chat", None).await;
    fixture.session("n", "running").await;
    // The root's checkout sees the nested repository as a new entry, an outside change.
    let token = fixture.preview("a", 2).await["siblingChangesToken"]
        .as_str()
        .map(str::to_owned);
    fixture
        .revert("a", 2, "full", token.as_deref())
        .await
        .expect("a nested repository is a checkout of its own");
    std::fs::remove_dir_all(nested.join(".git")).unwrap();
    let failure = fixture
        .revert("a", 1, "full", None)
        .await
        .expect_err("without its .git the subdirectory is in the root's checkout");
    assert!(detail(&failure).contains("Nested chat"), "{failure}");
    fixture.session("n", "ready").await;
    let gate = fixture.provider.pause_at(Stage::Quiet);
    let (service, mut routes) = delivery(&fixture.engine, Arc::default());
    let outcome = fixture.request_revert("a", 1, "full", None).await;
    entered(&gate).await;
    send_message(&fixture.engine, "n", "n-message").await;
    service.wake();
    not_delivered(&mut routes).await;
    gate.release.notify_one();
    let _ = outcome.await.unwrap();
    delivered(&mut routes, "n").await;
    service.shutdown().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_unresolvable_sibling_refuses_the_restore() {
    let fixture = Fixture::new().await;
    // A chat whose folder is gone.
    let gone = fixture.repo.join("gone");
    fixture.thread("g", "p", "Gone chat", Some(&gone)).await;
    fixture.session("g", "ready").await;
    let failure = fixture
        .revert("a", 2, "full", None)
        .await
        .expect_err("a sibling whose folder is gone refuses");
    assert!(
        detail(&failure).contains("BiBCode can't tell whether Gone chat works in this checkout"),
        "{failure}"
    );
    std::fs::create_dir(&gone).unwrap();
    // A chat whose folder Git cannot read.
    let broken = fixture.repo.join("broken");
    std::fs::create_dir(&broken).unwrap();
    std::fs::write(broken.join(".git"), "not a gitdir line\n").unwrap();
    fixture.thread("r", "p", "Broken chat", Some(&broken)).await;
    fixture.session("r", "ready").await;
    let failure = fixture
        .revert("a", 2, "full", None)
        .await
        .expect_err("a sibling whose rev-parse fails refuses");
    assert!(
        detail(&failure).contains("BiBCode can't tell whether Broken chat works"),
        "{failure}"
    );
    assert_eq!(fixture.provider.rewinds(), 0);
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_delivery_keyed_before_the_change_still_makes_the_restore_refuse() {
    let fixture = Fixture::new().await;
    // The panel's delivery holds admission under the key it resolved before the change.
    let admission = fixture
        .engine
        .admit_checkout_turn("b", "an-earlier-key")
        .await
        .unwrap();
    let failure = fixture
        .revert("a", 1, "full", None)
        .await
        .expect_err("an admitted sibling refuses the restore");
    assert!(
        detail(&failure).contains("Panel, Codex) is starting a turn"),
        "{failure}"
    );
    drop(admission);
    assert_eq!(fixture.tracked(), "two\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_restore_is_refused_while_a_panel_runs_a_turn() {
    let fixture = Fixture::new().await;
    fixture.session("b", "running").await;
    let failure = fixture
        .revert("a", 1, "full", None)
        .await
        .expect_err("the restore is refused");
    assert!(
        detail(&failure).contains("Another chat in this checkout (Panel, Codex) is running a turn"),
        "{failure}"
    );
    assert!(detail(&failure).contains("rewind only the conversation"));
    assert_eq!(fixture.tracked(), "two\n");
    assert_eq!(fixture.provider.rewinds(), 0);
    let checkpoints = fixture
        .engine
        .repositories()
        .list_checkpoints_by_thread("a".into())
        .await
        .unwrap();
    assert_eq!(checkpoints.len(), 2, "the conversation is unchanged");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_restore_is_refused_while_a_sibling_runs_background_work() {
    let fixture = Fixture::new().await;
    fixture
        .provider
        .writing
        .lock()
        .unwrap()
        .insert("b".into(), WritingReason::BackgroundWork);
    let failure = fixture.revert("a", 1, "full", None).await.unwrap_err();
    assert!(
        detail(&failure).contains("is running background work"),
        "{failure}"
    );
    assert_eq!(fixture.tracked(), "two\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_restore_is_refused_while_a_sibling_checkpoint_is_pending() {
    let fixture = Fixture::new().await;
    fixture
        .engine
        .hold_turns_for_checkpoint("b", "b-turn-1")
        .expect("the effects worker holds ended turns");
    let failure = fixture.revert("a", 1, "full", None).await.unwrap_err();
    assert!(
        detail(&failure).contains("is still saving its checkpoint"),
        "{failure}"
    );
    assert_eq!(fixture.tracked(), "two\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_restore_is_refused_when_a_sibling_session_is_unobservable() {
    let fixture = Fixture::new().await;
    fixture
        .provider
        .writing
        .lock()
        .unwrap()
        .insert("b".into(), WritingReason::Unobservable);
    let failure = fixture.revert("a", 1, "full", None).await.unwrap_err();
    assert!(
        detail(&failure).contains("BiBCode can't tell whether Panel, Codex is still working"),
        "{failure}"
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_idle_sibling_session_is_suspended_before_the_restore() {
    let fixture = Fixture::new().await;
    fixture.revert("a", 1, "full", None).await.unwrap();
    // Made quiet in planning and checked again before the rewind.
    let quieted = fixture.provider.quieted.lock().unwrap().clone();
    assert_eq!(
        quieted.iter().filter(|thread| *thread == "b").count(),
        2,
        "{quieted:?}"
    );
    assert_eq!(fixture.tracked(), "one\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_sibling_that_starts_writing_after_planning_is_caught_before_the_rewind() {
    let fixture = Fixture::new().await;
    let gate = fixture.provider.pause_at(Stage::Prepare);
    let outcome = fixture.request_revert("a", 1, "full", None).await;
    entered(&gate).await;
    fixture
        .provider
        .writing
        .lock()
        .unwrap()
        .insert("b".into(), WritingReason::Turn);
    gate.release.notify_one();
    let failure = outcome.await.unwrap().unwrap_err();
    assert!(detail(&failure).contains("is running a turn"), "{failure}");
    assert_eq!(fixture.provider.rewinds(), 0);
    assert_eq!(fixture.tracked(), "two\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_launch_in_flight_makes_the_restore_refuse() {
    let fixture = Fixture::new().await;
    let launch = fixture.engine.begin_session_launch("b").unwrap();
    let failure = fixture.revert("a", 1, "full", None).await.unwrap_err();
    assert!(
        detail(&failure).contains("is starting its session"),
        "{failure}"
    );
    drop(launch);
    // The reverse order: the restore marks the panel first, and its launch is refused.
    let gate = fixture.provider.pause_at(Stage::Prepare);
    let outcome = fixture.request_revert("a", 1, "full", None).await;
    entered(&gate).await;
    let refused = fixture.engine.begin_session_launch("b").err().unwrap();
    assert!(refused.contains("restoring files"), "{refused}");
    // The restoring thread's own reopen is not held.
    assert!(fixture.engine.begin_session_launch("a").is_ok());
    gate.release.notify_one();
    outcome.await.unwrap().unwrap();
    assert!(fixture.engine.begin_session_launch("b").is_ok());
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_unmanaged_opencode_sibling_refuses_the_restore() {
    let fixture = Fixture::new().await;
    fixture
        .provider
        .writing
        .lock()
        .unwrap()
        .insert("b".into(), WritingReason::UnmanagedServer);
    let failure = fixture.revert("a", 1, "full", None).await.unwrap_err();
    assert!(
        detail(&failure).contains("runs on an OpenCode server BiBCode doesn't manage"),
        "{failure}"
    );
    assert_eq!(fixture.tracked(), "two\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn turn_zero_head_fallback_is_refused_on_a_shared_checkout() {
    let fixture = Fixture::new().await;
    git(
        &fixture.repo,
        &["update-ref", "-d", &checkpoint_ref("a", 0)],
    );
    let failure = fixture.revert("a", 0, "full", None).await.unwrap_err();
    assert!(
        detail(&failure).contains("no starting checkpoint, and other chats share this checkout"),
        "{failure}"
    );
    assert_eq!(fixture.tracked(), "two\n");
    assert!(
        fixture.provider.quieted.lock().unwrap().is_empty(),
        "refused before any sibling is suspended"
    );
    // Rewinding only the conversation still works.
    fixture
        .revert("a", 0, "conversationOnly", None)
        .await
        .unwrap();
    assert_eq!(fixture.tracked(), "two\n");
    fixture.shutdown().await;
}

/// Mauro (#279 Q1): a chat that never started a provider session and has no turns cannot have
/// written a file, so it neither refuses the restore nor needs the token, and it is not
/// suspended. A restore still holds it: its first message waits for the restore.
#[tokio::test]
async fn a_chat_that_never_started_is_not_a_sibling_but_its_first_message_waits() {
    let fixture = Fixture::new().await;
    let linked = fixture.alone().await;
    fixture
        .thread("fresh", "p", "New panel", Some(&linked))
        .await;
    // An edit outside the thread needs no token: nobody else could have written it.
    std::fs::write(linked.join("notes.txt"), "mine\n").unwrap();
    let preview = fixture.preview("z", 1).await;
    assert_eq!(preview["siblingChangesToken"], Value::Null, "{preview}");
    assert_eq!(preview["writingSiblings"], json!([]));
    let gate = fixture.provider.pause_at(Stage::Prepare);
    let (service, mut routes) = delivery(&fixture.engine, Arc::default());
    let outcome = fixture.request_revert("z", 0, "full", None).await;
    entered(&gate).await;
    send_message(&fixture.engine, "fresh", "fresh-first").await;
    service.wake();
    not_delivered(&mut routes).await;
    gate.release.notify_one();
    outcome.await.unwrap().expect("the restore needs no token");
    assert!(
        !fixture
            .provider
            .quieted
            .lock()
            .unwrap()
            .contains(&"fresh".to_owned()),
        "a chat that never started is not suspended"
    );
    delivered(&mut routes, "fresh").await;
    service.shutdown().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn turn_zero_head_fallback_still_works_alone() {
    let fixture = Fixture::new().await;
    let linked = fixture.alone().await;
    git(&linked, &["update-ref", "-d", &checkpoint_ref("z", 0)]);
    fixture.revert("z", 0, "full", None).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(linked.join("tracked.txt")).unwrap(),
        "baseline\n",
        "restored from HEAD"
    );
    fixture.shutdown().await;
}

/// Every path under `dir` except `.git`, with its bytes (`None` for a directory).
fn tree_bytes(dir: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn walk(base: &Path, dir: &Path, into: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let relative = path.strip_prefix(base).unwrap().to_path_buf();
            if relative == Path::new(".git") {
                continue;
            }
            if path.is_dir() {
                into.insert(relative, None);
                walk(base, &path, into);
            } else {
                into.insert(relative, Some(std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut tree = BTreeMap::new();
    walk(dir, dir, &mut tree);
    tree
}

#[tokio::test]
async fn a_conversation_only_rewind_leaves_the_working_tree_unchanged() {
    let fixture = Fixture::new().await;
    let repo = fixture.repo.clone();
    std::fs::write(repo.join(".gitignore"), "ignored.log\n").unwrap();
    std::fs::write(repo.join("ignored.log"), "ignored\n").unwrap();
    std::fs::write(repo.join("untracked.txt"), "untracked\n").unwrap();
    std::fs::write(repo.join("tracked.txt"), "modified\n").unwrap();
    std::fs::create_dir(repo.join("empty")).unwrap();
    let before = tree_bytes(&repo);
    let status = git(&repo, &["status", "--porcelain=v2", "--ignored"]);
    fixture
        .revert("a", 1, "conversationOnly", None)
        .await
        .unwrap();
    assert_eq!(tree_bytes(&repo), before);
    assert_eq!(
        git(&repo, &["status", "--porcelain=v2", "--ignored"]),
        status
    );
    assert_eq!(fixture.provider.rewinds(), 1, "the provider rewound");
    let checkpoints = fixture
        .engine
        .repositories()
        .list_checkpoints_by_thread("a".into())
        .await
        .unwrap();
    assert_eq!(
        checkpoints
            .iter()
            .map(|checkpoint| checkpoint.checkpoint_turn_count)
            .collect::<Vec<_>>(),
        [1],
        "the newer turn is gone"
    );
    let refs = git(&repo, &["for-each-ref", "--format=%(refname)"]);
    assert!(
        !refs.contains(&checkpoint_ref("a", 2)),
        "the newer ref is deleted"
    );
    assert!(
        refs.contains(&checkpoint_ref("a", 1)),
        "the target ref is kept"
    );
    let snapshot = crate::orchestration::load_snapshot(&fixture.engine.repositories())
        .await
        .unwrap();
    assert!(snapshot.activities.iter().any(|activity| activity.kind
        == "checkpoint.revert.conversation-only"
        && activity.summary == "Conversation rewound, files kept"));
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_conversation_only_rewind_runs_while_a_sibling_is_busy() {
    let fixture = Fixture::new().await;
    fixture.session("b", "running").await;
    fixture
        .revert("a", 1, "conversationOnly", None)
        .await
        .unwrap();
    assert_eq!(fixture.tracked(), "two\n");
    assert_eq!(fixture.provider.rewinds(), 1);
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_conversation_only_rewind_is_refused_for_a_files_only_provider() {
    let fixture = Fixture::new().await;
    *fixture.provider.rewind_support.lock().unwrap() =
        Some(ConversationRewind::FilesOnlyProvider {
            provider_label: "Claude".into(),
        });
    let failure = fixture
        .revert("a", 1, "conversationOnly", None)
        .await
        .unwrap_err();
    assert!(
        detail(&failure)
            .contains("Claude can't rewind its conversation, so only a file restore is possible."),
        "{failure}"
    );
    assert_eq!(fixture.provider.rewinds(), 0);
    assert_eq!(fixture.tracked(), "two\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_conversation_only_rewind_is_refused_for_opencode_1() {
    let fixture = Fixture::new().await;
    *fixture.provider.rewind_support.lock().unwrap() =
        Some(ConversationRewind::RewindRestoresFiles {
            provider_label: "OpenCode 1".into(),
        });
    let failure = fixture
        .revert("a", 1, "conversationOnly", None)
        .await
        .unwrap_err();
    assert!(
        detail(&failure)
            .contains("OpenCode 1 can't rewind its conversation without restoring files"),
        "{failure}"
    );
    assert_eq!(fixture.provider.rewinds(), 0, "no rewind request is sent");
    fixture.shutdown().await;
}

#[test]
fn only_codex_and_opencode_2_rewind_without_touching_files() {
    assert!(crate::provider::rewind_keeps_files("codex", 1));
    assert!(crate::provider::rewind_keeps_files("opencode", 2));
    assert!(!crate::provider::rewind_keeps_files("opencode", 1));
    for provider in ["claude", "claudeAgent", "cursor", "grok"] {
        assert!(
            !crate::provider::rewind_keeps_files(provider, 2),
            "{provider}"
        );
    }
}

#[tokio::test]
async fn sibling_changes_need_the_matching_token() {
    let fixture = Fixture::new().await;
    // The panel's turn after the host's turn 1 edited `x`.
    fixture
        .diff_complete("b", 1, &["x"], "2026-08-01T00:00:01.500Z")
        .await;
    let failure = fixture.revert("a", 1, "full", None).await.unwrap_err();
    assert!(
        detail(&failure)
            .contains("Files in this checkout changed since turn 1, outside this chat."),
        "{failure}"
    );
    let token = failure["siblingChangesToken"].as_str().unwrap().to_owned();
    assert_eq!(
        fixture.preview("a", 1).await["siblingChangesToken"],
        json!(token)
    );
    // A sibling turn finishing after the preview changes the token.
    fixture
        .diff_complete("b", 2, &["y"], "2026-08-01T00:00:01.700Z")
        .await;
    let failure = fixture
        .revert("a", 1, "full", Some(&token))
        .await
        .unwrap_err();
    let fresh = failure["siblingChangesToken"].as_str().unwrap().to_owned();
    assert_ne!(fresh, token);
    assert_eq!(fixture.tracked(), "two\n");
    fixture.revert("a", 1, "full", Some(&fresh)).await.unwrap();
    assert_eq!(fixture.tracked(), "one\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_sibling_conversation_only_rewind_keeps_its_changes_in_the_warning() {
    for delete_instead in [false, true] {
        let fixture = Fixture::new().await;
        fixture.checkpoints("b", &[]).await;
        fixture
            .diff_complete("b", 1, &["x"], "2026-08-01T00:00:01.500Z")
            .await;
        if delete_instead {
            fixture.engine.dispatch(command(json!({"type":"thread.delete", "commandId":"delete-b", "threadId":"b", "createdAt":T3}))).await.unwrap();
        } else {
            fixture.session("b", "ready").await;
            fixture
                .revert("b", 0, "conversationOnly", None)
                .await
                .unwrap();
        }
        let failure = fixture.revert("a", 1, "full", None).await.unwrap_err();
        assert!(
            detail(&failure).contains("changed since turn 1"),
            "{failure}"
        );
        let preview = fixture.preview("a", 1).await;
        let turns = preview["siblingChanges"]["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 1, "{preview}");
        assert_eq!(turns[0]["files"], json!(["x"]));
        fixture.shutdown().await;
    }
}

#[tokio::test]
async fn a_terminal_edit_since_the_last_turn_is_listed() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.repo.join("notes.txt"), "from a terminal\n").unwrap();
    let preview = fixture.preview("a", 1).await;
    assert_eq!(preview["siblingChanges"]["paths"], json!(["notes.txt"]));
    let restored = preview["restoredPaths"].as_array().unwrap();
    assert!(restored.contains(&json!("notes.txt")) && restored.contains(&json!("tracked.txt")));
    assert!(fixture.revert("a", 1, "full", None).await.is_err());
    fixture.shutdown().await;
}

#[tokio::test]
async fn an_edit_absorbed_into_a_later_checkpoint_is_listed_as_restored() {
    let fixture = Fixture::new().await;
    // An editor changes `x` after turn 2, and the host's turn 3 captures it.
    std::fs::write(fixture.repo.join("x"), "editor\n").unwrap();
    capture_checkpoint(&fixture.repo, "a", 3).await.unwrap();
    fixture.diff_complete("a", 3, &[], T3).await;
    let preview = fixture.preview("a", 1).await;
    assert!(
        preview["restoredPaths"]
            .as_array()
            .unwrap()
            .contains(&json!("x")),
        "{preview}"
    );
    assert_eq!(preview["siblingChanges"]["paths"], json!([]));
    assert_eq!(preview["siblingChanges"]["turns"], json!([]));
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_content_change_with_the_same_paths_changes_the_token() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.repo.join("notes.txt"), "first\n").unwrap();
    let first = fixture.preview("a", 1).await;
    std::fs::write(fixture.repo.join("notes.txt"), "second\n").unwrap();
    let second = fixture.preview("a", 1).await;
    assert_eq!(
        first["siblingChanges"]["paths"],
        second["siblingChanges"]["paths"]
    );
    assert_ne!(first["siblingChangesToken"], second["siblingChangesToken"]);
    fixture.shutdown().await;
}

#[tokio::test]
async fn a_change_after_confirming_is_caught_before_the_rewind() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.repo.join("notes.txt"), "confirmed\n").unwrap();
    let token = fixture.preview("a", 1).await["siblingChangesToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let gate = fixture.provider.pause_at(Stage::Prepare);
    let outcome = fixture.request_revert("a", 1, "full", Some(&token)).await;
    entered(&gate).await;
    std::fs::write(fixture.repo.join("notes.txt"), "changed after\n").unwrap();
    gate.release.notify_one();
    let failure = outcome.await.unwrap().unwrap_err();
    assert!(
        detail(&failure).contains("Files in this checkout changed after you confirmed."),
        "{failure}"
    );
    assert_ne!(failure["siblingChangesToken"], json!(token));
    assert_eq!(
        fixture.provider.rewinds(),
        0,
        "the provider was not rewound"
    );
    assert_eq!(fixture.tracked(), "two\n");
    fixture.shutdown().await;
}

#[tokio::test]
async fn preview_reports_writing_siblings_changes_and_rewind_support() {
    let fixture = Fixture::new().await;
    fixture.session("b", "running").await;
    *fixture.provider.rewind_support.lock().unwrap() =
        Some(ConversationRewind::RewindRestoresFiles {
            provider_label: "OpenCode 1".into(),
        });
    let preview = fixture.preview("a", 1).await;
    assert_eq!(
        preview["writingSiblings"],
        json!([{"threadId":"b", "title":"Panel, Codex", "reason":"turn"}])
    );
    assert_eq!(preview["restoredPaths"], json!(["tracked.txt"]));
    assert_eq!(preview["conversationRewind"], json!("rewindRestoresFiles"));
    assert_eq!(preview["headFallbackRefused"], json!(false));
    assert!(preview["siblingChangesToken"].is_string());
    // Alone in its checkout, nothing is shared.
    fixture.alone().await;
    let alone = fixture.preview("z", 1).await;
    assert_eq!(alone["writingSiblings"], json!([]));
    assert_eq!(alone["siblingChangesToken"], Value::Null);
    fixture.shutdown().await;
}
