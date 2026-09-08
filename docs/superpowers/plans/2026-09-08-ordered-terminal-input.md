# Ordered Terminal Input Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded independent tasks; the coordinator owns server/client integration and final validation. Do not commit or stage changes in this shared checkout. Preserve the existing staged dependency plans and `outputs/` directory.

**Goal:** Remove per-write round-trip queuing from remote terminal typing while preserving input order, failure fencing, and the already implemented selected-server usage fix.

**Architecture:** A server-issued input lease binds sequenced writes to a physical RPC connection and terminal process generation. The client pipelines bounded writes over existing typed RPC, and the server serializes PTY delivery and rejects dependent input after failure. Capability negotiation preserves the legacy serialized path for older servers.

**Tech Stack:** Rust, Tokio/Axum, Effect Schema/RPC, React, Vite+.

**Spec:** `docs/plans/2026-09-08-remote-typing-and-provider-usage.md`, approved by the user's "do them" response on 2026-09-08.

## Global Constraints

- Keep contracts schema-only and application traffic on typed RPC.
- Capability `terminalOrderedInput` defaults to false when omitted.
- At most 16 outstanding input frames and 256 KiB of payload per connection; each ordered frame is at most 16 KiB UTF-8.
- Queued client input is capped at 1 MiB. Overflow ends the current batch visibly.
- Never raise the server's 64-request limit. Input must retain RPC capacity for control traffic.
- Missing-sequence deadline: five seconds. Duplicates must never write twice.
- Failure, disconnect, workspace loss, close, and process replacement invalidate input; no uncertain data is replayed.
- No local echo, new sidecar, production Node dependency, or persisted input queue.
- Existing usage fix and unrelated user changes are preserved. No installation or restart of the user's live app/server is part of validation.

## Task 1: Wire contracts and capability

**Files:** `packages/contracts/src/terminal.ts`, `rpc.ts`, `environment.ts`, corresponding tests and fixture exporter; Rust method/scope inventory and environment-descriptor publication sites.

**Interfaces:**

```ts
type TerminalBeginInput = { threadId: string; terminalId: string };
type TerminalInputLease = { inputId: string };
type TerminalWriteInputFrame = {
  threadId: string;
  terminalId: string;
  inputId: string;
  sequence: number; // nonnegative safe integer, starts at zero
  data: string; // nonempty; schema max length 16 Ki code units, UTF-8 byte cap enforced by owners
};
type TerminalInputAcknowledgement = { inputId: string; sequence: number };
type TerminalCancelInput = { threadId: string; terminalId: string; inputId: string };
// WS_METHODS.terminalBeginInput = "terminal.beginInput"
// WS_METHODS.terminalWriteInput = "terminal.writeInput"
// WS_METHODS.terminalCancelInput = "terminal.cancelInput"
```

- [ ] Add tests for absent capability, lease/frame/ack decoding, invalid sequence/data, method parity, and existing terminal errors. Example behavioral assertion:

```ts
expect(Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities)({}).terminalOrderedInput).toBe(false);
expect(() => Schema.decodeUnknownSync(TerminalWriteInputFrame)({
  threadId: "thread", terminalId: "term-1", inputId: "lease", sequence: -1, data: "x",
})).toThrow();
```

- [ ] Register schema-backed unary methods with the same terminal/workspace/environment error unions as `terminal.write`; begin returns lease, write returns acknowledgement, cancel returns null.
- [ ] Register Rust method inventory and `terminal:operate` authorization; advertise true at current server descriptor sites and update explicit typed fixtures.
- [ ] Run `vp test run packages/contracts/src/terminal.test.ts packages/contracts/src/environment.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts`; regenerate RPC fixtures using the existing exporter.

## Task 2: Server input ownership and delivery

**Files:** new `apps/server/src/terminal/input.rs`; existing `terminal/manager.rs`, `terminal/mod.rs`, `rpc/session.rs`, `production/server_terminal.rs`; focused Rust tests.

**Interfaces:** `RpcSessionContext` supplies a unique physical connection identity and its disconnect cancellation token. `TerminalManager` exposes begin/write/cancel input methods taking that connection identity plus terminal IDs. An input lease captures the existing `TerminalSessionIdentity` and generation cancellation token. These methods remain internal to the Rust owner and RPC adapter.

- [ ] Test out-of-order arrival, failed prefix, duplicate sequence, gap timeout, per-connection budget, another connection's lease, restart and cancellation with an instrumented PTY backend.
- [ ] Maintain one bounded connection/terminal lease registry with no polling. Guard admission before waiting; use sequence state plus notification to serialize frame delivery. A registered frame's lifetime retains its count/byte permit until settlement. Cancellation wakes waiters, and dropping admitted work must seal its lease.
- [ ] Deliver under the existing terminal generation publication guard. Check the captured process identity; do not resolve a replacement process at write time. Workspace admission remains on each write and failure seals that input lease.
- [ ] Bind physical connection cancellation at the RPC session loop, including E2EE sessions; do not use the persisted authentication-session ID as a physical socket identity.
- [ ] Add begin/write/cancel RPC handlers. Preserve the original terminal write route for older clients.
- [ ] Run `cargo test -p bibcode-server --lib terminal::`, `cargo test -p bibcode-server --test production_server_terminal_rpc`, and the affected RPC session/transport tests.

## Task 3: Bounded client input and negotiated session writes

**Files:** `packages/client-runtime/src/state/terminalInput.ts` and tests; new ordered writer module under `state/`; `rpc/session.ts`, `rpc/client.ts`, `state/terminal.ts` and focused tests as needed.

**Interfaces:** Extend the existing scheduler with a configurable in-flight window and UTF-8 frame/pending bounds, keeping defaults serialized for legacy callers. The runtime's terminal write command negotiates a lease through the actual `RpcSession`, uses monotonically sequenced `terminal.writeInput`, and validates the matching acknowledgement. A connection-scoped input admission owner shares the 16-frame/256-KiB window across terminals and preserves control capacity.

- [ ] First write a deterministic delayed-send test that enqueues `a`, leaves its promise pending, enqueues `b`, and requires both sends to have started in ordered mode. Keep the existing serialized-mode test unchanged.
- [ ] Implement bounded scheduling, UTF-8-safe splitting, stale-generation isolation, overflow/error fencing, and cancellation of pending work. Failed ordered batches remain stopped until reset after reattachment.
- [ ] Test multiple callers, shared connection budget, Unicode including surrogate boundaries, lost replies, stale completion after reset, and normal shutdown without unhandled rejections.
- [ ] Ensure beginning a lease and all writes use the same physical session. A capable server's failure never falls through to legacy writes. A new physical session receives no pending input from the previous one.
- [ ] Run `vp test run packages/client-runtime/src/state/terminalInput.test.ts packages/client-runtime/src/rpc` plus tests for the new ordered writer.

## Task 4: Renderer integration, documentation, and validation

**Files:** `apps/web/src/components/ThreadTerminalPanel.tsx` and its tests; living connection/RPC/remote architecture, workspace UI, shared/native validation runbooks; a new dated execution report.

- [ ] Bind the scheduler's ordered mode to the terminal environment's negotiated capability. Begin/release leases at attachment/generation boundaries and preserve the shared scheduler across all input callers. Keep the existing fallback-error ownership and renderer cleanup semantics.
- [ ] Add component coverage that exercises two input callers before the first acknowledgement and proves reattachment clears failed input without replay.
- [ ] Run the status-bar and terminal suites; measure a controlled 120 ms delayed acknowledgement at the real scheduler/RPC seam. Record queue delay separately from remote RTT and rendering. Exercise a disposable native terminal against a current-source server if available, without touching the user's active terminal.
- [ ] Update living ownership/protocol/lifecycle documentation and shared native procedures; report React best-practices review unavailable if the skill remains absent.
- [ ] Run `vp check`, `vp run typecheck`, `cargo fmt --all --check`, focused Rust tests, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `vp run --filter @bibcode/web build`, relevant cross-language fixture/interop tests, and final diff/status review.

## Coordination and rulings

- Continue in the existing `develop` checkout: the user approved the ongoing patch here, and the selected-server usage fix is already present. Do not move or stash unrelated work.
- Only one implementation subagent runs at a time; the coordinator can work on disjoint integration files. Review subagent-owned changes using a scoped diff, including untracked files, rather than requiring commits.
- Keep a ledger under this plan's ignored `.superpowers/sdd/` workspace. Review contracts before relying on their final names; the code snippets above settle the wire API.
