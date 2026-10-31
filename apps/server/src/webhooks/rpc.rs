//! The webhook administration methods: `webhooks.list` and `webhooks.listDeliveries`
//! (`access:read`), and `webhooks.upsert`, `delete`, `rotateSecret`, `sendTest` and
//! `redeliver` (`access:write`). An outside agent's `mcp-client` session never holds an
//! `access:*` scope, so agents cannot configure webhooks. `sendTest` and `redeliver` wait on
//! the endpoint's response, so the profiler counts them as long-running.

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
) -> Value {
    json!({
        "id": endpoint.id,
        "name": endpoint.name,
        "url": endpoint.url,
        "enabled": endpoint.enabled,
        "eventTypes": endpoint.event_types,
        "projectId": endpoint.project_id,
        "pairedClientId": endpoint.paired_session_id,
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
        let endpoints: Vec<Value> = endpoints
            .iter()
            .map(|endpoint| {
                let (pending, last, dropped) =
                    summaries.get(&endpoint.id).cloned().unwrap_or((0, None, 0));
                endpoint_view(endpoint, pending, last.as_deref(), dropped)
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
        let input: UpsertInput = decode(payload)?;
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
        let paired = optional_id(input.paired_client_id, "pairedClientId")?;
        if let Some(session) = &paired
            && !self
                .store()
                .is_live_agent_session(session)
                .await
                .map_err(storage)?
        {
            return Err(refusal(
                "invalid",
                "Pair the endpoint with an MCP client that is still authorized.",
            ));
        }
        let now = crate::mcp::control::now_iso();
        let existing = match optional_id(input.id, "id")? {
            Some(id) => Some(
                self.store()
                    .endpoint(&id)
                    .await
                    .map_err(storage)?
                    .ok_or_else(not_found)?,
            ),
            None => None,
        };
        let (endpoint, secret) = match existing {
            Some(existing) => {
                let endpoint = Endpoint {
                    name,
                    url,
                    enabled: input.enabled,
                    event_types,
                    project_id,
                    paired_session_id: paired,
                    ..existing
                };
                self.store()
                    .update_endpoint(endpoint.clone())
                    .await
                    .map_err(|error| match error {
                        StoreError::NotFound => not_found(),
                        error => storage(error),
                    })?;
                // A request in flight goes to the old URL or filters: drop it; it stays queued.
                self.cancel_endpoint(&endpoint.id);
                (endpoint, None)
            }
            None => {
                let endpoint = Endpoint {
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
                };
                let secret = signing::generate_secret().map_err(storage)?;
                self.inner
                    .secrets
                    .set(&secret_name(&endpoint.id), secret.as_bytes())
                    .await
                    .map_err(storage)?;
                if let Err(error) = self.store().insert_endpoint(endpoint.clone()).await {
                    let _ = self.inner.secrets.remove(&secret_name(&endpoint.id)).await;
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
        let mut result = json!({ "endpoint": endpoint_view(&stored, 0, None, 0) });
        if let Some(secret) = secret {
            result["secret"] = secret.into();
        }
        Ok(result)
    }

    pub(super) async fn delete(&self, payload: Value) -> Result<Value, Value> {
        let input: EndpointRef = decode(payload)?;
        self.cancel_endpoint(&input.id);
        if !self
            .store()
            .delete_endpoint(&input.id)
            .await
            .map_err(storage)?
        {
            return Err(not_found());
        }
        if let Err(error) = self.inner.secrets.remove(&secret_name(&input.id)).await {
            tracing::warn!(endpoint = %input.id, %error, "could not remove a webhook secret");
        }
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
        let cancel = self.endpoint_token(&endpoint.id);
        let attempt = self
            .attempt(
                endpoint,
                &delivery.delivery_id,
                &delivery.event_type,
                &delivery.body,
                &cancel,
            )
            .await;
        if attempt.failure == Some(delivery::Failure::Cancelled) {
            self.store()
                .abandon_delivery(&delivery.delivery_id)
                .await
                .map_err(storage)?;
        } else {
            let record = self.record(&delivery, &attempt, health);
            self.finish(endpoint, &delivery, &attempt, record).await;
        }
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
