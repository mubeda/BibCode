//! Registers the `updater.*` RPC surface (spec section 4.5) over a
//! `RemoteUpdateService`.

use crate::{remote_update::RemoteUpdateService, rpc::RpcRegistry};

pub fn register_remote_update_rpc(registry: &mut RpcRegistry, service: RemoteUpdateService) {
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
