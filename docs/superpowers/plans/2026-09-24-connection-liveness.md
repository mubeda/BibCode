# Connection Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A slow link is not a dead link. The client treats any inbound data as proof of life, the server splits large plain `/ws` messages into records with a control lane and progress-measured write deadlines, the server reaps silent clients, and the remaining damage paths (oversized responses, retry storms, config re-downloads, oversized pages, tight re-request loops, unhelpful copy) are fixed.

**Architecture:** Four phases in the spec's landing order.

- **Phase A (item 1).** Client-only. A local copy of Effect's `makeProtocolSocket` replaces the Pong-only pinger with a monitor fed by every raw WebSocket message. It closes with 4408 after 30 s of silence.
- **Phase B (items 2–4).** A new server transport writer, shared by plain and E2EE sessions, writes whole frames or records.
  - Records are negotiated by the `bibcode.rpc.chunked.v1` subprotocol on plain sockets and are always used on E2EE.
  - A bounded control lane overtakes queued data, as stand-alone `0x02` records when negotiated.
  - Each write has a deadline that measures progress.
  - The client reassembles plain records in a socket wrapper beneath the RPC protocol.
- **Phase C (item 5).** A server heartbeat pings every 15 s and reaps a connection after 45 s with no inbound frame and no data progress.
- **Phase D (items 6–9).**
  - An oversized response fails only its own request, with a typed error.
  - Retries get ±15 % jitter, plus an idle ladder for unselected environments.
  - The config arrives once per connection.
  - Pages have byte caps.
  - A cut-off query is re-issued once, then waits for Retry.
  - Disconnect copy says what happened.

**Tech Stack:** Rust (Axum 0.8.9 WebSocket, Tokio 1.53, tokio-tungstenite 0.30 in tests, snow 0.10), TypeScript (Effect 4.0.0-beta.107 RPC/Socket, `@effect/vitest`, Vite+ 0.3.0), React 19 (copy only), Playwright (live checks, from the spike's `node_modules` link).

**Spec:** [`docs/superpowers/specs/2026-09-24-connection-liveness-design.md`](../specs/2026-09-24-connection-liveness-design.md). The user approved it on 2026-09-24 with the recommended option on every ruling. Read the spec before each phase; this plan argues from it.

## Global Constraints

Copied verbatim from the spec (every task's requirements include these):

- Landing order: "First item 1 with item 9's close code: client-only, it works with every server and removes the E2EE drops and every plain drop under 30 s. Then items 2, 3 and 4 together, since they rewrite the same writer loops (`session.rs:690-712`, `e2ee.rs:1244-1266`); item 4's "end the session when the writer gives up" can land earlier as a small fix. Then item 5, which needs item 2. Items 6, 7, 8 and the copy follow in any order."
- Item 1: "Any raw WebSocket message is proof of life … so an E2EE record counts before reassembly. After 10 s with no inbound data the client sends the existing RPC `Ping`; after 30 s (three intervals, each ±10 % jitter) it closes with code 4408, reason `liveness timeout`. The supervisor stays the only retry owner."
- Item 1: "a copy of `makeProtocolSocket` that uses only public exports: `RpcClient.Protocol.make`, `RpcSerialization`, `ConnectionHooks` and `constPing`." (Ruling below: the copy owns its own hooks type instead of `ConnectionHooks`.)
- Item 2: "On a negotiated connection, the server sends each RPC message over 64 KiB as binary frames, one record per frame, in the E2EE record format: `0x00` for the final record and `0x01` for a continuation. The existing limits apply: 64 MiB and 2,048 records … Smaller messages stay whole text frames, and requests are not split."
- Item 2: "The client offers the WebSocket subprotocol `bibcode.rpc.chunked.v1` … No echo means today's framing."
- Item 3: "A small bounded lane beside the data queue carries Pong, interrupt exits, admission-failure terminals and protocol errors. The writer drains it before each message and between records. A control message sent between records goes out as a stand-alone record with a new flag, `0x02`, which the assembler returns without touching the partial message."
- Item 3: "Pong is sent with `try_send`, with no byte budget and no admission deadline, and a full lane drops the Pong instead of ending the read loop. For E2EE the client lists `"features":["interleave-v1"]` in `e2ee_auth` and the server confirms it in `e2ee_authenticated` … without it, control messages jump the queue only between whole messages. **Terminal output stays out of the lane.**"
- Item 4: "For plain and E2EE alike, each record (or each socket write of a legacy whole frame) must be accepted within 20 s, measured by a counting writer, and each message gets 30 s + size ÷ 16 KiB/s overall (about 9 minutes for 8 MiB), replacing E2EE's 64 KiB/s floor. When the writer gives up it ends the session, so the socket closes at once."
- Item 5: "Each pump sends a WebSocket Ping every 15 s to authenticated sockets: plain after the upgrade, E2EE after `e2ee_authenticated` (pre-auth keeps its 10 s deadline). An interval is alive if any frame arrived or the writer made progress. After three dead intervals (about 45 s) the session ends … Late ticks are not charged."
- Item 6: "A response that cannot fit the 64 MiB per-connection budget fails that request alone; `acquire_budget` stops cancelling the session. The limit also covers split plain sessions … Rename `response_larger_than_the_connection_budget_fails_the_session_closed` and update `remote.md:309-311`."
- Item 7: "Add ±15 % jitter to every retry delay. After 5 minutes of continuous failure, an environment that is not selected moves to 60, 120, then 300 s. Connect, retry, network-change and wakeup signals still end the wait at once, and blocked states are unchanged."
- Item 8: "Readiness should use the snapshot. The `application-active` probe … should use a small call instead." History pages target 1 MiB; "`review.getDiffPreview` gets a bound like `gitManager.getDiff`'s". "A request cut off by a transport failure is re-issued once on the next session. A second failure shows an error with Retry."
- Item 9: "The liveness close uses code 4408 … The client logs `liveness-timeout` with the time since the last inbound message, and the server logs 4408 separately."
- Ruling 7: "a typed `RpcResponseTooLargeError { method, bytes, limitBytes }` in the contracts".
- Copy (exact strings):
  - Liveness timeout: "No data from Local for 30 seconds. The connection is too slow or was lost. Reconnecting…"
  - Server closed: "Local closed the connection. Reconnecting…"
  - Git Manager while reconnecting: "Reconnecting to Local. History loads when the connection is back."
  - Clone cut-off copy is excluded by controller ruling R10; the clone-reconnect plan owns its next change.
  - Oversized response: "This result is too large to send (<size>; limit 64 MiB)."
- Compatibility: "Remote servers update on their own schedule, so every feature is negotiated with today's behavior as the fallback, and servers keep answering RPC `Ping`."

Repository requirements (AGENTS.md, briefs):

- Focused tests for every changed behavior, written first where a seam exists (watch red, then green).
- Broader checks across package or runtime boundaries: `vp test` for the changed TS packages, the affected Rust test binaries, `vp run check:contracts` whenever RPC contracts or wire fixtures change.
- `vp check` and `vp run typecheck` must pass.
- Rust: `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`.
- `apps/web` React changes: review against `vercel-react-best-practices` (`/home/mauro/.agents/skills/vercel-react-best-practices/SKILL.md`, its `AGENTS.md` or `rules/`) **and** against `UI.md`; report both results, or mark a review "not run".
- Living docs and `docs/testing/` runbooks change in the same task as the behavior they describe; otherwise state they were "reviewed and remain accurate".
- `packages/contracts` stays schema-only (schemas, tagged errors, message getters; no services, layers, or middleware classes).
- **Playwright live verification for every UI change** (user rule), against an isolated dev server: `BIBCODE_PORT_OFFSET=<unique n>`, its own `BIBCODE_HOME`, pairing through the server's startup token (`bibcode pairing offer` cannot target a dev data root).
- Known host flakes (not your bug; classify with a focused re-run or a cheap base-vs-change comparison, never chase):
  - `provider_terminal_supervisor` tests fail about once per full run even at base;
  - a `managed_endpoint` lib test can hang under heavy load;
  - pipe-heavy fixture tests fail when `pipe-user-pages-soft` is exhausted.
- Hard rules: no commits, pushes, PRs, `git stash`, `git reset`, `git checkout -- …`, `git restore`, or `git clean`. Never kill a process you did not start. Never touch the user's `bibcode-desktop` (pid 392675, port 3773) or the controller's dev server (vite pid 407211, `bibcode` pid 407225). Never write to real remotes. Never print secrets (write `<REDACTED>`). Stop only what you started.

## Coordination with concurrent work

This plan is **track A**. It runs in the same worktree at the same time as **track B** (the left-panel plan), and batch-1 implementers may still hold uncommitted edits.

- **Never edit track B files:** `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/Sidebar.logic*.ts`, `apps/web/src/components/AppSidebarLayout*`, `apps/web/src/components/ui/sidebar.tsx`, anything under `apps/web/src/components/sidebar/` (including `EnvironmentRail.tsx`, `EnvironmentContextCard.tsx`, `environmentContextCard.logic.ts`), `packages/contracts/src/ipc.ts`, `apps/desktop/src-tauri/src/context_menu.rs`, `docs/user/workspace-ui.md`, `UI.md`.
  - The context card shows `connectionStatusText`, so the new disconnect copy reaches it through `packages/client-runtime/src/connection/presentation.ts` (Task 16) without touching the card.
- **Unavoidable overlaps. Make targeted `Edit`s to your own paragraphs only; never rewrite or reformat these files:**
  - `docs/testing/cross-platform-validation.md`, `docs/testing/execution-report-template.md`, `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md`: track B and the clone work also add rows and scenarios.
  - `docs/architecture/overview.md`, `docs/architecture/remote.md`, `docs/architecture/rpc-and-orchestration.md`: other agents hold uncommitted edits.
  - `apps/server/src/production/runtime.rs`: the PR-panel agent owns concurrent runtime wiring. This plan edits only `GitReviewBackend` and its review-diff helpers/tests (Task 14); re-read those symbols before editing.
  - `packages/client-runtime/src/state/runtime.ts`: the update-badge work added `EnvironmentQueryRefreshInterval`. This plan edits only `createEnvironmentQueryAtomFamily` (Task 15).
  - `apps/web/src/state/entities.ts`: Task 12 moves only the active-environment atom and its accessors to a leaf module; it keeps local imports for the remaining reconciliation function and re-exports for track B's importers.
  - `apps/web/src/components/settings/remote-servers/ConnectTab.tsx`: Task 15 changes only automatic update-query revalidation; preserve the rename work and explicit user actions.
  - The rename sections in the connection-runtime doc and native runbooks: Tasks 2/16 replace only the temporary disconnect-name exception described below.
- If a workspace-wide gate fails because of files outside this plan, record the output in the ledger and continue; do not edit those files.

## Spec conflicts and rulings

Resolve these exactly as written; they are part of the plan.

1. **Legacy whole-frame write deadline.** Item 4 asks for "each socket write of a legacy whole frame … within 20 s, measured by a counting writer".
   - Axum's `WebSocket` hides the upgraded IO, so no counting writer can observe progress inside one frame.
   - Records get the 20 s progress deadline. A legacy whole frame is one observable write, bounded by the message deadline (30 s + size ÷ 16 KiB/s, never less than 30 s).
   - This is looser than the spec's parenthetical for whole frames and far looser than today's flat 5 s.
   - **Approved by the user on 2026-09-25 (R1).** Legacy whole frames get only the per-message deadline; records keep the 20 s progress deadline. Task 5 may proceed.
2. **Hooks type.** The protocol copy defines its own `onConnect`/`onDisconnect(disconnect)` options instead of `RpcClient.ConnectionHooks`, because the copy needs the close code for item 9. `ConnectionHooks` is no longer used by the session.
3. **Disconnect classes.** Close code 4408 (our own) maps to `liveness-timeout`. Any other close frame from the peer maps to `connection-closed`. 1006 or a socket error maps to `connection-lost`.
   - The spec gives copy only for the first two. `connection-lost` gets "The connection to Local was lost. Reconnecting…", which follows the spec's pattern and UI.md.
4. **Reaper timing.** "After three dead intervals (about 45 s)" plus the validation line "a reader that stops is reaped within 50 s" cannot both hold with 15 s-aligned checks (worst case 60 s).
   - The reaper keeps the last-activity time and checks every 5 s.
   - It reaps when 45 s pass with no inbound frame and no data-write progress, so detection is ≤ 50 s.
   - Pings still go out every 15 s. No control write (WebSocket Ping/Pong, RPC Pong, interrupt, admission terminal, or protocol error) is data progress: none resets either the 20 s data-progress deadline or the heartbeat activity clock.
   - A check that fires more than 10 s late resets the silence origin (late ticks are not charged).
5. **Typed oversize error placement.** Contracts export only the `RpcResponseTooLargeError` schema.
   - Client-runtime defines an `RpcMiddleware.Service` whose `error` is that schema and applies it with `WsRpcGroup.middleware(...)` in `rpc/protocol.ts`, so every method's exit schema decodes it without editing each method or `packages/contracts/src/rpc.ts`.
   - The fixture exporter iterates only `rpc.errorSchema`, so a static wire fixture plus a Rust parity test pin the shape.
6. **Silence bounds (harness).** Three independent checks in `rpc_liveness.rs`; all assertions run while the proxy remains frozen:
   - During a transfer, the server ends the frozen reader's session within 33 s of freeze start; observe server-side subscription cancellation, not a close delivered after thaw.
   - An idle frozen client is reaped within 50 s of freeze start, with at most 1 s scheduling tolerance. E2EE also releases permits, removes the live-connection row, and closes subscriptions.
   - The item-1 client detects a frozen server within 33 s (30 s + 10 % jitter). Only text/binary WebSocket messages reset its activity clock; WebSocket Ping/Pong never do.
7. **Selection for the idle ladder.** It uses a new `EnvironmentSelection` `Context.Reference` (default: nothing selected, so no environment enters the ladder), not `ConnectionWakeups`. The web provides it from the active-environment atom.
8. **Config once.** The session opens the one `subscribeServerConfig` stream and serves it to later subscribers through its wrapped client, replaying one synthesized snapshot and then live events.
   - This leaves `RpcSession`'s interface unchanged and removes the second 248 KB payload.
   - The keybinding toast still sees real `keybindingsUpdated` events.
9. **Live repro after the History cap.** Once Task 14 caps History pages at about 1 MiB, the 8.6 MB History repro no longer produces a large payload. Runbooks and the final live checks use a ~4 MB commit diff (`gitManager.getDiff`, under the 4.375 MB `MAX_REASONABLE_DIFF_SIZE`).
10. **Codex implementation and review.** Codex is available and implements the tasks. F4 runs the Codex review; record any actual tool failure without relying on the obsolete out-of-credits note.
11. **Replay byte cap follow-up.** `orchestration.replayEvents` byte capping is outside this plan. Spec ruling 8 names only History and review previews; record replay pagination/budgeting as a follow-up.
12. **Upstream protocol issue.** F5 outputs a draft issue for the user to file about the local Effect protocol copy. It is drafted, not filed; never write to GitHub.
13. **Approval ledger.** Plan-authored deviations remain **pending user approval** unless the controller's ledger records the user's approval. The controller rulings below direct this plan repair; they do not retroactively approve R1 or any other architectural deviation.

## Controller rulings (2026-09-24)

- R1: Gate Task 5 on the user's legacy-deadline decision; keep Phase A independent — the whole-frame fallback deviates from the spec — cost if wrong: legacy stalls are accepted without approval.
- R2: Snapshot each control drain, preserve data and message deadlines, and route oversized controls through data — continuously refilled controls must not starve data — cost if wrong: stuck data, permits and sessions.
- R3: Introduce items at first use and read/remove harness duration fields — every task must pass warnings-denied gates — cost if wrong: intermediate builds fail.
- R4: Require successful exact-payload Exits and assert all freeze bounds before thaw, including E2EE cleanup — eventual closure is insufficient evidence — cost if wrong: false passes and leaked resources.
- R5: Write record-aware browser observers and drivers under `$S/liveness-live/`; the controller runs them on the host — Codex cannot bind loopback sockets — cost if wrong: invisible Exits or unusable live evidence.
- R6: Void every `runRaw` onOpen, update exact auth JSON, and check limits before control delivery — callback types and caps apply to negotiated records — cost if wrong: type failures or cap bypass.
- R7: Update fixture count and explicit error unions; check untracked fixtures and require contract gate exit 0 — exporter and index behavior are part of the gate — cost if wrong: regeneration silently fails.
- R8: Count serialized History bytes and bound git capture before trimming to a file boundary — escaping and capture memory determine actual size — cost if wrong: oversized wire pages and unbounded memory.
- R9: Persist an exhausted cutoff latch through every automatic trigger until explicit Retry — one re-issue is the entire automatic budget — cost if wrong: request storms on refresh/remount.
- R10: Drop only the clone-disconnect copy and its F2 check — clone re-attach is next and removal cannot be confirmed over a lost connection — cost if wrong: a false cleanup promise.
- R11: Record replay byte capping as follow-up and output an upstream issue draft only — scope follows spec ruling 8 and issue filing belongs to the user — cost if wrong: scope creep or an unauthorized publication.
- R12: Add sibling module, config termination, mid-probe disconnect, and proxy CLI/control tests — new lifecycle seams need behavioral coverage — cost if wrong: untested failures and broken manual tooling.
- R13: Make runbook and report agree on 50 s idle and 33 s transfer bounds from freeze start — accepted writes cannot move the evidence origin — cost if wrong: an indefinite wait passes validation.
- R14: Report deviations as pending absent ledger approval; Codex implements and reviews — plan authorship is not user approval — cost if wrong: unauthorized behavior is presented as approved.
- R15: Refresh Task 2's model anchor and verify changed anchors against the tree — concurrent work moves code — cost if wrong: edits target the wrong source.
- V1: Preserve the 64 KiB/s inbound E2EE assembly floor and its shared-fixture parity assertion in Task 5; the new outbound writer does not retire inbound limits.
- V2: Include heartbeat Pings in each finite control snapshot, then write ready data before servicing more controls; control-class payloads never renew progress even when they require data framing. Exercise heartbeat, continuous refill, queued data, and a stalled sink together.
- V3: The authenticated E2EE cleanup regression uses a registered method with an authorization scope and bounds every asynchronous wait, including handler startup and teardown.
- V4: Every Task 12 supervisor construction supplies the registry-owned `targetRef`; `entities.ts` imports the selection helpers it still calls locally as well as re-exporting them.
- V5: Migrate the existing shared admission-deadline test to `Err(SendFailure::Rejected)` when Task 11 changes the send result type.
- V6: Every automatic query trigger, including status-bar intervals and ChatView snapshot-revision timers, uses latch-preserving revalidation. Only explicit user Retry resets exhaustion; regressions exercise those real consumers.
- V7: Name the isolated E2EE pairing offer `spike-remote`, matching the setup scripts and browser driver.
- V8: Add `useEnvironment` to all three Git Manager environment mocks, including lifecycle and telemetry coverage.
- V9: All Phase A transfer trials use bufferbloat mode with the unchanged server; its five-second write timeout remains in force. Backpressure guarantees begin in Phase B after R1 approval.
- V10: Re-verify edited anchors against current source, including `ConnectionTransientReason` at `model.ts:105`; use named symbols for concurrent PR/source-control changes and preserve `followStream` idle-and-rebind behavior.
- V11: Disconnect details use the current saved catalog label from the supervisor's target Ref, never `PreparedConnection.label`. Rename-then-disconnect tests cover Phase A and the final liveness/closed/lost copy.


## File structure

**Create**

| File | Responsibility |
| --- | --- |
| `packages/client-runtime/src/rpc/liveness.ts` | Inbound-activity clock and the liveness monitor (10 s probe, 30 s ±10 % death, 4408 constants). |
| `packages/client-runtime/src/rpc/livenessProtocol.ts` | Local copy of Effect's socket protocol: liveness, disconnect classification, no protocol retries, Ping probe. |
| `packages/client-runtime/src/rpc/chunkedSocket.ts` | Socket wrapper that reassembles negotiated plain `/ws` records (`0x00/0x01/0x02`). |
| `packages/client-runtime/src/rpc/transportErrors.ts` | `RpcTransportErrors` middleware that adds `RpcResponseTooLargeError` to every method's exit schema. |
| `packages/client-runtime/src/rpc/sharedServerConfig.ts` | One `subscribeServerConfig` stream per session, replayed to later subscribers. |
| `packages/client-runtime/src/connection/selection.ts` | `EnvironmentSelection` reference (the environment in view). |
| `packages/contracts/src/rpcTransport.ts` | `RpcResponseTooLargeError` schema with the oversize copy. |
| `apps/server/src/rpc/transport.rs` | Outbound transport writer: framing, control lane, deadlines, and (Phase C) heartbeat and reaper. |
| `apps/server/tests/rpc_liveness.rs` | In-process throttling-proxy regression harness. |
| `apps/web/src/state/activeEnvironment.ts` | Leaf module for the active-environment atom (breaks an import cycle). |
| `scripts/throttle-proxy.ts` | Node port of the spike's throttling TCP proxy for the manual runbook. |

Each new TypeScript module gets a sibling `*.test.ts`.

**Modify (main ones)**

| File | Tasks |
| --- | --- |
| `packages/client-runtime/src/rpc/session.ts` | 2, 7, 13, 16 |
| `packages/client-runtime/src/connection/model.ts` | 2 (reasons) |
| `packages/client-runtime/src/e2ee/frame.ts`, `packages/client-runtime/src/e2ee/socket.ts` | 7 |
| `packages/client-runtime/src/connection/supervisor.ts`, `packages/client-runtime/src/connection/registry.ts` (including rename/disconnect tests) | 2, 12, 16 |
| `packages/client-runtime/src/state/server.ts` | 13 |
| `packages/client-runtime/src/state/runtime.ts` | 15 |
| `packages/client-runtime/src/connection/presentation.ts`, `packages/client-runtime/src/errors/transport.ts` | 16 |
| `packages/client-runtime/src/rpc/protocol.ts` | 11 |
| `packages/contracts/src/remotePairing.ts` | 7 |
| `packages/contracts/src/index.ts` | 11 |
| `packages/contracts/scripts/export-rust-rpc-fixtures.ts` (+ regenerated fixtures) | 11 |
| `apps/server/src/rpc/session.rs` | 4, 5, 10, 11 |
| `apps/server/src/rpc/e2ee.rs` | 5, 6, 10 |
| `apps/server/src/rpc/mod.rs` | 5 |
| `apps/server/src/http.rs` | 6 |
| `apps/server/src/git/manager/graph.rs` | 14 |
| `apps/server/src/production/runtime.rs` | 14 (review backend only) |
| `apps/web/src/connection/platform.ts`, `apps/web/src/state/entities.ts` | 12 |
| `apps/web/src/components/status-bar/AppStatusBar.tsx`, `apps/web/src/components/ChatView.tsx`, and the automatic consumers enumerated in Task 15 | 15 |
| `apps/web/src/components/gitManager/gitManagerAvailability.ts`, `apps/web/src/components/gitManager/GitManagerPanel.tsx` | 16 |
| Docs: `docs/architecture/connection-runtime.md`, `rpc-and-orchestration.md`, `remote.md`, `overview.md` | per task |
| Runbooks: `docs/testing/*.md`, `docs/reference/scripts.md` | 17 |

## Working conventions

- Run every command from the repository root `/work/workspaces/orca/BibCode/main-3` unless a step says otherwise.
- Scratch root: `S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad`. Live-check root: `LIVE=$S/liveness-live`. Put logs, screenshots, profiles, and reports there, never in the repository.
- Focused TypeScript tests: `vp test run <file>`. Expected success tail: `Test Files  1 passed (1)`.
- Focused Rust tests:
  - unit: `cargo test -p bibcode-server --lib <module path>`;
  - integration: `cargo test -p bibcode-server --test <name>`.

  Expected success line: `test result: ok.`
- **Checkpoint (no commit)** closes every task. Record the printed tree hash in the execution ledger (`$S/p-liveness-ledger.md`, one line per task: task, tree hash, focused test results). Task review packages use `git diff <previous tree> <this tree>`.

  ```bash
  IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
  ```

- Before the first task: run `git status --short > $S/p-liveness-status-start.txt` and record the checkpoint tree of the untouched worktree as the base.

---

## Phase A — Item 1: client liveness (client-only)

### Task 1: Inbound-activity clock and liveness monitor

**Files:**
- Create: `packages/client-runtime/src/rpc/liveness.ts`
- Test: `packages/client-runtime/src/rpc/liveness.test.ts`

**Interfaces:**
- Consumes: Effect `Clock.Clock` and `Random.Random` references (tests pin both).
- Produces (used by Tasks 2, 13):
  - `export const LIVENESS_CLOSE_CODE = 4408`
  - `export const LIVENESS_CLOSE_REASON = "liveness timeout"`
  - `export interface LivenessTimings { intervalMs; deadAfterIntervals; jitter }`, `export const DEFAULT_LIVENESS_TIMINGS`
  - `export interface InboundActivity { record(): void; reset(): void; lastInboundAt(): number; sequence(): number }`
  - `export const makeInboundActivity: Effect.Effect<InboundActivity>`
  - `export const runLivenessMonitor: <E, R>(options: { activity: InboundActivity; sendPing: Effect.Effect<void, E, R>; timings?: LivenessTimings | undefined }) => Effect.Effect<number, never, R>`. It returns the silent time in milliseconds when the connection is dead.

- [ ] **Step 1: Write the failing test**

Create `packages/client-runtime/src/rpc/liveness.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";

import { makeInboundActivity, runLivenessMonitor } from "./liveness.ts";

const withRandom =
  (value: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Random.Random, {
        nextDoubleUnsafe: () => value,
        nextIntUnsafe: () => 0,
      }),
    );

describe("runLivenessMonitor", () => {
  it.effect("pings after each silent interval and gives up after three", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      let pings = 0;
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({
          activity,
          sendPing: Effect.sync(() => {
            pings += 1;
          }),
        }),
      );
      yield* TestClock.adjust("9999 millis");
      expect(pings).toBe(0);
      yield* TestClock.adjust("1 millis");
      expect(pings).toBe(1);
      yield* TestClock.adjust("10 seconds");
      expect(pings).toBe(2);
      expect(monitor.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(monitor)).toBe(30_000);
      expect(pings).toBe(2);
    }).pipe(withRandom(0.5)),
  );

  it.effect("restarts the silent period at the latest inbound message", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      let pings = 0;
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({
          activity,
          sendPing: Effect.sync(() => {
            pings += 1;
          }),
        }),
      );
      yield* TestClock.adjust("5 seconds");
      activity.record();
      yield* TestClock.adjust("9 seconds");
      expect(pings).toBe(0);
      yield* TestClock.adjust("1 second");
      expect(pings).toBe(1);
      yield* TestClock.adjust("20 seconds");
      expect(yield* Fiber.join(monitor)).toBe(30_000);
    }).pipe(withRandom(0.5)),
  );

  it.effect("declares death no earlier than 27 seconds of silence", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({ activity, sendPing: Effect.void }),
      );
      yield* TestClock.adjust("26999 millis");
      expect(monitor.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(monitor)).toBe(27_000);
    }).pipe(withRandom(0)),
  );

  it.effect("declares death no later than 33 seconds of silence", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({ activity, sendPing: Effect.void }),
      );
      yield* TestClock.adjust("32999 millis");
      expect(monitor.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(monitor)).toBe(33_000);
    }).pipe(withRandom(0.999_999)),
  );

  it.effect("counts silence from reset when the socket opens", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      yield* TestClock.adjust("7 seconds");
      activity.reset();
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({ activity, sendPing: Effect.void }),
      );
      yield* TestClock.adjust("29 seconds");
      expect(monitor.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(monitor)).toBe(30_000);
    }).pipe(withRandom(0.5)),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run packages/client-runtime/src/rpc/liveness.test.ts`
Expected: FAIL. The import of `./liveness.ts` fails to resolve.

- [ ] **Step 3: Write the implementation**

Create `packages/client-runtime/src/rpc/liveness.ts`:

```ts
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/** Close code the client sends when it gives up on a silent connection. */
export const LIVENESS_CLOSE_CODE = 4408;
/** Close reason sent with {@link LIVENESS_CLOSE_CODE}. */
export const LIVENESS_CLOSE_REASON = "liveness timeout";

export interface LivenessTimings {
  /** Silence before the client sends an RPC Ping; also the length of each interval. */
  readonly intervalMs: number;
  /** Silent intervals after which the connection is dead. */
  readonly deadAfterIntervals: number;
  /** Relative jitter for every interval: 0.1 means ±10 %. */
  readonly jitter: number;
}

export const DEFAULT_LIVENESS_TIMINGS: LivenessTimings = {
  intervalMs: 10_000,
  deadAfterIntervals: 3,
  jitter: 0.1,
};

/**
 * Proof of life for one WebSocket. The session records every raw inbound
 * message here, including E2EE records before reassembly, so a large message
 * that is still arriving keeps the connection alive.
 */
export interface InboundActivity {
  /** Records one inbound message. A plain function so a DOM listener can call it. */
  readonly record: () => void;
  /** Treats now as the latest inbound message; the protocol calls it when the socket opens. */
  readonly reset: () => void;
  /** Effect-clock milliseconds of the latest `record` or `reset`. */
  readonly lastInboundAt: () => number;
  /** Increments on every `record`. */
  readonly sequence: () => number;
}

export const makeInboundActivity: Effect.Effect<InboundActivity> = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  let lastInboundAt = clock.currentTimeMillisUnsafe();
  let sequence = 0;
  return {
    record: () => {
      lastInboundAt = clock.currentTimeMillisUnsafe();
      sequence += 1;
    },
    reset: () => {
      lastInboundAt = clock.currentTimeMillisUnsafe();
    },
    lastInboundAt: () => lastInboundAt,
    sequence: () => sequence,
  };
});

/**
 * Waits until the socket has been silent for `deadAfterIntervals` jittered
 * intervals and returns how long it was silent. After each silent interval
 * before that it sends an RPC Ping, which every live server answers. Inbound
 * messages never wake this loop: it re-reads the activity clock only when its
 * current deadline passes, so a busy socket costs one timer per interval.
 */
export const runLivenessMonitor = <E, R>(options: {
  readonly activity: InboundActivity;
  readonly sendPing: Effect.Effect<void, E, R>;
  readonly timings?: LivenessTimings | undefined;
}): Effect.Effect<number, never, R> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const random = yield* Random.Random;
    const timings = options.timings ?? DEFAULT_LIVENESS_TIMINGS;
    const nextInterval = (): number =>
      timings.intervalMs * (1 + (random.nextDoubleUnsafe() * 2 - 1) * timings.jitter);
    let observedSequence = options.activity.sequence();
    let silentSince = options.activity.lastInboundAt();
    let silentIntervals = 0;
    let deadline = silentSince + nextInterval();
    for (;;) {
      const now = clock.currentTimeMillisUnsafe();
      if (now < deadline) {
        yield* Effect.sleep(Math.ceil(deadline - now));
        continue;
      }
      const sequence = options.activity.sequence();
      if (sequence !== observedSequence) {
        observedSequence = sequence;
        silentSince = options.activity.lastInboundAt();
        silentIntervals = 0;
        deadline = silentSince + nextInterval();
        continue;
      }
      silentIntervals += 1;
      if (silentIntervals >= timings.deadAfterIntervals) return now - silentSince;
      yield* options.sendPing.pipe(Effect.ignore);
      deadline += nextInterval();
    }
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run packages/client-runtime/src/rpc/liveness.test.ts`
Expected: PASS. `Tests  5 passed (5)`.

- [ ] **Step 5: Checkpoint (no commit)**

Run the checkpoint command from "Working conventions"; record `Task 1 <tree> liveness.test.ts 5/5` in the ledger.

---

### Task 2: Local RPC protocol with the liveness monitor, wired into the session

**Files:**
- Create: `packages/client-runtime/src/rpc/livenessProtocol.ts`
- Test: `packages/client-runtime/src/rpc/livenessProtocol.test.ts`
- Modify: `packages/client-runtime/src/rpc/session.ts` (whole file replaced below)
- Modify: `packages/client-runtime/src/connection/model.ts:105` (`ConnectionTransientReason`; declaration re-verified against the current tree)
- Test: `packages/client-runtime/src/rpc/session.test.ts` (new tests, one updated expectation)
- Modify: `packages/client-runtime/src/connection/supervisor.ts` (`failureFromExit`, current-label disconnect details)
- Test: `packages/client-runtime/src/connection/registry.test.ts` (rename then disconnect through the existing target Ref)
- Docs: `docs/architecture/connection-runtime.md` ("State and retry policy")

**Interfaces:**
- Consumes (Task 1): `makeInboundActivity`, `runLivenessMonitor`, `LIVENESS_CLOSE_CODE`, `LIVENESS_CLOSE_REASON`, `LivenessTimings`, `InboundActivity`.
- Produces:
  - `export type RpcDisconnect = { _tag: "LivenessTimeout"; idleMs: number } | { _tag: "Closed"; code: number } | { _tag: "Lost" }`
  - `export function classifyDisconnect(cause: Cause.Cause<Socket.SocketError>, livenessIdleMs: number | null): RpcDisconnect`
  - `export interface LivenessProtocolOptions { activity; onConnect; onDisconnect(disconnect: RpcDisconnect); timings? }`
  - `export const makeLivenessProtocol(options): Effect.Effect<RpcClient.Protocol["Service"], never, Scope | RpcSerialization | Socket.Socket>`
  - `ConnectionTransientReason` gains `"liveness-timeout" | "connection-closed" | "connection-lost"`.
  - `session.ts` gains the private, label-neutral helper `disconnectError(wasConnected, disconnect)`. `supervisor.ts` formats those typed reasons with `currentTarget()` when publishing a failure; Task 16 changes that supervisor helper's detail strings. The target Ref is the saved-name source of truth, and neither a prepared descriptor nor a session caches that name.

- [ ] **Step 1: Write the failing protocol unit test**

Create `packages/client-runtime/src/rpc/livenessProtocol.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Socket from "effect/unstable/socket/Socket";

import { classifyDisconnect } from "./livenessProtocol.ts";

const closed = (code: number) =>
  Cause.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) }));

describe("classifyDisconnect", () => {
  it("reports our own liveness close with the silent time", () => {
    expect(classifyDisconnect(closed(4408), 30_000)).toEqual({
      _tag: "LivenessTimeout",
      idleMs: 30_000,
    });
  });

  it("reports a close frame from the server with its code", () => {
    expect(classifyDisconnect(closed(1000), null)).toEqual({ _tag: "Closed", code: 1000 });
    expect(classifyDisconnect(closed(1012), null)).toEqual({ _tag: "Closed", code: 1012 });
  });

  it("reports an abnormal closure or a socket error as a lost connection", () => {
    expect(classifyDisconnect(closed(1006), null)).toEqual({ _tag: "Lost" });
    expect(
      classifyDisconnect(
        Cause.fail(
          new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: "reset" }) }),
        ),
        null,
      ),
    ).toEqual({ _tag: "Lost" });
    expect(classifyDisconnect(Cause.interrupt(), null)).toEqual({ _tag: "Lost" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `vp test run packages/client-runtime/src/rpc/livenessProtocol.test.ts`
Expected: FAIL. `./livenessProtocol.ts` does not exist.

- [ ] **Step 3: Write the protocol copy**

Create `packages/client-runtime/src/rpc/livenessProtocol.ts`:

```ts
/**
 * A local copy of Effect's `RpcClient.makeProtocolSocket`
 * (effect 4.0.0-beta.107, `src/unstable/rpc/RpcClient.ts:1027-1177`) with
 * three changes:
 *
 * - liveness counts every inbound WebSocket message instead of only `Pong`
 *   (see `liveness.ts`);
 * - the liveness close uses code 4408 and the disconnect hook receives its
 *   cause;
 * - the protocol never reconnects, because the connection supervisor owns
 *   retries.
 *
 * It uses only public Effect exports. Re-check it against upstream on every
 * Effect upgrade, and delete it once upstream exposes a configurable pinger
 * (connection-liveness design, item 1).
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { constVoid } from "effect/Function";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { constPing, type FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import {
  type InboundActivity,
  LIVENESS_CLOSE_CODE,
  LIVENESS_CLOSE_REASON,
  type LivenessTimings,
  runLivenessMonitor,
} from "./liveness.ts";

/** Why a connected RPC socket ended. */
export type RpcDisconnect =
  | { readonly _tag: "LivenessTimeout"; readonly idleMs: number }
  | { readonly _tag: "Closed"; readonly code: number }
  | { readonly _tag: "Lost" };

/** Browsers report 1006 when the TCP connection ends without a close frame. */
const ABNORMAL_CLOSURE = 1006;

export function classifyDisconnect(
  cause: Cause.Cause<Socket.SocketError>,
  livenessIdleMs: number | null,
): RpcDisconnect {
  if (livenessIdleMs !== null) return { _tag: "LivenessTimeout", idleMs: livenessIdleMs };
  const error = Cause.findError(cause);
  if (
    Result.isSuccess(error) &&
    error.success.reason._tag === "SocketCloseError" &&
    error.success.reason.code !== ABNORMAL_CLOSURE
  ) {
    return { _tag: "Closed", code: error.success.reason.code };
  }
  return { _tag: "Lost" };
}

export interface LivenessProtocolOptions {
  readonly activity: InboundActivity;
  /** Runs when the socket opens; for E2EE, after in-channel authentication. */
  readonly onConnect: Effect.Effect<void>;
  /** Runs once when the socket ends. */
  readonly onDisconnect: (disconnect: RpcDisconnect) => Effect.Effect<void>;
  readonly timings?: LivenessTimings | undefined;
}

const toRpcClientError = (cause: Cause.Cause<Socket.SocketError>): RpcClientError => {
  const error = Cause.findError(cause);
  return new RpcClientError({
    reason: Result.isSuccess(error)
      ? error.success.reason
      : new RpcClientDefect({ message: "Unknown socket error", cause: Cause.squash(cause) }),
  });
};

export const makeLivenessProtocol = (
  options: LivenessProtocolOptions,
): Effect.Effect<
  RpcClient.Protocol["Service"],
  never,
  Scope.Scope | RpcSerialization.RpcSerialization | Socket.Socket
> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const socket = yield* Socket.Socket;
      const serialization = yield* RpcSerialization.RpcSerialization;
      const requestClientMap = new Map<string | number, number>();
      const write = yield* socket.writer;
      const opened = yield* Deferred.make<void>();
      let parser = serialization.makeUnsafe();
      let currentError: RpcClientError | undefined;
      let livenessIdleMs: number | null = null;

      const broadcast = (response: FromServerEncoded) =>
        Effect.forEach(clientIds, (clientId) => writeResponse(clientId, response));
      const broadcastError = (error: RpcClientError) => {
        currentError = error;
        return broadcast({ _tag: "ClientProtocolError", error });
      };

      const onOpen = Effect.suspend(() => {
        currentError = undefined;
        options.activity.reset();
        Deferred.doneUnsafe(opened, Effect.void);
        return options.onConnect;
      });

      const handleMessage = (message: string | Uint8Array) => {
        try {
          const responses = parser.decode(message) as Array<FromServerEncoded>;
          if (responses.length === 0) return;
          let index = 0;
          return Effect.whileLoop({
            while: () => index < responses.length,
            body: () => {
              const response = responses[index++]!;
              // A Pong only proves liveness, which the raw message already recorded.
              if (response._tag === "Pong") return Effect.void;
              if (Object.hasOwn(response, "requestId")) {
                const requestId = (
                  response as FromServerEncoded & { readonly requestId: string | number }
                ).requestId;
                const clientId = requestClientMap.get(requestId);
                if (clientId !== undefined) {
                  if (response._tag === "Exit") requestClientMap.delete(requestId);
                  return writeResponse(clientId, response);
                }
              }
              return broadcast(response);
            },
            step: constVoid,
          });
        } catch (defect) {
          return broadcast({
            _tag: "ClientProtocolError",
            error: new RpcClientError({
              reason: new RpcClientDefect({ message: "Error decoding message", cause: defect }),
            }),
          });
        }
      };

      const sendPing = Effect.suspend(() => {
        const encoded = parser.encode(constPing);
        return encoded === undefined ? Effect.void : write(encoded);
      });

      const livenessTimeout = Deferred.await(opened).pipe(
        Effect.andThen(
          runLivenessMonitor({ activity: options.activity, sendPing, timings: options.timings }),
        ),
        Effect.flatMap((idleMs) => {
          livenessIdleMs = idleMs;
          return Effect.logWarning("liveness-timeout").pipe(
            Effect.annotateLogs({ "rpc.liveness.idle_ms": idleMs }),
            // The close code must leave before the scope's release closes with 1000.
            Effect.andThen(
              write(new Socket.CloseEvent(LIVENESS_CLOSE_CODE, LIVENESS_CLOSE_REASON)).pipe(
                Effect.ignore,
              ),
            ),
            Effect.andThen(
              Effect.fail(
                new Socket.SocketError({
                  reason: new Socket.SocketCloseError({
                    code: LIVENESS_CLOSE_CODE,
                    closeReason: LIVENESS_CLOSE_REASON,
                  }),
                }),
              ),
            ),
          );
        }),
      );

      yield* Effect.suspend(() => {
        parser = serialization.makeUnsafe();
        return socket.runRaw(handleMessage, { onOpen }).pipe(Effect.raceFirst(livenessTimeout));
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) })),
        ),
        // Fail sends first: once `onDisconnect` wakes the session's waiters, a
        // write must fail at once instead of waiting on the closed socket.
        Effect.tapCause((cause) => broadcastError(toRpcClientError(cause))),
        Effect.onExit((exit) =>
          options.onDisconnect(
            Exit.isFailure(exit) ? classifyDisconnect(exit.cause, livenessIdleMs) : { _tag: "Lost" },
          ),
        ),
        Effect.ignore,
        Effect.annotateLogs({ module: "RpcClient", method: "makeLivenessProtocol" }),
        Effect.forkScoped,
      );

      return {
        send(clientId, request) {
          if (currentError) return Effect.fail(currentError);
          if (request._tag === "Request") requestClientMap.set(request.id, clientId);
          const encoded = parser.encode(request);
          if (encoded === undefined) return Effect.void;
          return Effect.orDie(write(encoded));
        },
        supportsAck: true,
        supportsTransferables: false,
      };
    }),
  );
```

- [ ] **Step 4: Run the protocol unit test**

Run: `vp test run packages/client-runtime/src/rpc/livenessProtocol.test.ts`
Expected: PASS. `Tests  3 passed (3)`.

- [ ] **Step 5: Add the transient reasons**

In `packages/client-runtime/src/connection/model.ts`, replace the `ConnectionTransientReason` literal list:

```ts
export const ConnectionTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "relay-unavailable",
  "remote-unavailable",
  "liveness-timeout",
  "connection-closed",
  "connection-lost",
]);
```

- [ ] **Step 6: Write the failing session tests**

In `packages/client-runtime/src/rpc/session.test.ts`:

1. Add the import `import * as Random from "effect/Random";` after the `effect/Layer` import.

2. In `class TestWebSocket`, add two fields after `readonly url: string;`:

```ts
  closeCode: number | null = null;
  closeReason: string | null = null;
```

   Replace `close(...)` with:

```ts
  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }
```

3. After `const encodeServerConfig = Schema.encodeSync(ServerConfig);` add:

```ts
const PING_FRAME = JSON.stringify({ _tag: "Ping" });
const FIXED_RANDOM = { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 0 };
const withFixedRandom = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Random.Random, FIXED_RANDOM));
const pingsSent = (socket: TestWebSocket) =>
  socket.sent.filter((frame) => frame === PING_FRAME).length;
```

4. In the test "owns one scoped websocket attempt and exposes readiness and closure", change the expected closure to:

```ts
      expect(error).toMatchObject({
        reason: "connection-closed",
        message: "The connection disconnected.",
      });
```

5. Append inside `describe("RpcSessionFactory", …)`:

```ts
  it.effect("sends an RPC Ping only after ten seconds without inbound data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);

        yield* TestClock.adjust("9 seconds");
        socket.serverMessage(encodeJson({ _tag: "Pong" }));
        yield* TestClock.adjust("9 seconds");
        expect(pingsSent(socket)).toBe(0);
        yield* TestClock.adjust("1 second");
        expect(pingsSent(socket)).toBe(1);
        expect(socket.readyState).toBe(TestWebSocket.OPEN);
      }),
    ).pipe(withFixedRandom),
  );

  it.effect("closes with 4408 after thirty seconds without inbound data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);

        yield* TestClock.adjust("29 seconds");
        expect(socket.readyState).toBe(TestWebSocket.OPEN);
        expect(pingsSent(socket)).toBe(2);
        yield* TestClock.adjust("1 second");
        const error = yield* Effect.flip(session.closed);
        expect(socket.closeCode).toBe(4408);
        expect(socket.closeReason).toBe("liveness timeout");
        expect(error).toBeInstanceOf(ConnectionTransientError);
        expect(error).toMatchObject({ reason: "liveness-timeout" });
      }),
    ).pipe(withFixedRandom),
  );

  it.effect("keeps a connection while inbound messages keep arriving", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);

        for (let elapsed = 0; elapsed < 64; elapsed += 8) {
          yield* TestClock.adjust("8 seconds");
          socket.serverMessage(encodeJson({ _tag: "Pong" }));
        }
        expect(socket.readyState).toBe(TestWebSocket.OPEN);
        expect(pingsSent(socket)).toBe(0);
      }),
    ).pipe(withFixedRandom),
  );

  it.effect("counts E2EE records as activity before a message is complete", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const staticPrivate = crypto.getRandomValues(new Uint8Array(32));
      const responder = createNkResponder({ staticPrivateKey: staticPrivate });
      const hostKey = Buffer.from(derivePublicKey(staticPrivate)).toString("base64url");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect({
            ...PREPARED,
            socketUrl: "wss://environment.example.test/ws-e2ee",
            e2ee: { hostKey, auth: { kind: "bearer", credential: "stored-secret" } },
          });
          const ready = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          responder.readMessageA(yield* awaitBinaryFrame(socket, 0));
          socket.serverMessage(responder.writeMessageB(new Uint8Array(0)));
          const transport = responder.split();
          const sendRecords = (body: unknown) => {
            for (const record of splitIntoRecords(new TextEncoder().encode(encodeJson(body)))) {
              socket.serverMessage(transport.send.encryptWithAd(new Uint8Array(0), record));
            }
          };
          transport.receive.decryptWithAd(new Uint8Array(0), yield* awaitBinaryFrame(socket, 1));
          sendRecords({ type: "e2ee_authenticated" });
          yield* completeEncryptedInitialConfig(socket, transport, sendRecords, 2);
          yield* Fiber.join(ready);

          // Forty seconds of continuation records for a message that never completes.
          for (let elapsed = 0; elapsed < 40; elapsed += 8) {
            yield* TestClock.adjust("8 seconds");
            socket.serverMessage(
              transport.send.encryptWithAd(new Uint8Array(0), Uint8Array.of(0x01, 0x20)),
            );
          }
          expect(socket.readyState).toBe(TestWebSocket.OPEN);
          yield* TestClock.adjust("30 seconds");
          expect(socket.closeCode).toBe(4408);
        }),
      );
    }).pipe(withFixedRandom),
  );
```

6. Add this helper after `completeInitialConfig` (Task 13 changes both helpers, not the tests):

```ts
const completeEncryptedInitialConfig = Effect.fn(
  "TestRpcSessionFactory.completeEncryptedInitialConfig",
)(function* (
  socket: TestWebSocket,
  transport: { readonly receive: { decryptWithAd(ad: Uint8Array, data: Uint8Array): Uint8Array } },
  sendRecords: (body: unknown) => void,
  frameIndex: number,
) {
  const record = transport.receive.decryptWithAd(
    new Uint8Array(0),
    yield* awaitBinaryFrame(socket, frameIndex),
  );
  const request = decodeRpcRequest(decodeJson(new TextDecoder().decode(record.subarray(1))));
  expect(request.tag).toBe(WS_METHODS.serverGetConfig);
  sendRecords({
    _tag: "Exit",
    requestId: request.id,
    exit: { _tag: "Success", value: encodeServerConfig(SERVER_CONFIG) },
  });
});
```

- [ ] **Step 7: Run the session tests to verify the new ones fail**

Run: `vp test run packages/client-runtime/src/rpc/session.test.ts`
Expected: FAIL. With Effect's pinger:
- the ten-second test sees a Ping at 5 s (`expected 1 to be 0` or similar);
- the 4408 test sees the socket closed with 1000 at about 10 s;
- the keep-alive test sees the pinger close the socket;
- the E2EE test sees a close before 40 s;
- the updated expectation still reads `reason: "transport"`.

- [ ] **Step 8: Rewrite `session.ts`**

Replace the whole content of `packages/client-runtime/src/rpc/session.ts` with:

```ts
import { type E2eeAuthenticatedMessage, type ServerConfig, WS_METHODS } from "@bibcode/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import { e2eeFailureOf, makeE2eeSocket } from "../e2ee/index.ts";
import type { ConnectionAttemptError, PreparedConnection } from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";

import { withInputAdmission } from "./inputAdmission.ts";
import { makeInboundActivity } from "./liveness.ts";
import { makeLivenessProtocol, type RpcDisconnect } from "./livenessProtocol.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
  readonly e2eeAuthenticated: Effect.Effect<E2eeAuthenticatedMessage | null>;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@bibcode/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;

function mapInitialConfigError(error: InitialConfigError): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "UpdateMaintenanceActiveError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: error.message,
      });
  }
}

function mapE2eeFailure(error: unknown): ConnectionAttemptError | null {
  const failure = e2eeFailureOf(error);
  if (failure === null) return null;
  switch (failure.reason) {
    case "host-identity-mismatch":
      return new ConnectionBlockedError({
        reason: "host-identity",
        detail: "The remote host identity does not match the saved pairing.",
      });
    case "unauthorized":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: "The remote environment rejected the saved credential.",
      });
    case "timeout":
      return new ConnectionTransientErrorClass({
        reason: "timeout",
        detail: "The encrypted channel handshake timed out.",
      });
    case "protocol":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: "The encrypted channel protocol failed.",
      });
  }
}

function disconnectError(
  wasConnected: boolean,
  disconnect: RpcDisconnect,
): ConnectionTransientErrorClass {
  if (!wasConnected) {
    return new ConnectionTransientErrorClass({
      reason: "transport",
      detail: "Could not establish a WebSocket connection.",
    });
  }
  switch (disconnect._tag) {
    case "LivenessTimeout":
      return new ConnectionTransientErrorClass({
        reason: "liveness-timeout",
        detail: "The connection disconnected.",
      });
    case "Closed":
      return new ConnectionTransientErrorClass({
        reason: "connection-closed",
        detail: "The connection disconnected.",
      });
    case "Lost":
      return new ConnectionTransientErrorClass({
        reason: "connection-lost",
        detail: "The connection disconnected.",
      });
  }
}

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionAttemptError>();
    const e2eeAuthenticated = yield* Deferred.make<E2eeAuthenticatedMessage | null>();
    const e2eeAttemptFailure = yield* Ref.make<ConnectionAttemptError | null>(null);
    const activity = yield* makeInboundActivity;
    const onDisconnect = (disconnect: RpcDisconnect) =>
      Effect.all({
        wasConnected: Deferred.isDone(connected),
        e2eeFailure: Ref.get(e2eeAttemptFailure),
      }).pipe(
        Effect.flatMap(({ wasConnected, e2eeFailure }) =>
          Deferred.fail(
            disconnected,
            e2eeFailure ?? disconnectError(wasConnected, disconnect),
          ),
        ),
        Effect.asVoid,
      );
    const connectionWebSocketConstructor: typeof webSocketConstructor = (url, protocols) => {
      const socket = webSocketConstructor(url, protocols);
      if (connection.e2ee !== null) socket.binaryType = "arraybuffer";
      // Every raw frame is proof of life, including E2EE records before reassembly.
      socket.addEventListener("message", activity.record);
      return socket;
    };
    const socketLayer = Layer.effect(
      Socket.Socket,
      Socket.makeWebSocket(connection.socketUrl, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
        Effect.map((plainSocket) => {
          if (connection.e2ee === null) return plainSocket;
          const encryptedSocket = makeE2eeSocket(plainSocket, {
            hostKey: connection.e2ee.hostKey,
            auth: connection.e2ee.auth,
            onAuthenticated: (message) => {
              Deferred.doneUnsafe(e2eeAuthenticated, Effect.succeed(message));
            },
          });
          return Socket.make({
            runRaw: (handler, options) =>
              encryptedSocket.runRaw(handler, options).pipe(
                Effect.tapError((error) => {
                  const mapped = mapE2eeFailure(error);
                  return mapped === null ? Effect.void : Ref.set(e2eeAttemptFailure, mapped);
                }),
              ),
            writer: encryptedSocket.writer,
          });
        }),
      ),
    ).pipe(
      Layer.provide(Layer.succeed(Socket.WebSocketConstructor, connectionWebSocketConstructor)),
    );
    // Layer.build keeps the socket in this session's scope; Effect.provide(layer) would close it.
    const transportContext = yield* Layer.build(
      Layer.mergeAll(socketLayer, RpcSerialization.layerJson),
    );
    const protocol = yield* makeLivenessProtocol({
      activity,
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect,
    }).pipe(Effect.provide(transportContext), Effect.withSpan("environment.websocket.connect"));
    const client = withInputAdmission(
      yield* makeWsRpcProtocolClient.pipe(Effect.provideService(RpcClient.Protocol, protocol)),
    );
    const initialConfig = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapInitialConfigError),
        Effect.withSpan("environment.initialSync"),
      ),
    );
    const probe = client[WS_METHODS.serverGetConfig]({}).pipe(
      Effect.mapError(mapInitialConfigError),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client,
      initialConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
      e2eeAuthenticated:
        connection.e2ee === null ? Effect.succeed(null) : Deferred.await(e2eeAuthenticated),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
```

- [ ] **Step 8a: Rename-then-disconnect regression, then current-label formatting**

Append inside `registry.test.ts`'s existing registry describe, using its current `makeHarness`, `sessions`, and `awaitConnectionState` helpers (`registry.rename` tests currently begin near line 1101):

```ts
  for (const [reason, expected] of [
    ["connection-closed", "GPU box disconnected."],
    ["connection-lost", "GPU box disconnected."],
    ["liveness-timeout", "GPU box disconnected."],
  ] as const) {
    it.effect(`uses the saved name after rename for ${reason}`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([RELAY_TARGET]);
        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const environmentId = RELAY_TARGET.environmentId;
          yield* registry.start;
          yield* awaitConnectionState(registry, environmentId, (state) => state.phase === "connected");
          const supervisor = yield* registry.run(environmentId, EnvironmentSupervisor.EnvironmentSupervisor);
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          yield* registry.rename(environmentId, "GPU box");
          expect(yield* SubscriptionRef.get(supervisor.prepared)).toBe(prepared);
          expect(Option.getOrThrow(prepared).label).not.toBe("GPU box");
          const session = (yield* Ref.get(harness.sessions)).at(-1);
          if (session === undefined) throw new Error("Missing live session");
          yield* Deferred.fail(session.closed, new ConnectionTransientError({
            reason, detail: "The connection disconnected.",
          }));
          const state = yield* awaitConnectionState(
            registry, environmentId, (value) => value.phase === "backoff",
          );
          expect(state.lastFailure?.message).toBe(expected);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
    );
  }
```

Run: `vp test run packages/client-runtime/src/connection/registry.test.ts -t "uses the saved name after rename"`.
Expected: FAIL (the raw session detail lacks the current saved name).

In `supervisor.ts`, immediately before `failureFromExit` (current line 165), add:

```ts
function labelDisconnectFailure(
  target: ConnectionTarget,
  error: ConnectionAttemptError,
): ConnectionAttemptError {
  if (error._tag !== "ConnectionTransientError") return error;
  switch (error.reason) {
    case "connection-closed":
    case "connection-lost":
    case "liveness-timeout":
      return new ConnectionTransientError({
        reason: error.reason,
        detail: `${target.label} disconnected.`,
      });
    default:
      return error;
  }
}
```

In `failureFromExit`, replace `failure: typedFailure.error,` with:

```ts
      failure: {
        ...typedFailure.error,
        error: labelDisconnectFailure(target, typedFailure.error.error),
      },
```

Keep its callers' existing `currentTarget()` reads (including the connected-session exit at current lines 541–561); do not substitute the initial `entry.target` or `active.lease.prepared.label`. The registry already updates this Ref atomically on rename. Repeat the focused command: expected PASS for all three reasons.

- [ ] **Step 9: Run the session tests to verify they pass**

Run: `vp test run packages/client-runtime/src/rpc/session.test.ts packages/client-runtime/src/rpc/livenessProtocol.test.ts packages/client-runtime/src/rpc/liveness.test.ts`
Expected: PASS. All three files pass. The existing tests (ordered frames, lost ordered reply at 15 s, unknown-request defect, E2EE handshake, host-identity block, authentication block, stalled handshake, scope release, never-opens) must stay green.

- [ ] **Step 10: Update the connection-runtime doc**

In `docs/architecture/connection-runtime.md`, section "State and retry policy", insert this paragraph immediately after the paragraph that starts "`RpcSessionFactory` disables protocol-owned reconnects.":

```markdown
Liveness is decided by the client from inbound data alone. The WebSocket that
`RpcSessionFactory` creates records every raw inbound message, including E2EE
records before reassembly, so a large response that is still arriving keeps the
connection alive. After 10 seconds without inbound data the client sends the
RPC `Ping`; after three such intervals (30 seconds, each ±10 % jitter) it closes
the socket with code 4408 and reason `liveness timeout`, logs `liveness-timeout`
with the silent time, and fails the session with a `ConnectionTransientError`
whose reason is `liveness-timeout`. A close frame from the server reports
`connection-closed`, and an abnormal closure (1006) or socket error reports
`connection-lost`. The protocol is a local copy of Effect's
`makeProtocolSocket` in `rpc/livenessProtocol.ts`; re-check it against upstream
on every Effect upgrade and delete it once upstream exposes a configurable
pinger.
```

In the same document's "Targets" rename paragraph, replace only the current sentence "Disconnect reasons and storage-identity errors still use `PreparedConnection.label`, the server's reported name." (re-verified at lines 106–108) with:

```markdown
Disconnect reasons read the current saved catalog label from the supervisor's
target Ref when the failure is published, so a rename during a live session
also names the next disconnect correctly. Storage-identity errors still use
the server's reported name.
```

- [ ] **Step 11: Package gates**

Run in order:
- `vp test run packages/client-runtime` — all client-runtime tests. A failure in a file outside this task's scope must be classified per the flake rules.
- `vp check` — no new findings in the touched files.
- `vp run typecheck` — no errors.

Expected: pass (or only pre-existing failures outside this plan, recorded with output).

- [ ] **Step 12: Checkpoint (no commit)**

Run the checkpoint command; record `Task 2 <tree> session/livenessProtocol/liveness tests` in the ledger.

---

### Task 3: Live verification of Phase A (Playwright, throttling proxy)

No repository files change; evidence goes to `$LIVE`. This proves item 1 on a real browser socket before the server work starts. The unchanged server still has its five-second whole-frame write timeout; these bufferbloat trials do not claim Phase B's backpressure tolerance. **The controller runs all live checks on the host; the Codex sandbox blocks loopback sockets. The implementer only writes the scratch scripts and hands off the exact commands. Phase A never waits for R1 or Task 5.**

**Files:**
- Uses (read-only): `$S/s2-liveness/throttle_proxy.py`, `$S/s2-liveness/measure.mjs`, `$S/s2-liveness/pair.mjs`, `$S/s2-liveness/setup-projects.mjs`, `$S/s2-liveness/wswrap.js`, `$S/s2-liveness/make_fixtures.py`. Setup scripts are read-only inputs; the new driver resolves `playwright` through the link under `$LIVE/node_modules`.

**Interfaces:**
- Consumes: Task 2's 4408 close and `liveness-timeout` log.
- Produces: `$LIVE/results-a.jsonl`, screenshots, and a ledger entry.

- [ ] **Step 1: Prepare the live root and fixtures**

```bash
S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad
LIVE=$S/liveness-live
mkdir -p $LIVE/home $LIVE/fixtures $LIVE/shots $LIVE/logs
ln -s $S/s2-liveness/node_modules $LIVE/node_modules
python3 $S/s2-liveness/make_fixtures.py $LIVE/fixtures
```

Expected: `hist-2m: git log bytes=… (2.xx MiB)` and `hist-8m: … (8.xx MiB)` lines.

Write `$S/liveness-live/wswrap.js` with this complete record-aware observer. Keep all original `$S/s2-liveness/` files read-only:

```js
// Scratch-only page observer. Never log payloads, auth messages or credentials.
(() => {
  const NativeWS = window.WebSocket;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const MAX_BYTES = 64 * 1024 * 1024;
  const MAX_RECORDS = 2048;
  const MAX_CONTROL = 65518;
  let sequence = 0;
  const encrypted = new WeakMap();
  const channels = new Map();
  window.__livenessExits = [];
  const now = () => performance.timeOrigin + performance.now();
  const emit = (entry) => console.debug("[wslog]" + JSON.stringify({ t: now(), ...entry }));
  const channel = (id) => {
    if (!channels.has(id)) channels.set(id, { parts: [], bytes: 0, count: 0, requests: new Map() });
    return channels.get(id);
  };
  const encryptedId = (transport) => {
    if (!encrypted.has(transport)) encrypted.set(transport, "e2ee-" + ++sequence);
    return encrypted.get(transport);
  };
  function decoded(id, text, direction, bin = false) {
    let values;
    try { const value = JSON.parse(text); values = Array.isArray(value) ? value : [value]; }
    catch { throw new Error("RPC observer received invalid JSON"); }
    for (const value of values) {
      if (!value || !value._tag) continue; // Never retain or log e2ee_auth/authenticated.
      const state = channel(id);
      const rid = String(value.requestId ?? value.id ?? "");
      if (direction === "send" && value._tag === "Request") state.requests.set(rid, value);
      const request = state.requests.get(rid);
      const result = value._tag === "Exit" ? value.exit : undefined;
      emit({
        ev: direction, id, tag: value._tag, rid, bin,
        method: value.tag ?? request?.tag, limit: String(value.payload?.limit ?? ""),
        exitTag: result?._tag, len: encoder.encode(text).length,
      });
      if (result && request) {
        state.requests.delete(rid);
        if (["gitManager.getCommits", "gitManager.getDiff"].includes(request.tag)) {
          window.__livenessExits.push({
            id, rid, method: request.tag, input: request.payload,
            exitTag: result._tag, value: result.value,
          });
          if (window.__livenessExits.length > 100) window.__livenessExits.shift();
        }
      }
    }
  }
  function record(id, bytes) {
    if (!bytes.length) throw new Error("empty record");
    const state = channel(id);
    const flag = bytes[0], body = bytes.subarray(1);
    if (state.count >= MAX_RECORDS || state.bytes + body.length > MAX_BYTES) {
      throw new Error("record assembly limit exceeded");
    }
    if (flag === 2) {
      if (!body.length || body.length > MAX_CONTROL) throw new Error("control cap");
      decoded(id, decoder.decode(body), "recv", true);
      return; // A control must not mutate the partial data message.
    }
    if (flag !== 0 && flag !== 1) throw new Error("unknown record flag");
    if (flag === 1 && !body.length) throw new Error("empty continuation");
    state.parts.push(body.slice());
    state.bytes += body.length;
    state.count += 1;
    if (flag === 1) return;
    const message = new Uint8Array(state.bytes);
    let offset = 0;
    for (const part of state.parts) { message.set(part, offset); offset += part.length; }
    state.parts = []; state.bytes = 0; state.count = 0;
    decoded(id, decoder.decode(message), "recv", true);
  }
  // Called by the scratch driver's in-memory dev-module instrumentation.
  window.__livenessRecord = (transport, bytes) => record(encryptedId(transport), bytes);
  window.__livenessSend = (transport, bytes) =>
    decoded(encryptedId(transport), decoder.decode(bytes), "send");
  class ObservedWebSocket extends NativeWS {
    constructor(url, protocols) {
      const original = String(url);
      const rewritten = original.replace(
        "://localhost:__SERVER_PORT__/", "://localhost:__PROXY_PORT__/",
      );
      super(rewritten, protocols);
      const parsed = new URL(rewritten);
      const rpc = ["/ws", "/ws-e2ee"].includes(parsed.pathname);
      this.__id = ++sequence;
      this.__rpc = rpc;
      this.__encrypted = parsed.pathname === "/ws-e2ee";
      if (!rpc) return;
      if (!this.__encrypted) window.__rpcSocket = this;
      emit({ ev: "construct", id: this.__id, rpc, url: parsed.origin + parsed.pathname });
      this.addEventListener("open", () =>
        emit({ ev: "open", id: this.__id, protocol: this.protocol }));
      let pending = Promise.resolve();
      this.addEventListener("message", (event) => {
        pending = pending.then(async () => {
          const data = event.data;
          emit({ ev: "raw-recv", id: this.__id, bin: typeof data !== "string",
            len: typeof data === "string" ? encoder.encode(data).length : data.byteLength ?? data.size });
          if (this.__encrypted) return; // Ciphertext is decoded at the instrumented boundary.
          if (typeof data === "string") return decoded(this.__id, data, "recv");
          const bytes = data instanceof Blob
            ? new Uint8Array(await data.arrayBuffer())
            : data instanceof Uint8Array ? data : new Uint8Array(data);
          if (this.protocol === "bibcode.rpc.chunked.v1") record(this.__id, bytes);
          else decoded(this.__id, decoder.decode(bytes), "recv", true);
        }).catch((error) => {
          window.__livenessObserverError = String(error);
          emit({ ev: "observer-error", id: this.__id, message: String(error) });
        });
      });
      this.addEventListener("close", (event) =>
        emit({ ev: "close", id: this.__id, code: event.code, reason: event.reason }));
    }
    send(data) {
      if (this.__rpc && !this.__encrypted && typeof data === "string") {
        decoded(this.__id, data, "send");
      }
      return super.send(data);
    }
    close(code, reason) {
      if (this.__rpc) emit({ ev: "close-call", id: this.__id, code, reason });
      return super.close(code, reason);
    }
  }
  window.WebSocket = ObservedWebSocket;
  window.__injectRpc = (tag, payload) => {
    const socket = window.__rpcSocket;
    if (!socket || socket.readyState !== 1) return null;
    const id = String(900000000 + Math.floor(Math.random() * 99999999));
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    return id;
  };
})();
```

Write `$S/liveness-live/measure.mjs` with this driver. Plain and E2EE transfers use the same successful-Exit oracle: the exact request id, successful exit tag, and exact serialized payload length/content from a freshly obtained unthrottled baseline. E2EE observation occurs on decrypted records inside the dev response, before application reassembly; ciphertext lengths or rendered text never count as completion.

```js
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const D = process.env.D;
const WEB = process.env.WEB;
const CONTROL = process.env.CONTROL ?? "127.0.0.1:13982";
const ROOT = "/work/workspaces/orca/BibCode/main-3";
const trials = JSON.parse(readFileSync(process.env.TRIALS, "utf8"));
const context = await chromium.launchPersistentContext(D + "/profile", {
  headless: true, viewport: { width: 1500, height: 950 },
});
const wrap = readFileSync(D + "/wswrap.js", "utf8")
  .replaceAll("__SERVER_PORT__", process.env.SERVER_PORT)
  .replaceAll("__PROXY_PORT__", process.env.PROXY_PORT);
await context.addInitScript(wrap);
// Instrument only the dev response in this browser. Never edit repository source
// or the old spike files. Both anchors are checked; drift fails the live check.
await context.route("**/e2ee/socket.ts*", async (route) => {
  const response = await route.fetch();
  let body = await response.text();
  for (const [oldText, newText] of [
    ["message = assembler.push(record);",
     "globalThis.__livenessRecord?.(currentTransport(), record); message = assembler.push(record);"],
    ["try: () => plaintextRecords(plaintext),",
     "try: () => { globalThis.__livenessSend?.(transport, plaintext); return plaintextRecords(plaintext); },"],
  ]) {
    assert.equal(body.split(oldText).length, 2, "E2EE observer anchor must match once");
    body = body.replace(oldText, newText);
  }
  await route.fulfill({ response, body });
});
const page = context.pages()[0] ?? await context.newPage();
let events = [];
page.on("console", (message) => {
  if (!message.text().startsWith("[wslog]")) return;
  const entry = JSON.parse(message.text().slice(7));
  events.push(entry);
  appendFileSync(process.env.WSLOG, JSON.stringify(entry) + "\n");
});
const setLink = async (down, up, mode = "small") => {
  const result = await fetch("http://" + CONTROL + "/set?down=" + down + "&up=" + up + "&freeze=0&mode=" + encodeURIComponent(mode));
  assert(result.ok);
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
async function requestFixture(method, input) {
  return page.evaluate(async ({ root, label, method, input }) => {
    const { appAtomRegistry: registry } = await import("/src/rpc/atomRegistry.ts");
    const { connectionAtomRuntime: runtime } = await import("/src/connection/runtime.ts");
    const { environmentCatalog } = await import("/src/connection/catalog.ts");
    const { runInEnvironment } = await import("/@fs" + root + "/packages/client-runtime/src/state/runtime.ts");
    const { request } = await import("/@fs" + root + "/packages/client-runtime/src/rpc/client.ts");
    const entries = registry.get(environmentCatalog.catalogValueAtom).entries;
    const entry = [...entries.values()].find((entry) => entry.target.label === label);
    if (!entry) throw new Error("Environment not found: " + label);
    const before = window.__livenessExits.length;
    const stable = (value) => JSON.stringify(value, Object.keys(value).sort());
    const sameInput = (left, right) =>
      stable(left) === stable(right) && stable(left.source ?? {}) === stable(right.source ?? {});
    const atom = runtime.atom(runInEnvironment(entry.target.environmentId, request(method, input)));
    const release = registry.mount(atom);
    let unsubscribe = () => {};
    let deadline;
    try {
      await new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("Fixture deadline exceeded")), 240000);
        unsubscribe = registry.subscribe(atom, (result) => {
          if (result.waiting || result._tag === "Initial") return;
          if (result._tag === "Failure") reject(new Error("Fixture RPC failed"));
          else resolve(undefined);
        }, { immediate: true });
      });
      for (let i = 0; i < 100; i += 1) {
        if (window.__livenessObserverError) throw new Error(window.__livenessObserverError);
        const exit = window.__livenessExits.slice(before).find((exit) =>
          exit.method === method && sameInput(exit.input, input));
        if (exit) return exit;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("No record-aware Exit for the request");
    } finally {
      clearTimeout(deadline);
      unsubscribe(); release();
    }
  }, { root: ROOT, label: process.env.REMOTE_LABEL ?? "Local", method, input });
}
try {
  for (const trial of trials) {
    await setLink(0, 0);
    await page.goto("http://localhost:" + WEB + "/", { waitUntil: "domcontentloaded" });
    await page.getByTestId("sidebar-add-project-trigger").waitFor({ timeout: 90000 });
    await page.waitForTimeout(3000);
    const cwd = D + "/fixtures/" + trial.fixture;
    const method = trial.method ?? (trial.fixture.includes("bigdiff")
      ? "gitManager.getDiff" : "gitManager.getCommits");
    const input = method === "gitManager.getDiff"
      ? { cwd, source: { _tag: "commit", sha: execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), path: "big.txt" } }
      : { cwd, offset: 0, limit: 100 };
    const expected = await requestFixture(method, input);
    assert.equal(expected.exitTag, "Success", "unthrottled baseline must succeed");
    const expectedJson = JSON.stringify(canonical(expected.value));
    const expectedBytes = Buffer.byteLength(expectedJson);
    const minimumBytes = trial.minBytes ?? (method === "gitManager.getDiff" ? 3500000 : 512000);
    assert(expectedBytes >= minimumBytes, "baseline must contain the expected large fixture");
    events = [];
    await setLink(trial.down, trial.up, trial.mode ?? "small");
    const started = Date.now();
    let actual, failure;
    try { actual = await requestFixture(method, input); }
    catch (error) { failure = String(error); }
    const transferMs = Date.now() - started;
    const close = events.find((event) => event.ev === "close");
    const closeCall = events.find((event) => event.ev === "close-call");
    const actualJson = actual && JSON.stringify(canonical(actual.value));
    const completed = actual?.exitTag === "Success"
      && Buffer.byteLength(actualJson) === expectedBytes && actualJson === expectedJson;
    const summary = {
      label: trial.label, completed, disconnected: Boolean(close), transferMs, expectedBytes,
      reqId: actual?.rid ?? null, exitTag: actual?.exitTag ?? null,
      clientInitiatedClose: Boolean(closeCall), clientCloseCode: closeCall?.code ?? null,
      disconnectAfterReqMs: closeCall ? closeCall.t - started : null,
      binaryRecords: events.filter((event) => event.ev === "raw-recv" && event.bin).length,
      failure: failure ?? null,
    };
    appendFileSync(process.env.OUT, JSON.stringify(summary) + "\n");
    await page.screenshot({ path: D + "/shots/" + trial.label + ".png" });
    if (trial.expectLivenessClose) {
      assert.equal(closeCall?.code, 4408);
      assert(summary.disconnectAfterReqMs >= 27000 && summary.disconnectAfterReqMs <= 33000);
    } else {
      assert(completed, "successful Exit must have exact baseline length and content");
      assert(!close, "transfer socket must stay connected");
    }
    console.log(JSON.stringify(summary));
  }
} finally {
  await setLink(0, 0);
  await context.close();
}
```

Run: `node --check "$LIVE/wswrap.js"` and `node --check "$LIVE/measure.mjs"`; after Step 6 also run `node --check "$LIVE/freeze.mjs"`.
Expected: exit 0. The controller runs the browser commands below on the host. The old pair/setup scripts may be reused read-only because they read `$D/wswrap.js`; do not run either old measurement driver.

- [ ] **Step 2: Start an isolated dev server (offset 71: server 13844, web 5804)**

```bash
cd /work/workspaces/orca/BibCode/main-3
BIBCODE_PORT_OFFSET=71 BIBCODE_HOME=$LIVE/home setsid vp run dev > $LIVE/logs/dev.log 2>&1 &
echo $! > $LIVE/logs/dev.pid
```

Wait until `$LIVE/logs/dev.log` contains `serverPort=13844 webPort=5804` and a startup JSON line with `"token"`. Then save the token without printing it:

```bash
grep -o '"token":"[^"]*"' $LIVE/logs/dev.log | head -1 | cut -d'"' -f4 > $LIVE/.token
test -s $LIVE/.token && echo "token saved (value redacted)"
```

- [ ] **Step 3: Start the throttling proxy (listen 13981 → 13844, control 13982)**

```bash
python3 $S/s2-liveness/throttle_proxy.py --listen 127.0.0.1:13981 --target 127.0.0.1:13844 \
  --control 127.0.0.1:13982 --log $LIVE/logs/proxy-a.jsonl > $LIVE/logs/proxy-a.out 2>&1 &
echo $! > $LIVE/logs/proxy-a.pid
```

- [ ] **Step 4: Pair the Playwright profile and add the fixtures**

```bash
D=$LIVE WEB=5804 TOKEN_FILE=$LIVE/.token node $S/s2-liveness/pair.mjs
D=$LIVE WEB=5804 SERVER_PORT=13844 PROXY_PORT=13981 NAMES=hist-2m,hist-8m \
  node $S/s2-liveness/setup-projects.mjs
```

Expected: `url after exchange:` without `/pair`, then `hist-2m: present=true` and `hist-8m: present=true`.

- [ ] **Step 5: Run the trials**

Every Phase A transfer row below uses the spike proxy’s `mode: "large"` (bufferbloat): it drains the unchanged server promptly so these trials avoid its five-second writer limit. If a run instead records the old writer timeout, classify it as an invalid Phase A setup, not a client-liveness pass; inspect proxy mode/buffering before rerunning. Phase B uses `mode: "small"` backpressure. The negative whole-frame case runs at 192 KiB/s, taking more than the maximum 33 s client deadline; 256 KiB/s would sit on the jitter boundary. This preserves Phase A’s independence from R1.

Write `$LIVE/trials-a.json`:

```json
[
  {"label":"a-256k-hist-2m","fixture":"hist-2m","minBytes":2000000,"down":262144,"up":262144,"latency":20,"mode":"large","trigger":"ui","observe":30},
  {"label":"a-512k-hist-8m","fixture":"hist-8m","minBytes":8000000,"down":524288,"up":524288,"latency":20,"mode":"large","trigger":"ui","observe":40},
  {"label":"a-192k-hist-8m","expectLivenessClose":true,"fixture":"hist-8m","minBytes":8000000,"down":196608,"up":196608,"latency":20,"mode":"large","trigger":"ui","observe":60}
]
```

Run:

```bash
D=$LIVE WEB=5804 SERVER_PORT=13844 PROXY_PORT=13981 CONTROL=127.0.0.1:13982 \
  TRIALS=$LIVE/trials-a.json OUT=$LIVE/results-a.jsonl WSLOG=$LIVE/logs/wslog-a.jsonl \
  node $LIVE/measure.mjs
```

Expected, per printed JSON line:
- `a-256k-hist-2m`: `"completed":true,"disconnected":false`.
- `a-512k-hist-8m`: `"completed":true,"disconnected":false`. Before this plan it dropped at 6.4 s.
- `a-192k-hist-8m`: the whole 8.6 MB frame cannot arrive within 30 s, so expect `"clientInitiatedClose":true`, `"clientCloseCode":4408`, and `disconnectAfterReqMs` between 27000 and 33000. The old pinger used code 1000 for these liveness failures. This drop is expected until Phase B splits messages.

- [ ] **Step 6: Frozen proxy**

With the page idle (open `http://localhost:5804/` through Playwright or reuse the last run's page), freeze the link: `curl -s "http://127.0.0.1:13982/set?down=1&up=1"`. The wslog must show a `close-call` with code 4408 27–33 s after the last receive event before it. That last receive is normally just before the freeze. Unfreeze with `curl -s "http://127.0.0.1:13982/set?down=0&up=0"` and confirm a new socket opens.

Write `$S/liveness-live/freeze.mjs` with the following complete driver; it also supplies F2's before-thaw assertions. It reads only a newly appended suffix of the isolated server log, and never accepts a line observed after the deadline:

```js
import assert from "node:assert/strict";
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const D = process.env.D;
const phaseA = process.env.PHASE_A === "1";
const transfer = process.env.KIND === "transfer";
const control = "http://" + (process.env.CONTROL ?? "127.0.0.1:13982");
const set = async (query) => {
  const response = await fetch(control + "/set?" + query);
  assert(response.ok);
};
const ctx = await chromium.launchPersistentContext(D + "/profile", {
  headless: true, viewport: { width: 1500, height: 950 },
});
const wrap = readFileSync(D + "/wswrap.js", "utf8")
  .replaceAll("__SERVER_PORT__", process.env.SERVER_PORT)
  .replaceAll("__PROXY_PORT__", process.env.PROXY_PORT);
await ctx.addInitScript(wrap);
const page = ctx.pages()[0] ?? await ctx.newPage();
const events = [];
page.on("console", (message) => {
  if (message.text().startsWith("[wslog]")) events.push(JSON.parse(message.text().slice(7)));
});
const waitFor = async (predicate, deadline, message) => {
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await page.waitForTimeout(25);
  }
  assert.fail(message);
};
try {
  await set("down=0&up=0&freeze=0");
  await page.goto("http://localhost:" + process.env.WEB + "/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("sidebar-add-project-trigger").waitFor({ timeout: 90000 });
  const socketPort = process.env.EXTRA_PORTS ?? process.env.PROXY_PORT;
  const opened = await waitFor(() => events.findLast((event) =>
    event.ev === "construct" && event.url.includes(":" + socketPort + "/")
    && events.some((other) => other.id === event.id && other.ev === "raw-recv")
    && !events.some((other) => other.id === event.id && other.ev === "close")),
    Date.now() + 90000, "authenticated target socket never received data");
  const socketId = opened.id;
  await page.waitForTimeout(1000);
  if (transfer) {
    assert(!phaseA, "transfer reaping is a Phase C check");
    const cwd = D + "/fixtures/bigdiff";
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await set("down=65536&up=65536");
    const requestedAt = Date.now();
    const id = await page.evaluate(({ cwd, sha }) => window.__injectRpc(
      "gitManager.getDiff", { cwd, source: { _tag: "commit", sha, path: "big.txt" } },
    ), { cwd, sha });
    assert(id, "plain fixture request was sent");
    await waitFor(() => events.find((event) =>
      event.id === socketId && event.ev === "raw-recv" && event.bin && event.t >= requestedAt),
      Date.now() + 10000, "no first binary data record");
  }
  const logPrefix = process.env.SERVER_LOG ? readFileSync(process.env.SERVER_LOG, "utf8") : "";
  const frozenAt = Date.now();
  await set(phaseA ? "down=1&up=1" : "freeze=1");
  const close = await waitFor(() => events.find((event) =>
    event.id === socketId && event.ev === "close-call" && event.t >= frozenAt),
    frozenAt + 33000, "no client liveness close within 33 s");
  assert.equal(close.code, 4408);
  const lastInbound = events.filter((event) =>
    event.id === socketId && event.ev === "raw-recv" && event.t <= close.t).at(-1);
  assert(lastInbound);
  assert(close.t - lastInbound.t >= 27000 && close.t - lastInbound.t <= 33000,
    "client clock uses last raw data, within jitter");
  let serverEndedMs = null;
  if (!phaseA) {
    assert(process.env.SERVER_LOG, "server log required for before-thaw evidence");
    const bound = transfer ? 33000 : 50000;
    const needle = transfer ? "RPC writer gave up; ending the session"
      : "RPC peer silent for 45 s; ending the session";
    await waitFor(() => readFileSync(process.env.SERVER_LOG, "utf8")
      .slice(logPrefix.length).includes(needle), frozenAt + bound,
      "server teardown exceeded its freeze-start bound");
    serverEndedMs = Date.now() - frozenAt;
    assert(serverEndedMs <= bound);
    const state = await (await fetch(control + "/state")).json();
    assert.equal(state.frozen, true, "all timing assertions precede thaw");
  }
  await page.screenshot({ path: D + "/shots/frozen-" + (transfer ? "transfer" : "idle") + ".png" });
  const result = { kind: transfer ? "transfer" : "idle", clientCloseMs: close.t - frozenAt,
    closeCode: close.code, serverEndedMs };
  appendFileSync(D + "/logs/freeze-results.jsonl", JSON.stringify(result) + "\n");
  console.log(JSON.stringify(result));
} finally {
  await set("down=0&up=0&freeze=0");
  await ctx.close();
}
```

The controller runs on the host:

```bash
D=$LIVE WEB=5804 SERVER_PORT=13844 PROXY_PORT=13981 CONTROL=127.0.0.1:13982 PHASE_A=1 \
  node $LIVE/freeze.mjs
```

Expected: exit 0 and `closeCode: 4408`, within 33 s of freeze start and 27–33 s after the last raw data message. Phase A does not assert the not-yet-implemented server heartbeat.

A 1 B/s trickle works as a freeze here only because Phase A has no server heartbeat. Apart from a Pong, every frame the server might send while idle is 34 bytes or more, so none arrives complete within 33 s. A Pong only answers a client Ping. At 1 B/s the Ping (about 21 bytes) and then the Pong (about 17 bytes) each take their size in seconds to cross, so the round trip needs more than 33 s. From Phase C on, the server's WebSocket heartbeat Ping and the browser's automatic Pong get through a 1 B/s link, so the server side never goes silent. That is why F2 uses a real freeze (`scripts/throttle-proxy.ts`, `freeze=1`).

- [ ] **Step 7: Stop only what you started and record evidence**

```bash
kill $(cat $LIVE/logs/proxy-a.pid)
kill -- -$(cat $LIVE/logs/dev.pid)
```

`setsid` made the dev runner a group leader, so this stops only its children. Append the three result lines, the frozen-proxy timing, and the screenshot paths to the ledger under `Task 3`.

---

## Phase B — Items 2, 3, 4: records, control lane, progress deadlines

### Task 4: A failed write ends the plain session (early fix)

**Files:**
- Modify: `apps/server/src/rpc/session.rs` (writer task in `run_session_split_budgeted`, reader ownership)
- Test: `apps/server/src/rpc/session.rs` (`mod tests`)

**Interfaces:**
- Consumes: nothing new.
- Produces: the invariant that a writer failure cancels `session_shutdown` at once and the socket halves are dropped within one second. Task 5 keeps this invariant, and the same test, when it moves the writer to `transport.rs`.

- [ ] **Step 1: Write the failing test**

In `apps/server/src/rpc/session.rs` `mod tests`, add after `struct BlockedSocketSink`'s impl block:

```rust
    /// Accepts one frame and never finishes writing it, like a peer that stopped reading.
    struct StalledSocketSink {
        started: Option<tokio::sync::oneshot::Sender<()>>,
        dropped: Option<tokio::sync::oneshot::Sender<()>>,
    }

    impl StalledSocketSink {
        fn new() -> (
            Self,
            tokio::sync::oneshot::Receiver<()>,
            tokio::sync::oneshot::Receiver<()>,
        ) {
            let (started, started_receiver) = tokio::sync::oneshot::channel();
            let (dropped, dropped_receiver) = tokio::sync::oneshot::channel();
            (
                Self {
                    started: Some(started),
                    dropped: Some(dropped),
                },
                started_receiver,
                dropped_receiver,
            )
        }
    }

    impl Drop for StalledSocketSink {
        fn drop(&mut self) {
            if let Some(dropped) = self.dropped.take() {
                let _ = dropped.send(());
            }
        }
    }

    impl<T> Sink<T> for StalledSocketSink {
        type Error = Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(mut self: Pin<&mut Self>, _item: T) -> Result<(), Self::Error> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
            }
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
    }
```

And add this test at the end of `mod tests`:

```rust
    #[tokio::test(start_paused = true)]
    async fn writer_failure_ends_the_session_and_drops_the_socket_within_one_second() {
        let mut registry = RpcRegistry::empty();
        registry.register_unary("test.echo", |_request, _cancellation| async {
            Ok(json!({ "value": "x".repeat(1024) }))
        });
        let (inbound_sender, inbound_receiver) = mpsc::channel(1);
        let reader = stream::unfold(inbound_receiver, |mut receiver| async {
            receiver.recv().await.map(|item| (Ok(item), receiver))
        });
        let (sink, started, dropped) = StalledSocketSink::new();
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_session_split_budgeted(
            sink,
            reader,
            registry,
            RpcSessionContext::unauthenticated(),
            shutdown.clone(),
            None,
        ));
        inbound_sender
            .send(request_frame(&["1"], "test.echo"))
            .await
            .expect("send request");
        timeout(Duration::from_secs(1), started)
            .await
            .expect("the response reaches the socket")
            .expect("start signal");

        tokio::time::advance(SOCKET_WRITE_TIMEOUT).await;
        timeout(Duration::from_secs(1), shutdown.cancelled())
            .await
            .expect("a failed write ends the session");
        timeout(Duration::from_secs(1), dropped)
            .await
            .expect("the socket is released within one second")
            .expect("drop signal");
        timeout(Duration::from_secs(1), session)
            .await
            .expect("session ends")
            .expect("session joins");
        drop(inbound_sender);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p bibcode-server --lib rpc::session::tests::writer_failure_ends_the_session_and_drops_the_socket_within_one_second`
Expected: FAIL with `a failed write ends the session`. Today the writer breaks out of its loop and tries a 5 s graceful close, but never cancels the session.

- [ ] **Step 3: Implement the fix**

In `run_session_split_budgeted`:

1. Replace `let socket_reader = socket_reader;` and `let mut socket_reader = std::pin::pin!(socket_reader);` with:

```rust
    // Boxed so the read half can be dropped as soon as the loop ends.
    let mut socket_reader = Box::pin(socket_reader);
```

2. Replace the whole `let mut writer = tokio::spawn(async move { … });` block with:

```rust
    let mut writer = tokio::spawn(async move {
        let mut failed = false;
        loop {
            let message = tokio::select! {
                () = writer_shutdown.cancelled() => break,
                message = outbound_receiver.recv() => {
                    let Some(message) = message else {
                        break;
                    };
                    message
                }
            };
            let Ok(message) = message.into_wire() else {
                failed = true;
                break;
            };
            if !matches!(
                timeout(SOCKET_WRITE_TIMEOUT, socket_writer.send(message)).await,
                Ok(Ok(()))
            ) {
                failed = true;
                break;
            }
        }
        if failed {
            // The peer stopped accepting data. End the session now so the socket
            // closes instead of staying open and silent; a graceful close would
            // only queue behind the stuck write.
            writer_shutdown.cancel();
        } else {
            let _ = timeout(SOCKET_WRITE_TIMEOUT, socket_writer.close()).await;
        }
    });
```

3. Immediately after the closing brace of the `{ let dispatch = …; loop { … } }` block and before `session_shutdown.cancel();`, insert:

```rust
    // Release the read half at once: after a writer failure both halves must go
    // so the connection closes promptly.
    drop(socket_reader);
```

- [ ] **Step 4: Run the test and the session suite**

Run: `cargo test -p bibcode-server --lib rpc::session`
Expected: PASS (`test result: ok.`). The new test and all existing session tests pass.

- [ ] **Step 5: Checkpoint (no commit)**

Record `Task 4 <tree> rpc::session` in the ledger.

---

### Task 5: Server transport writer: records, control lane, progress deadlines

**R1 approved by the user on 2026-09-25:** the legacy whole-frame deadline below is an approved deviation from the spec's parenthetical.

This task replaces both writer loops (plain `session.rs` and the E2EE outbound pump) with one writer in `apps/server/src/rpc/transport.rs`. Plain sessions select their framing from the negotiated subprotocol. No route offers it until Task 6, so plain `/ws` still sends whole frames after this task.

**Files:**
- Create: `apps/server/src/rpc/transport.rs`
- Modify: `apps/server/src/rpc/mod.rs` (declare the module)
- Modify: `apps/server/src/rpc/session.rs` (queue, control lane, writer spawn, `run_session`, tests)
- Modify: `apps/server/src/rpc/e2ee.rs` (drop the outbound pump and `PollSender`; move writer tests)
- Modify: `apps/server/src/rpc/byte_budget.rs` (enable existing nonblocking byte admission for the data fallback)
- Docs: `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/remote.md`, `docs/architecture/overview.md`

**Interfaces:**
- Consumes (from `session.rs`): `RpcOutboundFrame` with `pub(super) fn into_wire(self) -> Result<Self, serde_json::Error>` and `pub(crate) fn into_parts(self) -> (Message, Option<RpcOutboundBytePermit>)`.
- Consumes (from `e2ee.rs`): `pub(super) fn plaintext_records(&[u8]) -> Result<PlaintextRecords<'_>, E2eeSessionError>` (with `pub(super) struct PlaintextRecords`) and `pub(super) fn E2eeChannel::encrypt_record(&mut self, flag: u8, chunk: &[u8]) -> Result<Vec<u8>, E2eeSessionError>`.
- Produces (`transport.rs`):
  - `pub(crate) const CHUNKED_RPC_SUBPROTOCOL: &str = "bibcode.rpc.chunked.v1"`
  - `pub(crate) const RECORD_FLAG_CONTROL: u8 = 0x02`
  - `pub(crate) const PLAIN_WHOLE_MESSAGE_MAX_BYTES: usize = 65_536`
  - `pub(crate) const WRITE_PROGRESS_TIMEOUT: Duration = 20 s`
  - `pub(crate) const CONTROL_LANE_CAPACITY: usize = 80`
  - `pub(crate) enum OutboundFraming { Whole, PlainRecords, Encrypted { channel: Arc<Mutex<E2eeChannel>>, interleave: bool } }`
  - `pub(crate) fn message_deadline(started: Instant, bytes: usize) -> Instant`
  - `pub(crate) async fn run_writer<S: Sink<Message> + Unpin>(sink, framing, data: mpsc::Receiver<RpcOutboundFrame>, control: mpsc::Receiver<ServerMessage>, shutdown: CancellationToken)`
- Produces (`session.rs`): `run_session_split_budgeted(socket_writer: W: Sink<Message>, framing: OutboundFraming, socket_reader, registry, context, session_shutdown, outbound_budget)`.
  - `RpcOutboundQueue.control: mpsc::Sender<ServerMessage>`
  - `#[cfg(test)] pub(super) fn RpcOutboundFrame::plain(ServerMessage) -> RpcOutboundFrame`

- [ ] **Step 1: Write the failing session tests**

In `apps/server/src/rpc/session.rs` `mod tests`, add these two tests. They use the post-change signature and will not compile yet:

```rust
    #[tokio::test]
    async fn a_ping_flood_fills_the_control_lane_without_ending_the_read_loop() {
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let started_sender = Arc::new(std::sync::Mutex::new(Some(started_sender)));
        let mut registry = RpcRegistry::empty();
        registry.register_unary("test.after", move |_request, _cancellation| {
            let started_sender = Arc::clone(&started_sender);
            async move {
                if let Some(sender) = started_sender
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                {
                    let _ = sender.send(());
                }
                Ok(json!({}))
            }
        });
        let pings = serde_json::to_string(&vec![json!({ "_tag": "Ping" }); CONTROL_LANE_CAPACITY * 2])
            .expect("ping batch");
        let (inbound_sender, inbound_receiver) = mpsc::channel(2);
        let reader = stream::unfold(inbound_receiver, |mut receiver| async {
            receiver.recv().await.map(|item| (Ok(item), receiver))
        });
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_session_split_budgeted(
            BlockedSocketSink::default(),
            OutboundFraming::Whole,
            reader,
            registry,
            RpcSessionContext::unauthenticated(),
            shutdown.clone(),
            None,
        ));
        inbound_sender
            .send(RpcInboundFrame::plain(Message::Text(pings.into())))
            .await
            .expect("send pings");
        inbound_sender
            .send(request_frame(&["1"], "test.after"))
            .await
            .expect("send request");

        timeout(Duration::from_secs(1), started_receiver)
            .await
            .expect("the read loop survives a full control lane")
            .expect("handler start signal");
        assert!(!shutdown.is_cancelled());
        shutdown.cancel();
        drop(inbound_sender);
        timeout(Duration::from_secs(2), session)
            .await
            .expect("session cleanup deadline")
            .expect("session joins");
    }

    #[tokio::test(start_paused = true)]
    async fn control_messages_overtake_queued_responses() {
        let mut registry = RpcRegistry::empty();
        registry.register_unary("test.large", |_request, _cancellation| async {
            Ok(json!({ "data": "x".repeat(8 * 1024) }))
        });
        let recorded = Arc::new(std::sync::Mutex::new(Vec::<Message>::new()));
        let sink_recorded = Arc::clone(&recorded);
        let sink = Box::pin(futures_util::sink::unfold((), move |(), message: Message| {
            let recorded = Arc::clone(&sink_recorded);
            async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                recorded.lock().expect("recorded frames").push(message);
                Ok::<_, Infallible>(())
            }
        }));
        let (inbound_sender, inbound_receiver) = mpsc::channel(4);
        let reader = stream::unfold(inbound_receiver, |mut receiver| async {
            receiver.recv().await.map(|item| (Ok(item), receiver))
        });
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_session_split_budgeted(
            sink,
            OutboundFraming::Whole,
            reader,
            registry,
            RpcSessionContext::unauthenticated(),
            shutdown.clone(),
            None,
        ));
        inbound_sender
            .send(request_frame(&["1", "2"], "test.large"))
            .await
            .expect("send requests");
        tokio::time::sleep(Duration::from_millis(500)).await;
        inbound_sender
            .send(RpcInboundFrame::plain(Message::Text(r#"{"_tag":"Ping"}"#.into())))
            .await
            .expect("send ping");
        tokio::time::sleep(Duration::from_secs(5)).await;

        let tags: Vec<String> = recorded
            .lock()
            .expect("recorded frames")
            .iter()
            .map(|message| {
                let Message::Text(text) = message else {
                    panic!("legacy framing writes text frames");
                };
                let value: Value = serde_json::from_str(text).expect("frame JSON");
                value["_tag"].as_str().unwrap_or_default().to_owned()
            })
            .collect();
        assert_eq!(tags, vec!["Exit", "Pong", "Exit"], "the Pong overtakes the queued response");
        shutdown.cancel();
        drop(inbound_sender);
        timeout(Duration::from_secs(2), session)
            .await
            .expect("session cleanup deadline")
            .expect("session joins");
    }
```

Create `apps/server/src/rpc/transport.rs` with these tests first, and declare `mod transport;` in `rpc/mod.rs`. Step 3 supplies the missing production code above this module:

```rust
#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use futures_util::sink;
    use serde_json::{Value, json};

    use super::*;
    use crate::rpc::message::RequestId;

    type Recorded = Arc<Mutex<Vec<Message>>>;

    fn recording_sink(delay: Duration) -> (impl Sink<Message, Error = Infallible> + Unpin, Recorded) {
        let recorded: Recorded = Arc::default();
        let sink_recorded = Arc::clone(&recorded);
        let sink = Box::pin(sink::unfold((), move |(), message: Message| {
            let recorded = Arc::clone(&sink_recorded);
            async move {
                tokio::time::sleep(delay).await;
                recorded.lock().expect("recorded frames").push(message);
                Ok::<_, Infallible>(())
            }
        }));
        (sink, recorded)
    }

    fn response(id: &str, bytes: usize) -> RpcOutboundFrame {
        RpcOutboundFrame::plain(ServerMessage::success(
            RequestId::try_from(id).expect("request id"),
            Some(json!({ "data": "x".repeat(bytes) })),
        ))
    }

    fn flags(recorded: &[Message]) -> Vec<u8> {
        recorded
            .iter()
            .filter_map(|message| match message {
                Message::Binary(bytes) => bytes.first().copied(),
                _ => None,
            })
            .collect()
    }

    async fn write_all(
        framing: OutboundFraming,
        delay: Duration,
        frames: Vec<RpcOutboundFrame>,
    ) -> (Recorded, CancellationToken) {
        let (sink, recorded) = recording_sink(delay);
        let (data_sender, data) = mpsc::channel(8);
        let (_control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        let shutdown = CancellationToken::new();
        for frame in frames {
            data_sender.try_send(frame).expect("queue frame");
        }
        drop(data_sender);
        run_writer(sink, framing, data, control, shutdown.clone()).await;
        (recorded, shutdown)
    }

    #[tokio::test]
    async fn message_deadline_is_thirty_seconds_plus_size_at_sixteen_kib_per_second() {
        let started = Instant::now();
        assert_eq!(message_deadline(started, 0) - started, Duration::from_secs(30));
        assert_eq!(message_deadline(started, 16 * 1024) - started, Duration::from_secs(31));
        assert_eq!(
            message_deadline(started, 8 * 1024 * 1024) - started,
            Duration::from_secs(542)
        );
    }

    #[tokio::test]
    async fn whole_framing_sends_one_text_frame_per_message() {
        let (recorded, shutdown) =
            write_all(OutboundFraming::Whole, Duration::ZERO, vec![response("1", 200 * 1024)]).await;
        let recorded = recorded.lock().expect("recorded frames");
        assert_eq!(recorded.len(), 1);
        assert!(matches!(&recorded[0], Message::Text(text) if text.len() > 200 * 1024));
        assert!(!shutdown.is_cancelled());
    }

    #[tokio::test]
    async fn plain_records_split_large_messages_and_keep_small_ones_whole() {
        let (recorded, _) = write_all(
            OutboundFraming::PlainRecords,
            Duration::ZERO,
            vec![response("1", 1024), response("2", 200 * 1024)],
        )
        .await;
        let recorded = recorded.lock().expect("recorded frames");
        assert!(matches!(&recorded[0], Message::Text(_)), "a small message stays one text frame");
        assert_eq!(flags(&recorded[1..]), vec![0x01, 0x01, 0x01, 0x00]);
        let body: Vec<u8> = recorded[1..]
            .iter()
            .flat_map(|message| match message {
                Message::Binary(bytes) => bytes[1..].to_vec(),
                _ => Vec::new(),
            })
            .collect();
        let decoded: Value = serde_json::from_slice(&body).expect("records reassemble into JSON");
        assert_eq!(decoded["requestId"], "2");
        assert_eq!(
            decoded["exit"]["value"]["data"].as_str().map(str::len),
            Some(200 * 1024)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn control_messages_leave_between_records_as_control_records() {
        let (sink, recorded) = recording_sink(Duration::from_secs(1));
        let (data_sender, data) = mpsc::channel(8);
        let (control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        data_sender.try_send(response("1", 300 * 1024)).expect("queue frame");
        let writer = tokio::spawn(run_writer(
            sink,
            OutboundFraming::PlainRecords,
            data,
            control,
            CancellationToken::new(),
        ));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        control_sender.try_send(ServerMessage::Pong).expect("queue pong");
        drop(data_sender);
        writer.await.expect("writer joins");

        let recorded = recorded.lock().expect("recorded frames");
        let flags = flags(&recorded);
        let control_at = flags
            .iter()
            .position(|flag| *flag == RECORD_FLAG_CONTROL)
            .expect("a control record");
        assert!(
            control_at > 0 && control_at < flags.len() - 1,
            "the Pong interleaves with the data records: {flags:?}"
        );
        let Message::Binary(control) = &recorded[control_at] else {
            panic!("a control record is binary");
        };
        assert_eq!(&control[1..], br#"{"_tag":"Pong"}"#);
    }

    #[tokio::test(start_paused = true)]
    async fn whole_framing_sends_control_after_the_message_in_progress() {
        let (sink, recorded) = recording_sink(Duration::from_secs(1));
        let (data_sender, data) = mpsc::channel(8);
        let (control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        data_sender.try_send(response("1", 1024)).expect("queue first");
        data_sender.try_send(response("2", 1024)).expect("queue second");
        let writer = tokio::spawn(run_writer(
            sink,
            OutboundFraming::Whole,
            data,
            control,
            CancellationToken::new(),
        ));
        tokio::time::sleep(Duration::from_millis(500)).await;
        control_sender.try_send(ServerMessage::Pong).expect("queue pong");
        drop(data_sender);
        writer.await.expect("writer joins");

        let recorded = recorded.lock().expect("recorded frames");
        let tags: Vec<String> = recorded
            .iter()
            .map(|message| {
                let Message::Text(text) = message else {
                    panic!("whole framing writes text frames");
                };
                let value: Value = serde_json::from_str(text).expect("frame JSON");
                format!(
                    "{}{}",
                    value["_tag"].as_str().unwrap_or_default(),
                    value["requestId"].as_str().unwrap_or_default()
                )
            })
            .collect();
        assert_eq!(tags, vec!["Exit1", "Pong", "Exit2"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_record_stalled_for_twenty_seconds_ends_the_session() {
        let (sink, _recorded) = recording_sink(Duration::from_secs(3_600));
        let (data_sender, data) = mpsc::channel(8);
        let (_control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        let shutdown = CancellationToken::new();
        data_sender.try_send(response("1", 200 * 1024)).expect("queue frame");
        let started = Instant::now();
        let writer = tokio::spawn(run_writer(
            sink,
            OutboundFraming::PlainRecords,
            data,
            control,
            shutdown.clone(),
        ));
        shutdown.cancelled().await;
        assert_eq!(Instant::now() - started, WRITE_PROGRESS_TIMEOUT);
        writer.await.expect("writer joins");
    }

    #[tokio::test(start_paused = true)]
    async fn a_trickling_sink_fails_the_whole_message_deadline() {
        // Each 64 KiB record takes 19 s, under the progress deadline, but a
        // 1 MiB message gets only 30 s + 64 s in total.
        let (sink, _recorded) = recording_sink(Duration::from_secs(19));
        let (data_sender, data) = mpsc::channel(8);
        let (_control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        let shutdown = CancellationToken::new();
        data_sender.try_send(response("1", 1024 * 1024)).expect("queue frame");
        let started = Instant::now();
        let writer = tokio::spawn(run_writer(
            sink,
            OutboundFraming::PlainRecords,
            data,
            control,
            shutdown.clone(),
        ));
        shutdown.cancelled().await;
        let elapsed = Instant::now() - started;
        assert!(
            elapsed > Duration::from_secs(90) && elapsed < Duration::from_secs(95),
            "the message deadline fires after about 94 s, not {elapsed:?}"
        );
        writer.await.expect("writer joins");
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_sink_that_keeps_the_floor_finishes_a_large_message() {
        let (recorded, shutdown) = write_all(
            OutboundFraming::PlainRecords,
            Duration::from_secs(1),
            vec![response("1", 8 * 1024 * 1024)],
        )
        .await;
        assert!(!shutdown.is_cancelled());
        assert_eq!(recorded.lock().expect("recorded frames").len(), 129);
    }

    #[tokio::test(start_paused = true)]
    async fn refilled_controls_allow_data_and_do_not_extend_the_message_deadline() {
        let recorded: Recorded = Arc::default();
        let sink_recorded = Arc::clone(&recorded);
        let sink = Box::pin(sink::unfold((), move |(), message: Message| {
            let recorded = Arc::clone(&sink_recorded);
            async move {
                let is_data = matches!(&message, Message::Binary(bytes)
                    if bytes.first().is_some_and(|flag| *flag != RECORD_FLAG_CONTROL));
                tokio::time::sleep(if is_data {
                    Duration::from_secs(6)
                } else {
                    Duration::from_millis(100)
                }).await;
                recorded.lock().expect("frames").push(message);
                Ok::<_, Infallible>(())
            }
        }));
        let (data_sender, data) = mpsc::channel(1);
        let (control_sender, control) = mpsc::channel(1);
        data_sender.try_send(response("1", 1024 * 1024)).expect("queue data");
        let producer = tokio::spawn(async move {
            while control_sender.send(ServerMessage::Pong).await.is_ok() {}
        });
        let shutdown = CancellationToken::new();
        let started = Instant::now();
        let writer = tokio::spawn(run_writer(
            sink, OutboundFraming::PlainRecords, data, control, shutdown.clone(),
        ));
        timeout(Duration::from_secs(95), shutdown.cancelled())
            .await.expect("message deadline still fires under continuous control refill");
        writer.await.expect("writer joins");
        producer.await.expect("producer sees closed lane");
        let frames = recorded.lock().expect("frames");
        let data_count = flags(&frames).iter().filter(|flag| **flag != RECORD_FLAG_CONTROL).count();
        assert!(data_count >= 2, "a refilling producer cannot starve the next data record");
        assert!(frames.iter().any(|frame| matches!(frame, Message::Binary(bytes)
            if bytes.first() == Some(&RECORD_FLAG_CONTROL))));
        assert!(started.elapsed() >= Duration::from_secs(94)
            && started.elapsed() <= Duration::from_secs(95),
            "aggregate deadline, not renewed control deadlines: {:?}", started.elapsed());
    }

    #[tokio::test(start_paused = true)]
    async fn control_writes_cannot_renew_the_data_progress_deadline() {
        let sink = Box::pin(sink::unfold((), |(), message: Message| async move {
            let control = matches!(&message, Message::Binary(bytes)
                if bytes.first() == Some(&RECORD_FLAG_CONTROL));
            tokio::time::sleep(Duration::from_secs(if control { 12 } else { 1 })).await;
            Ok::<_, Infallible>(())
        }));
        let (data_sender, data) = mpsc::channel(1);
        let (control_sender, control) = mpsc::channel(2);
        data_sender.try_send(response("1", 1024 * 1024)).expect("data");
        let shutdown = CancellationToken::new();
        let started = Instant::now();
        let writer = tokio::spawn(run_writer(
            sink, OutboundFraming::PlainRecords, data, control, shutdown.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(500)).await;
        control_sender.try_send(ServerMessage::Pong).expect("first control");
        control_sender.try_send(ServerMessage::Pong).expect("second control");
        timeout(Duration::from_secs(32), shutdown.cancelled()).await
            .expect("controls cannot extend the data-progress deadline");
        assert_eq!(started.elapsed(), Duration::from_secs(21),
            "one data second followed by at most twenty seconds without data progress");
        writer.await.expect("writer joins");
    }
}
```

Also append this admission regression to `session.rs::tests`:

```rust
    #[tokio::test]
    async fn oversized_controls_use_the_data_lane() {
        let (outbound, mut data, mut control) = unbudgeted_outbound(2);
        let message = ServerMessage::success(
            RequestId::try_from("1").expect("id"),
            Some(json!({ "data": "x".repeat(64 * 1024) })),
        );
        try_send_control_message(&outbound, message.clone()).expect("sync data admission");
        assert!(control.try_recv().is_err());
        assert!(data.try_recv().expect("sync fallback frame").is_control());
        timeout(Duration::from_secs(1),
            send_unbudgeted_server_message(&outbound, &CancellationToken::new(), message))
            .await.expect("bounded admission").expect("async data admission");
        assert!(control.try_recv().is_err());
        assert!(data.try_recv().expect("async fallback frame").is_control());
    }
```

- [ ] **Step 2: Confirm the red state**

Run: `cargo test -p bibcode-server --lib rpc::session::tests::a_ping_flood 2>&1 | tail -5`
Expected: compile error (`OutboundFraming` and `CONTROL_LANE_CAPACITY` not found; `run_session_split_budgeted` takes 6 arguments). This is the red state for a signature change. The behavior tests go green in Step 8.

- [ ] **Step 3: Create `apps/server/src/rpc/transport.rs`**

```rust
//! Outbound half of one RPC connection.
//!
//! One writer task owns the WebSocket sink. It writes each queued RPC
//! message as one text frame or as records in the E2EE record format
//! (`0x00` final, `0x01` continuation), lets a small control lane overtake
//! queued data, and bounds every write by progress: each record must be
//! accepted within [`WRITE_PROGRESS_TIMEOUT`], and each message within 30 s
//! plus its size at 16 KiB/s. When a deadline passes the writer ends the
//! session at once, so the socket closes instead of going silent.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::extract::ws::Message;
use futures_util::{Sink, SinkExt};
use tokio::{
    sync::mpsc,
    time::{Instant, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;

use super::{
    e2ee::{E2eeChannel, MAX_E2EE_CHUNK_BYTES, plaintext_records},
    message::ServerMessage,
    session::RpcOutboundFrame,
};

/// WebSocket subprotocol a client offers to receive large plain `/ws`
/// messages as records.
pub(crate) const CHUNKED_RPC_SUBPROTOCOL: &str = "bibcode.rpc.chunked.v1";
/// A stand-alone control message sent between the records of another message.
pub(crate) const RECORD_FLAG_CONTROL: u8 = 0x02;
/// Plain messages up to this size stay one text frame on a chunked socket.
pub(crate) const PLAIN_WHOLE_MESSAGE_MAX_BYTES: usize = 64 * 1024;
/// Every record must be accepted by the socket within this time.
pub(crate) const WRITE_PROGRESS_TIMEOUT: Duration = Duration::from_secs(20);
const WRITE_BASE_ALLOWANCE: Duration = Duration::from_secs(30);
const WRITE_FLOOR_BYTES_PER_SECOND: u64 = 16 * 1024;
/// One control message per in-flight request (64) plus headroom for Pongs.
pub(crate) const CONTROL_LANE_CAPACITY: usize = 80;
/// How long a normal shutdown may spend sending the close frame.
const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// How queued messages leave the socket.
#[derive(Clone)]
pub(crate) enum OutboundFraming {
    /// Plain `/ws` without the subprotocol: one text frame per message.
    Whole,
    /// Plain `/ws` with [`CHUNKED_RPC_SUBPROTOCOL`]: messages over 64 KiB leave
    /// as binary records, and control messages interleave as `0x02` records.
    PlainRecords,
    /// `/ws-e2ee`: every message leaves as encrypted records; `interleave` is
    /// true when the client and server negotiated control interleaving.
    Encrypted {
        channel: Arc<Mutex<E2eeChannel>>,
        interleave: bool,
    },
}

impl OutboundFraming {
    fn splits(&self, bytes: usize) -> bool {
        match self {
            Self::Whole => false,
            Self::PlainRecords => bytes > PLAIN_WHOLE_MESSAGE_MAX_BYTES,
            Self::Encrypted { .. } => true,
        }
    }

    fn interleaves(&self) -> bool {
        match self {
            Self::Whole => false,
            Self::PlainRecords => true,
            Self::Encrypted { interleave, .. } => *interleave,
        }
    }

    fn record(&self, flag: u8, chunk: &[u8]) -> Result<Message, TransportError> {
        match self {
            Self::Whole | Self::PlainRecords => {
                let mut record = Vec::with_capacity(1 + chunk.len());
                record.push(flag);
                record.extend_from_slice(chunk);
                Ok(Message::Binary(record.into()))
            }
            Self::Encrypted { channel, .. } => channel
                .lock()
                .expect("E2EE channel lock")
                .encrypt_record(flag, chunk)
                .map(|frame| Message::Binary(frame.into()))
                .map_err(|_| TransportError::Encrypt),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransportError {
    /// A write did not finish before its deadline.
    Stalled,
    /// The socket rejected a write.
    Closed,
    /// A message could not be encoded or split.
    Encode,
    /// A record could not be encrypted.
    Encrypt,
}

/// The whole-message deadline: 30 s plus the message size at 16 KiB/s.
pub(crate) fn message_deadline(started: Instant, bytes: usize) -> Instant {
    let size_millis =
        u64::try_from(bytes).unwrap_or(u64::MAX).saturating_mul(1_000) / WRITE_FLOOR_BYTES_PER_SECOND;
    started + WRITE_BASE_ALLOWANCE + Duration::from_millis(size_millis)
}

enum WriterStep {
    Control(ServerMessage),
    Data(RpcOutboundFrame),
}

/// Owns the sink until the session ends. Returns after a normal shutdown (the
/// queue closed or the session was cancelled), which sends a close frame, or
/// after a failed write, which cancels `shutdown` so the whole session ends
/// and the socket closes without waiting on the stuck sink.
pub(crate) async fn run_writer<S>(
    mut sink: S,
    framing: OutboundFraming,
    mut data: mpsc::Receiver<RpcOutboundFrame>,
    mut control: mpsc::Receiver<ServerMessage>,
    shutdown: CancellationToken,
) where
    S: Sink<Message> + Unpin,
{
    let result: Result<(), TransportError> = async {
        loop {
            // Snapshot once: refills never extend this turn. Give queued data
            // a turn after the snapshot even while producers keep sending.
            tokio::select! {
                () = shutdown.cancelled() => return Ok(()),
                result = write_queued_control(
                    &mut sink, &framing, &mut control,
                    Instant::now() + WRITE_PROGRESS_TIMEOUT, false,
                ) => result?,
            }
            let step = tokio::select! {
                biased;
                () = shutdown.cancelled() => return Ok(()),
                frame = data.recv() => match frame {
                    Some(frame) => WriterStep::Data(frame),
                    None => return Ok(()),
                },
                Some(message) = control.recv() => WriterStep::Control(message),
            };
            let write = async {
                match step {
                    WriterStep::Control(message) => write_control(
                        &mut sink, &framing, message,
                        Instant::now() + WRITE_PROGRESS_TIMEOUT, false,
                    ).await,
                    WriterStep::Data(frame) => {
                        let is_data = !frame.is_control();
                        let frame = frame.into_wire().map_err(|_| TransportError::Encode)?;
                        // Hold the byte permit until all records leave or this
                        // future is cancelled; control sends never release it.
                        let (message, _budget) = frame.into_parts();
                        write_message(&mut sink, &framing, message, is_data, Some(&mut control)).await
                    }
                }
            };
            tokio::select! {
                () = shutdown.cancelled() => return Ok(()),
                result = write => result?,
            }
        }
    }.await;
    match result {
        Ok(()) => {
            let _ = timeout(GRACEFUL_CLOSE_TIMEOUT, sink.close()).await;
        }
        Err(error) => {
            tracing::info!(?error, "RPC writer gave up; ending the session");
            shutdown.cancel();
        }
    }
}

/// Writes one message. A whole frame's progress is invisible through the
/// sink, so a whole frame gets the whole-message deadline; each record gets
/// the progress deadline, capped by the message deadline. With `control`,
/// queued control messages go out as `0x02` records between records.
async fn write_message<S>(
    sink: &mut S,
    framing: &OutboundFraming,
    message: Message,
    is_data: bool,
    mut control: Option<&mut mpsc::Receiver<ServerMessage>>,
) -> Result<(), TransportError>
where
    S: Sink<Message> + Unpin,
{
    let length = match &message {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) => bytes.len(),
        Message::Ping(_) | Message::Pong(_) | Message::Close(_) => return Ok(()),
    };
    let deadline = message_deadline(Instant::now(), length);
    if !framing.splits(length) {
        let deadline = if is_data { deadline } else {
            deadline.min(Instant::now() + WRITE_PROGRESS_TIMEOUT)
        };
        return send_before(sink, message, deadline).await;
    }
    let payload: &[u8] = match &message {
        Message::Text(text) => text.as_bytes(),
        Message::Binary(bytes) => bytes,
        Message::Ping(_) | Message::Pong(_) | Message::Close(_) => return Ok(()),
    };
    let records = plaintext_records(payload).map_err(|_| TransportError::Encode)?;
    let mut data_deadline = Instant::now() + WRITE_PROGRESS_TIMEOUT;
    for (index, (flag, chunk)) in records.enumerate() {
        if index > 0
            && framing.interleaves()
            && let Some(control) = control.as_deref_mut()
        {
            // Control traffic uses the enclosing deadlines; it cannot renew
            // either the message allowance or the time since the last data.
            write_queued_control(
                sink, framing, control, deadline.min(data_deadline), true,
            ).await?;
        }
        let record = framing.record(flag, chunk)?;
        send_before(sink, record, deadline.min(data_deadline)).await?;
        if is_data {
            data_deadline = Instant::now() + WRITE_PROGRESS_TIMEOUT;
        }
    }
    Ok(())
}

/// Drains at most the records queued at entry, then gives data a turn.
async fn write_queued_control<S>(
    sink: &mut S,
    framing: &OutboundFraming,
    control: &mut mpsc::Receiver<ServerMessage>,
    deadline: Instant,
    interleaved: bool,
) -> Result<(), TransportError>
where
    S: Sink<Message> + Unpin,
{
    let queued_at_start = control.len();
    for _ in 0..queued_at_start {
        let Ok(message) = control.try_recv() else { break };
        write_control(sink, framing, message, deadline, interleaved).await?;
    }
    Ok(())
}

/// Controls are admitted only if their encoded payload fits one record.
/// This defensive check protects the bounded lane if a caller bypasses admission.
async fn write_control<S>(
    sink: &mut S,
    framing: &OutboundFraming,
    message: ServerMessage,
    deadline: Instant,
    interleaved: bool,
) -> Result<(), TransportError>
where
    S: Sink<Message> + Unpin,
{
    let text = serde_json::to_string(&message).map_err(|_| TransportError::Encode)?;
    if text.len() > MAX_E2EE_CHUNK_BYTES {
        return Err(TransportError::Encode);
    }
    let frame = if interleaved {
        framing.record(RECORD_FLAG_CONTROL, text.as_bytes())?
    } else if matches!(framing, OutboundFraming::Encrypted { .. }) {
        framing.record(0x00, text.as_bytes())?
    } else {
        Message::Text(text.into())
    };
    send_before(sink, frame, deadline.min(Instant::now() + WRITE_PROGRESS_TIMEOUT)).await
}

async fn send_before<S>(sink: &mut S, message: Message, deadline: Instant) -> Result<(), TransportError>
where
    S: Sink<Message> + Unpin,
{
    if Instant::now() >= deadline { return Err(TransportError::Stalled); }
    // `send` feeds and flushes one frame, so a control record never waits in
    // the sink's write buffer behind data.
    match timeout_at(deadline, sink.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(TransportError::Closed),
        Err(_) => Err(TransportError::Stalled),
    }
}

// The failing `mod tests` from Step 1 remains below this implementation.
```

- [ ] **Step 4: Register the module and expose the E2EE helpers**

1. `apps/server/src/rpc/mod.rs`: keep the Step 1 declaration `mod transport;` immediately after `mod session;`, exactly once.

2. `apps/server/src/rpc/e2ee.rs`:
   - `struct PlaintextRecords<'a>` becomes `pub(super) struct PlaintextRecords<'a>`.
   - `fn plaintext_records(` becomes `pub(super) fn plaintext_records(`.
   - Keep `MAX_E2EE_CHUNK_BYTES` at its existing `pub(crate)` visibility; it is the shared one-record payload cap, 65,518 bytes after Noise overhead.
   - In `impl E2eeChannel`, `fn encrypt_record(` becomes `pub(super) fn encrypt_record(`.

- [ ] **Step 5: Rewire `session.rs`**

Apply these edits to `apps/server/src/rpc/session.rs`:

1. Imports. Replace `use futures_util::{FutureExt, Sink, SinkExt, Stream, StreamExt};` with `use futures_util::{FutureExt, Sink, Stream, StreamExt};` and replace the `use super::{ … };` block with:

```rust
use super::{
    byte_budget::{RpcOutboundBudget, RpcOutboundBytePermit},
    message::{ClientMessage, RequestId, RpcRequest, ServerMessage},
    methods::{ACTIVE_RPC_METHODS, MethodMode},
    transport::{self, CHUNKED_RPC_SUBPROTOCOL, CONTROL_LANE_CAPACITY, OutboundFraming},
};
```

   If the test module used `SinkExt` through `use super::*`, add `use futures_util::SinkExt;` inside `mod tests` instead.

2. Keep control classification independent of its queue and wire framing. Add `Control(Message),` to `RpcOutboundPayload` for controls exceeding one record. They retain ordinary data-queue budgeting but never count as progress. Replace `into_wire` and `into_parts`, and add `is_control` inside `impl RpcOutboundFrame` (`into_control` is introduced with its first test use in Task 10):

```rust
    pub(super) fn into_wire(self) -> Result<Self, serde_json::Error> {
        let payload = match self.payload {
            RpcOutboundPayload::Plain(message) => RpcOutboundPayload::Encoded(
                Message::Text(serde_json::to_string(&message)?.into()),
            ),
            payload @ (RpcOutboundPayload::Encoded(_) | RpcOutboundPayload::Control(_)) => payload,
        };
        Ok(Self { payload, _budget: self._budget })
    }

    pub(crate) fn into_parts(self) -> (Message, Option<RpcOutboundBytePermit>) {
        let (RpcOutboundPayload::Encoded(message) | RpcOutboundPayload::Control(message)) = self.payload else {
            unreachable!("RPC writer encodes plain responses before the transport sink")
        };
        (message, self._budget)
    }

    pub(super) fn is_control(&self) -> bool {
        matches!(self.payload, RpcOutboundPayload::Control(_))
    }

```

Add the test constructor after these methods:

```rust
    #[cfg(test)]
    pub(super) fn plain(message: ServerMessage) -> Self {
        Self {
            payload: RpcOutboundPayload::Plain(message),
            _budget: None,
        }
    }
```

3. Replace the `struct RpcOutboundQueue` definition with:

```rust
#[derive(Clone)]
struct RpcOutboundQueue {
    sender: mpsc::Sender<RpcOutboundFrame>,
    /// Pong, interrupt exits, admission-failure terminals and client protocol
    /// errors. The writer drains it before each message and between records.
    control: mpsc::Sender<ServerMessage>,
    budget: Option<RpcOutboundBudget>,
}
```

4. Replace everything from `pub(crate) async fn run_session(` down to the end of `pub(crate) async fn run_session_split<W, R>(…) { … }`. That covers `run_session`, `struct PlainRpcSink`, its impls, and `run_session_split`. Replace it with:

```rust
pub(crate) async fn run_session(
    socket: WebSocket,
    registry: RpcRegistry,
    context: RpcSessionContext,
    session_shutdown: CancellationToken,
) {
    let framing = if socket
        .protocol()
        .is_some_and(|protocol| protocol.as_bytes() == CHUNKED_RPC_SUBPROTOCOL.as_bytes())
    {
        OutboundFraming::PlainRecords
    } else {
        OutboundFraming::Whole
    };
    let (socket_writer, socket_reader) = socket.split();
    let socket_reader = socket_reader.map(|frame| frame.map(RpcInboundFrame::plain));
    run_session_split_budgeted(
        socket_writer,
        framing,
        socket_reader,
        registry,
        context,
        session_shutdown,
        None,
    )
    .await;
}
```

5. Replace the signature and prologue of `run_session_split_budgeted`, through the end of the `let mut writer = tokio::spawn(…);` statement that Task 4 wrote, with:

```rust
pub(crate) async fn run_session_split_budgeted<W, R>(
    socket_writer: W,
    framing: OutboundFraming,
    socket_reader: R,
    registry: RpcRegistry,
    context: RpcSessionContext,
    session_shutdown: CancellationToken,
    outbound_budget: Option<RpcOutboundBudget>,
) where
    W: Sink<Message> + Unpin + Send + 'static,
    R: Stream<Item = Result<RpcInboundFrame, axum::Error>> + Send,
{
    let context = context.with_connection(session_shutdown.clone());
    let _connection_guard = session_shutdown.clone().drop_guard();
    // Boxed so the read half can be dropped as soon as the loop ends.
    let mut socket_reader = Box::pin(socket_reader);
    let (outbound_sender, outbound_receiver) =
        mpsc::channel::<RpcOutboundFrame>(OUTBOUND_CAPACITY);
    let (control_sender, control_receiver) =
        mpsc::channel::<ServerMessage>(CONTROL_LANE_CAPACITY);
    let outbound = RpcOutboundQueue {
        sender: outbound_sender,
        control: control_sender,
        budget: outbound_budget,
    };
    let mut writer = tokio::spawn(transport::run_writer(
        socket_writer,
        framing,
        outbound_receiver,
        control_receiver,
        session_shutdown.clone(),
    ));
```

   Keep Task 4's `drop(socket_reader);` after the loop block.

6. In the read loop's decode-error branch, replace `send_server_message(` with `send_unbudgeted_server_message(` in the call that sends `client_protocol_error(error.to_string())`. It keeps the `.await.is_err()` → `break` handling.

7. In `process_client_message`, replace the `ClientMessage::Ping => { … }` arm with:

```rust
        ClientMessage::Ping => {
            // A full lane drops this Pong; the client's liveness counts any
            // inbound data, and a Ping must never end the read loop.
            let _ = dispatch.outbound.control.try_send(ServerMessage::Pong);
            Ok(())
        }
```

In the existing `ClientMessage::Interrupt` arm (`session.rs:851`), keep cancellation of a known request. Replace the unknown-request reply with:

```rust
            send_unbudgeted_server_message(
                dispatch.outbound,
                dispatch.shutdown,
                ServerMessage::interrupt(request_id),
            ).await
```

This is control traffic; an unusually long ID still takes the control-class fallback below if it exceeds one record.

8. Replace the body and doc comment of `try_send_control_message` with:

```rust
/// Delivers an interrupt through the control lane without byte budgeting and
/// without waiting. Oversized controls use data framing and budgeting,
/// but remain control-class for all progress accounting.
fn try_send_control_message(outbound: &RpcOutboundQueue, message: ServerMessage) -> Result<(), ()> {
    let encoded = serde_json::to_string(&message).map_err(|_| ())?;
    if encoded.len() <= super::e2ee::MAX_E2EE_CHUNK_BYTES {
        return outbound.control.try_send(message).map_err(|_| ());
    }
    let permit = outbound.budget.as_ref()
        .map(|budget| budget.try_acquire(encoded.len()))
        .transpose()?;
    outbound.sender.try_send(RpcOutboundFrame {
        payload: RpcOutboundPayload::Control(Message::Text(encoded.into())),
        _budget: permit,
    }).map_err(|_| ())
}
```

9. Replace the body and doc comment of `send_unbudgeted_server_message` with:

```rust
/// Sends a bounded terminal or protocol error through the control lane,
/// bypassing the byte budget but waiting for lane capacity under the shared
/// deadline. Used when the budgeted path already failed, so the client still
/// observes a terminal.
async fn send_unbudgeted_server_message(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    message: ServerMessage,
) -> Result<(), ()> {
    let deadline = Instant::now() + OUTBOUND_SEND_TIMEOUT;
    let encoded = serde_json::to_string(&message).map_err(|_| ())?;
    if encoded.len() > super::e2ee::MAX_E2EE_CHUNK_BYTES {
        drop(message);
        let budget = outbound.acquire_budget(session_shutdown, encoded.len(), deadline).await?;
        let frame = RpcOutboundFrame {
            payload: RpcOutboundPayload::Control(Message::Text(encoded.into())),
            _budget: budget,
        };
        return tokio::select! {
            () = session_shutdown.cancelled() => Err(()),
            result = timeout_at(deadline, outbound.sender.send(frame)) => {
                match result { Ok(Ok(())) => Ok(()), Ok(Err(_)) | Err(_) => Err(()) }
            }
        };
    }
    tokio::select! {
        () = session_shutdown.cancelled() => Err(()),
        result = timeout_at(deadline, outbound.control.send(message)) => {
            match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) | Err(_) => Err(()),
            }
        }
    }
}
```

10. Keep `SOCKET_WRITE_TIMEOUT`: `e2ee.rs` still imports it for the handshake. In `byte_budget.rs`, remove `#[cfg(test)]` from both `RpcOutboundBudget::try_acquire` and its private `try_acquire_both` helper (currently at lines 110–116); the oversized-control data fallback above now calls it in production. Keep test-only allowances on process-budget fixture helpers.

- [ ] **Step 6: Update the existing session tests**

In `session.rs` `mod tests`:

1. Make `BlockedSocketSink` a `Sink<Message>`: change `pending: Option<RpcOutboundFrame>` to `pending: Option<Message>`, `impl Sink<RpcOutboundFrame> for BlockedSocketSink` to `impl Sink<Message> for BlockedSocketSink`, and `fn start_send(mut self: Pin<&mut Self>, item: RpcOutboundFrame)` to `item: Message`.

2. Replace `fn unbudgeted_outbound` with:

```rust
    fn unbudgeted_outbound(
        capacity: usize,
    ) -> (
        RpcOutboundQueue,
        mpsc::Receiver<RpcOutboundFrame>,
        mpsc::Receiver<ServerMessage>,
    ) {
        let (sender, receiver) = mpsc::channel(capacity);
        let (control, control_receiver) = mpsc::channel(CONTROL_LANE_CAPACITY);
        (
            RpcOutboundQueue {
                sender,
                control,
                budget: None,
            },
            receiver,
            control_receiver,
        )
    }
```

   Update both callers to `let (outbound, _receiver, _control) = unbudgeted_outbound(1);`.

3. Every `run_session_split_budgeted(` call in the tests gains `OutboundFraming::Whole,` as its second argument. That includes Task 4's test and the tests `inbound_guard_is_released_after_dispatch_not_handler_completion`, `session_teardown_is_bounded_when_a_handler_ignores_cancellation`, `slow_socket_cannot_hide_more_than_one_large_response_in_the_session_queue`, `slow_sockets_share_one_process_outbound_plaintext_budget` and `response_larger_than_the_connection_budget_fails_the_session_closed`.

4. In Task 4's test, replace `tokio::time::advance(SOCKET_WRITE_TIMEOUT).await;` with `tokio::time::advance(Duration::from_secs(31)).await;`. A stalled whole frame of about 1 KiB now fails at its message deadline (30 s + size at 16 KiB/s).

5. `stream_admission_expiry_delivers_a_terminal_failure`: the terminal now arrives on the control lane. Replace the queue setup and the assertion block with:

```rust
        let (sender, _receiver) = mpsc::channel(8);
        let (control, mut control_receiver) = mpsc::channel(CONTROL_LANE_CAPACITY);
        let outbound = RpcOutboundQueue {
            sender,
            control,
            budget: Some(RpcOutboundBudget::new(process.clone(), 1024)),
        };
```

   and, after `tokio::time::advance(Duration::from_secs(6)).await;`:

```rust
        let terminal = timeout(Duration::from_secs(1), control_receiver.recv())
            .await
            .expect("a terminal reaches the control lane")
            .expect("terminal message");
        let text = serde_json::to_string(&terminal).expect("terminal JSON");
        assert!(
            text.contains("RpcOutboundAdmissionError"),
            "admission expiry must surface as an explicit stream failure: {text}"
        );
        let decoded: Value = serde_json::from_str(&text).expect("terminal JSON");
        assert_eq!(decoded["requestId"], "1");
```

6. `latest_stream_cancellation_delivers_an_interrupt_past_queued_budget_waiters`: replace the queue construction with the same `sender`/`control` pair (`budget: Some(RpcOutboundBudget::new(process.clone(), 64))`). Replace the frame assertion with:

```rust
        let interrupt = timeout(Duration::from_millis(500), control_receiver.recv())
            .await
            .expect("the interrupt is delivered despite queued budget waiters")
            .expect("interrupt message");
        let text = serde_json::to_string(&interrupt).expect("interrupt JSON");
        assert!(
            text.contains("Interrupt"),
            "cancellation must surface as an interrupt exit: {text}"
        );
```

7. `byte_and_queue_admission_share_one_five_second_deadline`: add `let (control, _control_receiver) = mpsc::channel(CONTROL_LANE_CAPACITY);` and `control,` to the `RpcOutboundQueue` literal.

- [ ] **Step 7: Rewire `e2ee.rs` onto the shared writer**

1. Imports:
   - `use tokio_util::sync::{CancellationToken, PollSender};` becomes `use tokio_util::sync::CancellationToken;`.
   - Remove `Sink` from `use futures_util::{Sink, SinkExt, StreamExt, stream};`, keeping `SinkExt, StreamExt, stream`.
   - In `use super::{ … session::{ … } }`, remove `RpcOutboundFrame`. Add `transport::OutboundFraming,` inside the `use super::{ … }` list.

2. In `run_established_e2ee`:
   - Delete the `let (outbound_tx, mut outbound_rx) = …;` line.
   - Delete the whole `let outbound_shutdown = …; let outbound_channel = …; let outbound_pump = tokio::spawn(async move { … });` block.
   - Replace the tail (from `let writer_sink = PollSender::new(outbound_tx);` through `reap_pump(inbound_pump).await;`) with:

```rust
    let reader_stream = stream::unfold(inbound_rx, |mut receiver| async {
        receiver.recv().await.map(|item| (item, receiver))
    });
    // The session's writer task owns the socket sink and encrypts one record
    // at a time, so control records can overtake a large message.
    run_session_split_budgeted(
        ws_writer,
        OutboundFraming::Encrypted {
            channel: Arc::clone(&channel),
            interleave: false,
        },
        reader_stream,
        registry,
        context,
        session_shutdown.clone(),
        Some(RpcOutboundBudget::new(
            E2EE_RESOURCE_BUDGET.global_outbound(),
            E2EE_OUTBOUND_BUFFER_BUDGET_BYTES_PER_CONNECTION,
        )),
    )
    .await;

    session_shutdown.cancel();
    if let Some(expiration_guard) = expiration_guard {
        let _ = expiration_guard.await;
    }
    reap_pump(inbound_pump).await;
```

3. Delete only `async fn send_established_encrypted_message` and its four outbound tests below. Keep `const E2EE_LOGICAL_WRITE_BYTES_PER_SECOND: usize = 64 * 1024;` (`e2ee.rs:51`): `inbound_assembly_deadline` still uses it at line 1478, and `shared_fixture_matches_server_transport_constants` compares it with `logical_write_bytes_per_second` at lines 1587–1590. The inbound 64 KiB/s floor and five-second base remain unchanged; the new outbound 16 KiB/s floor is separate. Replace the stale outbound-mirroring comment above `inbound_assembly_deadline` with:

   ```rust
   /// Absolute inbound assembly bound: the five-second base plus one second
   /// per 64 KiB received. This inbound resource limit is independent of the
   /// outbound writer's 30-second base and 16 KiB/s floor.
   ```

   Run `cargo test -p bibcode-server --lib rpc::e2ee::tests::shared_fixture_matches_server_transport_constants` and `cargo test -p bibcode-server --lib rpc::e2ee::tests::inbound_` in Step 8. Expected: PASS, including the unchanged shared fixture assertion; do not regenerate the inbound fixture with outbound values. Delete these four tests:
   - `outbound_logical_message_accepts_progress_across_record_deadlines`
   - `outbound_logical_message_rejects_a_stalled_record`
   - `outbound_logical_message_enforces_the_size_derived_total_deadline`
   - `outbound_size_allowance_lets_a_large_message_finish_on_a_slow_sink`

   In their place in `mod tests`, add:

```rust
    fn encrypted_response(bytes: usize) -> crate::rpc::session::RpcOutboundFrame {
        crate::rpc::session::RpcOutboundFrame::plain(crate::rpc::ServerMessage::success(
            crate::rpc::RequestId::try_from("1").expect("request id"),
            Some(json!({ "data": "x".repeat(bytes) })),
        ))
    }

    /// Runs the shared writer over an encrypted channel with a sink that takes
    /// `delay` per record, and reports the records, whether the session was
    /// cancelled, and the elapsed time.
    async fn run_encrypted_writer(
        delay: Duration,
        bytes: usize,
    ) -> (SnowInitiator, Vec<Message>, bool, Duration) {
        let (initiator, responder) = establish().await;
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let sink_recorded = Arc::clone(&recorded);
        let sink = Box::pin(futures_util::sink::unfold((), move |(), message: Message| {
            let recorded = Arc::clone(&sink_recorded);
            async move {
                tokio::time::sleep(delay).await;
                recorded.lock().expect("recorded frames").push(message);
                Ok::<_, std::convert::Infallible>(())
            }
        }));
        let (data_sender, data) = tokio::sync::mpsc::channel(4);
        let (_control_sender, control) =
            tokio::sync::mpsc::channel(super::super::transport::CONTROL_LANE_CAPACITY);
        let shutdown = CancellationToken::new();
        data_sender
            .try_send(encrypted_response(bytes))
            .expect("queue frame");
        drop(data_sender);
        let started = Instant::now();
        super::super::transport::run_writer(
            sink,
            OutboundFraming::Encrypted {
                channel: Arc::new(Mutex::new(responder)),
                interleave: false,
            },
            data,
            control,
            shutdown.clone(),
        )
        .await;
        let recorded = recorded.lock().expect("recorded frames").clone();
        (initiator, recorded, shutdown.is_cancelled(), Instant::now() - started)
    }

    #[tokio::test(start_paused = true)]
    async fn encrypted_records_accept_progress_across_record_deadlines() {
        let (_initiator, recorded, cancelled, elapsed) =
            run_encrypted_writer(Duration::from_secs(1), MAX_E2EE_CHUNK_BYTES * 5).await;
        assert!(!cancelled);
        assert_eq!(recorded.len(), 6);
        assert_eq!(elapsed, Duration::from_secs(6));
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_encrypted_record_ends_the_session_after_twenty_seconds() {
        let (_initiator, _recorded, cancelled, elapsed) =
            run_encrypted_writer(Duration::from_secs(3_600), 1024).await;
        assert!(cancelled);
        assert_eq!(elapsed, Duration::from_secs(20));
    }

    #[tokio::test(start_paused = true)]
    async fn a_trickling_encrypted_sink_fails_the_message_deadline() {
        // Three records at 19 s each; the message deadline is 30 s + ~8.5 s.
        let (_initiator, _recorded, cancelled, elapsed) =
            run_encrypted_writer(Duration::from_secs(19), 140_000).await;
        assert!(cancelled);
        assert!(
            elapsed > Duration::from_secs(38) && elapsed < Duration::from_secs(39),
            "the message deadline fires at about 38.5 s, not {elapsed:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_encrypted_sink_that_keeps_the_floor_finishes_eight_mebibytes() {
        let (_initiator, recorded, cancelled, _elapsed) =
            run_encrypted_writer(Duration::from_secs(1), 8 * 1024 * 1024).await;
        assert!(!cancelled);
        assert_eq!(recorded.len(), 129);
    }
```

   `run_encrypted_writer` returns the initiator so Task 6 can decrypt records. It is unused here, which is why each binding is `_initiator`.

- [ ] **Step 8: Run the Rust suites**

Run, in order:
- `cargo test -p bibcode-server --lib rpc::transport`
- `cargo test -p bibcode-server --lib rpc::session`
- `cargo test -p bibcode-server --lib rpc::e2ee`
- `cargo test -p bibcode-server --test rpc_wire --test e2ee_ws`

Expected: each ends `test result: ok.`. The two new session tests pass; the transport tests pass. `e2ee_ws` exercises the rewired E2EE writer end to end.

- [ ] **Step 9: Lints**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: no output from fmt; clippy finishes with no warnings. Fix any `unused` import the compiler reports in the edited files.

- [ ] **Step 10: Update the living docs**

1. `docs/architecture/rpc-and-orchestration.md`, section "Wire protocol": after the paragraph ending "stream flow before invoking handlers.", insert:

```markdown
Each connection has one writer task that owns the socket sink. It drains a
bounded control lane before every queued message: RPC `Pong`, interrupt exits,
`RpcOutboundAdmissionError` terminals, and client protocol errors (80 entries,
one per in-flight request plus room for Pongs). A `Ping` never ends the read
loop; when the lane is full its `Pong` is dropped, because the client's
liveness counts any inbound data. Terminal output and other data never use the
lane. Every write is bounded by progress: a record must be accepted within 20
seconds, a whole frame within its message deadline, and every message within
30 seconds plus its size at 16 KiB/s. When a deadline passes, the writer ends
the session at once, so the socket closes instead of staying open and silent.
```

2. `docs/architecture/remote.md`: replace the sentence group that starts "Unary results, stream chunks, handler-error terminals, RPC ping/pong control messages, protocol errors, and defects use the same admission path." It ends with "one small control message per request." Replace it with:

```markdown
Unary results, stream chunks, handler-error terminals, and defects use the same
admission path. RPC `Pong`, interrupt exits, `RpcOutboundAdmissionError`
terminals, and client protocol errors bypass byte admission through the
connection writer's bounded control lane, which holds one small control message
per in-flight request plus room for Pongs; a full lane drops a `Pong` instead
of ending the read loop.
```

   Then replace "Each Noise record then receives a fresh five-second WebSocket-sink progress deadline, while the whole logical message is bounded by five seconds plus one second per 64 KiB of plaintext. Records remain serialized, and the pump retains its one-second join bound." with:

```markdown
The connection's one writer task encrypts and writes one record at a time: each
Noise record must be accepted by the socket within 20 seconds, and the whole
logical message within 30 seconds plus its size at 16 KiB/s. When either
deadline passes, the writer ends the session at once.
```

   Keep the line breaks of the surrounding text. Edit only these sentences.

3. `docs/architecture/overview.md`: replace "Outbound fit-first admission keeps a five-second reservation deadline, gives each record a fresh five-second sink deadline, and adds a size-derived aggregate deadline." with "Outbound fit-first admission keeps a five-second reservation deadline; the connection writer then gives each record 20 seconds to be accepted and each message 30 seconds plus its size at 16 KiB/s, and ends the session when either passes."

- [ ] **Step 11: Checkpoint (no commit)**

Record `Task 5 <tree> rpc::transport/session/e2ee + rpc_wire + e2ee_ws` in the ledger.

---

### Task 6: Negotiate plain records and E2EE interleave on the server

**Files:**
- Modify: `apps/server/src/http.rs` (both plain upgrades)
- Modify: `apps/server/src/rpc/mod.rs` (re-export `CHUNKED_RPC_SUBPROTOCOL`)
- Modify: `apps/server/src/rpc/e2ee.rs` (`E2eeAuthMessage.features`, replies, interleave flag)
- Test: `apps/server/tests/rpc_wire.rs`, `apps/server/tests/e2ee_ws.rs`, `apps/server/src/rpc/e2ee.rs` (`mod tests`)
- Docs: `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/remote.md`, `docs/architecture/overview.md`

**Interfaces:**
- Consumes (Task 5): `CHUNKED_RPC_SUBPROTOCOL`, `E2EE_INTERLEAVE_FEATURE`, `OutboundFraming::Encrypted { interleave }`, `RECORD_FLAG_CONTROL`, `CONTROL_LANE_CAPACITY`, `run_writer`, and the test helpers `run_encrypted_writer`/`encrypted_response`.
- Produces:
  - `pub(crate) fn e2ee_authenticated_json(interleave: bool) -> Vec<u8>`
  - `pub(crate) fn e2ee_authenticated_with_credential_json(credential, environment_id, storage_instance_id, pairing_confirmation_required, interleave: bool) -> Vec<u8>`
  - `E2eeAuthMessage { r#type, pairing, bearer, features: Vec<String> }`

- [ ] **Step 1: Write the failing integration tests**

1. In `apps/server/tests/rpc_wire.rs`, extend the `tokio_tungstenite` import to `use tokio_tungstenite::{connect_async, tungstenite::{Message, client::IntoClientRequest, http::HeaderValue}};` and append:

```rust
async fn connect_plain(
    address: std::net::SocketAddr,
    chunked: bool,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Option<String>,
) {
    let mut request = format!("ws://{address}/ws")
        .into_client_request()
        .expect("WebSocket request");
    if chunked {
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static("bibcode.rpc.chunked.v1"),
        );
    }
    let (socket, response) = connect_async(request).await.expect("WebSocket connects");
    let selected = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    (socket, selected)
}

fn bytes_registry() -> RpcRegistry {
    let mut registry = RpcRegistry::empty();
    registry.register_unary("fixture.bytes", |request, _cancellation| async move {
        let bytes = request.payload["bytes"]
            .as_u64()
            .and_then(|bytes| usize::try_from(bytes).ok())
            .unwrap_or_default();
        Ok(json!({ "data": "x".repeat(bytes) }))
    });
    registry
}

#[tokio::test]
async fn chunked_subprotocol_splits_large_responses_into_records() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start_with_registry(test_config(&temp), bytes_registry())
        .await
        .expect("server starts");
    let (mut socket, selected) = connect_plain(handle.local_addr(), true).await;
    assert_eq!(selected.as_deref(), Some("bibcode.rpc.chunked.v1"));

    send_json(
        &mut socket,
        json!({ "_tag": "Request", "id": "1", "tag": "fixture.bytes", "payload": { "bytes": 1024 }, "headers": [] }),
    )
    .await;
    let small = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("small response")
        .expect("socket open")
        .expect("frame");
    assert!(matches!(small, Message::Text(_)), "small messages stay whole text frames");

    send_json(
        &mut socket,
        json!({ "_tag": "Request", "id": "2", "tag": "fixture.bytes", "payload": { "bytes": 200 * 1024 }, "headers": [] }),
    )
    .await;
    let mut flags = Vec::new();
    let mut body = Vec::new();
    loop {
        let frame = timeout(Duration::from_secs(2), socket.next())
            .await
            .expect("record")
            .expect("socket open")
            .expect("frame");
        let Message::Binary(record) = frame else {
            panic!("large messages arrive as binary records, got {frame:?}");
        };
        flags.push(record[0]);
        body.extend_from_slice(&record[1..]);
        if record[0] == 0x00 {
            break;
        }
    }
    assert!(flags.len() >= 4);
    assert!(flags[..flags.len() - 1].iter().all(|flag| *flag == 0x01));
    let response: Value = serde_json::from_slice(&body).expect("records reassemble");
    assert_eq!(response["requestId"], "2");
    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn clients_without_the_subprotocol_receive_whole_text_frames() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = ServerRuntime::start_with_registry(test_config(&temp), bytes_registry())
        .await
        .expect("server starts");
    let (mut socket, selected) = connect_plain(handle.local_addr(), false).await;
    assert_eq!(selected, None);
    send_json(
        &mut socket,
        json!({ "_tag": "Request", "id": "1", "tag": "fixture.bytes", "payload": { "bytes": 200 * 1024 }, "headers": [] }),
    )
    .await;
    let frame = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("response")
        .expect("socket open")
        .expect("frame");
    assert!(matches!(frame, Message::Text(text) if text.len() > 200 * 1024));
    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}
```

2. In `apps/server/tests/e2ee_ws.rs`, append:

```rust
#[tokio::test]
async fn interleave_v1_is_confirmed_only_when_the_client_lists_it() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let startup = handle.startup_access().expect("startup pairing");
    let credential = mint_e2ee_credential(&handle, temp.path(), &startup.credential).await;
    let host_key = read_host_public_key(temp.path());

    let (mut socket, mut transport) = noise_connect(handle.local_addr(), &host_key).await;
    send_encrypted(
        &mut socket,
        &mut transport,
        json!({ "type": "e2ee_auth", "bearer": credential, "features": ["interleave-v1"] })
            .to_string()
            .as_bytes(),
    )
    .await;
    let reply = recv_encrypted_json(&mut socket, &mut transport).await;
    assert_eq!(reply["type"], "e2ee_authenticated");
    assert_eq!(reply["features"], json!(["interleave-v1"]));
    assert_get_config(&mut socket, &mut transport).await;

    let (_socket, _transport, reply) =
        open_authenticated_bearer_socket(&handle, &host_key, &credential).await;
    assert_eq!(reply["type"], "e2ee_authenticated");
    assert!(reply.get("features").is_none(), "no features without the request: {reply}");
}
```

3. In `apps/server/src/rpc/e2ee.rs` `mod tests`, add:

```rust
    #[test]
    fn authenticated_replies_confirm_interleave_only_when_requested() {
        let plain: serde_json::Value =
            serde_json::from_slice(&e2ee_authenticated_json(false)).expect("plain reply");
        assert!(plain.get("features").is_none());
        let interleaved: serde_json::Value =
            serde_json::from_slice(&e2ee_authenticated_json(true)).expect("interleaved reply");
        assert_eq!(interleaved["features"], json!(["interleave-v1"]));
        let minted: serde_json::Value = serde_json::from_slice(
            &e2ee_authenticated_with_credential_json("credential", "environment", None, false, true),
        )
        .expect("minted reply");
        assert_eq!(minted["features"], json!(["interleave-v1"]));
    }

    #[tokio::test(start_paused = true)]
    async fn interleave_sends_control_records_between_encrypted_records() {
        let (mut initiator, responder) = establish().await;
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let sink_recorded = Arc::clone(&recorded);
        let sink = Box::pin(futures_util::sink::unfold((), move |(), message: Message| {
            let recorded = Arc::clone(&sink_recorded);
            async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                recorded.lock().expect("recorded frames").push(message);
                Ok::<_, std::convert::Infallible>(())
            }
        }));
        let (data_sender, data) = tokio::sync::mpsc::channel(4);
        let (control_sender, control) =
            tokio::sync::mpsc::channel(super::super::transport::CONTROL_LANE_CAPACITY);
        data_sender
            .try_send(encrypted_response(MAX_E2EE_CHUNK_BYTES * 4))
            .expect("queue frame");
        let writer = tokio::spawn(super::super::transport::run_writer(
            sink,
            OutboundFraming::Encrypted {
                channel: Arc::new(Mutex::new(responder)),
                interleave: true,
            },
            data,
            control,
            CancellationToken::new(),
        ));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        control_sender
            .try_send(crate::rpc::ServerMessage::Pong)
            .expect("queue pong");
        drop(data_sender);
        writer.await.expect("writer joins");

        let mut flags = Vec::new();
        let mut control_plaintext = Vec::new();
        for message in recorded.lock().expect("recorded frames").iter() {
            let Message::Binary(frame) = message else {
                panic!("encrypted records are binary");
            };
            let mut plaintext = vec![0_u8; MAX_E2EE_CIPHERTEXT_BYTES];
            let len = initiator
                .transport
                .read_message(frame, &mut plaintext)
                .expect("decrypt record");
            flags.push(plaintext[0]);
            if plaintext[0] == super::super::transport::RECORD_FLAG_CONTROL {
                control_plaintext = plaintext[1..len].to_vec();
            }
        }
        let control_at = flags
            .iter()
            .position(|flag| *flag == super::super::transport::RECORD_FLAG_CONTROL)
            .expect("a control record");
        assert!(control_at > 0 && control_at < flags.len() - 1, "{flags:?}");
        assert_eq!(control_plaintext, br#"{"_tag":"Pong"}"#);
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p bibcode-server --test rpc_wire chunked_subprotocol 2>&1 | tail -3`
Expected: FAIL. `selected` is `None`, because the upgrade never selects a protocol.

Run: `cargo test -p bibcode-server --lib rpc::e2ee::tests::authenticated_replies 2>&1 | tail -3`
Expected: compile error (`e2ee_authenticated_json` takes no arguments).

- [ ] **Step 3: Implement the negotiation**

0. `apps/server/src/rpc/transport.rs`: define the feature immediately before its first production use in this task (never in Task 5):

```rust
/// E2EE feature that lets control records interleave with a split message.
pub(crate) const E2EE_INTERLEAVE_FEATURE: &str = "interleave-v1";
```

1. `apps/server/src/rpc/mod.rs`: add `pub(crate) use transport::CHUNKED_RPC_SUBPROTOCOL;` after the `pub(crate) use e2ee::{…};` line.

2. `apps/server/src/http.rs`:
   - Add `CHUNKED_RPC_SUBPROTOCOL,` to the `rpc::{ … }` import list.
   - In **both** plain upgrades in `websocket`, insert `.protocols([CHUNKED_RPC_SUBPROTOCOL])` directly after `upgrade` and before `.max_frame_size(MAX_PLAIN_WEBSOCKET_FRAME_BYTES)`. For example:

```rust
        return upgrade
            .protocols([CHUNKED_RPC_SUBPROTOCOL])
            .max_frame_size(MAX_PLAIN_WEBSOCKET_FRAME_BYTES)
            .max_message_size(MAX_PLAIN_WEBSOCKET_MESSAGE_BYTES)
```

   `scripts/transport-caps-contract.test.ts` requires `.max_frame_size(…)` to be followed directly by `.max_message_size(…)`, so do not put anything between them.

3. `apps/server/src/rpc/e2ee.rs`:
   - Add `transport::E2EE_INTERLEAVE_FEATURE,` to the `use super::{ … }` list (next to `transport::OutboundFraming`).
   - Replace `struct E2eeAuthMessage` with:

```rust
#[derive(Debug, Deserialize)]
pub(crate) struct E2eeAuthMessage {
    pub r#type: String,
    #[serde(default)]
    pub pairing: Option<String>,
    #[serde(default)]
    pub bearer: Option<String>,
    /// Channel features the client supports; older clients send none.
    #[serde(default)]
    pub features: Vec<String>,
}
```

   - Replace `e2ee_authenticated_json` and `e2ee_authenticated_with_credential_json` with:

```rust
fn confirm_features(reply: &mut serde_json::Value, interleave: bool) {
    if interleave {
        reply
            .as_object_mut()
            .expect("static authenticated reply is an object")
            .insert("features".to_owned(), json!([E2EE_INTERLEAVE_FEATURE]));
    }
}

pub(crate) fn e2ee_authenticated_json(interleave: bool) -> Vec<u8> {
    let mut reply = json!({ "type": "e2ee_authenticated" });
    confirm_features(&mut reply, interleave);
    serde_json::to_vec(&reply).expect("static JSON")
}

pub(crate) fn e2ee_authenticated_with_credential_json(
    credential: &str,
    environment_id: &str,
    storage_instance_id: Option<&str>,
    pairing_confirmation_required: bool,
    interleave: bool,
) -> Vec<u8> {
    let mut reply = json!({
        "type": "e2ee_authenticated",
        "credential": credential,
        "environmentId": environment_id,
    });
    if let Some(storage_instance_id) = storage_instance_id {
        reply
            .as_object_mut()
            .expect("static authenticated reply is an object")
            .insert(
                "storageInstanceId".to_owned(),
                serde_json::Value::String(storage_instance_id.to_owned()),
            );
    }
    if pairing_confirmation_required {
        reply
            .as_object_mut()
            .expect("static authenticated reply is an object")
            .insert(
                "pairingConfirmationRequired".to_owned(),
                serde_json::Value::Bool(true),
            );
    }
    confirm_features(&mut reply, interleave);
    serde_json::to_vec(&reply).expect("static JSON")
}
```

   - In `enum EstablishOutcome`, add `interleave: bool,` to the `Accepted { … }` variant.
   - In `run_e2ee_session`, directly after the `if message.r#type != "e2ee_auth" { … }` check, add `let interleave = message.features.iter().any(|feature| feature == E2EE_INTERLEAVE_FEATURE);`.
   - Pass `interleave` as the last argument of `e2ee_authenticated_with_credential_json(…)`, and call `e2ee_authenticated_json(interleave)`.
   - Return `EstablishOutcome::Accepted { channel, admission: …, interleave }`.
   - Destructure `Ok(Ok(EstablishOutcome::Accepted { channel, admission, interleave }))`, and pass `interleave` to `run_established_e2ee(ws_writer, ws_reader, channel, admission, interleave, auth, registry, session_shutdown)`.
   - Add the parameter `interleave: bool,` after `admission: EstablishedE2eeAdmission,` in `run_established_e2ee`, and use `interleave` in `OutboundFraming::Encrypted { channel: Arc::clone(&channel), interleave }`.
   - Its eight parameters now cross Clippy’s threshold; add `#[allow(clippy::too_many_arguments, reason = "Explicit authenticated transport handoff")]` directly on `run_established_e2ee` in this task. This is not an unused-item suppression.
   - In the existing test `pairing_reply_omits_an_absent_storage_identity`, add the argument `false` to both `e2ee_authenticated_with_credential_json` calls.

   Run `rg -n 'e2ee_authenticated_json|e2ee_authenticated_with_credential_json' apps/server` and update every other caller the same way.

- [ ] **Step 4: Run the tests**

Run:
- `cargo test -p bibcode-server --lib rpc::e2ee`
- `cargo test -p bibcode-server --test rpc_wire --test e2ee_ws`
- `vp test run scripts/transport-caps-contract.test.ts`

Expected: all pass.

- [ ] **Step 5: Lints**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Update the living docs**

1. `docs/architecture/rpc-and-orchestration.md`: after the paragraph inserted in Task 5, insert:

```markdown
A plain `/ws` client may offer the WebSocket subprotocol
`bibcode.rpc.chunked.v1`. When the server selects it, every RPC message over 64
KiB leaves as binary frames, one record per frame, in the E2EE record format:
`0x00` for the final record, `0x01` for a continuation, and `0x02` for a
stand-alone control message sent between the records of another message, which
the client returns without touching the partial message. Smaller messages stay
whole text frames, requests are never split, and the limits are 64 MiB and
2,048 records per message. Without the echoed subprotocol the server keeps
today's whole text frames. E2EE sockets always use records; `0x02` control
records are used there only when the client lists `interleave-v1` in
`e2ee_auth` and the server confirms it.
```

2. `docs/architecture/remote.md`: replace "`e2ee_authenticated` acknowledgement. Invalid credentials receive" with "`e2ee_authenticated` acknowledgement. Either form may carry `"features":["interleave-v1"]`; the server then confirms the same list in `e2ee_authenticated` and may send stand-alone `0x02` control records between the records of a large message. Without the confirmation, control messages overtake queued data only between whole messages. Invalid credentials receive".

3. `docs/architecture/overview.md`: replace "Plain `/ws` caps individual frames at 16 MiB while retaining the 64 MiB reassembled-message cap." with "Plain `/ws` caps individual frames at 16 MiB while retaining the 64 MiB reassembled-message cap; a client that offers the `bibcode.rpc.chunked.v1` subprotocol receives messages over 64 KiB as binary records instead."

- [ ] **Step 7: Checkpoint (no commit)**

Record `Task 6 <tree> rpc::e2ee + rpc_wire + e2ee_ws + transport-caps-contract` in the ledger.

---

### Task 7: Client offers the subprotocol, reassembles records, and accepts `0x02`

**Files:**
- Create: `packages/client-runtime/src/rpc/chunkedSocket.ts`
- Test: `packages/client-runtime/src/rpc/chunkedSocket.test.ts`
- Modify: `packages/client-runtime/src/e2ee/frame.ts` (control flag, assembler option)
- Test: `packages/client-runtime/src/e2ee/frame.test.ts`
- Modify: `packages/client-runtime/src/e2ee/socket.ts` (features in `e2ee_auth`, assembler option)
- Test: `packages/client-runtime/src/e2ee/socket.test.ts`
- Modify: `packages/client-runtime/src/rpc/session.ts` (offer the protocol, `arraybuffer` always, wrap the plain socket)
- Test: `packages/client-runtime/src/rpc/session.test.ts`
- Modify: `packages/contracts/src/remotePairing.ts` (`features` fields)
- Test: `packages/contracts/src/remotePairing.test.ts`

**Interfaces:**
- Consumes (Tasks 5–6 on the wire): records `0x00/0x01/0x02`, `bibcode.rpc.chunked.v1`, and `interleave-v1` confirmed in `e2ee_authenticated.features`.
- Produces:
  - `export const E2EE_RECORD_FLAG_CONTROL = 0x02`
  - `export interface RecordAssemblerOptions { readonly allowControlRecords?: boolean }` with `new RecordAssembler(maxMessageBytes?, options?)`
  - `export const CHUNKED_RPC_SUBPROTOCOL = "bibcode.rpc.chunked.v1"`
  - `export const makeChunkedSocket(inner: Socket.Socket, negotiated: () => boolean): Socket.Socket`
  - `export const E2EE_INTERLEAVE_FEATURE = "interleave-v1"`
  - Contracts: `E2eeChannelFeatures`; optional `features` on `E2eeAuthPairingMessage`, `E2eeAuthBearerMessage` and `E2eeAuthenticatedMessage`.

- [ ] **Step 1: Write the failing frame tests**

Append to `packages/client-runtime/src/e2ee/frame.test.ts` (extend its imports with `E2EE_RECORD_FLAG_CONTROL`, `E2eeFrameError`, `RecordAssembler`, `MAX_E2EE_CHUNK_BYTES`, `MAX_E2EE_RECORDS_PER_MESSAGE` as needed):

```ts
describe("RecordAssembler control records", () => {
  const encoder = new TextEncoder();
  const record = (flag: number, text: string) => {
    const bytes = encoder.encode(text);
    const out = new Uint8Array(1 + bytes.length);
    out[0] = flag;
    out.set(bytes, 1);
    return out;
  };

  it("returns a 0x02 record at once without touching the partial message", () => {
    const assembler = new RecordAssembler(undefined, { allowControlRecords: true });
    expect(assembler.push(record(0x01, "hello "))).toBeNull();
    expect(new TextDecoder().decode(assembler.push(record(0x02, "pong"))!)).toBe("pong");
    expect(new TextDecoder().decode(assembler.push(record(0x00, "world"))!)).toBe("hello world");
  });

  it("rejects 0x02 unless control records were negotiated", () => {
    const assembler = new RecordAssembler();
    expect(() => assembler.push(record(E2EE_RECORD_FLAG_CONTROL, "pong"))).toThrow(E2eeFrameError);
  });

  it("refuses a control payload larger than one record", () => {
    const assembler = new RecordAssembler(undefined, { allowControlRecords: true });
    expect(() => assembler.push(record(0x02, "x".repeat(MAX_E2EE_CHUNK_BYTES + 1))))
      .toThrow(E2eeFrameError);
  });

  it("checks the byte limit before returning a control payload", () => {
    const assembler = new RecordAssembler(4, { allowControlRecords: true });
    assembler.push(record(0x01, "abc"));
    expect(() => assembler.push(record(0x02, "de"))).toThrow(E2eeFrameError);
  });

  it("checks the record limit before returning a control payload", () => {
    const assembler = new RecordAssembler(undefined, { allowControlRecords: true });
    for (let i = 0; i < MAX_E2EE_RECORDS_PER_MESSAGE; i += 1) {
      assembler.push(record(0x01, "x"));
    }
    expect(() => assembler.push(record(0x02, "pong"))).toThrow(E2eeFrameError);
  });

  it("rejects an empty control record", () => {
    const assembler = new RecordAssembler(undefined, { allowControlRecords: true });
    expect(() => assembler.push(Uint8Array.of(0x02))).toThrow(E2eeFrameError);
  });
});
```

Run: `vp test run packages/client-runtime/src/e2ee/frame.test.ts`
Expected: FAIL (the constructor does not accept the control option, and the new control behavior is missing).

- [ ] **Step 2: Implement the frame change**

In `packages/client-runtime/src/e2ee/frame.ts`:
1. After `export const E2EE_RECORD_FLAG_CONTINUATION = 0x01;` add `export const E2EE_RECORD_FLAG_CONTROL = 0x02;`.
2. Add before `export class RecordAssembler`:

```ts
export interface RecordAssemblerOptions {
  /** Accept `0x02` stand-alone control records between the records of another message. */
  readonly allowControlRecords?: boolean;
}
```

3. Replace the class's fields, constructor and the start of `push` (through the `const chunk = …` line) with:

```ts
  private parts: Array<Uint8Array> = [];
  private assembledBytes = 0;
  private recordCount = 0;
  private readonly maxMessageBytes: number;
  private readonly allowControlRecords: boolean;

  constructor(
    maxMessageBytes = MAX_E2EE_LOGICAL_MESSAGE_BYTES,
    options?: RecordAssemblerOptions,
  ) {
    this.maxMessageBytes = maxMessageBytes;
    this.allowControlRecords = options?.allowControlRecords ?? false;
  }

  push(recordPlaintext: Uint8Array): Uint8Array | null {
    if (recordPlaintext.length === 0) throw new E2eeFrameError("empty E2EE record");

    const flag = recordPlaintext[0];
    const chunk = recordPlaintext.subarray(1);
    // Apply the existing 64 MiB / 2,048-record bounds before any early
    // control return. The control itself is one complete record and does
    // not mutate the in-progress data message.
    if (this.recordCount >= MAX_E2EE_RECORDS_PER_MESSAGE) {
      throw new E2eeFrameError("E2EE record count overflow");
    }
    if (this.assembledBytes + chunk.length > this.maxMessageBytes) {
      throw new E2eeFrameError("E2EE reassembly overflow");
    }
    if (flag === E2EE_RECORD_FLAG_CONTROL && this.allowControlRecords) {
      if (chunk.length > MAX_E2EE_CHUNK_BYTES) {
        throw new E2eeFrameError("E2EE control record overflow");
      }
      if (chunk.length === 0) throw new E2eeFrameError("empty E2EE control record");
      // A control message is complete in one record and leaves the partial message alone.
      return chunk.slice();
    }
```

   Delete the old duplicate record-count and byte-overflow guards below this replacement. Keep the continuation-empty guard, record increment, flag validation and reassembly code unchanged; every guard now precedes the control return.

Run: `vp test run packages/client-runtime/src/e2ee/frame.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the chunked-socket test**

Create `packages/client-runtime/src/rpc/chunkedSocket.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Socket from "effect/unstable/socket/Socket";

import { makeChunkedSocket } from "./chunkedSocket.ts";

const encoder = new TextEncoder();
const record = (flag: number, text: string) => {
  const bytes = encoder.encode(text);
  const out = new Uint8Array(1 + bytes.length);
  out[0] = flag;
  out.set(bytes, 1);
  return out;
};

/** A socket that delivers the given frames once run, then stays open. */
const scriptedSocket = (frames: ReadonlyArray<string | Uint8Array>): Socket.Socket =>
  Socket.make({
    runRaw: (handler) =>
      Effect.gen(function* () {
        for (const frame of frames) {
          const result = handler(frame);
          if (Effect.isEffect(result)) yield* result;
        }
        return yield* Effect.never;
      }),
    writer: Effect.succeed(() => Effect.void),
  });

const collect = (socket: Socket.Socket, count: number) =>
  Effect.gen(function* () {
    const received: Array<string | Uint8Array> = [];
    const fiber = yield* Effect.forkChild(
      socket.runRaw((data) => {
        received.push(data);
      }),
    );
    for (let attempt = 0; attempt < 100 && received.length < count; attempt += 1) {
      yield* Effect.yieldNow;
    }
    yield* Fiber.interrupt(fiber);
    return received;
  });

describe("makeChunkedSocket", () => {
  it.effect("reassembles records and passes control records through in order", () =>
    Effect.gen(function* () {
      const socket = makeChunkedSocket(
        scriptedSocket([
          "whole",
          record(0x01, "par"),
          record(0x02, "control"),
          record(0x00, "tial"),
        ]),
        () => true,
      );
      expect(yield* collect(socket, 3)).toEqual(["whole", "control", "partial"]);
    }),
  );

  it.effect("passes binary frames through unchanged without the subprotocol", () =>
    Effect.gen(function* () {
      const frame = record(0x00, "legacy");
      const socket = makeChunkedSocket(scriptedSocket([frame]), () => false);
      expect(yield* collect(socket, 1)).toEqual([frame]);
    }),
  );

  it.effect("fails the socket on a malformed record", () =>
    Effect.gen(function* () {
      const socket = makeChunkedSocket(scriptedSocket([Uint8Array.of(0x07, 0x20)]), () => true);
      const error = yield* Effect.flip(socket.runRaw(() => undefined));
      expect(Socket.isSocketError(error)).toBe(true);
    }),
  );
});
```

Run: `vp test run packages/client-runtime/src/rpc/chunkedSocket.test.ts`
Expected: FAIL. `./chunkedSocket.ts` does not exist.

- [ ] **Step 4: Implement the chunked socket**

Create `packages/client-runtime/src/rpc/chunkedSocket.ts`:

```ts
import * as Effect from "effect/Effect";
import * as Socket from "effect/unstable/socket/Socket";

import { RecordAssembler } from "../e2ee/frame.ts";

/** Subprotocol a plain `/ws` client offers to receive large messages as records. */
export const CHUNKED_RPC_SUBPROTOCOL = "bibcode.rpc.chunked.v1";

const decoder = new TextDecoder();

/**
 * Reassembles plain `/ws` records when the server selected
 * {@link CHUNKED_RPC_SUBPROTOCOL}. Text frames are whole messages; binary
 * frames are records (`0x00` final, `0x01` continuation, `0x02` stand-alone
 * control). Without the subprotocol every frame passes through unchanged,
 * which is today's framing. `negotiated` is read at the first frame, after the
 * socket opened.
 */
export const makeChunkedSocket = (
  inner: Socket.Socket,
  negotiated: () => boolean,
): Socket.Socket =>
  Socket.make({
    runRaw: <A, E, R>(
      handler: (data: string | Uint8Array) => Effect.Effect<A, E, R> | void,
      options?: { readonly onOpen?: Effect.Effect<void> | undefined },
    ): Effect.Effect<void, Socket.SocketError | E, R> =>
      Effect.suspend(() => {
        const assembler = new RecordAssembler(undefined, { allowControlRecords: true });
        let chunked: boolean | null = null;
        return inner.runRaw<A, E | Socket.SocketError, R>((data) => {
          chunked ??= negotiated();
          if (!chunked || typeof data === "string") return handler(data);
          const bytes =
            data instanceof Uint8Array ? data : new Uint8Array(data as unknown as ArrayBuffer);
          let message: Uint8Array | null;
          try {
            message = assembler.push(bytes);
          } catch (cause) {
            return Effect.fail(
              new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }),
            );
          }
          return message === null ? undefined : handler(decoder.decode(message));
        }, options);
      }),
    writer: inner.writer,
  });
```

Run: `vp test run packages/client-runtime/src/rpc/chunkedSocket.test.ts`
Expected: PASS (`Tests  3 passed (3)`).

- [ ] **Step 5: Contracts: E2EE channel features**

In `packages/contracts/src/remotePairing.ts`:
1. Before `E2eeAuthPairingMessage` add:

```ts
/** Optional transport features a client offers and the server confirms inside the channel. */
export const E2eeChannelFeatures = Schema.Array(TrimmedNonEmptyString);
export type E2eeChannelFeatures = typeof E2eeChannelFeatures.Type;
```

2. Add `features: Schema.optionalKey(E2eeChannelFeatures),` to `E2eeAuthPairingMessage`, `E2eeAuthBearerMessage` and `E2eeAuthenticatedMessage`.

In `packages/contracts/src/remotePairing.test.ts`, at the end of "round-trips the channel control messages", add:

```ts
    expect(
      decodeAuth({ type: "e2ee_auth", bearer: "stored", features: ["interleave-v1"] }),
    ).toEqual({ type: "e2ee_auth", bearer: "stored", features: ["interleave-v1"] });
    expect(
      decodeReady({ type: "e2ee_authenticated", features: ["interleave-v1"] }).features,
    ).toEqual(["interleave-v1"]);
```

Run: `vp test run packages/contracts/src/remotePairing.test.ts`
Expected: PASS.

- [ ] **Step 6: E2EE socket — offer `interleave-v1`, honor the confirmation**

Tests first. In `packages/client-runtime/src/e2ee/socket.test.ts`, `responderScript` gets an option to confirm interleave and to send a control record mid-message:

1. Change the signature to `const responderScript = (options?: { failAuth?: boolean; messageBPayload?: Uint8Array; confirmInterleave?: boolean; interleaveControl?: boolean }) =>`.
2. Replace `reply({ type: "e2ee_authenticated" });` (the bearer branch) with:

```ts
        reply({
          type: "e2ee_authenticated",
          ...(options?.confirmInterleave === true ? { features: ["interleave-v1"] } : {}),
        });
```

3. Replace the last line `reply({ echoed: text.length });` with:

```ts
    if (options?.interleaveControl === true) {
      const body = new TextEncoder().encode(encodeJson({ echoed: text.length }));
      const send = (bytes: Uint8Array) =>
        emit(currentTransport().send.encryptWithAd(new Uint8Array(0), bytes));
      send(Uint8Array.of(0x01, ...body.subarray(0, 4)));
      send(Uint8Array.of(0x02, ...new TextEncoder().encode(encodeJson({ control: true }))));
      send(Uint8Array.of(0x00, ...body.subarray(4)));
      return;
    }
    reply({ echoed: text.length });
```

Append these tests inside `describe("makeE2eeSocket", …)`. They follow the pattern of the existing authenticated-echo tests in this file, which use `makeScriptedInnerSocket(script)` and `makeE2eeSocket(inner, { hostKey, auth })`, write a message through the writer, and collect handler calls:

```ts
  it.effect("offers interleave-v1 in the auth message", () =>
    Effect.gen(function* () {
      const responder = responderScript();
      const socket = makeE2eeSocket(makeScriptedInnerSocket(responder.script), {
        hostKey: Buffer.from(responder.hostKey).toString("base64url"),
        auth: { kind: "bearer", credential: "stored" },
      });
      const opened = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        socket.runRaw(() => undefined, { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) }),
      );
      yield* Deferred.await(opened);
      expect(decodeJson(responder.received[0]!)).toMatchObject({
        type: "e2ee_auth",
        bearer: "stored",
        features: ["interleave-v1"],
      });
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("delivers a mid-message control record once the server confirms interleave-v1", () =>
    Effect.gen(function* () {
      const responder = responderScript({ confirmInterleave: true, interleaveControl: true });
      const socket = makeE2eeSocket(makeScriptedInnerSocket(responder.script), {
        hostKey: Buffer.from(responder.hostKey).toString("base64url"),
        auth: { kind: "bearer", credential: "stored" },
      });
      const received: Array<string> = [];
      const opened = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        socket.runRaw(
          (data) => {
            received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
          },
          { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) },
        ),
      );
      yield* Deferred.await(opened);
      const write = yield* Scope.provide(socket.writer, yield* Scope.make());
      yield* write('{"hello":true}');
      for (let attempt = 0; attempt < 100 && received.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(received.map((text) => decodeJson(text))).toEqual([
        { control: true },
        { echoed: 14 },
      ]);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("fails closed on a control record the server never confirmed", () =>
    Effect.gen(function* () {
      const responder = responderScript({ interleaveControl: true });
      const socket = makeE2eeSocket(makeScriptedInnerSocket(responder.script), {
        hostKey: Buffer.from(responder.hostKey).toString("base64url"),
        auth: { kind: "bearer", credential: "stored" },
      });
      const opened = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        Effect.exit(socket.runRaw(() => undefined, { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) })),
      );
      yield* Deferred.await(opened);
      const write = yield* Scope.provide(socket.writer, yield* Scope.make());
      yield* write('{"hello":true}');
      const exit = yield* Fiber.join(fiber);
      expect(findE2eeCause(exit)?.reason).toBe("protocol");
    }),
  );
```

Before implementation, update the three existing exact auth-JSON assertions in `socket.test.ts` (current lines 265, 288 and 328), preserving these exact credentials:

```ts
      expect(received[0]).toBe(encodeJson({
        type: "e2ee_auth", pairing: "one-time-1", features: ["interleave-v1"],
      }));
      expect(received[0]).toBe(encodeJson({
        type: "e2ee_auth", bearer: "stored-1", features: ["interleave-v1"],
      }));
      expect(received[0]).toBe(encodeJson({
        type: "e2ee_auth", pairing: "one-time-2", features: ["interleave-v1"],
      }));
```

Run: `vp test run packages/client-runtime/src/e2ee/socket.test.ts`
Expected: FAIL (the three auth assertions lack the offered features, and the negotiated control tests fail). Every `onOpen` passed to `Socket.runRaw` must be `Effect<void>`; use `.pipe(Effect.asVoid)`.

Implementation. In `packages/client-runtime/src/e2ee/socket.ts`:
1. After `export const E2EE_HOST_IDENTITY_CLOSE_CODE = 4403;` add:

```ts
/** Lets the server interleave `0x02` control records with a large message. */
export const E2EE_INTERLEAVE_FEATURE = "interleave-v1";
const E2EE_CLIENT_FEATURES = [E2EE_INTERLEAVE_FEATURE];
```

2. Replace the `authMessage` construction with:

```ts
                const authMessage =
                  options.auth.kind === "pairing"
                    ? {
                        type: "e2ee_auth",
                        pairing: options.auth.token,
                        features: E2EE_CLIENT_FEATURES,
                      }
                    : {
                        type: "e2ee_auth",
                        bearer: options.auth.credential,
                        features: E2EE_CLIENT_FEATURES,
                      };
```

3. Replace `assembler = new RecordAssembler();` (in the `e2ee_authenticated` branch) with:

```ts
                  assembler = new RecordAssembler(undefined, {
                    allowControlRecords: ready.features?.includes(E2EE_INTERLEAVE_FEATURE) === true,
                  });
```

Run: `vp test run packages/client-runtime/src/e2ee`
Expected: PASS (existing E2EE tests plus the three new ones).

- [ ] **Step 7: Session — offer the subprotocol and wrap the plain socket (tests first)**

In `packages/client-runtime/src/rpc/session.test.ts`:
1. Extend the contracts import with `ServerSettings`.
2. In `class TestWebSocket`, add the field `protocol = "";`. Change the constructor to `constructor(url: string, protocols?: string | Array<string>) { this.url = url; this.protocols = protocols; }` with the field `readonly protocols: string | Array<string> | undefined;`.
3. In `makeFactory`, change the constructor layer to `Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => { const socket = new TestWebSocket(url, protocols); sockets.push(socket); return socket as unknown as globalThis.WebSocket; })`.
4. After `encodeServerConfig` add `const encodeServerSettings = Schema.encodeSync(ServerSettings);`.
5. Append:

```ts
  it.effect("offers the chunked subprotocol on plain sockets only", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          expect(socket.protocols).toEqual(["bibcode.rpc.chunked.v1"]);
          expect(socket.binaryType).toBe("arraybuffer");
        }),
      );
    }),
  );

  it.effect("reassembles records when the server selected the subprotocol", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.protocol = "bibcode.rpc.chunked.v1";
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);

        const settings = yield* Effect.forkChild(
          session.client[WS_METHODS.serverGetSettings]({}),
        );
        const request = yield* awaitRequest(socket, 1);
        const body = new TextEncoder().encode(
          encodeJson({
            _tag: "Exit",
            requestId: request.id,
            exit: { _tag: "Success", value: encodeServerSettings(DEFAULT_SERVER_SETTINGS) },
          }),
        );
        const record = (flag: number, bytes: Uint8Array) => {
          const out = new Uint8Array(1 + bytes.length);
          out[0] = flag;
          out.set(bytes, 1);
          return out;
        };
        socket.serverMessage(record(0x01, body.subarray(0, 10)));
        socket.serverMessage(
          record(0x02, new TextEncoder().encode(encodeJson({ _tag: "Pong" }))),
        );
        socket.serverMessage(record(0x00, body.subarray(10)));
        expect(yield* Fiber.join(settings)).toEqual(DEFAULT_SERVER_SETTINGS);
      }),
    ),
  );

  it.effect("keeps binary frames whole when the server did not select the subprotocol", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);

        const settings = yield* Effect.forkChild(
          session.client[WS_METHODS.serverGetSettings]({}),
        );
        const request = yield* awaitRequest(socket, 1);
        socket.serverMessage(
          new TextEncoder().encode(
            encodeJson({
              _tag: "Exit",
              requestId: request.id,
              exit: { _tag: "Success", value: encodeServerSettings(DEFAULT_SERVER_SETTINGS) },
            }),
          ),
        );
        expect(yield* Fiber.join(settings)).toEqual(DEFAULT_SERVER_SETTINGS);
      }),
    ),
  );
```

Run: `vp test run packages/client-runtime/src/rpc/session.test.ts`
Expected: FAIL. `socket.protocols` is `undefined` and the record test times out, because the session does not offer or reassemble yet.

Implementation. In `packages/client-runtime/src/rpc/session.ts`:
1. Add `import { CHUNKED_RPC_SUBPROTOCOL, makeChunkedSocket } from "./chunkedSocket.ts";`.
2. Replace the `connectionWebSocketConstructor` definition with:

```ts
    let rawSocket: globalThis.WebSocket | null = null;
    const connectionWebSocketConstructor: typeof webSocketConstructor = (url, protocols) => {
      const socket = webSocketConstructor(url, protocols);
      // Binary frames must stay in delivery order: E2EE ciphertext and plain records.
      socket.binaryType = "arraybuffer";
      // Every raw frame is proof of life, including E2EE records before reassembly.
      socket.addEventListener("message", activity.record);
      rawSocket = socket;
      return socket;
    };
```

3. In the socket layer, replace `Socket.makeWebSocket(connection.socketUrl, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(` with:

```ts
      Socket.makeWebSocket(connection.socketUrl, {
        openTimeout: SOCKET_OPEN_TIMEOUT,
        ...(connection.e2ee === null ? { protocols: [CHUNKED_RPC_SUBPROTOCOL] } : {}),
      }).pipe(
```

   Then replace `if (connection.e2ee === null) return plainSocket;` with:

```ts
          if (connection.e2ee === null) {
            return makeChunkedSocket(
              plainSocket,
              () => rawSocket?.protocol === CHUNKED_RPC_SUBPROTOCOL,
            );
          }
```

- [ ] **Step 8: Run the client suites**

Run: `vp test run packages/client-runtime packages/contracts/src/remotePairing.test.ts`
Expected: PASS. All session tests, including Phase A's liveness tests, stay green.

- [ ] **Step 9: Gates**

Run: `vp check` and `vp run typecheck`
Expected: no new findings or errors.

- [ ] **Step 10: Checkpoint (no commit)**

Record `Task 7 <tree> client-runtime + remotePairing` in the ledger.

---

### Task 8: `rpc_liveness.rs` slow-link regression harness (transfer matrix)

**Files:**
- Create: `apps/server/tests/rpc_liveness.rs`

**Interfaces:**
- Consumes:
  - `ServerRuntime::start_with_registry`, `ServerConfig::new(..).with_bind(..).with_unsafe_no_auth()`, `RpcRegistry::register_unary`;
  - the host key at `<root>/userdata/secrets/host-identity-x25519.bin` (bytes 32..64);
  - the wire behavior from Tasks 5–7.
- Produces: `ThrottleProxy` (with `freeze`), `Mode`, `Trial`, `Outcome`, `run_trial`, `wait_for_exit` (including exact payload validation), and `ThrottleProxy::freeze`, which Task 10 reuses in this file.

- [ ] **Step 1: Write the harness**

Create `apps/server/tests/rpc_liveness.rs`:

```rust
//! Slow-link regression harness (connection-liveness design, "Validation").
//!
//! A real server sits behind an in-process throttling TCP proxy. The proxy
//! reads from the server only as fast as the link rate, through a small
//! upstream receive buffer, so the server's socket writes block as on a real
//! bottleneck (backpressure). The test clients follow the item-1 client rule:
//! every inbound WebSocket message is proof of life, an RPC `Ping` goes out
//! after 10 s without inbound data, and the link is declared dead after 30 s.
//!
//! The transfer matrix takes about two minutes (8 MiB at 64 KiB/s is 128 s);
//! all trials run concurrently against one server.

use std::{
    net::SocketAddr,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use bibcode_server::{RpcRegistry, ServerConfig, ServerHandle, ServerRuntime};
use futures_util::{SinkExt, StreamExt, future::join_all};
use serde_json::{Value, json};
use snow::TransportState;
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    time::{Instant, sleep, sleep_until, timeout},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};

const KIB: u64 = 1024;
const MIB: usize = 1024 * 1024;
const PROBE_AFTER: Duration = Duration::from_secs(10);
const DEAD_AFTER: Duration = Duration::from_secs(30);
const NOISE_NK_PARAMS: &str = "Noise_NK_25519_ChaChaPoly_SHA256";
const MAX_CIPHERTEXT_BYTES: usize = 65_535;
const MAX_CHUNK_BYTES: usize = 65_518;
const MAX_LOGICAL_BYTES: usize = 64 * MIB;
const MAX_RECORDS: usize = 2_048;
const PROXY_CHUNK: usize = 4 * 1024;
const PROXY_UPSTREAM_RECEIVE_BUFFER: u32 = 64 * 1024;

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    PlainSplit,
    PlainLegacy,
    Encrypted,
}

#[derive(Clone, Copy, Debug)]
struct Trial {
    mode: Mode,
    rate: u64,
    bytes: usize,
}

#[derive(Debug)]
enum Outcome {
    Completed(Duration),
    Dead(Duration),
    Closed(Duration),
}

async fn start_server(temp: &TempDir) -> ServerHandle {
    let mut registry = RpcRegistry::empty();
    registry.register_unary("fixture.bytes", |request, _cancellation| async move {
        let bytes = request.payload["bytes"]
            .as_u64()
            .and_then(|bytes| usize::try_from(bytes).ok())
            .unwrap_or_default();
        Ok(json!({ "data": "x".repeat(bytes) }))
    });
    ServerRuntime::start_with_registry(
        ServerConfig::new(temp.path())
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth(),
        registry,
    )
    .await
    .expect("server starts")
}

fn host_public_key(root: &Path) -> Vec<u8> {
    let record = std::fs::read(
        root.join("userdata")
            .join("secrets")
            .join("host-identity-x25519.bin"),
    )
    .expect("persisted host identity");
    record[32..].to_vec()
}

/// Paces server-to-client bytes at `rate` and forwards client-to-server bytes
/// as they come. `freeze(true)` stops both directions without closing.
struct ThrottleProxy {
    address: SocketAddr,
    frozen: Arc<AtomicBool>,
}

impl ThrottleProxy {
    async fn start(target: SocketAddr, rate: u64) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("proxy listens");
        let address = listener.local_addr().expect("proxy address");
        let frozen = Arc::new(AtomicBool::new(false));
        let accept_frozen = Arc::clone(&frozen);
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let frozen = Arc::clone(&accept_frozen);
                tokio::spawn(relay(client, target, rate, frozen));
            }
        });
        Self { address, frozen }
    }

    fn freeze(&self, frozen: bool) {
        self.frozen.store(frozen, Ordering::Relaxed);
    }
}

async fn wait_while_frozen(frozen: &AtomicBool) -> bool {
    let mut waited = false;
    while frozen.load(Ordering::Relaxed) {
        waited = true;
        sleep(Duration::from_millis(20)).await;
    }
    waited
}

async fn relay(client: TcpStream, target: SocketAddr, rate: u64, frozen: Arc<AtomicBool>) {
    let upstream = TcpSocket::new_v4().expect("upstream socket");
    upstream
        .set_recv_buffer_size(PROXY_UPSTREAM_RECEIVE_BUFFER)
        .expect("small upstream receive buffer");
    let Ok(server) = upstream.connect(target).await else {
        return;
    };
    let (mut client_read, mut client_write) = client.into_split();
    let (mut server_read, mut server_write) = server.into_split();
    let up_frozen = Arc::clone(&frozen);
    let up = tokio::spawn(async move {
        let mut buffer = vec![0_u8; PROXY_CHUNK];
        loop {
            wait_while_frozen(&up_frozen).await;
            let read = match client_read.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            wait_while_frozen(&up_frozen).await;
            if server_write.write_all(&buffer[..read]).await.is_err() {
                break;
            }
        }
        let _ = server_write.shutdown().await;
    });
    let mut buffer = vec![0_u8; PROXY_CHUNK];
    let mut next_send = Instant::now();
    loop {
        if wait_while_frozen(&frozen).await {
            next_send = Instant::now();
        }
        let read = match server_read.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let pace = Duration::from_secs_f64(read as f64 / rate as f64);
        next_send = next_send.max(Instant::now()) + pace;
        sleep_until(next_send).await;
        wait_while_frozen(&frozen).await;
        if client_write.write_all(&buffer[..read]).await.is_err() {
            break;
        }
    }
    let _ = client_write.shutdown().await;
    up.abort();
}

enum Framing {
    Whole,
    Records,
    Encrypted(Box<TransportState>),
}

async fn connect_plain(proxy: SocketAddr, chunked: bool) -> TestSocket {
    let mut request = format!("ws://{proxy}/ws")
        .into_client_request()
        .expect("WebSocket request");
    if chunked {
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static("bibcode.rpc.chunked.v1"),
        );
    }
    let (socket, response) = connect_async(request).await.expect("WebSocket connects");
    assert_eq!(
        response.headers().get("Sec-WebSocket-Protocol").and_then(|value| value.to_str().ok()),
        chunked.then_some("bibcode.rpc.chunked.v1"),
    );
    socket
}

fn encrypt_record(transport: &mut TransportState, flag: u8, chunk: &[u8]) -> Vec<u8> {
    let mut record = Vec::with_capacity(chunk.len() + 1);
    record.push(flag);
    record.extend_from_slice(chunk);
    let mut frame = vec![0_u8; record.len() + 16];
    let len = transport
        .write_message(&record, &mut frame)
        .expect("encrypt record");
    frame.truncate(len);
    frame
}

async fn send_encrypted(socket: &mut TestSocket, transport: &mut TransportState, plaintext: &[u8]) {
    let mut chunks = plaintext.chunks(MAX_CHUNK_BYTES).peekable();
    while let Some(chunk) = chunks.next() {
        let flag = if chunks.peek().is_some() { 0x01 } else { 0x00 };
        let frame = encrypt_record(transport, flag, chunk);
        socket
            .send(Message::Binary(frame.into()))
            .await
            .expect("send encrypted record");
    }
}

async fn connect_encrypted(proxy: SocketAddr, host_key: &[u8]) -> (TestSocket, TransportState) {
    let mut socket = connect_async(format!("ws://{proxy}/ws-e2ee"))
        .await
        .expect("E2EE WebSocket connects")
        .0;
    let mut initiator = snow::Builder::new(NOISE_NK_PARAMS.parse().expect("Noise parameters"))
        .remote_public_key(host_key)
        .expect("host key")
        .build_initiator()
        .expect("Noise initiator");
    let mut message_a = vec![0_u8; MAX_CIPHERTEXT_BYTES];
    let len = initiator
        .write_message(&[], &mut message_a)
        .expect("write message A");
    message_a.truncate(len);
    socket
        .send(Message::Binary(message_a.into()))
        .await
        .expect("send message A");
    let message_b = loop {
        match socket.next().await {
            Some(Ok(Message::Binary(frame))) => break frame,
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            other => panic!("expected message B, got {other:?}"),
        }
    };
    let mut payload = vec![0_u8; MAX_CIPHERTEXT_BYTES];
    initiator
        .read_message(&message_b, &mut payload)
        .expect("read message B");
    let mut transport = initiator
        .into_transport_mode()
        .expect("Noise transport mode");
    // The server runs with unsafe_no_auth, so any bearer is accepted.
    send_encrypted(
        &mut socket,
        &mut transport,
        json!({ "type": "e2ee_auth", "bearer": "harness", "features": ["interleave-v1"] })
            .to_string()
            .as_bytes(),
    )
    .await;
    (socket, transport)
}

async fn send_text(socket: &mut TestSocket, framing: &mut Framing, text: &str) {
    match framing {
        Framing::Whole | Framing::Records => socket
            .send(Message::Text(text.to_owned().into()))
            .await
            .expect("send text frame"),
        Framing::Encrypted(transport) => send_encrypted(socket, transport, text.as_bytes()).await,
    }
}

#[derive(Default)]
struct Assembly {
    bytes: Vec<u8>,
    records: usize,
}

/// Turns one WebSocket data frame into zero or one complete RPC message.
fn reassemble(framing: &mut Framing, partial: &mut Assembly, frame: Message) -> Option<Vec<u8>> {
    let record = match (framing, frame) {
        (Framing::Whole | Framing::Records, Message::Text(text)) => {
            return Some(text.as_bytes().to_vec());
        }
        (Framing::Whole, Message::Binary(bytes)) => return Some(bytes.to_vec()),
        (Framing::Records, Message::Binary(bytes)) => bytes.to_vec(),
        (Framing::Encrypted(transport), Message::Binary(bytes)) => {
            let mut plaintext = vec![0_u8; MAX_CIPHERTEXT_BYTES];
            let len = transport
                .read_message(&bytes, &mut plaintext)
                .expect("decrypt record");
            plaintext.truncate(len);
            plaintext
        }
        _ => return None,
    };
    let (&flag, chunk) = record.split_first().expect("record flag");
    assert!(partial.records < MAX_RECORDS, "record cap");
    assert!(partial.bytes.len() + chunk.len() <= MAX_LOGICAL_BYTES, "message cap");
    match flag {
        0x00 => {
            partial.bytes.extend_from_slice(chunk);
            partial.records = 0;
            Some(std::mem::take(&mut partial.bytes))
        }
        0x01 => {
            assert!(!chunk.is_empty(), "nonempty continuation");
            partial.records += 1;
            partial.bytes.extend_from_slice(chunk);
            None
        }
        0x02 => {
            assert!(!chunk.is_empty() && chunk.len() <= MAX_CHUNK_BYTES, "control cap");
            Some(chunk.to_vec())
        },
        other => panic!("unknown record flag {other}"),
    }
}

/// Reads until the Exit for `request_id`, applying the item-1 client rule.
async fn wait_for_exit(
    socket: &mut TestSocket,
    framing: &mut Framing,
    started: Instant,
    request_id: &str,
    expected_bytes: usize,
) -> Outcome {
    let mut last_inbound = Instant::now();
    let mut pinged = false;
    let mut partial = Assembly::default();
    loop {
        let idle_deadline = last_inbound + if pinged { DEAD_AFTER } else { PROBE_AFTER };
        let frame = tokio::select! {
            frame = socket.next() => frame,
            () = sleep_until(idle_deadline) => {
                if pinged {
                    let close = tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: 4408.into(), reason: "liveness timeout".into(),
                    };
                    let _ = timeout(Duration::from_secs(1), socket.close(Some(close))).await;
                    return Outcome::Dead(started.elapsed());
                }
                send_text(socket, framing, r#"{"_tag":"Ping"}"#).await;
                pinged = true;
                continue;
            }
        };
        let Some(Ok(frame)) = frame else {
            return Outcome::Closed(started.elapsed());
        };
        if matches!(frame, Message::Close(_)) {
            return Outcome::Closed(started.elapsed());
        }
        if matches!(&frame, Message::Text(_) | Message::Binary(_)) {
            last_inbound = Instant::now();
            pinged = false;
        }
        let Some(message) = reassemble(framing, &mut partial, frame) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&message) else {
            continue;
        };
        if value["_tag"] == "Exit" && value["requestId"] == request_id {
            assert_eq!(value["exit"]["_tag"], "Success", "matching Exit must succeed: {value}");
            let data = value["exit"]["value"]["data"].as_str().expect("fixture data string");
            assert_eq!(data.len(), expected_bytes, "exact requested payload length");
            assert!(data.bytes().all(|byte| byte == b'x'), "exact fixture payload content");
            return Outcome::Completed(started.elapsed());
        }
    }
}

/// Connects through `proxy` and returns the socket and its framing, after
/// the E2EE `e2ee_authenticated` reply for encrypted sockets.
async fn open(mode: Mode, proxy: SocketAddr, host_key: &[u8]) -> (TestSocket, Framing) {
    match mode {
        Mode::PlainSplit => (connect_plain(proxy, true).await, Framing::Records),
        Mode::PlainLegacy => (connect_plain(proxy, false).await, Framing::Whole),
        Mode::Encrypted => {
            let (mut socket, transport) = connect_encrypted(proxy, host_key).await;
            let mut framing = Framing::Encrypted(Box::new(transport));
            let mut partial = Assembly::default();
            loop {
                let frame = socket
                    .next()
                    .await
                    .expect("authenticated reply")
                    .expect("frame");
                if let Some(message) = reassemble(&mut framing, &mut partial, frame) {
                    let reply: Value = serde_json::from_slice(&message).expect("reply JSON");
                    assert_eq!(reply["type"], "e2ee_authenticated");
                    assert_eq!(reply["features"], json!(["interleave-v1"]));
                    break;
                }
            }
            (socket, framing)
        }
    }
}

async fn request_bytes(socket: &mut TestSocket, framing: &mut Framing, id: &str, bytes: usize) {
    let request = json!({
        "_tag": "Request",
        "id": id,
        "tag": "fixture.bytes",
        "payload": { "bytes": bytes },
        "headers": [],
    });
    send_text(socket, framing, &request.to_string()).await;
}

async fn run_trial(server: SocketAddr, host_key: &[u8], trial: Trial) -> Outcome {
    let proxy = ThrottleProxy::start(server, trial.rate).await;
    let (mut socket, mut framing) = open(trial.mode, proxy.address, host_key).await;
    let started = Instant::now();
    request_bytes(&mut socket, &mut framing, "1", trial.bytes).await;
    wait_for_exit(&mut socket, &mut framing, started, "1", trial.bytes).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slow_links_finish_transfers_without_a_disconnect() {
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let host_key = host_public_key(temp.path());
    let server = handle.local_addr();
    let trials: Vec<Trial> = [Mode::PlainSplit, Mode::PlainLegacy, Mode::Encrypted]
        .into_iter()
        .flat_map(|mode| {
            [64 * KIB, 256 * KIB].into_iter().flat_map(move |rate| {
                [MIB, 8 * MIB]
                    .into_iter()
                    .map(move |bytes| Trial { mode, rate, bytes })
            })
        })
        .collect();
    let outcomes = join_all(
        trials
            .iter()
            .map(|trial| run_trial(server, &host_key, *trial)),
    )
    .await;

    let mut failures = Vec::new();
    for (trial, outcome) in trials.iter().zip(&outcomes) {
        let expected_seconds = trial.bytes as f64 / trial.rate as f64;
        let passed = match (trial.mode, outcome) {
            (_, Outcome::Completed(after)) => {
                assert!(*after < Duration::from_secs(600), "completed after {after:?}");
                true
            }
            (_, Outcome::Closed(after)) => {
                failures.push(format!("{trial:?}: peer closed after {after:?}"));
                false
            }
            // A legacy whole frame that needs more than 30 s cannot beat the
            // client rule; it may be declared dead, but never before 27 s.
            (Mode::PlainLegacy, Outcome::Dead(after)) => {
                expected_seconds >= 30.0 && *after >= Duration::from_secs(27) && *after <= Duration::from_secs(33)
            }
            _ => false,
        };
        if !passed {
            failures.push(format!("{trial:?} -> {outcome:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "slow-link trials failed:\n{}",
        failures.join("\n")
    );
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn item_one_client_detects_a_frozen_server_within_thirty_three_seconds() {
    let temp = TempDir::new().expect("temporary root");
    let handle = start_server(&temp).await;
    let proxy = ThrottleProxy::start(handle.local_addr(), 1024 * KIB).await;
    let (mut socket, mut framing) = open(Mode::PlainSplit, proxy.address, &[]).await;
    request_bytes(&mut socket, &mut framing, "1", 1024).await;
    assert!(matches!(wait_for_exit(
        &mut socket, &mut framing, Instant::now(), "1", 1024,
    ).await, Outcome::Completed(_)));
    proxy.freeze(true);
    let frozen_at = Instant::now();
    let result = timeout(Duration::from_secs(33), wait_for_exit(
        &mut socket, &mut framing, frozen_at, "999", 0,
    )).await.expect("client detects silence before 33 s while freeze remains active");
    assert!(proxy.frozen.load(Ordering::Relaxed));
    assert!(matches!(result, Outcome::Dead(after)
        if after >= Duration::from_secs(27) && after <= Duration::from_secs(33)),
        "frozen-server result: {result:?}");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

```

   Every harness helper is used in this task. The match above reads both `Completed(Duration)` and `Closed(Duration)` fields; do not suppress unused-item warnings.

- [ ] **Step 2: Run the harness**

Run: `cargo test -p bibcode-server --test rpc_liveness -- --nocapture 2>&1 | tail -15`
Expected: both the transfer matrix and frozen-server detection pass (`test result: ok. 2 passed`), in about 130–150 s.
- If a split or E2EE trial reports `Dead` or `Closed`, the server is not splitting, or a deadline is too tight. Debug Tasks 5–7; do not loosen the assertions.
- If only legacy 8 MiB trials fail with `Dead` under 27 s, the client model is wrong. Fix the harness.

- [ ] **Step 3: Lints**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 4: Checkpoint (no commit)**

Record `Task 8 <tree> rpc_liveness (duration)` in the ledger.

---

### Task 9: Live verification of Phase B (plain records and E2EE in a real browser)

No repository files change. Reuse `$LIVE` and the fixtures from Task 3. **Live checks run on the host by the controller; the Codex sandbox blocks loopback sockets, so the implementer only writes scripts.** Use Task 3's complete record-aware observer and new driver under `$S/liveness-live/` for both plain and E2EE.

**Files:**
- Uses (read-only): `$S/s2-liveness/pair-remote.mjs` for setup.
- Uses: `$LIVE/wswrap.js` and `$LIVE/measure.mjs`, whose complete source is in Task 3. The old `$S/s2-liveness/measure-e2ee.mjs` is not a completion oracle.

**Interfaces:**
- Consumes: Tasks 5–7 (records and negotiation) through a real Chromium socket.
- Produces: `$LIVE/results-b.jsonl`, `$LIVE/results-b-e2ee.jsonl`, and ledger entries.

- [ ] **Step 1: Restart the isolated dev server and the proxy**

Repeat Task 3 Steps 2–3 with fresh logs (`dev-b.log`, `proxy-b.jsonl`). The paired profile and the added fixtures persist in `$LIVE/home` and `$LIVE/profile`.

- [ ] **Step 2: Plain `/ws` trials**

Write `$LIVE/trials-b.json`:

```json
[
  {"label":"b-64k-hist-8m","fixture":"hist-8m","minBytes":8000000,"down":65536,"up":65536,"latency":20,"mode":"small","trigger":"ui","observe":180},
  {"label":"b-256k-hist-8m","fixture":"hist-8m","minBytes":8000000,"down":262144,"up":262144,"latency":20,"mode":"small","trigger":"ui","observe":70}
]
```

Run `$LIVE/measure.mjs` as in Task 3 Step 5, with `TRIALS=$LIVE/trials-b.json OUT=$LIVE/results-b.jsonl WSLOG=$LIVE/logs/wslog-b.jsonl`.
Expected: both lines `"completed":true,"disconnected":false`. `$LIVE/logs/wslog-b.jsonl` shows `"bin":true` receive events during the transfer (records). The initial HTTP upgrade in `$LIVE/logs/proxy-b.jsonl` shows `sec-websocket-protocol` in the logged headers.

- [ ] **Step 3: E2EE trials through a second server**

```bash
cd /work/workspaces/orca/BibCode/main-3
cargo build -p bibcode-server
mkdir -p $LIVE/home-remote
./target/debug/bibcode serve --host 127.0.0.1 --port 13990 --base-dir $LIVE/home-remote --no-browser \
  > $LIVE/logs/remote.log 2>&1 &
echo $! > $LIVE/logs/remote.pid
python3 $S/s2-liveness/throttle_proxy.py --listen 127.0.0.1:13991 --target 127.0.0.1:13990 \
  --control 127.0.0.1:13992 --log $LIVE/logs/proxy-e2ee.jsonl > $LIVE/logs/proxy-e2ee.out 2>&1 &
echo $! > $LIVE/logs/proxy-e2ee.pid
./target/debug/bibcode pairing offer --base-dir $LIVE/home-remote --name spike-remote --endpoint http://127.0.0.1:13991 \
  --reach this-computer --json > $LIVE/.offer.json
for n in 1m 8m; do cp -r $LIVE/fixtures/hist-$n $LIVE/fixtures/e2ee-hist-$n; done
D=$LIVE WEB=5804 SERVER_PORT=13844 PROXY_PORT=13981 EXTRA_PORTS=13991 NAMES=e2ee-hist-1m,e2ee-hist-8m \
  node $S/s2-liveness/pair-remote.mjs
```

Never print `.offer.json`; it holds a pairing link. Write `$LIVE/trials-b-e2ee.json`:

```json
[
  {"label":"e2ee-64k-e2ee-hist-8m","fixture":"e2ee-hist-8m","minBytes":8000000,"down":65536,"up":65536,"observe":180},
  {"label":"e2ee-256k-e2ee-hist-8m","fixture":"e2ee-hist-8m","minBytes":8000000,"down":262144,"up":262144,"observe":70}
]
```

Run:

```bash
D=$LIVE WEB=5804 SERVER_PORT=13844 PROXY_PORT=13981 EXTRA_PORTS=13991 CONTROL=127.0.0.1:13992 \
  TRIALS=$LIVE/trials-b-e2ee.json OUT=$LIVE/results-b-e2ee.jsonl WSLOG=$LIVE/logs/wslog-b-e2ee.jsonl \
  REMOTE_LABEL=spike-remote node $LIVE/measure.mjs
```

Expected: every trial has a successful, exact-content Exit and no close; a rendered commit label alone never passes. Before this plan, 10 of 12 throttled E2EE trials dropped at 6.8–7.0 s.

- [ ] **Step 4: Stop what you started and record**

Kill the proxy PIDs and the remote server PID from their pid files, and the dev runner group (`kill -- -$(cat $LIVE/logs/dev.pid)`). Record the result lines and screenshots under `Task 9` in the ledger.

---

## Phase C — Item 5: server heartbeat and reaper

### Task 10: Heartbeat Pings, silence reaping, 4408 logging, and the silent-client harness cases

**Files:**
- Modify: `apps/server/src/rpc/transport.rs` (`ConnectionLiveness`, `run_heartbeat`, writer Pings and progress, `log_peer_close`)
- Modify: `apps/server/src/rpc/session.rs` (liveness parameter, heartbeat task, plain reader, close logging)
- Modify: `apps/server/src/rpc/e2ee.rs` (inbound pump records activity, close logging, liveness hand-off)
- Modify: `apps/server/tests/rpc_liveness.rs` (server-side teardown observer and three freeze cases)
- Modify: `apps/server/src/auth/service.rs` (test-only live-connection row observer)
- Docs: `docs/architecture/remote.md`, `docs/architecture/rpc-and-orchestration.md`

**Interfaces:**
- Consumes (Task 5): `run_writer`, `write_message`, `write_queued_control`, `write_control`, `send_before`, `WRITE_PROGRESS_TIMEOUT`. Consumes (Task 8): `ThrottleProxy`, `open`, `request_bytes`, `wait_for_exit`, with successful exact-payload assertions.
- Produces:
  - `pub(crate) struct ConnectionLiveness` with `pub(crate) fn new() -> Arc<Self>` and `pub(crate) fn record_inbound(&self)`.
  - `pub(crate) const HEARTBEAT_PING_INTERVAL: Duration = 15 s` and `pub(crate) const HEARTBEAT_SILENCE_LIMIT: Duration = 45 s`.
  - `pub(crate) async fn run_heartbeat(liveness: Arc<ConnectionLiveness>, shutdown: CancellationToken)`.
  - `pub(crate) fn log_peer_close(frame: Option<&CloseFrame>)` and `pub(crate) const LIVENESS_CLOSE_CODE: u16 = 4408`.
  - New signatures:
    - `run_writer(sink, framing, liveness: Arc<ConnectionLiveness>, data, control, shutdown)`
    - `run_session_split_budgeted(socket_writer, framing, liveness: Arc<ConnectionLiveness>, socket_reader, registry, context, session_shutdown, outbound_budget)`

- [ ] **Step 1: Write the failing transport tests**

For the control-class regression, first add this test-only constructor in `impl RpcOutboundFrame` (`session.rs`); this is its first use:

```rust
    #[cfg(test)]
    pub(super) fn into_control(self) -> Result<Self, serde_json::Error> {
        let (message, budget) = self.into_wire()?.into_parts();
        Ok(Self { payload: RpcOutboundPayload::Control(message), _budget: budget })
    }
```

Append to `mod tests` in `apps/server/src/rpc/transport.rs`:

```rust
    #[tokio::test(start_paused = true)]
    async fn a_stopped_reader_is_reaped_within_fifty_seconds() {
        let liveness = ConnectionLiveness::new();
        let shutdown = CancellationToken::new();
        let started = Instant::now();
        let heartbeat = tokio::spawn(run_heartbeat(Arc::clone(&liveness), shutdown.clone()));
        tokio::time::sleep(Duration::from_secs(44)).await;
        assert!(!shutdown.is_cancelled(), "not before 45 s of silence");
        shutdown.cancelled().await;
        let elapsed = Instant::now() - started;
        assert!(
            elapsed >= HEARTBEAT_SILENCE_LIMIT && elapsed <= Duration::from_secs(50),
            "reaped after {elapsed:?}"
        );
        heartbeat.await.expect("heartbeat joins");
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_reader_making_progress_is_not_reaped() {
        let liveness = ConnectionLiveness::new();
        let shutdown = CancellationToken::new();
        let heartbeat = tokio::spawn(run_heartbeat(Arc::clone(&liveness), shutdown.clone()));
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_secs(10)).await;
            liveness.record_progress();
        }
        assert!(!shutdown.is_cancelled());
        shutdown.cancel();
        heartbeat.await.expect("heartbeat joins");
    }

    #[tokio::test(start_paused = true)]
    async fn the_heartbeat_asks_for_a_ping_every_fifteen_seconds() {
        let liveness = ConnectionLiveness::new();
        let shutdown = CancellationToken::new();
        let heartbeat = tokio::spawn(run_heartbeat(Arc::clone(&liveness), shutdown.clone()));
        tokio::time::sleep(Duration::from_secs(14)).await;
        assert!(!liveness.take_ping());
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(liveness.take_ping());
        assert!(!liveness.take_ping());
        liveness.record_inbound();
        tokio::time::sleep(Duration::from_secs(15)).await;
        assert!(liveness.take_ping());
        shutdown.cancel();
        heartbeat.await.expect("heartbeat joins");
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_check_does_not_charge_the_gap() {
        let liveness = ConnectionLiveness::new();
        let shutdown = CancellationToken::new();
        let heartbeat = tokio::spawn(run_heartbeat(Arc::clone(&liveness), shutdown.clone()));
        tokio::task::yield_now().await;
        // The runtime stalls for a minute (a suspended laptop), so the next check
        // fires 55 s late.
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        assert!(!shutdown.is_cancelled(), "the stalled minute is not silence");
        tokio::time::sleep(Duration::from_secs(50)).await;
        assert!(shutdown.is_cancelled(), "silence after the stall still counts");
        heartbeat.await.expect("heartbeat joins");
    }

    #[tokio::test(start_paused = true)]
    async fn the_writer_sends_a_requested_ping_between_records() {
        let liveness = ConnectionLiveness::new();
        let (sink, recorded) = recording_sink(Duration::from_secs(1));
        let (data_sender, data) = mpsc::channel(8);
        let (_control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        data_sender.try_send(response("1", 300 * 1024)).expect("queue frame");
        let writer = tokio::spawn(run_writer(
            sink,
            OutboundFraming::PlainRecords,
            Arc::clone(&liveness),
            data,
            control,
            CancellationToken::new(),
        ));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        liveness.request_ping();
        drop(data_sender);
        writer.await.expect("writer joins");
        let recorded = recorded.lock().expect("recorded frames");
        let ping_at = recorded
            .iter()
            .position(|message| matches!(message, Message::Ping(_)))
            .expect("a heartbeat ping");
        assert!(ping_at > 0 && ping_at < recorded.len() - 1, "the ping leaves between records");
    }

    #[tokio::test(start_paused = true)]
    async fn a_ping_write_is_not_progress() {
        let liveness = ConnectionLiveness::new();
        let (sink, recorded) = recording_sink(Duration::ZERO);
        let (_data_sender, data) = mpsc::channel::<RpcOutboundFrame>(1);
        let (_control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        let writer = tokio::spawn(run_writer(
            sink,
            OutboundFraming::Whole,
            Arc::clone(&liveness),
            data,
            control,
            CancellationToken::new(),
        ));
        tokio::time::sleep(Duration::from_secs(10)).await;
        liveness.request_ping();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(matches!(
            recorded.lock().expect("recorded frames").first(),
            Some(Message::Ping(_))
        ));
        assert_eq!(liveness.silent_for(Instant::now()), Duration::from_millis(10_010));
        writer.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn pong_and_interrupt_writes_are_not_heartbeat_progress() {
        let liveness = ConnectionLiveness::new();
        let (sink, recorded) = recording_sink(Duration::ZERO);
        let (_data_sender, data) = mpsc::channel(1);
        let (control_sender, control) = mpsc::channel(2);
        let shutdown = CancellationToken::new();
        let writer = tokio::spawn(run_writer(
            sink, OutboundFraming::Whole, Arc::clone(&liveness),
            data, control, shutdown.clone(),
        ));
        tokio::time::sleep(Duration::from_secs(10)).await;
        control_sender.try_send(ServerMessage::Pong).expect("Pong");
        control_sender.try_send(ServerMessage::interrupt(
            RequestId::try_from("1").expect("id"),
        )).expect("interrupt");
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(recorded.lock().expect("frames").len(), 2);
        assert_eq!(liveness.silent_for(Instant::now()), Duration::from_secs(11));
        shutdown.cancel();
        writer.await.expect("writer joins");
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_and_refilled_controls_yield_to_data_and_preserve_its_deadline() {
        let started = Instant::now();
        let recorded: Recorded = Arc::default();
        let sink_recorded = Arc::clone(&recorded);
        let sink = Box::pin(sink::unfold((), move |(), message: Message| {
            let recorded = Arc::clone(&sink_recorded);
            async move {
                let data = matches!(&message, Message::Binary(bytes)
                    if bytes.first().is_some_and(|flag| *flag != RECORD_FLAG_CONTROL));
                // 80 controls take 16 s: longer than the heartbeat interval.
                // Stall late in the transfer, when the aggregate deadline is
                // tighter than the deadline since the last data progress.
                if started.elapsed() >= Duration::from_secs(105) {
                    std::future::pending::<()>().await;
                }
                tokio::time::sleep(if data {
                    Duration::from_secs(1)
                } else {
                    Duration::from_millis(200)
                }).await;
                recorded.lock().expect("frames").push(message);
                Ok::<_, Infallible>(())
            }
        }));
        let (data_sender, data) = mpsc::channel(1);
        let (control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        data_sender.try_send(response("1", 1024 * 1024)).expect("queued data");
        for _ in 0..CONTROL_LANE_CAPACITY {
            control_sender.try_send(ServerMessage::Pong).expect("initial control snapshot");
        }
        let producer = tokio::spawn(async move {
            while control_sender.send(ServerMessage::Pong).await.is_ok() {}
        });
        let liveness = ConnectionLiveness::new();
        let shutdown = CancellationToken::new();
        let heartbeat = tokio::spawn(run_heartbeat(Arc::clone(&liveness), shutdown.clone()));
        let inbound_liveness = Arc::clone(&liveness);
        let inbound_shutdown = shutdown.clone();
        let inbound = tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = inbound_shutdown.cancelled() => return,
                    () = tokio::time::sleep(Duration::from_secs(5)) => inbound_liveness.record_inbound(),
                }
            }
        });
        let writer = tokio::spawn(run_writer(
            sink, OutboundFraming::PlainRecords, liveness, data, control, shutdown.clone(),
        ));
        timeout(Duration::from_secs(112), shutdown.cancelled()).await
            .expect("writer deadline fires despite inbound activity and continuous controls");
        // First snapshot takes 16 s; the 1 MiB message then gets about 94 s.
        assert!(started.elapsed() >= Duration::from_secs(110)
            && started.elapsed() < Duration::from_secs(111),
            "aggregate message deadline, not a new allowance per control: {:?}", started.elapsed());
        timeout(Duration::from_secs(1), writer).await.expect("bounded writer").expect("writer joins");
        timeout(Duration::from_secs(1), heartbeat).await.expect("bounded heartbeat").expect("heartbeat joins");
        timeout(Duration::from_secs(1), inbound).await.expect("bounded inbound").expect("inbound joins");
        timeout(Duration::from_secs(1), producer).await.expect("bounded producer").expect("producer joins");
        let frames = recorded.lock().expect("frames");
        assert!(flags(&frames).iter().filter(|flag| **flag != RECORD_FLAG_CONTROL).count() >= 2,
            "ready data must leave before another heartbeat/control snapshot");
        assert!(frames.iter().any(|frame| matches!(frame, Message::Ping(_))),
            "the real heartbeat was running");
    }

    #[tokio::test(start_paused = true)]
    async fn oversized_control_records_renew_neither_progress_clock() {
        let liveness = ConnectionLiveness::new();
        let started = Instant::now();
        let (sink, recorded) = recording_sink(Duration::from_secs(6));
        let (data_sender, data) = mpsc::channel(1);
        let (_control_sender, control) = mpsc::channel(CONTROL_LANE_CAPACITY);
        data_sender.try_send(response("1", 300 * 1024).into_control().expect("control"))
            .expect("oversized control on data queue");
        let shutdown = CancellationToken::new();
        let writer = tokio::spawn(run_writer(
            sink, OutboundFraming::PlainRecords, Arc::clone(&liveness), data, control, shutdown.clone(),
        ));
        timeout(Duration::from_secs(21), shutdown.cancelled()).await.expect("fixed progress bound");
        assert_eq!(started.elapsed(), WRITE_PROGRESS_TIMEOUT);
        assert_eq!(liveness.silent_for(Instant::now()), WRITE_PROGRESS_TIMEOUT);
        assert_eq!(recorded.lock().expect("frames").len(), 3, "accepted controls still do not count");
        timeout(Duration::from_secs(1), writer).await.expect("bounded writer").expect("writer joins");
    }

    #[test]
    fn a_4408_close_is_the_clients_liveness_timeout() {
        let liveness = CloseFrame {
            code: LIVENESS_CLOSE_CODE,
            reason: Utf8Bytes::from_static("liveness timeout"),
        };
        let normal = CloseFrame {
            code: 1000,
            reason: Utf8Bytes::from_static(""),
        };
        assert!(is_liveness_close(Some(&liveness)));
        assert!(!is_liveness_close(Some(&normal)));
        assert!(!is_liveness_close(None));
    }
```

- [ ] **Step 1a: Write the failing silent-client harness cases**

Append to `apps/server/tests/rpc_liveness.rs`. Teardown is observed on the server while the proxy remains frozen; no close needs to cross the frozen link.

```rust
async fn start_observed_server(
    temp: &TempDir,
) -> (ServerHandle, tokio::sync::mpsc::Receiver<()>, tokio::sync::mpsc::Receiver<Instant>) {
    let (started_tx, started) = tokio::sync::mpsc::channel(1);
    let (ended_tx, ended) = tokio::sync::mpsc::channel(1);
    let mut registry = RpcRegistry::empty();
    registry.register_unary("fixture.bytes", |request, _| async move {
        let bytes = request.payload["bytes"].as_u64().expect("bytes") as usize;
        Ok(json!({ "data": "x".repeat(bytes) }))
    });
    registry.register_stream("fixture.watch", move |_, cancellation| {
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        let started = started_tx.clone();
        let ended = ended_tx.clone();
        tokio::spawn(async move {
            started.send(()).await.expect("watch started");
            cancellation.cancelled().await;
            sender.closed().await;
            ended.send(Instant::now()).await.expect("watch teardown observed");
        });
        receiver
    });
    let handle = ServerRuntime::start_with_registry(
        ServerConfig::new(temp.path()).with_bind("127.0.0.1", 0).with_unsafe_no_auth(),
        registry,
    ).await.expect("observed server");
    (handle, started, ended)
}

async fn watch_session(socket: &mut TestSocket, framing: &mut Framing) {
    send_text(socket, framing, &json!({
        "_tag": "Request", "id": "100", "tag": "fixture.watch", "payload": {}, "headers": [],
    }).to_string()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reader_frozen_mid_transfer_is_dropped_by_the_server() {
    for mode in [Mode::PlainSplit, Mode::Encrypted] {
        let temp = TempDir::new().expect("temporary root");
        let (handle, mut started, mut ended) = start_observed_server(&temp).await;
        let proxy = ThrottleProxy::start(handle.local_addr(), 256 * KIB).await;
        let (mut socket, mut framing) = open(mode, proxy.address, &host_public_key(temp.path())).await;
        watch_session(&mut socket, &mut framing).await;
        started.recv().await.expect("subscription established");
        request_bytes(&mut socket, &mut framing, "1", 8 * MIB).await;
        sleep(Duration::from_secs(3)).await;
        proxy.freeze(true);
        let frozen_at = Instant::now();
        let closed_at = timeout(Duration::from_secs(33), ended.recv()).await
            .expect("session and subscription end within 33 s while frozen")
            .expect("teardown timestamp");
        assert!(proxy.frozen.load(Ordering::Relaxed));
        assert!(closed_at.duration_since(frozen_at) <= Duration::from_secs(33));
        handle.shutdown();
        handle.join().await.expect("server joins");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_client_that_goes_silent_is_reaped_by_the_heartbeat() {
    for mode in [Mode::PlainSplit, Mode::Encrypted] {
        let temp = TempDir::new().expect("temporary root");
        let (handle, mut started, mut ended) = start_observed_server(&temp).await;
        let proxy = ThrottleProxy::start(handle.local_addr(), 1024 * KIB).await;
        let (mut socket, mut framing) = open(mode, proxy.address, &host_public_key(temp.path())).await;
        watch_session(&mut socket, &mut framing).await;
        started.recv().await.expect("subscription established");
        request_bytes(&mut socket, &mut framing, "1", 1024).await;
        assert!(matches!(wait_for_exit(
            &mut socket, &mut framing, Instant::now(), "1", 1024,
        ).await, Outcome::Completed(_)));
        proxy.freeze(true);
        let frozen_at = Instant::now();
        let closed_at = timeout(Duration::from_secs(51), ended.recv()).await
            .expect("50 s idle bound plus 1 s scheduling tolerance")
            .expect("teardown timestamp");
        assert!(proxy.frozen.load(Ordering::Relaxed));
        assert!(closed_at.duration_since(frozen_at) <= Duration::from_secs(51));
        handle.shutdown();
        handle.join().await.expect("server joins");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_client_silent_for_thirty_seconds_is_kept() {
    let temp = TempDir::new().expect("temporary root");
    let (handle, mut started, mut ended) = start_observed_server(&temp).await;
    let proxy = ThrottleProxy::start(handle.local_addr(), 1024 * KIB).await;
    let (mut socket, mut framing) = open(Mode::PlainSplit, proxy.address, &[]).await;
    watch_session(&mut socket, &mut framing).await;
    started.recv().await.expect("subscription established");
    proxy.freeze(true);
    sleep(Duration::from_secs(30)).await;
    assert!(ended.try_recv().is_err(), "not reaped under the 45 s limit");
    proxy.freeze(false);
    request_bytes(&mut socket, &mut framing, "2", 1024).await;
    let result = wait_for_exit(&mut socket, &mut framing, Instant::now(), "2", 1024).await;
    assert!(matches!(result, Outcome::Completed(_)), "{result:?}");
    handle.shutdown();
    handle.join().await.expect("server joins");
}
```

Run before applying Step 3's heartbeat code:
`cargo test -p bibcode-server --test rpc_liveness an_idle_client_that_goes_silent`.
Expected: FAIL at the 51 s frozen deadline on the pre-heartbeat implementation.
The mid-transfer case already passes from Task 5's progress deadline.

- [ ] **Step 2: Confirm the red state**

Run: `cargo test -p bibcode-server --lib rpc::transport 2>&1 | tail -5`
Expected: compile errors (`ConnectionLiveness`, `run_heartbeat`, `is_liveness_close` not found; `run_writer` has the wrong arity).

- [ ] **Step 3: Implement liveness, heartbeat and writer changes in `transport.rs`**

1. Replace the imports at the top of `transport.rs` with:

```rust
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::extract::ws::{CloseFrame, Message};
use futures_util::{Sink, SinkExt};
use tokio::{
    sync::{Notify, mpsc},
    time::{Instant, MissedTickBehavior, timeout, timeout_at},
};
use tokio_util::sync::CancellationToken;
```

   Keep the `use super::{ … };` block unchanged. In `mod tests`, add `use axum::extract::ws::Utf8Bytes;`.

2. Add after `const GRACEFUL_CLOSE_TIMEOUT …;`:

```rust
/// Heartbeat Pings go out this often once the socket is authenticated.
pub(crate) const HEARTBEAT_PING_INTERVAL: Duration = Duration::from_secs(15);
/// A connection with no inbound frame and no accepted data write for this long ends.
pub(crate) const HEARTBEAT_SILENCE_LIMIT: Duration = Duration::from_secs(45);
const HEARTBEAT_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// A check that fires this much later than planned does not charge the gap.
const HEARTBEAT_LATE_TICK: Duration = Duration::from_secs(10);
/// Close code the client sends after its own liveness timeout.
pub(crate) const LIVENESS_CLOSE_CODE: u16 = 4408;

/// Activity shared by one connection's reader, writer and heartbeat.
pub(crate) struct ConnectionLiveness {
    origin: Instant,
    last_activity_ms: AtomicU64,
    ping_due: AtomicBool,
    wake_writer: Notify,
}

impl ConnectionLiveness {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            origin: Instant::now(),
            last_activity_ms: AtomicU64::new(0),
            ping_due: AtomicBool::new(false),
            wake_writer: Notify::new(),
        })
    }

    /// Any inbound frame, including WebSocket Ping, Pong and Close.
    pub(crate) fn record_inbound(&self) {
        self.touch();
    }

    /// Only accepted data writes count. Ping, Pong and interrupt/control writes never do.
    fn record_progress(&self) {
        self.touch();
    }

    fn touch(&self) {
        let elapsed = u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_activity_ms.fetch_max(elapsed, Ordering::Relaxed);
    }

    fn silent_for(&self, now: Instant) -> Duration {
        let last = self.origin
            + Duration::from_millis(self.last_activity_ms.load(Ordering::Relaxed));
        now.saturating_duration_since(last)
    }

    fn request_ping(&self) {
        self.ping_due.store(true, Ordering::Release);
        self.wake_writer.notify_one();
    }

    fn take_ping(&self) -> bool {
        self.ping_due.swap(false, Ordering::AcqRel)
    }
}

/// Asks the writer for a WebSocket Ping every 15 s and ends the session after
/// 45 s with no inbound frame and no accepted data write. Checks run every 5 s, so
/// a peer that stops reading is reaped within 50 s. A check that fires more
/// than 10 s late (the process was suspended or starved) restarts the silence
/// clock and pings at once instead of charging time the process did not run.
pub(crate) async fn run_heartbeat(liveness: Arc<ConnectionLiveness>, shutdown: CancellationToken) {
    let mut checks = tokio::time::interval(HEARTBEAT_CHECK_INTERVAL);
    checks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    checks.tick().await;
    let mut previous_check = Instant::now();
    let mut next_ping = previous_check + HEARTBEAT_PING_INTERVAL;
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
            _ = checks.tick() => {}
        }
        let now = Instant::now();
        if now.saturating_duration_since(previous_check)
            > HEARTBEAT_CHECK_INTERVAL + HEARTBEAT_LATE_TICK
        {
            liveness.touch();
            next_ping = now;
        }
        previous_check = now;
        if liveness.silent_for(now) >= HEARTBEAT_SILENCE_LIMIT {
            tracing::info!("RPC peer silent for 45 s; ending the session");
            shutdown.cancel();
            return;
        }
        if now >= next_ping {
            liveness.request_ping();
            next_ping = now + HEARTBEAT_PING_INTERVAL;
        }
    }
}

fn is_liveness_close(frame: Option<&CloseFrame>) -> bool {
    frame.is_some_and(|frame| frame.code == LIVENESS_CLOSE_CODE)
}

/// Logs a close frame from the client. Code 4408 is the client's liveness
/// timeout and is logged at info level so it stands apart from a clean close.
pub(crate) fn log_peer_close(frame: Option<&CloseFrame>) {
    if is_liveness_close(frame) {
        tracing::info!(
            close_code = LIVENESS_CLOSE_CODE,
            "RPC client closed the connection after its liveness timeout"
        );
    } else {
        tracing::debug!(
            close_code = frame.map(|frame| frame.code),
            "RPC client closed the connection"
        );
    }
}
```

3. Add a `Ping` wake-up variant to `WriterStep`; it requests a snapshot, never an out-of-band write:

```rust
enum WriterStep {
    Control(ServerMessage),
    Data(RpcOutboundFrame),
    Ping,
}
```

4. Replace `run_writer` with the following. A snapshot includes only controls and a heartbeat Ping pending at entry. After it drains, biased selection checks data first. An idle control send is a one-record turn; the next selection again checks data before any further control service.

```rust
pub(crate) async fn run_writer<S>(
    mut sink: S,
    framing: OutboundFraming,
    liveness: Arc<ConnectionLiveness>,
    mut data: mpsc::Receiver<RpcOutboundFrame>,
    mut control: mpsc::Receiver<ServerMessage>,
    shutdown: CancellationToken,
) where
    S: Sink<Message> + Unpin,
{
    let result: Result<(), TransportError> = async {
        let mut service_snapshot = true;
        loop {
            if service_snapshot {
                tokio::select! {
                    () = shutdown.cancelled() => return Ok(()),
                    result = write_queued_control(
                        &mut sink, &framing, &liveness, Some(&mut control),
                        Instant::now() + WRITE_PROGRESS_TIMEOUT, false,
                    ) => result?,
                }
            }
            let step = tokio::select! {
                biased;
                () = shutdown.cancelled() => return Ok(()),
                frame = data.recv() => match frame {
                    Some(frame) => WriterStep::Data(frame),
                    None => return Ok(()),
                },
                () = liveness.wake_writer.notified() => WriterStep::Ping,
                Some(message) = control.recv() => WriterStep::Control(message),
            };
            if matches!(&step, WriterStep::Ping) {
                service_snapshot = true;
                continue;
            }
            // After an idle control write, select ready data immediately.
            // After data, another finite snapshot is allowed.
            service_snapshot = matches!(&step, WriterStep::Data(_));
            let write = async {
                match step {
                    WriterStep::Control(message) => write_control(
                        &mut sink, &framing, message,
                        Instant::now() + WRITE_PROGRESS_TIMEOUT, false,
                    ).await,
                    WriterStep::Data(frame) => {
                        let is_data = !frame.is_control();
                        let frame = frame.into_wire().map_err(|_| TransportError::Encode)?;
                        let (message, _budget) = frame.into_parts();
                        write_message(
                            &mut sink, &framing, &liveness, message, is_data, Some(&mut control),
                        ).await
                    }
                    WriterStep::Ping => unreachable!("Ping requests the next snapshot"),
                }
            };
            tokio::select! {
                () = shutdown.cancelled() => return Ok(()),
                result = write => result?,
            }
        }
    }.await;
    match result {
        Ok(()) => {
            let _ = timeout(GRACEFUL_CLOSE_TIMEOUT, sink.close()).await;
        }
        Err(error) => {
            tracing::info!(?error, "RPC writer gave up; ending the session");
            shutdown.cancel();
        }
    }
}
```

5. Replace `write_message` with this complete version. Oversized controls retain `is_data == false` through normal framing. Their accepted records renew neither the 20-second data-progress deadline nor the heartbeat clock:

```rust
async fn write_message<S>(
    sink: &mut S,
    framing: &OutboundFraming,
    liveness: &ConnectionLiveness,
    message: Message,
    is_data: bool,
    mut control: Option<&mut mpsc::Receiver<ServerMessage>>,
) -> Result<(), TransportError>
where
    S: Sink<Message> + Unpin,
{
    let length = match &message {
        Message::Text(text) => text.len(),
        Message::Binary(bytes) => bytes.len(),
        Message::Ping(_) | Message::Pong(_) | Message::Close(_) => return Ok(()),
    };
    let deadline = message_deadline(Instant::now(), length);
    let mut data_deadline = Instant::now() + WRITE_PROGRESS_TIMEOUT;
    if !framing.splits(length) {
        send_before(sink, message, if is_data { deadline } else { deadline.min(data_deadline) }).await?;
        if is_data { liveness.record_progress(); }
        return Ok(());
    }
    let payload: &[u8] = match &message {
        Message::Text(text) => text.as_bytes(),
        Message::Binary(bytes) => bytes,
        Message::Ping(_) | Message::Pong(_) | Message::Close(_) => return Ok(()),
    };
    let records = plaintext_records(payload).map_err(|_| TransportError::Encode)?;
    for (index, (flag, chunk)) in records.enumerate() {
        if index > 0 {
            let lane = if framing.interleaves() { control.as_deref_mut() } else { None };
            write_queued_control(
                sink, framing, liveness, lane, deadline.min(data_deadline), true,
            ).await?;
        }
        let record = framing.record(flag, chunk)?;
        send_before(sink, record, deadline.min(data_deadline)).await?;
        if is_data {
            data_deadline = Instant::now() + WRITE_PROGRESS_TIMEOUT;
            liveness.record_progress();
        }
    }
    Ok(())
}
```

6. Replace `write_queued_control` with a single snapshot of both control sources. Keep `write_control` and `send_before` unchanged. No deferred-control vector or separate `write_ping` helper is needed:

```rust
async fn write_queued_control<S>(
    sink: &mut S,
    framing: &OutboundFraming,
    liveness: &ConnectionLiveness,
    mut control: Option<&mut mpsc::Receiver<ServerMessage>>,
    deadline: Instant,
    interleaved: bool,
) -> Result<(), TransportError>
where
    S: Sink<Message> + Unpin,
{
    let queued_at_start = control.as_ref().map_or(0, |lane| lane.len());
    let ping_at_start = liveness.take_ping();
    if ping_at_start {
        send_before(sink, Message::Ping(Default::default()),
            deadline.min(Instant::now() + WRITE_PROGRESS_TIMEOUT)).await?;
    }
    if let Some(control) = control.as_mut() {
        for _ in 0..queued_at_start {
            let Ok(message) = control.try_recv() else { break };
            write_control(sink, framing, message, deadline, interleaved).await?;
        }
    }
    Ok(())
}
```

7. Insert `ConnectionLiveness::new(),` as the third argument in **every Task 5** `run_writer` test call, including `write_all`, both ordering tests, both original timeout tests, `control_writes_cannot_renew_the_data_progress_deadline`, and `refilled_controls_allow_data_and_do_not_extend_the_message_deadline`. The new Task 10 tests already use that arity.

- [ ] **Step 4: Wire liveness through `session.rs` and `e2ee.rs`**

`session.rs`:
1. Extend the transport import: `transport::{self, CHUNKED_RPC_SUBPROTOCOL, CONTROL_LANE_CAPACITY, ConnectionLiveness, OutboundFraming},`.
2. In `run_session`, replace the two lines that split and map the socket and the `run_session_split_budgeted` call with:

```rust
    let liveness = ConnectionLiveness::new();
    let (socket_writer, socket_reader) = socket.split();
    let reader_liveness = Arc::clone(&liveness);
    let socket_reader = socket_reader.map(move |frame| {
        if frame.is_ok() {
            reader_liveness.record_inbound();
        }
        frame.map(RpcInboundFrame::plain)
    });
    run_session_split_budgeted(
        socket_writer,
        framing,
        liveness,
        socket_reader,
        registry,
        context,
        session_shutdown,
        None,
    )
    .await;
```

3. In `run_session_split_budgeted`:
   - Add the parameter `liveness: Arc<ConnectionLiveness>,` after `framing: OutboundFraming,`.
   - Add `#[allow(clippy::too_many_arguments, reason = "Explicit shared session transport handoff")]` directly on `run_session_split_budgeted` when its signature grows to eight arguments.
   - Replace the writer spawn with:

```rust
    let mut writer = tokio::spawn(transport::run_writer(
        socket_writer,
        framing,
        Arc::clone(&liveness),
        outbound_receiver,
        control_receiver,
        session_shutdown.clone(),
    ));
    let mut heartbeat = tokio::spawn(transport::run_heartbeat(liveness, session_shutdown.clone()));
```

   - After the final writer join (`if timeout(PUMP_JOIN_TIMEOUT, &mut writer).await.is_err() { … }`), add:

```rust
    if timeout(PUMP_JOIN_TIMEOUT, &mut heartbeat).await.is_err() {
        heartbeat.abort();
        let _ = heartbeat.await;
    }
```

   - In the read loop, replace `Message::Close(_) => break,` with:

```rust
                        Message::Close(frame) => {
                            transport::log_peer_close(frame.as_ref());
                            break;
                        }
```

4. Tests: insert `ConnectionLiveness::new(),` as the third argument in every `run_session_split_budgeted(` call in `mod tests`.

`e2ee.rs`:
1. Extend the imports: `transport::{ConnectionLiveness, E2EE_INTERLEAVE_FEATURE, OutboundFraming, log_peer_close},`.
2. In `run_established_e2ee`, directly after `let channel = Arc::new(Mutex::new(channel));` add `let liveness = ConnectionLiveness::new();` and `let inbound_liveness = Arc::clone(&liveness);`.
3. In the inbound pump loop, directly after the `let frame = match &assembly { … };` statement, add:

```rust
            if frame.is_ok() {
                inbound_liveness.record_inbound();
            }
```

   Then replace the arm `Ok(Message::Close(_)) | Err(_) | Ok(Message::Text(_)) => break,` with:

```rust
                Ok(Message::Close(close)) => {
                    log_peer_close(close.as_ref());
                    break;
                }
                Err(_) | Ok(Message::Text(_)) => break,
```

4. Pass `liveness` as the third argument of `run_session_split_budgeted(ws_writer, OutboundFraming::Encrypted { … }, liveness, reader_stream, …)`.
5. Tests: in `run_encrypted_writer` and `interleave_sends_control_records_between_encrypted_records`, insert `ConnectionLiveness::new(),` as the third argument of `run_writer(`.

- [ ] **Step 4a: E2EE cleanup on reap (test first)**

Add `apps/server/src/auth/service.rs` to this task's files (test-only observation).
In `rpc/e2ee.rs::tests`, write this test before generalizing the session signature. It registers `subscribeServerConfig`, whose `orchestration:read` scope is declared in `apps/server/src/auth/scope.rs:63` (the dispatch guard is `session.rs:918–928`). The desktop bootstrap principal has that scope. Every wait is bounded; a bad method now fails at the one-second startup assertion instead of hanging. The 60-second reader guard exceeds the 51-second reap assertion, so EOF cannot make the test pass.

```rust
    #[tokio::test(start_paused = true)]
    async fn heartbeat_reap_releases_permits_live_row_and_subscriptions() {
        let config = ServerConfig::new(".").with_bind("127.0.0.1", 3773)
            .with_desktop("desktop-test-seed").expect("config");
        let auth = AuthService::new(&config, vec![7_u8; 32]);
        let issued = timeout(Duration::from_secs(1), auth.exchange_bootstrap(
            "desktop-test-seed", None, e2ee_client_metadata(), None, SessionTransport::E2ee,
        )).await.expect("bounded bootstrap").expect("session");
        let principal = timeout(Duration::from_secs(1),
            auth.authenticate_token(&issued.token, SessionTransport::E2ee))
            .await.expect("bounded authentication").expect("principal");
        let session_id = principal.session_id.clone();
        let budget = E2eeResourceBudget::new(1, 1, 1024, 1024, 1024);
        let permit = budget.try_reserve().expect("global permit")
            .bind_principal(&session_id).expect("principal permit");
        let started = CancellationToken::new();
        let closed = CancellationToken::new();
        let mut registry = RpcRegistry::empty();
        let handler_started = started.clone();
        let handler_closed = closed.clone();
        registry.register_stream("subscribeServerConfig", move |_, cancellation| {
            let (sender, receiver) = tokio::sync::mpsc::channel(1);
            let started = handler_started.clone();
            let closed = handler_closed.clone();
            tokio::spawn(async move {
                started.cancel();
                timeout(Duration::from_secs(55), cancellation.cancelled()).await
                    .expect("bounded subscription cancellation");
                timeout(Duration::from_secs(1), sender.closed()).await
                    .expect("bounded subscription receiver closure");
                closed.cancel();
            });
            receiver
        });
        let (mut initiator, channel) = timeout(Duration::from_secs(1), establish())
            .await.expect("bounded Noise setup");
        let request = serde_json::json!({
            "_tag": "Request", "id": "1", "tag": "subscribeServerConfig", "payload": {}, "headers": [],
        }).to_string();
        let records = initiator_encrypt(&mut initiator, &[record(0x00, request.as_bytes())]);
        let (inbound, receiver) = tokio::sync::mpsc::channel(1);
        let reader = futures_util::stream::unfold(receiver, |mut receiver| async {
            timeout(Duration::from_secs(60), receiver.recv()).await.ok().flatten()
                .map(|frame| (Ok::<_, axum::Error>(frame), receiver))
        });
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_established_e2ee(
            futures_util::sink::drain(), Box::pin(reader), channel,
            EstablishedE2eeAdmission {
                accept: E2eeAccept::Authenticated { principal, minted: None },
                _permit: permit,
            },
            true, auth.clone(), registry, shutdown,
        ));
        timeout(Duration::from_secs(1), inbound.send(Message::Binary(records[0].clone().into())))
            .await.expect("bounded request send").expect("watch request");
        timeout(Duration::from_secs(1), started.cancelled()).await
            .expect("authorized stream handler starts");
        assert_eq!(timeout(Duration::from_secs(1),
            auth.live_connection_count_for_test(&session_id)).await.expect("bounded live-row read"), 1);
        assert!(budget.try_reserve().is_err(), "established permit held while live");
        let frozen_at = Instant::now(); // keep reader open, deliver no more frames
        let cleanup_deadline = frozen_at + Duration::from_secs(51);
        timeout_at(cleanup_deadline, session).await
            .expect("reaped within 50 s plus 1 s scheduling tolerance").expect("session joins");
        timeout_at(cleanup_deadline, closed.cancelled()).await
            .expect("subscription receiver closed within the same freeze bound");
        assert_eq!(timeout_at(cleanup_deadline,
            auth.live_connection_count_for_test(&session_id)).await.expect("bounded live-row read"), 0,
            "the live-connection row is gone");
        assert!(budget.try_reserve().expect("global permit released")
            .bind_principal(&session_id).is_ok(), "principal permit released");
        assert!(frozen_at.elapsed() <= Duration::from_secs(51));
        drop(inbound);
    }
```

Run: `cargo test -p bibcode-server --lib rpc::e2ee::tests::heartbeat_reap_releases`.
Expected: FAIL to compile (observation method missing and concrete WebSocket halves).

In `AuthService`'s impl in `auth/service.rs`, add the test-only observer:

```rust
    #[cfg(test)]
    pub(crate) async fn live_connection_count_for_test(&self, session_id: &str) -> usize {
        self.state.lock().await.live_connections.get(session_id).map_or(0, HashMap::len)
    }
```

Replace only `run_established_e2ee`'s signature with the following; keep its body,
including the Task 6 interleave negotiation and Task 10 liveness wiring:

```rust
async fn run_established_e2ee<W, R>(
    mut ws_writer: W,
    mut ws_reader: R,
    channel: E2eeChannel,
    admission: EstablishedE2eeAdmission,
    interleave: bool,
    auth: AuthService,
    registry: RpcRegistry,
    session_shutdown: CancellationToken,
) where
    W: futures_util::Sink<Message> + Unpin + Send + 'static,
    R: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin + Send + 'static,
{
```

Run the same focused command. Expected: PASS with all three cleanup assertions.
No production inspection API is added.

- [ ] **Step 5: Run the unit suites**

Run:
- `cargo test -p bibcode-server --lib rpc::transport`
- `cargo test -p bibcode-server --lib rpc::session`
- `cargo test -p bibcode-server --lib rpc::e2ee`

Expected: all `test result: ok.`.

- [ ] **Step 6: Re-run the silent-client harness cases**

Run: `cargo test -p bibcode-server --test rpc_liveness an_idle_client_that_goes_silent`.
Expected: PASS, with teardown asserted before thaw for both plain and E2EE.

- [ ] **Step 7: Run the harness**

Run: `cargo test -p bibcode-server --test rpc_liveness -- --nocapture 2>&1 | tail -12`
Expected: five tests pass (`test result: ok. 5 passed`), in about 150 s wall time because the tests run in parallel. The transfer matrix must still pass: slow readers that make progress are not reaped.

- [ ] **Step 8: Lints and the broader server suites**

Run:
- `cargo fmt --all --check`
- `cargo clippy -p bibcode-server --all-targets -- -D warnings`
- `cargo test -p bibcode-server --test rpc_wire --test e2ee_ws --test production_control`

Expected: clean and passing. Classify any unrelated failure per the flake rules.

- [ ] **Step 9: Update the living docs**

1. `docs/architecture/remote.md`: insert a new paragraph directly before the paragraph that starts "Together, these limits preserve the 65,535-byte ciphertext record ceiling":

```markdown
Once a socket is authenticated (plain `/ws` after the upgrade, E2EE after
`e2ee_authenticated`; pre-auth keeps its 10-second deadline), the connection's
writer sends a WebSocket Ping every 15 seconds between frames or records. Every
inbound frame, including the browser's automatic Pong, and every data write
the socket accepts counts as activity. No control write (Ping, Pong, interrupt,
admission terminal or protocol error) counts as data progress.
When 45 seconds pass without activity (checked every 5 seconds, so a stopped
reader is reaped within 50 seconds), the session ends and frees its E2EE
permits, live-connection row, and subscriptions. A check that fires more than 10
seconds late, because the process was suspended, restarts the silence clock
instead of reaping. A client close with code 4408, the client's liveness
timeout, is logged at info level; other client closes are logged at debug level.
```

2. `docs/architecture/rpc-and-orchestration.md`: append to the writer paragraph from Task 5 the sentence "The writer also sends the heartbeat's WebSocket Ping between frames or records; see [Remote environments](./remote.md)."

- [ ] **Step 10: Checkpoint (no commit)**

Record `Task 10 <tree> rpc::transport/session/e2ee + rpc_liveness (5) + rpc_wire + e2ee_ws` in the ledger.

---

## Phase D — Items 6, 7, 8, 9: damage limits and copy

### Task 11: An oversized response fails one request with a typed error

**Files:**
- Create: `packages/contracts/src/rpcTransport.ts`
- Test: `packages/contracts/src/rpcTransport.test.ts`
- Modify: `packages/contracts/src/index.ts` (export)
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts` (static fixture)
- Test: `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts` (390 fixtures)
- Generated: `packages/contracts/fixtures/rpc-wire/exit-response-too-large.json`, `packages/contracts/fixtures/rpc-wire/manifest.json`
- Create: `packages/client-runtime/src/rpc/transportErrors.ts`
- Test: `packages/client-runtime/src/rpc/transportErrors.test.ts`
- Modify: `packages/client-runtime/src/rpc/protocol.ts`
- Modify: `packages/client-runtime/src/rpc/session.ts` (`mapInitialConfigError`)
- Test: `packages/client-runtime/src/rpc/session.test.ts`
- Modify: `apps/server/src/rpc/transport.rs` (`MAX_RECORDED_MESSAGE_BYTES`, `max_message_bytes`)
- Modify: `apps/server/src/rpc/session.rs` (`SendFailure`, message limit, request-scoped failure, test rename)
- Docs: `docs/architecture/remote.md`, `docs/architecture/rpc-and-orchestration.md`

**Interfaces:**
- Consumes: `RpcOutboundQueue`, `send_server_message`, `reserve_server_message`, `run_unary/run_stream/run_latest_stream` (session.rs); `OutboundFraming` (Task 5).
- Produces:
  - TS: `export class RpcResponseTooLargeError` (fields `method: string`, `bytes: number`, `limitBytes: number`; `message` = "This result is too large to send (<size>; limit 64 MiB).").
  - TS: `export class RpcTransportErrors extends RpcMiddleware.Service<RpcTransportErrors>()(…, { error: RpcResponseTooLargeError })`.
  - Rust: `enum SendFailure { Rejected, TooLarge { bytes, limit } }`, `fn response_too_large_failure(method: &str, bytes: usize, limit_bytes: usize) -> Value`, `RpcOutboundQueue.max_message_bytes: Option<usize>`, `fn RpcOutboundQueue::message_limit(&self) -> Option<usize>`.
  - Rust: `pub(crate) const MAX_RECORDED_MESSAGE_BYTES: usize = 64 MiB`, `pub(crate) fn OutboundFraming::max_message_bytes(&self) -> Option<usize>`.

- [ ] **Step 1: Contract schema (test first)**

Create `packages/contracts/src/rpcTransport.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RpcResponseTooLargeError } from "./rpcTransport.ts";

describe("RpcResponseTooLargeError", () => {
  it("says how large the result was and what the limit is", () => {
    const error = new RpcResponseTooLargeError({
      method: "gitManager.getCommits",
      bytes: 70_000_000,
      limitBytes: 67_108_864,
    });
    expect(error.message).toBe("This result is too large to send (66.8 MiB; limit 64 MiB).");
  });

  it("encodes to the wire shape the Rust server sends", () => {
    const encoded = Schema.encodeSync(RpcResponseTooLargeError)(
      new RpcResponseTooLargeError({ method: "m", bytes: 1, limitBytes: 2 }),
    );
    expect(encoded).toEqual({
      _tag: "RpcResponseTooLargeError",
      method: "m",
      bytes: 1,
      limitBytes: 2,
    });
  });
});
```

Run: `vp test run packages/contracts/src/rpcTransport.test.ts`
Expected: FAIL (module missing).

Create `packages/contracts/src/rpcTransport.ts`:

```ts
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

const MEBIBYTE = 1024 * 1024;

const formatMebibytes = (bytes: number): string => {
  const mebibytes = bytes / MEBIBYTE;
  return `${Number.isInteger(mebibytes) ? mebibytes.toFixed(0) : mebibytes.toFixed(1)} MiB`;
};

/**
 * The server could not send a response because it exceeds the connection's
 * message limit. Only the request that produced it fails; the connection
 * stays open. Every RPC method can end with it.
 */
export class RpcResponseTooLargeError extends Schema.TaggedError<RpcResponseTooLargeError>()(
  "RpcResponseTooLargeError",
  {
    method: Schema.String,
    bytes: NonNegativeInt,
    limitBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `This result is too large to send (${formatMebibytes(this.bytes)}; limit ${formatMebibytes(this.limitBytes)}).`;
  }
}
```

In `packages/contracts/src/index.ts`, add `export * from "./rpcTransport.ts";` directly before `export * from "./rpc.ts";`.

Run: `vp test run packages/contracts/src/rpcTransport.test.ts`
Expected: PASS.

- [ ] **Step 2: Static wire fixture**

First update `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts` (current line 114), adding the presence assertion beside the count:

```ts
    expect(manifest.fixtures).toHaveLength(390);
    expect(manifest.fixtures).toContain("exit-response-too-large.json");
```

Run: `vp test run packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
Expected: FAIL (389 fixtures before the new fixture is exported). Method count, typed-failure count and schema fingerprint count do not change: this is a static wire fixture.

In `packages/contracts/scripts/export-rust-rpc-fixtures.ts`:
1. Add `import { RpcResponseTooLargeError } from "../src/rpcTransport.ts";` after the `../src/rpc.ts` import.
2. Inside `const fixtures = { … }`, after the `"exit-interrupt"` entry, add:

```ts
  "exit-response-too-large": {
    _tag: "Exit",
    requestId,
    exit: {
      _tag: "Failure",
      cause: [
        {
          _tag: "Fail",
          error: Schema.encodeSync(RpcResponseTooLargeError)(
            new RpcResponseTooLargeError({
              method: "gitManager.getCommits",
              bytes: 70_000_000,
              limitBytes: 67_108_864,
            }),
          ),
        },
      ],
    },
  } satisfies RpcMessage.ResponseExitEncoded,
```

Run: `node packages/contracts/scripts/export-rust-rpc-fixtures.ts`
Expected: exit 0. `packages/contracts/fixtures/rpc-wire/exit-response-too-large.json` exists, and `manifest.json` lists it under `fixtures`.

Run: `vp test run packages/contracts/scripts/export-rust-rpc-fixtures.test.ts` and `git status --short -- packages/contracts/fixtures`.
Expected: tests PASS, the new fixture appears as `??` in status and `manifest.json` is modified. Untracked files never appear in ordinary `git diff --stat`.

- [ ] **Step 3: Server — failing tests first**

In `apps/server/src/rpc/session.rs` `mod tests`:

1. Rename `response_larger_than_the_connection_budget_fails_the_session_closed` to `response_larger_than_the_connection_budget_fails_only_its_request` and replace its body with:

```rust
        let response = Arc::new("x".repeat(2 * 1024));
        let (enqueued, mut enqueue_events) = mpsc::unbounded_channel();
        let mut registry = RpcRegistry::empty();
        registry.register_guarded_unary(
            "test.oversizedResponse",
            move |_request, _cancellation| {
                let response = Arc::clone(&response);
                let enqueued = enqueued.clone();
                async move {
                    RpcUnaryResult::guarded(
                        Ok(json!({ "value": response.as_str() })),
                        EnqueueNotification(enqueued),
                    )
                }
            },
        );
        registry.register_unary("test.small", |_request, _cancellation| async {
            Ok(json!({ "ok": true }))
        });
        let recorded = Arc::new(std::sync::Mutex::new(Vec::<Message>::new()));
        let sink_recorded = Arc::clone(&recorded);
        let sink = Box::pin(futures_util::sink::unfold((), move |(), message: Message| {
            let recorded = Arc::clone(&sink_recorded);
            async move {
                recorded.lock().expect("recorded frames").push(message);
                Ok::<_, Infallible>(())
            }
        }));
        let (inbound_sender, inbound_receiver) = mpsc::channel(1);
        let reader = stream::unfold(inbound_receiver, |mut receiver| async {
            receiver.recv().await.map(|item| (Ok(item), receiver))
        });
        let shutdown = CancellationToken::new();
        let session = tokio::spawn(run_session_split_budgeted(
            sink,
            OutboundFraming::Whole,
            ConnectionLiveness::new(),
            reader,
            registry,
            RpcSessionContext::unauthenticated(),
            shutdown.clone(),
            Some(RpcOutboundBudget::new(
                RpcOutboundProcessBudget::new(4 * 1024),
                1024,
            )),
        ));
        inbound_sender
            .send(request_frame(&["1"], "test.oversizedResponse"))
            .await
            .expect("send oversized response request");
        inbound_sender
            .send(request_frame(&["2"], "test.small"))
            .await
            .expect("send small request");

        let frames = timeout(Duration::from_secs(2), async {
            loop {
                let frames: Vec<Value> = recorded
                    .lock()
                    .expect("recorded frames")
                    .iter()
                    .filter_map(|message| match message {
                        Message::Text(text) => serde_json::from_str(text).ok(),
                        _ => None,
                    })
                    .collect();
                if frames.len() >= 2 {
                    return frames;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("both requests are answered");
        assert!(!shutdown.is_cancelled(), "an oversized response keeps the session open");
        assert!(enqueue_events.try_recv().is_err(), "the oversized response is never enqueued");
        let oversized = frames
            .iter()
            .find(|frame| frame["requestId"] == "1")
            .expect("a failure for request 1");
        let error = &oversized["exit"]["cause"][0]["error"];
        assert_eq!(error["_tag"], "RpcResponseTooLargeError");
        assert_eq!(error["method"], "test.oversizedResponse");
        assert_eq!(error["limitBytes"], 1024);
        assert!(error["bytes"].as_u64().is_some_and(|bytes| bytes > 1024));
        let small = frames
            .iter()
            .find(|frame| frame["requestId"] == "2")
            .expect("a response for request 2");
        assert_eq!(small["exit"]["_tag"], "Success");
        shutdown.cancel();
        drop(inbound_sender);
        timeout(Duration::from_secs(2), session)
            .await
            .expect("session cleanup deadline")
            .expect("session joins");
```

2. Add:

```rust
    #[tokio::test]
    async fn record_framed_plain_sessions_refuse_messages_over_the_limit() {
        let (sender, _receiver) = mpsc::channel(1);
        let (control, _control_receiver) = mpsc::channel(CONTROL_LANE_CAPACITY);
        let outbound = RpcOutboundQueue {
            sender,
            control,
            budget: None,
            max_message_bytes: Some(1024),
        };
        let failure = send_server_message(
            &outbound,
            &CancellationToken::new(),
            ServerMessage::success(
                RequestId::try_from("1").expect("request id"),
                Some(json!({ "data": "x".repeat(2048) })),
            ),
        )
        .await;
        assert!(
            matches!(failure, Err(SendFailure::TooLarge { limit: 1024, bytes }) if bytes > 2048),
            "{failure:?}"
        );
    }

    #[test]
    fn response_too_large_failure_matches_the_typescript_wire_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/rpc-wire/exit-response-too-large.json"
        ))
        .expect("fixture JSON");
        let message = ServerMessage::failure(
            RequestId::try_from("900719925474099312345").expect("request id"),
            response_too_large_failure("gitManager.getCommits", 70_000_000, 67_108_864),
        );
        assert_eq!(serde_json::to_value(message).expect("message JSON"), fixture);
    }
```

3. Add `max_message_bytes: None,` to every `RpcOutboundQueue { … }` literal in `mod tests`: `unbudgeted_outbound`, `stream_admission_expiry_delivers_a_terminal_failure`, `latest_stream_cancellation_delivers_an_interrupt_past_queued_budget_waiters`, `byte_and_queue_admission_share_one_five_second_deadline`.

4. In `byte_and_queue_admission_share_one_five_second_deadline` (`session.rs:2170`, final assertion currently at line 2200), replace its `Err(())` assertion with:

```rust
        assert_eq!(send.await.expect("send task joins"), Err(SendFailure::Rejected));
```

Keep the 4 s + 999 ms + 1 ms admission timing assertions. Run `cargo test -p bibcode-server --lib rpc::session::tests::byte_and_queue_admission_share_one_five_second_deadline` before and after Step 4: first a missing `SendFailure` compile error, then PASS with rejection at the same shared five-second deadline.

Run: `cargo test -p bibcode-server --lib rpc::session 2>&1 | tail -5`
Expected: compile errors (`SendFailure`, `max_message_bytes`, `response_too_large_failure` not found). This is the red state for the new API.

- [ ] **Step 4: Server — implement request-scoped oversize failures**

`transport.rs`: add after `PLAIN_WHOLE_MESSAGE_MAX_BYTES`:

```rust
/// Largest message a record-reassembling client accepts (64 MiB).
pub(crate) const MAX_RECORDED_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
```

   and inside `impl OutboundFraming`:

```rust
    /// The largest message the peer can reassemble; `None` for whole frames.
    pub(crate) fn max_message_bytes(&self) -> Option<usize> {
        match self {
            Self::Whole => None,
            Self::PlainRecords | Self::Encrypted { .. } => Some(MAX_RECORDED_MESSAGE_BYTES),
        }
    }
```

`session.rs`:
1. `struct RpcOutboundQueue`: add the field

```rust
    /// Largest message the peer can reassemble; `None` for legacy whole frames.
    max_message_bytes: Option<usize>,
```

   and in `run_session_split_budgeted`, compute `let max_message_bytes = framing.max_message_bytes();` before the writer spawn (framing moves into it), and set `max_message_bytes,` in the `RpcOutboundQueue` literal.

2. Replace `impl RpcOutboundQueue { … }` with (the `#[cfg(test)] fn try_send` stays; paste it back unchanged inside the impl):

```rust
impl RpcOutboundQueue {
    /// The largest encoded message this connection may send, if bounded.
    fn message_limit(&self) -> Option<usize> {
        let connection = self.budget.as_ref().map(|budget| budget.connection_capacity);
        match (self.max_message_bytes, connection) {
            (Some(message), Some(connection)) => Some(message.min(connection)),
            (message, connection) => message.or(connection),
        }
    }

    async fn acquire_budget(
        &self,
        shutdown: &CancellationToken,
        bytes: usize,
        deadline: Instant,
    ) -> Result<Option<RpcOutboundBytePermit>, SendFailure> {
        let Some(budget) = &self.budget else {
            return Ok(None);
        };
        tokio::select! {
            () = shutdown.cancelled() => Err(SendFailure::Rejected),
            result = budget.acquire(bytes, deadline) => {
                result.map(Some).map_err(|()| SendFailure::Rejected)
            }
        }
    }
}
```

3. Add near `outbound_admission_failure`:

```rust
/// Why an outbound message could not be queued.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SendFailure {
    /// Admission failed: deadline, closed queue, or session shutdown.
    Rejected,
    /// The encoded message exceeds what this connection can deliver.
    TooLarge { bytes: usize, limit: usize },
}

impl SendFailure {
    /// The typed failure the client receives for the request.
    fn into_error(self, method: &str) -> Value {
        match self {
            Self::Rejected => outbound_admission_failure(),
            Self::TooLarge { bytes, limit } => response_too_large_failure(method, bytes, limit),
        }
    }
}

/// `RpcResponseTooLargeError` in `packages/contracts/src/rpcTransport.ts`.
fn response_too_large_failure(method: &str, bytes: usize, limit_bytes: usize) -> Value {
    json!({
        "_tag": "RpcResponseTooLargeError",
        "method": method,
        "bytes": bytes,
        "limitBytes": limit_bytes,
    })
}
```

4. Replace `send_server_message` with:

```rust
async fn send_server_message(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    message: ServerMessage,
) -> Result<(), SendFailure> {
    let deadline = Instant::now() + OUTBOUND_SEND_TIMEOUT;
    let frame = if let Some(limit) = outbound.message_limit() {
        // Encode exactly once and drop the value tree before the admission
        // wait, so the memory resident while waiting is precisely the bytes
        // that will be charged.
        let encoded = serde_json::to_string(&message).map_err(|_| SendFailure::Rejected)?;
        drop(message);
        if encoded.len() > limit {
            return Err(SendFailure::TooLarge {
                bytes: encoded.len(),
                limit,
            });
        }
        let budget = outbound
            .acquire_budget(session_shutdown, encoded.len(), deadline)
            .await?;
        RpcOutboundFrame {
            payload: RpcOutboundPayload::Encoded(Message::Text(encoded.into())),
            _budget: budget,
        }
    } else {
        RpcOutboundFrame {
            payload: RpcOutboundPayload::Plain(message),
            _budget: None,
        }
    };
    tokio::select! {
        () = session_shutdown.cancelled() => Err(SendFailure::Rejected),
        result = timeout_at(deadline, outbound.sender.send(frame)) => {
            match result {
                Ok(Ok(())) => Ok(()),
                Ok(Err(_)) | Err(_) => Err(SendFailure::Rejected),
            }
        }
    }
}
```

5. Replace `reserve_server_message` with:

```rust
async fn reserve_server_message(
    outbound: &RpcOutboundQueue,
    session_shutdown: &CancellationToken,
    encoded_len_bound: usize,
) -> Result<RpcResponseEnqueuePermit, SendFailure> {
    if let Some(limit) = outbound.message_limit()
        && encoded_len_bound > limit
    {
        return Err(SendFailure::TooLarge {
            bytes: encoded_len_bound,
            limit,
        });
    }
    let deadline = Instant::now() + OUTBOUND_SEND_TIMEOUT;
    let budget = outbound
        .acquire_budget(session_shutdown, encoded_len_bound, deadline)
        .await?;
    tokio::select! {
        () = session_shutdown.cancelled() => Err(SendFailure::Rejected),
        result = timeout_at(deadline, outbound.sender.clone().reserve_owned()) => {
            match result {
                Ok(Ok(permit)) => Ok(RpcResponseEnqueuePermit {
                    permit,
                    budget,
                    encoded_len_bound,
                }),
                Ok(Err(_)) | Err(_) => Err(SendFailure::Rejected),
            }
        }
    }
}
```

6. `run_unary`: after `let request_id = request.id.clone();`, add `let method = request.tag.clone();`. Replace everything from `if let Some(enqueue_guard) = enqueue_guard {` to the end of the function with:

```rust
    if let Some(enqueue_guard) = enqueue_guard {
        let encoded_len_bound = if outbound.message_limit().is_some() {
            let Ok(encoded_len_bound) = enqueue_guard.encoded_len_bound(&response) else {
                return;
            };
            encoded_len_bound
        } else {
            0
        };
        match reserve_server_message(&outbound, &session_shutdown, encoded_len_bound).await {
            Ok(permit) => enqueue_guard.enqueue(permit, response),
            Err(failure) => {
                let _ = send_unbudgeted_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::failure(request_id, failure.into_error(&method)),
                )
                .await;
            }
        }
    } else if let Err(failure) = send_server_message(&outbound, &session_shutdown, response).await {
        let _ = send_unbudgeted_server_message(
            &outbound,
            &session_shutdown,
            ServerMessage::failure(request_id, failure.into_error(&method)),
        )
        .await;
    }
```

7. `run_stream`:
   - After `let request_id = request.id.clone();` add `let method = request.tag.clone();`.
   - Pass `&method` as a new last argument to both `send_stream_terminal(…)` calls.
   - Replace the chunk-send failure block (`if send_server_message(… ServerMessage::Chunk { … }).await.is_err() { … return; }`) with:

```rust
                if let Err(failure) = send_server_message(
                    &outbound,
                    &session_shutdown,
                    ServerMessage::Chunk {
                        request_id: request_id.clone(),
                        values,
                    },
                )
                .await
                {
                    // The chunk lost admission or cannot fit the connection. Ending
                    // the subscription silently would strand the client, so deliver
                    // an explicit terminal through the control lane.
                    let _ = send_unbudgeted_server_message(
                        &outbound,
                        &session_shutdown,
                        ServerMessage::failure(request_id, failure.into_error(&method)),
                    )
                    .await;
                    return;
                }
```

8. `send_stream_terminal`: add the parameter `method: &str` and replace its body with:

```rust
    if let Err(failure) = send_server_message(outbound, session_shutdown, primary).await {
        let _ = send_unbudgeted_server_message(
            outbound,
            session_shutdown,
            ServerMessage::failure(request_id, failure.into_error(method)),
        )
        .await;
    }
```

9. `run_latest_stream`:
   - After `let request_id = request.id.clone();` add `let method = request.tag.clone();`.
   - Pass `&method` as a new last argument to both `send_latest_stream_terminal(…)` calls.
   - In the chunk failure branch, replace `if send_latest_stream_message(…).await.is_err() {` with `if let Err(failure) = send_latest_stream_message(…).await {`, and replace `outbound_admission_failure()` inside that branch with `failure.into_error(&method)`.

10. `send_latest_stream_terminal`: add the parameter `method: &str`. Replace `if send_latest_stream_message(…).await.is_err() {` with `if let Err(failure) = send_latest_stream_message(…).await {`, and replace `outbound_admission_failure()` inside it with `failure.into_error(method)`.

11. `send_latest_stream_message`: return type `Result<(), SendFailure>`; the cancellation arm becomes `() = cancellation.cancelled() => Err(SendFailure::Rejected),`.

12. `process_client_message`: every `return send_server_message(…).await;` gains `.map_err(|_| ())`, so the function keeps returning `Result<(), ()>`. The unknown-request `ClientMessage::Interrupt` reply already uses Task 5's `send_unbudgeted_server_message` and keeps its `Result<(), ()>` unchanged.

13. The read-loop protocol-error path already uses `send_unbudgeted_server_message` (Task 5). No change is needed.

Task 5's oversized-control fallback still uses `RpcOutboundPayload::Control`, not `send_server_message`. In `send_unbudgeted_server_message`, replace only the budget-acquisition binding with:

```rust
        if outbound.message_limit().is_some_and(|limit| encoded.len() > limit) {
            return Err(());
        }
        let budget = outbound.acquire_budget(session_shutdown, encoded.len(), deadline)
            .await.map_err(|_| ())?;
```

In `try_send_control_message`, after serialization and before either admission path, add:

```rust
    if outbound.message_limit().is_some_and(|limit| encoded.len() > limit) {
        return Err(());
    }
```

Both fallbacks retain ordinary byte budgeting and control classification. No oversized
control may be stored on the bypass lane or in an unbudgeted deferred vector.

- [ ] **Step 5: Run the server tests**

Run:
- `cargo test -p bibcode-server --lib rpc::session`
- `cargo test -p bibcode-server --test rpc_wire`

Expected: all pass, including `response_larger_than_the_connection_budget_fails_only_its_request`, `record_framed_plain_sessions_refuse_messages_over_the_limit`, `response_too_large_failure_matches_the_typescript_wire_fixture`, and the fixture round-trip in `rpc_wire`.

- [ ] **Step 6: Client — middleware (test first)**

Create `packages/client-runtime/src/rpc/transportErrors.test.ts`:

```ts
import { RpcResponseTooLargeError, WS_METHODS, WsRpcGroup } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { RpcTransportErrors } from "./transportErrors.ts";

describe("RpcTransportErrors", () => {
  it("lets every method decode an oversized-response failure", () => {
    const group = WsRpcGroup.middleware(RpcTransportErrors);
    for (const tag of [WS_METHODS.gitManagerGetCommits, WS_METHODS.subscribeServerConfig]) {
      const rpc = group.requests.get(tag)!;
      const decodeExit = Schema.decodeUnknownSync(Schema.toCodecJson(Rpc.exitSchema(rpc)));
      const exit = decodeExit({
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: {
              _tag: "RpcResponseTooLargeError",
              method: tag,
              bytes: 70_000_000,
              limitBytes: 67_108_864,
            },
          },
        ],
      });
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error) && error.value instanceof RpcResponseTooLargeError).toBe(true);
    }
  });
});
```

Run: `vp test run packages/client-runtime/src/rpc/transportErrors.test.ts`
Expected: FAIL (module missing).

Create `packages/client-runtime/src/rpc/transportErrors.ts`:

```ts
import { RpcResponseTooLargeError } from "@bibcode/contracts";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

/**
 * Declares the transport failures any RPC may end with, so every method's
 * exit schema decodes them. The client never runs this middleware
 * (`requiredForClient` is false); the Rust server produces the failure.
 */
export class RpcTransportErrors extends RpcMiddleware.Service<RpcTransportErrors>()(
  "@bibcode/client-runtime/rpc/RpcTransportErrors",
  { error: RpcResponseTooLargeError },
) {}
```

In `packages/client-runtime/src/rpc/protocol.ts`, add `import { RpcTransportErrors } from "./transportErrors.ts";` and replace `RpcClient.make(WsRpcGroup, {` with `RpcClient.make(WsRpcGroup.middleware(RpcTransportErrors), {`.

In `packages/client-runtime/src/rpc/session.ts` `mapInitialConfigError`, add before `case "RpcClientError":`:

```ts
    case "RpcResponseTooLargeError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
```

The error-union propagation is explicit; do not replace it with compiler-directed edits:

| Boundary | Required final union / code |
| --- | --- |
| `rpc/protocol.ts` `makeWsRpcProtocolClient` / inferred `WsRpcProtocolClient` | Every unary Effect error and stream error includes `RpcResponseTooLargeError` through `WsRpcGroup.middleware(RpcTransportErrors)`. |
| `rpc/session.ts` `InitialConfigError` | Keep the derived `Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>>`; it gains the new member. The exhaustive `mapInitialConfigError` switch gains the complete case above. Task 13 changes the source to the subscription's derived error union. |
| `rpc/client.ts` `EnvironmentRpcFailure` / `EnvironmentRpcStreamFailure` | Their conditional types infer the augmented Effect/Stream error union from `WsRpcProtocolClient`; preserve that derivation, including `EnvironmentRpcUnavailableError`. No handwritten narrowing union. |
| `state/runtime.ts` RPC query/command/subscription factories | The inferred error includes `RpcResponseTooLargeError` plus the existing registry/runtime errors; preserve `EnvironmentRpcFailure` / `EnvironmentRpcStreamFailure` inference. |
| `connection/pairingAdd.test.ts` `confirmationOutcome` | Its narrower mock error union (`EnvironmentAuthorizationError | RpcClientError`) remains assignable to the wider client method; no fake oversize case is required. |

Run: `vp run typecheck`.
Expected: exit 0; the only production exhaustive switch requiring a new branch in the current tree is `mapInitialConfigError`. Any new concurrent caller must preserve the same typed failure and message; record it before editing.

- [ ] **Step 7: Client — end-to-end session test**

In `packages/client-runtime/src/rpc/session.test.ts`, add `RpcResponseTooLargeError` to the contracts import and append:

```ts
  it.effect("fails only the request whose response is too large", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);

        const settings = yield* Effect.forkChild(
          Effect.flip(session.client[WS_METHODS.serverGetSettings]({})),
        );
        const request = yield* awaitRequest(socket, 1);
        socket.serverMessage(
          encodeJson({
            _tag: "Exit",
            requestId: request.id,
            exit: {
              _tag: "Failure",
              cause: [
                {
                  _tag: "Fail",
                  error: {
                    _tag: "RpcResponseTooLargeError",
                    method: WS_METHODS.serverGetSettings,
                    bytes: 70_000_000,
                    limitBytes: 67_108_864,
                  },
                },
              ],
            },
          }),
        );
        const error = yield* Fiber.join(settings);
        expect(error).toBeInstanceOf(RpcResponseTooLargeError);
        expect(error.message).toBe("This result is too large to send (66.8 MiB; limit 64 MiB).");
        expect(socket.readyState).toBe(TestWebSocket.OPEN);
      }),
    ),
  );
```

Run:
- `vp test run packages/client-runtime/src/rpc packages/contracts/src/rpcTransport.test.ts`
- The temporary-index `vp run check:contracts` command below.

Expected: all tests pass and `vp run check:contracts` exits **0** after regeneration. Its final Git comparison is against the index, so prepare a temporary fixture-only index as follows; this leaves the real index and other agents' changes untouched:

```bash
(
  set -eu
  node packages/contracts/scripts/export-rust-rpc-fixtures.ts
  git status --short -- packages/contracts/fixtures
  git diff --stat -- packages/contracts/fixtures
  CONTRACT_INDEX=$(mktemp)
  trap 'rm -f "$CONTRACT_INDEX"' EXIT
  GIT_INDEX_FILE="$CONTRACT_INDEX" git read-tree HEAD
  GIT_INDEX_FILE="$CONTRACT_INDEX" git add -- packages/contracts/fixtures
  GIT_INDEX_FILE="$CONTRACT_INDEX" vp run check:contracts
)
```

Before the temporary-index gate, review the full new JSON file and manifest change against Step 2; status must include the untracked fixture. The gate must leave that reviewed fixture baseline unchanged and exit 0. Report `check:contracts: PASS (exit 0, temporary fixture index)`; any nonzero result is a failure, never an expected success.

- [ ] **Step 8: Lints and gates**

Run:
- `cargo fmt --all --check`
- `cargo clippy -p bibcode-server --all-targets -- -D warnings`
- `vp check`
- `vp run typecheck`

Expected: clean.

- [ ] **Step 9: Update the living docs**

1. `docs/architecture/remote.md`: replace the two lines

```
64 MiB connection cap fails the session closed immediately; otherwise both
```

   (preceded on the line before by "transport control and carry no RPC plaintext. A response larger than the") so that the sentence reads: "A response larger than the 64 MiB connection cap fails only its own request with a typed `RpcResponseTooLargeError { method, bytes, limitBytes }`, and the session stays open; otherwise both". Keep the rest of the paragraph.

2. `docs/architecture/rpc-and-orchestration.md`: append to the records paragraph from Task 6:

```markdown
A response that does not fit the connection's message limit (64 MiB on E2EE and
record-framed plain sockets) fails only its own request with a typed
`RpcResponseTooLargeError { method, bytes, limitBytes }`; the session stays
open. Clients decode it for every method through the client-runtime
`RpcTransportErrors` middleware, and its message reads "This result is too large
to send (<size>; limit 64 MiB)."
```

- [ ] **Step 10: Checkpoint (no commit)**

Record `Task 11 <tree> session.rs + rpc_wire + client rpc + contracts + check:contracts (expected fixture diff)` in the ledger.

---

### Task 12: Reconnect jitter and the idle ladder for unselected environments

**Files:**
- Create: `packages/client-runtime/src/connection/selection.ts`
- Test: `packages/client-runtime/src/connection/selection.test.ts`
- Modify: `packages/client-runtime/src/connection/index.ts` (export)
- Modify: `packages/client-runtime/src/connection/supervisor.ts`
- Modify: `packages/client-runtime/src/connection/registry.ts`
- Test: `packages/client-runtime/src/connection/supervisor.test.ts`
- Create: `apps/web/src/state/activeEnvironment.ts`
- Test: `apps/web/src/state/activeEnvironment.test.ts`
- Modify: `apps/web/src/state/entities.ts` (move the atom out, re-export)
- Create: `apps/web/src/connection/environmentSelection.ts`
- Test: `apps/web/src/connection/environmentSelection.test.ts`
- Modify: `apps/web/src/connection/platform.ts`
- Docs: `docs/architecture/connection-runtime.md`

**Interfaces:**
- Consumes: Effect `Random.Random` (tests pin it), `AtomRegistry.toStream`.
- Produces:
  - `export class EnvironmentSelection extends Context.Reference<{ current: Effect.Effect<EnvironmentId | null>; changes: Stream.Stream<EnvironmentId | null> }>`, with a default that selects nothing.
  - `export function isEnvironmentShown(selected: EnvironmentId | null, environmentId: EnvironmentId): boolean`.
  - Supervisor signal `{ _tag: "SelectionChanged" }` (internal).
  - Web: `export const activeEnvironmentIdAtom`, `useActiveEnvironmentId`, `readActiveEnvironmentId`, `setActiveEnvironmentId` (moved; `entities.ts` re-exports them), and `export function makeEnvironmentSelection(registry: AtomRegistry.AtomRegistry)`.

- [ ] **Step 1: The selection reference (test first)**

Create `packages/client-runtime/src/connection/selection.test.ts`:

```ts
import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { EnvironmentSelection, isEnvironmentShown } from "./selection.ts";

describe("EnvironmentSelection", () => {
  it.effect("defaults to unknown selection and leaves its change stream open", () =>
    Effect.gen(function* () {
      const selection = yield* EnvironmentSelection;
      expect(yield* selection.current).toBeNull();
      const changes = yield* Effect.forkChild(Stream.runCollect(selection.changes));
      yield* Effect.yieldNow;
      expect(changes.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(changes);
    }),
  );
  it("only idles known unselected environments", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    expect(isEnvironmentShown(null, local)).toBe(true);
    expect(isEnvironmentShown(local, local)).toBe(true);
    expect(isEnvironmentShown(remote, local)).toBe(false);
  });
});
```

Run: `vp test run packages/client-runtime/src/connection/selection.test.ts`.
Expected: FAIL (module missing). Then create `packages/client-runtime/src/connection/selection.ts`:

```ts
import type { EnvironmentId } from "@bibcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * The environment the user is looking at. After long failure, supervisors of
 * other environments move to the idle retry ladder. The default selects
 * nothing, so without a platform value no environment counts as unselected.
 */
export class EnvironmentSelection extends Context.Reference<{
  /** The selected environment now, or null when unknown. */
  readonly current: Effect.Effect<EnvironmentId | null>;
  /** The selected environment after every change; it may repeat the current one. */
  readonly changes: Stream.Stream<EnvironmentId | null>;
}>("@bibcode/client-runtime/connection/selection/EnvironmentSelection", {
  defaultValue: () => ({ current: Effect.succeed(null), changes: Stream.never }),
}) {}

/** True when the environment is selected, or when nothing is selected. */
export function isEnvironmentShown(
  selected: EnvironmentId | null,
  environmentId: EnvironmentId,
): boolean {
  return selected === null || selected === environmentId;
}
```

In `packages/client-runtime/src/connection/index.ts`, add `export { EnvironmentSelection, isEnvironmentShown } from "./selection.ts";` after the `./resolver.ts` export.

Run: `vp test run packages/client-runtime/src/connection/selection.test.ts`.
Expected: PASS (2 tests).

- [ ] **Step 2: Failing supervisor tests**

In `packages/client-runtime/src/connection/supervisor.test.ts`:

1. Add imports: `import * as Clock from "effect/Clock";`, `import * as Random from "effect/Random";`, and `import { EnvironmentSelection } from "./selection.ts";`. Extend the contracts import with the type `EnvironmentId as EnvironmentIdType` only if the file does not already import `EnvironmentId` (it does; reuse `EnvironmentId`).

2. In `makeHarness`'s options type, add:

```ts
  readonly random?: number;
  readonly selection?: SubscriptionRef.SubscriptionRef<EnvironmentId | null>;
```

   At the start of its body, add:

```ts
  const selection =
    options?.selection ?? (yield* SubscriptionRef.make<EnvironmentId | null>(null));
```

   Add these two layers to its `Layer.mergeAll(…)`:

```ts
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => options?.random ?? 0.5,
      nextIntUnsafe: () => 0,
    }),
    Layer.succeed(
      EnvironmentSelection,
      EnvironmentSelection.of({
        current: SubscriptionRef.get(selection),
        changes: SubscriptionRef.changes(selection),
      }),
    ),
```

3. In `makeStorageIdentityHarness`'s `Layer.mergeAll(…)`, add `Layer.succeed(Random.Random, { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 0 }),`.

4. Append inside `describe("EnvironmentSupervisor", …)`:

```ts
  it.effect("moves every retry delay by up to fifteen percent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ prepare: () => Effect.fail(transient()), random: 0 });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        targetRef: yield* Ref.make<ConnectionTarget>(TARGET_ENTRY.target),
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const first = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(first.retryAt! - (yield* Clock.currentTimeMillis)).toBe(850);
      yield* TestClock.adjust(849);
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      yield* TestClock.adjust(1);
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  const collectBackoffDelays = Effect.fn("TestConnectionHarness.collectBackoffDelays")(function* (
    state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
    until: (delays: ReadonlyArray<number>) => boolean,
  ) {
    const delays: Array<number> = [];
    for (let attempt = 1; !until(delays); attempt += 1) {
      const backoff = yield* eventuallyState(
        state,
        (value) => value.phase === "backoff" && value.attempt === attempt,
      );
      const delay = backoff.retryAt! - (yield* Clock.currentTimeMillis);
      delays.push(delay);
      yield* TestClock.adjust(delay);
    }
    return delays;
  });

  it.effect("moves an unselected environment to the idle ladder after five minutes", () =>
    Effect.gen(function* () {
      const selection = yield* SubscriptionRef.make<EnvironmentId | null>(
        EnvironmentId.make("another-environment"),
      );
      const harness = yield* makeHarness({ prepare: () => Effect.fail(transient()), selection });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        targetRef: yield* Ref.make<ConnectionTarget>(TARGET_ENTRY.target),
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const delays = yield* collectBackoffDelays(
        supervisor.state,
        (collected) => collected.filter((delay) => delay >= 60_000).length === 4,
      );
      const firstIdle = delays.findIndex((delay) => delay >= 60_000);
      expect(delays.slice(firstIdle)).toEqual([60_000, 120_000, 300_000, 300_000]);
      expect(delays.slice(0, firstIdle).every((delay) => delay <= 16_000)).toBe(true);
      expect(delays.slice(0, firstIdle).reduce((total, delay) => total + delay, 0)).toBeGreaterThanOrEqual(
        300_000,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the selected environment on the normal ladder", () =>
    Effect.gen(function* () {
      const selection = yield* SubscriptionRef.make<EnvironmentId | null>(TARGET.environmentId);
      const harness = yield* makeHarness({ prepare: () => Effect.fail(transient()), selection });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        targetRef: yield* Ref.make<ConnectionTarget>(TARGET_ENTRY.target),
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const delays = yield* collectBackoffDelays(
        supervisor.state,
        (collected) => collected.reduce((total, delay) => total + delay, 0) > 600_000,
      );
      expect(delays.every((delay) => delay <= 16_000)).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ends an idle wait at once when the environment is selected", () =>
    Effect.gen(function* () {
      const selection = yield* SubscriptionRef.make<EnvironmentId | null>(
        EnvironmentId.make("another-environment"),
      );
      const harness = yield* makeHarness({ prepare: () => Effect.fail(transient()), selection });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        targetRef: yield* Ref.make<ConnectionTarget>(TARGET_ENTRY.target),
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const delays: Array<number> = [];
      let attempt = 1;
      for (;;) {
        const backoff = yield* eventuallyState(
          supervisor.state,
          (value) => value.phase === "backoff" && value.attempt === attempt,
        );
        const delay = backoff.retryAt! - (yield* Clock.currentTimeMillis);
        if (delay >= 60_000) break;
        delays.push(delay);
        yield* TestClock.adjust(delay);
        attempt += 1;
      }
      const before = yield* Ref.get(harness.prepareCount);
      yield* SubscriptionRef.set(selection, TARGET.environmentId);
      yield* eventuallyState(
        supervisor.state,
        (value) => value.phase === "backoff" && value.attempt === attempt + 1,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(before + 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not restart a blocked environment when it is selected", () =>
    Effect.gen(function* () {
      const selection = yield* SubscriptionRef.make<EnvironmentId | null>(
        EnvironmentId.make("another-environment"),
      );
      const harness = yield* makeHarness({ prepare: () => Effect.fail(blocked()), selection });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        targetRef: yield* Ref.make<ConnectionTarget>(TARGET_ENTRY.target),
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* SubscriptionRef.set(selection, TARGET.environmentId);
      for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("blocked");
    }),
  );
```

Run: `vp test run packages/client-runtime/src/connection/supervisor.test.ts`
Expected: FAIL. The jitter test sees 1000 instead of 850; the ladder test never sees a delay of 60 000 or more and times out on `eventuallyState`.

- [ ] **Step 3: Implement jitter, the idle ladder, and selection wake-ups**

In `packages/client-runtime/src/connection/supervisor.ts`:

1. Imports: add `import * as Random from "effect/Random";` and `import { EnvironmentSelection, isEnvironmentShown } from "./selection.ts";`.

2. After `const RETRY_DELAYS_MS = …;` add:

```ts
/** Every retry delay moves by up to ±15 % so reconnecting clients spread out. */
const RETRY_JITTER = 0.15;
/** After this much continuous failure an unselected environment retries rarely. */
const IDLE_LADDER_AFTER_MS = 5 * 60_000;
const IDLE_RETRY_DELAYS_MS = [60_000, 120_000, 300_000] as const;
```

3. Add `| { readonly _tag: "SelectionChanged" }` to `type SupervisorSignal`.

4. After `function retryDelayMs(…) { … }` add:

```ts
function idleRetryDelayMs(idleFailures: number): number {
  return (
    IDLE_RETRY_DELAYS_MS[Math.min(idleFailures - 1, IDLE_RETRY_DELAYS_MS.length - 1)] ?? 300_000
  );
}

function jitteredDelayMs(
  delayMs: number,
  random: { readonly nextDoubleUnsafe: () => number },
): number {
  return Math.round(delayMs * (1 + (random.nextDoubleUnsafe() * 2 - 1) * RETRY_JITTER));
}
```

5. In `make`, after `const wakeups = yield* ConnectionWakeups.ConnectionWakeups;` add:

```ts
  const selection = yield* EnvironmentSelection;
  const random = yield* Random.Random;
  const shown = yield* Ref.make(
    isEnvironmentShown(yield* selection.current, target.environmentId),
  );
```

6. Signal handling:
   - In `waitForEstablishmentInterrupt`, change `case "ConnectRequested": break;` to `case "ConnectRequested": case "SelectionChanged": break;`.
   - In `monitorConnectedLease`'s outer switch, change `case "ConnectRequested": break;` (last case) to `case "ConnectRequested": case "SelectionChanged": break;`.
   - In its probe switch, change `case "ConnectRequested": case "Wakeup": break;` to `case "ConnectRequested": case "Wakeup": case "SelectionChanged": break;`.
   - In `waitForRetrySignal`, add `case "SelectionChanged":` to the cases that `return`.
   - Replace `const waitForSignal = Queue.take(signals);` with:

```ts
  // A selection change only shortens retry waits; it never restarts an idle,
  // offline or blocked supervisor.
  const waitForSignal = Effect.gen(function* () {
    for (;;) {
      const next = yield* Queue.take(signals);
      if (next._tag !== "SelectionChanged") return next;
    }
  });
```

7. In `run`:
   - After `let pendingRetry = Option.none<PendingRetryTrace>();` add:

```ts
    let failingSince: number | null = null;
    let idleFailures = 0;
```

   - In the `!currentIntent.desired` branch, and inside `if (outcome.stable) { … }`, also reset `failingSince = null;` and `idleFailures = 0;`.
   - Replace everything from `failureCount += 1;` through `yield* waitForRetrySignal(delayMs);` with:

```ts
      failureCount += 1;
      const failedAt = yield* Clock.currentTimeMillis;
      failingSince ??= failedAt;
      const idle = !(yield* Ref.get(shown)) && failedAt - failingSince >= IDLE_LADDER_AFTER_MS;
      idleFailures = idle ? idleFailures + 1 : 0;
      const delayMs = jitteredDelayMs(
        idle ? idleRetryDelayMs(idleFailures) : retryDelayMs(failureCount - 1),
        random,
      );
      pendingRetry = Option.map(attemptSpan, (previousAttempt) => ({
        previousAttempt,
        failureCount,
        delayMs,
        reason: error.reason,
      }));
      const failedIntent = yield* Ref.get(intent);
      yield* setState({
        desired: failedIntent.desired,
        network: failedIntent.network,
        phase: "backoff",
        stage: null,
        attempt,
        generation,
        lastFailure: error,
        retryAt: failedAt + delayMs,
      });
      yield* waitForRetrySignal(delayMs);
```

8. After the `wakeups.changes` fork, add:

```ts
  yield* selection.changes.pipe(
    Stream.runForEach((selected) => {
      const nowShown = isEnvironmentShown(selected, target.environmentId);
      return Ref.getAndSet(shown, nowShown).pipe(
        Effect.flatMap((wasShown) =>
          !wasShown && nowShown ? signal({ _tag: "SelectionChanged" }) : Effect.void,
        ),
      );
    }),
    Effect.forkScoped,
  );
```

In `packages/client-runtime/src/connection/registry.ts`:
1. Add `import { EnvironmentSelection } from "./selection.ts";`.
2. In `make`, after `const wakeups = yield* ConnectionWakeups.ConnectionWakeups;` add `const selection = yield* EnvironmentSelection;`.
3. In `createServiceScope`, add `Effect.provideService(EnvironmentSelection, selection),` after the `ConnectionWakeups` line.

Run: `vp test run packages/client-runtime/src/connection`
Expected: PASS, including every existing supervisor and registry test (the fixed `Random` keeps their exact delays).

- [ ] **Step 4: Web — move the active-environment atom to a leaf module (test first)**

Create `apps/web/src/state/activeEnvironment.test.ts`:

```ts
import { EnvironmentId } from "@bibcode/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import {
  activeEnvironmentIdAtom, readActiveEnvironmentId, setActiveEnvironmentId,
} from "./activeEnvironment";

afterEach(resetAppAtomRegistryForTests);

describe("active environment", () => {
  it("starts unknown and reads writes from the shared registry", () => {
    expect(readActiveEnvironmentId()).toBeNull();
    const selected = EnvironmentId.make("remote");
    setActiveEnvironmentId(selected);
    expect(readActiveEnvironmentId()).toBe(selected);
    expect(appAtomRegistry.get(activeEnvironmentIdAtom)).toBe(selected);
    setActiveEnvironmentId(null);
    expect(readActiveEnvironmentId()).toBeNull();
  });
  it("uses the new registry after a test reset", () => {
    setActiveEnvironmentId(EnvironmentId.make("local"));
    resetAppAtomRegistryForTests();
    expect(readActiveEnvironmentId()).toBeNull();
  });
});
```

Run: `vp test run apps/web/src/state/activeEnvironment.test.ts`.
Expected: FAIL (module missing). Then create `apps/web/src/state/activeEnvironment.ts`:

```ts
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@bibcode/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * The environment selected in the environment rail. A leaf module, so the
 * connection platform layer can read it without importing the entity atoms.
 */
export const activeEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-active-environment-id"),
);

export function useActiveEnvironmentId(): EnvironmentId | null {
  return useAtomValue(activeEnvironmentIdAtom);
}

export function readActiveEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(activeEnvironmentIdAtom);
}

export function setActiveEnvironmentId(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(activeEnvironmentIdAtom, environmentId);
}
```

In `apps/web/src/state/entities.ts`:
- Delete the definitions of `activeEnvironmentIdAtom`, `useActiveEnvironmentId`, `readActiveEnvironmentId` and `setActiveEnvironmentId`.
- Keep `previousPrimaryEnvironmentIdAtom` and `reconcileEnvironmentSelection` in place (currently lines 64 and 82). The latter still calls `readActiveEnvironmentId` and `setActiveEnvironmentId` at lines 86 and 96. Keep its `appAtomRegistry` import and add these local bindings as well as the compatibility re-exports:

```ts
import { readActiveEnvironmentId, setActiveEnvironmentId } from "./activeEnvironment";

export {
  activeEnvironmentIdAtom,
  readActiveEnvironmentId,
  setActiveEnvironmentId,
  useActiveEnvironmentId,
} from "./activeEnvironment";
```

- A re-export does not bind a local identifier. Recheck `rg -n 'activeEnvironmentIdAtom|readActiveEnvironmentId|setActiveEnvironmentId' apps/web/src/state/entities.ts` after this targeted move; import any further locally used export if concurrent code adds one.

Every existing importer, including track B's `Sidebar.tsx` and `EnvironmentRail.tsx`, keeps importing from `state/entities` unchanged.

Run: `vp test run apps/web/src/state/activeEnvironment.test.ts apps/web/src/state/entities.test.ts` and `vp run typecheck`.
Expected: PASS, including existing primary/startup selection reconciliation coverage and both new leaf-module tests; no missing local bindings.

- [ ] **Step 5: Web — publish the selection (test first)**

Create `apps/web/src/connection/environmentSelection.test.ts`:

```ts
import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/unstable/reactivity";

import { activeEnvironmentIdAtom } from "../state/activeEnvironment";
import { makeEnvironmentSelection } from "./environmentSelection";

describe("makeEnvironmentSelection", () => {
  it.effect("reads the rail selection and streams its changes", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const selection = makeEnvironmentSelection(registry);
      expect(yield* selection.current).toBeNull();
      const changes = yield* Effect.forkChild(
        selection.changes.pipe(Stream.take(2), Stream.runCollect),
      );
      yield* Effect.yieldNow;
      registry.set(activeEnvironmentIdAtom, EnvironmentId.make("remote-1"));
      expect(Array.from(yield* Fiber.join(changes))).toEqual([null, "remote-1"]);
      expect(yield* selection.current).toBe("remote-1");
    }),
  );
});
```

Run: `vp test run apps/web/src/connection/environmentSelection.test.ts`
Expected: FAIL (module missing).

Create `apps/web/src/connection/environmentSelection.ts`:

```ts
import { EnvironmentSelection } from "@bibcode/client-runtime/connection";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/unstable/reactivity";

import { activeEnvironmentIdAtom } from "../state/activeEnvironment";

/** Publishes the environment-rail selection to the connection supervisors. */
export function makeEnvironmentSelection(registry: AtomRegistry.AtomRegistry) {
  return EnvironmentSelection.of({
    current: Effect.sync(() => registry.get(activeEnvironmentIdAtom)),
    changes: AtomRegistry.toStream(registry, activeEnvironmentIdAtom),
  });
}
```

In `apps/web/src/connection/platform.ts`:
1. Add `EnvironmentSelection` to the `@bibcode/client-runtime/connection` import list, and add `import { makeEnvironmentSelection } from "./environmentSelection";`.
2. Before `type ConnectionPlatformLayerSource`, add:

```ts
const environmentSelectionLayer = Layer.succeed(
  EnvironmentSelection,
  makeEnvironmentSelection(appAtomRegistry),
);
```

3. Add `| typeof environmentSelectionLayer` to `ConnectionPlatformLayerSource` and `environmentSelectionLayer,` to `Layer.mergeAll(…)` in `connectionPlatformLayer`.

Run: `vp test run apps/web/src/connection apps/web/src/state`
Expected: PASS.

- [ ] **Step 6: Gates and reviews**

Run: `vp check` and `vp run typecheck`
Expected: clean.

React review (`vercel-react-best-practices`): the only hook touched is `useActiveEnvironmentId`, moved verbatim. Record "reviewed: no render or hook change". UI.md review: retry timing is not visible except through reconnect speed. Record "reviewed: no visible change".

- [ ] **Step 7: Update the living doc**

In `docs/architecture/connection-runtime.md`, replace

```
Transient failures retry after 1, 2, 4, 8, then 16 seconds, with 16 seconds as
the cap. The sequence continues while the connection remains desired.
```

with

```markdown
Transient failures retry after 1, 2, 4, 8, then 16 seconds, with 16 seconds as
the cap, and every delay moves by up to ±15 % so reconnecting clients spread
out. The sequence continues while the connection remains desired. After five
minutes of continuous failure, an environment that is not selected in the
environment rail (`EnvironmentSelection`) retries after 60, 120, then 300
seconds. Connect, retry, network-change and wakeup signals still end any wait
at once, selecting the environment ends its idle wait and returns it to the
normal ladder, and blocked states are unchanged.
```

(Match the file's current line breaks when you select the old text; edit only these sentences.)

- [ ] **Step 8: Checkpoint (no commit)**

Record `Task 12 <tree> connection tests + web selection` in the ledger.

---

### Task 13: The config crosses the wire once per connection; the health probe is an RPC Ping

**Files:**
- Modify: `packages/client-runtime/src/rpc/liveness.ts` (`awaitAfter`)
- Test: `packages/client-runtime/src/rpc/liveness.test.ts`
- Create: `packages/client-runtime/src/rpc/sharedServerConfig.ts`
- Test: `packages/client-runtime/src/rpc/sharedServerConfig.test.ts`
- Modify: `packages/client-runtime/src/rpc/session.ts` (shared config, readiness, probe, client override)
- Modify: `packages/client-runtime/src/state/server.ts` (reuse the event reducer)
- Test: `packages/client-runtime/src/rpc/session.test.ts` (helpers and new tests)
- Docs: `docs/architecture/connection-runtime.md`, `docs/architecture/rpc-and-orchestration.md`

**Interfaces:**
- Consumes:
  - Task 1: `InboundActivity`.
  - Task 2: `makeLivenessProtocol` returns a `Protocol` whose `send(clientId, FromClientEncoded)` accepts `constPing`.
- Produces:
  - `InboundActivity.awaitAfter(sequence: number): Effect.Effect<void>`.
  - `export function applyServerConfigEvent(config: ServerConfig | null, event: ServerConfigStreamEvent): ServerConfig | null`.
  - `export interface SharedServerConfig<E> { initialConfig: Effect.Effect<ServerConfig, E | RpcClientError>; events: Stream.Stream<ServerConfigStreamEvent, E | RpcClientError> }`.
  - `export const makeSharedServerConfig: <E>(source: Stream.Stream<ServerConfigStreamEvent, E>) => Effect.Effect<SharedServerConfig<E>, never, Scope.Scope>`.
  - `RpcSession`'s interface is unchanged. `initialConfig` comes from the first snapshot; `probe` sends an RPC Ping and completes at the next inbound message; `client[subscribeServerConfig]` replays the shared stream.

- [ ] **Step 1: `awaitAfter` (test first)**

Append to `packages/client-runtime/src/rpc/liveness.test.ts`:

```ts
describe("makeInboundActivity", () => {
  it.effect("awaitAfter completes at the next recorded message", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      const waiting = yield* Effect.forkChild(activity.awaitAfter(activity.sequence()));
      yield* Effect.yieldNow;
      expect(waiting.pollUnsafe()).toBeUndefined();
      activity.record();
      yield* Fiber.join(waiting);
      yield* activity.awaitAfter(0);
    }),
  );
});
```

Run: `vp test run packages/client-runtime/src/rpc/liveness.test.ts`
Expected: FAIL (`awaitAfter` is not a function).

In `packages/client-runtime/src/rpc/liveness.ts`:
1. Add `import * as Deferred from "effect/Deferred";`.
2. Add to `interface InboundActivity`:

```ts
  /** Completes at the first `record` after the given sequence. */
  readonly awaitAfter: (sequence: number) => Effect.Effect<void>;
```

3. Replace `makeInboundActivity` with:

```ts
export const makeInboundActivity: Effect.Effect<InboundActivity> = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  let lastInboundAt = clock.currentTimeMillisUnsafe();
  let sequence = 0;
  let waiters: Array<Deferred.Deferred<void>> = [];
  return {
    record: () => {
      lastInboundAt = clock.currentTimeMillisUnsafe();
      sequence += 1;
      if (waiters.length === 0) return;
      const ready = waiters;
      waiters = [];
      for (const waiter of ready) Deferred.doneUnsafe(waiter, Effect.void);
    },
    reset: () => {
      lastInboundAt = clock.currentTimeMillisUnsafe();
    },
    lastInboundAt: () => lastInboundAt,
    sequence: () => sequence,
    awaitAfter: (after) =>
      Effect.suspend(() => {
        if (sequence > after) return Effect.void;
        const waiter = Deferred.makeUnsafe<void>();
        waiters.push(waiter);
        return Deferred.await(waiter).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              waiters = waiters.filter((candidate) => candidate !== waiter);
            }),
          ),
        );
      }),
  };
});
```

Run: `vp test run packages/client-runtime/src/rpc/liveness.test.ts`
Expected: PASS.

- [ ] **Step 2: Shared config stream (test first)**

Create `packages/client-runtime/src/rpc/sharedServerConfig.test.ts`:

```ts
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Stream from "effect/Stream";

import { applyServerConfigEvent, makeSharedServerConfig } from "./sharedServerConfig.ts";

const CONFIG = {
  cwd: "/tmp/workspace",
  keybindings: [],
  issues: [],
  providers: [],
  settings: DEFAULT_SERVER_SETTINGS,
} as unknown as ServerConfig;

const snapshot = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

describe("makeSharedServerConfig", () => {
  it.effect("takes the initial config from the first snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = yield* makeSharedServerConfig(
          Stream.make(snapshot(CONFIG)).pipe(Stream.concat(Stream.never)),
        );
        expect(yield* shared.initialConfig).toBe(CONFIG);
      }),
    ),
  );

  it.effect("replays the current config to a late subscriber, then passes live events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* Queue.unbounded<ServerConfigStreamEvent>();
        const shared = yield* makeSharedServerConfig(Stream.fromQueue(source));
        yield* Queue.offer(source, snapshot(CONFIG));
        yield* Queue.offer(source, {
          version: 1,
          type: "keybindingsUpdated",
          payload: { keybindings: [], issues: [] },
        });
        yield* shared.initialConfig;
        for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
        const subscriber = yield* Effect.forkChild(
          shared.events.pipe(Stream.take(2), Stream.runCollect),
        );
        for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
        yield* Queue.offer(source, {
          version: 1,
          type: "settingsUpdated",
          payload: { settings: DEFAULT_SERVER_SETTINGS },
        });
        const events = Array.from(yield* Fiber.join(subscriber));
        expect(events.map((event) => event.type)).toEqual(["snapshot", "settingsUpdated"]);
      }),
    ),
  );

  it.effect("fails the initial config and every subscriber when the source fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = yield* makeSharedServerConfig(
          Stream.fail("settings unreadable" as const),
        );
        expect(yield* Effect.flip(shared.initialConfig)).toBe("settings unreadable");
        expect(yield* Effect.flip(Stream.runCollect(shared.events))).toBe("settings unreadable");
      }),
    ),
  );
});

describe("shared config termination", () => {
  it.effect("fails readiness and subscribers when the source ends before a snapshot", () =>
    Effect.scoped(Effect.gen(function* () {
      const shared = yield* makeSharedServerConfig(Stream.empty);
      expect(yield* Effect.flip(shared.initialConfig)).toBeInstanceOf(RpcClientError);
      expect(yield* Effect.flip(Stream.runCollect(shared.events))).toBeInstanceOf(RpcClientError);
    })),
  );

  for (const ending of ["complete", "fail"] as const) {
    it.effect(`settles existing and late subscribers after source ${ending}`, () =>
      Effect.scoped(Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const tail = Stream.fromEffect(Deferred.await(finish)).pipe(
          Stream.flatMap(() => ending === "fail" ? Stream.fail("config source failed") : Stream.empty),
        );
        const shared = yield* makeSharedServerConfig(
          Stream.make(snapshot(CONFIG)).pipe(Stream.concat(tail)),
        );
        expect(yield* shared.initialConfig).toBe(CONFIG);
        const reading = yield* Effect.forkChild(Effect.flip(Stream.runCollect(shared.events)));
        yield* Deferred.succeed(finish, undefined);
        const existing = yield* Fiber.join(reading);
        const late = yield* Effect.flip(Stream.runCollect(shared.events));
        if (ending === "fail") {
          expect(existing).toBe("config source failed");
          expect(late).toBe("config source failed");
        } else {
          expect(existing).toBeInstanceOf(RpcClientError);
          expect(late).toBeInstanceOf(RpcClientError);
        }
      })),
    );
  }
});

describe("applyServerConfigEvent", () => {
  it("ignores updates that arrive before the first snapshot", () => {
    expect(
      applyServerConfigEvent(null, {
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_SERVER_SETTINGS },
      }),
    ).toBeNull();
  });
});
```

Run: `vp test run packages/client-runtime/src/rpc/sharedServerConfig.test.ts`
Expected: FAIL (module missing).

Create `packages/client-runtime/src/rpc/sharedServerConfig.ts`:

```ts
import type { ServerConfig, ServerConfigStreamEvent } from "@bibcode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError, RpcClientDefect } from "effect/unstable/rpc/RpcClientError";

/** The config after one stream event. Updates before the first snapshot change nothing. */
export function applyServerConfigEvent(
  config: ServerConfig | null,
  event: ServerConfigStreamEvent,
): ServerConfig | null {
  switch (event.type) {
    case "snapshot":
      return event.config;
    case "keybindingsUpdated":
      return config === null
        ? null
        : { ...config, keybindings: event.payload.keybindings, issues: event.payload.issues };
    case "providerStatuses":
      return config === null ? null : { ...config, providers: event.payload.providers };
    case "settingsUpdated":
      return config === null ? null : { ...config, settings: event.payload.settings };
  }
}

interface ServerConfigFeed {
  readonly config: ServerConfig | null;
  readonly event: ServerConfigStreamEvent | null;
}

export interface SharedServerConfig<E> {
  /** The first snapshot's config, or the stream's failure. */
  readonly initialConfig: Effect.Effect<ServerConfig, E | RpcClientError>;
  /** One snapshot of the current config, then every later event unchanged. */
  readonly events: Stream.Stream<ServerConfigStreamEvent, E | RpcClientError>;
}

/**
 * Runs a connection's one `subscribeServerConfig` stream and serves it to
 * every consumer, so the config (about 250 KB) crosses the wire once per
 * connection. A late subscriber starts from a synthesized snapshot of the
 * current config, then sees the same events as everyone else.
 */
export const makeSharedServerConfig = <E>(
  source: Stream.Stream<ServerConfigStreamEvent, E>,
): Effect.Effect<SharedServerConfig<E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const feed = yield* SubscriptionRef.make<ServerConfigFeed>({ config: null, event: null });
    const firstConfig = yield* Deferred.make<ServerConfig, E | RpcClientError>();
    const failed = yield* Deferred.make<never, E | RpcClientError>();
    yield* source.pipe(
      Stream.runForEach((event) =>
        SubscriptionRef.updateAndGet(feed, (state) => ({
          config: applyServerConfigEvent(state.config, event),
          event,
        })).pipe(
          Effect.flatMap((state) =>
            state.config === null ? Effect.void : Deferred.succeed(firstConfig, state.config),
          ),
        ),
      ),
      Effect.andThen(Effect.fail(new RpcClientError({
        reason: new RpcClientDefect({ message: "The server config stream ended.", cause: undefined }),
      }))),
      Effect.catch((error: E | RpcClientError) =>
        Deferred.fail(firstConfig, error).pipe(Effect.andThen(Deferred.fail(failed, error))),
      ),
      Effect.forkScoped,
    );
    const events: Stream.Stream<ServerConfigStreamEvent, E | RpcClientError> = Stream.merge(
      SubscriptionRef.changes(feed).pipe(
        Stream.mapAccum(
          () => false,
          (started, state): readonly [boolean, ReadonlyArray<ServerConfigStreamEvent>] => {
            if (!started) {
              return state.config === null
                ? [false, []]
                : [true, [{ version: 1, type: "snapshot", config: state.config }]];
            }
            return [true, state.event === null ? [] : [state.event]];
          },
        ),
      ),
      Stream.fromEffect(Deferred.await(failed)),
    );
    return { initialConfig: Deferred.await(firstConfig), events };
  });
```

Run: `vp test run packages/client-runtime/src/rpc/sharedServerConfig.test.ts`
Expected: PASS (`Tests  7 passed (7)`).

- [ ] **Step 3: Session tests first**

In `packages/client-runtime/src/rpc/session.test.ts`:
1. Add `import * as Stream from "effect/Stream";`.
2. Replace `awaitRequest` so that it returns the index-th **Request** frame and ignores Acks and Pings:

```ts
const requestFrames = (socket: TestWebSocket) =>
  socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => decodeJson(frame) as { readonly _tag?: string })
    .filter((message) => message._tag === "Request")
    .map((message) => decodeRpcRequest(message));

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  index = 0,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = requestFrames(socket)[index];
    if (request) return request;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
});
```

3. Replace `completeInitialConfig` so it answers the config subscription with a snapshot chunk:

```ts
const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
  config = SERVER_CONFIG,
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.subscribeServerConfig,
    payload: {},
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Chunk",
      requestId: request.id,
      values: [{ version: 1, type: "snapshot", config: encodeServerConfig(config) }],
    }),
  );
  return request;
});
```

4. In `completeEncryptedInitialConfig`, change the expected tag to `WS_METHODS.subscribeServerConfig` and the reply to:

```ts
  sendRecords({
    _tag: "Chunk",
    requestId: request.id,
    values: [{ version: 1, type: "snapshot", config: encodeServerConfig(SERVER_CONFIG) }],
  });
```

5. In "owns one scoped websocket attempt and exposes readiness and closure", replace `expect(socket.sent).toHaveLength(1);` and `expect(typeof socket.sent[0]).toBe("string");` with `expect(requestFrames(socket).map((request) => request.tag)).toEqual([WS_METHODS.subscribeServerConfig]);`.

6. Append:

```ts
  it.effect("becomes ready from the first config snapshot without calling server.getConfig", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);
        expect(yield* session.initialConfig).toEqual(SERVER_CONFIG);
        expect(requestFrames(socket).map((request) => request.tag)).toEqual([
          WS_METHODS.subscribeServerConfig,
        ]);
      }),
    ),
  );

  it.effect("serves later config subscriptions from the one server stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        const configRequest = yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);

        const first = yield* session.client[WS_METHODS.subscribeServerConfig]({}).pipe(
          Stream.take(1),
          Stream.runCollect,
        );
        expect(Array.from(first)[0]).toMatchObject({ type: "snapshot" });
        const subscriber = yield* Effect.forkChild(
          session.client[WS_METHODS.subscribeServerConfig]({}).pipe(
            Stream.take(2),
            Stream.runCollect,
          ),
        );
        for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
        socket.serverMessage(
          encodeJson({
            _tag: "Chunk",
            requestId: configRequest.id,
            values: [
              { version: 1, type: "keybindingsUpdated", payload: { keybindings: [], issues: [] } },
            ],
          }),
        );
        const events = Array.from(yield* Fiber.join(subscriber));
        expect(events.map((event) => event.type)).toEqual(["snapshot", "keybindingsUpdated"]);
        expect(
          requestFrames(socket).filter(
            (request) => request.tag === WS_METHODS.subscribeServerConfig,
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("probes with an RPC Ping and succeeds at the next inbound message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);

        const probing = yield* Effect.forkChild(session.probe);
        for (let attempt = 0; attempt < 100 && pingsSent(socket) === 0; attempt += 1) {
          yield* Effect.yieldNow;
        }
        expect(pingsSent(socket)).toBe(1);
        expect(probing.pollUnsafe()).toBeUndefined();
        socket.serverMessage(encodeJson({ _tag: "Pong" }));
        yield* Fiber.join(probing);
      }),
    ).pipe(withFixedRandom),
  );

  it.effect("fails a health probe when the connection drops while it waits for data", () =>
    Effect.scoped(Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const ready = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(ready);
      const probing = yield* Effect.forkChild(Effect.flip(session.probe));
      for (let i = 0; i < 100 && pingsSent(socket) === 0; i += 1) yield* Effect.yieldNow;
      expect(pingsSent(socket)).toBe(1);
      expect(probing.pollUnsafe()).toBeUndefined();
      socket.close(1006, "");
      const error = yield* Fiber.join(probing);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.reason).toBe("connection-lost");
    })).pipe(withFixedRandom),
  );

  it.effect("fails the probe once the socket has closed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const ready = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);
        socket.open();
        yield* completeInitialConfig(socket);
        yield* Fiber.join(ready);
        socket.close(1000);
        yield* Effect.flip(session.closed);
        const error = yield* Effect.flip(session.probe);
        expect(error).toBeInstanceOf(ConnectionTransientError);
      }),
    ),
  );
```

Run: `vp test run packages/client-runtime/src/rpc/session.test.ts`
Expected: FAIL. The session still sends `server.getConfig`, so `completeInitialConfig` sees the wrong tag.

- [ ] **Step 4: Session implementation**

In `packages/client-runtime/src/rpc/session.ts`:
1. Add imports: `import { constPing } from "effect/unstable/rpc/RpcMessage";` and `import { makeSharedServerConfig } from "./sharedServerConfig.ts";`.
2. Replace everything from `const client = withInputAdmission(` through the end of the `const probe = …;` statement with:

```ts
    const admitted = withInputAdmission(
      yield* makeWsRpcProtocolClient.pipe(Effect.provideService(RpcClient.Protocol, protocol)),
    );
    // The connection's one config stream: readiness waits for its first
    // snapshot, and later subscribers replay it instead of opening another.
    const sharedConfig = yield* makeSharedServerConfig(
      admitted[WS_METHODS.subscribeServerConfig]({}),
    );
    const client: WsRpcProtocolClient = {
      ...admitted,
      [WS_METHODS.subscribeServerConfig]: () => sharedConfig.events,
    };
    const initialConfig = yield* Effect.cached(
      sharedConfig.initialConfig.pipe(
        Effect.mapError(mapInitialConfigError),
        Effect.withSpan("environment.initialSync"),
      ),
    );
    // Any inbound message after the Ping proves the connection is alive.
    const probe = Effect.suspend(() => {
      const before = activity.sequence();
      return protocol.send(0, constPing).pipe(Effect.andThen(activity.awaitAfter(before)));
    }).pipe(
      Effect.mapError(
        (error) =>
          new ConnectionTransientErrorClass({
            reason: "transport",
            detail: error.message,
          }),
      ),
      Effect.raceFirst(Deferred.await(disconnected)),
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );
```

Import `type * as Stream from "effect/Stream"` and replace the error alias with:

```ts
type InitialConfigError = Stream.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig]>
>;
```

The subscription already includes `RpcClientError` and Task 11's `RpcResponseTooLargeError`; its completed-source failure uses that existing `RpcClientError` branch. Treat unexpected source completion as a protocol failure so neither readiness nor subscribers wait forever.

In `packages/client-runtime/src/state/server.ts`:
1. Add `import { applyServerConfigEvent } from "../rpc/sharedServerConfig.ts";`.
2. Replace `applyServerConfigProjection` with:

```ts
export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  const config = applyServerConfigEvent(
    Option.getOrNull(Option.map(current, (projection) => projection.config)),
    event,
  );
  return config === null ? Option.none() : Option.some({ config, latestEvent: event });
}
```

- [ ] **Step 5: Run the client suites**

Run: `vp test run packages/client-runtime`
Expected: PASS. `state/server.test.ts` keeps passing with the shared reducer, and all session tests pass, including the ordered terminal-input tests (their requests are found by `awaitRequest` despite Acks).

- [ ] **Step 6: Gates**

Run: `vp check` and `vp run typecheck`
Expected: clean.

- [ ] **Step 7: Update the living docs**

1. `docs/architecture/connection-runtime.md`:
   - In "Ownership", replace "After the session is ready it verifies the initial `server.getConfig` descriptor through the same identity owner." with "After the session is ready it verifies the descriptor from the first `subscribeServerConfig` snapshot through the same identity owner."
   - In "State and retry policy", replace "- `connected`: the WebSocket is open and `server.getConfig` succeeded;" with "- `connected`: the WebSocket is open and the first `subscribeServerConfig` snapshot arrived;".
   - After the liveness paragraph from Task 2, add:

```markdown
Each session opens exactly one `subscribeServerConfig` stream. Readiness waits
for its first snapshot, and every later config subscription on that session
replays the same stream (a snapshot of the current config, then live events),
so the roughly 250 KB config crosses the wire once per connection. The
`application-active` health probe sends an RPC `Ping` and succeeds at the next
inbound message instead of re-fetching the config.
```

2. `docs/architecture/rpc-and-orchestration.md`, "Session establishment": replace "`RpcSessionFactory` then opens the socket, builds the Effect RPC client, and calls `server.getConfig`. The session is ready only after both steps succeed." with "`RpcSessionFactory` then opens the socket, builds the Effect RPC client, and opens the connection's one `subscribeServerConfig` stream. The session is ready only after the socket opens and the first snapshot arrives; later config subscriptions on the same session replay that stream."

- [ ] **Step 8: Checkpoint (no commit)**

Record `Task 13 <tree> client-runtime` in the ledger.

---

### Task 14: Byte caps for History pages and review diff previews

**Files:**
- Modify: `apps/server/src/git/manager/graph.rs` (page byte target)
- Modify: `apps/server/src/production/runtime.rs` (review source bound; review backend only)
- Test: `apps/server/src/git/manager/graph.rs` (`mod tests`), `apps/server/src/production/runtime.rs` (`mod tests`)
- Docs: `docs/architecture/overview.md` (Git Manager bullet)

**Interfaces:**
- Consumes: `page`, `GitManagerCommitEntry`, `COMMIT_PAGE_SIZE`, `MAX_REASONABLE_DIFF_SIZE` (graph.rs); `ReviewSource.truncated` (existing).
- Produces:
  - `pub const COMMIT_PAGE_TARGET_BYTES: usize = 1024 * 1024`
  - `fn commits_within_target(&[GitManagerCommitEntry], usize) -> usize`
  - `const MAX_REVIEW_SOURCE_DIFF_BYTES: usize = MAX_REASONABLE_DIFF_SIZE`
  - `fn bound_review_diff(diff: String, limit: usize, captured_truncated: bool) -> (String, bool)`
  - `async fn capture_review_diff<R: tokio::io::AsyncRead + Unpin>(reader: R, limit: usize) -> std::io::Result<(String, bool)>`

  The client needs no change: History pages already follow `nextOffset`, and the Diff panel already shows its "truncated" notice for `truncated` sources.

- [ ] **Step 1: Failing tests**

In `apps/server/src/git/manager/graph.rs` `mod tests`, append:

```rust
    fn entry_with_body(bytes: usize) -> GitManagerCommitEntry {
        GitManagerCommitEntry {
            sha: "a".repeat(40),
            short_sha: "a".repeat(7),
            parents: Vec::new(),
            decorations: Vec::new(),
            subject: "subject".to_owned(),
            body: "b".repeat(bytes),
            author_name: "Ann".to_owned(),
            author_email: "ann@example.test".to_owned(),
            authored_at_ms: 0,
            committer_name: "Cara".to_owned(),
            committer_email: "cara@example.test".to_owned(),
            committed_at_ms: 0,
            changed_files: Vec::new(),
        }
    }

    #[test]
    fn pages_keep_commits_up_to_the_byte_target_and_at_least_one() {
        let large: Vec<_> = (0..10).map(|_| entry_with_body(300 * 1024)).collect();
        assert_eq!(commits_within_target(&large, COMMIT_PAGE_TARGET_BYTES), 3);
        let huge = vec![entry_with_body(5 * 1024 * 1024), entry_with_body(10)];
        assert_eq!(commits_within_target(&huge, COMMIT_PAGE_TARGET_BYTES), 1);
        let small: Vec<_> = (0..100).map(|_| entry_with_body(100)).collect();
        assert_eq!(commits_within_target(&small, COMMIT_PAGE_TARGET_BYTES), 100);
    }

    #[test]
    fn history_budget_counts_json_escaping_instead_of_raw_string_lengths() {
        let mut entry = entry_with_body(0);
        entry.body = "\u{0001}".repeat(80 * 1024);
        entry.subject = "\\\"\\".repeat(1024);
        let encoded = serde_json::to_vec(&entry).expect("entry JSON").len();
        assert!(encoded > entry.body.len() * 5, "control characters expand in JSON");
        let entries = vec![entry.clone(), entry.clone(), entry];
        let kept = commits_within_target(&entries, COMMIT_PAGE_TARGET_BYTES);
        assert_eq!(kept, 2);
        let bytes = serde_json::to_vec(&entries[..kept]).expect("page JSON").len();
        assert!(bytes <= COMMIT_PAGE_TARGET_BYTES);
        assert!(serde_json::to_vec(&entries).expect("all JSON").len() > COMMIT_PAGE_TARGET_BYTES);
    }

    #[tokio::test]
    async fn a_page_of_large_commits_stops_near_one_mebibyte_and_pages_on() {
        let repository = repository_with_one_commit();
        for index in 0..14 {
            fs::write(repository.path().join("counter.txt"), format!("{index}\n"))
                .expect("fixture file");
            git(repository.path(), &["add", "counter.txt"]);
            let message = repository.path().join("message.txt");
            fs::write(&message, format!("large {index}\n\n{}", "b".repeat(90 * 1024)))
                .expect("commit message");
            git(
                repository.path(),
                &["commit", "-q", "-F", message.to_str().expect("utf-8 path")],
            );
        }
        let first = page(
            &GitRepository::default(),
            repository.path(),
            None,
            0,
            COMMIT_PAGE_SIZE,
            &CancellationToken::new(),
        )
        .await
        .expect("first history page");
        assert_eq!(first.commits.len(), 11, "eleven 90 KiB commits fit 1 MiB");
        assert_eq!(first.next_offset, Some(11));
        assert!(!first.exhausted);
        let second = page(
            &GitRepository::default(),
            repository.path(),
            Some(first.pinned_tips.as_slice()),
            11,
            COMMIT_PAGE_SIZE,
            &CancellationToken::new(),
        )
        .await
        .expect("second history page");
        assert_eq!(second.commits.len(), 4, "three large commits and the first one");
        assert!(second.exhausted);
    }
```

In `apps/server/src/production/runtime.rs` `mod tests`, append:

```rust
    #[test]
    fn review_diffs_over_the_bound_are_cut_at_a_file_boundary() {
        let first = format!("diff --git a/one b/one\n+{}\n", "1".repeat(40));
        let second = format!("diff --git a/two b/two\n+{}\n", "2".repeat(40));
        let diff = format!("{first}{second}");
        assert_eq!(bound_review_diff(diff.clone(), diff.len(), false), (diff.clone(), false));
        let (cut, truncated) = bound_review_diff(diff.clone(), first.len() + 16, false);
        assert!(truncated);
        assert_eq!(cut, first);
        let (empty, truncated) = bound_review_diff(diff, 10, false);
        assert!(truncated);
        assert!(empty.is_empty());
    }

    #[tokio::test]
    async fn review_capture_stops_reading_at_the_cap_plus_one_probe_byte() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Endless(Arc<AtomicUsize>);
        impl tokio::io::AsyncRead for Endless {
            fn poll_read(
                self: Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                let bytes = vec![b'x'; buf.remaining()];
                self.0.fetch_add(bytes.len(), Ordering::Relaxed);
                buf.put_slice(&bytes);
                std::task::Poll::Ready(Ok(()))
            }
        }
        let read = Arc::new(AtomicUsize::new(0));
        let (diff, truncated) = tokio::time::timeout(
            Duration::from_secs(1), capture_review_diff(Endless(Arc::clone(&read)), 128),
        ).await.expect("never wait for EOF on an oversized diff").expect("capture");
        assert_eq!(read.load(Ordering::Relaxed), 129);
        assert!(truncated);
        assert!(diff.len() <= 128);

        let first = "diff --git a/one b/one\n+one\n";
        let second = format!("diff --git a/two b/two\n+{}\n", "x".repeat(1000));
        let input = format!("{first}{second}");
        let (diff, truncated) = capture_review_diff(input.as_bytes(), first.len() + 32)
            .await.expect("capture bounded diff");
        assert!(truncated);
        assert_eq!(diff, first, "the incomplete last file is discarded");
    }

```

Run:
- `cargo test -p bibcode-server --lib git::manager::graph 2>&1 | tail -3`
- `cargo test -p bibcode-server --lib production::runtime::tests::review_diffs 2>&1 | tail -3`

Expected: compile errors (`commits_within_target`, `COMMIT_PAGE_TARGET_BYTES`, `bound_review_diff` not found).

- [ ] **Step 2: Implement the History byte target**

In `apps/server/src/git/manager/graph.rs`, after `const RECORD_SEPARATOR: char = '\u{1e}';` add:

```rust
/// History pages target 1 MiB of serialized commit JSON. Always retain one
/// commit so an unusually large entry cannot stop pagination.
pub const COMMIT_PAGE_TARGET_BYTES: usize = 1024 * 1024;

/// Serialization accounts for escaping, arrays, field names and numbers.
fn encoded_entry_bytes(entry: &GitManagerCommitEntry) -> usize {
    serde_json::to_vec(entry).expect("GitManagerCommitEntry serializes to JSON").len()
}

/// How many leading commits fit the page target; always at least one.
fn commits_within_target(commits: &[GitManagerCommitEntry], target: usize) -> usize {
    let mut total = 2_usize; // JSON array brackets
    for (index, entry) in commits.iter().enumerate() {
        total = total.saturating_add(encoded_entry_bytes(entry)).saturating_add(usize::from(index > 0));
        if total > target && index > 0 {
            return index;
        }
    }
    commits.len()
}
```

In `page`, replace everything from `let has_more = commits.len() > limit;` through the returned `Ok(GitManagerCommitPage { … })` with:

```rust
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let kept = commits_within_target(&commits, COMMIT_PAGE_TARGET_BYTES);
    let trimmed = kept < commits.len();
    commits.truncate(kept);
    let returned = commits.len();
    let more = has_more || trimmed;
    Ok(GitManagerCommitPage {
        generation,
        pinned_tips: selection.pinned_tips,
        commits,
        next_offset: more.then_some(offset.saturating_add(returned)),
        exhausted: !more,
        degraded_to_all_paging: selection.degraded_to_all_paging,
    })
```

- [ ] **Step 3: Implement the review source bound**

In `apps/server/src/production/runtime.rs` (current anchors: `GitReviewBackend` at 781, `run_review_diff` at 885, `untracked_review_diff` at 932):

1. Add these helpers after `MAX_UNTRACKED_REVIEW_TOTAL_BYTES`. The capture owns at most the cap plus one EOF/overflow probe byte and stops reading immediately on overflow:

```rust
const MAX_REVIEW_SOURCE_DIFF_BYTES: usize =
    crate::git::manager::graph::MAX_REASONABLE_DIFF_SIZE;

fn bound_review_diff(diff: String, limit: usize, captured_truncated: bool) -> (String, bool) {
    if !captured_truncated && diff.len() <= limit { return (diff, false); }
    let mut end = limit.min(diff.len());
    while !diff.is_char_boundary(end) { end -= 1; }
    let cut = diff[..end].rfind("\ndiff --git ").map_or(0, |index| index + 1);
    (diff[..cut].to_owned(), true)
}

async fn capture_review_diff<R: tokio::io::AsyncRead + Unpin>(
    reader: R, limit: usize,
) -> std::io::Result<(String, bool)> {
    let mut bytes = Vec::new();
    reader.take(limit.saturating_add(1) as u64).read_to_end(&mut bytes).await?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    Ok(bound_review_diff(
        String::from_utf8_lossy(&bytes).into_owned(), limit, truncated,
    ))
}
```

2. Replace `run_review_diff` completely. Do not use `Command::output()` then truncate; stop capture, kill and reap git after overflow. The existing background/AppImage setup stays in place:

```rust
async fn run_review_diff(cwd: &str, args: Vec<String>) -> Result<UntrackedReviewDiff, ReviewError> {
    let mut command = Command::new("git");
    configure_background_command(&mut command);
    crate::process::isolate_appimage_environment(&mut command);
    let mut child = command
        .args(["-C", cwd]).args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn().map_err(|error| ReviewError::Backend(error.to_string()))?;
    let stdout = child.stdout.take().expect("piped git stdout");
    let captured = capture_review_diff(stdout, MAX_REVIEW_SOURCE_DIFF_BYTES).await;
    if !matches!(&captured, Ok((_, false))) {
        let _ = child.start_kill();
    }
    let status = child.wait().await.map_err(|error| ReviewError::Backend(error.to_string()))?;
    let (diff, truncated) = captured.map_err(|error| ReviewError::Backend(error.to_string()))?;
    Ok(UntrackedReviewDiff {
        diff: if status.success() || truncated { diff } else { String::new() },
        truncated,
    })
}
```

3. Replace the untracked call and working-tree assembly with:

```rust
            let untracked = if tracked_worktree.truncated {
                UntrackedReviewDiff { diff: String::new(), truncated: false }
            } else {
                untracked_review_diff(
                    &input.cwd,
                    MAX_REVIEW_SOURCE_DIFF_BYTES.saturating_sub(tracked_worktree.diff.len() + 1),
                ).await?
            };
            let (working_tree_diff, working_tree_truncated) = bound_review_diff(
                join_review_diffs(&tracked_worktree.diff, &untracked.diff),
                MAX_REVIEW_SOURCE_DIFF_BYTES,
                false,
            );
```

In the branch match, replace `_ => String::new()` with:

```rust
                _ => UntrackedReviewDiff { diff: String::new(), truncated: false },
```

In the source arguments, replace `untracked.truncated` with
`tracked_worktree.truncated || untracked.truncated || working_tree_truncated`,
and replace the branch's `branch_diff, false` with
`branch_diff.diff, branch_diff.truncated`.

4. Change `untracked_review_diff` to accept `limit: usize`. After its existing
`let mut truncated = false;` insert `let mut patch_bytes = 0_usize;`.
Inside the loop, before metadata/file reads, insert:

```rust
        if patch_bytes >= limit {
            truncated = true;
            break;
        }
```

Replace the existing `tokio::fs::read(&absolute)` block and the final
`diffs.push(if contents.contains(&0) …);` with:

```rust
        let file = tokio::fs::File::open(&absolute).await
            .map_err(|error| ReviewError::Backend(error.to_string()))?;
        let remaining = limit.saturating_sub(patch_bytes);
        let mut contents = Vec::new();
        file.take(remaining.saturating_add(1) as u64).read_to_end(&mut contents).await
            .map_err(|error| ReviewError::Backend(error.to_string()))?;
        if contents.len() > remaining {
            truncated = true;
            break;
        }
        total_bytes = total_bytes.saturating_add(contents.len() as u64);
        let diff = if contents.contains(&0) {
            binary_untracked_diff(&path)
        } else {
            text_untracked_diff(&path, &String::from_utf8_lossy(&contents))
        };
        if patch_bytes.saturating_add(diff.len() + usize::from(!diffs.is_empty())) > limit {
            truncated = true;
            break;
        }
        patch_bytes += diff.len() + usize::from(!diffs.is_empty());
        diffs.push(diff);
```

The existing metadata-overflow branch must also count its binary marker before
pushing it; replace that branch's `diffs.push(binary_untracked_diff(&path));`
with:

```rust
            let marker = binary_untracked_diff(&path);
            let bytes = marker.len() + usize::from(!diffs.is_empty());
            if patch_bytes.saturating_add(bytes) > limit {
                truncated = true;
                break;
            }
            patch_bytes += bytes;
            diffs.push(marker);
```

Keep the existing total/file-count caps. Update each existing
`untracked_review_diff(cwd)` test call to
`untracked_review_diff(cwd, MAX_REVIEW_SOURCE_DIFF_BYTES)`; the helper is local
to this review backend. In `review_diff_commands_ignore_appimage_environment` (re-verified declaration at line 2708; tracked-diff expectation at line 2727), change `.expect("tracked review diff"),` to `.expect("tracked review diff").diff,` for the new capture result. No source captures an entire oversized git diff first.

This file carries the PR-panel agent's uncommitted runtime edits. Re-read `GitReviewBackend` and `review_diff_commands_ignore_appimage_environment` before applying this task; touch only that review backend region.

- [ ] **Step 4: Run the tests**

Run:
- `cargo test -p bibcode-server --lib git::manager::graph`
- `cargo test -p bibcode-server --lib production::runtime::tests`
- `cargo test -p bibcode-server --test git_manager_reads --test production_git_manager_rpc`

Expected: all pass. `production_git_manager_rpc.rs` carries another agent's edits; classify unrelated failures per the flake rules.

- [ ] **Step 5: Lints**

Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Update the living doc**

In `docs/architecture/overview.md`, in the Git Manager bullet, replace "tip-pinned history pages, diff and" with "tip-pinned history pages (at most 100 commits and about 1 MiB each), diff and". Also add: "Review preview sources stop capturing git output at the patch cap, discard the last incomplete file, and set `truncated`; History budgets count serialized JSON including escaping." This records the changed capture and byte-budget invariants.

- [ ] **Step 7: Checkpoint (no commit)**

Record `Task 14 <tree> graph + runtime tests + git_manager_reads + production_git_manager_rpc` in the ledger.

---

### Task 15: A cut-off request is re-issued once, then waits for Retry

**Files:**
- Modify: `packages/client-runtime/src/state/runtime.ts` (`createEnvironmentQueryAtomFamily` and explicit retry helper)
- Test: `packages/client-runtime/src/state/queryTransport.test.ts` (new; keeps other agents' `runtime.test.ts` untouched)
- Modify: `packages/client-runtime/src/state/gitManager.ts` (forward explicit Retry through wrappers; omit local cache identity from the cutoff key)
- Modify: `apps/web/src/components/gitManager/history/GitManagerHistoryView.tsx` (keep automatic recovery on the non-Retry path)
- Test: `apps/web/src/components/gitManager/history/GitManagerHistoryView.test.tsx` (query-view mock gains the automatic revalidation callback)
- Modify: `apps/web/src/state/query.ts` (`formatEnvironmentQueryError`, explicit Retry callback)
- Test: `apps/web/src/state/query.test.ts` (new)
- Modify: `apps/web/src/components/status-bar/AppStatusBar.tsx`, `apps/web/src/components/ChatView.tsx` (automatic timers preserve retry exhaustion)
- Test: `apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx`, `apps/web/src/components/ChatView.test.tsx` (real timer consumers)
- Modify/test: the automatic consumers and their existing test doubles listed in Step 2's migration table
- Docs: `docs/architecture/connection-runtime.md`

**Interfaces:**
- Consumes: the `rpcGenerationAtom` inside `createEnvironmentQueryAtomFamily`, and `RpcClientError` from `effect/unstable/rpc`.
- Produces:
  - Query atoms keep their type. Cutoff state is keyed by environment plus request input and survives remount/atom eviction. After the one automatic re-issue fails, every automatic path re-emits the stored failure. Only `retryEnvironmentQuery(atom, refresh)` clears it.
  - `export const QUERY_CONNECTION_DROPPED_MESSAGE = "The connection dropped before the result arrived."` (web).

- [ ] **Step 1: Failing client-runtime test**

Create `packages/client-runtime/src/state/queryTransport.test.ts`:

```ts
// @effect-diagnostics globalTimers:off - A bounded real-time pause proves no request was sent.
import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { createEnvironmentQueryAtomFamily, retryEnvironmentQuery, forwardEnvironmentQueryRetry } from "./runtime.ts";

const ENVIRONMENT_ID = EnvironmentId.make("query-transport-test");

const cutOff = () =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketCloseError({ code: 4408, closeReason: "liveness timeout" }),
  });

const makeHarness = Effect.fn("TestQueryTransport.makeHarness")(function* (
  outcomes: ReadonlyArray<"cut" | "ok">,
  refreshIntervalMs?: number,
) {
  let calls = 0;
  const connection = yield* SubscriptionRef.make({ phase: "connected", generation: 1 });
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID, label: "Query test" },
    session: yield* SubscriptionRef.make(Option.none()),
    state: connection,
  } as never);
  const environment = EnvironmentRegistry.of({
    run: <A, E>(_: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (
      _: EnvironmentId,
      stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
    ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as never);
  const query = createEnvironmentQueryAtomFamily(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environment)),
    {
      label: "test:query-transport",
      staleTimeMs: 0, // Remount really attempts SWR revalidation in these regressions.
      transportCutoffKey: (_input: { readonly refreshCacheKey: string }) => ({}),
      ...(refreshIntervalMs === undefined ? {} : { refreshIntervalMs }),
      execute: () =>
        Effect.suspend(() => {
          const outcome = outcomes[calls] ?? "ok";
          calls += 1;
          return outcome === "cut" ? Effect.fail(cutOff()) : Effect.succeed("page");
        }),
    },
  );
  return {
    atom: query({ environmentId: ENVIRONMENT_ID, input: { refreshCacheKey: "first" } }),
    remountAtom: (refreshCacheKey: string) => query({ environmentId: ENVIRONMENT_ID, input: { refreshCacheKey } }),
    calls: () => calls,
    reconnect: (generation: number) =>
      SubscriptionRef.set(connection, { phase: "connected", generation }),
    registry: AtomRegistry.make(),
  };
});

const settle = () => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));

describe("createEnvironmentQueryAtomFamily after transport cut-offs", () => {
  it.effect("re-issues a cut-off request once on the next connection", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(["cut", "ok"]);
      h.registry.mount(h.atom);
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(AsyncResult.isFailure(h.registry.get(h.atom))).toBe(true)),
      );
      yield* h.reconnect(2);
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(AsyncResult.isSuccess(h.registry.get(h.atom))).toBe(true)),
      );
      expect(h.calls()).toBe(2);
    }),
  );

  it.effect("waits for an explicit Retry after two cut-offs in a row", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(["cut", "cut", "ok"]);
      h.registry.mount(h.atom);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.calls()).toBe(1)));
      yield* h.reconnect(2);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.calls()).toBe(2)));
      yield* h.reconnect(3);
      yield* settle();
      expect(h.calls()).toBe(2);
      expect(AsyncResult.isFailure(h.registry.get(h.atom))).toBe(true);
      retryEnvironmentQuery(h.atom, () => h.registry.refresh(h.atom));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(AsyncResult.isSuccess(h.registry.get(h.atom))).toBe(true)),
      );
      expect(h.calls()).toBe(3);
    }),
  );

  it.effect("does not send a third request on stale revalidation or remount", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(["cut", "cut", "ok"]);
      const unmount = h.registry.mount(h.atom);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.calls()).toBe(1)));
      yield* h.reconnect(2);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.calls()).toBe(2)));
      unmount();
      const release = h.registry.mount(h.atom);
      h.registry.refresh(h.atom); // automatic invalidation does not authorize Retry
      yield* settle();
      expect(h.calls()).toBe(2);
      expect(AsyncResult.isFailure(h.registry.get(h.atom))).toBe(true);
      release();
      h.registry.dispose();
    }),
  );

  it.effect("keeps exhaustion across new local cache keys and forwards explicit Retry through wrappers", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(["cut", "cut", "ok"]);
      const unmount = h.registry.mount(h.atom);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.calls()).toBe(1)));
      yield* h.reconnect(2);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.calls()).toBe(2)));
      unmount();
      const remounted = h.remountAtom("new-view");
      const wrapped = forwardEnvironmentQueryRetry(
        remounted, remounted.pipe(Atom.makeRefreshOnSignal(Atom.make(0))),
      );
      h.registry.mount(wrapped);
      yield* settle();
      expect(h.calls()).toBe(2);
      retryEnvironmentQuery(wrapped, () => h.registry.refresh(wrapped));
      yield* Effect.promise(() => vi.waitFor(() =>
        expect(AsyncResult.isSuccess(h.registry.get(wrapped))).toBe(true)));
      expect(h.calls()).toBe(3);
      h.registry.dispose();
    }),
  );

  it.effect("suppresses periodic refresh after the automatic re-issue fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(["cut", "cut", "ok"], 20);
      h.registry.mount(h.atom);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.calls()).toBe(1)));
      yield* settle();
      expect(h.calls()).toBe(1); // first cut-off waits for a different connection
      yield* h.reconnect(2);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.calls()).toBe(2)));
      yield* settle(); // several periodic ticks
      yield* h.reconnect(3);
      yield* settle();
      expect(h.calls()).toBe(2);
      retryEnvironmentQuery(h.atom, () => h.registry.refresh(h.atom));
      yield* Effect.promise(() => vi.waitFor(() =>
        expect(AsyncResult.isSuccess(h.registry.get(h.atom))).toBe(true)));
      h.registry.dispose();
    }),
  );

});
```

Run: `vp test run packages/client-runtime/src/state/queryTransport.test.ts`
Expected: the first test PASSES (today's behavior already re-issues on every connection). The second FAILS with `expected 3 to be 2`, because today generation 3 re-runs the request.

- [ ] **Step 1a: Failing tests for the actual timer consumers**

In `AppStatusBar.behavior.test.tsx`, extend the hoisted query-view type with `revalidate: ReturnType<typeof vi.fn>;` and `requiresRetry: boolean;`. Replace its `query` helper with:

```ts
function query(data: unknown = null, isPending = false, error: string | null = null) {
  return { data, error, isPending, refresh: vi.fn(), revalidate: vi.fn(), requiresRetry: false };
}
```

Append inside the existing status-bar behavior describe:

```tsx
it("keeps exhausted queries latched through usage and resource timer ticks", async () => {
  vi.useFakeTimers();
  harness.selectedEnvironment = { environmentId: EnvironmentId.make("remote") };
  harness.primaryLocalEnvironment = { environmentId: EnvironmentId.make("local") };
  harness.queries = [
    query({ providers: [] }, false, "The connection dropped."),
    query(null, false, "The connection dropped."),
    query(null, false, "The connection dropped."),
  ];
  for (const value of harness.queries) value.requiresRetry = true;
  renderStatusBar();
  const cleanups = harness.effects.map((effect) => effect());
  try {
    await vi.advanceTimersByTimeAsync(61_000); // 30 s usage and 2 s resource intervals
    expect(harness.refreshProviderUsage).toHaveBeenCalledTimes(3);
    for (const value of harness.queries) {
      expect(value.revalidate).toHaveBeenCalled();
      expect(value.refresh).not.toHaveBeenCalled();
      expect(value.requiresRetry).toBe(true);
    }
  } finally {
    for (const cleanup of cleanups.reverse()) if (typeof cleanup === "function") cleanup();
  }
});
```

Existing assertions for automatic refresh effects (for example "replaces refresh intervals when the environment changes") now assert `revalidate`; explicit button assertions keep `refresh`. Add both fields to the query doubles in the other `AppStatusBar*.test.tsx` files as well.

In `ChatView.test.tsx`, add these fields beside `queryRefreshCalls` in the hoisted harness and clear them in `beforeEach`:

```ts
    queryRevalidationCalls: [] as string[],
    queryRetryCalls: [] as string[],
    queryAwaitingRetry: new Set<string>(),
```

```ts
  h.queryRevalidationCalls = [];
  h.queryRetryCalls = [];
  h.queryAwaitingRetry.clear();
```

In its existing `useEnvironmentQuery` double (current lines 200–246), replace only `refresh` and add the other two fields. `queryRefreshCalls` remains the combined observer used by existing tests; the new observers distinguish authorization to Retry from automatic revalidation:

```ts
        refresh: () => {
          if (key === null) return;
          h.queryRetryCalls.push(key);
          h.queryAwaitingRetry.delete(key);
          h.queryRefreshCalls.push(key);
        },
        revalidate: () => {
          if (key === null) return;
          h.queryRevalidationCalls.push(key);
          h.queryRefreshCalls.push(key);
        },
        requiresRetry: key !== null && h.queryAwaitingRetry.has(key),
```

Append next to "refreshes open activity queries from the first page when the snapshot revision advances" (current line 2796). Reuse that describe's actual mounted ChatView, stores, fixtures and ActivityPanel handlers:

```tsx
it("keeps exhausted roster and detail queries latched across snapshot timers", async () => {
  const child = actor("actor-liveness", "Liveness inspector");
  const snapshot = activitySnapshot({ _tag: "thread", threadId }, [child]);
  seedEnvironment(makeEnvironmentPresentation());
  seedProject(makeProject());
  seedServerThread(makeThread());
  seedGitStatus(true);
  seedActivityState(environmentId, snapshot.scope, snapshot);
  seedActivityQueries(environmentId, snapshot, [child]);
  const { container, root } = await mountActivityRoute();
  try {
    await openSubagents(container);
    await vi.waitFor(() =>
      expect(container.querySelector(`[data-activity-row="${child.id}"]`)).not.toBeNull());
    await click(container.querySelector(`[data-activity-row="${child.id}"]`)!);
    await vi.waitFor(() => expect(h.queryRefreshCalls.length).toBeGreaterThan(0));
    const keys = [...h.activeQuerySubscriptions.keys()].filter(
      (key) => key.startsWith("activity-roster:") || key.startsWith("activity-detail:"),
    );
    expect(keys.some((key) => key.startsWith("activity-detail:"))).toBe(true);
    expect(keys.filter((key) => key.startsWith("activity-roster:"))).toHaveLength(2);
    for (const key of keys) {
      h.queryAwaitingRetry.add(key);
      h.queryEmissionsByKey.set(key, AsyncResult.failure(
        Cause.fail(new Error("The connection dropped before the result arrived.")),
      ));
    }
    h.queryRetryCalls = [];
    h.queryRevalidationCalls = [];
    vi.useFakeTimers();
    for (const revision of [2, 3, 4]) {
      seedActivityState(environmentId, snapshot.scope,
        activitySnapshot(snapshot.scope, [child], { revision }));
      await act(async () => {
        root.render(<ChatView environmentId={environmentId} threadId={threadId}
          routeKind="server" reserveTitleBarControlInset />);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    for (const key of keys) {
      expect(h.queryRevalidationCalls).toContain(key);
      expect(h.queryAwaitingRetry.has(key)).toBe(true);
    }
    expect(h.queryRetryCalls).toEqual([]);
    // The failed-detail Retry handler is an explicit user action.
    await act(async () => { latestActivityPanelProps().onLoadMoreDetail(); });
    expect(h.queryRetryCalls.some((key) => key.startsWith("activity-detail:"))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  }
});
```

Run: `vp test run apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx apps/web/src/components/ChatView.test.tsx`.
Expected: FAIL because today's timer callbacks invoke `refresh`. The runtime tests above prove the real latch and request counts; these mounted/captured consumer tests prove the actual timers never invoke its clearing action.

- [ ] **Step 2: Implement the bookkeeping**

In `packages/client-runtime/src/state/runtime.ts`:
1. Add imports: `import * as Schema from "effect/Schema";` and `import { RpcClientError } from "effect/unstable/rpc";`.
2. Before `export function createEnvironmentQueryAtomFamily`, add:

```ts
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const queryRetries = new WeakMap<object, {
  readonly retry: () => void;
  readonly awaitingRetry: () => boolean;
}>();

/** Call only from an explicit user Retry, never from automatic invalidation. */
export function retryEnvironmentQuery(atom: object, refresh: () => void): void {
  queryRetries.get(atom)?.retry();
  refresh();
}

export function isEnvironmentQueryAwaitingRetry(atom: object): boolean {
  return queryRetries.get(atom)?.awaitingRetry() ?? false;
}

/** A query wrapper retains the source query's explicit Retry action. */
export function forwardEnvironmentQueryRetry<A extends object>(source: object, exposed: A): A {
  const retry = queryRetries.get(source);
  if (retry !== undefined) queryRetries.set(exposed, retry);
  return exposed;
}

interface QueryTransportState<E> {
  /** 0: normal; 1: waiting for a new session; 2: automatic budget exhausted. */
  cutoffs: number;
  cutoffGeneration: number | null;
  lastCutoff: Cause.Cause<E> | null;
}

function isTransportCutoff(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some(
    (reason) => Cause.isFailReason(reason) && isRpcClientError(reason.error),
  );
}

function recordQueryOutcome<A, E>(
  state: QueryTransportState<E>, generation: number, exit: Exit.Exit<A, E>,
): void {
  if (Exit.isSuccess(exit)) {
    state.cutoffs = 0;
    state.cutoffGeneration = null;
    state.lastCutoff = null;
  } else if (!Cause.hasInterruptsOnly(exit.cause)) {
    if (state.cutoffs === 2) {
      // Every failure of the one automatic re-issue latches, including a
      // typed server error; remount/refresh/generation cannot authorize more.
      state.lastCutoff = exit.cause;
    } else if (isTransportCutoff(exit.cause)) {
      state.cutoffs = 1;
      state.cutoffGeneration = generation;
      state.lastCutoff = exit.cause;
    }
  }
}
```

3. In `createEnvironmentQueryAtomFamily`, before `const family = Atom.family`, add the cutoff-only map. It survives idle atom eviction; successful queries leave no entry:

```ts
  const cutoffsByKey = new Map<string, QueryTransportState<E | EnvironmentNotRegisteredError>>();
```

Add to `EnvironmentQueryAtomOptions`:

```ts
  /** Stable wire-request identity when input also carries local cache metadata. */
  readonly transportCutoffKey?: (input: Input) => unknown;
```

Inside that family, after `const idleTtlMs = …;`, add:

```ts
    const cutoffKey = environmentRpcKey({
      environmentId: target.environmentId,
      input: options.transportCutoffKey?.(target.input) ?? target.input,
    });
```

Replace the body of `runtime.atom((get) => { … })` with:

```ts
        const generation = Option.getOrNull(
          AsyncResult.value(get(rpcGenerationAtom(target.environmentId))),
        );
        if (generation === null) return Effect.never;
        return Effect.suspend(() => {
          const transport: QueryTransportState<E | EnvironmentNotRegisteredError> =
            cutoffsByKey.get(cutoffKey) ?? {
              cutoffs: 0, cutoffGeneration: null, lastCutoff: null,
            };
          if (transport.lastCutoff !== null) {
            if (transport.cutoffs >= 2 || generation === transport.cutoffGeneration) {
              return Effect.failCause(transport.lastCutoff);
            }
            // Consume the sole automatic re-issue before starting it.
            transport.cutoffs = 2;
          }
          return runInEnvironment(target.environmentId, options.execute(target.input)).pipe(
            Effect.onExit((exit) => Effect.sync(() => {
              recordQueryOutcome(transport, generation, exit);
              if (transport.cutoffs === 0) cutoffsByKey.delete(cutoffKey);
              else cutoffsByKey.set(cutoffKey, transport);
            })),
          );
        });
```

Keep the existing `Atom.swr` and `withQueryRefreshInterval` wrappers. Replace the family's final return with:

```ts
    const exposed = (
      options.refreshIntervalMs === undefined
        ? queryAtom
        : withQueryRefreshInterval(queryAtom, options.refreshIntervalMs)
    ).pipe(Atom.setIdleTTL(idleTtlMs), Atom.withLabel(`${options.label}:${key}`));
    queryRetries.set(exposed, {
      retry: () => { cutoffsByKey.delete(cutoffKey); },
      awaitingRetry: () => (cutoffsByKey.get(cutoffKey)?.cutoffs ?? 0) >= 2,
    });
    return exposed;
```

In `apps/web/src/state/query.ts`, import `retryEnvironmentQuery` and `isEnvironmentQueryAwaitingRetry` from
`@bibcode/client-runtime/state/runtime` and `useCallback` from `react`.
Add `readonly revalidate: () => void;` and `readonly requiresRetry: boolean;` to `EnvironmentQueryView`. Automatic refreshes preserve cutoff state, and wrapper views can keep a latched failure visible. In `useEnvironmentQuery`, replace the existing refresh binding with:

```ts
  const refreshAtom = useAtomRefresh(selectedAtom);
  const refresh = useCallback(
    () => retryEnvironmentQuery(selectedAtom, refreshAtom),
    [selectedAtom, refreshAtom],
  );
```

In `packages/client-runtime/src/state/gitManager.ts`, import
`forwardEnvironmentQueryRetry` from `./runtime.ts`. In `refreshOnDegradedFocus`,
replace the `return query(target).pipe(…)` with:

```ts
      const source = query(target);
      return forwardEnvironmentQueryRetry(source, source.pipe(
        Atom.makeRefreshOnSignal(focusRefresh(scopeKey)),
        Atom.setIdleTTL(0),
      ));
```

Set `transportCutoffKey` on the two History factories whose input contains a
local `refreshCacheKey` (that key changes on remount, but the wire request does not):

```ts
        // getHistoryFirstPage options:
        transportCutoffKey: (input) => ({ cwd: input.cwd, limit: input.limit }),
```

```ts
      // getRetainedCommitPages options:
      transportCutoffKey: (input) => ({
        cwd: input.cwd, pinnedTips: input.pinnedTips, offsets: input.offsets, limit: input.limit,
      }),
```

Return `revalidate: refreshAtom,` and `requiresRetry: isEnvironmentQueryAwaitingRetry(selectedAtom),` beside `refresh,` in the hook's result.
This hook's returned `refresh` clears the latch only for an explicit Retry.
In `GitManagerHistoryView.tsx`, add
`const revalidateFirstPage = firstPageQuery.revalidate;` beside the existing
`refreshFirstPage` binding. In the `nextPageTipsUnresolvable` effect (current
line 569), replace its `refreshFirstPage();` call and dependency entry with
`revalidateFirstPage();` / `revalidateFirstPage`. Keep the explicit
`handleRefresh` and failure-card Retry on `refreshFirstPage`.
Add `revalidate: vi.fn(),` to that component test's `useEnvironmentQuery`
mock. This prevents its automatic paging recovery from clearing exhaustion.

Preserve the current `rpcGenerationAtom` / `followStreamInEnvironment` wiring in `runtime.ts:532` and `registry.ts`'s `followStream` (current line 442): absent installations idle, and later installations rebind. Do not replace it with `runStream` or complete the follower when an environment disappears.

Migrate automatic consumers of this hook to `revalidate` too. These are targeted
edits to existing callbacks; add the listed files and their closest existing
tests to Task 15's file scope, preserve their other agents' changes, and change
the matching dependency entry along with each callback:

| Current automatic call site (verified in the tree) | Complete replacement inside that existing callback |
| --- | --- |
| `apps/web/src/components/pullRequests/shared/usePullRequestsQuery.ts`, open/remount effect event | `const refresh = useEffectEvent(() => query.revalidate());` |
| `apps/web/src/components/SourceControlCommits.tsx`, reload/expand effect | `query.revalidate();` |
| `apps/web/src/components/CreateWorktreeDialog.tsx`, refs-enabled effect | `if (refsEnabled && !wasEnabled) refsQuery.revalidate();` |
| `apps/web/src/components/DiffPanel.tsx`, Git signal effect | `branchDiffPreview.revalidate();` |
| `apps/web/src/components/RemoteDirectoryBrowser.tsx`, post-navigation effect | `query.revalidate();` |
| `apps/web/src/components/ChatView.tsx`, snapshot-revision timer and newest-page reset | Use `revalidate` on all three bounded queries; preserve explicit Retry intent across cursor reset as shown below. |
| `apps/web/src/components/status-bar/AppStatusBar.tsx`, usage and resource intervals | Use `revalidate` for `performRefresh(false)` and resource polling; only `performRefresh(true)` from the user uses `refresh`, as shown below. |
| `apps/web/src/components/gitManager/GitManagerPanel.tsx`, refs and stash signal effects | Add `const revalidateRefs = refsQuery.revalidate;` and `const revalidateStashes = stashesQuery.revalidate;`; use those callbacks and dependencies in the two signal effects. Keep manual Refresh/Retry aliases separate. |
| `apps/web/src/components/gitManager/GitManagerToolbar.tsx`, refs signal effect | Add `const revalidateRefs = refsQuery.revalidate;`; the effect becomes `if (signalGeneration !== null) revalidateRefs();` with `[revalidateRefs, signalGeneration]`. |
| `apps/web/src/components/gitManager/changes/GitManagerChangesView.tsx`, refs signal effect | Add `const revalidateRefs = refsQuery.revalidate;`; use it in the signal effect and its dependency array. |
| `apps/web/src/components/files/FileBrowserPanel.tsx`, entry-change signal effect | Add `const revalidateEntries = entriesQuery.revalidate;`; replace only that effect's call/dependency with `revalidateEntries`, retaining `handledEntryChangeRef`. |
| `apps/web/src/components/settings/remote-servers/ConnectTab.tsx`, update refresh epoch effect | Add `const revalidateUpdateStatus = updateQuery.revalidate;`; call it when `remoteUpdateControl && updateRefreshEpoch > 0` and use `[revalidateUpdateStatus, remoteUpdateControl, updateRefreshEpoch]`. Preserve explicit `onRetryUpdate`. |
| `apps/web/src/components/BranchToolbarBranchSelector.tsx`, opening the branch menu and post-branch-action reads | Replace `branchRefState.refresh()` with `branchRefState.revalidate()` in `handleOpenChange` / `runBranchAction`; replace the latter's `branchStatusQuery.refresh()` with `branchStatusQuery.revalidate()`; update dependencies. |
| `apps/web/src/components/gitManager/changes/GitManagerDiffPane.tsx`, renderer stale callback and automatic post-mutation reload | Add `const revalidateDiff = diffQuery.revalidate;`; use `onStale={revalidateDiff}` and `revalidateDiff()` after partial-stage/discard completion; keep explicit Refresh/Retry on `refreshDiff`. |

Post-mutation cache reads are automatic revalidation too. In the already named `GitManagerPanel`, `GitManagerToolbar`, `GitManagerChangesView`, `FileBrowserPanel` and `BranchToolbarBranchSelector` mutation-success/failure-finally callbacks, use the corresponding query's `revalidate()` and dependency alias. A manual Refresh/Retry action may clear exhaustion; opening a view, an event/epoch, or completing a mutation may not. Audit direct and aliased callbacks with `rg -n '\\.refresh|refresh[A-Z]|onStale|onFinished|setInterval|setTimeout' apps/web/src/components apps/web/src/state` before the Step 4 gate. The archived-thread reconciler uses its separate raw Atom refresh owner, which never calls `retryEnvironmentQuery`; keep it unchanged.

The two timer consumers need complete callback separation:

1. `AppStatusBar.tsx`: replace the existing `performRefresh` binding (current line 336) with:

```tsx
  const performRefresh = useCallback(
    (force: boolean) => createStatusBarRefreshHandler({
      environmentId,
      refreshProviderUsage,
      refreshUsageQuery: force ? usage.refresh : usage.revalidate,
      refreshProcessDiagnostics: force ? diagnostics.refresh : diagnostics.revalidate,
      refreshLocalProcessDiagnostics: primaryLocalEnvironmentId === null
        ? null
        : force ? localDiagnostics.refresh : localDiagnostics.revalidate,
    })(force),
    [
      diagnostics.refresh, diagnostics.revalidate, environmentId,
      localDiagnostics.refresh, localDiagnostics.revalidate, primaryLocalEnvironmentId,
      refreshProviderUsage, usage.refresh, usage.revalidate,
    ],
  );
```

The existing automatic `refresh` callback still calls `performRefresh(false)`; the explicit user refresh/Retry still calls `performRefresh(true)`. Replace the `resourceRefresh` binding with:

```tsx
  const resourceRefresh = useCallback(
    createStatusBarResourceRefreshHandler({
      environmentId,
      refreshProcessDiagnostics: diagnostics.revalidate,
      refreshLocalProcessDiagnostics:
        primaryLocalEnvironmentId === null ? null : localDiagnostics.revalidate,
    }),
    [diagnostics.revalidate, environmentId, localDiagnostics.revalidate, primaryLocalEnvironmentId],
  );
```

Both existing interval effects keep their ref-based scheduling and cleanup; no new timer or query state owner is introduced.

2. `ChatView.tsx`: add `readonly revalidate: () => void;` to `BoundedActivityQuery`. Inside `useBoundedActivityQuery`, replace `newestRefreshKeyRef` with:

```tsx
  const newestRefreshKeyRef = useRef<{ key: string; retry: boolean } | null>(null);
```

Replace its newest-page effect with:

```tsx
  useEffect(() => {
    const pending = newestRefreshKeyRef.current;
    if (queryKey === null || current.cursor !== null || pending?.key !== queryKey) return;
    newestRefreshKeyRef.current = null;
    if (pending.retry) query.refresh();
    else query.revalidate();
  }, [current.cursor, query.refresh, query.revalidate, queryKey]);
```

Keep the explicit failed-cursor `loadMore` action. Replace its `refresh` callback with these complete callbacks:

```tsx
  const refreshNewest = useCallback((retry: boolean) => {
    if (queryKey === null) return;
    if (current.cursor === null) {
      if (retry) query.refresh();
      else query.revalidate();
      return;
    }
    newestRefreshKeyRef.current = { key: queryKey, retry };
    setState((previous) => ({
      key: queryKey,
      cursor: null,
      pages: previous.key === queryKey ? previous.pages : [],
    }));
  }, [current.cursor, query.refresh, query.revalidate, queryKey]);
  const refresh = useCallback(() => refreshNewest(true), [refreshNewest]);
  const revalidate = useCallback(() => refreshNewest(false), [refreshNewest]);
```

Add `revalidate,` beside `refresh,` in the returned memo and include it in that memo's dependency array. In `ActivityPanelBinding`, replace the snapshot timer's ref callback (current lines 662–667) with:

```tsx
  const refreshQueriesRef = useRef<() => void>(() => undefined);
  refreshQueriesRef.current = () => {
    activeRoster.revalidate();
    doneRoster.revalidate();
    detailQuery.revalidate();
  };
```

Keep the existing 100 ms snapshot-revision debounce and unmount cleanup unchanged. Returning to the first page must preserve whether the initiating action was automatic or explicit; merely changing the newest-page effect without changing this timer's wrapper calls is insufficient.

Repeat the two consumer test commands from Step 1a: expected PASS. Also run `vp test run apps/web/src/components/status-bar apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx` to verify existing interval cleanup, paging recovery, and explicit Retry.

In test doubles for these automatic callbacks, add `revalidate` with the same
existing refresh spy so their assertions still measure the refresh. For example,
a query double that has `refresh: h.refresh` gains `revalidate: h.refresh`; a
double using `vi.fn()` gets a named shared spy for both fields. Explicit Retry
buttons keep `refresh`. Do not replace user click handlers.

Task 15 Step 3 includes a focused query-action test: automatic revalidation calls the raw refresh, while explicit Retry goes through the latch-clearing helper. Existing automatic-consumer mocks gain that same `revalidate` callback and
`requiresRetry: false`.

Re-read `usePullRequestsQuery`, `openedView`, and its callers in the current tree immediately before their targeted changes; concurrent PR fixes own adjacent code. Their symbol names are the anchors here, not historical line numbers.

The existing PR query wrapper hides an unchanged cached failure while it waits
for revalidation. A latched failure intentionally keeps the same cause, so fix
that assumption in `usePullRequestsQuery.ts`: after the effect, before its
`if (opened.atom !== atom)` return, add:

```ts
  if (query.requiresRetry) return query;
```

In that hook's effect event, guard the automatic action too:

```ts
  const refresh = useEffectEvent(() => {
    if (!query.requiresRetry) query.revalidate();
  });
```

In `PullRequestsListView.test.tsx`, add `awaitingRetry: false` to the hoisted
harness, reset it in `beforeEach`, and return `requiresRetry: h.awaitingRetry`
from its query mock. Append this regression before implementing the guard:

```tsx
it("shows an exhausted cached failure on remount without issuing another request", async () => {
  h.first = null;
  h.awaitingRetry = true;
  h.error = new PullRequestsOperationError({
    operation: "list", code: "not_authenticated", message: "The connection dropped.",
    hostDetail: null, retryable: false,
  });
  await render();
  expect(container.textContent).toContain("The connection dropped.");
  await act(async () => root.render(null));
  await render();
  expect(container.textContent).toContain("The connection dropped.");
  expect(h.refresh).not.toHaveBeenCalled();
});
```

Run: `vp test run apps/web/src/components/pullRequests/list/PullRequestsListView.test.tsx`.
Expected: red before the guard (failure hidden or automatic refresh observed),
then PASS after the guard.

Automatic mount revalidation, cache invalidation, periodic ticks and generation
changes never call `retryEnvironmentQuery` and cannot clear the latch.

This file holds the update-badge agent's uncommitted `EnvironmentQueryRefreshInterval` work. Edit only these places.

Run:
- `vp test run packages/client-runtime/src/state/queryTransport.test.ts packages/client-runtime/src/state/runtime.test.ts packages/client-runtime/src/state/gitManager.test.ts`
- `vp test run apps/web/src/state/queries.test.tsx apps/web/src/components/gitManager apps/web/src/components/pullRequests apps/web/src/components/SourceControlCommits.test.tsx apps/web/src/components/CreateWorktreeDialog.test.tsx apps/web/src/components/DiffPanel.test.tsx apps/web/src/components/RemoteDirectoryBrowser.test.tsx apps/web/src/components/ChatView.test.tsx`
Expected: PASS; preserve the explicit Retry path while automatic callbacks leave the cutoff latch intact.

- [ ] **Step 3: Web copy for a cut-off (test first)**

Create `apps/web/src/state/query.test.ts`:

```ts
import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { RpcClientError } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { formatEnvironmentQueryError, QUERY_CONNECTION_DROPPED_MESSAGE, useEnvironmentQuery } from "./query";

const actions = vi.hoisted(() => ({
  refresh: vi.fn(),
  retry: vi.fn((_atom: object, refresh: () => void) => refresh()),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success("page"),
  useAtomRefresh: () => actions.refresh,
}));
vi.mock("react", () => ({ useCallback: (callback: () => void) => callback }));
vi.mock("@bibcode/client-runtime/state/runtime", () => ({
  retryEnvironmentQuery: actions.retry,
  isEnvironmentQueryAwaitingRetry: () => true,
}));

it("only explicit Retry clears the cutoff latch", () => {
  const atom = Atom.make(AsyncResult.success("page"));
  const result = useEnvironmentQuery(atom);
  expect(result.requiresRetry).toBe(true);
  result.revalidate();
  expect(actions.refresh).toHaveBeenCalledTimes(1);
  expect(actions.retry).not.toHaveBeenCalled();
  result.refresh();
  expect(actions.retry).toHaveBeenCalledExactlyOnceWith(atom, actions.refresh);
  expect(actions.refresh).toHaveBeenCalledTimes(2);
});

describe("formatEnvironmentQueryError", () => {
  it("names a transport cut-off instead of showing the raw socket error", () => {
    const cause = Cause.fail(
      new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 4408, closeReason: "liveness timeout" }),
      }),
    );
    expect(formatEnvironmentQueryError(cause)).toBe(QUERY_CONNECTION_DROPPED_MESSAGE);
    expect(QUERY_CONNECTION_DROPPED_MESSAGE).toBe(
      "The connection dropped before the result arrived.",
    );
  });

  it("keeps the message of any other error", () => {
    expect(formatEnvironmentQueryError(Cause.fail(new Error("Branch not found.")))).toBe(
      "Branch not found.",
    );
  });

  it("falls back when an error has no message", () => {
    expect(formatEnvironmentQueryError(Cause.fail("opaque"))).toBe(
      "The environment request failed.",
    );
  });
});
```

Run: `vp test run apps/web/src/state/query.test.ts`
Expected: FAIL (`QUERY_CONNECTION_DROPPED_MESSAGE` is not exported).

In `apps/web/src/state/query.ts`:
1. Add imports: `import * as Schema from "effect/Schema";` and `import { RpcClientError } from "effect/unstable/rpc";`.
2. Replace `formatEnvironmentQueryError` with:

```ts
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

/** Shown when the connection dropped mid-request; the view's Retry reloads it. */
export const QUERY_CONNECTION_DROPPED_MESSAGE = "The connection dropped before the result arrived.";

export function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (isRpcClientError(error)) return QUERY_CONNECTION_DROPPED_MESSAGE;
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}
```

   The History view then reads "Couldn’t load history: The connection dropped before the result arrived." next to its existing **Retry** button (`GitManagerHistoryView.tsx`, first-page failure card).

Run: `vp test run apps/web/src/state/query.test.ts apps/web/src/components/gitManager`
Expected: PASS.

- [ ] **Step 4: Gates and reviews**

Run: `vp test run apps/web/src/components/gitManager apps/web/src/components/status-bar apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/files/FileBrowserPanel.test.tsx apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx apps/web/src/components/BranchToolbarBranchSelector.test.tsx`, `vp check` and `vp run typecheck`.
Expected: pass, with automatic-consumer mocks exposing `revalidate` and explicit Retry still using its separate callback.

React review (`vercel-react-best-practices`): `query.ts` changes the formatter and `useEnvironmentQuery`; the Retry callback uses `useCallback` with both `selectedAtom` and `refreshAtom` dependencies. Verify automatic refreshes never call the explicit retry helper. Record the result.

UI.md review: the failure card names what failed ("Couldn’t load history"), why ("The connection dropped before the result arrived."), and the next step (the existing Retry button). It does not expose the raw `SocketCloseError` text. Record the result.

- [ ] **Step 5: Update the living doc**

In `docs/architecture/connection-runtime.md`, after the config paragraph from Task 13, add:

```markdown
Query atoms re-run when a new connection generation arrives. A request cut off
by a transport failure (`RpcClientError`) is re-issued once on the next
connection; after that automatic attempt fails, mount revalidation, periodic refresh,
cache invalidation and later connections keep showing
the failure ("The connection dropped before the result arrived.") until the
user presses Retry, so a payload the link cannot carry is not requested again on
every reconnect.
```

- [ ] **Step 6: Checkpoint (no commit)**

Record `Task 15 <tree> queryTransport + web query tests` in the ledger.

---

### Task 16: Disconnect and reconnecting copy

Controller ruling R10 excludes the clone-disconnect row: clone re-attach is the next approved item, and a disconnected client cannot confirm folder removal. Preserve today's honest clone message.

**Files:**
- Modify: `packages/client-runtime/src/connection/supervisor.ts` (`labelDisconnectFailure` details)
- Test: `packages/client-runtime/src/connection/registry.test.ts` (final rename/disconnect copy)
- Test: `packages/client-runtime/src/rpc/session.test.ts`
- Modify: `packages/client-runtime/src/connection/presentation.ts` (`connectionStatusText`)
- Test: `packages/client-runtime/src/connection/presentation.test.ts`
- Modify: `packages/client-runtime/src/errors/transport.ts` (patterns)
- Test: `packages/client-runtime/src/errors/transport.test.ts`
- Modify: `apps/web/src/components/gitManager/gitManagerAvailability.ts` (label, reconnecting copy)
- Modify: `apps/web/src/components/gitManager/GitManagerPanel.tsx` (pass the label)
- Test: `apps/web/src/components/gitManager/gitManagerAvailability.test.ts`, `apps/web/src/components/gitManager/GitManagerPanel.test.tsx` (mock)
- Docs: `docs/architecture/connection-runtime.md`

**Interfaces:**
- Consumes: `RpcDisconnect` classes and the supervisor's current-target formatting (Task 2), `useEnvironment(environmentId)` from `apps/web/src/state/environments.ts`. Every `<label>` below is the current saved catalog name; the session's own error stays label-neutral.
- Produces:
  - `resolveGitManagerAvailability(connectionState, serverConfig, environmentLabel: string)`.
  - Disconnect details:
    - liveness: "No data from <label> for 30 seconds. The connection is too slow or was lost."
    - closed: "<label> closed the connection."
    - lost: "The connection to <label> was lost."
  - `connectionStatusText` renders a reconnecting failure as "<detail> Reconnecting…".

- [ ] **Step 1: Failing client-runtime tests**

1. `packages/client-runtime/src/rpc/session.test.ts`:
   - Keep Task 2's label-neutral session expectations (`"The connection disconnected."`); the supervisor owns user-facing names.
   - In the Task 2 rename/disconnect table in `connection/registry.test.ts`, replace its rows with the following before changing the formatter:

```ts
    ["connection-closed", "GPU box closed the connection."],
    ["connection-lost", "The connection to GPU box was lost."],
    ["liveness-timeout", "No data from GPU box for 30 seconds. The connection is too slow or was lost."],
```

   - Append this session classification regression:

```ts
  it.effect("reports an abnormal closure as a lost connection", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const ready = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(ready);
      socket.close(1006, "");
      const error = yield* Effect.flip(session.closed);
      expect(error).toMatchObject({
        reason: "connection-lost",
        message: "The connection disconnected.",
      });
    }),
  );
```

2. `packages/client-runtime/src/connection/presentation.test.ts`:
   - In "combines reconnect progress with the latest failure", expect `"Relay request timed out. Reconnecting…"`.
   - In "formats every connection status with optional error details", expect `"Reconnecting…"` for the reconnecting phase without an error.
   - Add inside the same `describe`:

```ts
  it("ends a failure that lacks punctuation before announcing the reconnect", () => {
    expect(
      connectionStatusText({ phase: "reconnecting", error: "connect ECONNREFUSED", traceId: null }),
    ).toBe("connect ECONNREFUSED. Reconnecting…");
    expect(
      connectionStatusText({
        phase: "reconnecting",
        error: "No data from Local for 30 seconds. The connection is too slow or was lost.",
        traceId: null,
      }),
    ).toBe(
      "No data from Local for 30 seconds. The connection is too slow or was lost. Reconnecting…",
    );
  });
```

3. `packages/client-runtime/src/errors/transport.test.ts`, inside `describe("isTransportConnectionErrorMessage", …)`:

```ts
  it("recognizes the disconnect copy the RPC session reports", () => {
    expect(
      isTransportConnectionErrorMessage(
        "No data from Local for 30 seconds. The connection is too slow or was lost.",
      ),
    ).toBe(true);
    expect(isTransportConnectionErrorMessage("Local closed the connection.")).toBe(true);
    expect(isTransportConnectionErrorMessage("The connection to Local was lost.")).toBe(true);
  });
```

Run: `vp test run packages/client-runtime/src/rpc/session.test.ts packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/connection/presentation.test.ts packages/client-runtime/src/errors/transport.test.ts`
Expected: FAIL on the new supervisor rename/disconnect and presentation copy expectations. Repeat after Step 2: expected PASS, with the unchanged prepared name excluded from displayed failures.

- [ ] **Step 2: Implement the client-runtime copy**

1. In `supervisor.ts`, replace `labelDisconnectFailure` with this version. Its caller still reads the current target Ref at failure publication, including a rename during an established session:

```ts
function labelDisconnectFailure(
  target: ConnectionTarget,
  error: ConnectionAttemptError,
): ConnectionAttemptError {
  if (error._tag !== "ConnectionTransientError") return error;
  const label = target.label;
  switch (error.reason) {
    case "liveness-timeout":
      return new ConnectionTransientError({
        reason: error.reason,
        detail: `No data from ${label} for 30 seconds. The connection is too slow or was lost.`,
      });
    case "connection-closed":
      return new ConnectionTransientError({
        reason: error.reason,
        detail: `${label} closed the connection.`,
      });
    case "connection-lost":
      return new ConnectionTransientError({
        reason: error.reason,
        detail: `The connection to ${label} was lost.`,
      });
    default:
      return error;
  }
}
```

2. `presentation.ts`:
   - Add above `connectionStatusText`:

```ts
/** Ends `text` with sentence punctuation so a follow-on sentence reads cleanly. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
```

   - Replace the `case "reconnecting":` branch with:

```ts
    case "reconnecting":
      return connection.error ? `${asSentence(connection.error)} Reconnecting…` : "Reconnecting…";
```

3. `transport.ts`: add these entries to `TRANSPORT_ERROR_PATTERNS`, after `/\bdisconnected\.$/i,`:

```ts
  /^No data from .+ for 30 seconds\./i,
  /\bclosed the connection\.$/i,
  /^The connection to .+ was lost\.$/i,
```

Run the three test files again.
Expected: PASS.

- [ ] **Step 3: Failing web tests**

1. `apps/web/src/components/gitManager/gitManagerAvailability.test.ts`:
   - Add `"Local"` as the third argument to every `resolveGitManagerAvailability(…)` call.
   - In "names reconnecting and missing-capability states", change the backoff expectation's `reason` to `"Reconnecting to Local. History loads when the connection is back."`.
   - Add `ConnectionTransientError` to the `@bibcode/client-runtime/connection` import, then add:

```ts
  it("keeps the reconnecting copy while a reconnect attempt is connecting", () => {
    expect(
      resolveGitManagerAvailability(
        connection({
          desired: true,
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          network: "online",
          lastFailure: new ConnectionTransientError({
            reason: "liveness-timeout",
            detail: "No data from Local for 30 seconds. The connection is too slow or was lost.",
          }),
        }),
        serverConfig(true),
        "Local",
      ),
    ).toEqual({
      kind: "pending",
      reason: "Reconnecting to Local. History loads when the connection is back.",
    });
  });
```

2. In each `vi.mock("../../state/environments", …)` below, add the same export, preserving the existing connection-state stub:

   - `apps/web/src/components/gitManager/GitManagerPanel.test.tsx`;
   - `apps/web/src/components/gitManager/GitManagerPanel.lifecycle.test.tsx:47`;
   - `apps/web/src/components/gitManager/gitManagerTelemetry.test.tsx:70`.

   ```ts
   useEnvironment: () => ({ label: "Local" }),
   ```

   Include all three files in Task 16's test scope and focused Git Manager gate.

Run: `vp test run apps/web/src/components/gitManager`
Expected: FAIL (wrong arity and old copy).

- [ ] **Step 4: Implement the web copy**

1. `apps/web/src/components/gitManager/gitManagerAvailability.ts`:
   - Add:

```ts
function reconnectingReason(environmentLabel: string): string {
  return `Reconnecting to ${environmentLabel}. History loads when the connection is back.`;
}
```

   - Change `function disconnectedReason(connectionState: SupervisorConnectionState): string` to take `environmentLabel: string` as a second parameter, and make its `case "backoff":` return `reconnectingReason(environmentLabel);`.
   - Change `resolveGitManagerAvailability` to `(connectionState, serverConfig, environmentLabel: string)`. Replace its `if (connectionState.phase === "connecting") { … }` block with:

```ts
  if (connectionState.phase === "connecting") {
    if (connectionState.lastFailure !== null) {
      return { kind: "pending", reason: reconnectingReason(environmentLabel) };
    }
    return {
      kind: "pending",
      reason:
        connectionState.stage === "synchronizing"
          ? "This environment is synchronizing."
          : "This environment is connecting.",
    };
  }
```

   - Pass `environmentLabel` to `disconnectedReason(connectionState, environmentLabel)`.

2. `apps/web/src/components/gitManager/GitManagerPanel.tsx`:
   - Change the import to `import { useEnvironment, useEnvironmentConnectionState } from "../../state/environments";`.
   - In `GitManagerPanel`, after `const connection = useEnvironmentConnectionState(environmentId);` add `const environmentLabel = useEnvironment(environmentId)?.label ?? "this environment";`.
   - Replace the availability line with `const availability = resolveGitManagerAvailability(connection.data, serverConfig, environmentLabel);`.

Run: `vp test run apps/web/src/components/gitManager`
Expected: PASS.

- [ ] **Step 5: Gates and reviews**

Run: `vp check` and `vp run typecheck`
Expected: clean.

React review (`vercel-react-best-practices`, `rules/`):
- `GitManagerPanel` gains one `useEnvironment` read. It is memoized inside the hook, and the derived string is a primitive, so there is no new render cascade.
- No effects added.

Record the result.

UI.md review against "Errors" (`UI.md:178-184`):
- Each message says what failed (no data, closed, lost) and why.
- Each says what happens or what to do next (reconnecting automatically; History loads when back).
- None exposes raw socket codes.
- The Git Manager panel keeps its "Git Manager Unavailable" heading with the new reason.

Record the result.

- [ ] **Step 6: Update the living doc**

In `docs/architecture/connection-runtime.md`, append to the liveness paragraph from Task 2:

```markdown
The supervisor uses the current saved catalog name in "No data from <environment> for 30 seconds. The
connection is too slow or was lost.", "<environment> closed the connection.",
and "The connection to <environment> was lost."; renaming a connected environment
changes the name used by the next disconnect without replacing its session.
While the supervisor retries,
connection status appends "Reconnecting…", and Git Manager shows "Reconnecting to
<environment>. History loads when the connection is back."
```

Add `docs/testing/linux-desktop.md`, `macos-desktop.md`, and `windows-desktop.md` to this task's targeted doc scope. In each existing **Rename…** scenario, replace only the final sentence beginning "If the server closes the connection instead" (re-verified at Linux lines 355–357, macOS 259–261, Windows 472–474) with:

```markdown
Disconnect reasons also use the saved name: rename the connected server, then
close or interrupt its connection and confirm the reconnecting detail names
the new alias. Repeat with a liveness timeout. Storage-identity errors still
use the server's reported name.
```

Preserve the surrounding rename, no-reconnect, and persistence assertions. Task 17's execution-report evidence records the renamed label in the same disconnect screenshots; no source/UI file owned by track B changes for this verification.

- [ ] **Step 7: Checkpoint (no commit)**

Record `Task 16 <tree> client-runtime copy + web gitManager` in the ledger.

---

### Task 17: Throttling proxy script and the slow-link runbook

**Files:**
- Create: `scripts/throttle-proxy.ts`
- Test: `scripts/throttle-proxy.test.ts`
- Docs: `docs/reference/scripts.md`, `docs/testing/cross-platform-validation.md`, `docs/testing/execution-report-template.md`, `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md`

**Execution:** These loopback tests and the manual scenario run on the host by the controller; Codex writes the scripts and tests.

**Interfaces:**
- Consumes: nothing from earlier tasks. The runbook verifies Tasks 1–16 by hand.
- Produces:
  - `export interface LinkSettings { down: number; up: number; frozen: boolean }`
  - `export async function startThrottleProxy(options): Promise<ThrottleProxy>`
  - `export function startControlServer(proxy: ThrottleProxy, host: string, port: number): Promise<NodeHttp.Server>`
  - `export async function runThrottleProxyMain(isMain: boolean, argv?: ReadonlyArray<string>): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `scripts/throttle-proxy.test.ts`:

```ts
// @effect-diagnostics nodeBuiltinImport:off - The proxy test drives raw loopback sockets.
// @effect-diagnostics globalTimers:off - The freeze check waits a bounded real time.
import * as NodeNet from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startThrottleProxy, startControlServer, runThrottleProxyMain } from "./throttle-proxy.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function servePayload(payload: Buffer): Promise<number> {
  const server = NodeNet.createServer((socket) => socket.end(payload));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as NodeNet.AddressInfo).port;
}

function readAll(port: number, onData?: (total: number) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Array<Buffer> = [];
    let total = 0;
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.on("data", (data: Buffer) => {
      parts.push(data);
      total += data.length;
      onData?.(total);
    });
    socket.on("end", () => resolve(Buffer.concat(parts)));
    socket.on("error", reject);
  });
}

describe("startThrottleProxy", () => {
  it("paces server-to-client bytes at the configured rate", async () => {
    const payload = Buffer.alloc(64 * 1024, 120);
    const target = await servePayload(payload);
    const proxy = await startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: target,
      initial: { down: 128 * 1024 },
    });
    cleanups.push(proxy.close);
    const started = Date.now();
    const received = await readAll(proxy.port);
    const elapsed = Date.now() - started;
    expect(received).toEqual(payload);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(3000);
  });

  it("forwards nothing while frozen and everything once thawed", async () => {
    const payload = Buffer.alloc(16 * 1024, 121);
    const target = await servePayload(payload);
    const proxy = await startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: target,
      initial: { frozen: true },
    });
    cleanups.push(proxy.close);
    let receivedWhileFrozen = 0;
    const reading = readAll(proxy.port, (total) => {
      if (proxy.settings().frozen) receivedWhileFrozen = total;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receivedWhileFrozen).toBe(0);
    proxy.update({ frozen: false });
    expect(await reading).toEqual(payload);
  });

  it("changes rates, freezes and thaws through the HTTP control API", async () => {
    const payload = Buffer.alloc(8192, 122);
    const targetPort = await servePayload(payload);
    const proxy = await startThrottleProxy({
      listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort,
    });
    cleanups.push(proxy.close);
    const control = await startControlServer(proxy, "127.0.0.1", 0);
    cleanups.push(() => new Promise<void>((resolve) => {
      control.closeAllConnections();
      control.close(() => resolve());
    }));
    const port = (control.address() as NodeNet.AddressInfo).port;
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await get("/set?down=65536&up=32768")).toEqual({
      down: 65536, up: 32768, frozen: false,
    });
    expect(await get("/set?freeze=1")).toEqual({
      down: 65536, up: 32768, frozen: true,
    });
    let bytes = 0;
    const reading = readAll(proxy.port, (total) => { bytes = total; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bytes).toBe(0);
    expect(await get("/set?freeze=0")).toEqual({
      down: 65536, up: 32768, frozen: false,
    });
    expect(await reading).toEqual(payload);
    expect(await get("/set?down=0")).toEqual({ down: 0, up: 32768, frozen: false });
    expect(await get("/state")).toEqual({ down: 0, up: 32768, frozen: false });
  });

  it("uses CLI listen/target/control and rate arguments", async () => {
    const payload = Buffer.from("CLI target reached");
    const target = await servePayload(payload);
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./throttle-proxy.ts", import.meta.url)),
      "--listen", "127.0.0.1:0", "--target", `127.0.0.1:${target}`,
      "--control", "127.0.0.1:0", "--down", "65536", "--up", "32768",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    await vi.waitFor(() => expect(output).toMatch(/control http:\/\/127\.0\.0\.1:\d+/));
    const ports = output.match(/throttle proxy 127\.0\.0\.1:(\d+).*control http:\/\/127\.0\.0\.1:(\d+)/);
    expect(ports).not.toBeNull();
    const listenPort = Number(ports![1]);
    const controlPort = Number(ports![2]);
    expect(controlPort).toBeGreaterThan(0);
    expect(await (await fetch(`http://127.0.0.1:${controlPort}/state`)).json())
      .toEqual({ down: 65536, up: 32768, frozen: false });
    expect(await readAll(listenPort)).toEqual(payload);
  });

  it("does not start a CLI server when imported", async () => {
    expect(await runThrottleProxyMain(false, [])).toBe(false);
  });

});
```

Run: `vp test run scripts/throttle-proxy.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 2: Implement the proxy**

Create `scripts/throttle-proxy.ts`:

```ts
// @effect-diagnostics nodeBuiltinImport:off - A development TCP proxy works on raw sockets.
// @effect-diagnostics globalTimers:off - Pacing owns short, bounded timers.
/**
 * Throttling TCP proxy for the slow-link liveness runbook
 * (docs/testing/cross-platform-validation.md, "Slow-link liveness scenario").
 * It is a development tool and never runs in production.
 *
 * Each direction is paced at its own rate. The proxy stops reading a source
 * while that direction holds 64 KiB, so a slow link makes the sender's socket
 * writes block (backpressure). `frozen` stops both directions without closing
 * either socket.
 *
 *   node scripts/throttle-proxy.ts --listen 127.0.0.1:13854 --target 127.0.0.1:13853 \
 *     --control 127.0.0.1:13855 [--down <bytes/s>] [--up <bytes/s>]
 *
 * Control API: GET /set?down=<B/s>&up=<B/s>&freeze=0|1 (0 B/s is unlimited); GET /state.
 */
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

export interface LinkSettings {
  /** Server-to-client bytes per second; 0 is unlimited. */
  readonly down: number;
  /** Client-to-server bytes per second; 0 is unlimited. */
  readonly up: number;
  /** Stops forwarding in both directions while true. */
  readonly frozen: boolean;
}

export const UNTHROTTLED: LinkSettings = { down: 0, up: 0, frozen: false };

const QUEUE_HIGH_WATER_BYTES = 64 * 1024;
const PIECE_BYTES = 4 * 1024;
const FROZEN_POLL_MS = 20;

export interface ThrottleProxy {
  readonly port: number;
  readonly settings: () => LinkSettings;
  readonly update: (next: Partial<LinkSettings>) => LinkSettings;
  readonly close: () => Promise<void>;
}

/** Forwards `source` to `destination` at `rate()` bytes per second; returns a stop function. */
function pace(
  source: NodeNet.Socket,
  destination: NodeNet.Socket,
  rate: () => number,
  frozen: () => boolean,
): () => void {
  const queue: Array<Buffer> = [];
  let queued = 0;
  let nextSendAt = 0;
  let ended = false;
  let waitingForDrain = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number): void => {
    if (timer === null && !waitingForDrain) timer = setTimeout(pump, Math.max(0, delayMs));
  };

  function pump(): void {
    timer = null;
    if (frozen()) {
      schedule(FROZEN_POLL_MS);
      return;
    }
    const piece = queue.shift();
    if (piece === undefined) {
      if (ended) destination.end();
      return;
    }
    queued -= piece.length;
    if (queued < QUEUE_HIGH_WATER_BYTES && source.isPaused()) source.resume();
    const bytesPerSecond = rate();
    const now = Date.now();
    nextSendAt =
      bytesPerSecond > 0
        ? Math.max(now, nextSendAt) + (piece.length / bytesPerSecond) * 1000
        : now;
    if (!destination.write(piece)) {
      waitingForDrain = true;
      destination.once("drain", () => {
        waitingForDrain = false;
        schedule(nextSendAt - Date.now());
      });
      return;
    }
    schedule(nextSendAt - Date.now());
  }

  source.on("data", (data: Buffer) => {
    for (let offset = 0; offset < data.length; offset += PIECE_BYTES) {
      const piece = data.subarray(offset, offset + PIECE_BYTES);
      queue.push(piece);
      queued += piece.length;
    }
    if (queued >= QUEUE_HIGH_WATER_BYTES) source.pause();
    schedule(nextSendAt - Date.now());
  });
  source.on("end", () => {
    ended = true;
    schedule(0);
  });
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}

export async function startThrottleProxy(options: {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly initial?: Partial<LinkSettings>;
}): Promise<ThrottleProxy> {
  let settings: LinkSettings = { ...UNTHROTTLED, ...options.initial };
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((client) => {
    const upstream = NodeNet.connect(options.targetPort, options.targetHost);
    sockets.add(client);
    sockets.add(upstream);
    const stopDown = pace(upstream, client, () => settings.down, () => settings.frozen);
    const stopUp = pace(client, upstream, () => settings.up, () => settings.frozen);
    const destroyBoth = (): void => {
      stopDown();
      stopUp();
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", destroyBoth);
    upstream.on("error", destroyBoth);
    client.on("close", destroyBoth);
    // When the server closes, the paced queue still drains to the client before it ends.
    upstream.on("close", () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve) =>
    server.listen(options.listenPort, options.listenHost, resolve),
  );
  const address = server.address() as NodeNet.AddressInfo;
  return {
    port: address.port,
    settings: () => settings,
    update: (next) => {
      settings = { ...settings, ...next };
      return settings;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export function startControlServer(
  proxy: ThrottleProxy,
  host: string,
  port: number,
): Promise<NodeHttp.Server> {
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://control.invalid");
    if (url.pathname === "/set") {
      const down = url.searchParams.get("down");
      const up = url.searchParams.get("up");
      const freeze = url.searchParams.get("freeze");
      proxy.update({
        ...(down === null ? {} : { down: Number(down) }),
        ...(up === null ? {} : { up: Number(up) }),
        ...(freeze === null ? {} : { frozen: freeze === "1" }),
      });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(proxy.settings()));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

function parseAddress(value: string | undefined, fallback: string): {
  readonly host: string;
  readonly port: number;
} {
  const [host = "127.0.0.1", port = "0"] = (value ?? fallback).split(":");
  return { host, port: Number(port) };
}

export async function runThrottleProxyMain(
  isMain: boolean,
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<boolean> {
  if (!isMain) return false;
  const args = new Map<string, string>();
  for (let index = 0; index + 1 < argv.length; index += 2) {
    args.set(argv[index]!, argv[index + 1]!);
  }
  const listen = parseAddress(args.get("--listen"), "127.0.0.1:13854");
  const target = parseAddress(args.get("--target"), "127.0.0.1:13853");
  const control = parseAddress(args.get("--control"), "127.0.0.1:13855");
  const proxy = await startThrottleProxy({
    listenHost: listen.host,
    listenPort: listen.port,
    targetHost: target.host,
    targetPort: target.port,
    initial: { down: Number(args.get("--down") ?? 0), up: Number(args.get("--up") ?? 0) },
  });
  const controlServer = await startControlServer(proxy, control.host, control.port);
  const controlPort = (controlServer.address() as NodeNet.AddressInfo).port;
  console.log(
    `throttle proxy ${listen.host}:${proxy.port} -> ${target.host}:${target.port}; control http://${control.host}:${controlPort}`,
  );
  return true;
}

void runThrottleProxyMain(import.meta.main);
```

Run: `vp test run scripts/throttle-proxy.test.ts`
Expected: PASS (`Tests  5 passed (5)`).

- [ ] **Step 3: Scripts reference**

In `docs/reference/scripts.md`, section "Repository Maintenance", add after the `vp run measure:desktop-runtime -- ...` bullet:

```markdown
- `node scripts/throttle-proxy.ts --listen <host:port> --target <host:port> --control <host:port> [--down <bytes/s>] [--up <bytes/s>]`:
  development-only throttling TCP proxy for the
  [slow-link liveness scenario](../testing/cross-platform-validation.md#slow-link-liveness-scenario).
  Each direction is paced separately with backpressure; `GET /set?down=&up=&freeze=0|1`
  on the control address changes the link (0 bytes/s is unlimited) and `GET /state`
  reports it.
```

- [ ] **Step 4: Cross-platform runbook scenario**

In `docs/testing/cross-platform-validation.md`, insert this section directly before `## Git Manager validation scenario`, after the paragraph that ends "record SSH coverage separately if tested.":

````markdown
## Slow-link liveness scenario

Run this against an isolated development server (its own `BIBCODE_HOME`) or a
standalone server reached from a browser, never against user data. Create a
disposable repository whose newest commit adds a text file of about 4 MB, below
the 4.375 MB patch bound, so Git Manager returns the whole patch:

```sh
node -e "require('fs').writeFileSync('big.txt', ('0123456789abcdef'.repeat(4)+'\n').repeat(61500))"
git add big.txt && git commit -q -m "big diff"
```

Put `scripts/throttle-proxy.ts` between the browser and the server:

1. Start the web client and note `webPort` from its `[dev-runner] mode=dev:web …`
   line: `BIBCODE_PORT_OFFSET=81 vp run dev:web`. It targets server port
   13854 (13773 + 81), where the proxy will listen.
2. Start the server on another offset and allow the web origin:
   `BIBCODE_PORT_OFFSET=80 BIBCODE_HOME=<disposable> vp run dev:server -- --dev-url http://localhost:<webPort>`.
3. Start the proxy:
   `node scripts/throttle-proxy.ts --listen 127.0.0.1:13854 --target 127.0.0.1:13853 --control 127.0.0.1:13855`.
4. Pair through the server's startup token (`/pair#token=…` on the web port) and
   add the repository.

With the browser's network panel on the RPC WebSocket:

1. `curl "http://127.0.0.1:13855/set?down=65536&up=65536"`, then open the big
   commit's diff in Git Manager History. The transfer takes about a minute and
   must finish without a disconnect. The socket must show
   `Sec-WebSocket-Protocol: bibcode.rpc.chunked.v1`, and the large response must
   arrive as binary frames.
2. Repeat at `down=262144&up=262144`.
3. With the page idle, `curl "http://127.0.0.1:13855/set?freeze=1"`. Within 33
   seconds the socket closes with code 4408, and Git Manager shows "Reconnecting
   to <environment>. History loads when the connection is back." A remote
   environment's context card shows "No data from <environment> for 30 seconds.
   The connection is too slow or was lost. Reconnecting…". Record that text
   within 15 seconds of the close. After that, a reconnect attempt through the
   frozen link can time out and show its own failure instead. Thaw with
   `freeze=0` and confirm the connection returns.
4. Freeze an idle connection and record the freeze-start timestamp. While it
   remains frozen, verify the server ends that session within 50 seconds of
   freeze start ("RPC peer silent for 45 s; ending the session"). Record the
   timestamp and duration before thawing. A later end is a failed check;
   accepted writes never move this measurement's origin.
5. Thaw after the idle assertion. Start another large transfer, freeze it after the first record, and keep it
   frozen. Verify server-side teardown within 33 seconds of freeze start,
   before thawing. Record subscription cleanup and the writer-failure log.
   A post-thaw close is not evidence of teardown within the bound.

Record the rates, transfer durations, close codes, the exact status text, and
the server log lines.
````

- [ ] **Step 5: Report template and platform runbooks**

1. `docs/testing/execution-report-template.md`:
   - In the Git Manager scenario table, insert this row directly after the `| Disconnect/reconnect and one missing-capability degradation … |` row. It keeps the 73-character first column so the table stays aligned:

```markdown
| Slow-link liveness: no disconnect; 4408 within 33 s when frozen           |        |                                      |                                   |
```

   - Insert directly after the `## Clone from URL network scenario` bullet list (before `## Process and temporary-root cleanup`):

```markdown
## Slow-link liveness scenario

- Server, web, and proxy ports; fixture diff size:
- 64 KiB/s: transfer duration, negotiated subprotocol, binary frames seen, disconnects (none expected):
- 256 KiB/s: transfer duration, disconnects (none expected):
- Frozen link: seconds until the 4408 close, exact status text, reconnect after thawing:
- Idle freeze: freeze-start and server teardown timestamps; elapsed seconds (at most 50), observed before thaw:
- Transfer freeze: freeze-start and server teardown timestamps; elapsed seconds (at most 33), observed before thaw; subscription cleanup evidence:
```

2. In each of `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md` and `docs/testing/windows-desktop.md`, insert after the paragraph that ends "shared procedure owns authenticated list/detail/files evidence.":

```markdown
Include the shared [slow-link liveness scenario](./cross-platform-validation.md#slow-link-liveness-scenario)
when a browser client and a development or standalone server are available on
this platform; otherwise record it as unavailable evidence.
```

- [ ] **Step 6: Gates**

Run:
- `vp check`
- `vp run typecheck`
- `vp test run scripts/throttle-proxy.test.ts scripts/remote-architecture-contract.test.ts scripts/transport-caps-contract.test.ts`

Expected: clean and passing. If `vp check` reports formatting only in a line this task added, reformat that line by hand; never run a formatter over a whole shared runbook.

- [ ] **Step 7: Checkpoint (no commit)**

Record `Task 17 <tree> throttle-proxy + docs` in the ledger.

---

## Finish

### F1: Full gates

Run each command from the repository root and record the command, exit code, duration and summary in the ledger:

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo check -p bibcode-desktop
vp test run packages/client-runtime packages/contracts apps/web scripts
cargo test -p bibcode-server
# Run the exact temporary-index check:contracts block in Task 11 Step 7.
git diff --check
```

What to expect:
- `cargo check -p bibcode-desktop` confirms that the desktop host, which embeds the server, still builds.
- Classify any failure outside this plan's files per the flake rules in Global Constraints.
- Run `vp run check:contracts` with the reviewed temporary fixture index from Task 11 Step 7. It must exit **0**, and report that exact exit code and index method. Check the new fixture with `git status --short -- packages/contracts/fixtures` as well as the tracked diff.
- `cargo test -p bibcode-server` includes `rpc_liveness`, about 2.5 minutes of wall time.

### F2: Final live checks (Playwright, isolated dev server)

These cover every user-visible change. Reuse `$LIVE` from Tasks 3 and 9, with fresh log files. **The controller runs these live checks on the host; the Codex sandbox blocks loopback sockets. The implementer only writes scripts.** Use the complete record-aware observer and driver in Task 3 (`$S/liveness-live/`); never reuse the old raw-frame completion oracle.

**Use the repository proxy, not the spike proxy, for every RPC link in F2.** F2 runs after Task 17, so put `scripts/throttle-proxy.ts` on the ports the spike proxies used:

```bash
cd /work/workspaces/orca/BibCode/main-3
node scripts/throttle-proxy.ts --listen 127.0.0.1:13981 --target 127.0.0.1:13844 --control 127.0.0.1:13982 \
  > $LIVE/logs/proxy-f2.out 2>&1 &
echo $! > $LIVE/logs/proxy-f2.pid
```

For step 5, start a second one the same way with `--listen 127.0.0.1:13991 --target 127.0.0.1:13990 --control 127.0.0.1:13992` (pid file `proxy-f2-e2ee.pid`).

- Freeze a link with `/set?freeze=1` and thaw it with `/set?freeze=0`; a thaw keeps the rates that were set.
- Never use `down=1&up=1` as a freeze once Phase C has landed. The server's heartbeat is a 2-byte WebSocket Ping, and the browser answers it with a 6-byte Pong. Both cross a 1 B/s link within seconds, so the server never sees 45 s of silence, and the reaper and its log line are never exercised. The client still closes with 4408, because JavaScript never sees Ping or Pong frames. But its close frame then trickles to the server for about 24 s, so the server-side timings stop meaning anything. A true freeze passes nothing in either direction, so the steps below get deterministic timings.
- The new scratch driver works against this proxy:
  - `/set` ignores `latency` and `mode`;
  - every other path, `/mark` included, just answers with the current settings.

  This proxy writes no frame log, so read timings from the wslog.

1. **Fixtures.** Add a big-diff repository and add it to the environment:

   ```bash
   mkdir -p $LIVE/fixtures/bigdiff && cd $LIVE/fixtures/bigdiff && git init -q -b main \
     && git -c user.name=Live -c user.email=live@example.invalid commit -q --allow-empty -m base \
     && node -e "require('fs').writeFileSync('big.txt', ('0123456789abcdef'.repeat(4)+'\n').repeat(61500))" \
     && git add big.txt && git -c user.name=Live -c user.email=live@example.invalid commit -q -m "big diff"
   ```

   Add it through `setup-projects.mjs` with `NAMES=bigdiff`.

2. **Plain records.** Start the dev server (Task 3 Step 2) and the repository proxy on 13981 (above). Use `$LIVE/measure.mjs` with `fixture: "bigdiff"` at each rate; it obtains the expected diff unthrottled, then asserts a successful Exit for the exact request id with identical length and content after record reassembly. Use the same observer while exercising the visible UI:
   - set the proxy to `down=65536&up=65536`;
   - open Git Manager for `bigdiff`;
   - click the commit `big diff` (`page.getByText("big diff").first()`);
   - click `big.txt` in its detail (`page.getByText("big.txt").first()`);
   - wait for the reassembled `gitManager.getDiff` **Success** Exit in the wslog; verify the driver’s exact-content result, not merely the presence of an Exit.

   Expected: no `close` event on the RPC socket, binary receive events during the transfer, and the patch renders. Repeat at 262144. Screenshot both.

3. **History pages.** At 65536, open Git Manager for `hist-8m`. The first page (about 1 MiB) renders in roughly 16 s without a disconnect, and scrolling loads the next page.

4. **Frozen local link.** The controller first runs both bounded freeze checks on the host:

   ```bash
   D=$LIVE WEB=5804 SERVER_PORT=13844 PROXY_PORT=13981 CONTROL=127.0.0.1:13982 SERVER_LOG=$LIVE/logs/dev.log KIND=idle node $LIVE/freeze.mjs
   D=$LIVE WEB=5804 SERVER_PORT=13844 PROXY_PORT=13981 CONTROL=127.0.0.1:13982 SERVER_LOG=$LIVE/logs/dev.log KIND=transfer node $LIVE/freeze.mjs
   ```

   Expected: exit 0; client detection ≤33 s, idle server teardown ≤50 s, transfer teardown ≤33 s, with every assertion before thaw. Use the current dev-log filename if Step 2 used a fresh log. Then exercise the visible UI: with Git Manager open, `curl "http://127.0.0.1:13982/set?down=0&up=0&freeze=1"`.
   Expected: within 33 s the wslog shows `close-call` with code 4408, and the panel reads "Git Manager Unavailable" / "Reconnecting to Local. History loads when the connection is back.". Thaw with `curl "http://127.0.0.1:13982/set?freeze=0"`; History loads again. Screenshot the reconnecting state.

5. **E2EE.** Set up the remote server as in Task 9 Step 3, but start the second repository proxy (above) in place of that step's `throttle_proxy.py` line. Copy `bigdiff` to `e2ee-bigdiff` and pair it.
   - Run `$LIVE/measure.mjs` with `REMOTE_LABEL=spike-remote`, `CONTROL=127.0.0.1:13992`, and `fixture: "e2ee-bigdiff"` at 65536 and 262144. Each decrypted, reassembled Success Exit must match its baseline length/content exactly. Then open the diff through the UI and capture the rendered patch.
   - Freeze proxy 2 (`curl "http://127.0.0.1:13992/set?freeze=1"`). The remote environment's context card must show "No data from <remote label> for 30 seconds. The connection is too slow or was lost. Reconnecting…" (screenshot). Take the screenshot within 15 s of the 4408 close. After that, the next reconnect attempt through the frozen link can hit its 15 s open timeout and replace the text with its own failure.
   - Thaw proxy 2 (`/set?freeze=0`) and confirm the environment reconnects.

6. **Re-request, then Retry.**
   - Set `down=16384&up=16384` and open `hist-8m` History. The first page takes about 64 s.
   - After 5 s, freeze (`/set?freeze=1`) for 35 s, then thaw (`/set?freeze=0`). The rate stays at 16384. The client reconnects and re-issues the page once.
   - Freeze again for 35 s and thaw the same way.
   - The History panel must show "Couldn’t load history: The connection dropped before the result arrived." with **Retry**, and the wslog must show no third `gitManager.getCommits` request after the second reconnect.
   - Set `down=0&up=0` and press Retry. History loads. Screenshot the failure card.

7. **Oversized response.** A real response over 64 MiB is not practical to produce live. The session tests (Rust and client) cover it. Record "oversize copy: covered by tests, not reproduced live".

8. Stop every process you started, and nothing else. Kill the PIDs in `proxy-f2.pid`, `proxy-f2-e2ee.pid` and `remote.pid` under `$LIVE/logs`, then the dev runner group (`kill -- -$(cat $LIVE/logs/dev.pid)`). Record results and screenshot paths in the ledger.

### F3: Claude two-axis review

Invoke the `code-review` skill.
- Base: the checkpoint tree recorded before Task 1. Scope: the files this plan created or modified (list them from the task headers).
- **Standards axis:** `AGENTS.md`, `UI.md`, the vercel React rules, and the repository conventions.
- **Spec axis:** `docs/superpowers/specs/2026-09-24-connection-liveness-design.md`, with each plan-authored deviation marked **pending user approval** unless the controller's ledger records the user's approval. Cite the ledger entry for any approved deviation; plan authorship and controller repair rulings are not approval.

Fix accepted findings, re-run the affected focused tests and gates, and checkpoint again.

### F4: Codex review

Run the review in the background, then collect it:

```bash
node /home/mauro/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs review --scope working-tree
node /home/mauro/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs status
node /home/mauro/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs result
```

- Run the first command with `run_in_background: true`. Poll `status` until the job completes, then read `result`.
- The working tree also holds other agents' changes, so judge only findings in this plan's files.
- Process the findings with `superpowers:receiving-code-review`: verify each against the code before changing anything, and push back on findings that are wrong.
- If the companion cannot run (for example, out of credits), record "Codex review: not run (<reason>)" and continue.

### F5: Hand back

Report to the controller:
- the ledger path and final tree hash;
- the gate results;
- the live-check evidence;
- both reviews' outcomes;
- every plan-authored spec deviation, including rulings 1 and 3, marked **pending user approval** unless the controller's ledger records the user's approval (cite it);
- `orchestration.replayEvents` byte capping as an out-of-scope follow-up;
- the residual risks.

Output this upstream issue draft to the controller for the user to file; do not call GitHub or create an issue. Report its status as **drafted, not filed**:

```markdown
Title: Make RPC socket liveness policy configurable for inbound activity

Effect version: 4.0.0-beta.107

BiBCode's RPC client can receive binary records for a large response continuously
while Effect's default RPC pinger waits only for a Pong. At 64–256 KiB/s,
a queued Pong can be delayed behind a healthy multi-record response, causing
a disconnect and cancellation of the request.

Reproduction: pace a large RPC response through a TCP proxy and delay the Pong
behind it. Observe received records while the default five-second pinger fails
the connection. BiBCode's regression matrix covers plain legacy frames, plain
records, and encrypted records at 64/256 KiB/s for 1/8 MiB responses.

Could makeProtocolSocket accept a public liveness policy or activity/probe hook,
so a caller can count raw transport activity before its own record reassembly,
retain protocol Ping compatibility, disable internal retries, and choose a
timeout close code? BiBCode currently carries a local protocol copy and a raw
WebSocket message hook (10 s probe, 30 s ±10 % silence deadline, 4408 close).
A supported hook would let us retire that copy. No credentials or user data are
needed to reproduce this behavior.
```

Residual risks:
- kernel send queues can still delay control messages, since `TCP_NOTSENT_LOWAT` is not set;
- links under about 2 KiB/s can still be declared dead;
- old clients keep the 5–10 s pinger until they update;
- WebKitGTK and shared-bottleneck behavior were not measured.

The controller asks the user about committing. Do not commit.

---

## Self-review

**Spec coverage** (spec section → task):

| Spec item | Task |
| --- | --- |
| 1. Client liveness counts every inbound message; 10 s Ping; 30 s ±10 %; 4408 `liveness timeout`; local protocol copy; raw hook before E2EE reassembly | 1, 2, 3 |
| 2. Split plain `/ws` over 64 KiB into records; subprotocol `bibcode.rpc.chunked.v1`; 64 MiB / 2,048 records; requests not split | 5, 6, 7 |
| 3. Control lane (Pong, interrupt exits, admission terminals, protocol errors); drained before messages and between records; `0x02`; Pong `try_send`, dropped when full; `interleave-v1` in `e2ee_auth`/`e2ee_authenticated`; terminal output excluded | 5, 6, 7 |
| 4. 20 s progress per record, 30 s + size ÷ 16 KiB/s per message; writer failure ends the session (early fix first) | 4, 5 (whole-frame deviation: ruling 1, approved by the user on 2026-09-25) |
| 5. Heartbeat every 15 s after auth, reap after 45 s silence, late ticks not charged, E2EE writer sends Pings itself | 10 |
| 6. Oversized response fails one request; typed `RpcResponseTooLargeError { method, bytes, limitBytes }`; split plain sessions limited; test renamed; `remote.md:309-311` | 11 |
| 7. ±15 % jitter; idle ladder 60/120/300 s after 5 min for unselected environments; signals still wake; blocked unchanged | 12 |
| 8. Config once (snapshot readiness, small probe); History 1 MiB pages; `review.getDiffPreview` bound; re-issue once then Retry | 13, 14, 15 |
| 9. 4408 logging on both sides; copy table (liveness, server closed, Git Manager reconnecting, oversize); clone excluded by R10 | 2, 10, 11, 16 |
| Validation: client vitest with `TestClock`; server Rust tests; `rpc_liveness.rs` harness; browser runbook with a Node proxy under `scripts/`; gates | 1–2, 4–16, 8 + 10, 17, Finish |
| Docs: `connection-runtime.md`, `rpc-and-orchestration.md`, `remote.md`, `overview.md`, `cross-platform-validation.md` + platform runbooks + report template, `scripts.md` | 2, 5, 6, 10–17 |

**Intermediate-boundary audit.** Task 5 removes the obsolete E2EE write-floor constant, retains the handshake timeout, and introduces no feature constant until Task 6. Task 8 uses every helper and reads every duration field. Task 10 introduces the test-only auth observer together with its caller. Task 11 lists the propagated error unions and the exact exhaustive-switch change. Every task with Rust edits runs Clippy with warnings denied; no unused-item allowance masks an intermediate failure.

**Controller repair coverage.** R1–R15 and V1–V11 are recorded above. The executable expectations below distinguish successful payloads from failure Exits, control traffic from data progress, and teardown observed during a freeze from delivery after thaw. Browser checks belong to the host controller. Pending deviations require the ledger's user approval; this plan does not grant it.

**Type consistency.**
- `run_writer` gains `liveness` in Task 10. `run_session_split_budgeted` gains `framing` (Task 5) and then `liveness` (Task 10). Each task updates every call site it names.
- `SendFailure`, `message_limit`, `max_message_bytes` and `MAX_RECORDED_MESSAGE_BYTES` appear first in Task 11.
- `ConnectionLiveness`, `run_heartbeat` and `log_peer_close` appear first in Task 10.
- `InboundActivity.awaitAfter` appears first in Task 13.
- `EnvironmentSelection` and `isEnvironmentShown` appear first in Task 12.
- `CHUNKED_RPC_SUBPROTOCOL` exists in Rust (`transport.rs`) and TypeScript (`chunkedSocket.ts`) with the same value.
- The E2EE feature string `interleave-v1` matches in `transport.rs`, `socket.ts`, and the contracts test.
