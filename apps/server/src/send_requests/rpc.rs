//! The `sendRequests.*` methods. Each holds `orchestration:operate` or `orchestration:read`,
//! which an outside agent's session holds too, so every handler starts with `require_person`.
//! None waits on a provider, so none is in `is_long_running`; the stream is log-only.

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::sync::mpsc;

use super::service::{
    SendRequestsGetHandoffTextInput, SendRequestsSendInput, SendRequestsService, refusal,
};
use crate::rpc::RpcRegistry;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestIdInput {
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscribeInput {
    #[serde(default)]
    thread_id: Option<String>,
}

/// Decodes a method's input. The decode error quotes input values (note or attachment text),
/// so the refusal leaves it out.
fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, Value> {
    serde_json::from_value(payload)
        .map_err(|_| refusal("invalid", "This is not a valid send request."))
}

fn encode(value: impl serde::Serialize) -> Result<Value, Value> {
    serde_json::to_value(value)
        .map_err(|_| refusal("invalid", "BiBCode could not encode the response."))
}

pub(crate) fn register_send_requests_rpc(registry: &mut RpcRegistry, service: SendRequestsService) {
    let send = service.clone();
    registry.register_unary_with_context("sendRequests.send", move |request, context, _| {
        let service = send.clone();
        async move {
            let input = decode::<SendRequestsSendInput>(request.payload)?;
            encode(service.send(&context, input).await?)
        }
    });
    let cancel = service.clone();
    registry.register_unary_with_context("sendRequests.cancel", move |request, context, _| {
        let service = cancel.clone();
        async move {
            let input = decode::<RequestIdInput>(request.payload)?;
            encode(service.cancel(&context, &input.request_id).await?)
        }
    });
    let dismiss = service.clone();
    registry.register_unary_with_context("sendRequests.dismiss", move |request, context, _| {
        let service = dismiss.clone();
        async move {
            let input = decode::<RequestIdInput>(request.payload)?;
            encode(service.dismiss(&context, &input.request_id).await?)
        }
    });
    let answer = service.clone();
    registry.register_unary_with_context("sendRequests.getAnswer", move |request, context, _| {
        let service = answer.clone();
        async move {
            let input = decode::<RequestIdInput>(request.payload)?;
            encode(service.get_answer(&context, &input.request_id).await?)
        }
    });
    let handoff = service.clone();
    registry.register_unary_with_context(
        "sendRequests.getHandoffText",
        move |request, context, _| {
            let service = handoff.clone();
            async move {
                let input = decode::<SendRequestsGetHandoffTextInput>(request.payload)?;
                encode(service.handoff_text(&context, input).await?)
            }
        },
    );
    registry.register_stream_with_context(
        "sendRequests.subscribe",
        move |request, context, cancellation| match decode::<SubscribeInput>(request.payload) {
            Ok(input) => service.subscribe(&context, input.thread_id, cancellation),
            Err(error) => {
                let (sender, receiver) = mpsc::channel(1);
                let _ = sender.try_send(Err(error));
                receiver
            }
        },
    );
}
