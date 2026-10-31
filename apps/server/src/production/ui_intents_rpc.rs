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
//! pending per thread. A `commitMessage` intent (slice X7, `git_set_commit_message`) is the last
//! one per folder, kept for 24 hours apart from the `focus` intents, so a Source Control panel
//! opened later still offers it and no flood of `focus` intents evicts it. The tool resolves the
//! folder from the thread; the handler has no projection to check it against, which is
//! acceptable for advice that a panel labels with the agent and never applies over a draft.

use std::{
    path::{Component, Path},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
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
/// Pending intents one agent credential may hold across threads.
pub(crate) const MOST_PENDING_PER_CLIENT: usize = 64;
/// Pending intents the server holds; past it the oldest are dropped first.
pub(crate) const MOST_PENDING: usize = 256;
/// The newest pending intents a subscriber's snapshot carries (a client keeps 64).
pub(crate) const SNAPSHOT_INTENTS: usize = 64;
/// What a `focus` intent may ask to show.
pub(crate) const SURFACES: &[&str] = &["thread", "files", "sourceControl", "diff"];
/// The surfaces a `path` applies to.
pub(crate) const PATH_SURFACES: &[&str] = &["files", "diff"];
/// `PROJECT_ENTRY_PATH_MAX_LENGTH` in `packages/contracts/src/project.ts`.
const MOST_PATH_CHARS: usize = 512;
/// How long a `commitMessage` intent stays pending.
pub(crate) const COMMIT_MESSAGE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// The longest suggested commit message, in characters.
pub(crate) const MOST_COMMIT_MESSAGE_CHARS: usize = 8_000;
/// Folders with a pending `commitMessage` intent; past it the oldest is dropped.
pub(crate) const MOST_COMMIT_MESSAGES: usize = 64;
/// The longest folder a `commitMessage` intent names.
const MOST_CWD_CHARS: usize = 4_096;
const STREAM_CAPACITY: usize = 64;
const INTENT_CAPACITY: usize = 128;

/// The pending intents of one environment and the stream that announces new ones.
#[derive(Clone)]
pub(crate) struct UiIntents {
    shared: Arc<Shared>,
}

struct Shared {
    pending: Mutex<Vec<Pending>>,
    /// The last `commitMessage` intent per folder, oldest first.
    messages: Mutex<Vec<Message>>,
    /// The last `commitMessage` sequence, written only while `messages` is locked.
    sequence: AtomicU64,
    published: broadcast::Sender<Value>,
}

struct Pending {
    thread_id: String,
    client_id: String,
    expires: Instant,
    intent: Value,
}

struct Message {
    cwd: String,
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
                messages: Mutex::new(Vec::new()),
                sequence: AtomicU64::new(0),
                published: broadcast::channel(INTENT_CAPACITY).0,
            }),
        }
    }

    /// The newest [`SNAPSHOT_INTENTS`] `focus` intents still pending, oldest first, then every
    /// pending `commitMessage` intent (at most [`MOST_COMMIT_MESSAGES`]); expired ones are
    /// dropped. One server is one environment, so this is the subscriber's environment.
    pub(crate) fn snapshot(&self) -> Vec<Value> {
        let mut snapshot: Vec<Value> = {
            let mut pending = self.lock();
            prune(&mut pending);
            let skip = pending.len().saturating_sub(SNAPSHOT_INTENTS);
            pending[skip..]
                .iter()
                .map(|entry| entry.intent.clone())
                .collect()
        };
        let mut messages = self.lock_messages();
        prune_messages(&mut messages);
        snapshot.extend(messages.iter().map(|entry| entry.intent.clone()));
        snapshot
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        let mut pending = self.lock();
        prune(&mut pending);
        pending.len()
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
    /// [`MOST_PENDING_PER_THREAD`] pending intents, or the agent [`MOST_PENDING_PER_CLIENT`].
    /// Past [`MOST_PENDING`] in all, the oldest pending intents are dropped.
    pub(crate) fn publish_focus(
        &self,
        thread_id: &str,
        surface: &str,
        path: Option<&str>,
        actor: Value,
    ) -> Result<(Value, usize), Value> {
        let client_id = actor["clientId"].as_str().unwrap_or_default().to_owned();
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
            if pending
                .iter()
                .filter(|entry| entry.client_id == client_id)
                .count()
                >= MOST_PENDING_PER_CLIENT
            {
                return Err(refusal(
                    "limit",
                    &format!(
                        "You already have {MOST_PENDING_PER_CLIENT} UI suggestions waiting for a person; each expires 60 seconds after it was sent."
                    ),
                ));
            }
            pending.push(Pending {
                thread_id: thread_id.to_owned(),
                client_id,
                expires: Instant::now() + FOCUS_TTL,
                intent: intent.clone(),
            });
            let excess = pending.len().saturating_sub(MOST_PENDING);
            pending.drain(..excess);
        }
        // No subscriber is not an error: the result says nobody saw it.
        let _ = self.shared.published.send(intent.clone());
        Ok((intent, self.shared.published.receiver_count()))
    }

    /// Publishes a suggested commit message for folder `cwd`, replacing the folder's earlier
    /// one, and returns it with the number of subscribed clients. It stays pending for
    /// [`COMMIT_MESSAGE_TTL`]; past [`MOST_COMMIT_MESSAGES`] folders the oldest is dropped. The
    /// caller has checked `message` ([`check_commit_message`]).
    ///
    /// Each one carries a `sequence` that rises with every publish: at least the clock in
    /// milliseconds, so it keeps rising across a restart. The sequence is taken, the folder
    /// updated and the intent broadcast under one lock, so concurrent publishers are announced
    /// in the order the folder kept them, and a client keeps a folder's highest sequence.
    pub(crate) fn publish_commit_message(
        &self,
        thread_id: &str,
        cwd: &str,
        message: &str,
        actor: Value,
    ) -> (Value, usize) {
        let now = time::OffsetDateTime::now_utc();
        let mut messages = self.lock_messages();
        let clock = u64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0);
        let sequence = self
            .shared
            .sequence
            .load(Ordering::Relaxed)
            .saturating_add(1)
            .max(clock);
        self.shared.sequence.store(sequence, Ordering::Relaxed);
        let intent = json!({
            "kind": "commitMessage",
            "intentId": Uuid::new_v4().to_string(),
            "sequence": sequence,
            "threadId": thread_id,
            "cwd": cwd,
            "message": message,
            "actor": actor,
            "createdAt": iso(now),
            "expiresAt": iso(now + COMMIT_MESSAGE_TTL),
        });
        prune_messages(&mut messages);
        messages.retain(|entry| entry.cwd != cwd);
        messages.push(Message {
            cwd: cwd.to_owned(),
            expires: Instant::now() + COMMIT_MESSAGE_TTL,
            intent: intent.clone(),
        });
        let excess = messages.len().saturating_sub(MOST_COMMIT_MESSAGES);
        messages.drain(..excess);
        // Sending never waits, so it is done in the lock's order.
        let _ = self.shared.published.send(intent.clone());
        drop(messages);
        (intent, self.shared.published.receiver_count())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Pending>> {
        self.shared
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_messages(&self) -> std::sync::MutexGuard<'_, Vec<Message>> {
        self.shared
            .messages
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn prune(pending: &mut Vec<Pending>) {
    let now = Instant::now();
    pending.retain(|entry| entry.expires > now);
}

fn prune_messages(messages: &mut Vec<Message>) {
    let now = Instant::now();
    messages.retain(|entry| entry.expires > now);
}

/// Why `message` cannot be a suggested commit message, if it cannot: it must hold text, at
/// most [`MOST_COMMIT_MESSAGE_CHARS`] characters, and no control character but a tab or a line
/// break. A person reads it in the Source Control panel, so nothing in it may hide or redraw
/// what they see there.
pub(crate) fn check_commit_message(message: &str) -> Result<(), &'static str> {
    if message.trim().is_empty() {
        return Err("message must hold text");
    }
    if message.chars().count() > MOST_COMMIT_MESSAGE_CHARS {
        return Err("message is at most 8000 characters");
    }
    if message
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err("message may not contain control characters other than tabs and line breaks");
    }
    Ok(())
}

fn iso(at: time::OffsetDateTime) -> String {
    at.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn refusal(reason: &str, message: &str) -> Value {
    json!({ "_tag": "UiIntentError", "reason": reason, "message": message })
}

/// `ui.publishIntent`'s input: a `focus` intent unless `kind` says otherwise.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PublishInput {
    Focus(FocusInput),
    CommitMessage(CommitMessageInput),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FocusInput {
    thread_id: String,
    surface: String,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitMessageInput {
    thread_id: String,
    cwd: String,
    message: String,
}

impl PublishInput {
    /// Reads the input, taking an input without `kind` as a `focus` intent (slice X4's shape).
    fn read(mut payload: Value) -> Result<Self, serde_json::Error> {
        if let Some(object) = payload.as_object_mut() {
            object
                .entry("kind")
                .or_insert_with(|| Value::String("focus".to_owned()));
        }
        serde_json::from_value(payload)
    }
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
    let input = match PublishInput::read(payload)
        .map_err(|error| refusal("invalid", &format!("Invalid UI intent: {error}")))?
    {
        PublishInput::Focus(input) => input,
        PublishInput::CommitMessage(input) => {
            return publish_commit_message(intents, input, actor);
        }
    };
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

fn publish_commit_message(
    intents: &UiIntents,
    input: CommitMessageInput,
    actor: Value,
) -> Result<Value, Value> {
    if input.thread_id.trim().is_empty() {
        return Err(refusal("invalid", "threadId is required."));
    }
    if input.cwd.is_empty()
        || input.cwd.chars().count() > MOST_CWD_CHARS
        || input.cwd.contains('\0')
        || !Path::new(&input.cwd).is_absolute()
    {
        return Err(refusal("invalid", "cwd is the thread's absolute folder."));
    }
    check_commit_message(&input.message).map_err(|reason| refusal("invalid", reason))?;
    let (intent, subscribers) =
        intents.publish_commit_message(&input.thread_id, &input.cwd, &input.message, actor);
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
            |intents: &UiIntents| json!({ "type": "snapshot", "intents": intents.snapshot() });
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
        assert_eq!(intents.len(), 1);
        tokio::time::advance(FOCUS_TTL - Duration::from_millis(1)).await;
        assert_eq!(intents.len(), 1);
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(intents.len(), 0);
    }

    fn agent(n: usize) -> Value {
        crate::mcp::activity::actor(&format!("session-{n}"), None)
    }

    #[tokio::test(start_paused = true)]
    async fn one_credential_holds_at_most_64_pending_intents_across_threads() {
        let intents = UiIntents::new();
        for thread in 0..MOST_PENDING_PER_CLIENT {
            intents
                .publish_focus(&format!("t{thread}"), "thread", None, agent(1))
                .unwrap();
        }
        let refused = intents
            .publish_focus("t-more", "thread", None, agent(1))
            .unwrap_err();
        assert_eq!(refused["reason"], "limit");
        // Another credential has its own allowance.
        intents
            .publish_focus("t-more", "thread", None, agent(2))
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn the_server_holds_at_most_256_pending_intents_and_snapshots_the_newest_64() {
        let intents = UiIntents::new();
        let mut published = Vec::new();
        for client in 0..5 {
            for thread in 0..MOST_PENDING_PER_CLIENT {
                let (intent, _) = intents
                    .publish_focus(
                        &format!("t{client}-{thread}"),
                        "thread",
                        None,
                        agent(client),
                    )
                    .unwrap();
                published.push(intent["intentId"].clone());
            }
        }
        assert_eq!(published.len(), 320);
        // The oldest are evicted first.
        assert_eq!(intents.len(), MOST_PENDING);
        let snapshot = intents.snapshot();
        assert_eq!(snapshot.len(), SNAPSHOT_INTENTS);
        let ids: Vec<&Value> = snapshot.iter().map(|intent| &intent["intentId"]).collect();
        assert_eq!(
            ids,
            published[published.len() - SNAPSHOT_INTENTS..]
                .iter()
                .collect::<Vec<_>>()
        );
        // An evicted intent freed its credential's allowance.
        intents
            .publish_focus("t0-new", "thread", None, agent(0))
            .unwrap();
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

    fn messages(intents: &UiIntents) -> Vec<Value> {
        intents
            .snapshot()
            .into_iter()
            .filter(|intent| intent["kind"] == "commitMessage")
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn a_commit_message_is_the_last_one_per_folder_for_24_hours() {
        let intents = UiIntents::new();
        let (first, _) = intents.publish_commit_message("t1", "/repo/a", "First", actor());
        assert_eq!(first["kind"], "commitMessage");
        assert_eq!(first["cwd"], "/repo/a");
        assert_eq!(first["message"], "First");
        intents.publish_commit_message("t2", "/repo/b", "Other folder", actor());
        let hour = Duration::from_secs(3_600);
        tokio::time::advance(hour).await;
        let (replaced, _) = intents.publish_commit_message("t1", "/repo/a", "Second", actor());
        let kept = messages(&intents);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0]["message"], "Other folder");
        assert_eq!(kept[1]["intentId"], replaced["intentId"]);
        // Focus limits never count it.
        assert_eq!(intents.len(), 0);
        tokio::time::advance(COMMIT_MESSAGE_TTL - hour - Duration::from_millis(1)).await;
        assert_eq!(messages(&intents).len(), 2);
        tokio::time::advance(Duration::from_millis(1)).await;
        let kept = messages(&intents);
        assert_eq!(kept.len(), 1, "the other folder's expired after 24 hours");
        assert_eq!(kept[0]["message"], "Second");
        tokio::time::advance(hour).await;
        assert!(messages(&intents).is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_flood_of_focus_intents_never_evicts_a_commit_message() {
        let intents = UiIntents::new();
        let (kept, _) = intents.publish_commit_message("t1", "/repo", "Keep me", actor());
        for client in 0..5 {
            for thread in 0..MOST_PENDING_PER_CLIENT {
                intents
                    .publish_focus(
                        &format!("t{client}-{thread}"),
                        "thread",
                        None,
                        agent(client),
                    )
                    .unwrap();
            }
        }
        let snapshot = intents.snapshot();
        assert_eq!(snapshot.len(), SNAPSHOT_INTENTS + 1);
        assert_eq!(snapshot.last().unwrap()["intentId"], kept["intentId"]);
    }

    #[tokio::test(start_paused = true)]
    async fn at_most_64_folders_keep_a_commit_message() {
        let intents = UiIntents::new();
        for folder in 0..=MOST_COMMIT_MESSAGES {
            intents.publish_commit_message("t1", &format!("/repo/{folder}"), "Message", actor());
        }
        let kept = messages(&intents);
        assert_eq!(kept.len(), MOST_COMMIT_MESSAGES);
        assert_eq!(kept[0]["cwd"], "/repo/1", "the oldest folder was dropped");
    }

    #[test]
    fn interleaved_publishers_keep_and_announce_the_highest_sequence_last() {
        let intents = UiIntents::new();
        let mut stream = intents.subscribe();
        std::thread::scope(|scope| {
            for writer in 0..4 {
                let intents = &intents;
                scope.spawn(move || {
                    for index in 0..25 {
                        intents.publish_commit_message(
                            "t1",
                            "/repo",
                            &format!("{writer}-{index}"),
                            actor(),
                        );
                    }
                });
            }
        });
        let mut announced = Vec::new();
        while let Ok(intent) = stream.try_recv() {
            announced.push(intent["sequence"].as_u64().expect("a sequence"));
        }
        // Each publish has its own sequence, announced in the order the folder kept them.
        // Fewer than the stream holds (128), so none is lost to lag.
        assert_eq!(announced.len(), 4 * 25);
        assert!(
            announced.windows(2).all(|pair| pair[0] < pair[1]),
            "{announced:?}"
        );
        let kept = messages(&intents);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["sequence"], *announced.last().unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn a_sequence_keeps_rising_across_a_restart() {
        let before = UiIntents::new();
        let (first, _) = before.publish_commit_message("t1", "/repo", "Before", actor());
        // A restarted server starts from the clock, so its first sequence is still higher.
        std::thread::sleep(Duration::from_millis(2));
        let after = UiIntents::new();
        let (second, _) = after.publish_commit_message("t1", "/repo", "After", actor());
        assert!(second["sequence"].as_u64() > first["sequence"].as_u64());
    }

    #[test]
    fn a_commit_message_holds_bounded_visible_text() {
        assert!(check_commit_message("Fix it\n\n\tDetails\r\n").is_ok());
        assert!(check_commit_message(&"x".repeat(MOST_COMMIT_MESSAGE_CHARS)).is_ok());
        for refused in [
            String::new(),
            " \n\t".to_owned(),
            "x".repeat(MOST_COMMIT_MESSAGE_CHARS + 1),
            "escape \u{1b}[2J".to_owned(),
            "nul\0".to_owned(),
        ] {
            assert!(check_commit_message(&refused).is_err(), "{refused:?}");
        }
    }

    #[test]
    fn an_input_without_kind_is_a_focus_intent_and_kinds_keep_their_own_fields() {
        assert!(matches!(
            PublishInput::read(json!({ "threadId": "t1", "surface": "thread" })),
            Ok(PublishInput::Focus(_))
        ));
        assert!(matches!(
            PublishInput::read(
                json!({ "kind": "commitMessage", "threadId": "t1", "cwd": "/repo", "message": "Fix" })
            ),
            Ok(PublishInput::CommitMessage(_))
        ));
        for refused in [
            json!({ "kind": "commitMessage", "threadId": "t1", "surface": "thread" }),
            json!({ "threadId": "t1", "cwd": "/repo", "message": "Fix" }),
            json!({ "kind": "terminal", "threadId": "t1" }),
            json!({ "kind": "commitMessage", "threadId": "t1", "cwd": "/repo", "message": "Fix", "extra": 1 }),
        ] {
            assert!(PublishInput::read(refused.clone()).is_err(), "{refused}");
        }
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
        assert_eq!(intents.len(), 0);
        for path in ["../outside", "/etc/passwd", "a/../../b", "a\\b"] {
            assert!(!is_relative_literal(path), "{path}");
        }
        assert!(is_relative_literal("src/main.rs"));
        assert!(is_relative_literal("./README.md"));
    }
}
