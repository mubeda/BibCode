//! Authenticated chat upload RPCs share one registry with durable turn admission.
use crate::{
    RpcRegistry,
    transfer::staging::{
        UploadAppendInput, UploadBeginInput, UploadError, UploadOwner, UploadRegistry,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdInput {
    upload_id: String,
}
fn error_value(error: UploadError) -> Value {
    serde_json::to_value(error).expect("upload error serializes")
}
fn decode<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(
        |error| json!({"_tag":"UploadError", "reason":"invalid", "message":error.to_string()}),
    )
}
pub fn register_uploads_rpc(registry: &mut RpcRegistry, uploads: UploadRegistry) {
    let begin = uploads.clone();
    registry.register_unary_with_context("uploads.begin", move |request, context, _| {
        let uploads = begin.clone();
        async move {
            let input = decode::<UploadBeginInput>(request.payload)?;
            let result = uploads
                .begin(&UploadOwner::from_context(&context), input)
                .await
                .map_err(error_value)?;
            Ok(json!(result))
        }
    });
    let append = uploads.clone();
    registry.register_unary_with_context("uploads.append", move |request, context, _| {
        let uploads = append.clone();
        async move {
            let input = decode::<UploadAppendInput>(request.payload)?;
            let result = uploads
                .append(&UploadOwner::from_context(&context), input)
                .await
                .map_err(error_value)?;
            Ok(json!(result))
        }
    });
    let get = uploads.clone();
    registry.register_unary_with_context("uploads.get", move |request, context, _| {
        let uploads = get.clone();
        async move {
            let input = decode::<IdInput>(request.payload)?;
            let result = uploads
                .get(&UploadOwner::from_context(&context), &input.upload_id)
                .await
                .map_err(error_value)?;
            Ok(json!(result))
        }
    });
    registry.register_unary_with_context("uploads.cancel", move |request, context, _| {
        let uploads = uploads.clone();
        async move {
            let input = decode::<IdInput>(request.payload)?;
            uploads
                .cancel(&UploadOwner::from_context(&context), &input.upload_id)
                .await
                .map_err(error_value)?;
            Ok(json!({}))
        }
    });
}
