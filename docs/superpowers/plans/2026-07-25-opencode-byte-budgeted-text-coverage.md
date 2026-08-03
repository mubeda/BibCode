# OpenCode Byte-Budgeted Text Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair OpenCode live-text reconciliation so unreconciled per-event
coverage is retained until the 16,384 byte budget is exhausted, with an
explicit marker when exact coverage is no longer available.

**Architecture:** Keep provider-event-derived delta entries and the existing
newest-backward snapshot matcher. Derive the live segment-count limit from the
byte contract so it cannot bind early, and add an acceptance-safe saturation
state that suppresses cumulative duplicates and emits one deterministic
recovery marker only at the true byte boundary.

**Tech Stack:** Rust, Serde JSON, SHA-256 identities, Plan 01 activity
mutations, OpenCode provider integration tests.

## Global Constraints

- The approved design is
  `docs/superpowers/specs/2026-07-25-opencode-byte-budgeted-text-coverage-design.md`.
- `MAX_TEXT_BYTES` remains exactly 16,384.
- Every retained live segment is non-empty and individually bounded.
- Segment count is bounded by `MAX_TEXT_BYTES`, never by the 2,048-entry seen
  cache.
- Provider-event-derived entry IDs, 100 ms batching, newest-backward matching,
  history caps, and mutation retry behavior must remain unchanged.
- Saturation is explicit through one deterministic
  `[truncated; recover from history]` marker; a saturated snapshot must never
  append the full candidate suffix.
- No root-chat, graph, lifecycle, tool, command, or runtime-routing behavior is
  changed.
- Production changes follow RED-GREEN-REFACTOR.

---

### Task 1: Retain exact live coverage through the byte boundary

**Files:**

- Modify: `apps/server/src/provider/opencode/activity.rs`
- Modify: `apps/server/tests/provider_opencode.rs`
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**

- Consumes:
  - `BoundedTextAccumulator`
  - `push_live_segment`
  - `handle_text_part`
  - `enqueue_snapshot`
  - `MAX_TEXT_BYTES`
  - `TRUNCATION_MARKER`
- Produces:
  - byte-derived live segment capacity;
  - acceptance-safe `coverage_saturated` state;
  - one deterministic saturation marker per authoritative snapshot identity;
  - unchanged `OpenCodeActivityOutput` and `ProviderActivityMutation`
    interfaces for Plans 05 Tasks 3 and 4.

- [x] **Step 1: Add a failing 2,050-event same-stream regression**

Create a focused integration test named:

```rust
#[test]
fn activity_tracker_retains_same_stream_coverage_past_seen_cache_capacity() {
    let mut tracker = OpenCodeActivityFixtureAdapter::new("root");
    tracker.reconcile_children(
        "root",
        &json!([{"id":"child","parentID":"root","time":{"created":1}}]),
    );
    tracker.handle_event(&json!({
        "id":"assistant",
        "type":"message.updated",
        "properties":{
            "sessionID":"child",
            "info":{"id":"message","sessionID":"child","role":"assistant"}
        }
    }));
    let mut cumulative = String::new();
    let mut emitted_ids = Vec::new();

    for index in 0..2_050_u64 {
        let delta = char::from(b'a' + u8::try_from(index % 26).unwrap()).to_string();
        cumulative.push_str(&delta);
        let output = tracker.handle_event_at(
            &json!({
                "id": format!("same-stream-{index}"),
                "type": "message.part.delta",
                "properties": {
                    "sessionID": "child",
                    "messageID": "message",
                    "partID": "part",
                    "field": "text",
                    "delta": delta
                }
            }),
            index.saturating_mul(101),
        );
        for batch in [output, tracker.flush_text()] {
            emitted_ids.extend(batch.mutations.into_iter().filter_map(|mutation| {
                match mutation {
                    ProviderActivityMutation::AppendEntry(entry) => Some(entry.id),
                    _ => None,
                }
            }));
        }
    }

    assert_eq!(emitted_ids.len(), 2_050);
    let snapshot = tracker.handle_event_at(
        &json!({
            "id":"snapshot",
            "type":"message.part.updated",
            "properties":{
                "sessionID":"child",
                "part":{
                    "id":"part",
                    "sessionID":"child",
                    "messageID":"message",
                    "type":"text",
                    "text":cumulative
                }
            }
        }),
        300_000,
    );
    assert!(snapshot.mutations.is_empty());
    assert!(tracker.flush_text().mutations.is_empty());
}
```

Use the existing test imports for `json`,
`OpenCodeActivityFixtureAdapter`, and `ProviderActivityMutation`; do not add
production-public test APIs.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p bibcode-server --test provider_opencode \
  activity_tracker_retains_same_stream_coverage_past_seen_cache_capacity \
  -- --nocapture
```

Expected failure: the cumulative snapshot emits a duplicate commentary entry
because the 2,049-event cap evicted one unreconciled segment.

- [x] **Step 3: Add direct byte-boundary RED tests**

In the private `#[cfg(test)]` module for `activity.rs`, add:

```rust
#[test]
fn live_coverage_count_cannot_bind_before_the_byte_budget() {
    let mut stream = BoundedTextAccumulator::default();
    for _ in 0..MAX_TEXT_BYTES {
        push_live_segment(&mut stream, "x");
    }
    assert_eq!(stream.live_bytes, MAX_TEXT_BYTES);
    assert_eq!(stream.live_segments.len(), MAX_TEXT_BYTES);
    assert!(!stream.coverage_saturated);
}

#[test]
fn live_coverage_marks_the_first_byte_over_budget() {
    let mut stream = BoundedTextAccumulator::default();
    for _ in 0..=MAX_TEXT_BYTES {
        push_live_segment(&mut stream, "x");
    }
    assert_eq!(stream.live_bytes, MAX_TEXT_BYTES);
    assert_eq!(stream.live_segments.len(), MAX_TEXT_BYTES);
    assert!(stream.coverage_saturated);
}

#[test]
fn empty_live_segments_consume_no_capacity() {
    let mut stream = BoundedTextAccumulator::default();
    push_live_segment(&mut stream, "");
    assert_eq!(stream.live_bytes, 0);
    assert!(stream.live_segments.is_empty());
    assert!(!stream.coverage_saturated);
}
```

Run:

```bash
cargo test -p bibcode-server --lib live_coverage_ -- --nocapture
```

Expected RED: `coverage_saturated` does not exist and the current count limit
evicts before `MAX_TEXT_BYTES`.

- [x] **Step 4: Derive count capacity from the byte contract**

In `activity.rs`, replace the seen-cache-derived constant and add saturation
state:

```rust
const MAX_LIVE_TEXT_EVENTS: usize = MAX_TEXT_BYTES;

#[derive(Debug, Default)]
struct BoundedTextAccumulator {
    normalized: String,
    live_segments: VecDeque<String>,
    live_bytes: usize,
    coverage_saturated: bool,
    pending: VecDeque<PendingTextEntry>,
    pending_bytes: usize,
    pending_at_ms: Option<u64>,
}
```

Update `push_live_segment` so empty input returns immediately, any prefix
eviction sets `coverage_saturated = true`, and both byte and derived count
bounds remain asserted:

```rust
fn push_live_segment(stream: &mut BoundedTextAccumulator, value: &str) {
    let segment = bounded_text(value);
    if segment.is_empty() {
        return;
    }
    while !stream.live_segments.is_empty()
        && (stream.live_segments.len() == MAX_LIVE_TEXT_EVENTS
            || stream.live_bytes.saturating_add(segment.len()) > MAX_TEXT_BYTES)
    {
        if let Some(removed) = stream.live_segments.pop_front() {
            stream.live_bytes = stream.live_bytes.saturating_sub(removed.len());
            stream.coverage_saturated = true;
        }
    }
    stream.live_bytes = stream.live_bytes.saturating_add(segment.len());
    stream.live_segments.push_back(segment);
    debug_assert!(stream.live_bytes <= MAX_TEXT_BYTES);
    debug_assert!(stream.live_segments.len() <= MAX_LIVE_TEXT_EVENTS);
}
```

- [x] **Step 5: Add saturation-marker integration RED**

Add a test named
`activity_tracker_marks_true_live_coverage_saturation_without_snapshot_echo`.
Drive one text stream to exactly `MAX_TEXT_BYTES` bytes, add one more one-byte
delta, then submit a changed cumulative snapshot.

After handling the snapshot, define
`let snapshot_and_flush = [snapshot, tracker.flush_text()];`, collect
commentary details directly from `AppendEntry` mutations, and assert:

```rust
let details = snapshot_and_flush
    .into_iter()
    .flat_map(|output| output.mutations)
    .filter_map(|mutation| match mutation {
        ProviderActivityMutation::AppendEntry(entry) => entry.detail,
        _ => None,
    })
    .collect::<Vec<_>>();
assert_eq!(
    details,
    vec!["[truncated; recover from history]".to_owned()]
);
assert!(!details.iter().any(|detail| detail == &cumulative));
```

Repeat the same snapshot and prove the marker ID is stable and the repository
would receive no distinct duplicate. Then emit a new provider delta and prove
its stable live entry still appears once.

Run:

```bash
cargo test -p bibcode-server --test provider_opencode \
  activity_tracker_marks_true_live_coverage_saturation_without_snapshot_echo \
  -- --nocapture
```

Expected RED: the tracker has no saturation branch and can append a cumulative
candidate after coverage eviction.

- [x] **Step 6: Implement acceptance-safe saturation reconciliation**

Before ordinary newest-backward matching in `handle_text_part`, detect a
changed authoritative snapshot while `coverage_saturated` is true.

Create this private helper:

```rust
fn saturation_marker(
    session_id: &str,
    message_id: &str,
    part_id: &str,
    normalized: &str,
    at_ms: u64,
) -> PendingTextEntry {
    let snapshot_digest = digest(normalized);
    PendingTextEntry {
        id: entry_id(
            message_id,
            part_id,
            &format!("coverage-saturated:{snapshot_digest}"),
        ),
        semantic: format!(
            "text-coverage-saturated:{session_id}:{message_id}:{part_id}:{snapshot_digest}"
        ),
        detail: TRUNCATION_MARKER.to_owned(),
        at_ms,
        snapshot_base: None,
    }
}
```

Required behavior:

1. An unchanged or older snapshot does not clear genuine live segments.
2. A changed snapshot with saturated coverage queues the marker through
   `enqueue_snapshot`.
3. If enqueueing fails because pending state is full, normalized/live/saturated
   state remains unchanged and retryable.
4. After enqueue acceptance, update the bounded normalized baseline, clear live
   coverage, and reset `coverage_saturated`.
5. Do not enqueue the candidate snapshot suffix in the saturation branch.
6. Repeated identical snapshots use the same marker identity and do not create
   a distinct repository entry.

- [x] **Step 7: Verify focused GREEN**

Run:

```bash
cargo test -p bibcode-server --lib live_coverage_ -- --nocapture
cargo test -p bibcode-server --test provider_opencode \
  activity_tracker_retains_same_stream_coverage_past_seen_cache_capacity \
  -- --nocapture
cargo test -p bibcode-server --test provider_opencode \
  activity_tracker_marks_true_live_coverage_saturation_without_snapshot_echo \
  -- --nocapture
```

Expected: all new tests pass.

- [x] **Step 8: Run the complete regression matrix**

Run:

```bash
cargo test -p bibcode-server --test provider_opencode activity_tracker_ -- --nocapture
cargo test -p bibcode-server --test provider_opencode -- --nocapture
cargo test -p bibcode-server --lib \
  activity_output_accepts_exactly_256_mutations_and_returns_the_257th_for_retry \
  -- --nocapture
cargo test --release -p bibcode-server --test provider_opencode \
  activity_tracker_truncates_a_huge_delta_once_with_explicit_recovery_evidence \
  -- --nocapture
vp check
vp run typecheck
```

Expected:

- all focused and provider tests pass;
- release huge-input behavior emits bounded explicit recovery evidence;
- formatting, lint, and typecheck pass with no new warnings or errors.

- [x] **Step 9: Commit the repair**

```bash
git add apps/server/src/provider/opencode/activity.rs \
  apps/server/tests/provider_opencode.rs
git commit -m "fix(opencode): retain text coverage to byte limit"
```

- [x] **Step 10: Complete parent-plan bookkeeping after review**

Only after an independent reviewer approves Task 1:

- change Plan 05 Task 2 from `BLOCKED` to complete in
  `.superpowers/sdd/progress.md`;
- record the exact Task 2b commit range and review verdict;
- leave the earlier five-round history intact; and
- resume Plan 05 Task 3.
