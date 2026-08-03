# OpenCode Byte-Budgeted Text Coverage Design

**Date:** 2026-07-25

**Status:** Approved design, pending written-spec review

## Context

Plan 05 Task 2 maps verified OpenCode child-session text into deterministic
activity entries. Live SSE deltas use provider-derived entry identities, while
cumulative REST/SSE snapshots reconcile which live bytes have already been
projected.

The Task 2 fix loop reached its five-round breaker with one load-bearing
defect. `MAX_LIVE_TEXT_EVENTS` is currently 2,049, independent of the 16,384
byte text-coverage budget. A stream of 2,050 one-byte deltas therefore evicts
the oldest unreconciled segment while only one eighth of the byte budget is in
use. The next cumulative snapshot cannot prove that all of its bytes were
already emitted and can duplicate 2,049 entries.

Tasks 3 and 4 depend on this tracker for REST reconciliation and descendant SSE
routing, so they must not proceed until the boundary is corrected.

## Goals

- Retain exact per-event coverage until the 16,384 byte coverage budget is
  exhausted.
- Ensure a count limit can never evict a non-empty segment before the byte
  limit would.
- Preserve provider-derived delta entry IDs, 100 ms batch timing, replay
  idempotence, newest-backward snapshot matching, and retry-safe mutation
  acceptance.
- Make saturation at the byte boundary explicit instead of silently emitting a
  cumulative duplicate.
- Keep tracker state bounded by bytes and count under hostile input.

## Non-Goals

- Increasing the 16,384 byte activity-detail contract.
- Persisting an unbounded event-ID set.
- Replacing OpenCode REST history recovery in Task 3.
- Refactoring the complete OpenCode activity module.
- Changing root-chat text projection or tool/command lifecycle mapping.

## Considered Approaches

### 1. Byte-derived event bound with a saturation marker — selected

Derive the maximum live segment count from `MAX_TEXT_BYTES`. Empty deltas are
ignored, so every retained segment consumes at least one byte. A count bound of
`MAX_TEXT_BYTES` therefore cannot fire before the byte budget.

When adding a segment requires dropping coverage because the byte budget is
actually full, record a bounded saturation flag. The next authoritative
snapshot advances the baseline without echoing its candidate suffix and emits
one deterministic recovery/truncation marker.

This keeps the current per-event segment representation and matching algorithm,
directly fixes the failing boundary, and makes the unavoidable lossy case
truthful.

### 2. Packed byte ring plus segment-length table

Store content in a compact ring and preserve event boundaries in a parallel
length table. This lowers per-segment allocation overhead, but requires a
larger rewrite of matching, UTF-8 boundary handling, and prefix eviction. It is
valuable only if profiling later shows the bounded `VecDeque<String>` overhead
is material.

### 3. Digest evicted prefixes

Retain only a rolling digest and length for dropped coverage, then compare it
with a later snapshot prefix. This has subtle failure modes when history
contains bytes that were missed from the live stream, and complicates
incremental digest verification. It adds more state and ambiguity than the
selected design.

## State and Invariants

`BoundedTextAccumulator` keeps its ordered per-event `live_segments` and adds a
boolean coverage-saturation flag.

The following invariants are mandatory:

1. `live_bytes <= MAX_TEXT_BYTES`.
2. Empty live segments are never retained.
3. `live_segments.len() <= MAX_TEXT_BYTES`, because each retained segment is at
   least one byte.
4. The event-count bound is derived from `MAX_TEXT_BYTES`; it is not derived
   from the seen-event cache.
5. Dropping any unreconciled segment sets the saturation flag.
6. Snapshot reconciliation never emits the full candidate suffix while the
   saturation flag is set.
7. The saturation marker has a deterministic entry ID and is emitted at most
   once for an authoritative snapshot identity.
8. Coverage, normalized text, pending entries, and seen state advance only
   after the corresponding pending mutation is accepted, preserving retry
   behavior at the 256-mutation boundary.

## Data Flow

### Live delta

1. Validate provider, session, message, part, event identity, ownership, and
   non-empty text.
2. Produce the stable provider-event-derived pending activity entry.
3. After the entry is accepted into bounded pending state, append its bounded
   text as one live coverage segment.
4. If the byte budget requires prefix eviction, evict deterministically from
   the oldest segment and set the saturation flag.
5. Flush accepted entries using the existing 100 ms batch boundary.

### Cumulative snapshot without saturation

Use the existing newest-backward per-event coverage matching. Remove only the
segments proven covered by the authoritative suffix. Stale replay noise remains
bounded and cannot prevent newer segments from matching.

### Cumulative snapshot after saturation

The tracker can no longer prove byte-for-byte coverage for the dropped prefix.
It therefore:

1. does not append the candidate snapshot suffix as commentary;
2. queues one deterministic `[truncated; recover from history]` marker for the
   snapshot identity;
3. advances the bounded authoritative baseline to the snapshot; and
4. clears live coverage and the saturation flag only through the same
   acceptance-safe pending-state transition used by ordinary snapshot entries.

This prevents duplicates while explicitly reporting that exact coverage was
lost at the declared byte boundary.

## Bounds and Failure Behavior

- Live coverage content: 16,384 bytes per text stream.
- Live coverage segments: at most 16,384 non-empty segments per text stream.
- Pending text events: unchanged at 256.
- Text streams: unchanged at 256.
- Native IDs: unchanged at 64 bytes.
- Oversized individual inputs: unchanged deterministic truncation marker.
- Byte-window saturation: one deterministic recovery marker; never an
  unmarked cumulative duplicate.
- Invalid or empty deltas: ignored before consuming segment or seen-state
  capacity.

## Tests

The implementation must add RED tests before production changes:

1. **Same-stream count boundary:** emit 2,050 distinct one-byte deltas for one
   part, reconcile the cumulative snapshot, and prove no previously emitted
   suffix is appended again.
2. **Exact byte boundary:** retain 16,384 one-byte segments without count-based
   eviction or a recovery marker.
3. **One byte over budget:** the 16,385th one-byte segment triggers exactly one
   deterministic recovery marker; the cumulative snapshot does not duplicate
   its candidate suffix.
4. **Recovery after saturation:** a new live delta and later snapshot reconcile
   normally after the saturation marker is accepted.
5. **UTF-8 and empty inputs:** multi-byte text respects byte boundaries, while
   empty deltas consume no segment capacity.
6. **Regression matrix:** existing replay-after-seen-eviction, equal-text
   collision, 100 ms batching, whitespace, history caps, output retry, and
   release huge-input tests remain green.

Required verification:

```text
cargo test -p bibcode-server --test provider_opencode activity_tracker_ -- --nocapture
cargo test -p bibcode-server --test provider_opencode -- --nocapture
cargo test -p bibcode-server --lib activity_output_accepts_exactly_256_mutations_and_returns_the_257th_for_retry -- --nocapture
cargo test --release -p bibcode-server --test provider_opencode activity_tracker_truncates_a_huge_delta_once_with_explicit_recovery_evidence -- --nocapture
vp check
vp run typecheck
```

## Rollout

This repair is a new Plan 05 Task 2b, not a sixth fix-loop round. It receives a
fresh implementer, its own TDD evidence, and a clean independent review gate.
After approval, Task 2 is marked complete and Tasks 3 and 4 may resume.
