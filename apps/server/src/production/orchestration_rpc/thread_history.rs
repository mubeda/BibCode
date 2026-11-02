//! The thread history window (#226): a windowed thread stream opens with recent history under a
//! byte budget, and older history arrives in pages.
//!
//! A history row (message, activity, reasoning, proposed plan) has the key
//! `K = (createdAt, kindRank, id)`, the timeline's order across kinds. A window has a fixed
//! floor, `{ K | ALL, openedAt, epoch }`, and a row is in it when it's recent by `K`, was
//! written after the window opened (`written_sequence > openedAt`), or is live (streaming, or a
//! delivery that is still in flight or needs the user). A row only ever enters the window, so
//! index patches stay exact and nothing outside it is sent as a removal. A revert starts a new
//! history epoch, which invalidates the window and every page cursor of the thread.
//!
//! See `docs/plans/2026-11-01-thread-history-window-design.md`.

use std::collections::{HashMap, HashSet};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::orchestration::OrchestrationEngine;
use crate::persistence::ThreadHistoryMarks;
use crate::rpc::RpcResult;

/// The whole first thread value of a window (shell, live rows, carried rows, turn index and
/// history rows), as serialized JSON before the transport's deflate. The big-thread fixture of
/// the transfer budget is 6.1 MB decoded (`remote-load-3g-20261102.md`); about 1 MiB decoded is
/// about 300 KB on the wire, a few seconds at 3G.
pub(super) const HISTORY_OPEN_BYTES: usize = 1024 * 1024;
/// The most history rows a window opens with, live rows included.
pub(super) const HISTORY_WINDOW_ROWS: usize = 500;
/// The most user messages, so turns, a window opens with.
pub(super) const HISTORY_WINDOW_TURNS: usize = 10;
/// The most rows one history page holds.
pub(super) const HISTORY_PAGE_ROWS: usize = 75;
/// The most bytes one history page's rows serialize to; a page always holds its first row.
pub(super) const HISTORY_PAGE_BYTES: usize = 512 * 1024;
/// The most a reconnecting client's floor may admit before the server opens a fresh window.
pub(super) const HISTORY_FLOOR_HONOUR_BYTES: usize = 4 * 1024 * 1024;
/// What the floor and the counts may add to the value after the open budget was measured.
const OPEN_BUDGET_SLACK: usize = 512;

/// The four history arrays of a thread value, by kind rank.
const HISTORY_ARRAYS: [&str; 4] = ["messages", "activities", "reasoning", "proposedPlans"];
const MESSAGE: u8 = 0;
const ACTIVITY: u8 = 1;
const REASONING: u8 = 2;
const PLAN: u8 = 3;

/// `K = (createdAt, kindRank, id)`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub(super) struct HistoryKey(String, u8, String);

/// A window's floor or a page cursor: base64url JSON on the wire, opaque to the client. It holds
/// ids, timestamps and sequences, never content.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct HistoryFloor {
    v: u8,
    /// `None` is `ALL`: the whole thread (a floor), or nothing older (never a cursor).
    k: Option<HistoryKey>,
    #[serde(rename = "openedAt")]
    opened_at: i64,
    epoch: i64,
}

impl HistoryFloor {
    fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).expect("a floor serializes"))
    }

    fn decode(text: &str) -> Option<Self> {
        let floor: Self = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(text).ok()?).ok()?;
        (floor.v == 1).then_some(floor)
    }

    fn admits(&self, row: &RowMeta) -> bool {
        self.k.as_ref().is_none_or(|k| row.key >= *k) || row.written > self.opened_at || row.live
    }
}

/// What the window rule reads of one history row of the full thread value.
struct RowMeta {
    rank: u8,
    index: usize,
    key: HistoryKey,
    written: i64,
    live: bool,
    turn_id: Option<String>,
    user: bool,
}

fn row_metas(thread: &Value, marks: &ThreadHistoryMarks) -> Vec<RowMeta> {
    let mut metas = Vec::new();
    for (rank, name) in (0u8..).zip(HISTORY_ARRAYS) {
        let written = match rank {
            MESSAGE => &marks.messages,
            ACTIVITY => &marks.activities,
            REASONING => &marks.reasoning,
            _ => &marks.proposed_plans,
        };
        for (index, row) in rows(thread, name).iter().enumerate() {
            let id = row["id"].as_str().unwrap_or_default();
            let streaming = row["streaming"] == true;
            let live = match rank {
                MESSAGE => {
                    streaming
                        || matches!(
                            row.pointer("/delivery/state").and_then(Value::as_str),
                            Some("queued" | "pending" | "sending" | "uncertain" | "failed")
                        )
                }
                REASONING => streaming,
                _ => false,
            };
            metas.push(RowMeta {
                rank,
                index,
                key: HistoryKey(
                    row["createdAt"].as_str().unwrap_or_default().to_owned(),
                    rank,
                    id.to_owned(),
                ),
                written: written.get(id).copied().unwrap_or(0),
                live,
                turn_id: row["turnId"].as_str().map(str::to_owned),
                user: rank == MESSAGE && row["role"] == "user",
            });
        }
    }
    metas
}

fn rows<'a>(thread: &'a Value, name: &str) -> &'a [Value] {
    thread[name].as_array().map_or(&[], Vec::as_slice)
}

fn row<'a>(thread: &'a Value, meta: &RowMeta) -> &'a Value {
    &rows(thread, HISTORY_ARRAYS[usize::from(meta.rank)])[meta.index]
}

/// Serialized JSON bytes of a value, counted without building the text.
pub(super) fn json_bytes(value: &Value) -> usize {
    crate::json_size::encoded_json_len(value).unwrap_or(usize::MAX)
}

/// The state rows current state needs, selected as the web's readers select them, by activity
/// and plan id: every open request, the effective context-window and MCP status rows, the newest
/// plan (overall and of the latest turn) and the source plan of a running implementation.
/// Carried only when the window doesn't hold them.
struct CarriedSelection {
    activities: HashSet<String>,
    plans: HashSet<String>,
}

fn carried_selection(thread: &Value, marks: &ThreadHistoryMarks) -> CarriedSelection {
    let mut activities = HashSet::new();
    let mut context_window = None;
    let mut mcp_status = HashMap::<&str, &str>::new();
    // Canonical activity order (sequence, createdAt, id): the order the readers scan backwards.
    for activity in rows(thread, "activities") {
        let Some(id) = activity["id"].as_str() else {
            continue;
        };
        let request = activity
            .pointer("/payload/requestId")
            .and_then(Value::as_str);
        match (activity["kind"].as_str(), request) {
            (Some("approval.requested"), Some(request))
                if marks.pending_approvals.contains(request) =>
            {
                activities.insert(id.to_owned());
            }
            (Some("user-input.requested"), Some(request))
                if marks.open_user_inputs.contains(request) =>
            {
                activities.insert(id.to_owned());
            }
            _ => {}
        }
        if is_valid_context_window(activity) {
            context_window = Some(id);
        }
        if let Some(instance) = valid_mcp_status_instance(activity) {
            mcp_status.insert(instance, id);
        }
    }
    activities.extend(context_window.map(str::to_owned));
    activities.extend(mcp_status.into_values().map(str::to_owned));

    let plans = rows(thread, "proposedPlans");
    let newest = |of_turn: Option<&str>| {
        plans
            .iter()
            .filter(|plan| of_turn.is_none_or(|turn| plan["turnId"].as_str() == Some(turn)))
            .max_by(|left, right| {
                let order = |plan: &Value| {
                    (
                        plan["updatedAt"].as_str().unwrap_or_default().to_owned(),
                        plan["id"].as_str().unwrap_or_default().to_owned(),
                    )
                };
                order(left).cmp(&order(right))
            })
            .and_then(|plan| plan["id"].as_str())
    };
    let mut selected_plans = HashSet::new();
    selected_plans.extend(newest(None).map(str::to_owned));
    if let Some(latest_turn) = thread.pointer("/latestTurn/turnId").and_then(Value::as_str) {
        selected_plans.extend(newest(Some(latest_turn)).map(str::to_owned));
    }
    selected_plans.extend(
        plans
            .iter()
            .filter_map(|plan| plan["id"].as_str())
            .filter(|id| marks.running_source_plans.contains(*id))
            .map(str::to_owned),
    );
    CarriedSelection {
        activities,
        plans: selected_plans,
    }
}

/// `deriveLatestContextWindowSnapshot`'s test of a row (`apps/web/src/lib/contextWindow.ts`).
fn is_valid_context_window(activity: &Value) -> bool {
    activity["kind"] == "context-window.updated"
        && activity
            .pointer("/payload/usedTokens")
            .and_then(Value::as_f64)
            .is_some_and(|tokens| tokens.is_finite() && tokens >= 0.0)
}

/// The provider instance of an MCP status row `deriveMcpStatusSnapshot` would read
/// (`apps/web/src/components/chat/McpStatusPopover.tsx`): its snapshot parses.
fn valid_mcp_status_instance(activity: &Value) -> Option<&str> {
    let payload = activity["payload"].as_object()?;
    let is_status = match payload.get("eventType") {
        None => activity["summary"] == "mcp.status.updated",
        Some(event_type) => event_type == "mcp.status.updated",
    };
    if !is_status {
        return None;
    }
    let instance = payload.get("providerInstanceId")?.as_str()?;
    let servers = payload.get("servers")?.as_array()?;
    let valid = servers.iter().all(|server| {
        let Some(server) = server.as_object() else {
            return false;
        };
        let named = server
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty());
        let state = server
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| {
                matches!(
                    state,
                    "connected" | "starting" | "needs-auth" | "disconnected" | "error"
                )
            });
        let detail = server
            .get("detail")
            .is_none_or(|detail| detail.as_str().is_some_and(|text| !text.trim().is_empty()));
        named && state && detail
    });
    valid.then_some(instance)
}

/// Builds the windowed thread value: the rows `in_window` holds, in the server's order, the
/// carried rows it doesn't hold, every checkpoint (with `files` only for the window's turns) and
/// the `history` metadata.
fn build(
    full: &Value,
    metas: &[RowMeta],
    carried: &CarriedSelection,
    in_window: &[bool],
    floor: &HistoryFloor,
) -> Value {
    let thread = &full["thread"];
    let mut out = thread
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .filter(|(key, _)| {
                    !HISTORY_ARRAYS.contains(&key.as_str()) && key.as_str() != "checkpoints"
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    let mut held: [HashSet<usize>; 4] = Default::default();
    let mut turns = HashSet::new();
    let mut older_rows = 0usize;
    for (meta, &inside) in metas.iter().zip(in_window) {
        if inside {
            held[usize::from(meta.rank)].insert(meta.index);
            if let Some(turn) = &meta.turn_id {
                turns.insert(turn.as_str());
            }
        } else {
            older_rows += 1;
        }
    }
    for (rank, name) in HISTORY_ARRAYS.iter().enumerate() {
        let kept = rows(thread, name)
            .iter()
            .enumerate()
            .filter(|(index, _)| held[rank].contains(index))
            .map(|(_, row)| row.clone())
            .collect();
        out.insert((*name).to_owned(), Value::Array(kept));
    }
    let carried_rows = |rank: u8, ids: &HashSet<String>| {
        rows(thread, HISTORY_ARRAYS[usize::from(rank)])
            .iter()
            .enumerate()
            .filter(|(index, row)| {
                !held[usize::from(rank)].contains(index)
                    && row["id"].as_str().is_some_and(|id| ids.contains(id))
            })
            .map(|(_, row)| row.clone())
            .collect::<Vec<_>>()
    };
    let checkpoints = rows(thread, "checkpoints")
        .iter()
        .map(|checkpoint| {
            let mut checkpoint = checkpoint.clone();
            let in_window = checkpoint["turnId"]
                .as_str()
                .is_some_and(|turn| turns.contains(turn));
            if !in_window {
                // The turn index: #227's `filesTotal` stays, the list waits for a page.
                checkpoint["files"] = json!([]);
            }
            checkpoint
        })
        .collect();
    out.insert("checkpoints".to_owned(), Value::Array(checkpoints));
    out.insert(
        "history".to_owned(),
        json!({
            "floor": floor.encode(),
            "hasOlder": older_rows > 0,
            "olderRows": older_rows,
            "carried": {
                "activities": carried_rows(ACTIVITY, &carried.activities),
                "proposedPlans": carried_rows(PLAN, &carried.plans),
            },
        }),
    );
    json!({ "snapshotSequence": full["snapshotSequence"], "thread": Value::Object(out) })
}

fn admitted(floor: &HistoryFloor, metas: &[RowMeta]) -> Vec<bool> {
    metas.iter().map(|meta| floor.admits(meta)).collect()
}

/// Chooses a fresh floor at open (§3 of the design): the fixed parts first, then history rows
/// newest first by `K` until the byte, row or turn budget, the newest row always; the floor is
/// the oldest whole turn reached, or the oldest row taken inside one oversized turn.
fn choose_floor(
    full: &Value,
    metas: &[RowMeta],
    carried: &CarriedSelection,
    opened_at: i64,
    epoch: i64,
) -> HistoryFloor {
    let all = HistoryFloor {
        v: 1,
        k: None,
        opened_at,
        epoch,
    };
    let thread = &full["thread"];
    let mut candidates = (0..metas.len())
        .filter(|&index| !metas[index].live)
        .collect::<Vec<_>>();
    candidates.sort_by(|&left, &right| metas[right].key.cmp(&metas[left].key));
    let Some(&newest) = candidates.first() else {
        return all;
    };
    let live = metas.iter().map(|meta| meta.live).collect::<Vec<_>>();
    let probe = HistoryFloor {
        k: Some(metas[newest].key.clone()),
        ..all.clone()
    };
    let fixed = json_bytes(&build(full, metas, carried, &live, &probe)) + OPEN_BUDGET_SLACK;
    let budget = HISTORY_OPEN_BYTES.saturating_sub(fixed);
    let files_bytes = rows(thread, "checkpoints")
        .iter()
        .filter_map(|checkpoint| {
            Some((
                checkpoint["turnId"].as_str()?,
                json_bytes(&checkpoint["files"]).saturating_sub(2),
            ))
        })
        .collect::<HashMap<_, _>>();
    let mut counted_turns = metas
        .iter()
        .filter(|meta| meta.live)
        .filter_map(|meta| meta.turn_id.as_deref())
        .collect::<HashSet<_>>();
    let (mut bytes, mut rows_taken, mut users) = (0usize, live.iter().filter(|l| **l).count(), 0);
    let (mut taken, mut cut, mut oldest) = (0usize, None, None);
    for (position, &index) in candidates.iter().enumerate() {
        let meta = &metas[index];
        let new_turn = meta
            .turn_id
            .as_deref()
            .filter(|turn| !counted_turns.contains(turn));
        let cost = json_bytes(row(thread, meta))
            + 1
            + new_turn
                .and_then(|turn| files_bytes.get(turn))
                .copied()
                .unwrap_or(0);
        let over = bytes + cost > budget
            || rows_taken + 1 > HISTORY_WINDOW_ROWS
            || (meta.user && users + 1 > HISTORY_WINDOW_TURNS);
        if position > 0 && over {
            break;
        }
        bytes += cost;
        rows_taken += 1;
        taken += 1;
        counted_turns.extend(new_turn);
        if meta.user {
            users += 1;
            cut = Some(meta.key.clone());
        }
        oldest = Some(meta.key.clone());
    }
    if taken == candidates.len() {
        return all;
    }
    HistoryFloor {
        k: cut.or(oldest),
        ..all
    }
}

/// A windowed thread subscription's floor, fixed for the subscription unless a revert moves the
/// thread to a new history epoch.
pub(super) struct HistoryWindow {
    floor: Option<HistoryFloor>,
    /// The floor the client echoed, tried once at open.
    client_floor: Option<HistoryFloor>,
}

/// The `history` input of `orchestration.subscribeThread`: a client that holds a window echoes
/// its floor.
#[derive(Debug, Default, Deserialize)]
pub(super) struct HistoryInput {
    #[serde(default)]
    floor: Option<String>,
}

impl HistoryWindow {
    pub(super) fn new(input: &HistoryInput) -> Self {
        Self {
            floor: None,
            client_floor: input.floor.as_deref().and_then(HistoryFloor::decode),
        }
    }

    /// Reads the thread and applies the window. The flag is true when this read chose a new
    /// floor after the first: a revert moved the epoch, and the subscriber needs a snapshot.
    pub(super) async fn read(
        &mut self,
        engine: &OrchestrationEngine,
        thread_id: &str,
    ) -> (RpcResult, bool) {
        match load(engine, thread_id).await {
            Ok((full, marks)) => {
                let (value, rewindowed) = self.apply(&full, &marks);
                (Ok(value), rewindowed)
            }
            Err(error) => (Err(error), false),
        }
    }

    /// Applies the window to a full thread value `{snapshotSequence, thread}`.
    pub(super) fn apply(&mut self, full: &Value, marks: &ThreadHistoryMarks) -> (Value, bool) {
        let metas = row_metas(&full["thread"], marks);
        let carried = carried_selection(&full["thread"], marks);
        let opened_at = full["snapshotSequence"].as_i64().unwrap_or(0);
        let fresh = |metas: &[RowMeta]| choose_floor(full, metas, &carried, opened_at, marks.epoch);
        let (floor, rewindowed) = match self.floor.take() {
            Some(floor) if floor.epoch == marks.epoch => (floor, false),
            Some(_) => (fresh(&metas), true),
            None => {
                let honoured = self.client_floor.take().filter(|floor| {
                    floor.epoch == marks.epoch
                        && json_bytes(&build(
                            full,
                            &metas,
                            &carried,
                            &admitted(floor, &metas),
                            floor,
                        )) <= HISTORY_FLOOR_HONOUR_BYTES
                });
                (honoured.unwrap_or_else(|| fresh(&metas)), false)
            }
        };
        let value = build(full, &metas, &carried, &admitted(&floor, &metas), &floor);
        self.floor = Some(floor);
        (value, rewindowed)
    }
}

async fn load(
    engine: &OrchestrationEngine,
    thread_id: &str,
) -> Result<(Value, ThreadHistoryMarks), Value> {
    let full = super::thread_snapshot(engine, thread_id).await?;
    let marks = engine
        .repositories()
        .load_thread_history_marks(thread_id.to_owned())
        .await
        .map_err(|error| super::orchestration_error("OrchestrationGetSnapshotError", error))?;
    Ok((full, marks))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryPageInput {
    thread_id: String,
    cursor: String,
}

const METHOD: &str = "orchestration.getThreadHistoryPage";
const FAILED: &str = "OrchestrationGetThreadHistoryPageError";
const STALE: &str = "OrchestrationThreadHistoryStaleError";

fn page_error(tag: &str, message: &str) -> Value {
    json!({ "_tag": tag, "message": message })
}

/// `orchestration.getThreadHistoryPage`: the rows older than the cursor that its window doesn't
/// hold (`written_sequence <= openedAt` and not live), newest first, up to
/// [`HISTORY_PAGE_ROWS`] and [`HISTORY_PAGE_BYTES`], with the full checkpoints of their turns.
pub(super) async fn history_page(
    engine: &OrchestrationEngine,
    input: HistoryPageInput,
) -> RpcResult {
    let Some(cursor) = HistoryFloor::decode(&input.cursor).filter(|cursor| cursor.k.is_some())
    else {
        tracing::warn!(method = METHOD, thread_id = %input.thread_id, reason = "malformed cursor", "history page refused");
        return Err(page_error(FAILED, "The history cursor is not valid."));
    };
    let (full, marks) = load(engine, &input.thread_id).await.map_err(|error| {
        tracing::warn!(method = METHOD, thread_id = %input.thread_id, reason = "thread unavailable", "history page refused");
        page_error(
            FAILED,
            error["message"].as_str().unwrap_or("The thread could not be read."),
        )
    })?;
    page_of(&full, &marks, &cursor).inspect_err(|_| {
        tracing::warn!(method = METHOD, thread_id = %input.thread_id, reason = "stale cursor", "history page refused");
    })
}

/// The page under `cursor` of a full thread value, or the stale error when a revert moved the
/// thread to a new history epoch since the cursor's window opened.
pub(super) fn page_of(
    full: &Value,
    marks: &ThreadHistoryMarks,
    cursor: &HistoryFloor,
) -> RpcResult {
    let Some(below) = cursor.k.as_ref() else {
        return Err(page_error(FAILED, "The history cursor is not valid."));
    };
    if cursor.epoch != marks.epoch {
        return Err(page_error(
            STALE,
            "The thread's history changed since this window opened.",
        ));
    }
    let thread = &full["thread"];
    let metas = row_metas(thread, marks);
    let mut candidates = metas
        .iter()
        .filter(|meta| meta.key < *below && meta.written <= cursor.opened_at && !meta.live)
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.key.cmp(&left.key));
    let mut page: [Vec<Value>; 4] = Default::default();
    let (mut bytes, mut taken) = (0usize, 0usize);
    let mut turns = HashSet::new();
    for meta in &candidates {
        let row = row(thread, meta);
        let cost = json_bytes(row) + 1;
        if taken > 0 && (taken + 1 > HISTORY_PAGE_ROWS || bytes + cost > HISTORY_PAGE_BYTES) {
            break;
        }
        bytes += cost;
        taken += 1;
        page[usize::from(meta.rank)].push(row.clone());
        turns.extend(meta.turn_id.as_deref());
    }
    let remaining = candidates.len() - taken;
    let next = (remaining > 0).then(|| {
        HistoryFloor {
            k: Some(candidates[taken - 1].key.clone()),
            ..cursor.clone()
        }
        .encode()
    });
    let checkpoints = rows(thread, "checkpoints")
        .iter()
        .filter(|checkpoint| {
            checkpoint["turnId"]
                .as_str()
                .is_some_and(|turn| turns.contains(turn))
        })
        .cloned()
        .collect::<Vec<_>>();
    let [messages, activities, reasoning, proposed_plans] = page;
    Ok(json!({
        "messages": messages,
        "activities": activities,
        "reasoning": reasoning,
        "proposedPlans": proposed_plans,
        "checkpoints": checkpoints,
        "cursor": next,
        "olderRows": remaining,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENED_AT: i64 = 1_000;

    fn at(index: usize) -> String {
        format!(
            "2026-11-01T{:02}:{:02}:{:02}.000Z",
            index / 3600,
            (index / 60) % 60,
            index % 60
        )
    }

    fn message(id: &str, role: &str, index: usize, turn: Option<&str>, text: usize) -> Value {
        json!({
            "id": id, "turnId": turn, "role": role, "text": "x".repeat(text), "attachments": [],
            "streaming": false, "createdAt": at(index), "updatedAt": at(index),
        })
    }

    fn activity(id: &str, index: usize, turn: Option<&str>, kind: &str, payload: Value) -> Value {
        json!({
            "id": id, "turnId": turn, "tone": "tool", "kind": kind, "summary": kind,
            "payload": payload, "sequence": index, "createdAt": at(index),
        })
    }

    fn plan(id: &str, index: usize, turn: Option<&str>) -> Value {
        json!({
            "id": id, "turnId": turn, "planMarkdown": "Do it", "implementedAt": null,
            "implementationThreadId": null, "createdAt": at(index), "updatedAt": at(index),
        })
    }

    fn checkpoint(turn: &str, count: usize, files: usize) -> Value {
        let files = (0..files)
            .map(|file| json!({"path": format!("src/{file:04}.rs"), "kind": "modified", "additions": 1, "deletions": 0}))
            .collect::<Vec<_>>();
        json!({
            "turnId": turn, "checkpointTurnCount": count, "checkpointRef": format!("ref-{count}"),
            "status": "ready", "filesTotal": files.len(), "files": files,
            "assistantMessageId": null, "completedAt": at(count),
        })
    }

    /// A full thread value, its arrays in the server's order.
    fn full(
        messages: Vec<Value>,
        mut activities: Vec<Value>,
        reasoning: Vec<Value>,
        mut plans: Vec<Value>,
        checkpoints: Vec<Value>,
    ) -> Value {
        activities.sort_by_key(|row| row["sequence"].as_i64());
        plans.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
        json!({
            "snapshotSequence": OPENED_AT,
            "thread": {
                "id": "t1", "title": "Thread", "latestTurn": null, "session": null,
                "messages": messages, "activities": activities, "reasoning": reasoning,
                "proposedPlans": plans, "checkpoints": checkpoints,
            },
        })
    }

    /// `turns` turns: a user message, then `replies` assistant messages of `text` bytes.
    fn turns(turns: usize, replies: usize, text: usize) -> Vec<Value> {
        let mut rows = Vec::new();
        for turn in 0..turns {
            let base = turn * (replies + 1);
            let turn_id = format!("turn-{turn:03}");
            rows.push(message(&format!("u{turn:03}"), "user", base, None, 10));
            for reply in 0..replies {
                rows.push(message(
                    &format!("a{turn:03}-{reply:03}"),
                    "assistant",
                    base + reply + 1,
                    Some(&turn_id),
                    text,
                ));
            }
        }
        rows
    }

    fn open(full: &Value, marks: &ThreadHistoryMarks) -> Value {
        HistoryWindow::new(&HistoryInput::default())
            .apply(full, marks)
            .0
    }

    fn reopen(full: &Value, marks: &ThreadHistoryMarks, floor: &Value) -> Value {
        HistoryWindow::new(&HistoryInput {
            floor: floor.as_str().map(str::to_owned),
        })
        .apply(full, marks)
        .0
    }

    fn ids(thread: &Value, name: &str) -> Vec<String> {
        rows(thread, name)
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_owned())
            .collect()
    }

    fn history_rows(thread: &Value) -> usize {
        HISTORY_ARRAYS
            .iter()
            .map(|name| rows(thread, name).len())
            .sum()
    }

    fn floor_of(window: &Value) -> HistoryFloor {
        HistoryFloor::decode(window["thread"]["history"]["floor"].as_str().unwrap()).unwrap()
    }

    /// Every page from the window's floor to the end.
    fn every_page(full: &Value, marks: &ThreadHistoryMarks, window: &Value) -> Vec<Value> {
        let mut pages = Vec::new();
        let mut cursor = floor_of(window);
        loop {
            let page = page_of(full, marks, &cursor).expect("a page");
            let next = page["cursor"]
                .as_str()
                .map(|text| HistoryFloor::decode(text).unwrap());
            pages.push(page);
            match next {
                Some(next) => cursor = next,
                None => return pages,
            }
        }
    }

    #[test]
    fn thread_window_over_budget_opens_under_the_byte_row_and_turn_budgets() {
        // 30 turns of 150 KB replies: about 4.5 MB, so the byte budget binds before the turns.
        let full = full(turns(30, 1, 150_000), vec![], vec![], vec![], vec![]);
        let window = open(&full, &ThreadHistoryMarks::default());
        let thread = &window["thread"];
        assert!(
            json_bytes(&window) <= HISTORY_OPEN_BYTES,
            "{}",
            json_bytes(&window)
        );
        assert!(history_rows(thread) <= HISTORY_WINDOW_ROWS);
        let users = rows(thread, "messages")
            .iter()
            .filter(|row| row["role"] == "user")
            .count();
        assert!(users < HISTORY_WINDOW_TURNS, "{users}");
        assert_eq!(thread["history"]["hasOlder"], true);
        assert_eq!(
            thread["history"]["olderRows"],
            60 - history_rows(thread),
            "olderRows counts every row the window doesn't hold"
        );
        assert_eq!(
            rows(thread, "messages")[0]["role"],
            "user",
            "every turn is whole"
        );

        // The turn cap binds on small turns, the row cap on a long run of small rows.
        let small = open(
            &super::tests::full(turns(30, 1, 10), vec![], vec![], vec![], vec![]),
            &ThreadHistoryMarks::default(),
        );
        let users = rows(&small["thread"], "messages")
            .iter()
            .filter(|row| row["role"] == "user")
            .count();
        assert_eq!(users, HISTORY_WINDOW_TURNS);
    }

    #[test]
    fn thread_window_opens_a_single_900_row_turn_with_its_newest_rows_and_older_count() {
        let mut messages = vec![message("u", "user", 0, None, 10)];
        let activities = (1..=900)
            .map(|index| {
                activity(
                    &format!("a{index:03}"),
                    index,
                    Some("turn"),
                    "command",
                    json!({ "step": index }),
                )
            })
            .collect::<Vec<_>>();
        messages.push(message("reply", "assistant", 901, Some("turn"), 10));
        let full = full(messages, activities, vec![], vec![], vec![]);
        let window = open(&full, &ThreadHistoryMarks::default());
        let thread = &window["thread"];
        assert_eq!(history_rows(thread), HISTORY_WINDOW_ROWS);
        assert_eq!(ids(thread, "messages"), ["reply"]);
        let activities = ids(thread, "activities");
        assert_eq!(activities.first().map(String::as_str), Some("a402"));
        assert_eq!(activities.last().map(String::as_str), Some("a900"));
        assert_eq!(thread["history"]["hasOlder"], true);
        assert_eq!(thread["history"]["olderRows"], 902 - HISTORY_WINDOW_ROWS);
    }

    #[test]
    fn thread_window_takes_an_oversized_newest_row_alone() {
        let full = full(
            vec![
                message("u", "user", 0, None, 10),
                message("huge", "assistant", 1, Some("turn"), 3 * 1024 * 1024),
            ],
            vec![],
            vec![],
            vec![],
            vec![],
        );
        let thread = &open(&full, &ThreadHistoryMarks::default())["thread"];
        assert_eq!(ids(thread, "messages"), ["huge"]);
        assert_eq!(thread["history"]["olderRows"], 1);
    }

    #[test]
    fn an_empty_thread_opens_with_the_all_floor_and_no_older_history() {
        let window = open(
            &full(vec![], vec![], vec![], vec![], vec![]),
            &ThreadHistoryMarks::default(),
        );
        assert_eq!(floor_of(&window).k, None);
        assert_eq!(window["thread"]["history"]["hasOlder"], false);
        assert_eq!(window["thread"]["history"]["olderRows"], 0);
    }

    #[test]
    fn a_thread_under_budget_opens_whole_with_the_all_floor() {
        let full = full(
            turns(5, 2, 100),
            vec![],
            vec![],
            vec![plan("p", 3, Some("turn-000"))],
            vec![checkpoint("turn-000", 1, 3)],
        );
        let window = open(&full, &ThreadHistoryMarks::default());
        assert_eq!(floor_of(&window).k, None);
        assert_eq!(window["thread"]["history"]["hasOlder"], false);
        for name in HISTORY_ARRAYS.iter().chain(&["checkpoints"]) {
            assert_eq!(window["thread"][name], full["thread"][name], "{name}");
        }
    }

    #[test]
    fn a_cold_open_includes_a_streaming_message_and_reasoning_row_that_predate_the_floor() {
        let mut messages = turns(30, 1, 10);
        let mut early = message("streaming", "assistant", 0, Some("turn-000"), 10);
        early["streaming"] = json!(true);
        messages.push(early);
        let reasoning = vec![json!({
            "id": "thinking", "turnId": "turn-000", "text": "...", "streaming": true,
            "createdAt": at(0), "updatedAt": at(0),
        })];
        let window = open(
            &full(messages, vec![], reasoning, vec![], vec![]),
            &ThreadHistoryMarks::default(),
        );
        let thread = &window["thread"];
        assert_eq!(thread["history"]["hasOlder"], true);
        assert!(ids(thread, "messages").contains(&"streaming".to_owned()));
        assert_eq!(ids(thread, "reasoning"), ["thinking"]);
    }

    #[test]
    fn live_rows_include_every_in_flight_and_unresolved_delivery() {
        let mut messages = turns(30, 1, 10);
        for (index, state) in [
            "queued",
            "pending",
            "sending",
            "uncertain",
            "failed",
            "delivered",
            "dismissed",
        ]
        .iter()
        .enumerate()
        {
            let mut row = message(state, "user", index, None, 10);
            row["delivery"] = json!({ "state": state, "provider": "codex" });
            messages.push(row);
        }
        let full = full(messages, vec![], vec![], vec![], vec![]);
        let marks = ThreadHistoryMarks::default();
        let window = open(&full, &marks);
        let held = ids(&window["thread"], "messages");
        for live in ["queued", "pending", "sending", "uncertain", "failed"] {
            assert!(held.contains(&live.to_owned()), "{live} is live");
        }
        for settled in ["delivered", "dismissed"] {
            assert!(!held.contains(&settled.to_owned()), "{settled} is history");
        }
        // Live rows are never paged.
        let paged = every_page(&full, &marks, &window)
            .iter()
            .flat_map(|page| ids(page, "messages"))
            .collect::<Vec<_>>();
        assert!(paged.contains(&"delivered".to_owned()));
        assert!(!paged.iter().any(|id| {
            ["queued", "pending", "sending", "uncertain", "failed"].contains(&id.as_str())
        }));
    }

    #[test]
    fn history_pages_never_return_a_live_row() {
        let mut messages = turns(40, 1, 10);
        let mut streaming = message("streaming", "assistant", 2, Some("turn-001"), 10);
        streaming["streaming"] = json!(true);
        messages.push(streaming);
        let full = full(messages, vec![], vec![], vec![], vec![]);
        let marks = ThreadHistoryMarks::default();
        let window = open(&full, &marks);
        for page in every_page(&full, &marks, &window) {
            assert!(
                rows(&page, "messages")
                    .iter()
                    .all(|row| row["streaming"] == false)
            );
        }
    }

    fn open_requests_marks() -> ThreadHistoryMarks {
        ThreadHistoryMarks {
            pending_approvals: ["approve-open".to_owned()].into(),
            open_user_inputs: ["ask-open".to_owned(), "ask-turnless".to_owned()].into(),
            ..ThreadHistoryMarks::default()
        }
    }

    #[test]
    fn carried_rows_hold_every_open_request_below_the_floor() {
        let activities = vec![
            activity(
                "approval-open",
                1,
                Some("turn-000"),
                "approval.requested",
                json!({ "requestId": "approve-open" }),
            ),
            activity(
                "approval-closed",
                2,
                Some("turn-000"),
                "approval.requested",
                json!({ "requestId": "approve-closed" }),
            ),
            activity(
                "ask-open",
                3,
                Some("turn-001"),
                "user-input.requested",
                json!({ "requestId": "ask-open" }),
            ),
            activity(
                "ask-turnless",
                4,
                None,
                "user-input.requested",
                json!({ "requestId": "ask-turnless" }),
            ),
            activity(
                "ask-closed",
                5,
                None,
                "user-input.requested",
                json!({ "requestId": "ask-closed" }),
            ),
        ];
        let full = full(turns(30, 1, 10), activities, vec![], vec![], vec![]);
        let window = open(&full, &open_requests_marks());
        let history = &window["thread"]["history"];
        assert_eq!(history["hasOlder"], true);
        assert!(ids(&window["thread"], "activities").is_empty());
        let mut carried = ids(&history["carried"], "activities");
        carried.sort();
        assert_eq!(carried, ["approval-open", "ask-open", "ask-turnless"]);
    }

    #[test]
    fn carried_status_is_the_newest_valid_row_when_a_newer_row_is_malformed() {
        let mcp = |instance: &str, state: &str| json!({ "eventType": "mcp.status.updated", "providerInstanceId": instance, "servers": [{ "name": "docs", "state": state }] });
        let activities = vec![
            activity(
                "usage-valid",
                1,
                None,
                "context-window.updated",
                json!({ "usedTokens": 1000 }),
            ),
            activity(
                "usage-malformed",
                2,
                None,
                "context-window.updated",
                json!({ "usedTokens": "lots" }),
            ),
            activity("mcp-a-valid", 3, None, "mcp.status", mcp("a", "connected")),
            activity(
                "mcp-a-malformed",
                4,
                None,
                "mcp.status",
                mcp("a", "exploded"),
            ),
            activity("mcp-b-valid", 5, None, "mcp.status", mcp("b", "needs-auth")),
        ];
        let full = full(turns(30, 1, 10), activities, vec![], vec![], vec![]);
        let window = open(&full, &ThreadHistoryMarks::default());
        let mut carried = ids(&window["thread"]["history"]["carried"], "activities");
        carried.sort();
        assert_eq!(carried, ["mcp-a-valid", "mcp-b-valid", "usage-valid"]);
    }

    /// The shared fixture the web readers run too (`contextWindow.test.ts`,
    /// `McpStatusPopover.test.ts`): the server carries exactly the row each reader selects.
    #[test]
    fn carried_status_selection_matches_the_shared_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/contracts/fixtures/thread-stream/carried-status.json");
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("JSON");
        for case in fixture["cases"].as_array().expect("cases") {
            let thread = json!({ "activities": case["activities"], "proposedPlans": [] });
            let selected = carried_selection(&thread, &ThreadHistoryMarks::default()).activities;
            let mut expected = case["mcpStatus"]
                .as_object()
                .expect("mcpStatus")
                .values()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<HashSet<_>>();
            expected.extend(case["contextWindow"].as_str().map(str::to_owned));
            assert_eq!(selected, expected, "{}", case["name"]);
        }
    }

    #[test]
    fn carried_rows_hold_the_newest_plan_and_the_source_plan_of_a_running_implementation() {
        let plans = vec![
            plan("plan-source", 1, Some("turn-000")),
            plan("plan-old", 2, Some("turn-000")),
            plan("plan-newest", 3, Some("turn-001")),
        ];
        let mut full = full(turns(30, 1, 10), vec![], vec![], plans, vec![]);
        full["thread"]["latestTurn"] = json!({ "turnId": "turn-000" });
        let marks = ThreadHistoryMarks {
            running_source_plans: ["plan-source".to_owned()].into(),
            ..ThreadHistoryMarks::default()
        };
        let window = open(&full, &marks);
        let mut carried = ids(&window["thread"]["history"]["carried"], "proposedPlans");
        carried.sort();
        // The newest overall, the newest of the latest turn, and the running source plan.
        assert_eq!(carried, ["plan-newest", "plan-old", "plan-source"]);
    }

    #[test]
    fn a_carried_row_leaves_the_carried_set_once_the_window_holds_the_selected_row() {
        let activities = vec![activity(
            "ask",
            1,
            None,
            "user-input.requested",
            json!({ "requestId": "ask-open" }),
        )];
        let full = full(turns(30, 1, 10), activities, vec![], vec![], vec![]);
        let marks = open_requests_marks();
        let window = open(&full, &marks);
        assert_eq!(
            ids(&window["thread"]["history"]["carried"], "activities"),
            ["ask"]
        );
        // The row is written again after the window opened: the window holds it now.
        let mut written = marks.clone();
        written.activities.insert("ask".to_owned(), OPENED_AT + 1);
        let next = reopen(&full, &written, &window["thread"]["history"]["floor"]);
        assert_eq!(ids(&next["thread"], "activities"), ["ask"]);
        assert!(ids(&next["thread"]["history"]["carried"], "activities").is_empty());
    }

    #[test]
    fn history_pages_return_every_older_row_exactly_once_in_order() {
        let activities = (0..400)
            .map(|index| {
                activity(
                    &format!("act{index:03}"),
                    index * 2 + 1,
                    Some("t"),
                    "command",
                    json!({}),
                )
            })
            .collect::<Vec<_>>();
        let reasoning = (0..50)
            .map(|index| json!({"id": format!("r{index:02}"), "turnId": "t", "text": "...", "streaming": false, "createdAt": at(index * 5), "updatedAt": at(index * 5)}))
            .collect::<Vec<_>>();
        let full = full(
            turns(60, 3, 2_000),
            activities,
            reasoning,
            vec![plan("p", 7, None)],
            vec![],
        );
        let marks = ThreadHistoryMarks::default();
        let window = open(&full, &marks);
        let pages = every_page(&full, &marks, &window);
        assert!(pages.len() >= 2);
        assert_eq!(pages.last().unwrap()["cursor"], Value::Null);
        assert_eq!(pages.last().unwrap()["olderRows"], 0);
        // Newest first across pages: each page's keys sort below the previous page's.
        let mut keys = Vec::new();
        for page in &pages {
            let mut page_keys = Vec::new();
            for (rank, name) in (0u8..).zip(HISTORY_ARRAYS) {
                for row in rows(page, name) {
                    page_keys.push(HistoryKey(
                        row["createdAt"].as_str().unwrap().to_owned(),
                        rank,
                        row["id"].as_str().unwrap().to_owned(),
                    ));
                }
            }
            page_keys.sort();
            if let (Some(last), Some(first)) = (keys.last(), page_keys.last()) {
                assert!(first < last, "a page sorts below the one before it");
            }
            keys.extend(page_keys.into_iter().rev());
        }
        let mut union = HashMap::<&str, Vec<String>>::new();
        for name in HISTORY_ARRAYS {
            union
                .entry(name)
                .or_default()
                .extend(ids(&window["thread"], name));
            for page in &pages {
                union.entry(name).or_default().extend(ids(page, name));
            }
            let mut expected = ids(&full["thread"], name);
            let mut got = union[name].clone();
            expected.sort();
            got.sort();
            assert_eq!(got, expected, "{name}: every row exactly once");
        }
    }

    #[test]
    fn history_page_respects_its_row_and_byte_caps() {
        let full = full(turns(200, 1, 100), vec![], vec![], vec![], vec![]);
        let marks = ThreadHistoryMarks::default();
        let window = open(&full, &marks);
        let page = page_of(&full, &marks, &floor_of(&window)).unwrap();
        assert_eq!(rows(&page, "messages").len(), HISTORY_PAGE_ROWS);

        let big = super::tests::full(turns(40, 1, 200_000), vec![], vec![], vec![], vec![]);
        let window = open(&big, &marks);
        let page = page_of(&big, &marks, &floor_of(&window)).unwrap();
        let bytes: usize = rows(&page, "messages").iter().map(json_bytes).sum();
        assert!(bytes <= HISTORY_PAGE_BYTES, "{bytes}");
        assert!(!rows(&page, "messages").is_empty());

        // A row over the cap still comes alone.
        let huge = super::tests::full(
            vec![
                message("u0", "user", 0, None, 10),
                message("huge", "assistant", 1, Some("t0"), 700_000),
                message("u1", "user", 2, None, 10),
                message("big", "assistant", 3, Some("t1"), 3 * 1024 * 1024),
            ],
            vec![],
            vec![],
            vec![],
            vec![],
        );
        let window = open(&huge, &marks);
        assert_eq!(ids(&window["thread"], "messages"), ["big"]);
        let page = page_of(&huge, &marks, &floor_of(&window)).unwrap();
        assert_eq!(ids(&page, "messages"), ["u1"]);
        let page = page_of(
            &huge,
            &marks,
            &HistoryFloor::decode(page["cursor"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(ids(&page, "messages"), ["huge"]);
    }

    #[test]
    fn history_page_returns_full_checkpoints_for_its_turns() {
        let checkpoints = (0..30)
            .map(|turn| checkpoint(&format!("turn-{turn:03}"), turn + 1, 5))
            .collect();
        let full = full(turns(30, 1, 10), vec![], vec![], vec![], checkpoints);
        let marks = ThreadHistoryMarks::default();
        let window = open(&full, &marks);
        // The window's checkpoints: every one, with files only for its own turns.
        let index = rows(&window["thread"], "checkpoints");
        assert_eq!(index.len(), 30);
        assert_eq!(index[0]["files"], json!([]));
        assert_eq!(index[0]["filesTotal"], 5);
        assert_eq!(index[29]["files"].as_array().unwrap().len(), 5);
        let page = page_of(&full, &marks, &floor_of(&window)).unwrap();
        let page_turns = rows(&page, "messages")
            .iter()
            .filter_map(|row| row["turnId"].as_str())
            .collect::<HashSet<_>>();
        assert!(!page_turns.is_empty());
        for checkpoint in rows(&page, "checkpoints") {
            assert!(page_turns.contains(checkpoint["turnId"].as_str().unwrap()));
            assert_eq!(checkpoint["files"].as_array().unwrap().len(), 5);
        }
        assert_eq!(rows(&page, "checkpoints").len(), page_turns.len());
    }

    #[test]
    fn history_page_rejects_a_malformed_cursor() {
        let full = full(turns(30, 1, 10), vec![], vec![], vec![], vec![]);
        let all = HistoryFloor {
            v: 1,
            k: None,
            opened_at: OPENED_AT,
            epoch: 0,
        };
        let error = page_of(&full, &ThreadHistoryMarks::default(), &all).unwrap_err();
        assert_eq!(error["_tag"], FAILED);
        for text in ["", "not base64!", &URL_SAFE_NO_PAD.encode("{\"v\":2}")] {
            assert_eq!(HistoryFloor::decode(text), None, "{text}");
        }
    }

    #[test]
    fn history_page_rejects_a_cursor_from_before_a_revert() {
        let full = full(turns(30, 1, 10), vec![], vec![], vec![], vec![]);
        let window = open(&full, &ThreadHistoryMarks::default());
        let reverted = ThreadHistoryMarks {
            epoch: OPENED_AT + 5,
            ..ThreadHistoryMarks::default()
        };
        let error = page_of(&full, &reverted, &floor_of(&window)).unwrap_err();
        assert_eq!(error["_tag"], STALE);
    }

    #[test]
    fn a_resubscribe_whose_floor_admits_a_settled_oversized_row_gets_a_fresh_window() {
        let mut messages = turns(30, 1, 10);
        let marks = ThreadHistoryMarks::default();
        let window = open(
            &full(messages.clone(), vec![], vec![], vec![], vec![]),
            &marks,
        );
        let floor = window["thread"]["history"]["floor"].clone();
        // A row below the floor streamed past the reconnect cap and settled after the window
        // opened: the old floor would admit it.
        messages[1]["text"] = json!("x".repeat(HISTORY_FLOOR_HONOUR_BYTES + 1));
        let mut grown = full(messages, vec![], vec![], vec![], vec![]);
        grown["snapshotSequence"] = json!(OPENED_AT + 1);
        let mut written = marks.clone();
        written
            .messages
            .insert("a000-000".to_owned(), OPENED_AT + 1);
        let next = reopen(&grown, &written, &floor);
        assert_ne!(next["thread"]["history"]["floor"], floor, "a fresh window");
        assert!(json_bytes(&next) <= HISTORY_FLOOR_HONOUR_BYTES);
        // Under the cap, the same floor is honoured.
        let honoured = reopen(&grown, &marks, &floor);
        assert_eq!(honoured["thread"]["history"]["floor"], floor);
    }
}
