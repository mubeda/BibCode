use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnDeliveryState {
    Pending,
    Sending,
    Delivered,
    Uncertain,
    Dismissed,
    Failed,
}

#[derive(Clone, Debug)]
pub struct AttachmentReference {
    pub attachment_id: String,
    pub content_digest: Option<String>,
    pub size_bytes: i64,
}

#[derive(Clone, Debug)]
pub struct NewProviderTurnDelivery {
    pub command_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub provider_instance_id: String,
    pub provider_kind: String,
    pub provider_session_id: Option<String>,
    pub delivery_key: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct CommandAdmission {
    pub payload_digest: String,
    pub attachment_refs: Vec<AttachmentReference>,
    pub provider_turn: Option<NewProviderTurnDelivery>,
}

#[derive(Clone, Debug)]
pub struct ProviderTurnDelivery {
    pub command_id: String,
    pub thread_id: String,
    pub message_id: String,
    pub provider_instance_id: String,
    pub provider_kind: String,
    pub provider_session_id: Option<String>,
    pub delivery_key: String,
    pub payload: Value,
    pub state: TurnDeliveryState,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct TurnDeliveryTransition {
    pub command_id: String,
    pub expected_states: Vec<TurnDeliveryState>,
    pub expected_attempt: i64,
    pub next_state: TurnDeliveryState,
    pub detail: Option<String>,
    pub updated_at: String,
}

pub fn canonical_command_digest<T: Serialize>(value: &T) -> Result<String, String> {
    let value = serde_json::to_value(value).map_err(|error| error.to_string())?;
    let canonical =
        serde_json::to_string(&canonicalize(value)).map_err(|error| error.to_string())?;
    Ok(crate::crypto::sha256_hex(canonical))
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize(value)))
                    .collect(),
            )
        }
        value => value,
    }
}
