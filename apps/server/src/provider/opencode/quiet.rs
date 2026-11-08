//! Best-effort detection that an external OpenCode 2 server is quiet while BiBCode restores
//! files in a checkout another chat runs on it (#326). The person's "Only BiBCode uses this
//! server" statement is the guarantee; this probe and its fence only refuse or report what they
//! see. See `docs/plans/2026-11-07-external-opencode-quiet-proof-design.md`.

use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use reqwest::{StatusCode, header};
use serde_json::Value;
use tokio::{sync::watch, task::JoinHandle, time::Instant};
use url::Url;

use super::{
    OpenCodeServerApi, activity::MAX_LINEAGE_DEPTH, probe_server_api, sse::OpenCodeSseDecoder,
};

/// The maintainer's decision 4: one budget covers every probe of one restore, across all siblings.
pub(crate) const PROBE_BUDGET: Duration = Duration::from_secs(10);
/// Each request's own bound, as the adapter's delivery lookups.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// OpenCode 2's heartbeat comes every 15 s, so a stream silent this long has stopped.
const SILENCE_LIMIT: Duration = Duration::from_secs(20);
/// A session tree larger than this is not read in full, so it is not shown idle.
const TREE_LIMIT: usize = 50;
/// The schedules route's answer when `experimental.schedules` is off (OpenCode 2.2,
/// `core/src/schedule.ts` `DisabledError`): no schedule can fire.
const SCHEDULES_DISABLED: &str = "Scheduled tasks are disabled";
/// Events that start work, or announce it, for a session.
const STARTS: [&str; 5] = [
    "session.execution.started",
    "session.inbox.enqueued",
    "session.synthetic",
    "session.shell.started",
    "session.revert.staged",
];

/// Why the probe does not show the server quiet.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QuietRefusal {
    /// The server speaks OpenCode 1, which cannot report its work.
    OpenCode1,
    /// The probe saw work running, pending or scheduled.
    Working,
    /// An answer was missing, malformed, refused or late.
    Unreadable,
}

/// The sibling's server and session tree to probe.
pub(crate) struct QuietTarget<'a> {
    pub(crate) endpoint: &'a str,
    pub(crate) password: Option<&'a str>,
    /// The restoring checkout: terminals are listed for it, and events located in it trip.
    pub(crate) checkout: &'a Path,
    pub(crate) root_session_id: &'a str,
    /// The reverting thread's own OpenCode session on this server, whose rewind events
    /// (`session.revert.*`) BiBCode itself causes.
    pub(crate) reverting_session_id: Option<&'a str>,
}

/// Probes the sibling's server within `deadline` and, when it looks quiet, returns the open
/// fence that watches it through the restore.
pub(crate) async fn probe(
    target: &QuietTarget<'_>,
    deadline: Instant,
) -> Result<QuietFence, QuietRefusal> {
    probe_with(target, deadline, SILENCE_LIMIT).await
}

async fn probe_with(
    target: &QuietTarget<'_>,
    deadline: Instant,
    silence: Duration,
) -> Result<QuietFence, QuietRefusal> {
    let client = Client::new(target.endpoint, target.password)?;
    let api = tokio::time::timeout_at(
        deadline,
        probe_server_api(&client.http, target.endpoint, target.password),
    )
    .await
    .map_err(|_| QuietRefusal::Unreadable)?;
    match api {
        OpenCodeServerApi::V2 { .. } => {}
        OpenCodeServerApi::V1 => return Err(QuietRefusal::OpenCode1),
        _ => return Err(QuietRefusal::Unreadable),
    }
    let pid = client.pid(deadline).await?;
    // The fence opens before any status read, so a start published after it is seen.
    let fence = client.open_fence(target, pid, deadline, silence).await?;
    let tree = client.tree(target.root_session_id, deadline).await?;
    fence.tree.send_replace(tree.iter().cloned().collect());
    let active = client
        .get(client.url(&["session", "active"], &[]), deadline)
        .await?;
    let active = active
        .get("data")
        .and_then(Value::as_object)
        .ok_or(QuietRefusal::Unreadable)?;
    if tree.iter().any(|id| active.contains_key(id)) {
        return Err(QuietRefusal::Working);
    }
    let jobs = client
        .get(
            client.url(
                &["experimental", "job"],
                &[
                    ("sessionID", target.root_session_id),
                    ("descendants", "true"),
                ],
            ),
            deadline,
        )
        .await?;
    refuse_any(&jobs, |_| true)?;
    for id in &tree {
        for kind in ["inbox", "form"] {
            let list = client
                .get(client.url(&["session", id, kind], &[]), deadline)
                .await?;
            refuse_any(&list, |_| true)?;
        }
        let session = client
            .get(client.url(&["session", id], &[]), deadline)
            .await?;
        let time = session
            .pointer("/data/time")
            .and_then(Value::as_object)
            .ok_or(QuietRefusal::Unreadable)?;
        let millis = |name| time.get(name).and_then(Value::as_f64);
        match (millis("busy"), millis("idle")) {
            (None, _) => {}
            (Some(busy), Some(idle)) if busy <= idle => {}
            // An execution started and has no terminal event: running, or left by a crash.
            _ => return Err(QuietRefusal::Working),
        }
        let (status, schedules) = client
            .get_status(
                client.url(&["experimental", "schedule"], &[("sessionID", id)]),
                deadline,
            )
            .await?;
        if status == StatusCode::FORBIDDEN && schedules_disabled(&schedules) {
            continue;
        }
        if !status.is_success() {
            return Err(QuietRefusal::Unreadable);
        }
        // `done` cannot fire again; only `active` can.
        refuse_any(&schedules, |schedule| {
            schedule["status"] != "paused" && schedule["status"] != "done"
        })?;
    }
    let checkout = target.checkout.to_string_lossy();
    let location = [("location[directory]", checkout.as_ref())];
    // The shell list holds only running commands; the PTY list keeps exited ones until removed,
    // and an exited PTY writes nothing.
    let shells = client
        .get(client.url(&["shell"], &location), deadline)
        .await?;
    refuse_any(&shells, |_| true)?;
    let ptys = client
        .get(client.url(&["pty"], &location), deadline)
        .await?;
    refuse_any(&ptys, |pty| pty["status"] != "exited")?;
    // A start seen while the reads ran refuses too.
    if fence.tripped().is_some() {
        return Err(QuietRefusal::Working);
    }
    Ok(fence)
}

/// Refuses as working when `response`'s `data` list holds an entry that `counts`.
fn refuse_any(response: &Value, counts: impl Fn(&Value) -> bool) -> Result<(), QuietRefusal> {
    let list = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or(QuietRefusal::Unreadable)?;
    if list.iter().any(counts) {
        return Err(QuietRefusal::Working);
    }
    Ok(())
}

fn schedules_disabled(body: &Value) -> bool {
    body.get("message")
        .and_then(Value::as_str)
        .is_some_and(|message| message.starts_with(SCHEDULES_DISABLED))
}

#[derive(Clone)]
struct Client {
    http: reqwest::Client,
    base: Url,
}

impl Client {
    fn new(endpoint: &str, password: Option<&str>) -> Result<Self, QuietRefusal> {
        let mut headers = header::HeaderMap::new();
        if let Some(password) = password.filter(|password| !password.is_empty()) {
            use base64::Engine as _;
            let credentials =
                base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"));
            let value = header::HeaderValue::from_str(&format!("Basic {credentials}"))
                .map_err(|_| QuietRefusal::Unreadable)?;
            headers.insert(header::AUTHORIZATION, value);
        }
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|_| QuietRefusal::Unreadable)?;
        let base = Url::parse(endpoint).map_err(|_| QuietRefusal::Unreadable)?;
        Ok(Self { http, base })
    }

    fn url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        let mut url = self.base.clone();
        if let Ok(mut path) = url.path_segments_mut() {
            path.pop_if_empty().push("api").extend(segments);
        }
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        url
    }

    /// One bounded read: its status and JSON body (`Null` when the body is not JSON).
    async fn get_status(
        &self,
        url: Url,
        deadline: Instant,
    ) -> Result<(StatusCode, Value), QuietRefusal> {
        let deadline = deadline.min(Instant::now() + REQUEST_TIMEOUT);
        tokio::time::timeout_at(deadline, async {
            let response = self.http.get(url).send().await.ok()?;
            let status = response.status();
            Some((
                status,
                response.json::<Value>().await.unwrap_or(Value::Null),
            ))
        })
        .await
        .ok()
        .flatten()
        .ok_or(QuietRefusal::Unreadable)
    }

    async fn get(&self, url: Url, deadline: Instant) -> Result<Value, QuietRefusal> {
        match self.get_status(url, deadline).await? {
            (status, body) if status.is_success() && !body.is_null() => Ok(body),
            _ => Err(QuietRefusal::Unreadable),
        }
    }

    async fn pid(&self, deadline: Instant) -> Result<u64, QuietRefusal> {
        self.get(self.url(&["info"], &[]), deadline)
            .await?
            .get("pid")
            .and_then(Value::as_u64)
            .ok_or(QuietRefusal::Unreadable)
    }

    /// The root session and its descendants, read to a fixed depth and size; a tree past
    /// either bound, or a paged listing, is not read in full.
    async fn tree(&self, root: &str, deadline: Instant) -> Result<Vec<String>, QuietRefusal> {
        let mut tree = vec![root.to_owned()];
        let mut queue = VecDeque::from([(root.to_owned(), 0_usize)]);
        while let Some((parent, depth)) = queue.pop_front() {
            let children = self
                .get(self.url(&["session"], &[("parentID", &parent)]), deadline)
                .await?;
            if children
                .pointer("/cursor/next")
                .is_some_and(|next| !next.is_null())
            {
                return Err(QuietRefusal::Unreadable);
            }
            let children = children
                .get("data")
                .and_then(Value::as_array)
                .ok_or(QuietRefusal::Unreadable)?;
            for child in children {
                let id = child
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(QuietRefusal::Unreadable)?;
                if depth + 1 >= MAX_LINEAGE_DEPTH || tree.len() >= TREE_LIMIT {
                    return Err(QuietRefusal::Unreadable);
                }
                tree.push(id.to_owned());
                queue.push_back((id.to_owned(), depth + 1));
            }
        }
        Ok(tree)
    }

    /// Opens `GET /api/event`, waits for `server.connected`, and hands the stream to the
    /// fence's watcher.
    async fn open_fence(
        &self,
        target: &QuietTarget<'_>,
        pid: u64,
        deadline: Instant,
        silence: Duration,
    ) -> Result<QuietFence, QuietRefusal> {
        let request_deadline = deadline.min(Instant::now() + REQUEST_TIMEOUT);
        let (mut response, decoder) = tokio::time::timeout_at(request_deadline, async {
            let mut response = self.http.get(self.url(&["event"], &[])).send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let mut decoder = OpenCodeSseDecoder::default();
            loop {
                let chunk = response.chunk().await.ok()??;
                decoder.push(&chunk).ok()?;
                while let Some(event) = next_event(&mut decoder).ok()? {
                    if event["type"] == "server.connected" {
                        return Some((response, decoder));
                    }
                }
            }
        })
        .await
        .ok()
        .flatten()
        .ok_or(QuietRefusal::Unreadable)?;
        let checkout = target.checkout.to_path_buf();
        let filter = Filter {
            canonical_checkout: std::fs::canonicalize(&checkout)
                .unwrap_or_else(|_| checkout.clone()),
            checkout,
            tree: HashSet::new(),
            root: target.root_session_id.to_owned(),
            reverting: target.reverting_session_id.map(str::to_owned),
        };
        let (trip, tripped) = watch::channel(None);
        let trip = Arc::new(trip);
        let watcher_trip = trip.clone();
        let (tree_tx, tree_rx) = watch::channel(HashSet::new());
        let watcher = tokio::spawn(async move {
            let reason = watch_stream(&mut response, decoder, filter, tree_rx, silence).await;
            tracing::warn!(provider = "opencode", %reason, "an external OpenCode server's quiet fence tripped during a file restore");
            watcher_trip.send_replace(Some(reason));
        });
        Ok(QuietFence {
            client: self.clone(),
            pid,
            trip,
            tripped,
            tree: tree_tx,
            watcher,
        })
    }
}

/// Decodes the next complete frame; `None` once no complete frame is buffered. Data-less frames
/// (the heartbeat comment) are skipped.
fn next_event(decoder: &mut OpenCodeSseDecoder) -> Result<Option<Value>, String> {
    loop {
        let before = decoder.buffered_len();
        match decoder.take_event()? {
            Some(event) => return Ok(Some(event)),
            None if decoder.buffered_len() == before => return Ok(None),
            None => {}
        }
    }
}

/// Which events trip the fence.
struct Filter {
    checkout: PathBuf,
    canonical_checkout: PathBuf,
    /// Filled once the probe has read the tree; the root is known from the start.
    tree: HashSet<String>,
    root: String,
    reverting: Option<String>,
}

impl Filter {
    fn trips(&self, event: &Value) -> bool {
        let kind = event["type"].as_str().unwrap_or_default();
        if kind == "server.connected" {
            // A second one: the stream reconnected and events may have been missed.
            return true;
        }
        if !STARTS.contains(&kind) {
            return false;
        }
        let session = event.pointer("/data/sessionID").and_then(Value::as_str);
        if session.is_some()
            && session == self.reverting.as_deref()
            && kind.starts_with("session.revert.")
        {
            return false;
        }
        if session.is_some_and(|session| session == self.root || self.tree.contains(session)) {
            return true;
        }
        match event.pointer("/location/directory").and_then(Value::as_str) {
            None => true,
            Some(directory) => self.inside(Path::new(directory)),
        }
    }

    fn inside(&self, directory: &Path) -> bool {
        directory.starts_with(&self.checkout)
            || directory.starts_with(&self.canonical_checkout)
            || std::fs::canonicalize(directory)
                .is_ok_and(|directory| directory.starts_with(&self.canonical_checkout))
    }
}

/// Reads the stream until something trips the fence; returns why.
async fn watch_stream(
    response: &mut reqwest::Response,
    mut decoder: OpenCodeSseDecoder,
    mut filter: Filter,
    tree: watch::Receiver<HashSet<String>>,
    silence: Duration,
) -> String {
    loop {
        // Any chunk, heartbeat comments included, shows the stream alive.
        let chunk = match tokio::time::timeout(silence, response.chunk()).await {
            Err(_) => return "the event stream went silent".to_owned(),
            Ok(Err(error)) => return format!("the event stream failed: {error}"),
            Ok(Ok(None)) => return "the event stream ended".to_owned(),
            Ok(Ok(Some(chunk))) => chunk,
        };
        if let Err(error) = decoder.push(&chunk) {
            return error;
        }
        if tree.has_changed().unwrap_or(false) {
            filter.tree = tree.borrow().clone();
        }
        loop {
            match next_event(&mut decoder) {
                Err(error) => return error,
                Ok(None) => break,
                Ok(Some(event)) if filter.trips(&event) => {
                    return format!(
                        "{} for session {}",
                        event["type"].as_str().unwrap_or("an event"),
                        event
                            .pointer("/data/sessionID")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                    );
                }
                Ok(Some(_)) => {}
            }
        }
    }
}

/// The open event stream of a probed server, watched through the restore. Dropping it closes
/// the stream.
pub struct QuietFence {
    client: Client,
    pid: u64,
    trip: Arc<watch::Sender<Option<String>>>,
    tripped: watch::Receiver<Option<String>>,
    tree: watch::Sender<HashSet<String>>,
    watcher: JoinHandle<()>,
}

impl QuietFence {
    fn tripped(&self) -> Option<String> {
        self.tripped.borrow().clone()
    }

    /// `Err` with the reason once the fence has tripped, or when the server's process changed
    /// or cannot be read.
    pub(crate) async fn check(&self) -> Result<(), String> {
        if let Some(reason) = self.tripped() {
            return Err(reason);
        }
        let reason = match self.client.pid(Instant::now() + REQUEST_TIMEOUT).await {
            Ok(pid) if pid == self.pid => return self.tripped().map_or(Ok(()), Err),
            Ok(_) => "the server restarted".to_owned(),
            Err(_) => "the server's process could not be read".to_owned(),
        };
        tracing::warn!(provider = "opencode", %reason, "an external OpenCode server's quiet fence tripped during a file restore");
        self.trip.send_replace(Some(reason.clone()));
        Err(reason)
    }

    /// Lets a test wait until the watcher has seen a trip.
    #[cfg(test)]
    pub(crate) fn trips(&self) -> watch::Receiver<Option<String>> {
        self.tripped.clone()
    }
}

impl Drop for QuietFence {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}

#[cfg(test)]
pub(crate) mod test_server;
#[cfg(test)]
mod tests;
