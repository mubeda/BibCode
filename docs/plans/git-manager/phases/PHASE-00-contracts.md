# Git Manager / Phase 00 — Wire contracts for the whole feature

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Land every `gitManager.*` schema, RPC declaration, capability flag and registration for the entire Git Manager feature in one pass, so the wire-fixture gate is crossed exactly once.

**Architecture:** This phase adds a schema-only contracts module (`packages/contracts/src/gitManager.ts`), declares thirteen `gitManager.*` methods across the whole feature (reads, unary mutations, one streaming operation RPC, one read stream), and completes the server-side registration gate so the production registry stays valid. Handlers are **stubs** in this phase — `RpcRegistry::validate_complete` (apps/server/src/rpc/session.rs, indicative :468-489; re-verify) requires a registered handler for every entry in `ACTIVE_RPC_METHODS`, and `finalize_rpc_registry` (apps/server/src/production/runtime.rs, indicative :110-116 and :405) calls it at real startup. Without stubs the server would refuse to boot until the last handler phase. Implements the master plan's § Contracts and Slice 0.

**Tech Stack:** TypeScript / Effect Schema — packages/contracts (schema-only, no runtime logic). Test: `vp test packages/contracts`. Contract gate: `vp run check:contracts`. Type-check: `vp run typecheck`. This phase also edits Rust registries in `apps/server`: build `cargo build -p bibcode-server`, test `cargo test -p bibcode-server`, lint `cargo clippy -p bibcode-server --all-targets -- -D warnings`, format `cargo fmt --all --check`.

---

## Files

- **Create:** `packages/contracts/src/gitManager.ts` — all `GitManager…` schemas and `GitManagerOperationError`
- **Create:** `packages/contracts/src/gitManager.test.ts` — schema round-trip and decoding-default tests
- **Create:** `apps/server/src/production/git_manager_rpc.rs` — stub handlers + `register_git_manager_rpc`
- **Create:** `apps/server/src/git/manager/mod.rs` — submodule skeleton declaring the four files below
- **Create:** `apps/server/src/git/manager/refs.rs` — empty skeleton (PHASE-01 fills it)
- **Create:** `apps/server/src/git/manager/graph.rs` — empty skeleton (PHASE-01 fills it)
- **Create:** `apps/server/src/git/manager/guards.rs` — empty skeleton (PHASE-02 fills it)
- **Create:** `apps/server/src/git/manager/operations.rs` — empty skeleton (PHASE-04/07/09/11/13 fill it)
- **Create:** `packages/client-runtime/src/state/gitManager.ts` — the environment-scoped atom family module
- **Modify:** `packages/contracts/src/index.ts` — re-export `./gitManager.ts`
- **Modify:** `packages/contracts/src/rpc.ts` — `WS_METHODS` entries, `Rpc.make` declarations, `RpcGroup.make` membership
- **Modify:** `packages/contracts/src/environment.ts` — nine default-false capability booleans
- **Modify:** `packages/contracts/scripts/export-rust-rpc-fixtures.ts` — count guards (indicative :737-762)
- **Modify:** `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts` — count assertions (indicative :94-100)
- **Modify:** `apps/server/tests/rpc_wire.rs` — count assertions (indicative :85-95)
- **Modify:** `apps/server/src/rpc/methods.rs` — `ACTIVE_RPC_METHODS` entries
- **Modify:** `apps/server/src/auth/scope.rs` — append to the read list and the operate list
- **Modify:** `apps/server/src/git/mod.rs` — `mod manager;` and re-exports
- **Modify:** `apps/server/src/production/mod.rs` — `pub mod git_manager_rpc;`
- **Modify:** `apps/server/src/production/runtime.rs` — call `register_git_manager_rpc`
- **Modify:** `apps/server/src/production/control.rs` — declare the capabilities true in `environment_descriptor`
- **Modify:** `packages/client-runtime/src/rpc/client.ts` — add the new stream to `EnvironmentSubscriptionRpcTag`
- **Modify:** `packages/client-runtime/package.json` — `./state/git-manager` exports entry
- **Modify (regenerated, never hand-edited):** `packages/contracts/fixtures/rpc-wire/**`

## Dependencies

None.

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: High. Effort: ~3 h.

---

## Skills to Invoke (teammate-side)

Invoke these skills via the `Skill` tool BEFORE doing any work. Order matters: always-on first, then matched.

**Always-on (every phase):**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the new tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="codebase-design")` — *the whole feature's wire boundary is designed once, here*

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints (§ 2 hard constraints, § 9 zero telemetry)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints (§ Contracts is this phase)
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 4 has the RPC-addition checklist and the atom/lane patterns
- `docs/plans/git-manager/research/worktree-checkout-restrictions.md` — the blocked-reason code list this phase encodes
- `docs/architecture/rpc-and-orchestration.md` — the protocol and scope rules a new method must satisfy
- `docs/architecture/connection-runtime.md` — capability negotiation and default-false decoding
- `docs/reference/scripts.md` — what `vp check`, `vp run typecheck` and `vp run check:contracts` actually run

If a file does not exist, report it back in the per-phase notes section of `tasks.md` and continue with what's available.

---

## Pre-execution check

- [ ] **Step 00.0: Claim the phase.** Open `../tasks.md`. Change Phase 00 row → `Status = in_progress`, `Agent = phase-00`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 00.1: Locate and re-read every registration site.** Line numbers below are indicative; re-verify each against the working tree.

	```bash
	rg -n 'WS_METHODS = \{|RpcGroup.make' packages/contracts/src/rpc.ts
	rg -n 'ACTIVE_RPC_METHODS' apps/server/src/rpc/methods.rs
	rg -n 'required_scope' apps/server/src/auth/scope.rs
	rg -n 'EnvironmentSubscriptionRpcTag' packages/client-runtime/src/rpc/client.ts
	rg -n 'Expected 101|Expected 18|Expected 65|242|23 orchestration' packages/contracts/scripts/export-rust-rpc-fixtures.ts
	rg -n 'toHaveLength|toBe\(' packages/contracts/scripts/export-rust-rpc-fixtures.test.ts
	rg -n 'assert_eq!\(rust_methods.len|manifest\.' apps/server/tests/rpc_wire.rs
	rg -n 'validate_complete' apps/server/src/rpc/session.rs apps/server/src/production/runtime.rs
	```

	Record the three count sites and today's numbers in `tasks.md`. At the time of decomposition they all agreed: **101 methods, 18 stream methods, 65 top-level stream shapes, 65 stream-shape fixtures, 23 orchestration event shapes, 242 typed failure fixtures.** Confirm before changing anything. Note that `apps/server/src/maintenance.rs` has **no allowlist to edit** — `rpc_mutability` derives from the `mutability` field you set in `ACTIVE_RPC_METHODS`, so declaring reads with `read_unary`/`read_stream` *is* the maintenance classification.

- [ ] **Step 00.2: Author the first failing test.** Path: `packages/contracts/src/gitManager.test.ts`

	```ts
	import { Schema } from "effect/schema";
	import { describe, expect, it } from "vitest";
	import { GitManagerBlockedReason } from "./gitManager.ts";

	describe("GitManagerBlockedReason", () => {
	  it("round-trips a server-authored blocked reason verbatim", () => {
	    const decoded = Schema.decodeUnknownSync(GitManagerBlockedReason)({
	      operation: "checkout",
	      code: "worktree-checked-out",
	      message: "Checkout is blocked: this branch is already checked out in another worktree.",
	    });
	    expect(decoded.message).toBe(
	      "Checkout is blocked: this branch is already checked out in another worktree.",
	    );
	  });
	});
	```

- [ ] **Step 00.3: Run the new test; expect FAIL** (the module does not exist yet).

	```bash
	vp test run packages/contracts/src/gitManager.test.ts
	```

- [ ] **Step 00.4: Implement the minimum to make Step 00.2 pass.** Path: `packages/contracts/src/gitManager.ts`

	```ts
	export const GitManagerBlockedCode = Schema.Literals([
	  "worktree-checked-out", "dirty-working-tree", "operation-in-flight",
	  "merge-in-progress", "current-branch", "default-branch",
	  "no-upstream", "detached-head", "no-remote",
	]);
	export const GitManagerBlockedReason = Schema.Struct({
	  operation: TrimmedNonEmptyStringSchema,
	  code: GitManagerBlockedCode,
	  message: TrimmedNonEmptyStringSchema,
	});
	```

	Follow `packages/contracts/src/git.ts` for imports and style. **Do not touch `GitManagerError` or `GitManagerServiceError` in `git.ts`** — they are the internal git service's error types and mean something else.

- [ ] **Step 00.5: Run the test; expect PASS.**

- [ ] **Step 00.6: Add the remaining schemas, one failing test each.** Required symbols, in this order:
	`GitManagerWorktreeEntry`, `GitManagerRefEntry` (name, tipSha, upstream, ahead, behind, current, isDefault, worktreePath, blocked: array of `GitManagerBlockedReason`), `GitManagerRefsSnapshot` (generation, headRef, detachedSha, isDirty, defaultBranch, remotes, localBranches, remoteBranches, tags, worktrees, inProgressOperation, conflictedPaths), `GitManagerCommitEntry` (sha, shortSha, parents, decorations, subject, body, author/committer name+email+timestamp), `GitManagerCommitPage` (generation, pinnedTips, commits, nextOffset, exhausted, degradedToAllPaging), `GitManagerDiffSource` (union `working-tree | commit | stash`), `GitManagerDiff`, `GitManagerStashEntry`, `GitManagerConflictState`, `GitManagerMergePreview`, `GitManagerOperationRequest` (tagged union covering branch/sync, stash/merge, rewrite and tag families), `GitManagerOperationEvent` (`started | output | finished | failed`), `GitManagerSignalEvent`, and the error class `GitManagerOperationError` with fields `{ operation, code, message, blocked: NullOr(GitManagerBlockedReason) }`. Every `message` field is server-authored and rendered verbatim.

- [ ] **Step 00.7: Declare the thirteen methods in `packages/contracts/src/rpc.ts`.** This table is binding for every downstream phase.

	| WS method | Mode | Scope | Capability flag | Landing phase |
	| --- | --- | --- | --- | --- |
	| `gitManager.getRefs` | unary | read | `gitManagerReads` | 01 |
	| `gitManager.getCommits` | unary | read | `gitManagerReads` | 01 |
	| `gitManager.getDiff` | unary | read | `gitManagerReads` | 01 |
	| `gitManager.getStashes` | unary | read | `gitManagerStashMergeOperations` | 09 |
	| `gitManager.previewMerge` | unary | read | `gitManagerStashMergeOperations` | 09 |
	| `gitManager.listPullRequests` | unary | read | `gitManagerPullRequests` | 16 |
	| `subscribeGitManagerSignal` | stream | read | `gitManagerLiveSignal` | 09 |
	| `gitManager.commit` | unary | operate | `gitManagerCommitOperations` | 04 |
	| `gitManager.undoCommit` | unary | operate | `gitManagerCommitOperations` | 04 |
	| `gitManager.discard` | unary | operate | `gitManagerCommitOperations` | 04 |
	| `gitManager.stagePartial` | unary | operate | `gitManagerPartialStaging` | 11 |
	| `gitManager.discardPartial` | unary | operate | `gitManagerPartialStaging` | 11 |
	| `gitManager.runOperation` | stream | operate | `gitManagerBranchSyncOperations`, `gitManagerStashMergeOperations`, `gitManagerRewriteOperations`, `gitManagerTagOperations` | 07/09/13/16 |

	Every method declares `error: GitManagerOperationError`. Add the `WS_METHODS` key, the `Rpc.make(...)` const (streams add `stream: true`), and membership in `RpcGroup.make` — omitting the group registration is a hard "stale identifier" failure in the export script.

- [ ] **Step 00.8: Add the nine default-false capability booleans** to `ExecutionEnvironmentCapabilities` in `packages/contracts/src/environment.ts` (indicative :30-42), each `Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))`: `gitManagerReads`, `gitManagerCommitOperations`, `gitManagerBranchSyncOperations`, `gitManagerStashMergeOperations`, `gitManagerPartialStaging`, `gitManagerRewriteOperations`, `gitManagerTagOperations`, `gitManagerLiveSignal`, `gitManagerPullRequests`. Add a decoding-default test asserting each is `false` when absent from the payload.

- [ ] **Step 00.9: Complete the Rust registration.**
	1. `apps/server/src/rpc/methods.rs` — add each method to `ACTIVE_RPC_METHODS` in its existing alphabetical position, using `read_unary` / `read_stream` for reads and `mutation_unary` / `mutation_stream` for mutations.
	2. `apps/server/src/auth/scope.rs` — append the six read methods and the stream to the existing `SCOPE_ORCHESTRATION_READ` match arm's list, and the six mutations to the `SCOPE_ORCHESTRATION_OPERATE` list. The inline test `every_active_rpc_method_has_exactly_one_declared_scope` fails otherwise.
	3. `apps/server/src/production/git_manager_rpc.rs` — `GIT_MANAGER_UNARY_METHODS`, `GIT_MANAGER_STREAM_METHODS`, a `GitManagerRpcServices` struct, and `pub fn register_git_manager_rpc(registry: &mut RpcRegistry, services: GitManagerRpcServices)` modelled on `register_git_vcs_rpc` (apps/server/src/production/git_vcs.rs, indicative :395-419). Every handler returns a `GitManagerOperationError` with `code = "not-implemented"` for now.
	4. `apps/server/src/production/mod.rs` and `apps/server/src/production/runtime.rs` — declare the module and call `register_git_manager_rpc` beside `register_git_vcs_rpc` (indicative runtime.rs:389).
	5. `apps/server/src/production/control.rs` `environment_descriptor` (indicative :2140-2160) — declare all nine capabilities `true`.

- [ ] **Step 00.10: Create the server submodule skeleton.** `apps/server/src/git/manager/mod.rs` declaring `pub mod graph; pub mod guards; pub mod operations; pub mod refs;`, each file existing with only a doc comment (and `#![allow(dead_code)]` if Clippy objects). Add `mod manager;` plus `pub use manager;` re-exports to `apps/server/src/git/mod.rs`. This exists so PHASE-01 and PHASE-02 can run in parallel touching only their own file.

- [ ] **Step 00.11: Create the client atom module.** `packages/client-runtime/src/state/gitManager.ts` exporting `createGitManagerEnvironmentAtoms(runtime)` — query atom families for the three reads plus the stash/merge/PR reads, a subscription atom family for `subscribeGitManagerSignal`, and `createEnvironmentRpcCommand` entries for each mutation. Reuse `vcsCommandScheduler` / `vcsCommandConcurrency` from `packages/client-runtime/src/state/vcsCommandScheduler.ts` so Git Manager mutations serialise on the **same** per-`(environmentId, cwd)` lane as `vcs.stageFiles`. Add `subscribeGitManagerSignal` to `EnvironmentSubscriptionRpcTag` in `packages/client-runtime/src/rpc/client.ts` and a `"./state/git-manager"` entry to `packages/client-runtime/package.json`.

- [ ] **Step 00.12: Regenerate the fixtures and reconcile all three count sites.**

	```bash
	node packages/contracts/scripts/export-rust-rpc-fixtures.ts
	```

	It will throw with the real new numbers in the message (e.g. "Expected 101 active RPC methods, found 114"). Set the guards in `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, the assertions in `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`, and the assertions in `apps/server/tests/rpc_wire.rs` to the **same** actual values. Re-run until the export writes fixtures cleanly. Never hand-edit anything under `packages/contracts/fixtures/rpc-wire/`.

- [ ] **Step 00.13: Full build + test gate.**

	```bash
	vp run check:contracts
	vp run typecheck
	vp check
	vp test run packages/contracts
	cargo fmt --all --check
	cargo test -p bibcode-server
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	```

	Expected: zero warnings, zero errors, all tests green. `cargo test -p bibcode-server` must include `production_control` and `rpc_wire`.

- [ ] **Step 00.14: Prove the production registry is still complete.** Add a test in `apps/server/tests/production_control.rs` (or extend the existing `complete_registry` suite) asserting `finalize_rpc_registry` succeeds with every `gitManager.*` method registered, and fails when one is excluded. This is the guard that stops a later phase from removing a stub without adding a handler.

- [ ] **Step 00.15: TDD proof.** Temporarily change `GitManagerBlockedReason.message` to `Schema.Literal("x")` and delete one `gitManager.*` entry from `RpcGroup.make`. Re-run `vp test run packages/contracts/src/gitManager.test.ts` and `vp run check:contracts`; confirm both fail. Restore.

- [ ] **Step 00.16: Mark phase complete.** Change Phase 00 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary: the new counts, any method-table deviation, and how many tests landed.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] All thirteen `gitManager.*` methods appear in `WS_METHODS`, have an `Rpc.make`, are members of `RpcGroup.make`, appear in `ACTIVE_RPC_METHODS`, and have exactly one `required_scope` arm. Reads carry `orchestration:read`; no read carries a write scope.
- [ ] Regenerated fixtures under `packages/contracts/fixtures/rpc-wire/` are checked in and produced only by the export script.
- [ ] All three count sites agree and match the export's actual numbers.
- [ ] Nine capability booleans decode to `false` when absent, and the server descriptor declares them `true` (proven by a test).
- [ ] `register_git_manager_rpc` is wired into `runtime.rs`, and `finalize_rpc_registry` succeeds — proven by the Step 00.14 test.
- [ ] `vp run check:contracts`, `vp check`, `vp run typecheck` clean.
- [ ] `cargo fmt --all --check`, `cargo test -p bibcode-server`, `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean.
- [ ] **Zero telemetry:** this phase adds no analytics, crash reporting, usage counter, remote feature flag, avatar/identity fetch, third-party host contact, or new dependency. `git diff packages/*/package.json apps/*/package.json apps/server/Cargo.toml pnpm-lock.yaml` shows no dependency change.
- [ ] Final `git diff` and `git status --short` review: no generated files beyond the regenerated fixtures, no debug output, no unrelated edits.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **Method names are fixed by the Step 00.7 table.** No later phase adds a `gitManager.*` method; a phase that believes it needs one stops and escalates through `tasks.md`.
- **Known naming drift to reconcile before Round 1 starts.** Sibling phase files drafted in parallel refer to method names this table does not use. The Step 00.7 table wins; the coordinator must correct those files, or record the opposite decision in `tasks.md` before PHASE-00 executes.
  - `gitManager.getCommitDiff` (PHASE-06) and `gitManager.getStashDiff` (PHASE-12) → both are `gitManager.getDiff` with a `GitManagerDiffSource` of `{ _tag: "commit", sha, path }` or `{ _tag: "stash", index, path }`. The working-tree source (`{ _tag: "working-tree", path, staged }`) is the same method, which is why it is one method and not three.
  - `gitManager.subscribeRepository` (PHASE-09) → `subscribeGitManagerSignal`. Existing stream methods in `WS_METHODS` are bare `subscribeXxx` identifiers with no dot (`subscribeVcsStatus`, `subscribeWorktreeCatalog`, `subscribeActivity`); a dotted stream name breaks that convention.
- **Stubs must be replaced, not added to.** PHASE-01 replaces the `gitManager.getRefs` / `getCommits` / `getDiff` stubs in `apps/server/src/production/git_manager_rpc.rs`; PHASE-04 replaces `commit` / `undoCommit` / `discard`; PHASE-07/09/13/16 replace `runOperation` arms; PHASE-09 replaces `getStashes` / `previewMerge` / `subscribeGitManagerSignal`; PHASE-11 replaces `stagePartial` / `discardPartial`; PHASE-16 replaces `listPullRequests`. **Never delete a method from `ACTIVE_RPC_METHODS` to avoid writing a handler** — the server stops booting.
- **The server submodule skeleton already exists** at `apps/server/src/git/manager/{guards,refs,graph,operations}.rs`. PHASE-01 owns `refs.rs` + `graph.rs`, PHASE-02 owns `guards.rs`, PHASE-04/07/09/11/13 share `operations.rs` one round at a time. Nobody re-creates `mod.rs`.
- **Client atoms live in `packages/client-runtime/src/state/gitManager.ts`**, instantiated in web as `apps/web/src/state/gitManager.ts` (`export const gitManagerEnvironment = createGitManagerEnvironmentAtoms(connectionAtomRuntime)`) — PHASE-03 creates that one-line web wrapper. Web phases consume via `useEnvironmentQuery(gitManagerEnvironment.getRefs({ environmentId, input: { cwd } }))`; nobody calls `request` directly.
- **Mutations share the existing `vcsCommandScheduler` lane** keyed on `(environmentId, cwd)`, so a Git Manager commit and a Source Control stage cannot interleave client-side.
- **Blocked reasons are `{ operation, code, message }`** with `code` drawn from `GitManagerBlockedCode`. The client renders `message` verbatim and derives no policy; unknown codes fail closed (treat as blocked).
- **Every gitManager RPC fails with `GitManagerOperationError`** carrying `{ operation, code, message, blocked }`. Server code maps `GitCommandError` into it; `message` is a payload field and is never logged.
- **Capability gating is per-flag.** A web surface checks the flag from the same session it issues the request on, following `packages/client-runtime/src/state/vcs.ts` (indicative :78-99).
