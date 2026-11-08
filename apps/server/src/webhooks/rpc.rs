//! The webhook administration methods: `webhooks.list` and `webhooks.listDeliveries`
//! (`access:read`), and `webhooks.upsert`, `delete`, `rotateSecret`, `sendTest` and
//! `redeliver` (`access:write`). An outside agent's `mcp-client` session never holds an
//! `access:*` scope, so agents cannot configure webhooks. `sendTest` and `redeliver` wait on
//! the endpoint's response, so the profiler counts them as long-running.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    Webhooks, delivery,
    events::{self, WEBHOOK_TEST},
    now_ms, secret_name, signing,
    store::{self, Delivery, Endpoint, NewDelivery, StoreError},
};
use crate::rpc::RpcRegistry;

const MAX_NAME_CHARS: usize = 80;
const MAX_ID_CHARS: usize = 256;
const MAX_TOKEN_BYTES: usize = 1_024;
const TOKEN_MESSAGE: &str = "The token must be 1 to 1,024 visible ASCII characters with no spaces.";
const TOKEN_FOR_NEW_URL: &str = "Enter the token for the new URL, or remove it.";
/// Deliveries `webhooks.listDeliveries` returns: `(default, most)`.
const DELIVERIES_LIMIT: (i64, i64) = (50, 200);

pub(crate) fn register_webhooks_rpc(registry: &mut RpcRegistry, webhooks: Webhooks) {
    macro_rules! method {
        ($name:literal, $handler:ident) => {{
            let webhooks = webhooks.clone();
            registry.register_unary($name, move |request, _cancellation| {
                let webhooks = webhooks.clone();
                async move { webhooks.$handler(request.payload).await }
            });
        }};
    }
    method!("webhooks.list", list);
    method!("webhooks.listDeliveries", list_deliveries);
    method!("webhooks.upsert", upsert);
    method!("webhooks.delete", delete);
    method!("webhooks.rotateSecret", rotate_secret);
    method!("webhooks.sendTest", send_test);
    method!("webhooks.redeliver", redeliver);
}

fn refusal(reason: &str, message: &str) -> Value {
    json!({ "_tag": "WebhookError", "reason": reason, "message": message })
}

fn storage(error: impl std::fmt::Display) -> Value {
    tracing::warn!(%error, "a webhook method could not use the store");
    refusal(
        "storage",
        "BiBCode could not read or save its webhooks. Try again.",
    )
}

fn not_found() -> Value {
    refusal(
        "not_found",
        "This webhook endpoint no longer exists. Reload the list.",
    )
}

fn webhooks_off() -> Value {
    refusal(
        "webhooks_off",
        "Turn on Webhooks first in Settings → Agent integrations → Webhooks.",
    )
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T, Value> {
    serde_json::from_value(payload)
        .map_err(|error| refusal("invalid", &format!("Invalid request: {error}")))
}

fn iso_from_ms(ms: i64) -> Option<String> {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|at| {
            at.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
}

fn endpoint_view(
    endpoint: &Endpoint,
    pending: i64,
    last_state: Option<&str>,
    dropped: i64,
    names: &HashMap<String, String>,
) -> Value {
    json!({
        "id": endpoint.id,
        "name": endpoint.name,
        "url": endpoint.url,
        "enabled": endpoint.enabled,
        "eventTypes": endpoint.event_types,
        "projectId": endpoint.project_id,
        "pairedClientId": endpoint.paired_session_id,
        "pairedClientName": endpoint.paired_session_id.as_ref().and_then(|id| names.get(id)),
        "bearerTokenSet": endpoint.bearer_secret.is_some(),
        "statusKinds": endpoint.status_kinds,
        "consecutiveFailures": endpoint.consecutive_failures,
        "disabledReason": endpoint.disabled_reason,
        "pendingDeliveries": pending,
        "lastDeliveryState": last_state,
        "droppedDeliveries": dropped,
        "createdAt": endpoint.created_at,
        "updatedAt": endpoint.updated_at,
    })
}

fn delivery_view(delivery: &Delivery) -> Value {
    json!({
        "deliveryId": delivery.delivery_id,
        "eventId": delivery.event_id,
        "eventType": delivery.event_type,
        "state": delivery.state,
        "attempts": delivery.attempts,
        "lastStatus": delivery.last_status,
        "lastError": delivery.last_error,
        "latencyMs": delivery.latency_ms,
        "nextAttemptAt": (delivery.state == store::PENDING)
            .then(|| iso_from_ms(delivery.next_attempt_ms))
            .flatten(),
        "createdAt": delivery.created_at,
        "updatedAt": delivery.updated_at,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EndpointRef {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveriesInput {
    endpoint_id: String,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertInput {
    id: Option<String>,
    name: String,
    url: String,
    enabled: bool,
    event_types: Vec<String>,
    project_id: Option<String>,
    paired_client_id: Option<String>,
    /// Absent keeps the endpoint's token, `null` clears it and a string sets or replaces it.
    /// No `Debug`: it holds the token.
    #[serde(default, deserialize_with = "present")]
    bearer_token: Option<Option<String>>,
    /// Absent keeps the endpoint's `thread.status_changed` filter, so an older client's save
    /// never resets it; `null` sends every kind and a list only those.
    #[serde(default, deserialize_with = "present_kinds")]
    status_kinds: Option<Option<Vec<String>>>,
}

/// [`present`] for `statusKinds`.
fn present_kinds<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<Vec<String>>>, D::Error> {
    Option::<Vec<String>>::deserialize(deserializer).map(Some)
}

/// A `statusKinds` list as it is stored: known kinds, once each, in the catalog's order.
fn status_kinds(kinds: Vec<String>) -> Result<Vec<String>, Value> {
    if let Some(unknown) = kinds
        .iter()
        .find(|kind| !events::STATUS_KINDS.contains(&kind.as_str()))
    {
        return Err(refusal(
            "invalid",
            &format!("{unknown} is not a thread.status_changed kind."),
        ));
    }
    let kinds: Vec<String> = events::STATUS_KINDS
        .iter()
        .filter(|known| kinds.iter().any(|kind| kind == *known))
        .map(|kind| (*kind).to_owned())
        .collect();
    if kinds.is_empty() {
        return Err(refusal(
            "invalid",
            "Choose at least one status change, or stop sending Thread status changed.",
        ));
    }
    Ok(kinds)
}

/// A field that is present, as `Some`, so `null` and absent differ. A value of the wrong
/// type gets fixed text, because serde's own error quotes it and it may be the token.
fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer)
        .map(Some)
        .map_err(|_| serde::de::Error::custom("bearerToken must be a string or null"))
}

/// A bearer token as it is stored: trimmed, 1 to 1,024 bytes of visible ASCII, so it is
/// always a valid header value. No refusal ever holds any part of it.
fn bearer_token(value: &str) -> Result<String, Value> {
    let token = value.trim();
    if token
        .get(..7)
        .is_some_and(|start| start.eq_ignore_ascii_case("bearer "))
    {
        return Err(refusal(
            "invalid",
            "Paste the token without the word Bearer.",
        ));
    }
    if token.is_empty()
        || token.len() > MAX_TOKEN_BYTES
        || !token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(refusal("invalid", TOKEN_MESSAGE));
    }
    Ok(token.to_owned())
}

/// An upsert can hold a token, and serde's errors quote values and unknown keys, so a
/// malformed one gets fixed text that never reaches the reply or the RPC trace.
fn decode_upsert(payload: Value) -> Result<UpsertInput, Value> {
    serde_json::from_value(payload).map_err(|_| {
        refusal(
            "invalid",
            "Invalid request: an endpoint needs name, url, enabled and eventTypes, bearerToken must be a string or null, and statusKinds a list of strings or null.",
        )
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RedeliverInput {
    delivery_id: String,
}

fn optional_id(value: Option<String>, field: &str) -> Result<Option<String>, Value> {
    match value.map(|value| value.trim().to_owned()) {
        None => Ok(None),
        Some(value) if value.is_empty() => Ok(None),
        Some(value)
            if value.chars().count() > MAX_ID_CHARS || value.chars().any(char::is_control) =>
        {
            Err(refusal("invalid", &format!("{field} is not an id.")))
        }
        Some(value) => Ok(Some(value)),
    }
}

impl Webhooks {
    pub(super) async fn list(&self, _payload: Value) -> Result<Value, Value> {
        let store = self.store();
        let endpoints = store.endpoints().await.map_err(storage)?;
        let summaries = store.summaries().await.map_err(storage)?;
        let names = store.paired_client_names().await.map_err(storage)?;
        let endpoints: Vec<Value> = endpoints
            .iter()
            .map(|endpoint| {
                let (pending, last, dropped) =
                    summaries.get(&endpoint.id).cloned().unwrap_or((0, None, 0));
                endpoint_view(endpoint, pending, last.as_deref(), dropped, &names)
            })
            .collect();
        Ok(json!({
            "enabled": self.enabled(),
            "endpoints": endpoints,
            "maxEndpoints": store::MAX_ENDPOINTS,
        }))
    }

    pub(super) async fn list_deliveries(&self, payload: Value) -> Result<Value, Value> {
        let input: DeliveriesInput = decode(payload)?;
        let limit = match input.limit {
            None => DELIVERIES_LIMIT.0,
            Some(limit) if (1..=DELIVERIES_LIMIT.1).contains(&limit) => limit,
            Some(_) => {
                return Err(refusal(
                    "invalid",
                    &format!("limit must be 1 to {}.", DELIVERIES_LIMIT.1),
                ));
            }
        };
        let deliveries = self
            .store()
            .deliveries(&input.endpoint_id, limit)
            .await
            .map_err(storage)?;
        Ok(json!({ "deliveries": deliveries.iter().map(delivery_view).collect::<Vec<_>>() }))
    }

    pub(super) async fn upsert(&self, payload: Value) -> Result<Value, Value> {
        let input = decode_upsert(payload)?;
        let name = input.name.trim().to_owned();
        if name.is_empty()
            || name.chars().count() > MAX_NAME_CHARS
            || name.chars().any(char::is_control)
        {
            return Err(refusal(
                "invalid",
                &format!("Give the endpoint a name of 1 to {MAX_NAME_CHARS} characters."),
            ));
        }
        let url = input.url.trim().to_owned();
        if delivery::check_url(&url).is_none() {
            return Err(refusal("invalid", delivery::URL_MESSAGE));
        }
        let mut event_types = Vec::new();
        for event in input.event_types {
            if !events::is_event_type(&event) {
                return Err(refusal(
                    "invalid",
                    &format!("{event} is not a webhook event."),
                ));
            }
            if !event_types.contains(&event) {
                event_types.push(event);
            }
        }
        if event_types.is_empty() {
            return Err(refusal("invalid", "Choose at least one event to send."));
        }
        let project_id = optional_id(input.project_id, "projectId")?;
        // A run of a named client (#280) pairs with the identity, so the pairing outlives it.
        let paired = match optional_id(input.paired_client_id, "pairedClientId")? {
            Some(id) => Some(
                self.store()
                    .pairing_target(&id)
                    .await
                    .map_err(storage)?
                    .ok_or_else(|| {
                        refusal(
                            "invalid",
                            "Pair the endpoint with an MCP client that is still authorized.",
                        )
                    })?,
            ),
            None => None,
        };
        let bearer = match input.bearer_token {
            Some(Some(token)) => Some(Some(bearer_token(&token)?)),
            other => other,
        };
        let kinds = match input.status_kinds {
            Some(Some(kinds)) => Some(Some(status_kinds(kinds)?)),
            other => other,
        };
        let now = crate::mcp::control::now_iso();
        let (endpoint, secret) = match optional_id(input.id, "id")? {
            Some(id) => {
                // One edit at a time, from this read through the cleanup: the URL check below
                // and the row it writes see the same stored URL and token.
                let edit = self.edit_lock(&id);
                let _edit = edit.lock().await;
                let existing = self
                    .store()
                    .endpoint(&id)
                    .await
                    .map_err(storage)?
                    .ok_or_else(not_found)?;
                // Keeping the token would send receiver A's credential to receiver B.
                if existing.url != url && existing.bearer_secret.is_some() && bearer.is_none() {
                    return Err(refusal("invalid", TOKEN_FOR_NEW_URL));
                }
                let written = match &bearer {
                    Some(Some(token)) => {
                        Some(self.write_bearer(&id, token).await.map_err(storage)?)
                    }
                    _ => None,
                };
                self.after_token_write().await;
                // Where its deliveries go, which events it gets, or on/off: a new revision.
                // A token change alone is not: the next attempt reads the new token.
                let status_kinds = kinds.unwrap_or_else(|| existing.status_kinds.clone());
                let new_revision = existing.url != url
                    || existing.project_id != project_id
                    || existing.event_types != event_types
                    || existing.status_kinds != status_kinds
                    || existing.enabled != input.enabled;
                let bearer_secret = match &bearer {
                    None => existing.bearer_secret.clone(),
                    Some(_) => written.clone(),
                };
                let endpoint = Endpoint {
                    name,
                    url,
                    enabled: input.enabled,
                    event_types,
                    project_id,
                    paired_session_id: paired,
                    bearer_secret,
                    status_kinds,
                    ..existing
                };
                let update = self
                    .store()
                    .update_endpoint(endpoint.clone(), bearer.is_some());
                // A new revision commits only between requests, so no sender can post under
                // the old one after it; a rename touches nothing a sender reads.
                let updated = if new_revision {
                    self.under_send_lock(&endpoint.id, update).await
                } else {
                    update.await
                };
                if let Err(error) = updated {
                    // Nothing changed: the old URL keeps the old token.
                    if let Some(name) = &written
                        && let Err(error) = self.inner.secrets.remove(name).await
                    {
                        tracing::warn!(endpoint = %id, %error, "could not remove a webhook bearer token");
                    }
                    return Err(match error {
                        StoreError::NotFound => not_found(),
                        error => storage(error),
                    });
                }
                self.prune_bearer_files(&id, endpoint.bearer_secret.as_deref())
                    .await;
                (endpoint, None)
            }
            None => {
                let mut endpoint = Endpoint {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    url,
                    enabled: input.enabled,
                    event_types,
                    project_id,
                    paired_session_id: paired,
                    consecutive_failures: 0,
                    disabled_reason: None,
                    created_at: now.clone(),
                    updated_at: now,
                    revision: 0,
                    bearer_secret: None,
                    status_kinds: kinds.flatten(),
                };
                let secret = signing::generate_secret().map_err(storage)?;
                self.inner
                    .secrets
                    .set(&secret_name(&endpoint.id), secret.as_bytes())
                    .await
                    .map_err(storage)?;
                if let Some(Some(token)) = &bearer {
                    match self.write_bearer(&endpoint.id, token).await {
                        Ok(name) => endpoint.bearer_secret = Some(name),
                        Err(error) => {
                            let _ = self.inner.secrets.remove(&secret_name(&endpoint.id)).await;
                            return Err(storage(error));
                        }
                    }
                }
                if let Err(error) = self.store().insert_endpoint(endpoint.clone()).await {
                    let _ = self.inner.secrets.remove(&secret_name(&endpoint.id)).await;
                    if let Some(name) = &endpoint.bearer_secret {
                        let _ = self.inner.secrets.remove(name).await;
                    }
                    return Err(match error {
                        StoreError::Limit => refusal(
                            "limit",
                            &format!(
                                "An environment has at most {} webhook endpoints. Delete one first.",
                                store::MAX_ENDPOINTS
                            ),
                        ),
                        error => storage(error),
                    });
                }
                (endpoint, Some(secret))
            }
        };
        self.wake();
        let stored = self
            .store()
            .endpoint(&endpoint.id)
            .await
            .map_err(storage)?
            .ok_or_else(not_found)?;
        let names = self.store().paired_client_names().await.map_err(storage)?;
        let mut result = json!({ "endpoint": endpoint_view(&stored, 0, None, 0, &names) });
        if let Some(secret) = secret {
            result["secret"] = secret.into();
        }
        Ok(result)
    }

    pub(super) async fn delete(&self, payload: Value) -> Result<Value, Value> {
        let input: EndpointRef = decode(payload)?;
        let edit = self.edit_lock(&input.id);
        let _edit = edit.lock().await;
        let deleted = self
            .under_send_lock(&input.id, self.store().delete_endpoint(&input.id))
            .await;
        if !deleted.map_err(storage)? {
            return Err(not_found());
        }
        if let Err(error) = self.inner.secrets.remove(&secret_name(&input.id)).await {
            tracing::warn!(endpoint = %input.id, %error, "could not remove a webhook secret");
        }
        self.prune_bearer_files(&input.id, None).await;
        Ok(json!({ "deleted": true }))
    }

    pub(super) async fn rotate_secret(&self, payload: Value) -> Result<Value, Value> {
        let input: EndpointRef = decode(payload)?;
        if self
            .store()
            .endpoint(&input.id)
            .await
            .map_err(storage)?
            .is_none()
        {
            return Err(not_found());
        }
        let secret = signing::generate_secret().map_err(storage)?;
        self.inner
            .secrets
            .set(&secret_name(&input.id), secret.as_bytes())
            .await
            .map_err(storage)?;
        Ok(json!({ "secret": secret }))
    }

    /// Sends `webhook.test` to one endpoint now, enabled or not, and answers with the result.
    /// It is never retried and never counts toward the endpoint's health.
    pub(super) async fn send_test(&self, payload: Value) -> Result<Value, Value> {
        let input: EndpointRef = decode(payload)?;
        if !self.enabled() {
            return Err(webhooks_off());
        }
        let endpoint = self
            .store()
            .endpoint(&input.id)
            .await
            .map_err(storage)?
            .ok_or_else(not_found)?;
        let event = events::test_event(crate::mcp::control::now_iso());
        let delivery = NewDelivery {
            delivery_id: uuid::Uuid::new_v4().to_string(),
            endpoint_id: endpoint.id.clone(),
            event_id: event.id.clone(),
            event_type: WEBHOOK_TEST.to_owned(),
            body: event.body(&self.inner.environment_id),
            addressed: Some(endpoint.revision),
        };
        self.send_now(&endpoint, delivery, false).await
    }

    /// Sends a delivery again now, as a new delivery of the same event, and answers with the
    /// first attempt's result; a failure that is tried again stays queued.
    pub(super) async fn redeliver(&self, payload: Value) -> Result<Value, Value> {
        let input: RedeliverInput = decode(payload)?;
        if !self.enabled() {
            return Err(webhooks_off());
        }
        let original = self
            .store()
            .delivery(&input.delivery_id)
            .await
            .map_err(storage)?
            .ok_or_else(|| refusal("not_found", "This delivery is no longer in the log."))?;
        // Still queued or being sent: a second copy would race it out of order.
        if original.state == store::PENDING || original.state == store::SENDING {
            return Err(refusal(
                "queued",
                "This delivery is still queued or being sent. Redeliver it after it finishes.",
            ));
        }
        let endpoint = self
            .store()
            .endpoint(&original.endpoint_id)
            .await
            .map_err(storage)?
            .ok_or_else(not_found)?;
        if !endpoint.enabled {
            return Err(refusal(
                "endpoint_disabled",
                "Turn this endpoint on first, then redeliver.",
            ));
        }
        let health = original.event_type != WEBHOOK_TEST;
        let delivery = NewDelivery {
            delivery_id: uuid::Uuid::new_v4().to_string(),
            endpoint_id: endpoint.id.clone(),
            event_id: original.event_id,
            event_type: original.event_type,
            body: original.body,
            addressed: Some(endpoint.revision),
        };
        self.send_now(&endpoint, delivery, health).await
    }

    async fn send_now(
        &self,
        endpoint: &Endpoint,
        delivery: NewDelivery,
        health: bool,
    ) -> Result<Value, Value> {
        let delivery = self
            .store()
            .insert_sending(delivery, now_ms())
            .await
            .map_err(storage)?;
        // The endpoint's turn, then its token, then a fresh read: an edit committed before
        // the read is a new revision and refuses the send; one committed after it cancels
        // the token. Waiting for the turn ends only at shutdown.
        let turn = self.take_turn(&endpoint.id, &self.inner.shutdown).await;
        let cancel = self.endpoint_token(&endpoint.id);
        let current = self.store().endpoint(&endpoint.id).await.map_err(storage)?;
        let current = match current {
            Some(current) if current.revision == endpoint.revision => current,
            _ => {
                self.store()
                    .abandon_delivery(&delivery.delivery_id, store::ENDPOINT_CHANGED)
                    .await
                    .map_err(storage)?;
                self.wake();
                return Err(refusal(
                    "endpoint_changed",
                    "The endpoint changed while this was being sent. Nothing was sent; try again.",
                ));
            }
        };
        self.after_revision_read().await;
        // The turn is held through the record, so an automatic disable commits with no
        // sender between.
        let attempt = match &turn {
            Some(_) => {
                self.attempt_holding_turn(
                    &current,
                    &delivery.delivery_id,
                    &delivery.event_type,
                    &delivery.body,
                    &cancel,
                )
                .await
            }
            None => delivery::Attempt {
                status: None,
                failure: Some(delivery::Failure::Cancelled),
                latency_ms: 0,
            },
        };
        if attempt.failure == Some(delivery::Failure::Cancelled) {
            self.store()
                .abandon_delivery(&delivery.delivery_id, "cancelled")
                .await
                .map_err(storage)?;
        } else {
            let record = self.record(&delivery, &attempt, health);
            self.finish(&current, &delivery, &attempt, record).await;
        }
        drop(turn);
        self.wake();
        let stored = self
            .store()
            .delivery(&delivery.delivery_id)
            .await
            .map_err(storage)?
            .ok_or_else(not_found)?;
        Ok(json!({ "delivery": delivery_view(&stored) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bearer_token_is_visible_ascii_without_the_word_bearer() {
        assert_eq!(bearer_token("  tok-1.A_b~  ").unwrap(), "tok-1.A_b~");
        assert!(bearer_token(&"a".repeat(MAX_TOKEN_BYTES)).is_ok());
        const SECRET: &str = "SECRET9x";
        for (value, message) in [
            (
                format!("Bearer {SECRET}"),
                "Paste the token without the word Bearer.",
            ),
            (
                format!("bearer {SECRET}"),
                "Paste the token without the word Bearer.",
            ),
            (format!("{SECRET}\u{7}"), TOKEN_MESSAGE),
            (format!("{SECRET}\n{SECRET}"), TOKEN_MESSAGE),
            (format!("{SECRET} {SECRET}"), TOKEN_MESSAGE),
            (format!("{SECRET}\u{e9}"), TOKEN_MESSAGE),
            (
                format!("{SECRET}{}", "a".repeat(MAX_TOKEN_BYTES)),
                TOKEN_MESSAGE,
            ),
            ("   ".to_owned(), TOKEN_MESSAGE),
        ] {
            let refusal = bearer_token(&value).unwrap_err();
            assert_eq!(refusal["reason"], "invalid", "{value:?}");
            assert_eq!(refusal["message"], message, "{value:?}");
            assert!(!refusal.to_string().contains("SECRET"), "{refusal}");
        }
    }

    /// The contract's own encodings of an upsert: absent keeps the token and the status
    /// filter, `null` clears the token and a string sets it, and a list sets the filter. An
    /// upsert in the v0.14 shape is the absent case.
    #[test]
    fn upsert_fixtures_decode_to_keep_clear_and_set() {
        let fixture = |name: &str| -> UpsertInput {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../packages/contracts/fixtures/rpc-wire/contract-shapes/webhooks__upsert-{name}-request.json"
            ));
            let request: Value =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            serde_json::from_value(request["payload"].clone()).unwrap()
        };
        assert!(fixture("token-absent").bearer_token.is_none());
        assert!(fixture("token-absent").status_kinds.is_none());
        assert_eq!(
            fixture("status-kinds").status_kinds,
            Some(Some(vec![
                "turn.completed".to_owned(),
                "turn.failed".to_owned()
            ]))
        );
        assert!(fixture("status-kinds").bearer_token.is_none());
        assert_eq!(fixture("token-null").bearer_token, Some(None));
        assert_eq!(
            fixture("token-set").bearer_token,
            Some(Some("fixture-token".to_owned()))
        );
    }

    /// A malformed upsert is refused without echoing a token, so neither the reply nor
    /// the RPC trace that records the reply holds it.
    #[test]
    fn a_bearer_token_of_the_wrong_type_is_refused_without_its_value() {
        let endpoint = |token: Value| {
            json!({
                "name": "n", "url": "https://example.test/h", "enabled": true,
                "eventTypes": [], "bearerToken": token,
            })
        };
        for payload in [
            endpoint(json!(123_456_789_012_345_u64)),
            endpoint(json!(["SECRET9x"])),
            endpoint(json!({ "SECRET9x": 1 })),
            // A token pasted as the whole payload or as a key.
            json!("SECRET9x"),
            json!({ "SECRET9x": null }),
        ] {
            let refusal = decode_upsert(payload).err().unwrap();
            assert_eq!(refusal["reason"], "invalid");
            let shown = refusal.to_string();
            assert!(!shown.contains("123456789012345"), "{shown}");
            assert!(!shown.contains("SECRET9x"), "{shown}");
        }
    }
}
