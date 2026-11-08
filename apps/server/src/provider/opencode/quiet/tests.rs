//! The quiet probe and fence (#326) against a scripted OpenCode 2 server.

use std::time::Duration;

use serde_json::json;
use tokio::time::Instant;

use super::{
    QuietFence, QuietRefusal, QuietTarget, probe, probe_with,
    test_server::{CHILD, ROOT, ScriptedOpenCode, event, started},
};

const WAIT: Duration = Duration::from_secs(5);

struct Probe {
    _checkout: tempfile::TempDir,
    directory: std::path::PathBuf,
    server: ScriptedOpenCode,
}

impl Probe {
    async fn new() -> Self {
        let checkout = tempfile::tempdir().unwrap();
        let directory = std::fs::canonicalize(checkout.path()).unwrap();
        let server = ScriptedOpenCode::idle(&directory).await;
        Self {
            _checkout: checkout,
            directory,
            server,
        }
    }

    fn target(&self) -> QuietTarget<'_> {
        QuietTarget {
            endpoint: &self.server.url,
            password: None,
            checkout: &self.directory,
            root_session_id: ROOT,
            reverting_session_id: Some("ses_reverting"),
        }
    }

    async fn run(&self) -> Result<QuietFence, QuietRefusal> {
        probe(&self.target(), Instant::now() + WAIT).await
    }

    async fn run_silent_after(&self, silence: Duration) -> Result<QuietFence, QuietRefusal> {
        probe_with(&self.target(), Instant::now() + WAIT, silence).await
    }

    fn inside(&self) -> String {
        self.directory.join("src").to_string_lossy().into_owned()
    }
}

/// Waits until the fence's watcher has tripped.
async fn tripped(fence: &QuietFence) -> String {
    let mut trips = fence.trips();
    tokio::time::timeout(WAIT, trips.wait_for(Option::is_some))
        .await
        .expect("the fence trips")
        .unwrap()
        .clone()
        .unwrap()
}

/// Gives the watcher time to read what was pushed, then expects it untripped.
async fn untripped(fence: &QuietFence) {
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(*fence.trips().borrow(), None);
    fence.check().await.unwrap();
}

#[tokio::test]
async fn an_idle_tree_returns_an_open_fence_and_sends_nothing_to_the_sibling() {
    let probe = Probe::new().await;
    let fence = probe.run().await.unwrap();
    fence.check().await.unwrap();
    let requests = probe.server.requests();
    assert!(
        requests.iter().all(|request| request.starts_with("GET ")),
        "{requests:?}"
    );
    for route in ["/prompt", "/interrupt", "/revert"] {
        assert!(
            !requests.iter().any(|request| request.contains(route)),
            "{requests:?}"
        );
    }
    // Schedules are listed per tree session; terminals for the checkout's location only.
    for id in [ROOT, CHILD] {
        assert!(requests.contains(&format!("GET /api/experimental/schedule?sessionID={id}")));
    }
    let location = format!(
        "location%5Bdirectory%5D={}",
        url::form_urlencoded::byte_serialize(probe.directory.to_string_lossy().as_bytes())
            .collect::<String>()
    );
    for request in &requests {
        let located = request.contains(&location);
        let terminal = request.starts_with("GET /api/shell") || request.starts_with("GET /api/pty");
        assert_eq!(located, terminal, "{request}");
    }
}

#[tokio::test]
async fn a_running_tree_session_refuses() {
    let probe = Probe::new().await;
    probe.server.set(
        "/api/session/active",
        200,
        json!({"data":{ROOT:{"type":"running"}}}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
    probe.server.set(
        "/api/session/active",
        200,
        json!({"data":{CHILD:{"type":"running"}}}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
    // Another session's execution is not this tree's.
    probe.server.set(
        "/api/session/active",
        200,
        json!({"data":{"ses_other":{"type":"running"}}}),
    );
    assert!(probe.run().await.is_ok());
}

#[tokio::test]
async fn a_pending_job_refuses_while_nothing_is_active() {
    let probe = Probe::new().await;
    probe.server.set(
        "/api/experimental/job",
        200,
        json!({"data":[{"id":"job","sessionID":CHILD,"kind":"shell","status":"running"}]}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
    let jobs = probe
        .server
        .requests()
        .into_iter()
        .find(|request| request.starts_with("GET /api/experimental/job"))
        .unwrap();
    assert!(
        jobs.contains("sessionID=ses_root") && jobs.contains("descendants=true"),
        "{jobs}"
    );
}

#[tokio::test]
async fn parked_input_or_a_pending_form_refuses() {
    let probe = Probe::new().await;
    probe.server.set(
        "/api/session/ses_child/inbox",
        200,
        json!({"data":[{"id":"msg"}]}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
    probe
        .server
        .set("/api/session/ses_child/inbox", 200, json!({"data":[]}));
    probe.server.set(
        "/api/session/ses_root/form",
        200,
        json!({"data":[{"id":"form"}]}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
}

#[tokio::test]
async fn an_execution_without_a_terminal_event_refuses() {
    let probe = Probe::new().await;
    probe.server.set(
        "/api/session/ses_root",
        200,
        json!({"data":{"id":ROOT,"time":{"created":1,"busy":12,"idle":9}}}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
    probe.server.set(
        "/api/session/ses_root",
        200,
        json!({"data":{"id":ROOT,"time":{"created":1,"busy":12}}}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
}

#[tokio::test]
async fn schedules_refuse_only_when_one_can_fire() {
    let probe = Probe::new().await;
    let route = "/api/experimental/schedule?sessionID=ses_child";
    probe
        .server
        .set(route, 200, json!({"data":[{"id":"sch","status":"active"}]}));
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
    probe.server.set(
        route,
        200,
        json!({"data":[{"id":"sch","status":"paused"},{"id":"old","status":"done"}]}),
    );
    assert!(probe.run().await.is_ok());
    probe.server.set(
        route,
        403,
        json!({"_tag":"ForbiddenError","message":"Scheduled tasks are disabled; set experimental.schedules in config"}),
    );
    assert!(probe.run().await.is_ok());
    // A permission refusal is also a ForbiddenError, and does not show the schedules off.
    probe.server.set(
        route,
        403,
        json!({"_tag":"ForbiddenError","message":"blocked"}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Unreadable));
    probe.server.remove(route);
    probe.server.remove("/api/experimental/schedule");
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Unreadable));
}

#[tokio::test]
async fn a_terminal_in_the_checkout_refuses() {
    let probe = Probe::new().await;
    probe.server.set(
        "/api/shell",
        200,
        json!({"location":{"directory":probe.inside()},"data":[{"id":"sh","status":"running"}]}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
    probe.server.set("/api/shell", 200, json!({"data":[]}));
    probe.server.set(
        "/api/pty",
        200,
        json!({"data":[{"id":"pty","status":"running"}]}),
    );
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Working));
    // An exited PTY is kept until removed, and writes nothing.
    probe.server.set(
        "/api/pty",
        200,
        json!({"data":[{"id":"pty","status":"exited"}]}),
    );
    assert!(probe.run().await.is_ok());
    probe.server.remove("/api/pty");
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Unreadable));
}

#[tokio::test]
async fn a_server_without_the_job_route_cannot_be_read() {
    let probe = Probe::new().await;
    probe.server.remove("/api/experimental/job");
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::Unreadable));
}

#[tokio::test]
async fn one_budget_covers_every_probe_of_a_restore() {
    let probe = Probe::new().await;
    probe.server.stall("/api/experimental/job");
    let started = Instant::now();
    let budget = Duration::from_millis(600);
    assert_eq!(
        super::probe(&probe.target(), started + budget).await.err(),
        Some(QuietRefusal::Unreadable)
    );
    assert!(started.elapsed() < budget + Duration::from_millis(400));
    // Two siblings: the first answers slowly, the second never; the shared deadline ends both.
    let first = Probe::new().await;
    first
        .server
        .delay("/api/experimental/job", Duration::from_millis(400));
    let started = Instant::now();
    let deadline = started + budget;
    let fence = super::probe(&first.target(), deadline).await.unwrap();
    assert_eq!(
        super::probe(&probe.target(), deadline).await.err(),
        Some(QuietRefusal::Unreadable)
    );
    assert!(
        started.elapsed() < budget + Duration::from_millis(400),
        "refused when the shared budget ran out, not after a budget of its own"
    );
    drop(fence);
}

#[tokio::test]
async fn an_opencode_1_server_is_refused_before_any_session_read() {
    let probe = Probe::new().await;
    probe
        .server
        .set("/global/health", 200, json!({"healthy":true}));
    assert_eq!(probe.run().await.err(), Some(QuietRefusal::OpenCode1));
    assert!(
        !probe
            .server
            .requests()
            .iter()
            .any(|request| request.contains("/api/session")),
        "{:?}",
        probe.server.requests()
    );
}

#[tokio::test]
async fn a_start_in_the_tree_or_the_checkout_trips_the_fence() {
    let probe = Probe::new().await;
    let fence = probe.run().await.unwrap();
    probe
        .server
        .push(&started("ses_elsewhere", Some("/somewhere/else")));
    untripped(&fence).await;
    probe.server.push(&started(CHILD, Some("/somewhere/else")));
    assert!(tripped(&fence).await.contains(CHILD));
    assert!(fence.check().await.is_err());

    let fence = probe.run().await.unwrap();
    probe
        .server
        .push(&started("ses_other", Some(&probe.inside())));
    tripped(&fence).await;

    let fence = probe.run().await.unwrap();
    probe.server.push(&started("ses_other", None));
    tripped(&fence).await;
}

#[tokio::test]
async fn a_reconnect_an_end_a_silence_or_a_restart_trips_the_fence() {
    let probe = Probe::new().await;
    let fence = probe.run().await.unwrap();
    probe
        .server
        .push(&json!({"id":"evt","type":"server.connected","data":{}}));
    tripped(&fence).await;

    let fence = probe.run().await.unwrap();
    probe.server.close_streams();
    assert!(tripped(&fence).await.contains("ended"));

    // Heartbeats keep a quiet stream alive; silence does not.
    let fence = probe
        .run_silent_after(Duration::from_millis(300))
        .await
        .unwrap();
    for _ in 0..4 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        probe.server.heartbeat();
    }
    fence.check().await.unwrap();
    assert!(tripped(&fence).await.contains("silent"));

    let fence = probe.run().await.unwrap();
    probe.server.set_pid(101);
    assert_eq!(fence.check().await.unwrap_err(), "the server restarted");
}

#[tokio::test]
async fn dropping_the_fence_closes_its_stream() {
    let probe = Probe::new().await;
    let fence = probe.run().await.unwrap();
    assert_eq!(probe.server.open_streams(), 1);
    drop(fence);
    tokio::time::timeout(WAIT, async {
        while probe.server.open_streams() != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the server sees the stream end");
}

#[tokio::test]
async fn the_reverting_sessions_own_rewind_does_not_trip_the_fence() {
    let probe = Probe::new().await;
    let inside = probe.inside();
    let fence = probe.run().await.unwrap();
    probe.server.push(&event(
        "session.revert.staged",
        "ses_reverting",
        Some(&inside),
    ));
    probe.server.push(&event(
        "session.revert.committed",
        "ses_reverting",
        Some(&inside),
    ));
    untripped(&fence).await;
    probe.server.push(&started("ses_reverting", Some(&inside)));
    tripped(&fence).await;

    let fence = probe.run().await.unwrap();
    probe.server.push(&event(
        "session.revert.staged",
        ROOT,
        Some("/somewhere/else"),
    ));
    tripped(&fence).await;
}
