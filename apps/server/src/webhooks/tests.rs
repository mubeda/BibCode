//! The dispatcher end to end, against a local HTTPS receiver behind the test certificate
//! authority, with an injected resolver: no test reaches the network.

use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::{
    Webhooks, WebhooksConfig,
    delivery::{Failure, Fixture, Headers, NetPolicy, send},
    events, signing, store,
};
use crate::{
    auth::SecretStore,
    diagnostics::profiler::reader::Reader,
    git::clone_policy::{HostResolver, ResolveFuture, tests::resolver},
    mcp::control::{McpCapabilities, McpServerSettings},
    persistence::{Database, NewOrchestrationEvent, Repositories},
    test_support::tls_fixture::{TestCertificates, tls_proxy},
};

const MARKER: &str = "PROMPT-MARKER-never-in-a-payload";
const FAST_RETRIES: [Duration; 5] = [Duration::from_millis(40); 5];

/// What the receiver answers next.
#[derive(Clone, Copy, Debug)]
enum Reply {
    Status(u16),
    /// Never answers: the request stays in flight until the client drops it.
    Hang,
    /// Answers 200 after this many milliseconds.
    Delay(u64),
}

#[derive(Clone, Debug)]
struct Received {
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Received {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("a JSON body")
    }

    fn header(&self, name: &str) -> &str {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
            .unwrap_or_default()
    }
}

#[derive(Clone, Default)]
struct ReceiverState {
    received: Arc<Mutex<Vec<Received>>>,
    script: Arc<Mutex<VecDeque<Reply>>>,
    /// The reply once the script is spent.
    default: Arc<Mutex<Option<Reply>>>,
    hung: Arc<AtomicUsize>,
    /// Requests being answered now, and the most there ever were at once.
    open: Arc<AtomicUsize>,
    most_open: Arc<AtomicUsize>,
}

/// A local HTTPS receiver at `https://localhost:<port>/hook`.
struct Receiver {
    url: String,
    state: ReceiverState,
    certificates: TestCertificates,
}

async fn handle(
    State(state): State<ReceiverState>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let open = state.open.fetch_add(1, Ordering::SeqCst) + 1;
    state.most_open.fetch_max(open, Ordering::SeqCst);
    let status = answer(&state, uri.path().to_owned(), headers, body).await;
    state.open.fetch_sub(1, Ordering::SeqCst);
    status
}

async fn answer(
    state: &ReceiverState,
    path: String,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    state.received.lock().unwrap().push(Received {
        path,
        headers: headers
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect(),
        body: body.to_vec(),
    });
    let reply = state
        .script
        .lock()
        .unwrap()
        .pop_front()
        .or(*state.default.lock().unwrap())
        .unwrap_or(Reply::Status(200));
    match reply {
        Reply::Status(status) => StatusCode::from_u16(status).unwrap(),
        Reply::Hang => {
            state.hung.fetch_add(1, Ordering::SeqCst);
            std::future::pending::<()>().await;
            StatusCode::OK
        }
        Reply::Delay(ms) => {
            state.hung.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(ms)).await;
            StatusCode::OK
        }
    }
}

impl Receiver {
    async fn start() -> Self {
        let state = ReceiverState::default();
        let app = Router::new().fallback(handle).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let certificates = TestCertificates::generate();
        let proxy = tls_proxy(&certificates, upstream).await;
        Self {
            url: format!("https://localhost:{}/hook", proxy.port()),
            state,
            certificates,
        }
    }

    fn script(&self, replies: &[Reply]) {
        self.state.script.lock().unwrap().extend(replies);
    }

    fn answer_by_default(&self, reply: Reply) {
        *self.state.default.lock().unwrap() = Some(reply);
    }

    fn received(&self) -> Vec<Received> {
        self.state.received.lock().unwrap().clone()
    }

    fn policy(&self, resolver: Arc<dyn HostResolver>) -> NetPolicy {
        NetPolicy::with_fixture(
            resolver,
            Fixture {
                roots: vec![
                    reqwest::Certificate::from_der(self.certificates.authority.as_ref()).unwrap(),
                ],
                admit_loopback: true,
            },
        )
    }
}

async fn eventually(what: &str, mut check: impl AsyncFnMut() -> bool) {
    for _ in 0..250 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

/// The dispatcher's timing and queue size for one test.
#[derive(Clone)]
struct Timing {
    retry_delays: Vec<Duration>,
    poll: Duration,
    max_pending: i64,
    /// Holds the first dispatcher's start (a restart starts unpaused).
    start_pause: Option<Arc<super::Pause>>,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            retry_delays: FAST_RETRIES.to_vec(),
            poll: Duration::from_millis(30),
            max_pending: store::MAX_PENDING,
            start_pause: None,
        }
    }
}

struct Harness {
    timing: Timing,
    webhooks: Webhooks,
    database: Database,
    repositories: Repositories,
    enabled: watch::Sender<bool>,
    mcp: watch::Sender<McpServerSettings>,
    secrets_dir: tempfile::TempDir,
    profiler_dir: tempfile::TempDir,
    receiver: Receiver,
    resolver: Arc<dyn HostResolver>,
}

impl Harness {
    async fn new() -> Self {
        Self::new_with_findings(&[]).await
    }

    async fn new_with_findings(findings: &[(&str, u64, &str)]) -> Self {
        Self::new_full(findings, Timing::default()).await
    }

    async fn new_timed(timing: Timing) -> Self {
        Self::new_full(&[], timing).await
    }

    /// A harness whose findings book already holds `findings` when the dispatcher starts.
    async fn new_full(findings: &[(&str, u64, &str)], timing: Timing) -> Self {
        Self::new_with_receiver(findings, timing, Receiver::start().await).await
    }

    /// Queue-only finding audits need no listening socket or HTTP sender.
    async fn new_for_findings(findings: &[(&str, u64, &str)]) -> Self {
        let receiver = Receiver {
            url: "https://localhost/hook".to_owned(),
            state: ReceiverState::default(),
            certificates: TestCertificates::generate(),
        };
        let harness = Self::new_with_receiver(findings, Timing::default(), receiver).await;
        harness.webhooks.shutdown().await;
        harness
    }

    async fn new_with_receiver(
        findings: &[(&str, u64, &str)],
        timing: Timing,
        receiver: Receiver,
    ) -> Self {
        let database = Database::open_in_memory().await.unwrap();
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let resolver = resolver(&[("localhost", "127.0.0.1")]);
        let profiler_dir = tempfile::tempdir().unwrap();
        if !findings.is_empty() {
            write_file(
                &profiler_dir.path().join("findings.ndjson"),
                &findings_text(findings),
            );
        }
        Self::with(
            database,
            receiver,
            resolver,
            tempfile::tempdir().unwrap(),
            profiler_dir,
            timing,
        )
        .await
    }

    async fn with(
        database: Database,
        receiver: Receiver,
        resolver: Arc<dyn HostResolver>,
        secrets_dir: tempfile::TempDir,
        profiler_dir: tempfile::TempDir,
        mut timing: Timing,
    ) -> Self {
        let repositories = Repositories::new(database.clone());
        let (enabled, enabled_rx) = watch::channel(true);
        let (mcp, mcp_rx) = watch::channel(McpServerSettings::default());
        let directory = profiler_dir.path().to_path_buf();
        let webhooks = Webhooks::start(WebhooksConfig {
            database: database.clone(),
            repositories: repositories.clone(),
            secrets: SecretStore::new(secrets_dir.path()).await.unwrap(),
            environment_id: "env-test".to_owned(),
            enabled: enabled_rx,
            mcp: mcp_rx,
            findings: Arc::new(move || Some(Reader::new(directory.clone()))),
            net: receiver.policy(resolver.clone()),
            retry_delays: timing.retry_delays.clone(),
            poll: timing.poll,
            max_pending: timing.max_pending,
            start_pause: timing.start_pause.take(),
        });
        Self {
            timing,
            webhooks,
            database,
            repositories,
            enabled,
            mcp,
            secrets_dir,
            profiler_dir,
            receiver,
            resolver,
        }
    }

    /// Stops this dispatcher and starts another on the same store: a restart.
    async fn restart(self) -> Self {
        self.webhooks.shutdown().await;
        let enabled = *self.enabled.borrow();
        let next = Self::with(
            self.database,
            self.receiver,
            self.resolver,
            self.secrets_dir,
            self.profiler_dir,
            self.timing,
        )
        .await;
        next.enabled.send_replace(enabled);
        next
    }

    async fn call(&self, method: &str, payload: Value) -> Result<Value, Value> {
        match method {
            "list" => self.webhooks.list(payload).await,
            "listDeliveries" => self.webhooks.list_deliveries(payload).await,
            "upsert" => self.webhooks.upsert(payload).await,
            "delete" => self.webhooks.delete(payload).await,
            "rotateSecret" => self.webhooks.rotate_secret(payload).await,
            "sendTest" => self.webhooks.send_test(payload).await,
            "redeliver" => self.webhooks.redeliver(payload).await,
            _ => unreachable!(),
        }
    }

    /// A new endpoint at the receiver for `events`; returns its id and secret.
    async fn endpoint(&self, events: &[&str]) -> (String, String) {
        self.endpoint_at(&self.receiver.url.clone(), events).await
    }

    async fn endpoint_at(&self, url: &str, events: &[&str]) -> (String, String) {
        let created = self
            .call(
                "upsert",
                json!({ "name": "CI", "url": url, "enabled": true, "eventTypes": events }),
            )
            .await
            .expect("an endpoint");
        (
            created["endpoint"]["id"].as_str().unwrap().to_owned(),
            created["secret"].as_str().unwrap().to_owned(),
        )
    }

    /// A new endpoint at `url` for `events` that sends `token`; returns its id and secret.
    async fn endpoint_with_token(
        &self,
        url: &str,
        events: &[&str],
        token: &str,
    ) -> (String, String) {
        let created = self
            .call(
                "upsert",
                json!({ "name": "CI", "url": url, "enabled": true, "eventTypes": events, "bearerToken": token }),
            )
            .await
            .expect("an endpoint");
        (
            created["endpoint"]["id"].as_str().unwrap().to_owned(),
            created["secret"].as_str().unwrap().to_owned(),
        )
    }

    /// An upsert of endpoint `id` at the receiver for `thread.status_changed`, with `extra`
    /// fields set over that.
    async fn edit(&self, id: &str, extra: Value) -> Result<Value, Value> {
        let mut payload = json!({ "id": id, "name": "CI", "url": self.receiver.url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED] });
        for (key, value) in extra.as_object().unwrap() {
            payload[key] = value.clone();
        }
        self.call("upsert", payload).await
    }

    /// The endpoint's bearer token files in the secret store.
    async fn bearer_files(&self, id: &str) -> Vec<String> {
        let prefix = super::bearer_prefix(id);
        SecretStore::new(self.secrets_dir.path())
            .await
            .unwrap()
            .names()
            .await
            .unwrap()
            .into_iter()
            .filter(|name| name.starts_with(&prefix))
            .collect()
    }

    /// The bearer token file the endpoint's row names.
    async fn bearer_secret(&self, id: &str) -> Option<String> {
        self.webhooks
            .store()
            .endpoint(id)
            .await
            .unwrap()
            .unwrap()
            .bearer_secret
    }

    async fn deliveries(&self, endpoint: &str) -> Vec<Value> {
        self.call(
            "listDeliveries",
            json!({ "endpointId": endpoint, "limit": 200 }),
        )
        .await
        .unwrap()["deliveries"]
            .as_array()
            .unwrap()
            .clone()
    }

    async fn event(&self, event_type: &str, thread: &str, payload: Value) {
        self.repositories
            .append_event(NewOrchestrationEvent {
                event_id: uuid::Uuid::new_v4().to_string(),
                event_type: event_type.to_owned(),
                aggregate_kind: "thread".to_owned(),
                aggregate_id: thread.to_owned(),
                occurred_at: crate::mcp::control::now_iso(),
                command_id: None,
                causation_event_id: None,
                correlation_id: None,
                payload,
                metadata: json!({}),
            })
            .await
            .unwrap();
    }

    /// A turn starting and completing on `thread`, with a message carrying the marker.
    async fn turn(&self, thread: &str, turn: &str) {
        self.event(
            "thread.message-sent",
            thread,
            json!({ "threadId": thread, "text": MARKER }),
        )
        .await;
        self.event(
            "thread.session-set",
            thread,
            json!({ "threadId": thread, "session": { "status": "running", "activeTurnId": turn, "lastError": MARKER } }),
        )
        .await;
        self.event(
            "thread.session-set",
            thread,
            json!({ "threadId": thread, "session": { "status": "ready", "activeTurnId": null } }),
        )
        .await;
    }

    async fn approval(&self, thread: &str, request: &str) {
        self.event(
            "thread.activity-appended",
            thread,
            json!({ "threadId": thread, "activity": { "kind": "approval.requested", "summary": MARKER, "payload": { "requestId": request, "command": MARKER } } }),
        )
        .await;
    }

    fn write_findings(&self, findings: &[(&str, u64, &str)]) {
        write_file(
            &self.profiler_dir.path().join("findings.ndjson"),
            &findings_text(findings),
        );
    }
}

fn findings_text(findings: &[(&str, u64, &str)]) -> String {
    findings
        .iter()
        .map(|(id, count, last_seen)| {
            format!(
                "{}\n",
                json!({
                    "id": id, "fingerprint": id, "kind": "rpc.slow", "severity": "warn",
                    "firstSeen": "2026-10-31T09:00:00Z", "lastSeen": last_seen, "count": count,
                    "source": "server", "title": MARKER, "summary": MARKER, "state": "open",
                    "evidence": { "message": MARKER },
                })
            )
        })
        .collect()
}

fn write_file(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
}

async fn wait_for_requests(receiver: &Receiver, count: usize) -> Vec<Received> {
    eventually(&format!("{count} requests"), async || {
        receiver.received().len() >= count
    })
    .await;
    receiver.received()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_signed_delivery_verifies_with_the_secret_over_its_timestamp_and_holds_no_text() {
    let harness = Harness::new().await;
    let (endpoint, secret) = harness
        .endpoint(&[events::THREAD_STATUS_CHANGED, events::APPROVAL_REQUESTED])
        .await;
    // The dispatcher starts from now: give it a pass to take the feed's head.
    eventually("the feed position", async || {
        harness
            .webhooks
            .store()
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    harness.turn("thread-1", "turn-1").await;
    harness.approval("thread-1", "req-1").await;

    let received = wait_for_requests(&harness.receiver, 3).await;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let mut types = Vec::new();
    let mut cursors = Vec::new();
    for request in &received {
        assert!(signing::verify(
            &secret,
            request.header("X-BibCode-Timestamp"),
            &request.body,
            request.header("X-BibCode-Signature"),
            now,
            300,
        ));
        // The signature is over this endpoint's secret only.
        assert!(!signing::verify(
            "whsec_other",
            request.header("X-BibCode-Timestamp"),
            &request.body,
            request.header("X-BibCode-Signature"),
            now,
            300,
        ));
        let body = request.json();
        assert_eq!(request.header("X-BibCode-Event"), body["type"]);
        assert!(!request.header("X-BibCode-Delivery").is_empty());
        assert_eq!(body["environmentId"], "env-test");
        assert_eq!(body["threadId"], "thread-1");
        let text = String::from_utf8_lossy(&request.body);
        assert!(!text.contains(MARKER), "{text}");
        types.push(body["type"].as_str().unwrap().to_owned());
        cursors.push(body["cursor"].as_str().unwrap().to_owned());
    }
    assert_eq!(
        types,
        [
            events::THREAD_STATUS_CHANGED,
            events::THREAD_STATUS_CHANGED,
            events::APPROVAL_REQUESTED
        ]
    );
    assert_eq!(received[0].json()["kind"], "turn.started");
    assert_eq!(received[1].json()["kind"], "turn.completed");
    assert_eq!(received[2].json()["requestId"], "req-1");
    // The cursors are X3's: each one resumes `changes_since` right after its entry.
    let after_first =
        crate::mcp::tools::feed::page_after(&harness.repositories, &cursors[0], None, 100)
            .await
            .unwrap();
    assert_eq!(
        after_first
            .entries
            .iter()
            .map(|entry| entry["cursor"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        cursors[1..]
    );
    // The receiver answers before the dispatcher records the outcome.
    eventually("every delivery recorded as delivered", async || {
        harness
            .deliveries(&endpoint)
            .await
            .iter()
            .all(|delivery| delivery["state"] == "delivered")
    })
    .await;
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_follow_the_schedule_on_500_and_stop_on_400() {
    let harness = Harness::new().await;
    harness.receiver.answer_by_default(Reply::Status(500));
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    eventually("the feed position", async || {
        harness
            .webhooks
            .store()
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "error", "activeTurnId": null } }),
        )
        .await;
    // The first send and one retry per delay, then failed.
    let received = wait_for_requests(&harness.receiver, 1 + FAST_RETRIES.len()).await;
    eventually("the delivery to fail", async || {
        harness.deliveries(&endpoint).await[0]["state"] == "failed"
    })
    .await;
    let delivery = &harness.deliveries(&endpoint).await[0];
    assert_eq!(delivery["attempts"], 1 + FAST_RETRIES.len());
    assert_eq!(delivery["lastStatus"], 500);
    assert_eq!(delivery["lastError"], "status");
    // Each retry re-signs the same event under a fresh timestamp.
    assert!(
        received
            .iter()
            .all(|request| request.json()["id"] == received[0].json()["id"])
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(harness.receiver.received().len(), 1 + FAST_RETRIES.len());

    // A 400 is not tried again.
    harness.receiver.answer_by_default(Reply::Status(400));
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "idle", "activeTurnId": null } }),
        )
        .await;
    wait_for_requests(&harness.receiver, 2 + FAST_RETRIES.len()).await;
    eventually("the 400 to fail", async || {
        harness.deliveries(&endpoint).await[0]["state"] == "failed"
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(harness.receiver.received().len(), 2 + FAST_RETRIES.len());
    assert_eq!(harness.deliveries(&endpoint).await[0]["attempts"], 1);
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ten_failed_deliveries_in_a_row_disable_the_endpoint() {
    let harness = Harness::new().await;
    harness.receiver.answer_by_default(Reply::Status(410));
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    eventually("the feed position", async || {
        harness
            .webhooks
            .store()
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    for index in 0..12 {
        let status = if index % 2 == 0 { "idle" } else { "ready" };
        harness
            .event(
                "thread.session-set",
                "thread-1",
                json!({ "session": { "status": status, "activeTurnId": null } }),
            )
            .await;
    }
    eventually("the endpoint to be disabled", async || {
        let listed = harness.call("list", json!({})).await.unwrap();
        listed["endpoints"][0]["enabled"] == false
    })
    .await;
    let listed = harness.call("list", json!({})).await.unwrap();
    assert_eq!(listed["endpoints"][0]["disabledReason"], "failures");
    assert_eq!(listed["endpoints"][0]["consecutiveFailures"], 10);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(harness.receiver.received().len(), 10);
    // Re-enabling clears the count.
    let reenabled = harness
        .call(
            "upsert",
            json!({ "id": endpoint, "name": "CI", "url": harness.receiver.url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED] }),
        )
        .await
        .unwrap();
    assert_eq!(reenabled["endpoint"]["consecutiveFailures"], 0);
    assert_eq!(reenabled["endpoint"]["disabledReason"], Value::Null);
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_queue_and_the_feed_position_resume_after_a_restart() {
    let harness = Harness::new().await;
    harness.receiver.answer_by_default(Reply::Status(503));
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    eventually("the feed position", async || {
        harness
            .webhooks
            .store()
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    harness.turn("thread-1", "turn-1").await;
    wait_for_requests(&harness.receiver, 1).await;
    harness.webhooks.shutdown().await;
    // Written while no dispatcher runs.
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "idle", "activeTurnId": null } }),
        )
        .await;
    harness.receiver.answer_by_default(Reply::Status(204));
    let before = harness.receiver.received().len();
    let harness = harness.restart().await;
    eventually("every delivery to arrive", async || {
        let deliveries = harness.deliveries(&endpoint).await;
        deliveries.len() == 3
            && deliveries
                .iter()
                .all(|delivery| delivery["state"] == "delivered")
    })
    .await;
    let kinds: Vec<String> = harness.receiver.received()[before..]
        .iter()
        .map(|request| request.json()["kind"].as_str().unwrap().to_owned())
        .collect();
    for kind in ["turn.started", "turn.completed", "session.status"] {
        assert!(kinds.iter().any(|seen| seen == kind), "{kinds:?}");
    }
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_private_or_unresolvable_host_is_refused_and_nothing_else_resolves_it() {
    let receiver = Receiver::start().await;
    let headers = Headers {
        event_type: "webhook.test",
        delivery_id: "d",
        timestamp: 0,
        signature: "v1=",
        authorization: None,
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    // Private, link-local and loopback answers are refused without the fixture allowance.
    for address in ["10.0.0.5", "169.254.169.254", "127.0.0.1", "100.64.0.1"] {
        let policy = NetPolicy::new(resolver(&[("hooks.internal.test", address)]));
        let attempt = send(
            &policy,
            "https://hooks.internal.test/hook",
            &headers,
            b"{}",
            &cancel,
        )
        .await;
        assert_eq!(attempt.failure, Some(Failure::AddressRefused), "{address}");
        assert!(!attempt.retryable());
    }
    // One public address beside a private one is refused too.
    let mixed: HashMap<String, Vec<IpAddr>> = HashMap::from([(
        "hooks.internal.test".to_owned(),
        vec!["8.8.8.8".parse().unwrap(), "192.168.1.1".parse().unwrap()],
    )]);
    let policy = NetPolicy::new(Arc::new(crate::git::clone_policy::tests::MapResolver(
        mixed,
    )));
    let attempt = send(
        &policy,
        "https://hooks.internal.test/hook",
        &headers,
        b"{}",
        &cancel,
    )
    .await;
    assert_eq!(attempt.failure, Some(Failure::AddressRefused));
    // An IP literal is checked the same way.
    let attempt = send(
        &NetPolicy::new(resolver(&[])),
        "https://10.1.2.3/hook",
        &headers,
        b"{}",
        &cancel,
    )
    .await;
    assert_eq!(attempt.failure, Some(Failure::AddressRefused));
    // The injected resolver is the only one: `localhost` is not resolved by the system.
    let attempt = send(
        &receiver.policy(resolver(&[])),
        &receiver.url,
        &headers,
        b"{}",
        &cancel,
    )
    .await;
    assert_eq!(attempt.failure, Some(Failure::Unresolved));
    assert!(receiver.received().is_empty());
    // Plain HTTP is never sent.
    let attempt = send(
        &receiver.policy(resolver(&[("localhost", "127.0.0.1")])),
        &receiver.url.replace("https://", "http://"),
        &headers,
        b"{}",
        &cancel,
    )
    .await;
    assert_eq!(attempt.failure, Some(Failure::UrlRefused));
    assert!(receiver.received().is_empty());
}

/// Counts lookups, answering one address.
struct CountingResolver {
    address: IpAddr,
    lookups: AtomicUsize,
}

impl HostResolver for CountingResolver {
    fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> ResolveFuture<'a> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        let address = self.address;
        Box::pin(async move { Ok(vec![address]) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_attempt_resolves_once_and_connects_to_that_address_without_redirects() {
    let receiver = Receiver::start().await;
    let counting = Arc::new(CountingResolver {
        address: "127.0.0.1".parse().unwrap(),
        lookups: AtomicUsize::new(0),
    });
    let policy = receiver.policy(counting.clone());
    let headers = Headers {
        event_type: "webhook.test",
        delivery_id: "d",
        timestamp: 0,
        signature: "v1=",
        authorization: None,
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let attempt = send(&policy, &receiver.url, &headers, b"{}", &cancel).await;
    assert_eq!(attempt.failure, None);
    assert_eq!(counting.lookups.load(Ordering::SeqCst), 1);
    // A redirect is a failure, never followed.
    receiver.script(&[Reply::Status(302)]);
    let attempt = send(&policy, &receiver.url, &headers, b"{}", &cancel).await;
    assert_eq!(attempt.failure, Some(Failure::Redirect));
    assert_eq!(attempt.status, Some(302));
    assert_eq!(receiver.received().len(), 2);
    assert_eq!(counting.lookups.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabling_an_endpoint_stops_its_request_in_flight_and_its_queue() {
    let harness = Harness::new().await;
    harness.receiver.script(&[Reply::Hang]);
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    eventually("the feed position", async || {
        harness
            .webhooks
            .store()
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    harness.turn("thread-1", "turn-1").await;
    eventually("a request in flight", async || {
        harness.receiver.state.hung.load(Ordering::SeqCst) == 1
    })
    .await;
    harness
        .call(
            "upsert",
            json!({ "id": endpoint, "name": "CI", "url": harness.receiver.url, "enabled": false, "eventTypes": [events::THREAD_STATUS_CHANGED] }),
        )
        .await
        .unwrap();
    eventually("everything queued to be abandoned", async || {
        harness
            .deliveries(&endpoint)
            .await
            .iter()
            .all(|delivery| delivery["state"] == "abandoned")
    })
    .await;
    // The second event of the first turn may or may not have been queued before it was off.
    let queued = harness.deliveries(&endpoint).await.len();
    harness.turn("thread-1", "turn-2").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(harness.receiver.received().len(), 1);
    // Nothing new is queued for a disabled endpoint.
    assert_eq!(harness.deliveries(&endpoint).await.len(), queued);
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_webhooks_off_abandons_the_queue_and_starts_from_now_when_turned_on() {
    let harness = Harness::new().await;
    harness.receiver.answer_by_default(Reply::Status(503));
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    eventually("the feed position", async || {
        harness
            .webhooks
            .store()
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    harness.turn("thread-1", "turn-1").await;
    wait_for_requests(&harness.receiver, 1).await;
    eventually("both events queued", async || {
        harness.deliveries(&endpoint).await.len() == 2
    })
    .await;
    harness.enabled.send_replace(false);
    eventually("the queue to be abandoned", async || {
        harness
            .deliveries(&endpoint)
            .await
            .iter()
            .all(|delivery| delivery["state"] == "abandoned")
    })
    .await;
    assert!(
        harness
            .call("sendTest", json!({ "id": endpoint }))
            .await
            .is_err()
    );
    // What happens while off is never sent.
    harness.turn("thread-1", "turn-2").await;
    harness.receiver.answer_by_default(Reply::Status(200));
    harness.enabled.send_replace(true);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(harness.deliveries(&endpoint).await.len(), 2);
    harness.turn("thread-1", "turn-3").await;
    eventually("the new turn", async || {
        harness.deliveries(&endpoint).await.len() == 4
    })
    .await;
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoking_a_paired_client_disables_its_endpoints() {
    let harness = Harness::new().await;
    harness
        .database
        .call(|connection| {
            connection.execute(
                "INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at) VALUES ('agent-1', 'mcp-client', '[]', 'mcp', '2026-10-31T00:00:00Z', '2099-01-01T00:00:00Z')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    // A person's session cannot be paired.
    let refused = harness
        .call(
            "upsert",
            json!({ "name": "CI", "url": harness.receiver.url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED], "pairedClientId": "someone" }),
        )
        .await
        .unwrap_err();
    assert_eq!(refused["reason"], "invalid");
    let paired = harness
        .call(
            "upsert",
            json!({ "name": "CI", "url": harness.receiver.url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED], "pairedClientId": "agent-1" }),
        )
        .await
        .unwrap();
    let (other, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    harness
        .database
        .call(|connection| {
            connection.execute(
                "UPDATE auth_sessions SET revoked_at = '2026-10-31T00:00:01Z' WHERE session_id = 'agent-1'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    eventually("the paired endpoint to be disabled", async || {
        let listed = harness.call("list", json!({})).await.unwrap();
        listed["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .any(|endpoint| endpoint["disabledReason"] == "client-revoked")
    })
    .await;
    let listed = harness.call("list", json!({})).await.unwrap();
    for endpoint in listed["endpoints"].as_array().unwrap() {
        let is_paired = endpoint["id"] == paired["endpoint"]["id"];
        assert_eq!(endpoint["enabled"], !is_paired, "{endpoint}");
        if endpoint["id"] == other.as_str() {
            assert_eq!(endpoint["disabledReason"], Value::Null);
        }
    }
    harness.webhooks.shutdown().await;
}

/// Every second delivery is lost on the way (the receiver acknowledges it and drops it), yet
/// each lost transition is found through `changes_since` from the last cursor processed, and
/// each lost finding through `profiler_findings { since }` from the last `lastSeen` processed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_receiver_that_drops_every_second_delivery_still_sees_everything() {
    // Both sources start from now: the finding already there is never sent.
    let harness = Harness::new_with_findings(&[("old", 1, "2026-10-31T09:00:00Z")]).await;
    harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    harness.endpoint(&[events::PROFILER_FINDING]).await;
    eventually("both positions", async || {
        let store = harness.webhooks.store();
        store
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
            && store
                .position(store::FINDINGS_POSITION)
                .await
                .unwrap()
                .is_some()
    })
    .await;
    for index in 0..4 {
        harness.turn("thread-1", &format!("turn-{index}")).await;
    }
    // Two findings in the same second, then later ones and an unchanged recurrence.
    harness.write_findings(&[
        ("old", 1, "2026-10-31T09:00:00Z"),
        ("a", 1, "2026-10-31T10:00:00Z"),
        ("b", 1, "2026-10-31T10:00:00Z"),
    ]);
    eventually("the first findings", async || {
        harness
            .receiver
            .received()
            .iter()
            .filter(|request| request.json()["type"] == events::PROFILER_FINDING)
            .count()
            == 2
    })
    .await;
    harness.write_findings(&[
        ("old", 1, "2026-10-31T09:00:00Z"),
        ("a", 2, "2026-10-31T10:00:00Z"),
        ("b", 1, "2026-10-31T10:00:00Z"),
        ("c", 1, "2026-10-31T10:00:01Z"),
        ("d", 1, "2026-10-31T10:00:02Z"),
    ]);
    eventually("every delivery", async || {
        harness.receiver.received().len() == 8 + 4
    })
    .await;
    let received = harness.receiver.received();
    let transitions: Vec<Value> = received
        .iter()
        .map(Received::json)
        .filter(|body| body["type"] == events::THREAD_STATUS_CHANGED)
        .collect();
    assert_eq!(transitions.len(), 8);
    // Kept: every other one. From each kept cursor, the feed returns the dropped one next.
    for pair in transitions.chunks(2) {
        let (kept, dropped) = (&pair[0], &pair[1]);
        let page = crate::mcp::tools::feed::page_after(
            &harness.repositories,
            kept["cursor"].as_str().unwrap(),
            None,
            1,
        )
        .await
        .unwrap();
        assert_eq!(page.entries[0]["cursor"], dropped["cursor"]);
        assert_eq!(page.entries[0]["kind"], dropped["kind"]);
    }
    let findings: Vec<Value> = received
        .iter()
        .map(Received::json)
        .filter(|body| body["type"] == events::PROFILER_FINDING)
        .map(|body| body["finding"].clone())
        .collect();
    assert_eq!(
        findings
            .iter()
            .map(|finding| (
                finding["id"].as_str().unwrap().to_owned(),
                finding["count"].as_u64().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("a".to_owned(), 1),
            ("b".to_owned(), 1),
            ("c".to_owned(), 1),
            ("d".to_owned(), 1)
        ]
    );
    let reader = Reader::new(harness.profiler_dir.path());
    for pair in findings.chunks(2) {
        let (kept, dropped) = (&pair[0], &pair[1]);
        let arguments: Map<String, Value> =
            serde_json::from_value(json!({ "since": kept["lastSeen"] })).unwrap();
        let (content, _) =
            crate::diagnostics::profiler::mcp::findings_page(&reader, &arguments, Value::clone)
                .unwrap_or_else(|_| panic!("a findings page"));
        assert!(
            content["findings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|finding| finding["id"] == dropped["id"]
                    && finding["count"] == dropped["count"]),
            "{content}"
        );
    }
    assert!(
        !received
            .iter()
            .any(|request| String::from_utf8_lossy(&request.body).contains(MARKER))
    );
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finding_webhooks_only_report_new_reopened_or_severity_changed_findings() {
    let harness = Harness::new_for_findings(&[]).await;
    let (endpoint, _) = harness.endpoint(&[events::PROFILER_FINDING]).await;
    // Drive individual audits without a concurrent dispatcher or HTTP sender.
    harness.webhooks.shutdown().await;
    let endpoints = harness.webhooks.store().endpoints().await.unwrap();
    harness.webhooks.follow_findings(&endpoints).await;
    let mut finding: Value =
        serde_json::from_str(&findings_text(&[("a", 1, "2026-11-05T10:00:00Z")])).unwrap();
    let mut lines = String::new();
    for count in 1..=101 {
        finding["count"] = count.into();
        finding["lastSeen"] = format!("2026-11-05T10:{:02}:{:02}Z", count / 60, count % 60).into();
        lines.push_str(&format!("{finding}\n"));
        write_file(&harness.profiler_dir.path().join("findings.ndjson"), &lines);
        harness.webhooks.follow_findings(&endpoints).await;
        assert_eq!(
            harness
                .webhooks
                .store()
                .deliveries(&endpoint, 200)
                .await
                .unwrap()
                .len(),
            1,
            "audit {count} must not send an unchanged recurrence"
        );
    }
    let arguments = serde_json::from_value(json!({"since": "2026-11-05T10:00:00Z"})).unwrap();
    let (caught_up, _) = crate::diagnostics::profiler::mcp::findings_page(
        &Reader::new(harness.profiler_dir.path()),
        &arguments,
        Value::clone,
    )
    .unwrap();
    assert_eq!(caught_up["findings"][0]["id"], "a");
    assert_eq!(caught_up["findings"][0]["count"], 101);
    // Positions survive restart; the existing finding must not be delivered again.
    let harness = harness.restart().await;
    harness.webhooks.shutdown().await;
    harness.webhooks.follow_findings(&endpoints).await;
    let mut expected = 1;
    for (state, severity, sends) in [
        ("resolved", "warn", false),
        ("open", "warn", true),
        ("open", "error", true),
        ("resolved", "error", false),
        ("open", "error", true),
    ] {
        // Neither count nor lastSeen needs to change for a state/severity transition.
        finding["state"] = state.into();
        finding["severity"] = severity.into();
        lines.push_str(&format!("{finding}\n"));
        write_file(&harness.profiler_dir.path().join("findings.ndjson"), &lines);
        harness.webhooks.follow_findings(&endpoints).await;
        expected += usize::from(sends);
        let deliveries = harness
            .webhooks
            .store()
            .deliveries(&endpoint, 200)
            .await
            .unwrap();
        assert_eq!(deliveries.len(), expected, "{state}/{severity}");
        let ids: std::collections::HashSet<_> =
            deliveries.iter().map(|row| &row.event_id).collect();
        assert_eq!(
            ids.len(),
            expected,
            "each notification has its own event id"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_finding_positions_start_from_the_current_book_without_replaying() {
    let harness = Harness::new_for_findings(&[("a", 100, "2026-11-05T10:00:00Z")]).await;
    let (endpoint, _) = harness.endpoint(&[events::PROFILER_FINDING]).await;
    harness.webhooks.shutdown().await;
    harness
        .webhooks
        .store()
        .set_position(
            store::FINDINGS_POSITION,
            json!({"lastSeen": "2026-11-05T09:00:00Z", "marks": {"a": 99}}).to_string(),
        )
        .await
        .unwrap();
    harness
        .webhooks
        .follow_findings(&harness.webhooks.store().endpoints().await.unwrap())
        .await;
    assert!(
        harness
            .webhooks
            .store()
            .deliveries(&endpoint, 200)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_diagnostics_off_no_finding_is_delivered() {
    let harness = Harness::new_with_findings(&[("old", 1, "2026-10-31T09:00:00Z")]).await;
    harness.endpoint(&[events::PROFILER_FINDING]).await;
    eventually("the findings position", async || {
        harness
            .webhooks
            .store()
            .position(store::FINDINGS_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    harness.mcp.send_replace(McpServerSettings {
        capabilities: McpCapabilities {
            diagnostics: false,
            ..McpCapabilities::default()
        },
        ..McpServerSettings::default()
    });
    harness.write_findings(&[
        ("old", 1, "2026-10-31T09:00:00Z"),
        ("new", 1, "2026-10-31T10:00:00Z"),
    ]);
    eventually("the position to pass the new finding", async || {
        harness
            .webhooks
            .store()
            .position(store::FINDINGS_POSITION)
            .await
            .unwrap()
            .is_some_and(|position| position.contains("10:00:00"))
    })
    .await;
    // Turned on again, it does not replay what happened while it was off.
    harness.mcp.send_replace(McpServerSettings::default());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(harness.receiver.received().is_empty());
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_test_redeliver_rotate_and_delete() {
    let harness = Harness::new().await;
    let (endpoint, secret) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    let sent = harness
        .call("sendTest", json!({ "id": endpoint }))
        .await
        .unwrap();
    assert_eq!(sent["delivery"]["state"], "delivered");
    assert_eq!(sent["delivery"]["eventType"], events::WEBHOOK_TEST);
    let first = harness.receiver.received()[0].clone();
    assert_eq!(first.json()["type"], events::WEBHOOK_TEST);
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    assert!(signing::verify(
        &secret,
        first.header("X-BibCode-Timestamp"),
        &first.body,
        first.header("X-BibCode-Signature"),
        now,
        300
    ));
    // A redelivery is the same event under a new delivery id.
    let again = harness
        .call(
            "redeliver",
            json!({ "deliveryId": sent["delivery"]["deliveryId"] }),
        )
        .await
        .unwrap();
    assert_eq!(again["delivery"]["state"], "delivered");
    let second = harness.receiver.received()[1].clone();
    assert_eq!(second.json()["id"], first.json()["id"]);
    assert_ne!(
        second.header("X-BibCode-Delivery"),
        first.header("X-BibCode-Delivery")
    );
    // A failed test reports its status and never retries or counts.
    harness.receiver.script(&[Reply::Status(500)]);
    let failed = harness
        .call("sendTest", json!({ "id": endpoint }))
        .await
        .unwrap();
    assert_eq!(failed["delivery"]["state"], "failed");
    assert_eq!(failed["delivery"]["lastStatus"], 500);
    let listed = harness.call("list", json!({})).await.unwrap();
    assert_eq!(listed["endpoints"][0]["consecutiveFailures"], 0);
    // Rotation: the old secret no longer verifies.
    let rotated = harness
        .call("rotateSecret", json!({ "id": endpoint }))
        .await
        .unwrap();
    let new_secret = rotated["secret"].as_str().unwrap();
    assert_ne!(new_secret, secret);
    harness
        .call("sendTest", json!({ "id": endpoint }))
        .await
        .unwrap();
    let last = harness.receiver.received().last().unwrap().clone();
    let check = |secret: &str| {
        signing::verify(
            secret,
            last.header("X-BibCode-Timestamp"),
            &last.body,
            last.header("X-BibCode-Signature"),
            now,
            300,
        )
    };
    assert!(check(new_secret) && !check(&secret));
    // The secret is never listed.
    let listed = harness.call("list", json!({})).await.unwrap();
    assert!(!listed.to_string().contains(new_secret));
    // Delete removes the endpoint, its log and its secret.
    harness
        .call("delete", json!({ "id": endpoint }))
        .await
        .unwrap();
    assert!(harness.deliveries(&endpoint).await.is_empty());
    assert_eq!(
        harness.call("list", json!({})).await.unwrap()["endpoints"],
        json!([])
    );
    assert!(
        SecretStore::new(harness.secrets_dir.path())
            .await
            .unwrap()
            .get(&format!("webhook-{endpoint}"))
            .await
            .unwrap()
            .is_none()
    );
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_environment_writes_nothing_between_passes() {
    let harness = Harness::new().await;
    harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    eventually("the feed position", async || {
        harness
            .webhooks
            .store()
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    // Let the first passes settle (the findings position, the first prune).
    tokio::time::sleep(Duration::from_millis(150)).await;
    let changes = || async {
        harness
            .database
            .call(|connection| Ok(connection.total_changes()))
            .await
            .unwrap()
    };
    let before = changes().await;
    // About ten passes at the test's 30 ms poll.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(changes().await, before);
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_secret_is_never_sent_unsigned() {
    let harness = Harness::new().await;
    harness.enabled.send_replace(true);
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    std::fs::remove_file(
        harness
            .secrets_dir
            .path()
            .join(format!("webhook-{endpoint}.bin")),
    )
    .unwrap();
    let sent = harness
        .call("sendTest", json!({ "id": endpoint }))
        .await
        .unwrap();
    assert_eq!(sent["delivery"]["state"], "failed");
    assert_eq!(sent["delivery"]["lastError"], "secret_missing");
    assert!(harness.receiver.received().is_empty());
    harness.webhooks.shutdown().await;
}

async fn wait_for_feed_position(harness: &Harness) -> String {
    eventually("the feed position", async || {
        harness
            .webhooks
            .store()
            .position(store::FEED_POSITION)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    harness
        .webhooks
        .store()
        .position(store::FEED_POSITION)
        .await
        .unwrap()
        .unwrap()
}

const SLOW_RETRIES: [Duration; 5] = [Duration::from_secs(10); 5];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changing_an_endpoint_url_or_filter_abandons_what_it_queued() {
    let harness = Harness::new_timed(Timing {
        retry_delays: SLOW_RETRIES.to_vec(),
        ..Timing::default()
    })
    .await;
    harness.receiver.answer_by_default(Reply::Status(503));
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    wait_for_feed_position(&harness).await;
    harness.turn("thread-1", "turn-1").await;
    eventually("both events queued", async || {
        harness.deliveries(&endpoint).await.len() == 2
    })
    .await;
    let edit = |url: &str, name: &str, project: Value| json!({ "id": endpoint, "name": name, "url": url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED], "projectId": project });
    // A new name changes nothing that was queued.
    harness
        .call(
            "upsert",
            edit(&harness.receiver.url, "Renamed", Value::Null),
        )
        .await
        .unwrap();
    assert!(
        harness
            .deliveries(&endpoint)
            .await
            .iter()
            .all(|delivery| delivery["state"] == "pending")
    );
    // A new URL: what was queued for the old one is never sent to it.
    let moved = format!("{}/moved", harness.receiver.url);
    harness
        .call("upsert", edit(&moved, "Renamed", Value::Null))
        .await
        .unwrap();
    for delivery in harness.deliveries(&endpoint).await {
        assert_eq!(delivery["state"], "abandoned", "{delivery}");
        assert_eq!(delivery["lastError"], "endpoint_changed", "{delivery}");
    }
    // A new project filter does the same.
    harness.receiver.answer_by_default(Reply::Status(503));
    harness.turn("thread-1", "turn-2").await;
    eventually("the new turn queued", async || {
        harness
            .deliveries(&endpoint)
            .await
            .iter()
            .filter(|delivery| delivery["state"] == "pending")
            .count()
            == 2
    })
    .await;
    harness
        .call("upsert", edit(&moved, "Renamed", json!("project-1")))
        .await
        .unwrap();
    assert!(
        harness
            .deliveries(&endpoint)
            .await
            .iter()
            .all(|delivery| delivery["state"] == "abandoned")
    );
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redelivery_waits_for_the_request_in_flight_and_a_queued_one_is_refused() {
    let harness = Harness::new_timed(Timing {
        retry_delays: SLOW_RETRIES.to_vec(),
        ..Timing::default()
    })
    .await;
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    let test = harness
        .call("sendTest", json!({ "id": endpoint }))
        .await
        .unwrap();
    wait_for_feed_position(&harness).await;
    harness.receiver.script(&[Reply::Delay(600)]);
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "idle", "activeTurnId": null } }),
        )
        .await;
    eventually("the dispatcher's request in flight", async || {
        harness.receiver.state.hung.load(Ordering::SeqCst) == 1
    })
    .await;
    // Sent while the dispatcher's request is open: it waits for it, never overlapping.
    let again = harness
        .call(
            "redeliver",
            json!({ "deliveryId": test["delivery"]["deliveryId"] }),
        )
        .await
        .unwrap();
    assert_eq!(again["delivery"]["state"], "delivered");
    assert_eq!(harness.receiver.received().len(), 3);
    assert_eq!(harness.receiver.state.most_open.load(Ordering::SeqCst), 1);

    // A delivery still queued (here, waiting for its retry) cannot be sent a second time.
    harness.receiver.answer_by_default(Reply::Status(503));
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "ready", "activeTurnId": null } }),
        )
        .await;
    eventually("a delivery waiting to retry", async || {
        harness
            .deliveries(&endpoint)
            .await
            .iter()
            .any(|delivery| delivery["state"] == "pending" && delivery["attempts"] == 1)
    })
    .await;
    let queued = harness
        .deliveries(&endpoint)
        .await
        .into_iter()
        .find(|delivery| delivery["state"] == "pending")
        .unwrap();
    let refused = harness
        .call("redeliver", json!({ "deliveryId": queued["deliveryId"] }))
        .await
        .unwrap_err();
    assert_eq!(refused["reason"], "queued");
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deliveries_dropped_from_a_full_queue_are_logged_shown_and_announced_once() {
    let harness = Harness::new_timed(Timing {
        max_pending: 2,
        ..Timing::default()
    })
    .await;
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    wait_for_feed_position(&harness).await;
    // Four events queued at once (as one feed page would be): the queue keeps the newest two.
    // Their cursors are out of order on purpose: the range is by position, not by text.
    let queued: Vec<store::NewDelivery> = ["v1.9.0", "v1.10.0", "v1.11.0", "v1.12.0"]
        .iter()
        .enumerate()
        .map(|(index, cursor)| store::NewDelivery {
            delivery_id: format!("d{index}"),
            endpoint_id: endpoint.clone(),
            event_id: format!("ev_{index}"),
            event_type: events::THREAD_STATUS_CHANGED.to_owned(),
            body: json!({ "id": format!("ev_{index}"), "type": events::THREAD_STATUS_CHANGED, "cursor": cursor })
                .to_string(),
            addressed: None,
        })
        .collect();
    let abandoned = harness
        .webhooks
        .store()
        .enqueue(queued, Vec::new(), 0)
        .await
        .unwrap();
    assert_eq!(abandoned, 2);
    eventually("the two kept deliveries", async || {
        harness.receiver.received().len() == 2
    })
    .await;
    let received = harness.receiver.received();
    let first = received[0].json();
    assert_eq!(first["cursor"], "v1.11.0");
    assert_eq!(
        first["dropped"],
        json!({ "count": 2, "fromCursor": "v1.8.0", "toCursor": "v1.10.0" })
    );
    // Announced once.
    assert!(received[1].json().get("dropped").is_none());
    let deliveries = harness.deliveries(&endpoint).await;
    assert_eq!(
        deliveries
            .iter()
            .filter(|delivery| delivery["lastError"] == "queue_full")
            .count(),
        2
    );
    let listed = harness.call("list", json!({})).await.unwrap();
    assert_eq!(listed["endpoints"][0]["droppedDeliveries"], 2);
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retry_waiting_behind_its_delay_does_not_spin_the_dispatcher() {
    let harness = Harness::new_timed(Timing {
        poll: Duration::from_secs(1),
        retry_delays: vec![Duration::from_secs(5); 5],
        ..Timing::default()
    })
    .await;
    harness.receiver.answer_by_default(Reply::Status(500));
    let (endpoint, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    wait_for_feed_position(&harness).await;
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "idle", "activeTurnId": null } }),
        )
        .await;
    wait_for_requests(&harness.receiver, 1).await;
    // Due now, but behind the first one, which waits 5 s for its retry.
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "ready", "activeTurnId": null } }),
        )
        .await;
    eventually("the second delivery queued", async || {
        harness.deliveries(&endpoint).await.len() == 2
    })
    .await;
    let before = harness.webhooks.passes();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let passes = harness.webhooks.passes() - before;
    assert!(passes <= 3, "{passes} passes in one second");
    assert_eq!(harness.receiver.received().len(), 1);
    harness.webhooks.shutdown().await;
}

fn queued(endpoint: &store::Endpoint, cursors: &[&str], tag: &str) -> Vec<store::NewDelivery> {
    cursors
        .iter()
        .map(|cursor| store::NewDelivery {
            delivery_id: format!("{tag}-{cursor}"),
            endpoint_id: endpoint.id.clone(),
            event_id: format!("ev_{tag}_{cursor}"),
            event_type: events::THREAD_STATUS_CHANGED.to_owned(),
            body: json!({ "id": format!("ev_{tag}_{cursor}"), "type": events::THREAD_STATUS_CHANGED, "cursor": cursor })
                .to_string(),
            addressed: Some(endpoint.revision),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_between_the_snapshot_and_the_enqueue_or_the_send_sends_nothing_stale() {
    let harness = Harness::new_timed(Timing {
        retry_delays: SLOW_RETRIES.to_vec(),
        poll: Duration::from_secs(60),
        ..Timing::default()
    })
    .await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    let store = harness.webhooks.store();
    // The dispatcher's snapshot of the endpoint, taken before the edit.
    let snapshot = store.endpoint(&id).await.unwrap().unwrap();
    let edit = |url: String| json!({ "id": id, "name": "CI", "url": url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED] });
    harness
        .call("upsert", edit(format!("{}/moved", harness.receiver.url)))
        .await
        .unwrap();
    // Let the pass the edit woke finish, so only this test sends what it picks below.
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Chosen under the old URL: never queued for the new one.
    store
        .enqueue(queued(&snapshot, &["v1.1.0"], "stale"), Vec::new(), 0)
        .await
        .unwrap();
    assert!(harness.deliveries(&id).await.is_empty());

    // Queued under the current settings, then the endpoint is edited while the dispatcher
    // holds the row it picked: it is not sent to the new URL.
    let current = store.endpoint(&id).await.unwrap().unwrap();
    store
        .enqueue(queued(&current, &["v1.2.0"], "picked"), Vec::new(), 0)
        .await
        .unwrap();
    let picked = store
        .due(super::now_ms() + 1, Vec::new(), 8)
        .await
        .unwrap()
        .remove(0);
    harness
        .call("upsert", edit(format!("{}/again", harness.receiver.url)))
        .await
        .unwrap();
    harness.webhooks.deliver(picked, None).await;
    assert!(harness.receiver.received().is_empty());
    let log = harness.deliveries(&id).await;
    assert_eq!(log[0]["state"], "abandoned");
    assert_eq!(log[0]["lastError"], "endpoint_changed");
    harness.webhooks.shutdown().await;
}

/// A drop recorded while an announcement is in flight is announced next, alone: the first
/// 2xx acknowledges only the batch it carried.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drop_during_an_announcement_is_announced_next_without_repeating_the_first() {
    let harness = Harness::new_timed(Timing {
        max_pending: 2,
        ..Timing::default()
    })
    .await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    let store = harness.webhooks.store();
    let endpoint = store.endpoint(&id).await.unwrap().unwrap();
    harness.receiver.script(&[Reply::Delay(800)]);
    // c1..c4: c1 and c2 dropped (batch one); c3 goes out, announcing them, and stays open.
    store
        .enqueue(
            queued(&endpoint, &["v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0"], "a"),
            Vec::new(),
            0,
        )
        .await
        .unwrap();
    eventually("the announcing request in flight", async || {
        harness.receiver.state.hung.load(Ordering::SeqCst) == 1
    })
    .await;
    // Meanwhile c5..c8: c3 to c6 dropped (batch two).
    store
        .enqueue(
            queued(&endpoint, &["v1.5.0", "v1.6.0", "v1.7.0", "v1.8.0"], "b"),
            Vec::new(),
            0,
        )
        .await
        .unwrap();
    eventually("the next delivery", async || {
        harness.receiver.received().len() >= 2
    })
    .await;
    let received = harness.receiver.received();
    assert_eq!(
        received[0].json()["dropped"],
        json!({ "count": 2, "fromCursor": "v1.0.0", "toCursor": "v1.2.0" })
    );
    assert_eq!(received[1].json()["cursor"], "v1.7.0");
    assert_eq!(
        received[1].json()["dropped"],
        json!({ "count": 4, "fromCursor": "v1.2.0", "toCursor": "v1.6.0" })
    );
    eventually("the last delivery", async || {
        harness.receiver.received().len() == 3
    })
    .await;
    assert!(
        harness.receiver.received()[2]
            .json()
            .get("dropped")
            .is_none()
    );
    harness.webhooks.shutdown().await;
}

/// Eight endpoints held by slow manual sends never take the dispatcher's slots: a ninth
/// endpoint's delivery goes out at once, and the loop does not spin meanwhile.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn endpoints_held_by_manual_sends_neither_block_a_ready_one_nor_spin_the_loop() {
    let harness = Harness::new_timed(Timing {
        poll: Duration::from_secs(1),
        ..Timing::default()
    })
    .await;
    harness.receiver.answer_by_default(Reply::Delay(4_000));
    let mut held = Vec::new();
    for _ in 0..8 {
        held.push(harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await.0);
    }
    let (ready, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    wait_for_feed_position(&harness).await;
    let sends: Vec<_> = held
        .iter()
        .map(|id| {
            let webhooks = harness.webhooks.clone();
            let payload = json!({ "id": id });
            tokio::spawn(async move { webhooks.send_test(payload).await })
        })
        .collect();
    eventually("eight manual sends open", async || {
        harness.receiver.state.open.load(Ordering::SeqCst) == 8
    })
    .await;
    // One event for all nine endpoints; the ninth's delivery is queued last.
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "idle", "activeTurnId": null } }),
        )
        .await;
    eventually("the ready endpoint's delivery", async || {
        harness
            .receiver
            .received()
            .iter()
            .any(|request| request.json()["type"] == events::THREAD_STATUS_CHANGED)
    })
    .await;
    assert!(sends.iter().all(|send| !send.is_finished()));
    let delivered: Vec<Value> = harness.deliveries(&ready).await;
    assert_eq!(delivered.len(), 1);
    let before = harness.webhooks.passes();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let passes = harness.webhooks.passes() - before;
    assert!(passes <= 3, "{passes} passes in one second");
    for send in sends {
        send.await.unwrap().unwrap();
    }
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_and_its_undo_still_fence_off_what_was_chosen_before_them() {
    let harness = Harness::new_timed(Timing {
        poll: Duration::from_secs(60),
        ..Timing::default()
    })
    .await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    let store = harness.webhooks.store();
    let snapshot = store.endpoint(&id).await.unwrap().unwrap();
    let edit = |url: String| json!({ "id": id, "name": "CI", "url": url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED] });
    // A → B → A: the settings read the same as the snapshot's, but they were edited.
    harness
        .call("upsert", edit(format!("{}/b", harness.receiver.url)))
        .await
        .unwrap();
    harness
        .call("upsert", edit(harness.receiver.url.clone()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    store
        .enqueue(queued(&snapshot, &["v1.1.0"], "stale"), Vec::new(), 0)
        .await
        .unwrap();
    assert!(harness.deliveries(&id).await.is_empty());
    harness.webhooks.shutdown().await;
}

/// A test event built from a read of the endpoint, with an edit landing before it takes the
/// endpoint's lock and token: it is refused, never sent to the edited URL.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_send_built_before_an_edit_is_refused() {
    let harness = Harness::new().await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    // The test holds the endpoint's lock; the edit queues for it first, then the test event
    // reads the endpoint (still the old revision) and queues behind the edit.
    let turn = harness.webhooks.send_lock(&id).lock_owned().await;
    let editor = harness.webhooks.clone();
    let edit_payload = json!({ "id": id, "name": "CI", "url": format!("{}/moved", harness.receiver.url), "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED] });
    let edit = tokio::spawn(async move { editor.upsert(edit_payload).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let webhooks = harness.webhooks.clone();
    let payload = json!({ "id": id });
    let send = tokio::spawn(async move { webhooks.send_test(payload).await });
    eventually("the test event read and stored", async || {
        harness.deliveries(&id).await.len() == 1
    })
    .await;
    drop(turn);
    edit.await.unwrap().unwrap();
    let refused = send.await.unwrap().unwrap_err();
    assert_eq!(refused["reason"], "endpoint_changed", "{refused}");
    assert!(harness.receiver.received().is_empty());
    let log = harness.deliveries(&id).await;
    assert_eq!(log[0]["state"], "abandoned");
    assert_eq!(log[0]["lastError"], "endpoint_changed");
    harness.webhooks.shutdown().await;
}

/// An acknowledgement held up across webhooks off and on never erases a batch recorded
/// after it: batch numbers are never reused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_acknowledgement_paused_across_off_and_on_keeps_a_newer_drop() {
    let harness = Harness::new_timed(Timing {
        poll: Duration::from_secs(60),
        max_pending: 1,
        ..Timing::default()
    })
    .await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let store = harness.webhooks.store();
    let endpoint = store.endpoint(&id).await.unwrap().unwrap();
    store
        .enqueue(queued(&endpoint, &["v1.1.0", "v1.2.0"], "a"), Vec::new(), 0)
        .await
        .unwrap();
    // A request announced this batch and got its 2xx; its acknowledgement is held up.
    let (announced, _) = store.dropped(&id).await.unwrap().unwrap();
    // Webhooks off, then on, and a new drop.
    harness.webhooks.turned_off().await;
    store
        .enqueue(queued(&endpoint, &["v1.3.0", "v1.4.0"], "b"), Vec::new(), 0)
        .await
        .unwrap();
    store.acknowledge_dropped(&id, announced).await.unwrap();
    let (_, pending) = store
        .dropped(&id)
        .await
        .unwrap()
        .expect("the newer drop stays");
    assert_eq!(pending.from_cursor.as_deref(), Some("v1.2.0"));
    harness.webhooks.shutdown().await;
}

/// Holds the next sender just after its revision read until `release`.
async fn edit_while_a_sender_is_past_its_revision_read(
    harness: &Harness,
    id: &str,
    pause: Arc<super::Pause>,
) -> tokio::task::JoinHandle<Result<Value, Value>> {
    tokio::time::timeout(Duration::from_secs(5), pause.reached.notified())
        .await
        .expect("a sender past its revision read");
    let webhooks = harness.webhooks.clone();
    let payload = json!({ "id": id, "name": "CI", "url": format!("{}/moved", harness.receiver.url), "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED] });
    let edit = tokio::spawn(async move { webhooks.upsert(payload).await });
    // The edit waits for the sender: it cannot commit while one may still post to the old URL.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!edit.is_finished(), "the edit committed under a sender");
    pause.release.notify_one();
    edit
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_waits_for_a_manual_send_past_its_revision_read_and_stops_it() {
    let harness = Harness::new().await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    let pause = harness.webhooks.pause_next_sender_after_revision_read();
    let webhooks = harness.webhooks.clone();
    let payload = json!({ "id": id });
    let send = tokio::spawn(async move { webhooks.send_test(payload).await });
    let edit = edit_while_a_sender_is_past_its_revision_read(&harness, &id, pause).await;
    edit.await.unwrap().unwrap();
    let sent = send.await.unwrap().unwrap();
    assert_eq!(sent["delivery"]["state"], "abandoned", "{sent}");
    assert!(harness.receiver.received().is_empty());
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_waits_for_a_queued_send_past_its_revision_read_and_stops_it() {
    let harness = Harness::new().await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    wait_for_feed_position(&harness).await;
    let pause = harness.webhooks.pause_next_sender_after_revision_read();
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "idle", "activeTurnId": null } }),
        )
        .await;
    let edit = edit_while_a_sender_is_past_its_revision_read(&harness, &id, pause).await;
    edit.await.unwrap().unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(harness.receiver.received().is_empty());
    let log = harness.deliveries(&id).await;
    assert_eq!(log[0]["state"], "abandoned");
    assert_eq!(log[0]["lastError"], "endpoint_changed");
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn endpoints_are_validated_and_limited_to_twenty() {
    let harness = Harness::new().await;
    for (payload, field) in [
        (
            json!({ "name": "", "url": "https://a.example/", "enabled": true, "eventTypes": ["panel.created"] }),
            "name",
        ),
        (
            json!({ "name": "x", "url": "http://a.example/", "enabled": true, "eventTypes": ["panel.created"] }),
            "url",
        ),
        (
            json!({ "name": "x", "url": "https://a.example/", "enabled": true, "eventTypes": [] }),
            "events",
        ),
        (
            json!({ "name": "x", "url": "https://a.example/", "enabled": true, "eventTypes": ["webhook.test"] }),
            "test event",
        ),
    ] {
        let refused = harness.call("upsert", payload).await.unwrap_err();
        assert_eq!(refused["_tag"], "WebhookError", "{field}");
        assert_eq!(refused["reason"], "invalid", "{field}");
    }
    for index in 0..20 {
        harness
            .call(
                "upsert",
                json!({ "name": format!("e{index}"), "url": "https://a.example/", "enabled": true, "eventTypes": ["panel.created"] }),
            )
            .await
            .unwrap();
    }
    let refused = harness
        .call(
            "upsert",
            json!({ "name": "one more", "url": "https://a.example/", "enabled": true, "eventTypes": ["panel.created"] }),
        )
        .await
        .unwrap_err();
    assert_eq!(refused["reason"], "limit");
    harness.webhooks.shutdown().await;
}

/// `dropped.fromCursor` is where to resume `changes_since`, which reads strictly after the
/// cursor it is given, so it must come just before the first dropped event.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changes_since_from_dropped_from_cursor_returns_the_first_dropped_event() {
    let harness = Harness::new_timed(Timing {
        poll: Duration::from_secs(60),
        max_pending: 2,
        ..Timing::default()
    })
    .await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let store = harness.webhooks.store();
    let endpoint = store.endpoint(&id).await.unwrap().unwrap();
    let start = crate::mcp::tools::feed::head(&harness.repositories)
        .await
        .unwrap();
    harness.turn("thread-1", "turn-1").await;
    harness.turn("thread-1", "turn-2").await;
    let page = crate::mcp::tools::feed::page_after(&harness.repositories, &start, None, 100)
        .await
        .unwrap();
    let transitions: Vec<&Value> = page
        .entries
        .iter()
        .filter(|entry| events::from_feed_entry(entry, None).is_some())
        .collect();
    assert!(transitions.len() >= 4, "{transitions:?}");
    let cursors: Vec<&str> = transitions
        .iter()
        .map(|entry| entry["cursor"].as_str().unwrap())
        .collect();
    store
        .enqueue(queued(&endpoint, &cursors, "k"), Vec::new(), 0)
        .await
        .unwrap();
    let (_, lost) = store
        .dropped(&id)
        .await
        .unwrap()
        .expect("some were dropped");
    let dropped = cursors.len() - 2;
    assert_eq!(lost.count as usize, dropped);
    let from = lost.from_cursor.expect("a range");
    let resumed = crate::mcp::tools::feed::page_after(&harness.repositories, &from, None, 100)
        .await
        .unwrap();
    // The first dropped event is returned, then every later one: none is skipped.
    let resumed_cursors: Vec<&str> = resumed
        .entries
        .iter()
        .filter(|entry| events::from_feed_entry(entry, None).is_some())
        .map(|entry| entry["cursor"].as_str().unwrap())
        .collect();
    assert_eq!(resumed_cursors, cursors);
    harness.webhooks.shutdown().await;
}

const TOKEN_A: &str = "tok-A.1_x~";
const TOKEN_B: &str = "tok-B.2_y~";

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// A status change on `thread-1`, which a `thread.status_changed` endpoint is sent.
async fn status_change(harness: &Harness) {
    harness
        .event(
            "thread.session-set",
            "thread-1",
            json!({ "session": { "status": "idle", "activeTurnId": null } }),
        )
        .await;
}

async fn send_test(harness: &Harness, id: &str) -> Value {
    harness.call("sendTest", json!({ "id": id })).await.unwrap()["delivery"].clone()
}

/// An upsert of endpoint `id` at the receiver, with `extra` fields over it, run on its own.
fn spawn_edit(
    harness: &Harness,
    id: &str,
    extra: Value,
) -> tokio::task::JoinHandle<Result<Value, Value>> {
    let webhooks = harness.webhooks.clone();
    let mut payload = json!({ "id": id, "name": "CI", "url": harness.receiver.url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED] });
    for (key, value) in extra.as_object().unwrap() {
        payload[key] = value.clone();
    }
    tokio::spawn(async move { webhooks.upsert(payload).await })
}

async fn reached(pause: &super::Pause, what: &str) {
    tokio::time::timeout(Duration::from_secs(5), pause.reached.notified())
        .await
        .unwrap_or_else(|_| panic!("{what}"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bearer_token_is_sent_on_deliveries_retries_redeliveries_and_tests() {
    let harness = Harness::new().await;
    harness.receiver.script(&[Reply::Status(500)]);
    let url = harness.receiver.url.clone();
    let (id, secret) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    wait_for_feed_position(&harness).await;
    status_change(&harness).await;
    // The first attempt gets a 500 and the retry a 200.
    wait_for_requests(&harness.receiver, 2).await;
    eventually("the delivery recorded", async || {
        harness.deliveries(&id).await[0]["state"] == "delivered"
    })
    .await;
    let delivered = harness.deliveries(&id).await[0]["deliveryId"].clone();
    harness
        .call("redeliver", json!({ "deliveryId": delivered }))
        .await
        .unwrap();
    assert_eq!(send_test(&harness, &id).await["state"], "delivered");
    let received = harness.receiver.received();
    assert_eq!(received.len(), 4);
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    for request in &received {
        assert_eq!(request.header("Authorization"), bearer(TOKEN_A));
        // The signature is unchanged and does not cover the header.
        assert!(signing::verify(
            &secret,
            request.header("X-BibCode-Timestamp"),
            &request.body,
            request.header("X-BibCode-Signature"),
            now,
            300,
        ));
    }
    harness.webhooks.shutdown().await;
}

#[derive(Clone, Default)]
struct CapturedLog(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// In a process of its own, so no sibling test can turn a callsite off for this capture, and
/// on one thread, so the scoped subscriber sees the dispatcher's tasks.
#[tokio::test]
async fn a_bearer_token_is_never_listed_or_logged() {
    let Some(child) = crate::test_support::in_own_process(
        "webhooks::tests::a_bearer_token_is_never_listed_or_logged",
    ) else {
        return;
    };
    const CANARY: &str = "TOKEN-CANARY-31337";
    let log = CapturedLog::default();
    let _logging = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer({
                let log = log.clone();
                move || log.clone()
            })
            .finish(),
    );
    let harness = Harness::new().await;
    harness.receiver.answer_by_default(Reply::Status(400));
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], CANARY)
        .await;
    wait_for_feed_position(&harness).await;
    status_change(&harness).await;
    wait_for_requests(&harness.receiver, 1).await;
    assert_eq!(
        harness.receiver.received()[0].header("Authorization"),
        bearer(CANARY)
    );
    eventually("the failure recorded", async || {
        harness.deliveries(&id).await[0]["state"] == "failed"
    })
    .await;
    // Refusals never echo the value.
    for refused in [
        format!("Bearer {CANARY}"),
        format!("{CANARY} x"),
        format!("{CANARY}\u{7}"),
    ] {
        let refusal = harness
            .edit(&id, json!({ "bearerToken": refused }))
            .await
            .unwrap_err();
        assert!(!refusal.to_string().contains(CANARY), "{refusal}");
    }
    // A missing file fails unsent, and that is logged too.
    let name = harness.bearer_secret(&id).await.unwrap();
    std::fs::remove_file(harness.secrets_dir.path().join(format!("{name}.bin"))).unwrap();
    assert_eq!(send_test(&harness, &id).await["lastError"], "token_missing");
    let listed = harness.call("list", json!({})).await.unwrap();
    assert_eq!(listed["endpoints"][0]["bearerTokenSet"], true);
    let deliveries = harness
        .call("listDeliveries", json!({ "endpointId": id }))
        .await
        .unwrap();
    for shown in [&listed, &deliveries] {
        assert!(!shown.to_string().contains(CANARY), "{shown}");
        assert!(!shown.to_string().contains("webhook-bearer-"), "{shown}");
    }
    harness.webhooks.shutdown().await;
    let log = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(
        log.contains("webhook delivery failed"),
        "the capture saw the run:\n{log}"
    );
    assert!(!log.contains(CANARY), "the token reached the log:\n{log}");
    child.complete();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upsert_without_the_token_keeps_it_and_null_clears_it() {
    let harness = Harness::new().await;
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    // An older client's save names no token: it is kept.
    let renamed = harness
        .edit(&id, json!({ "name": "Renamed" }))
        .await
        .unwrap();
    assert_eq!(renamed["endpoint"]["bearerTokenSet"], true);
    send_test(&harness, &id).await;
    assert_eq!(
        harness.receiver.received()[0].header("Authorization"),
        bearer(TOKEN_A)
    );
    // A string replaces it without a new revision, so the queue is kept.
    let store = harness.webhooks.store();
    let revision = store.endpoint(&id).await.unwrap().unwrap().revision;
    harness
        .edit(&id, json!({ "bearerToken": TOKEN_B }))
        .await
        .unwrap();
    assert_eq!(
        store.endpoint(&id).await.unwrap().unwrap().revision,
        revision
    );
    send_test(&harness, &id).await;
    assert_eq!(
        harness.receiver.received()[1].header("Authorization"),
        bearer(TOKEN_B)
    );
    assert_eq!(harness.bearer_files(&id).await.len(), 1);
    // `null` clears it and removes its file.
    let cleared = harness
        .edit(&id, json!({ "bearerToken": null }))
        .await
        .unwrap();
    assert_eq!(cleared["endpoint"]["bearerTokenSet"], false);
    send_test(&harness, &id).await;
    assert_eq!(harness.receiver.received()[2].header("Authorization"), "");
    assert!(harness.bearer_files(&id).await.is_empty());
    // Delete removes every file of the endpoint.
    harness
        .edit(&id, json!({ "bearerToken": TOKEN_A }))
        .await
        .unwrap();
    harness.call("delete", json!({ "id": id })).await.unwrap();
    assert!(harness.bearer_files(&id).await.is_empty());
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_set_token_that_is_missing_fails_the_delivery_unsent() {
    let harness = Harness::new().await;
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    let name = harness.bearer_secret(&id).await.unwrap();
    std::fs::remove_file(harness.secrets_dir.path().join(format!("{name}.bin"))).unwrap();
    let sent = send_test(&harness, &id).await;
    assert_eq!(sent["state"], "failed");
    assert_eq!(sent["lastError"], "token_missing");
    wait_for_feed_position(&harness).await;
    status_change(&harness).await;
    eventually("the queued delivery failed", async || {
        harness.deliveries(&id).await.iter().any(|delivery| {
            delivery["eventType"] == events::THREAD_STATUS_CHANGED && delivery["state"] == "failed"
        })
    })
    .await;
    let queued = harness.deliveries(&id).await;
    assert_eq!(queued[0]["lastError"], "token_missing");
    // Never retried, and never sent without the token.
    assert_eq!(queued[0]["attempts"], 1);
    assert!(harness.receiver.received().is_empty());
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_commit_of_a_url_and_token_change_keeps_the_old_url_with_the_old_token() {
    let harness = Harness::new().await;
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    let before = harness.bearer_files(&id).await;
    let run = |sql: &'static str| {
        harness.database.call(move |connection| {
            connection.execute_batch(sql)?;
            Ok(())
        })
    };
    run(
        "CREATE TRIGGER refuse_edit BEFORE UPDATE ON webhook_endpoints \
         BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    )
    .await
    .unwrap();
    let moved = harness
        .edit(
            &id,
            json!({ "url": format!("{url}/b"), "bearerToken": TOKEN_B }),
        )
        .await
        .unwrap_err();
    assert_eq!(moved["reason"], "storage");
    run("DROP TRIGGER refuse_edit;").await.unwrap();
    // The new file went with the failed commit.
    assert_eq!(harness.bearer_files(&id).await, before);
    send_test(&harness, &id).await;
    let received = harness.receiver.received();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].path, "/hook");
    assert_eq!(received[0].header("Authorization"), bearer(TOKEN_A));
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_url_change_without_the_token_is_refused_while_one_is_set() {
    let harness = Harness::new().await;
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    let moved = format!("{url}/b");
    let refused = harness
        .edit(&id, json!({ "url": moved }))
        .await
        .unwrap_err();
    assert_eq!(refused["reason"], "invalid");
    assert_eq!(
        refused["message"],
        "Enter the token for the new URL, or remove it."
    );
    let store = harness.webhooks.store();
    assert_eq!(store.endpoint(&id).await.unwrap().unwrap().url, url);
    // Restated, or removed, it is saved.
    harness
        .edit(&id, json!({ "url": moved, "bearerToken": TOKEN_B }))
        .await
        .unwrap();
    harness
        .edit(
            &id,
            json!({ "url": format!("{url}/c"), "bearerToken": null }),
        )
        .await
        .unwrap();
    // With no token set, a URL change needs nothing more.
    harness.edit(&id, json!({})).await.unwrap();
    assert_eq!(store.endpoint(&id).await.unwrap().unwrap().url, url);
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_token_file_left_by_a_crash_is_removed_by_the_next_edit_and_never_sent() {
    let harness = Harness::new().await;
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    // An edit that wrote its file and stopped before its commit.
    SecretStore::new(harness.secrets_dir.path())
        .await
        .unwrap()
        .set(&super::new_bearer_name(&id), TOKEN_B.as_bytes())
        .await
        .unwrap();
    let harness = harness.restart().await;
    send_test(&harness, &id).await;
    assert_eq!(
        harness.receiver.received()[0].header("Authorization"),
        bearer(TOKEN_A)
    );
    assert_eq!(harness.bearer_files(&id).await.len(), 2);
    harness
        .edit(&id, json!({ "name": "Renamed" }))
        .await
        .unwrap();
    let kept = harness.bearer_secret(&id).await.unwrap();
    assert_eq!(harness.bearer_files(&id).await, [kept]);
    send_test(&harness, &id).await;
    assert_eq!(
        harness.receiver.received()[1].header("Authorization"),
        bearer(TOKEN_A)
    );
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_during_dispatcher_start_keeps_its_token() {
    let pause = Arc::new(super::Pause::default());
    let harness = Harness::new_timed(Timing {
        start_pause: Some(pause.clone()),
        ..Timing::default()
    })
    .await;
    reached(&pause, "the dispatcher held at its start").await;
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    harness
        .edit(&id, json!({ "bearerToken": TOKEN_B }))
        .await
        .unwrap();
    pause.release.notify_one();
    wait_for_feed_position(&harness).await;
    status_change(&harness).await;
    let received = wait_for_requests(&harness.receiver, 1).await;
    assert_eq!(received[0].header("Authorization"), bearer(TOKEN_B));
    assert_eq!(harness.bearer_files(&id).await.len(), 1);
    eventually("the delivery recorded", async || {
        harness.deliveries(&id).await[0]["state"] == "delivered"
    })
    .await;
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_clear_and_replace_leave_a_readable_token_or_none() {
    // The edit held after its token write, the one that waits for it, and the token left.
    for (first, second, expected) in [
        (
            json!({ "bearerToken": TOKEN_B }),
            json!({ "bearerToken": null }),
            None,
        ),
        (
            json!({ "bearerToken": null }),
            json!({ "bearerToken": TOKEN_B }),
            Some(TOKEN_B),
        ),
    ] {
        let harness = Harness::new().await;
        let url = harness.receiver.url.clone();
        let (id, _) = harness
            .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
            .await;
        let pause = harness.webhooks.pause_next_edit_after_token_write();
        let held = spawn_edit(&harness, &id, first);
        reached(&pause, "the first edit held after its token write").await;
        let waiting = spawn_edit(&harness, &id, second);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !waiting.is_finished(),
            "the second edit ran inside the first"
        );
        pause.release.notify_one();
        held.await.unwrap().unwrap();
        let last = waiting.await.unwrap().unwrap();
        assert_eq!(last["endpoint"]["bearerTokenSet"], expected.is_some());
        // The row names a readable file, or none, and nothing else is left.
        let named = harness.bearer_secret(&id).await;
        assert_eq!(
            harness.bearer_files(&id).await,
            named.into_iter().collect::<Vec<_>>()
        );
        let sent = send_test(&harness, &id).await;
        assert_eq!(sent["state"], "delivered", "{sent}");
        assert_eq!(
            harness.receiver.received()[0].header("Authorization"),
            expected.map(bearer).unwrap_or_default()
        );
        harness.webhooks.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replaced_token_file_is_not_removed_under_a_sender_that_read_it() {
    let harness = Harness::new().await;
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    let old = harness.bearer_secret(&id).await.unwrap();
    let pause = harness.webhooks.pause_next_sender_after_revision_read();
    let webhooks = harness.webhooks.clone();
    let payload = json!({ "id": id });
    let send = tokio::spawn(async move { webhooks.send_test(payload).await });
    reached(&pause, "a sender past its row read").await;
    let edit = spawn_edit(&harness, &id, json!({ "bearerToken": TOKEN_B }));
    // The edit commits, then waits for the sender before it removes the file the sender read.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!edit.is_finished(), "the edit did not wait for the sender");
    assert!(harness.bearer_files(&id).await.contains(&old));
    pause.release.notify_one();
    let sent = send.await.unwrap().unwrap();
    assert_eq!(sent["delivery"]["state"], "delivered", "{sent}");
    assert_eq!(
        harness.receiver.received()[0].header("Authorization"),
        bearer(TOKEN_A)
    );
    edit.await.unwrap().unwrap();
    assert!(!harness.bearer_files(&id).await.contains(&old));
    send_test(&harness, &id).await;
    assert_eq!(
        harness.receiver.received()[1].header("Authorization"),
        bearer(TOKEN_B)
    );
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_racing_a_url_and_token_change_never_pairs_the_old_url_with_the_new_token() {
    let harness = Harness::new().await;
    let url = harness.receiver.url.clone();
    let (id, _) = harness
        .endpoint_with_token(&url, &[events::THREAD_STATUS_CHANGED], TOKEN_A)
        .await;
    // The rename reads URL A and is held before its commit.
    let pause = harness.webhooks.pause_next_edit_after_token_write();
    let rename = spawn_edit(&harness, &id, json!({ "name": "Renamed" }));
    reached(&pause, "the rename held after its read").await;
    // Meanwhile another edit moves the endpoint to URL B with token B.
    let moved = format!("{url}/b");
    let relocate = spawn_edit(
        &harness,
        &id,
        json!({ "url": moved, "bearerToken": TOKEN_B }),
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!relocate.is_finished(), "the move ran inside the rename");
    pause.release.notify_one();
    rename.await.unwrap().unwrap();
    relocate.await.unwrap().unwrap();
    let store = harness.webhooks.store();
    assert_eq!(store.endpoint(&id).await.unwrap().unwrap().url, moved);
    send_test(&harness, &id).await;
    let received = harness.receiver.received();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].path, "/hook/b");
    assert_eq!(received[0].header("Authorization"), bearer(TOKEN_B));
    harness.webhooks.shutdown().await;
}

/// An endpoint whose status filter leaves out `turn.started` gets only the turn's completion;
/// one with no filter gets both.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_endpoint_that_skips_turn_started_gets_no_such_delivery() {
    let harness = Harness::new().await;
    let created = harness
        .call(
            "upsert",
            json!({ "name": "Done only", "url": harness.receiver.url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED], "statusKinds": ["turn.completed"] }),
        )
        .await
        .expect("an endpoint");
    assert_eq!(
        created["endpoint"]["statusKinds"],
        json!(["turn.completed"])
    );
    let filtered = created["endpoint"]["id"].as_str().unwrap().to_owned();
    let (every, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    wait_for_feed_position(&harness).await;
    harness.turn("thread-1", "turn-1").await;
    let received = wait_for_requests(&harness.receiver, 3).await;
    let mut kinds: Vec<String> = received
        .iter()
        .map(|request| request.json()["kind"].as_str().unwrap().to_owned())
        .collect();
    kinds.sort();
    assert_eq!(kinds, ["turn.completed", "turn.completed", "turn.started"]);
    assert_eq!(harness.deliveries(&filtered).await.len(), 1);
    assert_eq!(harness.deliveries(&every).await.len(), 2);
    harness.webhooks.shutdown().await;
}

/// `statusKinds` absent keeps the stored filter (an older client's save), `null` sends every
/// kind, and a change is a new revision; unknown and empty lists are refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upsert_without_status_kinds_keeps_them_and_null_clears_them() {
    let harness = Harness::new().await;
    let (id, _) = harness.endpoint(&[events::THREAD_STATUS_CHANGED]).await;
    let listed = harness.call("list", json!({})).await.unwrap();
    assert_eq!(listed["endpoints"][0]["statusKinds"], Value::Null);
    let set = harness
        .edit(
            &id,
            json!({ "statusKinds": ["turn.failed", "turn.completed", "turn.failed"] }),
        )
        .await
        .unwrap();
    assert_eq!(
        set["endpoint"]["statusKinds"],
        json!(["turn.completed", "turn.failed"]),
        "known kinds, once each, in the catalog's order"
    );
    let store = harness.webhooks.store();
    let revision = store.endpoint(&id).await.unwrap().unwrap().revision;
    // The v0.14 shape: no `statusKinds`.
    let renamed = harness
        .edit(&id, json!({ "name": "Renamed" }))
        .await
        .unwrap();
    assert_eq!(
        renamed["endpoint"]["statusKinds"],
        json!(["turn.completed", "turn.failed"])
    );
    assert_eq!(
        store.endpoint(&id).await.unwrap().unwrap().revision,
        revision
    );
    for refused in [json!(["turn.started", "turn.exploded"]), json!([])] {
        let refusal = harness
            .edit(&id, json!({ "statusKinds": refused }))
            .await
            .unwrap_err();
        assert_eq!(refusal["reason"], "invalid", "{refused}");
    }
    let cleared = harness
        .edit(&id, json!({ "statusKinds": null }))
        .await
        .unwrap();
    assert_eq!(cleared["endpoint"]["statusKinds"], Value::Null);
    assert!(store.endpoint(&id).await.unwrap().unwrap().revision > revision);
    harness.webhooks.shutdown().await;
}

/// Named clients (#280): `runs` live `mcp-client` sessions of the named client `nc_builder`,
/// and the unnamed session `unnamed`.
async fn seed_named_runs(harness: &Harness, runs: &[&str]) {
    let runs: Vec<String> = runs.iter().map(|run| (*run).to_owned()).collect();
    harness
        .database
        .call(move |connection| {
            connection.execute(
                "INSERT INTO mcp_named_clients (client_id, name, created_at) VALUES ('nc_builder', 'builder', '2026-11-07T00:00:00Z')",
                [],
            )?;
            for run in runs.iter().map(String::as_str).chain(["unnamed"]) {
                let named = (run != "unnamed").then_some("nc_builder");
                connection.execute(
                    "INSERT INTO auth_sessions (session_id, subject, scopes, method, client_label, issued_at, expires_at, mcp_named_client_id) VALUES (?1, 'mcp-client', '[]', 'mcp', ?2, '2026-11-07T00:00:00Z', '2099-01-01T00:00:00Z', ?3)",
                    rusqlite::params![run, format!("MCP · {run}"), named],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
}

async fn paired_endpoint(harness: &Harness, name: &str, client: &str) -> Value {
    harness
        .call(
            "upsert",
            json!({ "name": name, "url": harness.receiver.url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED], "pairedClientId": client }),
        )
        .await
        .unwrap()["endpoint"]
        .clone()
}

async fn endpoint_state(harness: &Harness, id: &Value) -> Value {
    let listed = harness.call("list", json!({})).await.unwrap();
    listed["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|endpoint| endpoint["id"] == *id)
        .cloned()
        .expect("endpoint listed")
}

async fn relay_exits(harness: &Harness, session_id: &str) {
    assert!(
        harness
            .repositories
            .revoke_mcp_credential(session_id.to_owned(), "2026-11-07T00:00:01Z".to_owned())
            .await
            .unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_endpoint_paired_with_a_named_client_survives_its_relay_exiting() {
    let harness = Harness::new().await;
    seed_named_runs(&harness, &["run-1"]).await;
    let named = paired_endpoint(&harness, "Named", "run-1").await;
    assert_eq!(
        named["pairedClientId"], "nc_builder",
        "paired with the identity"
    );
    assert_eq!(named["pairedClientName"], "builder");
    let unnamed = paired_endpoint(&harness, "Unnamed", "unnamed").await;
    assert_eq!(unnamed["pairedClientName"], "MCP · unnamed");

    relay_exits(&harness, "run-1").await;
    relay_exits(&harness, "unnamed").await;
    // Once the unnamed endpoint is off, the dispatcher has reconciled past both exits.
    eventually("the unnamed endpoint to turn off", async || {
        endpoint_state(&harness, &unnamed["id"]).await["disabledReason"] == "client-revoked"
    })
    .await;
    let named = endpoint_state(&harness, &named["id"]).await;
    assert_eq!(named["enabled"], true, "{named}");
    assert_eq!(
        named["pairedClientName"], "builder",
        "named with no run live"
    );
    // Re-saving the stored id (the on/off toggle) still pairs.
    paired_endpoint(&harness, "Named", "nc_builder").await;
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_person_revoking_a_named_clients_row_disables_its_endpoints_and_ends_every_run() {
    let harness = Harness::new().await;
    seed_named_runs(&harness, &["run-1", "run-2"]).await;
    let named = paired_endpoint(&harness, "Named", "run-2").await;
    let revoked = harness
        .repositories
        .revoke_auth_session_and_identity("run-1".to_owned(), "2026-11-07T00:00:01Z".to_owned())
        .await
        .unwrap();
    let mut sessions = revoked.sessions;
    sessions.sort();
    assert_eq!(sessions, ["run-1", "run-2"]);
    eventually("the named endpoint to turn off", async || {
        endpoint_state(&harness, &named["id"]).await["disabledReason"] == "client-revoked"
    })
    .await;
    let refused = harness
        .call(
            "upsert",
            json!({ "name": "Again", "url": harness.receiver.url, "enabled": true, "eventTypes": [events::THREAD_STATUS_CHANGED], "pairedClientId": "nc_builder" }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        refused["reason"], "invalid",
        "an ended identity cannot be paired"
    );
    harness.webhooks.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_endpoint_paired_with_an_unnamed_relay_turns_off_when_it_exits() {
    let harness = Harness::new().await;
    seed_named_runs(&harness, &[]).await;
    let unnamed = paired_endpoint(&harness, "Unnamed", "unnamed").await;
    assert_eq!(unnamed["pairedClientId"], "unnamed");
    relay_exits(&harness, "unnamed").await;
    eventually("the unnamed endpoint to turn off", async || {
        endpoint_state(&harness, &unnamed["id"]).await["disabledReason"] == "client-revoked"
    })
    .await;
    harness.webhooks.shutdown().await;
}
