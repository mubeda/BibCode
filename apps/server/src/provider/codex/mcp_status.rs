use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Weak},
    task::{Context, Poll},
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::protocol::JsonRpcConnection;

const PRE_ROOT_LIMIT: usize = 64;
pub(crate) const MCP_STATUS_PAGE_LIMIT: usize = 8;
pub(crate) const MCP_STATUS_PAGE_SIZE: u32 = 50;
pub(crate) const MCP_STATUS_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum McpServerState {
    Connected,
    Starting,
    NeedsAuth,
    Disconnected,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerStatus {
    pub(crate) name: String,
    pub(crate) state: McpServerState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
}

pub(crate) type McpLoadResult = Result<BTreeMap<String, McpServerStatus>, String>;

#[derive(Clone)]
pub(crate) struct McpStatusHandle {
    sender: mpsc::Sender<McpStatusCommand>,
}

pub(crate) struct McpOpenCompletion {
    completion: oneshot::Receiver<Result<(), String>>,
    _ownership: Arc<McpOpenOwnership>,
}

pub(crate) struct McpOpenReservation {
    completion: oneshot::Receiver<Result<(), String>>,
    ownership: oneshot::Receiver<Arc<McpOpenOwnership>>,
}

pub(crate) struct McpOpenOwnership {
    cancellation: CancellationToken,
}

impl Drop for McpOpenOwnership {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

impl Future for McpOpenCompletion {
    type Output = Result<Result<(), String>, oneshot::error::RecvError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.completion).poll(context)
    }
}

impl McpOpenCompletion {
    pub(crate) async fn cancel(mut self) {
        self._ownership.cancellation.cancel();
        let _ = (&mut self.completion).await;
    }
}

impl McpOpenReservation {
    pub(crate) async fn into_completion(self) -> Result<McpOpenCompletion, String> {
        let ownership = self
            .ownership
            .await
            .map_err(|_| "MCP status actor stopped before accepting an opening".to_owned())?;
        Ok(McpOpenCompletion {
            completion: self.completion,
            _ownership: ownership,
        })
    }
}

pub(crate) enum McpStatusEffect {
    Load {
        epoch: u64,
        generation: u64,
        root: String,
    },
    Snapshot(Vec<McpServerStatus>),
    Warning(String),
    Complete(Vec<oneshot::Sender<Result<(), String>>>),
}

pub(crate) enum McpStatusCommand {
    BeginOpen {
        done: oneshot::Sender<Result<(), String>>,
        ownership: oneshot::Sender<Arc<McpOpenOwnership>>,
    },
    BindRoot {
        root: String,
    },
    Refresh {
        done: oneshot::Sender<Result<(), String>>,
    },
    Notification {
        root: Option<String>,
        server: McpServerStatus,
    },
    LoadFinished {
        epoch: u64,
        generation: u64,
        result: McpLoadResult,
    },
    #[cfg(test)]
    SnapshotForTest {
        done: oneshot::Sender<Vec<McpServerStatus>>,
    },
    Shutdown {
        done: oneshot::Sender<()>,
    },
}

struct McpStatusState {
    root: Option<String>,
    epoch: u64,
    generation: u64,
    in_flight: Option<InFlightRefresh>,
    servers: BTreeMap<String, McpServerStatus>,
    pre_root: VecDeque<(Option<String>, McpServerStatus)>,
}

struct InFlightRefresh {
    epoch: u64,
    generation: u64,
    opening: bool,
    opening_ownership: Option<OpeningOwnership>,
    root_changed: bool,
    overlay: BTreeMap<String, McpServerStatus>,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
}

struct OpeningOwnership {
    owner: Weak<McpOpenOwnership>,
    cancellation: CancellationToken,
}

impl McpStatusHandle {
    pub(crate) fn channel(capacity: usize) -> (Self, mpsc::Receiver<McpStatusCommand>) {
        let (sender, receiver) = mpsc::channel(capacity);
        (Self { sender }, receiver)
    }

    pub(crate) async fn begin_open(&self) -> Result<McpOpenCompletion, String> {
        let (command, reservation) = Self::opening();
        self.send(command).await?;
        reservation.into_completion().await
    }

    pub(crate) fn reserve_open(&self) -> Result<McpOpenReservation, String> {
        let (command, reservation) = Self::opening();
        self.sender
            .try_send(command)
            .map_err(|_| "MCP status actor is unavailable".to_owned())?;
        Ok(reservation)
    }

    fn opening() -> (McpStatusCommand, McpOpenReservation) {
        let (done_tx, done_rx) = oneshot::channel();
        let (ownership_tx, ownership_rx) = oneshot::channel();
        (
            McpStatusCommand::BeginOpen {
                done: done_tx,
                ownership: ownership_tx,
            },
            McpOpenReservation {
                completion: done_rx,
                ownership: ownership_rx,
            },
        )
    }

    pub(crate) async fn refresh(&self) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let (done_tx, done_rx) = oneshot::channel();
        self.send(McpStatusCommand::Refresh { done: done_tx })
            .await?;
        Ok(done_rx)
    }

    pub(crate) async fn bind_root(&self, root: String) -> Result<(), String> {
        self.send(McpStatusCommand::BindRoot { root }).await
    }

    pub(crate) async fn notification(
        &self,
        root: Option<String>,
        server: McpServerStatus,
    ) -> Result<(), String> {
        self.send(McpStatusCommand::Notification { root, server })
            .await
    }

    pub(crate) async fn load_finished(
        &self,
        epoch: u64,
        generation: u64,
        result: McpLoadResult,
    ) -> Result<(), String> {
        self.send(McpStatusCommand::LoadFinished {
            epoch,
            generation,
            result,
        })
        .await
    }

    #[cfg(test)]
    pub(crate) async fn snapshot_for_test(&self) -> Result<Vec<McpServerStatus>, String> {
        let (done_tx, done_rx) = oneshot::channel();
        self.send(McpStatusCommand::SnapshotForTest { done: done_tx })
            .await?;
        done_rx
            .await
            .map_err(|_| "MCP status actor stopped before returning its snapshot".to_owned())
    }

    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        let (done_tx, done_rx) = oneshot::channel();
        self.send(McpStatusCommand::Shutdown { done: done_tx })
            .await?;
        done_rx
            .await
            .map_err(|_| "MCP status actor stopped before shutdown completed".to_owned())
    }

    async fn send(&self, command: McpStatusCommand) -> Result<(), String> {
        self.sender
            .send(command)
            .await
            .map_err(|_| "MCP status actor is unavailable".to_owned())
    }
}

pub(crate) async fn run_actor(
    mut receiver: mpsc::Receiver<McpStatusCommand>,
    effects_tx: mpsc::UnboundedSender<McpStatusEffect>,
) {
    let mut state = McpStatusState {
        root: None,
        epoch: 0,
        generation: 0,
        in_flight: None,
        servers: BTreeMap::new(),
        pre_root: VecDeque::new(),
    };

    loop {
        let opening_cancellation = state
            .in_flight
            .as_ref()
            .and_then(|in_flight| in_flight.opening_ownership.as_ref())
            .map(|ownership| ownership.cancellation.clone());
        let command = if let Some(cancellation) = opening_cancellation {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    cancel_open(&mut state, "MCP status opening was cancelled".to_owned());
                    continue;
                }
                command = receiver.recv() => command,
            }
        } else {
            receiver.recv().await
        };
        let Some(command) = command else {
            break;
        };
        match command {
            McpStatusCommand::BeginOpen { done, ownership } => {
                begin_open(&mut state, done, ownership);
            }
            McpStatusCommand::BindRoot { root } => bind_root(&mut state, root, &effects_tx),
            McpStatusCommand::Refresh { done } => refresh(&mut state, done, &effects_tx),
            McpStatusCommand::Notification { root, server } => {
                notification(&mut state, root, server, &effects_tx);
            }
            McpStatusCommand::LoadFinished {
                epoch,
                generation,
                result,
            } => finish_load(&mut state, epoch, generation, result, &effects_tx),
            #[cfg(test)]
            McpStatusCommand::SnapshotForTest { done } => {
                let _ = done.send(snapshot(&state.servers));
            }
            McpStatusCommand::Shutdown { done } => {
                if let Some(in_flight) = state.in_flight.take() {
                    for waiter in in_flight.waiters {
                        let _ = waiter.send(Err("MCP status actor shut down".to_owned()));
                    }
                }
                let _ = done.send(());
                return;
            }
        }
    }
}

fn begin_open(
    state: &mut McpStatusState,
    done: oneshot::Sender<Result<(), String>>,
    ownership: oneshot::Sender<Arc<McpOpenOwnership>>,
) {
    if let Some(owner) = state
        .in_flight
        .as_ref()
        .filter(|in_flight| in_flight.opening)
        .and_then(|in_flight| in_flight.opening_ownership.as_ref())
        .and_then(|ownership| ownership.owner.upgrade())
    {
        state
            .in_flight
            .as_mut()
            .expect("checked above")
            .waiters
            .push(done);
        let _ = ownership.send(owner);
        return;
    }
    if state
        .in_flight
        .as_ref()
        .is_some_and(|in_flight| in_flight.opening)
    {
        cancel_open(state, "MCP status opening was cancelled".to_owned());
    }

    let mut waiters = state
        .in_flight
        .take()
        .map_or_else(Vec::new, |in_flight| in_flight.waiters);
    waiters.push(done);
    state.generation = state.generation.wrapping_add(1);
    state.pre_root.clear();
    let cancellation = CancellationToken::new();
    let owner = Arc::new(McpOpenOwnership {
        cancellation: cancellation.clone(),
    });
    state.in_flight = Some(InFlightRefresh {
        epoch: state.epoch,
        generation: state.generation,
        opening: true,
        opening_ownership: Some(OpeningOwnership {
            owner: Arc::downgrade(&owner),
            cancellation,
        }),
        root_changed: false,
        overlay: BTreeMap::new(),
        waiters,
    });
    let _ = ownership.send(owner);
}

fn cancel_open(state: &mut McpStatusState, error: String) {
    let Some(in_flight) = state.in_flight.take_if(|in_flight| in_flight.opening) else {
        return;
    };
    state.pre_root.clear();
    for waiter in in_flight.waiters {
        let _ = waiter.send(Err(error.clone()));
    }
}

fn bind_root(
    state: &mut McpStatusState,
    root: String,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
) {
    let changed = state.root.as_deref() != Some(root.as_str());
    if changed {
        state.root = Some(root.clone());
        state.epoch = state.epoch.wrapping_add(1);
        state.servers.clear();
    }

    if changed
        && state
            .in_flight
            .as_ref()
            .is_some_and(|in_flight| !in_flight.opening)
    {
        let waiters = state.in_flight.take().expect("checked above").waiters;
        state.generation = state.generation.wrapping_add(1);
        state.pre_root.clear();
        let epoch = state.epoch;
        let generation = state.generation;
        state.in_flight = Some(InFlightRefresh {
            epoch,
            generation,
            opening: false,
            opening_ownership: None,
            root_changed: true,
            overlay: BTreeMap::new(),
            waiters,
        });
        dispatch_load(state, effects_tx, epoch, generation, root);
        return;
    }

    if state.in_flight.is_none() {
        state.generation = state.generation.wrapping_add(1);
        state.in_flight = Some(InFlightRefresh {
            epoch: state.epoch,
            generation: state.generation,
            opening: true,
            opening_ownership: None,
            root_changed: changed,
            overlay: BTreeMap::new(),
            waiters: Vec::new(),
        });
    }

    let staged = state
        .pre_root
        .drain(..)
        .filter(|(notification_root, _)| matches_root(notification_root.as_deref(), &root))
        .collect::<Vec<_>>();
    let (epoch, generation) = {
        let Some(in_flight) = state.in_flight.as_mut() else {
            return;
        };
        if !in_flight.opening {
            return;
        }
        in_flight.epoch = state.epoch;
        in_flight.root_changed |= changed;
        for (_, server) in staged {
            in_flight.overlay.insert(server.name.clone(), server);
        }
        in_flight.opening = false;
        in_flight.opening_ownership = None;
        (in_flight.epoch, in_flight.generation)
    };
    dispatch_load(state, effects_tx, epoch, generation, root);
}

fn refresh(
    state: &mut McpStatusState,
    done: oneshot::Sender<Result<(), String>>,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
) {
    if let Some(in_flight) = state.in_flight.as_mut() {
        in_flight.waiters.push(done);
        return;
    }
    let Some(root) = state.root.clone() else {
        let _ = done.send(Err("MCP status root is not bound".to_owned()));
        return;
    };
    state.generation = state.generation.wrapping_add(1);
    let in_flight = InFlightRefresh {
        epoch: state.epoch,
        generation: state.generation,
        opening: false,
        opening_ownership: None,
        root_changed: false,
        overlay: BTreeMap::new(),
        waiters: vec![done],
    };
    let epoch = in_flight.epoch;
    let generation = in_flight.generation;
    state.in_flight = Some(in_flight);
    dispatch_load(state, effects_tx, epoch, generation, root);
}

fn dispatch_load(
    state: &mut McpStatusState,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
    epoch: u64,
    generation: u64,
    root: String,
) {
    if effects_tx
        .send(McpStatusEffect::Load {
            epoch,
            generation,
            root,
        })
        .is_err()
    {
        if let Some(in_flight) = state.in_flight.take() {
            for waiter in in_flight.waiters {
                let _ = waiter.send(Err("MCP status effect receiver is unavailable".to_owned()));
            }
        }
    }
}

fn notification(
    state: &mut McpStatusState,
    root: Option<String>,
    server: McpServerStatus,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
) {
    if state
        .in_flight
        .as_ref()
        .is_some_and(|in_flight| in_flight.opening)
    {
        if state.pre_root.len() == PRE_ROOT_LIMIT {
            state.pre_root.pop_front();
        }
        state.pre_root.push_back((root, server));
        return;
    }
    let Some(bound_root) = state.root.as_deref() else {
        return;
    };
    if !matches_root(root.as_deref(), bound_root) {
        return;
    }
    if let Some(in_flight) = state.in_flight.as_mut() {
        in_flight.overlay.insert(server.name.clone(), server);
        return;
    }
    if state.servers.get(&server.name) == Some(&server) {
        return;
    }
    state.servers.insert(server.name.clone(), server);
    let _ = effects_tx.send(McpStatusEffect::Snapshot(snapshot(&state.servers)));
}

fn finish_load(
    state: &mut McpStatusState,
    epoch: u64,
    generation: u64,
    result: McpLoadResult,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
) {
    if state
        .in_flight
        .as_ref()
        .is_none_or(|in_flight| in_flight.epoch != epoch || in_flight.generation != generation)
    {
        return;
    }
    let in_flight = state.in_flight.take().expect("checked above");
    state.pre_root.clear();
    match result {
        Ok(mut baseline) => {
            baseline.extend(in_flight.overlay);
            state.servers = baseline;
            let _ = effects_tx.send(McpStatusEffect::Snapshot(snapshot(&state.servers)));
        }
        Err(error) => {
            let mut visible = if in_flight.root_changed {
                BTreeMap::new()
            } else {
                state.servers.clone()
            };
            visible.extend(in_flight.overlay);
            let changed = in_flight.root_changed || visible != state.servers;
            state.servers = visible;
            if changed {
                let _ = effects_tx.send(McpStatusEffect::Snapshot(snapshot(&state.servers)));
            }
            let _ = effects_tx.send(McpStatusEffect::Warning(format!(
                "MCP status discovery failed: {error}"
            )));
        }
    }
    let _ = effects_tx.send(McpStatusEffect::Complete(in_flight.waiters));
}

fn matches_root(notification_root: Option<&str>, root: &str) -> bool {
    notification_root.is_none_or(|notification_root| notification_root == root)
}

fn snapshot(servers: &BTreeMap<String, McpServerStatus>) -> Vec<McpServerStatus> {
    servers.values().cloned().collect()
}

pub(crate) async fn refresh_mcp_status_snapshot(
    connection: &JsonRpcConnection,
    root: &str,
) -> McpLoadResult {
    let mut servers = BTreeMap::new();
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    for _ in 0..MCP_STATUS_PAGE_LIMIT {
        let mut params = serde_json::json!({
            "threadId": root,
            "limit": MCP_STATUS_PAGE_SIZE,
            "detail": "toolsAndAuthOnly",
        });
        if let Some(cursor) = cursor.as_ref() {
            params["cursor"] = serde_json::json!(cursor);
        }
        let cancellation = CancellationToken::new();
        let request = connection.request_cancellable("mcpServerStatus/list", params, &cancellation);
        tokio::pin!(request);
        let response = match tokio::time::timeout(MCP_STATUS_REQUEST_TIMEOUT, &mut request).await {
            Ok(result) => result.map_err(|error| error.to_string())?,
            Err(_) => {
                cancellation.cancel();
                let _ = request.await;
                return Err("mcpServerStatus/list request timed out".to_owned());
            }
        };
        let data = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "mcpServerStatus/list response missing data array".to_owned())?;
        for server in data.iter().map(mcp_server_status_from_snapshot) {
            let server = server?;
            servers.insert(server.name.clone(), server);
        }
        match response.get("nextCursor") {
            None | Some(Value::Null) => return Ok(servers),
            Some(Value::String(next_cursor)) if !next_cursor.trim().is_empty() => {
                if !seen_cursors.insert(next_cursor.clone()) {
                    return Err("mcpServerStatus/list response repeated nextCursor".to_owned());
                }
                cursor = Some(next_cursor.clone());
            }
            _ => return Err("mcpServerStatus/list response has invalid nextCursor".to_owned()),
        }
    }
    Err("mcpServerStatus/list response exceeded page limit".to_owned())
}

pub(crate) fn mcp_server_status_from_snapshot(server: &Value) -> Result<McpServerStatus, String> {
    let name = server
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "mcpServerStatus/list row missing a non-empty name".to_owned())?;
    let (state, detail) = match server.get("authStatus").and_then(Value::as_str) {
        Some("unsupported" | "bearerToken" | "oAuth") => (McpServerState::Starting, None),
        Some("notLoggedIn") => (
            McpServerState::NeedsAuth,
            Some("Authentication required.".to_owned()),
        ),
        Some(other) => {
            return Err(format!(
                "mcpServerStatus/list row has unsupported authStatus {other}"
            ));
        }
        None => return Err("mcpServerStatus/list row missing authStatus".to_owned()),
    };
    Ok(McpServerStatus {
        name: name.to_owned(),
        state,
        detail,
    })
}

pub(crate) fn mcp_server_status_from_notification(params: &Value) -> Option<McpServerStatus> {
    mcp_server_status(
        params.get("name")?.as_str()?,
        params.get("status")?.as_str()?,
        params.get("error").and_then(Value::as_str),
        params.get("failureReason").and_then(Value::as_str),
    )
}

pub(crate) fn mcp_server_status(
    name: &str,
    status: &str,
    error: Option<&str>,
    failure_reason: Option<&str>,
) -> Option<McpServerStatus> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let state = match status {
        "ready" | "connected" => McpServerState::Connected,
        "starting" => McpServerState::Starting,
        "cancelled" | "disconnected" => McpServerState::Disconnected,
        "failed" if failure_reason == Some("reauthenticationRequired") => McpServerState::NeedsAuth,
        "failed" | "error" => McpServerState::Error,
        "needs-auth" => McpServerState::NeedsAuth,
        _ => return None,
    };
    let detail = error.map(str::trim).filter(|detail| !detail.is_empty());
    Some(McpServerStatus {
        name: name.to_owned(),
        state,
        detail: detail.map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use tokio::sync::mpsc;

    use super::*;

    fn server(name: &str, state: McpServerState) -> McpServerStatus {
        McpServerStatus {
            name: name.to_owned(),
            state,
            detail: None,
        }
    }

    fn map<const N: usize>(servers: [McpServerStatus; N]) -> BTreeMap<String, McpServerStatus> {
        servers
            .into_iter()
            .map(|server| (server.name.clone(), server))
            .collect()
    }

    fn names(servers: &[McpServerStatus]) -> Vec<&str> {
        servers.iter().map(|server| server.name.as_str()).collect()
    }

    #[tokio::test]
    async fn stages_notifications_until_the_opening_load_completes() {
        // Mutation caught: committing an in-flight notification emits an incomplete snapshot.
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
        let actor = tokio::spawn(run_actor(receiver, effects_tx));

        let opening = handle.begin_open().await.unwrap();
        handle
            .notification(
                Some("root-1".into()),
                server("before", McpServerState::Connected),
            )
            .await
            .unwrap();
        handle.bind_root("root-1".into()).await.unwrap();

        let McpStatusEffect::Load {
            epoch,
            generation,
            root,
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected list load");
        };
        assert_eq!(root, "root-1");

        handle
            .notification(
                Some("root-1".into()),
                server("during", McpServerState::Starting),
            )
            .await
            .unwrap();
        assert!(effects_rx.try_recv().is_err());

        handle
            .load_finished(
                epoch,
                generation,
                Ok(map([server("seed", McpServerState::Connected)])),
            )
            .await
            .unwrap();
        let McpStatusEffect::Snapshot(snapshot) = effects_rx.recv().await.unwrap() else {
            panic!("expected complete snapshot");
        };
        assert_eq!(names(&snapshot), vec!["before", "during", "seed"]);
        drop(opening);
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn opening_retains_exact_last_sixty_four_notifications_before_filtering_root() {
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
        let actor = tokio::spawn(run_actor(receiver, effects_tx));

        let opening = handle.begin_open().await.unwrap();
        for index in 0..PRE_ROOT_LIMIT + 2 {
            handle
                .notification(
                    Some(if index % 2 == 0 {
                        "matching-root".to_owned()
                    } else {
                        "foreign-root".to_owned()
                    }),
                    server(&format!("server-{index:02}"), McpServerState::Connected),
                )
                .await
                .unwrap();
        }
        handle.bind_root("matching-root".into()).await.unwrap();
        let McpStatusEffect::Load {
            epoch, generation, ..
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected list load");
        };
        handle
            .load_finished(epoch, generation, Ok(BTreeMap::new()))
            .await
            .unwrap();
        let McpStatusEffect::Snapshot(snapshot) = effects_rx.recv().await.unwrap() else {
            panic!("expected complete snapshot");
        };
        assert_eq!(
            snapshot
                .iter()
                .map(|server| server.name.clone())
                .collect::<Vec<_>>(),
            (2..=PRE_ROOT_LIMIT)
                .step_by(2)
                .map(|index| format!("server-{index:02}"))
                .collect::<Vec<_>>()
        );

        drop(opening);
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn changed_root_failure_only_publishes_new_root_observations() {
        // Mutation caught: retaining old-root committed servers after a failed new-root load.
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
        let actor = tokio::spawn(run_actor(receiver, effects_tx));

        let old_opening = handle.begin_open().await.unwrap();
        handle.bind_root("old-root".into()).await.unwrap();
        let McpStatusEffect::Load {
            epoch, generation, ..
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected old-root load");
        };
        handle
            .load_finished(
                epoch,
                generation,
                Ok(map([server("old-only", McpServerState::Connected)])),
            )
            .await
            .unwrap();
        let _ = effects_rx.recv().await;
        let _ = effects_rx.recv().await;
        drop(old_opening);

        let new_opening = handle.begin_open().await.unwrap();
        handle
            .notification(
                Some("old-root".into()),
                server("late-old", McpServerState::Connected),
            )
            .await
            .unwrap();
        handle.bind_root("new-root".into()).await.unwrap();
        let McpStatusEffect::Load {
            epoch, generation, ..
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected new-root load");
        };
        handle
            .notification(
                Some("new-root".into()),
                server("new-only", McpServerState::Starting),
            )
            .await
            .unwrap();
        handle
            .load_finished(epoch, generation, Err("list unavailable".to_owned()))
            .await
            .unwrap();

        let McpStatusEffect::Snapshot(new_root_failure_snapshot) = effects_rx.recv().await.unwrap()
        else {
            panic!("expected new-root snapshot");
        };
        assert_eq!(names(&new_root_failure_snapshot), vec!["new-only"]);
        assert!(!names(&new_root_failure_snapshot).contains(&"old-only"));
        assert!(!names(&new_root_failure_snapshot).contains(&"late-old"));
        assert!(matches!(
            effects_rx.recv().await,
            Some(McpStatusEffect::Warning(_))
        ));
        let _ = effects_rx.recv().await;
        drop(new_opening);
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn overlapping_refreshes_coalesce_and_late_old_epoch_success_is_ignored() {
        // Mutation caught: a second refresh starts duplicate I/O or applies a stale root result.
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
        let actor = tokio::spawn(run_actor(receiver, effects_tx));

        let opening = handle.begin_open().await.unwrap();
        let refresh = handle.refresh().await.unwrap();
        handle.bind_root("root-1".into()).await.unwrap();
        let McpStatusEffect::Load {
            epoch: old_epoch,
            generation: old_generation,
            ..
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected first load");
        };
        assert!(effects_rx.try_recv().is_err());

        let replacement_opening = handle.begin_open().await.unwrap();
        handle.bind_root("root-2".into()).await.unwrap();
        let McpStatusEffect::Load {
            epoch, generation, ..
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected replacement load");
        };
        handle
            .load_finished(
                old_epoch,
                old_generation,
                Ok(map([server("old-only", McpServerState::Connected)])),
            )
            .await
            .unwrap();
        assert!(effects_rx.try_recv().is_err());

        handle
            .load_finished(
                epoch,
                generation,
                Ok(map([server("new-only", McpServerState::Connected)])),
            )
            .await
            .unwrap();
        let McpStatusEffect::Snapshot(snapshot) = effects_rx.recv().await.unwrap() else {
            panic!("expected replacement snapshot");
        };
        assert_eq!(names(&snapshot), vec!["new-only"]);
        drop((opening, refresh, replacement_opening));
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn root_change_during_refresh_replaces_the_old_load() {
        // Mutation caught: accepting an old-root result after the root has changed.
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
        let actor = tokio::spawn(run_actor(receiver, effects_tx));

        let opening = handle.begin_open().await.unwrap();
        handle.bind_root("old-root".into()).await.unwrap();
        let McpStatusEffect::Load {
            epoch, generation, ..
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected initial load");
        };
        handle
            .load_finished(
                epoch,
                generation,
                Ok(map([server("old-only", McpServerState::Connected)])),
            )
            .await
            .unwrap();
        let _ = effects_rx.recv().await;
        let McpStatusEffect::Complete(waiters) = effects_rx.recv().await.unwrap() else {
            panic!("expected initial completion");
        };
        for waiter in waiters {
            waiter.send(Ok(())).unwrap();
        }
        assert_eq!(opening.await.unwrap(), Ok(()));

        let refresh = handle.refresh().await.unwrap();
        let McpStatusEffect::Load {
            epoch: old_epoch,
            generation: old_generation,
            root,
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected old-root refresh load");
        };
        assert_eq!(root, "old-root");
        handle.bind_root("new-root".into()).await.unwrap();
        let McpStatusEffect::Load {
            epoch,
            generation,
            root,
        } = tokio::time::timeout(std::time::Duration::from_millis(100), effects_rx.recv())
            .await
            .expect("expected replacement load")
            .unwrap()
        else {
            panic!("expected replacement load");
        };
        assert_eq!(root, "new-root");

        handle
            .load_finished(
                old_epoch,
                old_generation,
                Ok(map([server("old-only", McpServerState::Connected)])),
            )
            .await
            .unwrap();
        assert!(effects_rx.try_recv().is_err());

        handle
            .load_finished(
                epoch,
                generation,
                Ok(map([server("new-only", McpServerState::Connected)])),
            )
            .await
            .unwrap();
        let McpStatusEffect::Snapshot(snapshot) = effects_rx.recv().await.unwrap() else {
            panic!("expected new-root snapshot");
        };
        assert_eq!(names(&snapshot), vec!["new-only"]);
        let McpStatusEffect::Complete(waiters) = effects_rx.recv().await.unwrap() else {
            panic!("expected refresh completion");
        };
        for waiter in waiters {
            waiter.send(Ok(())).unwrap();
        }
        assert_eq!(refresh.await.unwrap(), Ok(()));
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn closed_effect_receiver_fails_opening_waiters() {
        // Mutation caught: retaining a completion waiter after the effect worker has stopped.
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, effects_rx) = mpsc::unbounded_channel();
        drop(effects_rx);
        let actor = tokio::spawn(run_actor(receiver, effects_tx));

        let opening = handle.begin_open().await.unwrap();
        handle.bind_root("root-1".into()).await.unwrap();

        let completion = tokio::time::timeout(std::time::Duration::from_millis(100), opening)
            .await
            .expect("effect failure must resolve the opening waiter")
            .unwrap();
        assert!(completion.is_err());
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_same_root_refreshes_emit_one_load_and_complete_both_waiters() {
        // Mutation caught: a second post-bind refresh starts I/O or loses a completion waiter.
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
        let actor = tokio::spawn(run_actor(receiver, effects_tx));

        let opening = handle.begin_open().await.unwrap();
        handle.bind_root("root-1".into()).await.unwrap();
        let McpStatusEffect::Load {
            epoch, generation, ..
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected opening load");
        };
        handle
            .load_finished(epoch, generation, Ok(BTreeMap::new()))
            .await
            .unwrap();
        let _ = effects_rx.recv().await;
        let McpStatusEffect::Complete(waiters) = effects_rx.recv().await.unwrap() else {
            panic!("expected opening completion");
        };
        for waiter in waiters {
            waiter.send(Ok(())).unwrap();
        }
        assert_eq!(opening.await.unwrap(), Ok(()));

        let first = handle.refresh().await.unwrap();
        let second = handle.refresh().await.unwrap();
        let McpStatusEffect::Load {
            epoch,
            generation,
            root,
        } = effects_rx.recv().await.unwrap()
        else {
            panic!("expected one refresh load");
        };
        assert_eq!(root, "root-1");
        assert!(effects_rx.try_recv().is_err());
        handle
            .load_finished(
                epoch,
                generation,
                Ok(map([server("same-root", McpServerState::Connected)])),
            )
            .await
            .unwrap();
        let _ = effects_rx.recv().await;
        let McpStatusEffect::Complete(waiters) = effects_rx.recv().await.unwrap() else {
            panic!("expected refresh completions");
        };
        assert_eq!(waiters.len(), 2);
        for waiter in waiters {
            waiter.send(Ok(())).unwrap();
        }
        assert_eq!(first.await.unwrap(), Ok(()));
        assert_eq!(second.await.unwrap(), Ok(()));
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }
}
