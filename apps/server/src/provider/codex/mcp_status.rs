use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Weak},
    task::{Context, Poll},
};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const PRE_ROOT_LIMIT: usize = 64;

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
    Snapshot(Vec<McpServerStatus>),
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
    opening: Option<Opening>,
    servers: BTreeMap<String, McpServerStatus>,
    pre_root: VecDeque<(Option<String>, McpServerStatus)>,
}

struct Opening {
    ownership: OpeningOwnership,
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
        opening: None,
        servers: BTreeMap::new(),
        pre_root: VecDeque::new(),
    };

    loop {
        let opening_cancellation = state
            .opening
            .as_ref()
            .map(|opening| opening.ownership.cancellation.clone());
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
            #[cfg(test)]
            McpStatusCommand::SnapshotForTest { done } => {
                let _ = done.send(snapshot(&state.servers));
            }
            McpStatusCommand::Shutdown { done } => {
                if let Some(opening) = state.opening.take() {
                    for waiter in opening.waiters {
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
    if let Some(opening) = state.opening.as_mut()
        && let Some(owner) = opening.ownership.owner.upgrade()
    {
        opening.waiters.push(done);
        let _ = ownership.send(owner);
        return;
    }
    cancel_open(state, "MCP status opening was cancelled".to_owned());
    state.pre_root.clear();
    let cancellation = CancellationToken::new();
    let owner = Arc::new(McpOpenOwnership {
        cancellation: cancellation.clone(),
    });
    state.opening = Some(Opening {
        ownership: OpeningOwnership {
            owner: Arc::downgrade(&owner),
            cancellation,
        },
        waiters: vec![done],
    });
    let _ = ownership.send(owner);
}

fn cancel_open(state: &mut McpStatusState, error: String) {
    let Some(opening) = state.opening.take() else {
        return;
    };
    state.pre_root.clear();
    for waiter in opening.waiters {
        let _ = waiter.send(Err(error.clone()));
    }
}

fn bind_root(
    state: &mut McpStatusState,
    root: String,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
) {
    if state.opening.is_some() || state.root.as_deref() != Some(root.as_str()) {
        state.servers.clear();
    }
    for (_, server) in state
        .pre_root
        .drain(..)
        .filter(|(notification_root, _)| matches_root(notification_root.as_deref(), &root))
    {
        state.servers.insert(server.name.clone(), server);
    }
    state.root = Some(root);
    let waiters = state
        .opening
        .take()
        .map_or_else(Vec::new, |opening| opening.waiters);
    publish(state, waiters, effects_tx);
}

fn refresh(
    state: &mut McpStatusState,
    done: oneshot::Sender<Result<(), String>>,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
) {
    if let Some(opening) = state.opening.as_mut() {
        opening.waiters.push(done);
        return;
    }
    if state.root.is_none() {
        let _ = done.send(Err("MCP status root is not bound".to_owned()));
        return;
    }
    publish(state, vec![done], effects_tx);
}

fn publish(
    state: &McpStatusState,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
) {
    // shortcut: status is notification-only; use discovery when Codex offers a bounded auth-only response.
    let _ = effects_tx.send(McpStatusEffect::Snapshot(snapshot(&state.servers)));
    if let Err(error) = effects_tx.send(McpStatusEffect::Complete(waiters))
        && let McpStatusEffect::Complete(waiters) = error.0
    {
        for waiter in waiters {
            let _ = waiter.send(Err("MCP status effect receiver is unavailable".to_owned()));
        }
    }
}

fn notification(
    state: &mut McpStatusState,
    root: Option<String>,
    server: McpServerStatus,
    effects_tx: &mpsc::UnboundedSender<McpStatusEffect>,
) {
    if state.opening.is_some() {
        if state.pre_root.len() == PRE_ROOT_LIMIT {
            state.pre_root.pop_front();
        }
        state.pre_root.push_back((root, server));
        return;
    }
    let Some(bound_root) = state.root.as_deref() else {
        return;
    };
    if !matches_root(root.as_deref(), bound_root)
        || state.servers.get(&server.name) == Some(&server)
    {
        return;
    }
    state.servers.insert(server.name.clone(), server);
    let _ = effects_tx.send(McpStatusEffect::Snapshot(snapshot(&state.servers)));
}

fn matches_root(notification_root: Option<&str>, root: &str) -> bool {
    notification_root.is_none_or(|notification_root| notification_root == root)
}

fn snapshot(servers: &BTreeMap<String, McpServerStatus>) -> Vec<McpServerStatus> {
    servers.values().cloned().collect()
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
    use super::*;

    fn server(name: &str) -> McpServerStatus {
        McpServerStatus {
            name: name.to_owned(),
            state: McpServerState::Connected,
            detail: None,
        }
    }

    async fn published(effects: &mut mpsc::UnboundedReceiver<McpStatusEffect>) -> Vec<String> {
        let McpStatusEffect::Snapshot(servers) = effects.recv().await.unwrap() else {
            panic!("snapshot must precede completion");
        };
        let McpStatusEffect::Complete(waiters) = effects.recv().await.unwrap() else {
            panic!("expected completion");
        };
        for waiter in waiters {
            waiter.send(Ok(())).unwrap();
        }
        servers.into_iter().map(|server| server.name).collect()
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
                    Some(
                        if index % 2 == 0 {
                            "matching-root"
                        } else {
                            "foreign-root"
                        }
                        .into(),
                    ),
                    server(&format!("server-{index:02}")),
                )
                .await
                .unwrap();
        }
        handle.bind_root("matching-root".into()).await.unwrap();
        assert_eq!(
            published(&mut effects_rx).await,
            (2..=PRE_ROOT_LIMIT)
                .step_by(2)
                .map(|index| format!("server-{index:02}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(opening.await.unwrap(), Ok(()));
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn refresh_retains_observations_and_changed_root_drops_old_status() {
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
        let actor = tokio::spawn(run_actor(receiver, effects_tx));
        for root in ["old-root", "old-root", "new-root"] {
            let opening = handle.begin_open().await.unwrap();
            let first_refresh = handle.refresh().await.unwrap();
            let second_refresh = handle.refresh().await.unwrap();
            handle
                .notification(Some(root.into()), server(root))
                .await
                .unwrap();
            handle
                .notification(Some("foreign".into()), server("foreign"))
                .await
                .unwrap();
            handle.bind_root(root.into()).await.unwrap();
            assert_eq!(published(&mut effects_rx).await, [root]);
            assert_eq!(opening.await.unwrap(), Ok(()));
            assert_eq!(first_refresh.await.unwrap(), Ok(()));
            assert_eq!(second_refresh.await.unwrap(), Ok(()));
            let refresh = handle.refresh().await.unwrap();
            assert_eq!(published(&mut effects_rx).await, [root]);
            assert_eq!(refresh.await.unwrap(), Ok(()));
            handle
                .notification(Some(root.into()), server(root))
                .await
                .unwrap();
            // Synchronize with the mailbox before testing duplicate suppression.
            assert_eq!(handle.snapshot_for_test().await.unwrap(), [server(root)]);
            assert!(effects_rx.try_recv().is_err());
        }
        let reopened = handle.begin_open().await.unwrap();
        handle.bind_root("new-root".into()).await.unwrap();
        assert!(published(&mut effects_rx).await.is_empty());
        assert_eq!(reopened.await.unwrap(), Ok(()));
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_opening_releases_joined_refresh_and_discards_staged_notifications() {
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, mut effects_rx) = mpsc::unbounded_channel();
        let actor = tokio::spawn(run_actor(receiver, effects_tx));
        let opening = handle.begin_open().await.unwrap();
        let refresh = handle.refresh().await.unwrap();
        handle
            .notification(None, server("abandoned"))
            .await
            .unwrap();
        opening.cancel().await;
        assert!(refresh.await.unwrap().is_err());
        let retry = handle.begin_open().await.unwrap();
        handle.bind_root("root".into()).await.unwrap();
        assert!(published(&mut effects_rx).await.is_empty());
        assert_eq!(retry.await.unwrap(), Ok(()));
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }

    #[tokio::test]
    async fn closed_effect_receiver_fails_opening_waiters() {
        let (handle, receiver) = McpStatusHandle::channel(64);
        let (effects_tx, effects_rx) = mpsc::unbounded_channel();
        drop(effects_rx);
        let actor = tokio::spawn(run_actor(receiver, effects_tx));
        let opening = handle.begin_open().await.unwrap();
        handle.bind_root("root".into()).await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), opening)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        handle.shutdown().await.unwrap();
        actor.await.unwrap();
    }
}
