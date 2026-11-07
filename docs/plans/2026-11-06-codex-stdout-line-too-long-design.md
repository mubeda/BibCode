# Codex stdout LineTooLong closes delivery (#316)

Status: **Self-approved by Mauro** (explicit “approve yourself” for this defect, 2026-11-06 ART). Design for issue [#316](https://github.com/mubeda/BibCode/issues/316). Verified against `origin/main` at `2101b2cde9` (post v0.15.2 chore merge); transport path unchanged from v0.15.1 for this mechanism.

## Problem

Codex **chat** stdio JSON-RPC (`apps/server/src/provider/codex/protocol.rs`) hard-fails the whole connection when any single stdout span exceeds **`CODEX_TRANSPORT_MESSAGE_MAX_BYTES` (8 MiB)** before a newline (`read_bounded_line` → `ProtocolError::LineTooLong` → `fail_connection` nests Display into `Closed`). Turn delivery classifies the resulting launch failure as **`DefinitelyNotSent`** and retries up to **`DELIVERY_ATTEMPTS_MAX` (20)**, then Rejects with `delivery.failing` / `attempts-exhausted`. The UI shows Delivery failed with the nested string; later messages wait behind the failed head.

Observed on BiBCode 0.15.1 + Codex CLI 0.167.0 (remote server). Outgoing user text was ~90 characters — **not** the oversized payload. Emitting JSON-RPC method is **unproven** (no method/byte diagnostics today). Synthetic tests show over-bound blobs with or without a trailing LF produce the **identical** nested detail.

Related but different: #120 (512 KiB activity decoder), #273 (MCP key collision + attempt cap). This incident uses the #273 cap with a different error.

## Non-goals

- Do **not** only raise the 8 MiB cap.
- Do **not** blanket-refactor Claude / OpenCode / unrelated adapters.
- Do **not** claim Cursor/Grok are “safe” from absence of logs.
- Do **not** push, retag, or cut a Release from this worktree until the release watcher reconciles #316 (parent hold). Existing CI on other branches may finish.
- Do **not** touch PR #314 / release/v0.15.2 worktree contents except by landing a normal fix PR later.

## Provider impact (evidence classes)

| Provider                 | Transport                                             | Bound                     | This exact mechanism                    |
| ------------------------ | ----------------------------------------------------- | ------------------------- | --------------------------------------- |
| Codex chat               | stdio JSON-RPC                                        | 8 MiB                     | **Proven** (incident + synthetic)       |
| Codex terminal remote WS | same max on frames; 512 KiB activity decoder separate | related bound             | **Code-only**; not this Delivery banner |
| Cursor ACP               | stdio JSON-RPC (`cursor/acp.rs`)                      | **128 KiB**               | **Code-only susceptible** (tighter)     |
| Grok                     | re-exports Cursor ACP                                 | **128 KiB**               | **Code-only susceptible**               |
| Claude                   | Agent SDK / stream-json                               | no LineTooLong in adapter | **Not this mechanism**                  |
| OpenCode                 | HTTP/session API                                      | no stdout LineTooLong     | **Not this mechanism**                  |

Shared amplifier: durable delivery + attempt cap for `DefinitelyNotSent`. Fix classification may live in shared launch outcome mapping; adapter-specific framing stays local.

## Options

### A. Classify deterministic transport size closes as non-retryable + privacy-safe diagnostics (recommended P0)

1. When Codex (and, if the same string/path is shared, ACP) fails a launch with a nested Closed/LineTooLong (“read line exceeded … bytes on stdout”), map **`launch_failure_outcome`** (and the frozen path if it currently Rejects already) so delivery **Rejects once** instead of burning 20 relaunches. Match on structured error / stable substring already present in Display — do not scrape payloads.
2. On `LineTooLong`, log **privacy-safe** fields only: stream, maximum, bytes accumulated since last LF (or “at least maximum+1”), whether an LF was seen before fail, and **pending request method** if one is registered (no body, no thread/project content).
3. Regression tests:
   - protocol: nested Closed Display string for over-bound stdout (Codex); optional twin for ACP 128 KiB only if a shared helper is extracted or ACP diagnostics are touched.
   - delivery: a launch failure whose detail is that nested string becomes **Rejected** on first attempt (no 20-storm), profiler still records failing with a distinct error class if one exists or `attempts-exhausted` equivalent for immediate reject — prefer a clear class such as `transport-line-too-long` if profiler already allows custom classes; otherwise keep existing Rejected path with the detail string and assert attempts stay at 1.

Stops the automatic retry storm immediately. The failed head still holds later queued messages until Retry or Dismiss; this does not by itself prevent an oversized frame on a later resume of the same history.

### B. Bound startup fetches (P1, same PR if small and proven)

Where Codex app-server accepts it on 0.167.0: request **metadata-only / exclude-turns** (or equivalent) on `thread/resume` so history is not one giant stdout line. Verify against Codex docs + a unit/integration expectation on the outbound params. If the option is absent or behavior unverified on 0.167.0, leave a follow-up and do **not** guess params.

Optional: tighten MCP status / turns/list paging only with evidence; no speculative catalogue rewrite.

NOTE (#316, evidence update): `excludeTurns` is present in the installed 0.167.0 stable schema. Synthetic resume probes did not show oversized default resume lines; MCP `toolsAndAuthOnly` did. See Evidence update section.

### C. Raise transport cap only

Rejected as sole fix: hides the emitter, still can OOM, does not stop deterministic relaunch if history grows past any new cap.

## Decision

Ship **A** now. Include **B** only if outbound params are documented for this Codex version and tests assert them; otherwise open a follow-up comment on #316. No C alone.

Cursor/Grok: if classification keys off the shared nested “read line exceeded” detail string at `launch_failure_outcome`, they inherit the non-retry behavior without an ACP rewrite. Add an ACP LineTooLong diagnostic/regression **only** when touching `cursor/acp.rs` for shared helper extraction; otherwise leave ACP framing alone (code-only susceptibility noted on the issue).

## Acceptance

- Failing-then-passing regression: over-bound Codex stdout → nested Closed string → delivery Rejected without 20 attempts.
- Privacy-safe LineTooLong log fields present in unit or tracing test hooks as the repo usually asserts.
- `cargo fmt`, `clippy -D warnings` on touched crates, and the focused server tests for protocol + delivery/launch failure pass.
- Design note lands in the same PR as the code.
- No push/tag/Release from the implementing agent until parent release hold lifts.

## Historical pre-fix recovery advice (already on #316)

Copy prompt → **new Codex chat** (`thread/start`). Avoid Retry on the stuck thread. Dismiss unblocks queue but same-thread resume remains risky until A/B ship.

## Evidence update (2026-11-06 ART, isolated Codex 0.167.0 probes)

Source: installed `codex-cli 0.167.0` `app-server generate-json-schema` + throwaway `CODEX_HOME` probes under `/tmp/codex-316-*` (byte lengths / ok codes only; no payloads; no live user threads).

1. **`excludeTurns` is real on 0.167.0** (stable `ThreadResumeParams`). Earlier deferral that “docs don’t pin 0.167.0” is superseded by the installed schema bundle.
2. **Synthetic oversized rollout history did not inflate `thread/resume` stdout** (legacy/paginated, 3–9 MiB synthetic items → ~1.7 KiB resume, empty `turns`). So resume history is **not** proven as the offending frame; cursor presence alone is insufficient.
3. **`mcpServerStatus/list` with `toolsAndAuthOnly` can exceed 8 MiB** (synthetic MCP tool description 9e6 chars → **9000517**-byte JSON-RPC line). This is a proven LineTooLong-capable mechanism and matches BiBCode’s launch `mcp_status.rs` call shape. Live pending-method confirmation still required.
4. **Option A remains partial mitigation** (stop retry storm + diagnostics). **Option B** is schema-safe defense-in-depth, not a proven incident fix. **Causal same-thread fix** should target the confirmed oversized-response class (MCP catalogue bound/avoidance and/or transport handling) once live `pending_methods` confirms, without guessing resume.

## Decision update — MCP catalogue (lab-proven startup frame)

Self-approved for this defect. Installed Codex 0.167.0 schema offers only `full` | `toolsAndAuthOnly` for `mcpServerStatus/list`; both embed tool schemas. BiBCode’s pre-fix mapper (`mcp_server_status_from_snapshot`) kept only `name` + `authStatus`. Lab: `toolsAndAuthOnly` can return a **9_000_517**-byte stdout line and kill the shared chat transport.

**Chosen smallest compatible fix:** remove `mcpServerStatus/list` discovery from the launch/refresh path.
Opening publishes notification observations; refresh republishes the committed
snapshot without provider I/O. Remove the loader and its paging, timeout,
overlay-load and generation machinery, including the draft's test-only copy.
Keep bounded pre-root staging, cancellation ownership, root filtering, and the
ordered publication/completion worker. A successful opening replaces status
with the new connection's observations; failed/aborted reconnect retains the
old snapshot. Tool availability for the model remains Codex MCP runtime.
Auth/status UI uses `mcpServer/startupStatus/updated` notifications. Servers
without notifications and auth state known only from the catalogue may be
absent: this is a deliberate status-discovery limitation, not full parity with
the former list-backed baseline.

**Not chosen:** raise the 8 MiB cap; add `excludeTurns` as a causal fix; treat
the lab MCP frame as proof of the live emitter. `excludeTurns` is real in the
installed 0.167.0 stable schema, but the synthetic history probes did not
establish it as a fix for this failure. No resume parameter is added here.

**Proof target:** `mcp_catalogue_oversize_thread_resumes_and_completes_followup_turns`
drives `CodexSessionRuntime::start` through new-thread startup and existing-thread
resume, refresh, two completed turns on the same provider thread, and shutdown.
The synthetic peer would emit an oversized catalogue response if requested.
The MCP actor/runtime tests cover refresh retention, root filtering, publication
ordering, failed/aborted opening, and successful reconnect.

**Scope:** lab-proven MCP startup fix ≠ confirmed production pending method. Option A remains partial (retry storm). Same-thread continuity for the MCP mechanism is restored by keeping the transport alive through launch.

## Migration implementation scope

The initial Option A decision above is superseded for this combined draft:
Option A remains the fallback for deterministic transport-size failures, and
the notification-only MCP path addresses same-thread continuation for the
lab-proven startup mechanism. A failed durable message remains visible with
Retry/Dismiss; retry after applying this fix can resume the same provider
thread when MCP catalogue discovery was the cause. This patch does not
silently replay failed messages, discard history, change databases, or restart
production. Issue #316 stays open and the release hold stays in place until
production emitter attribution and the remaining validation are resolved.

Validation results and host-specific commands belong in the handoff report,
not in the living runbook. No commit is permitted before a read-only Codex
review reports NO FINDINGS on the combined diff.
