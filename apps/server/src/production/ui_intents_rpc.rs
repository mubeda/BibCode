//! UI intents (#139, slice X4): an outside agent's suggestion of what a person might look at.
//!
//! `ui.publishIntent` (`orchestration:operate`) puts an intent on `subscribeUiIntents`
//! (`orchestration:read`). Every client showing the environment raises a non-modal toast, and
//! nothing moves until a person clicks **Show**: an intent is advice, never a command, so it
//! cannot steal focus from someone typing. Intents live in memory only.
//!
//! The actor comes from the authenticated principal: only an outside agent's `mcp-client`
//! session publishes, and no client input names who asked. The `focus_ui` tool checks the
//! thread and its path (C5) before it publishes; the handler repeats the shape checks.
//!
//! Each kind keeps its own retention. A `focus` intent expires after 60 seconds, at most 16
//! pending per thread. Slice X7 adds `commitMessage`, the last one per folder for 24 hours.

use std::{
    path::{Component, Path},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, mpsc},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::rpc::{RpcRegistry, RpcSessionContext, RpcStreamChunk};

/// How long a `focus` intent stays pending.
pub(crate) const FOCUS_TTL: Duration = Duration::from_secs(60);
/// Pending `focus` intents one thread may hold.
pub(crate) const MOST_PENDING_PER_THREAD: usize = 16;
/// What a `focus` intent may ask to show.
pub(crate) const SURFACES: &[&str] = &["thread", "files", "sourceControl", "diff"];
/// The surfaces a `path` applies to.
pub(crate) const PATH_SURFACES: &[&str] = &["files", "diff"];
/// `PROJECT_ENTRY_PATH_MAX_LENGTH` in `packages/contracts/src/project.ts`.
const MOST_PATH_CHARS: usize = 512;
const STREAM_CAPACITY: usize = 64;
const INTENT_CAPACITY: usize = 128;

/// The pending intents of one environment and the stream that announces new ones.
#[derive(Clone)]
pub(crate) struct UiIntents {
    shared: Arc<Shared>,
}

struct Shared {
    pending: Mutex<Vec<Pending>>,
    published: broadcast::Sender<Value>,
}

struct Pending {
    thread_id: String,
    expires: Instant,
    intent: Value,
}

impl Default for UiIntents {
    fn default() -> Self {
        Self::new()
    }
}

impl UiIntents {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                pending: Mutex::new(Vec::new()),
                published: broadcast::channel(INTENT_CAPACITY).0,
            }),
        }
    }

    /// The intents still pending, oldest first; expired ones are dropped.
    pub(crate) fn pending(&self) -> Vec<Value> {
        let mut pending = self.lock();
        prune(&mut pending);
        pending.iter().map(|entry| entry.intent.clone()).collect()
    }

    /// Each intent published from now on; every receiver counts as a subscribed client.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.shared.published.subscribe()
    }

    /// Publishes a `focus` intent and returns it with the number of subscribed clients.
    ///
    /// # Errors
    ///
    /// A typed `UiIntentError` (`reason: "limit"`) when the thread already holds
    /// [`MOST_PENDING_PER_THREAD`] pending intents.
    pub(crate) fn publish_focus(
        &self,
        thread_id: &str,
        surface: &str,
        path: Option<&str>,
        actor: Value,
    ) -> Result<(Value, usize), Value> {
        let now = time::OffsetDateTime::now_utc();
        let intent = json!({
            "kind": "focus",
            "intentId": Uuid::new_v4().to_string(),
            "threadId": thread_id,
            "surface": surface,
            "path": path,
            "actor": actor,
            "createdAt": iso(now),
            "expiresAt": iso(now + FOCUS_TTL),
        });
        {
            let mut pending = self.lock();
            prune(&mut pending);
            if pending
                .iter()
                .filter(|entry| entry.thread_id == thread_id)
                .count()
                >= MOST_PENDING_PER_THREAD
            {
                return Err(refusal(
                    "limit",
                    &format!(
                        "This thread already has {MOST_PENDING_PER_THREAD} UI suggestions waiting for a person; each expires 60 seconds after it was sent."
                    ),
                ));
            }
            pending.push(Pending {
                thread_id: thread_id.to_owned(),
                expires: Instant::now() + FOCUS_TTL,
                intent: intent.clone(),
            });
        }
        // No subscriber is not an error: the result says nobody saw it.
        let _ = self.shared.published.send(intent.clone());
        Ok((intent, self.shared.published.receiver_count()))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Pending>> {
        self.shared
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn prune(pending: &mut Vec<Pending>) {
    let now = Instant::now();
    pending.retain(|entry| entry.expires > now);
}

fn iso(at: time::OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn refusal(reason: &str, message: &str) -> Value {
    json!({ "_tag": "UiIntentError", "reason": reason, "message": message })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublishInput {
    thread_id: String,
    surface: String,
    #[serde(default)]
    path: Option<String>,
}

/// Registers `ui.publishIntent` and `subscribeUiIntents` on `intents`.
pub(crate) fn register_ui_intents_rpc(registry: &mut RpcRegistry, intents: UiIntents) {
    let publish = intents.clone();
    registry.register_unary_with_context(
        "ui.publishIntent",
        move |request, context, _cancellation| {
            let intents = publish.clone();
            async move { publish_intent(&intents, request.payload, &context).await }
        },
    );
    registry.register_stream("subscribeUiIntents", move |_request, cancellation| {
        intents_stream(intents.clone(), cancellation)
    });
}

async fn publish_intent(
    intents: &UiIntents,
    payload: Value,
    context: &RpcSessionContext,
) -> Result<Value, Value> {
    let Some(actor) = crate::mcp::activity::principal_actor(context).await else {
        return Err(refusal(
            "actor",
            "Only an outside agent's MCP session publishes UI suggestions.",
        ));
    };
    let input: PublishInput = serde_json::from_value(payload)
        .map_err(|error| refusal("invalid", &format!("Invalid UI intent: {error}")))?;
    if input.thread_id.trim().is_empty() {
        return Err(refusal("invalid", "threadId is required."));
    }
    if !SURFACES.contains(&input.surface.as_str()) {
        return Err(refusal(
            "invalid",
            "surface is thread, files, sourceControl or diff.",
        ));
    }
    let path = input.path.as_deref().filter(|path| !path.is_empty());
    if let Some(path) = path {
        if !PATH_SURFACES.contains(&input.surface.as_str()) {
            return Err(refusal("invalid", "path applies to files and diff only."));
        }
        if !is_relative_literal(path) {
            return Err(refusal(
                "invalid",
                "path is a file path relative to the thread's folder.",
            ));
        }
    }
    let (intent, subscribers) =
        intents.publish_focus(&input.thread_id, &input.surface, path, actor)?;
    Ok(json!({ "intentId": intent["intentId"], "subscribers": subscribers }))
}

/// A relative path with no `..`, NUL or root, at most 512 characters. The tool applies the
/// full C5 check against the thread's folder before it publishes.
fn is_relative_literal(path: &str) -> bool {
    path.chars().count() <= MOST_PATH_CHARS
        && !path.contains(['\0', '\\'])
        && !Path::new(path).has_root()
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn intents_stream(
    intents: UiIntents,
    cancellation: CancellationToken,
) -> mpsc::Receiver<RpcStreamChunk> {
    let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
    // Subscribed before the snapshot, so nothing published in between is missed; a client
    // drops an intent it already has by its id.
    let mut published = intents.subscribe();
    tokio::spawn(async move {
        let snapshot =
            |intents: &UiIntents| json!({ "type": "snapshot", "intents": intents.pending() });
        let mut next = snapshot(&intents);
        loop {
            let sent = tokio::select! {
                () = cancellation.cancelled() => break,
                sent = sender.send(Ok(vec![next])) => sent,
            };
            if sent.is_err() {
                break;
            }
            next = tokio::select! {
                () = cancellation.cancelled() => break,
                intent = published.recv() => match intent {
                    Ok(intent) => json!({ "type": "intent", "intent": intent }),
                    Err(broadcast::error::RecvError::Lagged(_)) => snapshot(&intents),
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
        }
    });
    receiver
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor() -> Value {
        crate::mcp::activity::actor("session-1", Some("Claude Code"))
    }

    #[tokio::test(start_paused = true)]
    async fn a_focus_intent_expires_after_60_seconds() {
        let intents = UiIntents::new();
        let (intent, subscribers) = intents
            .publish_focus("t1", "files", Some("src/main.rs"), actor())
            .unwrap();
        assert_eq!(subscribers, 0);
        assert_eq!(intent["kind"], "focus");
        assert_eq!(intent["actor"]["label"], "Claude Code");
        assert_eq!(intents.pending().len(), 1);
        tokio::time::advance(FOCUS_TTL - Duration::from_millis(1)).await;
        assert_eq!(intents.pending().len(), 1);
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(intents.pending().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_thread_holds_at_most_16_pending_intents() {
        let intents = UiIntents::new();
        for _ in 0..MOST_PENDING_PER_THREAD {
            intents
                .publish_focus("t1", "thread", None, actor())
                .unwrap();
        }
        let refused = intents
            .publish_focus("t1", "thread", None, actor())
            .unwrap_err();
        assert_eq!(refused["_tag"], "UiIntentError");
        assert_eq!(refused["reason"], "limit");
        // Another thread has its own limit, and expiry frees the first.
        intents
            .publish_focus("t2", "thread", None, actor())
            .unwrap();
        tokio::time::advance(FOCUS_TTL).await;
        intents
            .publish_focus("t1", "thread", None, actor())
            .unwrap();
    }

    #[tokio::test]
    async fn the_stream_sends_the_pending_intents_then_each_new_one() {
        let intents = UiIntents::new();
        let (first, _) = intents.publish_focus("t1", "diff", None, actor()).unwrap();
        let cancellation = CancellationToken::new();
        let mut stream = intents_stream(intents.clone(), cancellation.clone());
        let snapshot = stream.recv().await.unwrap().unwrap();
        assert_eq!(snapshot[0]["type"], "snapshot");
        assert_eq!(snapshot[0]["intents"][0]["intentId"], first["intentId"]);
        let (second, subscribers) = intents
            .publish_focus("t1", "sourceControl", None, actor())
            .unwrap();
        assert_eq!(subscribers, 1);
        let next = stream.recv().await.unwrap().unwrap();
        assert_eq!(next[0]["type"], "intent");
        assert_eq!(next[0]["intent"]["intentId"], second["intentId"]);
        cancellation.cancel();
    }

    #[tokio::test]
    async fn only_an_outside_agent_publishes_and_paths_stay_relative() {
        let intents = UiIntents::new();
        let person = publish_intent(
            &intents,
            json!({ "threadId": "t1", "surface": "thread" }),
            &RpcSessionContext::unauthenticated(),
        )
        .await
        .unwrap_err();
        assert_eq!(person["reason"], "actor");
        assert!(intents.pending().is_empty());
        for path in ["../outside", "/etc/passwd", "a/../../b", "a\\b"] {
            assert!(!is_relative_literal(path), "{path}");
        }
        assert!(is_relative_literal("src/main.rs"));
        assert!(is_relative_literal("./README.md"));
    }
}
