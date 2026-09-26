# `orchestration.replayEvents`: byte-budgeted pages

Status: **Approved by the user on 2026-09-26** — Option A: opt-in `paged: true` on the existing method (about 1 MiB pages) plus a 64 MiB fail-fast for unpaged calls. Build after the connection-liveness commit (shares the contracts fixture manifest).

This follows up ruling 11 and controller ruling R11 of the
[connection liveness plan](../plans/2026-09-24-connection-liveness.md), which left replay
pagination out of scope. It builds on ruling 5 (the typed `RpcResponseTooLargeError`), Task 14
(the History and review byte caps) and Task 15 (the cut-off re-issue rule).

Citations were checked on 2026-09-26 against `d87f854f` plus the uncommitted liveness tree. Line
numbers in `rpc/session.rs`, `rpc/transport.rs`, `client-runtime/src/state/runtime.ts` and the
architecture docs may move when that tree lands.

## Problem and evidence

**No first-party caller.**

- Nothing in `apps/web`, `packages/client-runtime`, `packages/shared` or `apps/desktop` calls the
  method. The desktop lists it only in a test (`apps/desktop/src-tauri/src/backend.rs:5920`), and
  `git log -S replayEvents -- apps/web packages/client-runtime` is empty.
- The replay coordinator ported from upstream, `apps/web/src/orchestrationRecovery.ts`, is
  imported only by its test. The research agrees
  (`docs/plans/remote-servers/orca-fixes-since-port-research.md:410-414`).
- Resync uses snapshots. `subscribeShell` and `subscribeThread` send a whole snapshot on subscribe,
  on each relevant event and on lag (`apps/server/src/production/orchestration_rpc.rs:797-866`).

The method is still reachable: any principal with `orchestration:read` can call it
(`apps/server/src/auth/scope.rs:42, 72`; `rpc/methods.rs:88`). The living doc still offers "replay
methods" for recovery (`docs/architecture/rpc-and-orchestration.md:1497-1499`).

**The cost has no bound.**

- **The whole tail is loaded first.** The handler (`orchestration_rpc.rs:169-180`) calls
  `engine.read_events` (`orchestration/engine.rs:2569-2576`). Its `read_all_events` loops over
  128-row batches to the end (`engine.rs:5322-5340`).
- **Then it is copied twice.** `wire_event` builds a `Value` tree
  (`orchestration_rpc.rs:1245-1259`), and the session encodes the whole message before it checks
  the size (`rpc/session.rs:1384-1400`). That is about three copies of the tail at the peak.
- **The log only grows.** Nothing deletes from `orchestration_events`, and each provider text
  delta is its own event (`production/provider_runtime.rs:4573, 4630-4645` →
  `engine.rs:4350-4366`).

A synthetic measurement of the `wire_event` shape (UUID identifiers and a `provider:<uuid>`
command ID; fan-out scratchpad script `fo-design-replay/event_size.py`, not in the repo) gives
707 B of envelope per delta:

- a 16-character delta costs 723 B;
- a 4,000-character reply streamed in 16-character deltas is about 181 KB;
- 64 MiB holds about 92,800 deltas.

The scratchpad's dev stores (4–38 events, no provider traffic) are not representative, and no real
store was measured.

**Today's outcomes.**

| Framing | Limit | Over the limit | Large, under the limit |
| --- | --- | --- | --- |
| E2EE | 64 MiB (`rpc/transport.rs:46, 198-203`) | `RpcResponseTooLargeError` for this request (`session.rs:1396-1400, 1526-1551`), after the whole tail is built | Holds most of the connection's 64 MiB budget (`rpc/e2ee.rs:82`). A concurrent response that does not fit fails with `RpcOutboundAdmissionError` after 5 s (`session.rs:42`). |
| Plain, `bibcode.rpc.chunked.v1` | 64 MiB | Same as E2EE | Transfer time only (no byte budget) |
| Plain, whole frames | none (`transport.rs:200`) | One frame, bounded only by 30 s + size ÷ 16 KiB/s | Nothing arrives until the frame ends: a new client closes with 4408 at 30 s, an old one at 5–10 s. |

64 MiB takes 17 minutes at 64 KiB/s. A late cut-off loses all of it, and Task 15's one re-issue
starts again from zero.

## Goals and non-goals

**Goals:**

- Pages of about 1 MiB of serialized events, always with at least one event, as for History
  (`git/manager/graph.rs:24-45`), with server memory bounded the same way.
- No skipped, reordered or silently truncated events, and an explicit "caught up" signal.
- A caller can resume from its last applied event, with no server state.
- Every pairing of old and new clients and servers keeps working, with no connection `Defect`.
- Defined behavior with `RpcResponseTooLargeError` and with Task 15.

**Non-goals:**

- a first-party replay consumer (this record fixes only its contract and rules);
- event retention or compaction;
- snapshot sizes (covered by the slow-link record);
- the effects lag path (see Related findings).

## Alternatives

**A. Opt-in pages on the existing method (recommended).**

- The input gains `paged: true` (`Schema.optionalKey(Schema.Literal(true))`). With the flag, the
  server returns `{ events, exhausted }`, and the success schema becomes
  `Schema.Union([Schema.Array(OrchestrationEvent), OrchestrationReplayEventsPage])`.
- Unpaged calls keep the array, but the reader fails with `RpcResponseTooLargeError` at 64 MiB
  instead of building the rest.
- An old server ignores `paged`: `ReplayInput` (`orchestration_rpc.rs:1298-1302`) takes serde's
  default of skipping unknown fields. It returns the whole array, which a new client decodes as one
  exhausted page. Old clients never send the flag.

For: one method, an additive change, no negotiation, and an explicit end. Against: a union success
type (one line to normalize), and a paged caller on an old server still pays the unbounded
response.

**B. A new paged method behind a capability.**

- `orchestration.replayEventPage` returns `{ events, exhausted }`, and the server advertises it as
  `capabilities.orchestrationReplayPages` (`apps/server/src/lifecycle.rs:59-65`, like
  `vcsCloneReattach`). `replayEvents` keeps its shape plus the 64 MiB fail-fast.
- A client must check the capability first. An old server answers an unknown tag with a connection
  `Defect` (`session.rs:894-902`), and the Effect client then fails every in-flight request
  (`.repos/effect-smol/packages/effect/src/unstable/rpc/RpcClient.ts:592-593`).

For: clean schemas, and the client knows in advance. Against: capability plumbing, and a second
method in `methods.rs`, `scope.rs`, the contracts, the fixtures and the desktop list. A streaming
variant saves no round trips, because a stream waits for each chunk's `Ack`
(`session.rs:1220-1233`), and the Task 15 latch covers only unary query atoms.

**C. Bound only, or remove.** The 64 MiB fail-fast alone is the smallest change, on the server
only, but large tails still can't be replayed and there is no incremental path. Removing the
method is the least code, but every remaining caller then hits the connection `Defect`, and the
doc's "replay methods" go.

**Rejected outright:** implicit pages that keep the array shape. A caller that expects every event
after N would get a prefix with no signal that it is behind.

**Security.** A and B bound the memory and wire cost equally, but both leave replay open to every
`orchestration:read` principal. Only removing the method (C) closes that surface.

## Recommendation: A

**Server.**

- **Where it lives.** The page builder goes in the RPC adapter (`production/orchestration_rpc.rs`).
  `engine.read_events` stays as it is, because 27 engine-test call sites and the effects producer
  use it.
- **How it reads.** It reads `read_events_from_sequence(cursor, 128)` batches
  (`persistence/repositories.rs:109-132`) and converts each row with `wire_event`.
- **How it counts.** It counts each row's exact encoded length with a counting writer, so escaping
  is included (liveness ruling R8). The writer is `JsonLength` (`session.rs:1593-1617`), exposed as
  `pub(crate)`; it also serves the parked History double-serialization cleanup.
- **Where a page ends.** It stops before the event that would pass `REPLAY_PAGE_TARGET_BYTES`
  (1 MiB, the `COMMIT_PAGE_TARGET_BYTES` value), always keeping one event (`graph.rs:34-45`).
  `exhausted` is true only when a batch comes back short, or a one-row probe finds nothing.
- **Unpaged calls** run the same loop with a `MAX_RECORDED_MESSAGE_BYTES` (64 MiB) ceiling. They
  fail with `RpcResponseTooLargeError { method, bytes, limitBytes }` as soon as the total passes
  it, so `bytes` is a lower bound.
  - The ceiling counts only event bytes, so it keeps a small margin below the limit for the `Exit`
    envelope.
  - The session's own size check (`session.rs:1396-1400`) stays the backstop.
- **Memory.** A request holds one batch plus one page. With 64 in-flight requests (`session.rs:40`),
  a connection holds about 64 MiB instead of an unbounded amount.

**Resume token.**

- **The cursor is the last applied `sequence`.** That is the `INTEGER PRIMARY KEY AUTOINCREMENT` of
  `orchestration_events`, which is never reused or pruned. So the cursor stays valid across
  reconnects and restarts with no server state, and an opaque token would add nothing.
- **It is scoped to `(environmentId, storageInstanceId)`** (`lifecycle.rs:52-55`). Another store
  is another sequence space, so on `storage-changed`
  (`packages/client-runtime/src/state/shell.ts:76`) the caller drops the cursor and takes a
  snapshot.
- **If pruning ever lands**, add `earliestAvailableSequence` or a typed cursor-too-old error then.

**Page size.**

- **Chunked plain and E2EE.** A 1 MiB page is 16 records of 64 KiB.
  - At 64 KiB/s it takes 16 s.
  - At 16 KiB/s it takes 64 s, with a record every 4 s. The client's 30 s monitor stays quiet, and
    the message deadline (30 s + 1 MiB ÷ 16 KiB/s = 94 s) holds.
  - A cut-off loses one page, not 17 minutes.
- **Whole frames.** A page is one message, which needs 34.1 KiB/s to arrive within 30 s. Paged
  callers are new clients, which always offer `bibcode.rpc.chunked.v1`, so only third-party
  clients are affected.
- **Round trips.** One round trip per MiB, at the spike's 40 ms, adds 2.6 s to a 64-page,
  17-minute transfer.
- **Large single events.** A single event over the target goes alone. Known bounds:
  - a Codex activity: its 8 MiB stdout line (`provider/codex/protocol.rs:33`);
  - a turn-diff summary: the 8 MiB `numstat` cap (`production/orchestration_effects.rs:43, 1141-1174`),
    about 25 MB of JSON at 20-character paths (estimate; scratchpad
    `fo-design-replay/turn_diff_size.py`, not in the repo);
  - user text: 120,000 characters (`packages/contracts/src/orchestration.ts:153`).

  No event found reaches 64 MiB, though the Claude, Cursor and OpenCode transport caps were not
  checked. Nothing forbids it, either.

**Oversize error.**

- **Paged calls** get `RpcResponseTooLargeError` only for a single event over the connection limit.
  - It is a typed failure, not a cut-off: `isQueryTransportCutoff` matches only `RpcClientError`
    (`runtime.ts:536`). So it shows at once and is never re-issued automatically.
  - On the one automatic re-issue, it latches until Retry (`recordQueryOutcome`, `runtime.ts:614`).
  - The caller stops at that cursor and takes a snapshot.
- **Unpaged calls** get the same error from the ceiling before the tail is built, on every framing.
  So whole-frame sockets no longer carry unbounded frames.

**Cut-off re-issue rule.** The rule (`docs/architecture/connection-runtime.md:434-464`) is keyed by
environment and request input (`runtime.ts:706`). Each page's input carries its cursor, so each page
is its own key:

- a transport cut-off is re-issued once on the next session;
- a second cut-off at the same cursor latches until Retry;
- progress renews the budget, because the next page is a new key.

The unused coordinator already encodes this policy (`deriveReplayRetryDecision`,
`orchestrationRecovery.ts:39`). A caller that wants one budget per replay passes a
`transportCutoffKey` without the cursor (`runtime.ts:57`).

**Partial replay (rules for a future caller).**

1. Open the live subscription first and buffer it, as the server does before a snapshot
   (`orchestration_rpc.rs:802-803`). Then request pages from the cursor.
2. Apply pages in order, ignoring events at or below the cursor (as `shellReducer.ts:16` does), and
   advance the cursor to the last applied sequence. A page is a sequence-ordered prefix, so the
   state after it is the state at that sequence, and an overlapping re-issue is harmless.
3. Report synchronized only after `exhausted` and after applying buffered live events above the
   cursor.
4. After a cut-off, keep the applied prefix and resume under the rule above. After the latch,
   `RpcResponseTooLargeError`, `OrchestrationReplayEventsError` or a storage change, stop and take
   a snapshot, which stays the authority.
5. Treat an array (an old server that ignored `paged`) as one exhausted page.

## Affected packages and files

- **`apps/server`:**
  - `src/production/orchestration_rpc.rs`: `ReplayInput.paged`, the builder, the handler and unit
    tests;
  - `src/rpc/session.rs`: make the length helper and `response_too_large_failure` `pub(crate)`;
  - `tests/production_orchestration_rpc.rs`: the replay block at `:1648-1731`.
- **`packages/contracts`:**
  - `src/orchestration.ts:1511-1534`: the input field, the page schema and the union;
  - `src/rpc.ts:1494-1498`, if the success reference changes.

  Run `vp run check:contracts`. The exporter covers error schemas only (liveness ruling 5), so the
  fixtures should not change.
- **`packages/client-runtime` and `apps/web`:** nothing until a consumer exists.
- **Liveness files:** edit them only after the liveness change is committed.

## Test and live-validation plan

- **Rust unit tests** (`orchestration_rpc.rs`):
  - Task 14's three cases (many large gives N, one huge gives 1, many small gives all);
  - escaping is counted;
  - `exhausted` is set exactly at the tail, including a page that ends on a 128-row boundary;
  - the concatenated pages equal `read_events(0)`;
  - an unpaged call over a lowered ceiling fails with `RpcResponseTooLargeError` without reading
    past it.
- **RPC integration test.** Seed about 3,000 deltas (about 2 MiB) as
  `assistant_completion_replay_preserves_the_declared_message_payload_shape` (`:707`) does, then
  iterate with `paged: true`. Check that:
  - each page is at most 1 MiB, unless it is a single event;
  - the cursor strictly advances;
  - `exhausted` is set only on the last page;
  - the content equals the unpaged replay;
  - an input without `paged` still decodes;
  - a negative cursor still clamps.
- **Contracts:** a vitest decoding both union branches; `vp run check:contracts`.
- **Gates:** `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`,
  `vp check`, `vp run typecheck`, the lib tests and `production_orchestration_rpc`.
- **Live checks.** No UI calls replay, so Playwright, `UI.md` and `vercel-react-best-practices` do
  not apply. On an isolated dev server seeded with about 100 MB of events:
  1. Measure server RSS during an unpaged `replayEvents(0)` before and after the change. Before,
     it holds about three copies of the tail; after, the call fails fast with under 64 MiB held.
  2. Run a paged replay through `scripts/throttle-proxy.ts` at 64 KiB/s. Expect about 16 s per
     page and no 4408 close, and a freeze in the middle of a page resumes from the cursor after
     the reconnect.

## Docs and runbooks to update

- **`docs/architecture/rpc-and-orchestration.md`:** the oversize paragraph (`:87-92`) gains the
  replay ceiling, and `:1497-1499` describes snapshot-first resync and the page contract.
- **`docs/architecture/connection-runtime.md`:** only when a consumer lands.
- **`docs/testing/`:** reviewed; no change, because no UI flow or test command changes.
- **`docs/reference/scripts.md`:** only if the live script moves into `scripts/`.

## Risks

- **Whole-frame callers** with a tail over 64 MiB now get an error instead of one giant frame that
  usually failed anyway. E2EE and chunked callers already get it.
- **Misleading size.** The unpaged error's `bytes` is a lower bound, so the message can read
  "64.0 MiB; limit 64 MiB".
- **Old servers.** A new client on an old server still pays the unbounded response. Add B's
  capability later if a consumer must avoid that.
- **Concurrent unpaged calls.** 64 of them can hold 64 MiB each, 4 GiB for one connection
  (question 3).
- **Wide turn diffs.** A page holding one wide turn diff can be tens of MB.

## Related findings (not in scope)

- **Effects lag recovery.** The effects producer recovers from broadcast lag with
  `engine.read_events(last_sequence)`, and `last_sequence` starts at 0
  (`orchestration_effects.rs:458, 471-481`). So a lag before its first event reads the whole log
  into memory. Whether re-processing old reactor events is idempotent was not checked.
- **Negative cursors.** The contract types `fromSequenceExclusive` as non-negative, but the server
  clamps negative values (`orchestration_rpc.rs:175`), and a test sends −100
  (`production_orchestration_rpc.rs:1648-1653`).

## Open questions for the user

1. Does anything outside this repository call `replayEvents`? If nothing does, would you rather
   have a clean breaking shape (always the envelope), or remove the method (C)?
2. Should pages be 1 MiB (the History value, which needs 34 KiB/s on whole-frame sockets), or
   smaller?
3. Should the unpaged ceiling be 64 MiB (the transport limit) or lower? And should unpaged replays
   run one at a time?
4. Should the unused `orchestrationRecovery.ts` stay as the model for a future consumer, or be
   deleted?
5. Should B's capability be added now, or with the first consumer?
