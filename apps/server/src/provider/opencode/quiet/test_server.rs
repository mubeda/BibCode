//! A scripted OpenCode 2 server for the quiet probe (#326): each route's answer is set by the
//! test, the event stream is pushed on cue, and every request is recorded.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{OriginalUri, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::stream;
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub(crate) const ROOT: &str = "ses_root";
pub(crate) const CHILD: &str = "ses_child";

#[derive(Default)]
struct Script {
    /// Answers by `path?query`, then by `path`.
    routes: Mutex<HashMap<String, (u16, Value)>>,
    /// Paths that never answer.
    stalled: Mutex<HashSet<String>>,
    /// Paths that answer after a delay.
    delays: Mutex<HashMap<String, Duration>>,
    requests: Mutex<Vec<String>>,
    streams: Mutex<Vec<mpsc::UnboundedSender<Bytes>>>,
    open_streams: Arc<AtomicUsize>,
    pid: AtomicU64,
}

/// Decrements the open-stream count when the server drops a stream's body.
struct Open(Arc<AtomicUsize>);

impl Drop for Open {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) struct ScriptedOpenCode {
    pub(crate) url: String,
    script: Arc<Script>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ScriptedOpenCode {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl ScriptedOpenCode {
    /// An idle OpenCode 2.2 server: root `ses_root` with child `ses_child`, located in
    /// `checkout`, nothing running, pending, scheduled or open.
    pub(crate) async fn idle(checkout: &std::path::Path) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let script = Arc::new(Script::default());
        script.pid.store(100, Ordering::SeqCst);
        let app = Router::new().fallback(handle).with_state(script.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let server = Self { url, script, task };
        let directory = checkout.to_string_lossy().into_owned();
        server.set(
            "/api/session?parentID=ses_root",
            200,
            json!({"data":[{"id":CHILD,"parentID":ROOT}],"cursor":{}}),
        );
        server.set(
            "/api/session?parentID=ses_child",
            200,
            json!({"data":[],"cursor":{}}),
        );
        server.set("/api/session/active", 200, json!({"data":{}}));
        server.set("/api/experimental/job", 200, json!({"data":[]}));
        for id in [ROOT, CHILD] {
            server.set(&format!("/api/session/{id}/inbox"), 200, json!({"data":[]}));
            server.set(&format!("/api/session/{id}/form"), 200, json!({"data":[]}));
            server.set(
                &format!("/api/experimental/schedule?sessionID={id}"),
                200,
                json!({"data":[]}),
            );
        }
        server.set(
            "/api/session/ses_root",
            200,
            json!({"data":{"id":ROOT,"location":{"directory":directory},"time":{"created":1,"busy":5,"idle":9}}}),
        );
        server.set(
            "/api/session/ses_child",
            200,
            json!({"data":{"id":CHILD,"parentID":ROOT,"location":{"directory":directory},"time":{"created":2}}}),
        );
        server.set(
            "/api/shell",
            200,
            json!({"location":{"directory":directory},"data":[]}),
        );
        server.set(
            "/api/pty",
            200,
            json!({"location":{"directory":directory},"data":[]}),
        );
        server
    }

    pub(crate) fn set(&self, route: &str, status: u16, body: Value) {
        self.script
            .routes
            .lock()
            .unwrap()
            .insert(route.to_owned(), (status, body));
    }

    pub(crate) fn remove(&self, route: &str) {
        self.script.routes.lock().unwrap().remove(route);
    }

    pub(crate) fn stall(&self, path: &str) {
        self.script.stalled.lock().unwrap().insert(path.to_owned());
    }

    pub(crate) fn delay(&self, path: &str, delay: Duration) {
        self.script
            .delays
            .lock()
            .unwrap()
            .insert(path.to_owned(), delay);
    }

    pub(crate) fn set_pid(&self, pid: u64) {
        self.script.pid.store(pid, Ordering::SeqCst);
    }

    /// Every request, as `METHOD /path?query`.
    pub(crate) fn requests(&self) -> Vec<String> {
        self.script.requests.lock().unwrap().clone()
    }

    pub(crate) fn open_streams(&self) -> usize {
        self.script.open_streams.load(Ordering::SeqCst)
    }

    /// Pushes an event frame to every open stream.
    pub(crate) fn push(&self, event: &Value) {
        self.send(format!("data: {event}\n\n"));
    }

    /// Sends a heartbeat comment, as OpenCode 2 does every 15 s.
    pub(crate) fn heartbeat(&self) {
        self.send(": heartbeat\n\n".to_owned());
    }

    /// Ends every open stream.
    pub(crate) fn close_streams(&self) {
        self.script.streams.lock().unwrap().clear();
    }

    fn send(&self, frame: String) {
        for stream in self.script.streams.lock().unwrap().iter() {
            let _ = stream.send(Bytes::from(frame.clone()));
        }
    }
}

/// `session.execution.started` for `session`, located in `directory` when given.
pub(crate) fn started(session: &str, directory: Option<&str>) -> Value {
    event("session.execution.started", session, directory)
}

pub(crate) fn event(kind: &str, session: &str, directory: Option<&str>) -> Value {
    let mut event = json!({"id":"evt","type":kind,"data":{"sessionID":session}});
    if let Some(directory) = directory {
        event["location"] = json!({"directory": directory});
    }
    event
}

async fn handle(State(script): State<Arc<Script>>, uri: OriginalUri) -> Response {
    let path = uri.0.path().to_owned();
    let query = uri.0.query().unwrap_or_default().to_owned();
    script.requests.lock().unwrap().push(format!(
        "GET {path}{}",
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    ));
    if script.stalled.lock().unwrap().contains(&path) {
        std::future::pending::<()>().await;
    }
    let delay = script.delays.lock().unwrap().get(&path).copied();
    if let Some(delay) = delay {
        tokio::time::sleep(delay).await;
    }
    if path == "/api/event" {
        let (sender, receiver) = mpsc::unbounded_channel();
        sender
            .send(Bytes::from(
                "data: {\"id\":\"evt\",\"type\":\"server.connected\",\"data\":{}}\n\n",
            ))
            .unwrap();
        script.streams.lock().unwrap().push(sender);
        script.open_streams.fetch_add(1, Ordering::SeqCst);
        let open = Open(script.open_streams.clone());
        let body = stream::unfold((receiver, open), |(mut receiver, open)| async move {
            let chunk = receiver.recv().await?;
            Some((Ok::<_, std::io::Error>(chunk), (receiver, open)))
        });
        return (
            [(header::CONTENT_TYPE, "text/event-stream")],
            Body::from_stream(body),
        )
            .into_response();
    }
    if path == "/api/info" {
        return axum::Json(json!({"version":"2.2.5","pid":script.pid.load(Ordering::SeqCst)}))
            .into_response();
    }
    let routes = script.routes.lock().unwrap();
    let answer = routes
        .get(&format!("{path}?{query}"))
        .or_else(|| routes.get(&path))
        .cloned();
    drop(routes);
    match answer {
        Some((status, body)) => {
            (StatusCode::from_u16(status).unwrap(), axum::Json(body)).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
