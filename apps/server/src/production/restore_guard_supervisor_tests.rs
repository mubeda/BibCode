//! The supervisor's side of the shared-checkout restore guard (#279): how it reads, suspends
//! and refuses to relaunch the sessions of other chats in a restoring checkout.

use super::*;
use crate::{
    orchestration::EngineOptions,
    persistence::{Database, run_migrations},
    production::{
        orchestration_effects::{ConversationRewind, RevertProbe, WritingReason},
        worktree_runtime::removal_test_support::{self, RemovalTestDriver},
    },
    server_settings::{ProviderInstanceState, ProviderSettingsState},
};

const TIME: &str = "2026-11-07T00:00:00Z";

struct Fixture {
    _root: tempfile::TempDir,
    cwd: PathBuf,
    settings_root: PathBuf,
    engine: OrchestrationEngine,
    driver: Arc<RemovalTestDriver>,
    supervisor: Arc<ProviderRuntimeSupervisor>,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_factory(None).await
    }

    async fn with_factory(factory: Option<Arc<dyn ProviderDriverFactory>>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().to_path_buf();
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
        engine.dispatch(serde_json::from_value(json!({"type":"project.create", "commandId":"project", "projectId":"p1", "title":"Project", "workspaceRoot":cwd, "createdAt":TIME})).unwrap()).await.unwrap();
        for (thread, instance) in [
            ("t1", "codex"),
            ("external", "opencode-external"),
            ("owned", "opencode-owned"),
            ("files", "claudeAgent"),
        ] {
            engine.dispatch(serde_json::from_value(json!({"type":"thread.create", "commandId":format!("thread-{thread}"), "threadId":thread, "projectId":"p1", "title":thread, "kind":"workspace", "modelSelection":{"instanceId":instance, "model":"m"}, "runtimeMode":"full-access", "interactionMode":"default", "branch":null, "worktreePath":null, "createdAt":TIME})).unwrap()).await.unwrap();
        }
        let settings_root = cwd.join("settings");
        std::fs::create_dir(&settings_root).unwrap();
        let mut settings = ProviderSettingsState::default();
        for (instance, config) in [
            ("opencode-external", json!({"serverUrl":"http://127.0.0.1:4773"})),
            ("opencode-owned", json!({})),
        ] {
            settings.provider_instances.insert(
                instance.to_owned(),
                ProviderInstanceState {
                    driver: "opencode".to_owned(),
                    enabled: true,
                    display_name: None,
                    environment: Vec::new(),
                    config,
                },
            );
        }
        std::fs::write(
            settings_root.join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        let driver = Arc::new(RemovalTestDriver::default());
        let supervisor = match factory {
            Some(factory) => Arc::new(ProviderRuntimeSupervisor::start(
                engine.clone(),
                factory,
                ActivityProjection::new(crate::activity::ActivityRepository::new(
                    engine.repositories().database().clone(),
                )),
                SupervisorOptions::default(),
            )),
            None => removal_test_support::supervisor(&engine, driver.clone()),
        };
        Self {
            _root: root,
            cwd,
            settings_root,
            engine,
            driver,
            supervisor,
        }
    }

    fn launch(&self, thread: &str, provider: &str, endpoint: Option<&str>) -> ProviderLaunchRequest {
        let mut request = removal_test_support::launch(thread, self.cwd.clone());
        request.provider = provider.to_owned();
        request.endpoint = endpoint.map(str::to_owned);
        request
    }

    fn probe(&self) -> SupervisorRevertProbe<'_> {
        SupervisorRevertProbe {
            supervisor: &self.supervisor,
            settings_root: &self.settings_root,
            engine: &self.engine,
        }
    }
}

#[tokio::test]
async fn an_idle_sibling_session_is_suspended_and_no_path_reopens_it_during_the_restore() {
    let fixture = Fixture::new().await;
    fixture
        .supervisor
        .launch(fixture.launch("t1", "claude", None))
        .await
        .unwrap();
    assert_eq!(fixture.probe().quiet_sibling("t1").await.unwrap(), None);
    assert_eq!(fixture.driver.shutdowns.load(Ordering::SeqCst), 1);
    assert!(
        fixture
            .supervisor
            .capture_session_identity("t1")
            .await
            .unwrap()
            .is_none(),
        "the session is suspended, so nothing it runs can start a turn"
    );
    let runtime = fixture
        .engine
        .repositories()
        .get_provider_session_runtime("t1".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime.status, "suspended");
    // While a restore holds it, every reopen fails at the one launch point: delivery, a
    // conversation-only rewind, compaction and reconciliation all launch through it.
    let mut restore = fixture.engine.hold_checkout_for_restore("checkout").await;
    restore.hold_threads(&["t1".to_owned()]).unwrap();
    for context_handoff in [false, true] {
        let error = fixture
            .supervisor
            .launch_with_context_handoff(fixture.launch("t1", "claude", None), context_handoff, None, false)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("Another chat in this checkout is restoring files"),
            "{error}"
        );
    }
    drop(restore);
    fixture
        .supervisor
        .launch(fixture.launch("t1", "claude", None))
        .await
        .expect("the session reopens once the restore ends");
}

#[tokio::test]
async fn a_running_sibling_session_writes_and_is_not_suspended() {
    let fixture = Fixture::new().await;
    fixture
        .supervisor
        .launch(fixture.launch("t1", "claude", None))
        .await
        .unwrap();
    fixture.engine.dispatch(serde_json::from_value(json!({"type":"thread.session.set", "commandId":"running", "threadId":"t1", "session":{"threadId":"t1", "status":"running", "providerName":"claude", "activeTurnId":"turn", "lastError":null, "updatedAt":TIME}, "createdAt":TIME})).unwrap()).await.unwrap();
    assert_eq!(
        fixture.probe().quiet_sibling("t1").await.unwrap(),
        Some(WritingReason::Turn)
    );
    assert_eq!(fixture.driver.shutdowns.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_restore_is_refused_when_a_sibling_session_is_unobservable() {
    let fixture = Fixture::new().await;
    // Codex reports its background work only through Chat Activity, which is off here.
    fixture
        .supervisor
        .launch(fixture.launch("t1", "codex", None))
        .await
        .unwrap();
    assert_eq!(
        fixture.probe().quiet_sibling("t1").await.unwrap(),
        Some(WritingReason::Unobservable)
    );
    assert_eq!(fixture.driver.shutdowns.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_unmanaged_opencode_sibling_refuses_live_and_suspended() {
    let fixture = Fixture::new().await;
    fixture
        .supervisor
        .launch(fixture.launch("external", "opencode", Some("http://127.0.0.1:4773")))
        .await
        .unwrap();
    assert_eq!(
        fixture.probe().quiet_sibling("external").await.unwrap(),
        Some(WritingReason::UnmanagedServer)
    );
    fixture
        .supervisor
        .stop_session_if_current(
            fixture
                .supervisor
                .capture_session_identity("external")
                .await
                .unwrap()
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.probe().quiet_sibling("external").await.unwrap(),
        Some(WritingReason::UnmanagedServer),
        "a suspended session on an external server may still be working there"
    );
    // A session on a server BiBCode started has no live session here and is quiet.
    assert_eq!(fixture.probe().quiet_sibling("owned").await.unwrap(), None);
}

#[tokio::test]
async fn the_conversation_rewind_answer_follows_the_provider_and_its_api() {
    let fixture = Fixture::new().await;
    assert!(matches!(
        fixture.probe().conversation_rewind("files").await.unwrap(),
        ConversationRewind::FilesOnlyProvider { .. }
    ));
    // A suspended OpenCode session's API version is not known before its reopen.
    assert_eq!(
        fixture.probe().conversation_rewind("owned").await.unwrap(),
        ConversationRewind::Available
    );
    // The test driver speaks API 1, as OpenCode 1 does.
    fixture
        .supervisor
        .launch(fixture.launch("owned", "opencode", None))
        .await
        .unwrap();
    assert!(matches!(
        fixture.probe().conversation_rewind("owned").await.unwrap(),
        ConversationRewind::RewindRestoresFiles { .. }
    ));
    assert_eq!(
        fixture.probe().conversation_rewind("t1").await.unwrap(),
        ConversationRewind::Available
    );
}

/// A factory that holds every driver creation until released, as a slow provider start does.
struct PausingFactory {
    inner: Arc<RemovalTestDriver>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

impl ProviderDriverFactory for PausingFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            self.inner.create(request).await
        })
    }
}

#[tokio::test]
async fn a_launch_in_flight_makes_the_restore_refuse() {
    let (entered, release) = (
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
    );
    let fixture = Fixture::with_factory(Some(Arc::new(PausingFactory {
        inner: Arc::new(RemovalTestDriver::default()),
        entered: entered.clone(),
        release: release.clone(),
    })))
    .await;
    let supervisor = fixture.supervisor.clone();
    let request = fixture.launch("t1", "claude", None);
    let launch = tokio::spawn(async move { supervisor.launch(request).await });
    tokio::time::timeout(Duration::from_secs(30), entered.notified())
        .await
        .unwrap();
    let mut restore = fixture.engine.hold_checkout_for_restore("checkout").await;
    assert_eq!(
        restore.hold_threads(&["t1".to_owned()]),
        Err(crate::orchestration::engine::RestoreHoldConflict::Launching(
            "t1".to_owned()
        ))
    );
    release.notify_one();
    launch.await.unwrap().unwrap();
    assert!(restore.hold_threads(&["t1".to_owned()]).is_ok());
}
