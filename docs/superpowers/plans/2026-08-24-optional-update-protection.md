# Optional Desktop Update Protection Implementation Plan

> **For inline execution:** REQUIRED SUB-SKILL: use
> `superpowers:executing-plans`. The user explicitly prohibited subagents and
> commits until the complete fix is verified, so every task runs in this
> worktree and no commit step is included.

**Goal:** Make desktop update protection reliable, observable, and explicitly
skippable after failure on macOS, Windows, and Linux.

**Architecture:** The server's typed RPC inventory becomes the maintenance
classification source and the admission gate exposes bounded blocker metadata.
The Tauri host polls authenticated preparation status and remains authoritative
for the failure-gated bypass; additive contracts carry progress to the React
dialog.

**Tech Stack:** Rust, Axum, Tokio, Tauri 2, TypeScript, Effect Schema, React,
Vite+ Test.

**Spec:** `docs/superpowers/specs/2026-08-24-optional-update-protection-design.md`

## Global Constraints

- No subagents.
- No commits until the user confirms the fully verified result.
- Protection remains default-on and bypass is per update, failure-gated, and
  explicitly acknowledged.
- No payloads, paths, credentials, or request bodies enter blocker diagnostics.
- Preserve older-host decoding through additive defaults.

---

### Task 1: Correct and centralize RPC maintenance classification

**Files:**
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `apps/server/src/maintenance.rs`
- Test: `apps/server/tests/production_maintenance.rs`

**Interfaces:**
- Produces: `RpcMethodSpec` maintenance mutability consumed by
  `rpc_mutability(method)`.

- [ ] Add an assertion that `subscribeWorktreeCatalog` is read-only and run the
  focused Rust test to observe the current mutation result.
- [ ] Add mutability to the typed RPC inventory without changing its serialized
  `{name, mode}` manifest, and derive `rpc_mutability` from that inventory.
- [ ] Keep unknown methods as mutations and run the focused test green.

### Task 2: Make mutation blockers and preparation stages observable

**Files:**
- Modify: `apps/server/src/maintenance.rs`
- Modify: `apps/server/src/http.rs`
- Modify: `apps/server/src/rpc/session.rs`
- Test: `apps/server/tests/production_maintenance.rs`

**Interfaces:**
- Produces: authenticated status JSON containing `stage`, `elapsedMs`,
  `remainingMs`, `inFlightMutations`, and bounded `blockers` entries with only
  `operation` and `ageMs`.

- [ ] Add gate and HTTP status tests that expect named blocker metadata and
  stage transitions; run them red.
- [ ] Track named permits by ID, publish stage transitions around drain,
  quiescence, store lock, checkpoint, and backup, and log timeout blockers.
- [ ] Name WebSocket and HTTP mutation admissions, then run the focused server
  tests green.

### Task 3: Add version-skew-safe desktop progress and bypass contracts

**Files:**
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ipc.test.ts`
- Modify: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Test: `packages/contracts/src/ipc.test.ts`

**Interfaces:**
- Produces: protection status `skipped`; optional `stage`, `elapsedMs`, and
  `blockedOperationCount`; install input `skipProtection`; typed
  `UpdateMaintenanceActiveError` for provider-usage refresh.

- [ ] Add decoding and bridge-shape assertions for progress, skipped state, and
  bypass input; run them red.
- [ ] Add schemas with older-host defaults and the maintenance rejection error.
- [ ] Run contract tests green.

### Task 4: Publish progress and enforce host-owned bypass safety

**Files:**
- Modify: `apps/desktop/src-tauri/src/updates.rs`
- Test: `apps/desktop/src-tauri/src/updates.rs`

**Interfaces:**
- Consumes: server maintenance status and `skipProtection` input.
- Produces: emitted desktop update progress and a stopped-backend install path
  whose protection entries are `skipped`.

- [ ] Add tests for progress serialization, first-attempt bypass rejection, and
  installer-failure restart after an eligible bypass; run them red.
- [ ] Poll maintenance status while prepare is pending and emit changed stages.
- [ ] Enforce prior-failure eligibility, bypass prepare/commit only when
  eligible, stop the snapshot, and reuse installer recovery.
- [ ] Run desktop update tests green.

### Task 5: Present progress and explicit unsafe acknowledgement

**Files:**
- Modify: `apps/web/src/components/desktop/UpdateProtectionDialog.tsx`
- Modify: `apps/web/src/components/desktop/UpdateProtectionDialog.test.tsx`
- Modify: `apps/web/src/tauriDesktopBridge.test.ts`

**Interfaces:**
- Consumes: additive protection progress and `skipProtection`.
- Produces: live stage copy and an acknowledgement-gated **Install without
  backup** action after failure.

- [ ] Add dialog tests for stage/count/elapsed copy and bypass acknowledgement;
  add bridge forwarding coverage; run them red.
- [ ] Render progress and the warning acknowledgement, reset local decisions on
  close, and forward `{ skipProtection: true }`.
- [ ] Run focused web tests green.

### Task 6: Align living architecture and native runbooks

**Files:**
- Modify: `docs/architecture/overview.md`
- Modify: `docs/testing/macos-desktop.md`
- Modify: `docs/testing/windows-desktop.md`
- Modify: `docs/testing/linux-desktop.md`

- [ ] Document default-on, failure-gated bypass, progress semantics, blocker
  privacy, and exact backend-stop behavior.
- [ ] Add native validation cases for read subscriptions, visible progress, and
  acknowledged bypass on all three platforms.

### Task 7: Verify the complete uncommitted change

- [ ] Run focused contracts, web, server, and desktop tests.
- [ ] Run `cargo fmt --all --check`, affected Clippy targets with warnings
  denied, `vp check`, and `vp run typecheck`.
- [ ] Run broader affected Rust and TypeScript suites selected by CodeGraph and
  direct dependency inspection.
- [ ] Review `git diff` and `git status --short`; do not commit.
