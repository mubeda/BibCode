//! Registers the `updater.*` RPC surface (spec section 4.5) over a
//! `RemoteUpdateService`.

use serde_json::{Value, json};

use crate::{
    persistence::Repositories, production::server_terminal::ServerTerminalServices,
    remote_update::RemoteUpdateService, rpc::RpcRegistry,
};

/// Counts the work an update restart would stop. Its own read method: status is
/// polled every second and must never wait on the store.
#[derive(Clone)]
pub struct ActiveWorkCounter {
    repositories: Repositories,
    terminals: ServerTerminalServices,
}

impl ActiveWorkCounter {
    #[must_use]
    pub fn new(repositories: Repositories, terminals: ServerTerminalServices) -> Self {
        Self {
            repositories,
            terminals,
        }
    }

    pub async fn count(&self) -> Result<Value, Value> {
        let (running_turns, queued_messages) = self
            .repositories
            .count_active_work()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "could not count running work for an update confirmation");
                json!({
                    "_tag": "RemoteUpdateActiveWorkError",
                    "message": "Could not count running work.",
                })
            })?;
        let live_terminals = self.terminals.live_terminal_count().await;
        Ok(json!({
            "runningTurns": running_turns,
            "liveTerminals": live_terminals,
            "queuedMessages": queued_messages,
        }))
    }
}

pub fn register_remote_update_rpc(
    registry: &mut RpcRegistry,
    service: RemoteUpdateService,
    active_work: ActiveWorkCounter,
) {
    registry.register_unary("updater.activeWork", move |_request, _cancellation| {
        let counter = active_work.clone();
        async move { counter.count().await }
    });

    let status = service.clone();
    registry.register_unary("updater.status", move |_request, _cancellation| {
        let service = status.clone();
        async move {
            Ok(serde_json::to_value(service.status().await).expect("snapshot serializes"))
        }
    });

    let check = service.clone();
    registry.register_unary("updater.check", move |_request, _cancellation| {
        let service = check.clone();
        async move { Ok(serde_json::to_value(service.check().await).expect("snapshot serializes")) }
    });

    registry.register_unary("updater.install", move |_request, _cancellation| {
        let service = service.clone();
        async move {
            service
                .install()
                .await
                .map(|snapshot| serde_json::to_value(snapshot).expect("snapshot serializes"))
        }
    });
}
