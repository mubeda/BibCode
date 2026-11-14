//! The `sendRequests.*` methods. Each holds `orchestration:operate`, which an outside agent's
//! session holds too, so every handler starts with `require_person`. `sendRequests.send` only
//! queues a turn and never waits on a provider, so it is not in `is_long_running`.

use super::service::{SendRequestsSendInput, SendRequestsService, refusal};
use crate::rpc::RpcRegistry;

pub(crate) fn register_send_requests_rpc(registry: &mut RpcRegistry, service: SendRequestsService) {
    registry.register_unary_with_context("sendRequests.send", move |request, context, _| {
        let service = service.clone();
        async move {
            let input = serde_json::from_value::<SendRequestsSendInput>(request.payload)
                .map_err(|error| refusal("invalid", &format!("Invalid request: {error}")))?;
            let request = service.send(&context, input).await?;
            serde_json::to_value(request)
                .map_err(|error| refusal("invalid", &format!("Invalid response: {error}")))
        }
    });
}
