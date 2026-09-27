# Clone Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Clone from URL keeps running on the server when the WebSocket drops. The dialog re-attaches on the next session and finishes, or reports the real outcome. Cancel, closing the dialog, shutdown, and old servers keep predictable behaviour.

**Architecture:** Design alternative A.

- A server-owned clone runtime (`CloneRuntime`) lives in a new module beside the Git VCS RPC services and replaces the static `CloneDestinationRegistry`.
  - It keys one live clone per destination (canonical parent + derived leaf).
  - A clone owns its root cancellation token, a tracked task, and a clone of the starter's admission permit.
  - Git runs in its own task, so cleanup and the published outcome survive a panicking transfer.
- `vcs.clone` gains optional `attach`/`detach`. `vcs.cancelClone` is new. Both are gated by the new `vcsCloneReattach` capability.
- The Git module keeps reservation, transfer, identity-checked cleanup, and the reuse check. The reuse check also refuses a leftover without an index.
- `packages/client-runtime/src/state/vcsClone.ts` owns the re-attach loop and the capability-gated "cancel on the next session" call.
- The Add Project workflow gains `reconnecting` and `cancelling` phases and the spec's copy table. It never starts a new clone while a server cancel is still unsettled.

**Tech Stack:** Rust (Tokio 1.53, `tokio_util::sync::CancellationToken`, `tokio::sync::watch`, serde_json), TypeScript (Effect 4.0.0-beta.107 RPC/Schema/Stream, `@effect/vitest`, Vite+), React 19, Playwright (live check).

**Spec:** [`docs/superpowers/specs/2026-09-24-clone-reconnect-design.md`](../specs/2026-09-24-clone-reconnect-design.md). The user approved it on 2026-09-24 with the recommended option on every ruling. Read it before each task; this plan argues from it.

The spec's line citations predate concurrent edits, so this plan re-anchors every edit by symbol and by line numbers verified on 2026-09-25. It was revised the same day after a Codex pre-flight; see "Pre-flight corrections applied (2026-09-25)" at the end.

## Global Constraints

Copied verbatim from the spec. Every task's requirements include these.

- Architecture: "**A. Runtime-owned operation keyed by destination (chosen)**".
- Owner: "A clone runtime in `GitVcsRpcServices`, beside `worktree_removal_tasks` … replaces the static `CloneDestinationRegistry` …; the Git module keeps reservation, transfer, identity-checked cleanup, and the reuse check."
- Entry: "keyed by canonical parent plus today's derived leaf …: the URL, a root transfer token (`CancellationToken::new()`), a state watch, whether the starter detached, a clone of its admission permit …, and the tracked task. Admission is non-waiting and bounded like the catalog runtime …; proposed bound 16."
- Start-or-join: "No live entry: today's path, dropping any retained outcome. Same URL running: join and share its outcome; same URL cleaning up: wait, then start (the retry-after-Cancel ruling). Another URL: `busy` at once."
- "**`attach: true` is join-only:** join a live entry with the same URL (another URL: `busy`), else return a retained outcome, else run the reuse check without reserving (a finished clone's path, the incomplete-clone error, or `not-in-progress` for no folder)."
- "**Caller cancellation** (Interrupt, teardown, dropped handler) ends that caller's wait, and cancels the clone only if the caller started it without `detach`, so older clients keep today's Cancel. Joiners never cancel by leaving."
- "**`vcs.cancelClone`** takes the clone's input (`url`, `parentDir`, `directoryName?`), so only the server derives keys. It cancels a live entry with that URL, waits for its cleanup, and returns `{ cancelled: true }`, else `false`; idempotent, it never touches a finished clone. `orchestration:operate` … and `mutation_unary`, like the other cancel RPCs."
- "**Failure retention:** failed and cancelled outcomes stay in memory 5 minutes, so a re-attach gets the real reason; success needs none (the disk is the record)."
- "**Shutdown** … closes admission, cancels every root token, and drains beside `worktree_removal_tasks.close_and_drain()` …, so Git stops and the partial folder is removed first."
- Orphan policy: "No orphan deadline, so a laptop sleep never loses a long clone; an unattached clone runs under the 24-hour bound … and, for HTTP(S), the stall guard".
- Orphan consequence: "**Closing a window no longer stops a remote clone:** the socket close only detaches, and the unmount's `vcs.cancelClone` may not get out of a closing or disconnected window." Cloning "the same URL into the same folder joins a running orphan or adds a finished one".
- "**Closing the dialog cancels** …, removing only the folder the clone created. With the capability, Cancel and close send `vcs.cancelClone`, then end the wait; an abort alone only detaches."
- "**The client registers the project** after success or re-attach …, so default-model resolution stays client-side".
- Scope: "`sourceControl.cloneRepository` shares `clone_repository` …, so it uses the runtime without new fields". Follow-ups (Git Manager transfers, `vcs.pull`, pushes) are out of scope.
- "**Capability `vcsCloneReattach`, default false,** gates the fields and the loop; the server detaches only when asked."
- Ruling 5: "**Cancel key: by destination.**"
- Ruling 6: "reuse also requires the file at `git rev-parse --git-path index` to exist; same message. A lock alone may belong to a running Git command, so it is not the test."
- Ruling 9: "**Duplicate projects: no change**".
- Ruling 10: "**Destination keys: canonical parent plus lexical leaf.** `vcs.clone` already canonicalizes …; `sourceControl.cloneRepository` must too".
- Wire: "`GitCloneInput` … and `CloneInput` gain optional `attach` and `detach` (default false)." "`vcs.clone` errors add `GitCloneOperationError { reason, destination, message }` (`busy`, `capacity`, `shutting-down`, `not-in-progress`, `cancelled`)."
- Client: "`packages/client-runtime/src/state/vcs.ts` owns the loop (React owns no retry loops …). Capability false: today's single call. Capability true: send `detach: true`; on `RpcClientError`, `EnvironmentRpcUnavailableError`, or an interrupt it did not request, publish `reconnecting`, wait for the next session as `subscribe()` does, and re-issue with `attach: true`. Typed failures never re-attach. No attempt limit or timer: the loop ends at an outcome, a Cancel or close, a blocked or user-disconnected environment, or a session without the capability (reported as stopped). Cancel goes out on its own lane, since the clone holds its serial lane".
- UI: "The form keeps its values in every outcome. Phases: `idle → cloning ⇄ reconnecting → registering → closed`, plus `cancelling`. **Cancel clone** shows in `cloning` and `reconnecting`. `<host>` is the dialog's host label."
- Copy (exact strings, `<host>` = `selectedHost.label`, `<path>` = the error's `destination`):

  | Situation                       | Dialog                                                                                                     |
  | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
  | Connection lost                 | **Cloning…**; "Lost the connection to <host>. The clone continues on the server; reconnecting…"            |
  | Reconnected, still running      | **Cloning…**; status cleared                                                                               |
  | Cancel while disconnected       | **Cancelling…**; "The clone stops when <host> reconnects."                                                 |
  | Cancel confirmed                | "Clone cancelled." (today)                                                                                 |
  | Success after re-attach         | **Adding project…**, closes once the project opens (today)                                                 |
  | Clone failed, live or retained  | "Clone failed: <server detail>" (today)                                                                    |
  | `not-in-progress`               | "No clone is in progress for <path>. Press Clone to start again."                                          |
  | `cancelled`, not by this dialog | "The clone into <path> was cancelled elsewhere. Press Clone to start again."                               |
  | `busy`                          | "Another clone into <path> is in progress. Wait for it to finish or choose another folder."                |
  | `capacity`                      | "Too many clones are running on <host>. Wait for one to finish and try again."                             |
  | `shutting-down`                 | "<host> is shutting down. Press Clone again once it is back."                                              |
  | Blocked or disconnected         | "Can't reconnect to <host>. The clone continues there; clone the same URL into the same folder to finish." |

- "`busy` omits the other URL, which may embed credentials."
- Interplay: "Batch-1 process-group guard: prerequisite and backstop." It is **in the tree**: `SupervisedChildGuard` at `apps/server/src/process/supervised.rs:163,205`, landed in `f05100a1`. No task adds it.

Repository requirements (AGENTS.md, controller brief):

- Focused tests first for every changed behaviour (watch red, then green).
- **Every task ends green on its own**, and each task's checkpoint builds and passes its gates without the next task. Rust denies warnings for every target (`[workspace.lints.rust] warnings = "deny"`, `Cargo.toml:101-102`), so a task may add an item only together with its first non-test caller. Production startup also rejects a method listed in `ACTIVE_RPC_METHODS` without a registered handler (`RpcRegistry::validate_complete`, called at `apps/server/src/production/runtime.rs:119`). A method spec therefore lands in the same task as its handler.
- New lifecycle tests must be shown to go **red against a deliberately broken variant**. Each such test names the break in its task's "Red evidence" table. The implementer applies the break temporarily, runs the test, records the failing assertion in the ledger, and restores the code before continuing.
- TypeScript tests follow the repository lint rules: no `Effect.runSync`/`runPromise` in tests (`bibcode/no-manual-effect-runtime-in-tests`; use `it.effect` and `Effect.promise`), and Schema decoders are compiled at module scope (`bibcode/no-inline-schema-compile`).
- `vp check`, `vp run typecheck`, `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings` must pass. Run `vp run check:contracts` whenever contracts or fixtures change.
- `apps/web` React changes: review against `vercel-react-best-practices` (`/home/mauro/.agents/skills/vercel-react-best-practices/SKILL.md`) **and** `UI.md`, and report both. An agent without the skill reports that review as "not run".
- Living docs and `docs/testing/` runbooks change in the same change as the behaviour they describe (AGENTS.md "Testing Runbook Maintenance").
- `packages/contracts` stays schema-only.
- Playwright live verification of every UI state change, against an isolated dev server (`BIBCODE_PORT_OFFSET`, its own `BIBCODE_HOME`). **Never use port 3773** (the user's desktop app).
- **Implementers never commit.** Every task ends with "Stop: the controller runs a Codex review and asks the user before committing". No `git add`, `commit`, `stash`, `reset`, `checkout`, `restore`, or `clean`.
- Known host flakes; classify them, never chase them:
  - `provider_terminal_supervisor` fails about once per full run, even at base;
  - pipe-heavy fixture tests fail when `pipe-user-pages-soft` is exhausted;
  - Codex-sandbox loopback `EPERM`: run socket tests on the host before calling them broken.


## Coordination with concurrent work

Other agents edit this worktree at the same time. `git status --short` at plan time lists their uncommitted files.

- **Never edit** these files; they belong to other tracks:
  - `apps/web/src/components/Sidebar*`, anything under `apps/web/src/components/sidebar/`, and `apps/web/src/components/settings/remote-servers/*`;
  - `apps/web/src/connection/*`, `apps/web/src/tauriDesktopBridge*`, `apps/web/src/localApi.ts`, `apps/web/src/contextMenuFallback*`;
  - `packages/client-runtime/src/connection/*`, `packages/client-runtime/src/platform/*`, `packages/contracts/src/ipc*`;
  - `apps/desktop/**`, `.github/workflows/ci.yml`, `scripts/ci-platform-contract.test.ts`.
- **Shared files: make targeted `Edit`s to your own paragraphs or symbols only; never reformat or rewrite them.**
  - `docs/architecture/overview.md`, `docs/architecture/connection-runtime.md`, `docs/architecture/rpc-and-orchestration.md`, and `docs/user/workspace-ui.md`. Other agents hold uncommitted edits there; `workspace-ui.md` belongs to the left-panel track.
  - `docs/testing/cross-platform-validation.md`, `docs/testing/execution-report-template.md`, and `docs/testing/README.md`. The liveness and left-panel plans also add scenarios there.
  - `apps/server/src/production/runtime.rs`. The PR-panel agent owns concurrent runtime wiring. Task 6 adds one field, one constructor line, one struct-literal line, and one drain line; re-read those symbols before editing.
  - `packages/shared/src/testSupport.ts`. Task 1 adds one line to `makeTestExecutionEnvironmentCapabilities`; other tracks may add capabilities beside it.
- If a workspace gate fails only in files outside this plan, record the output and continue. Do not edit those files.

### Overlap with the connection-liveness plan

[`2026-09-24-connection-liveness.md`](./2026-09-24-connection-liveness.md) is independent by spec ("It makes spurious drops rarer; this design makes the rest … harmless to a clone"). Neither plan needs the other to land first. Both edit these files:

| File | Liveness | This plan | Rule |
| --- | --- | --- | --- |
| `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, its `.test.ts`, `packages/contracts/fixtures/rpc-wire/**` | Task 11 adds one static fixture (+1 fixture) | Task 1: +1 typed failure, +1 fixture, +1 fingerprint. Task 5: +1 method, +2 typed failures, +2 fixtures, +2 fingerprints. | Pin **deltas**, not absolutes: read the current manifest numbers, then add. From today's tree (131 methods / 288 typed failures / 389 fixtures / 359 fingerprints), this plan ends at 132 / 291 / 392 / 362. It ends at 393 fixtures if liveness Task 11 lands first; that task's plan now states its own delta the same way (item 10 of the pre-flight corrections). |
| `apps/server/tests/rpc_wire.rs` (`rust_registry_matches_the_active_typescript_rpc_group`) | Task 6 appends subprotocol tests; the counts do not change | Task 1 bumps the typed-failure pin (288 → 289); Task 5 bumps the method pin (131 → 132) and the typed-failure pin (289 → 291) | Edit only the two `assert_eq!` literals. |
| `docs/architecture/connection-runtime.md`, `rpc-and-orchestration.md`, `overview.md` | Several paragraphs | Task 11 paragraphs named there | Targeted edits only. |
| `docs/testing/cross-platform-validation.md`, `execution-report-template.md` | Task 17 slow-link scenario | Task 12 updates the Clone from URL scenario only | Targeted edits only. |
| `packages/client-runtime/src/rpc/client.ts` | Task 11: `EnvironmentRpcFailure` gains `RpcResponseTooLargeError` through inference | **Read only.** `vcsClone.ts` imports `currentSession`, `requestInSession`, and `EnvironmentRpcUnavailableError` | Nothing to merge. `RpcResponseTooLargeError` is a typed failure, so the loop never re-attaches on it. |

These are consumed only, never edited: liveness Task 2 (`rpc/livenessProtocol.ts`, the local socket protocol) and Task 15 (query re-issue). Consequences:

- Commands are outside liveness Task 15, so it never re-issues `vcs.clone`; only this plan's loop does.
- After liveness Task 2, pending calls on a dropped socket still end with `RpcClientError` or the resumed interrupt (`RpcClient.ts:286-302`). Task 7's transport-loss classifier covers both.
- Live check: before liveness Task 2, the client notices a silent socket after about 5 s (the Pong pinger); after it, after 30 s ±10 %. Task 14 therefore drops the connection with the browser `offline` event, which ends the lease at once in both regimes (`packages/client-runtime/src/connection/supervisor.ts:381-449`). It holds the outage for 40 s, which exceeds both bounds.
- Controller ruling R10 in the liveness plan hands the clone-disconnect copy to this plan. Tasks 9 and 10 own it.

## Plan-authored decisions pending controller approval

The spec leaves these open. Each is the smallest choice consistent with the spec. The controller accepted D1-D14 as implementation decisions on 2026-09-25 (see "Controller rulings on the open questions" at the end), and revised D11 in round 2. The user can still override any of them. The pre-flight corrections changed D3, D6, D7 and D11 and added D10-D14.

- **D1 — `vcs.cancelClone` error union:** `[GitCommandError, EnvironmentRpcError]`. The handler fails only when `parentDir` cannot be resolved (`GitCommandError`, as `vcs.clone` does) or at the auth and maintenance layers. A caller that leaves ends through the RPC interruption path (an `Interrupt` exit), never as a typed failure. It reads no `cwd`, so the workspace errors cannot occur. That is 2 typed-failure fixtures.
- **D2 — Position of `GitCloneOperationError` in `vcs.clone`'s union:** it is appended **last**, so `vcs__clone-00..03.json` stay byte-identical and only `vcs__clone-04.json` is new.
- **D3 — `sourceControl.cloneRepository` failures:** its declared union is `[SourceControlRepositoryError, EnvironmentRpcError]`. So every failure the runtime returns for it becomes `SourceControlRepositoryError { provider, operation: "cloneRepository", detail }`: a `GitCommandError` keeps its `detail`, and a `GitCloneOperationError` gives its `message`. This also ends today's pass-through of an undeclared `GitCommandError`, which the client could not decode. The wire union stays unchanged ("without new fields"), and it never sends `attach`/`detach`.
- **D4 — Phase channel:** the clone command input carries an optional `onProgress(progress: { phase: "cloning" | "reconnecting"; reattach: boolean })` callback, the same pattern as the existing `onCloned`. `reattach` tells the dialog whether Cancel and close must send `vcs.cancelClone` (capability true) or only abort (capability false).
- **D5 — The client-side stop error:** client-runtime defines `VcsCloneStoppedError { environmentId, reason: "environment-unavailable" | "reattach-unsupported", message }`. The reasons map to the copy as follows:
  - `environment-unavailable` (blocked or user-disconnected) shows "Can't reconnect to <host>. The clone continues there; clone the same URL into the same folder to finish.";
  - `reattach-unsupported` (a session without the capability, "reported as stopped") shows today's "The clone stopped before it finished. Try again."
- **D6 — Cancel settlement:**
  - After Cancel, the form stays in **Cancelling…** until the clone request **and** the server cancel have both settled. The cancel settles when it is acknowledged, when the environment stops or loses the capability, or when it fails.
  - No new clone into that destination is dispatched before then. A still-retrying cancel keyed by destination could otherwise stop it. The client runtime owns this (round-2 ruling): a module-level registry of pending cancels, keyed by environment and destination, holds any later clone into the folder, across unmount and remount. It works per client runtime (one tab or window).
  - Only a failed or stopped cancel aborts the clone wait. An acknowledged cancel lets the clone request return its own outcome, so a cleanup failure is still shown.
  - Copy: a clone outcome that is a real failure (for example a folder that could not be removed) shows "Clone failed: <detail>". A cancel that stopped with `environment-unavailable` shows the Blocked row. `reattach-unsupported` shows "The clone stopped before it finished. Try again." Any other cancel failure shows "Clone failed: <detail>". Otherwise the form shows "Clone cancelled.".
- **D7 — "Closing the dialog":** the dialog cannot be dismissed while `busy` (`AddProjectDialog.tsx` ignores `onOpenChange` and hides the close button). "Close" therefore means the workflow's unmount effect (`useAddProjectWorkflow.ts:257-266`), as today. With the capability, that unmount sends `vcs.cancelClone` **as best effort**, per the orphan policy: a closing or disconnected window may never get it out, and then the clone keeps running on the host. Re-cloning the same URL into the same folder joins or adds it.
- **D8 — Server-authored `message` text** for `GitCloneOperationError`. The dialog shows the spec's copy, not this text; the text serves logs and other clients:
  - `busy`: "Another clone into <destination> is in progress."
  - `capacity`: "Too many clones are running on this server."
  - `shutting-down`: "The server is shutting down."
  - `not-in-progress`: "No clone is in progress for <destination>."
  - `cancelled`: "The clone into <destination> was cancelled."
- **D9 — `attach` while shutting down:** a retained outcome is still returned. Otherwise the answer is `shutting-down`, not a disk inspection, so the dialog shows the actionable "<host> is shutting down…" copy.
- **D10 — `vcs.cancelClone` answer:**
  - `{ cancelled: true }` when a live clone of that URL existed and did not finish successfully. It ended cancelled, or, if its cleanup failed, as a failure that names the leftover folder.
  - `{ cancelled: false }` when nothing of that URL was live, or when Git had already succeeded (a finished clone is never touched).
  - The answer comes only after the clone's outcome has been published, which happens after cleanup.
- **D11 — Retained outcomes (revised 2026-09-25, round 2; see Controller rulings):**
  - Retention is keyed by destination **and URL**: a re-attach for another URL never receives the outcome.
  - Expired outcomes are swept on every access (start, attach, cancel, finish).
  - No outcome is ever dropped before its five minutes; the spec's "stay in memory 5 minutes" binds.
  - Memory is bounded at admission instead: a new clone is refused with `capacity` when live clones plus retained outcomes reach 256 (`CLONE_RETAINED_OUTCOME_CAPACITY`). A start that replaces its own destination's retained outcome does not count that outcome. After outcomes expire, clones are admitted again.
- **D12 — Cancel beats a racing success in the dialog:** if Git finishes while a Cancel is pending, the dialog does not register the project (`shouldRegister`). It shows "Clone cancelled.", and the folder stays for the next **Clone** to add, as today's workspace docs describe.
- **D13 — Deterministic interleavings:** the runtime has `#[cfg(test)]` pause points:
  - after the transfer returned, before its result decides between success and cleanup (`AfterTransfer`);
  - before an attach reads the disk (`BeforeInspect`);
  - before reservation (`BeforeReserve`, Task 6).

  The ordering tests use them; nothing of this compiles into the server.
- **D14 — Attach revalidation:** an attach remembers the runtime's start generation before it reads the disk. If any clone started meanwhile, it discards the inspection and admits again, so it joins a clone that raced it instead of reporting that clone's half-written folder.

## File structure

**Create**

| File | Responsibility |
| --- | --- |
| `apps/server/src/production/clone_operations.rs` | `CloneRuntime`: destination-keyed start-or-join, attach, retention (Task 4); cancel (Task 5); shutdown drain (Task 6); its unit tests and test pauses. |
| `packages/client-runtime/src/state/vcsClone.ts` | `cloneWithReattach`, `cancelCloneOnNextSession`, `isCloneTransportLoss`, `VcsCloneStoppedError`, `VcsCloneProgress`. |
| `packages/client-runtime/src/state/vcsClone.test.ts` | Loop, capability gating, and cancel behaviour against scripted sessions. |

**Modify**

| File | Task | Change |
| --- | --- | --- |
| `packages/contracts/src/git.ts`, `git.test.ts` | 1, 5 | `attach`/`detach` and `GitCloneOperationError` (1); `GitCancelCloneInput`/`Result` (5). |
| `packages/contracts/src/rpc.ts`, `rpc.test.ts` | 1, 5 | `vcs.clone` union member (1); `WS_METHODS.vcsCancelClone`, `WsVcsCancelCloneRpc`, group entry, decode test (5). |
| `packages/contracts/src/environment.ts`, `environment.test.ts` | 1 | `vcsCloneReattach` capability. |
| `packages/shared/src/testSupport.ts` | 1 | `vcsCloneReattach: false` in the full-capabilities test fixture. |
| `packages/contracts/scripts/export-rust-rpc-fixtures.ts` + `.test.ts`, `packages/contracts/fixtures/rpc-wire/**` | 1, 5 | Counts and regenerated fixtures. |
| `apps/server/tests/rpc_wire.rs` | 1, 5 | Count pins. |
| `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs` | 5 | Method spec and scope, landed with the handler. |
| `apps/server/src/git/repository.rs` | 2, 3, 4 | Index check (2); clone API split with separate transfer and cleanup (3); `inspect_clone_destination` and registry removal (4). |
| `apps/server/src/git/mod.rs` | 4 | Re-export the `pub(crate)` clone API. |
| `apps/server/src/production/mod.rs` | 4 | `pub(crate) mod clone_operations;` |
| `apps/server/src/production/git_vcs.rs` | 4, 5, 6 | Runtime field and `vcs.clone`/`sourceControl.cloneRepository` wiring (4); `vcs.cancelClone` (5); `clone_operations()` accessor (6). |
| `apps/server/tests/production_git_vcs_rpc.rs` | 4, 5 | Reconnect, attach, busy, symlink (4); cancel and wire shapes (5). |
| `apps/server/src/production/runtime.rs`, `apps/server/tests/production_maintenance.rs` | 6 | Shutdown drain and its test. |
| `apps/server/src/lifecycle.rs`, `apps/server/src/production/control.rs` | 6 | Advertise `vcsCloneReattach` once the whole server contract exists. |
| `apps/server/tests/git_coverage.rs` | 3, 4 (read-only check) | Must stay green unchanged. |
| `packages/client-runtime/src/state/vcs.ts`, `vcsCommandScheduler.ts`, `vcs.test.ts` | 8 | `clone` via the loop, `cancelClone` on its own lane. |
| `apps/web/src/components/add-project/AddProjectDialog.logic.ts`, `.logic.test.ts` | 9 | Phase union and copy helpers. |
| `apps/web/src/components/add-project/AddProjectSteps.tsx`, `.test.tsx` | 9 | Labels for every phase, Cancel visibility, status line. |
| `apps/web/src/components/add-project/addProjectOperations.ts`, `.test.ts` | 10 | `onProgress`, `shouldRegister`, `cancelClone`. |
| `apps/web/src/components/add-project/useAddProjectWorkflow.ts`, `.test.tsx`, `.public.test.tsx` | 10 | Phase machine, cancel settlement, Cancel and close with the capability. |
| `docs/architecture/rpc-and-orchestration.md`, `overview.md`, `connection-runtime.md`, `docs/user/workspace-ui.md` | 11 | Living docs. |
| `docs/testing/cross-platform-validation.md`, `docs/testing/execution-report-template.md` | 12 | Runbook and report. |

## Working conventions

- Run every command from the repository root `/work/workspaces/orca/BibCode/main-3` unless a step says otherwise.
- Scratch root: `S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad`. Live-check root: `LIVE=$S/clone-live`. Logs, screenshots, and helper scripts go there, never into the repository.
- Focused TypeScript tests: `vp test run <file>`. Expected success tail: `Test Files  1 passed (1)`.
- Focused Rust tests:
  - unit, one filter: `cargo test -p bibcode-server --lib <module path>`;
  - unit, several filters: `cargo test -p bibcode-server --lib -- <filter> <filter>`. Cargo takes one positional filter, and libtest takes any number after `--`.
  - integration: `cargo test -p bibcode-server --test <name> -- <filter> …`.

  Expected: `test result: ok.`
- Before the first task, run `git status --short > $S/clone-reconnect-status-start.txt`.
- **Checkpoint (no commit)** closes every task. Record the printed tree hash in `$S/clone-reconnect-ledger.md`, one line per task: task, tree hash, focused test results, red evidence. Review packages use `git diff <previous tree> <this tree>`.

  ```bash
  IDX=$(mktemp) && GIT_INDEX_FILE=$IDX git read-tree HEAD && GIT_INDEX_FILE=$IDX git add -A && GIT_INDEX_FILE=$IDX git write-tree && rm -f $IDX
  ```

  This uses a temporary index; the real index is untouched.
- **Every task's gate** before its checkpoint:
  - Rust tasks run `cargo clippy -p bibcode-server --all-targets -- -D warnings` and the Rust test binaries they touch;
  - TypeScript tasks run `vp check` and the package typechecks they touch.

  The checkpoint must be green.

---

## Phase 1 — Wire contract

### Task 1: `vcs.clone` contract, capability, and wire fixtures

`vcs.cancelClone`'s wire contract lands in Task 5, together with its handler. Production startup rejects an `ACTIVE_RPC_METHODS` entry without a handler, and `rpc_wire` requires the Rust method list to equal the TypeScript group, so neither half can land alone.

**Files:**
- Modify: `packages/contracts/src/git.ts` (`GitCloneInput` at 169-173; the error after `GitCommandError` at 393-408)
- Modify: `packages/contracts/src/rpc.ts` (import block 59-89; `WsVcsCloneRpc` at 965-973)
- Modify: `packages/contracts/src/environment.ts` (`ExecutionEnvironmentCapabilities`, 30-62)
- Modify: `packages/shared/src/testSupport.ts` (`makeTestExecutionEnvironmentCapabilities`, 4-29)
- Test: `packages/contracts/src/git.test.ts`, `packages/contracts/src/environment.test.ts`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts` (count pins at 861-879), `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts` (101-114)
- Regenerate: `packages/contracts/fixtures/rpc-wire/**`
- Modify: `apps/server/tests/rpc_wire.rs` (85-95)

**Interfaces:**
- Produces (TS, used by Tasks 5 and 7-10):
  - `GitCloneInput` gains `attach?: boolean`, `detach?: boolean`.
  - `GitCloneOperationReason = "busy" | "capacity" | "shutting-down" | "not-in-progress" | "cancelled"`.
  - `class GitCloneOperationError { _tag: "GitCloneOperationError"; reason: GitCloneOperationReason; destination: string; message: string }`.
  - `WsVcsCloneRpc`'s error union gains `GitCloneOperationError`, last (D2).
  - `ExecutionEnvironmentCapabilities.vcsCloneReattach: boolean` (decodes to `false` when absent).
- The Rust server needs no change here: `CloneInput` ignores unknown fields until Task 4 reads them.

- [ ] **Step 1: Write the failing contract tests**

In `packages/contracts/src/git.test.ts`, add `GitCloneInput` and `GitCloneOperationError` to the existing `./git.ts` import. Next to the file's other module-level decoders (after `const decodeRunStackedActionResult = …`), add:

```ts
const decodeCloneInput = Schema.decodeUnknownSync(GitCloneInput);
const decodeCloneOperationError = Schema.decodeUnknownSync(GitCloneOperationError);
```

Append:

```ts
describe("clone re-attach contracts", () => {
  it("keeps attach and detach optional on the clone input", () => {
    expect(decodeCloneInput({ url: "https://example.test/demo.git", parentDir: "/code" })).toEqual({
      url: "https://example.test/demo.git",
      parentDir: "/code",
    });
    expect(
      decodeCloneInput({
        url: "https://example.test/demo.git",
        parentDir: "/code",
        directoryName: "demo",
        attach: true,
        detach: true,
      }),
    ).toMatchObject({ attach: true, detach: true, directoryName: "demo" });
  });

  it("decodes every clone operation reason and rejects unknown ones", () => {
    for (const reason of ["busy", "capacity", "shutting-down", "not-in-progress", "cancelled"]) {
      const error = decodeCloneOperationError({
        _tag: "GitCloneOperationError",
        reason,
        destination: "/code/demo",
        message: "Synthetic server message.",
      });
      expect(error.reason).toBe(reason);
      expect(error.message).toBe("Synthetic server message.");
    }
    expect(() =>
      decodeCloneOperationError({
        _tag: "GitCloneOperationError",
        reason: "unknown",
        destination: "/code/demo",
        message: "x",
      }),
    ).toThrow();
  });
});
```

Append inside the existing `describe("execution environment contracts", …)` in `packages/contracts/src/environment.test.ts`:

```ts
  it("defaults clone re-attach off for older servers and preserves advertised support", () => {
    expect(decodeTerminalCapabilities({}).vcsCloneReattach).toBe(false);
    expect(decodeTerminalCapabilities({ vcsCloneReattach: true }).vcsCloneReattach).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/contracts/src/git.test.ts packages/contracts/src/environment.test.ts`
Expected: FAIL. `GitCloneOperationError` is not exported, and `vcsCloneReattach` is `undefined`.

- [ ] **Step 3: Add the schemas**

In `packages/contracts/src/git.ts`, replace `GitCloneInput` (169-174) with:

```ts
export const GitCloneInput = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
  parentDir: TrimmedNonEmptyStringSchema,
  directoryName: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Join-only: never starts a clone. Sent only when the server advertises `vcsCloneReattach`. */
  attach: Schema.optional(Schema.Boolean),
  /** The caller leaving (socket close, Interrupt) does not stop a clone it started. */
  detach: Schema.optional(Schema.Boolean),
});
export type GitCloneInput = typeof GitCloneInput.Type;
```

After the `GitCommandError` class (ends at 408), add:

```ts
export const GitCloneOperationReason = Schema.Literals([
  "busy",
  "capacity",
  "shutting-down",
  "not-in-progress",
  "cancelled",
]);
export type GitCloneOperationReason = typeof GitCloneOperationReason.Type;

/**
 * The server's clone runtime refused or ended a clone. `destination` is the folder the clone
 * targets; a `busy` error never names the running clone's URL, which may embed credentials.
 */
export class GitCloneOperationError extends Schema.TaggedError<GitCloneOperationError>()(
  "GitCloneOperationError",
  {
    reason: GitCloneOperationReason,
    destination: Schema.String,
    message: Schema.String,
  },
) {}
```

In `packages/contracts/src/environment.ts`, add after `terminalSizeOwnership` (line 61):

```ts
  vcsCloneReattach: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
```

In `packages/shared/src/testSupport.ts`, add `vcsCloneReattach: false,` after `remoteUpdateControl: false,` (line 26). The function returns the full decoded `ExecutionEnvironmentCapabilities` type, which now requires the field.

In `packages/contracts/src/rpc.ts`, add `GitCloneOperationError` to the `./git.ts` import block (59-89). Replace `WsVcsCloneRpc` (965-973) with the version below. Per D2, the new member goes last.

```ts
export const WsVcsCloneRpc = Rpc.make(WS_METHODS.vcsClone, {
  payload: GitCloneInput,
  success: GitCloneResult,
  error: Schema.Union([
    GitCommandError,
    WorkspaceUnavailableError,
    WorkspaceIdentityError,
    EnvironmentRpcError,
    GitCloneOperationError,
  ]),
});
```

- [ ] **Step 4: Run the contract tests and the typechecks**

Run: `vp test run packages/contracts/src/git.test.ts packages/contracts/src/environment.test.ts`
Expected: PASS.

`vcsCloneReattach` is required on the decoded `Type` (`withDecodingDefault`). So any TypeScript literal that spells out the whole `ExecutionEnvironmentCapabilities` type breaks here, not in a later task.

Run: `rg -n "terminalSizeOwnership" --type ts -g '!node_modules' -g '!.repos'`
Expected: the only full literal is `packages/shared/src/testSupport.ts`, now fixed. (The other hits read the field or build partial objects.) If a new full literal appears in a file under "Never edit", stop and report it; do not work around it.

Run: `vp run --filter @bibcode/contracts typecheck && vp run --filter @bibcode/shared typecheck && vp run --filter @bibcode/client-runtime typecheck && vp run --filter @bibcode/web typecheck`
Expected: exit 0. (If a package name differs, use the `name` in that package's `package.json`.)

- [ ] **Step 5: Update the fixture pins**

Read the current values first: `node -e 'const m=require("./packages/contracts/fixtures/rpc-wire/manifest.json");console.log(m.methods.length,m.typedFailureFixtures.length,m.fixtures.length,Object.keys(m.schemaFingerprints).length)'`.

Expected today: `131 288 389 359`. If liveness Task 11 has landed, the third number is `390`. Add these deltas to whatever you read:

| Pin | Delta | Target (from 131/288/389/359) |
| --- | --- | --- |
| RPC methods | 0 | 131 |
| Typed failures | +1 (`vcs__clone-04`) | 289 |
| Fixtures | +1 | 390 (391 after liveness Task 11) |
| Schema fingerprints | +1 | 360 |
| Streaming methods | 0 | 20 |

Edit these literals:
- `packages/contracts/scripts/export-rust-rpc-fixtures.ts`: `typedFailureFixtures.length !== 288` and its message.
- `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`: `typedFailureFixtures).toHaveLength(288)`, `fixtures).toHaveLength(389)`, and `schemaFingerprints)).toHaveLength(359)`. After the fixtures-length line, add:

  ```ts
      expect(manifest.typedFailureFixtures).toContain("typed-failures/vcs__clone-04.json");
  ```

- `apps/server/tests/rpc_wire.rs`: `manifest.typed_failure_fixtures.len(), 288`.

Run: `vp test run packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
Expected: PASS. The test drives the exporter in memory against the updated group, so a FAIL naming a count means the arithmetic is wrong; recount.

- [ ] **Step 6: Regenerate the fixtures and run the contract gate**

Before the gate, review the regenerated JSON. Expect exactly one new `typed-failures/vcs__clone-04.json` (a `GitCloneOperationError`), the manifest's counts and fingerprint, and no change to `vcs__clone-00..03.json`. `check:contracts` compares against the index, so use a temporary fixture-only index. It leaves the real index and other agents' changes untouched:

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

Expected:
- status shows `?? packages/contracts/fixtures/rpc-wire/typed-failures/vcs__clone-04.json` and ` M …/manifest.json`;
- `vp run check:contracts` exits **0**. It includes `cargo test -p bibcode-server --test rpc_wire`, so the Rust pin is proven here.

Report `check:contracts: PASS (exit 0, temporary fixture index)`.

- [ ] **Step 7: Task gate**

Run: `vp check`
Expected: exit 0.

Run: `cargo test -p bibcode-server --test rpc_wire`
Expected: `test result: ok.`

- [ ] **Step 8: Checkpoint**

Record the checkpoint tree hash and results in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

## Phase 2 — Server

### Task 2: Reuse refuses a leftover without an index (ruling 6)

**Files:**
- Modify: `apps/server/src/git/repository.rs` (`reuse_existing_clone`, 4971-5068)
- Test: `apps/server/src/git/repository.rs` (`mod clone_tests`, starts at 11104)

**Interfaces:**
- Consumes: nothing new.
- Produces: `reuse_existing_clone` returns the existing "An incomplete clone exists at <path>. Remove it or choose another folder." error when `git rev-parse --git-path index` names a file that does not exist. The message is unchanged.

- [ ] **Step 1: Write the failing test**

Append inside `mod clone_tests` (after `reuse_rejects_a_placeholder_or_commitless_clone_and_keeps_it`):

```rust
    #[tokio::test]
    async fn reuse_refuses_an_index_less_leftover_but_reuses_an_empty_tree_clone() {
        let sandbox = TestSandbox::new("git-clone-index-less");
        let parent = clone_parent(&sandbox);
        let url = source_repository(&sandbox);
        let repository = GitRepository::default();

        // A crash during checkout: HEAD resolves, Git never wrote the index, and a stale lock
        // is left behind. A lock alone may belong to a running Git command, so it is not the test.
        let crashed = parent.join("crashed");
        git(&parent, &["clone", "-q", "--", &url, "crashed"]);
        fs::remove_file(crashed.join(".git/index")).expect("remove the index");
        fs::write(crashed.join(".git/index.lock"), b"").expect("stale index lock");
        let error = repository
            .clone_repository(&url, &parent, Some("crashed"), &CancellationToken::new())
            .await
            .expect_err("an index-less leftover is not adopted");
        assert_eq!(
            error.detail.as_ref(),
            format!(
                "An incomplete clone exists at {}. Remove it or choose another folder.",
                display_path(&crashed)
            )
        );
        assert!(crashed.join(".git").is_dir(), "the leftover is kept");

        // Git writes the index even for an empty tree, so such a clone is still reused.
        let empty_source = sandbox.path("empty-source");
        fs::create_dir(&empty_source).expect("empty source repository");
        git(&empty_source, &["init", "-q", "-b", "main"]);
        git(
            &empty_source,
            &["-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", "empty"],
        );
        let empty_url = file_url(&empty_source);
        git(&parent, &["clone", "-q", "--", &empty_url, "empty"]);
        assert!(parent.join("empty/.git/index").is_file());
        let reused = repository
            .clone_repository(&empty_url, &parent, Some("empty"), &CancellationToken::new())
            .await
            .expect("an empty-tree clone is reused");
        assert_eq!(reused, parent.join("empty"));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p bibcode-server --lib git::repository::clone_tests::reuse_refuses_an_index_less_leftover`
Expected: FAIL. `expect_err` panics because today's `HEAD^{commit}` check accepts the crashed leftover.

- [ ] **Step 3: Implement the index check**

In `reuse_existing_clone`, replace the block from `// An interrupted clone keeps its origin …` to the final `Ok(destination.to_path_buf())` with:

```rust
        let incomplete = || {
            simple_error(
                CLONE_OPERATION,
                destination,
                &format!(
                    "An incomplete clone exists at {}. Remove it or choose another folder.",
                    display_path(destination)
                ),
            )
        };
        // An interrupted clone keeps its origin but never checks out a commit: HEAD stays
        // Git's `refs/heads/.invalid` placeholder, or names a branch without commits.
        let head = self
            .execute_read(
                "GitVcsDriver.clone.inspectHead",
                destination,
                &strings(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
                true,
                cancellation,
            )
            .await?;
        if head.exit_code != 0 || head.stdout.trim().is_empty() {
            return Err(incomplete());
        }
        // A clone killed during checkout has a resolvable HEAD but no index: Git writes the
        // index once, after checkout, even for an empty tree. A stale `index.lock` may belong
        // to a running Git command, so only the missing index marks the clone incomplete.
        let index = self
            .execute_read(
                "GitVcsDriver.clone.inspectIndex",
                destination,
                &strings(&["rev-parse", "--git-path", "index"]),
                true,
                cancellation,
            )
            .await?;
        let index_path = PathBuf::from(index.stdout.trim());
        let index_path = if index_path.is_absolute() {
            index_path
        } else {
            destination.join(index_path)
        };
        let has_index = index.exit_code == 0
            && !index.stdout.trim().is_empty()
            && tokio::fs::metadata(&index_path)
                .await
                .is_ok_and(|metadata| metadata.is_file());
        if !has_index {
            return Err(incomplete());
        }
        Ok(destination.to_path_buf())
```

- [ ] **Step 4: Run the clone tests to verify they pass**

Run: `cargo test -p bibcode-server --lib git::repository::clone_tests`
Expected: `test result: ok.` All existing clone tests stay green, including `reuse_rejects_a_placeholder_or_commitless_clone_and_keeps_it` and `clone_destination_errors_name_the_folder_and_the_next_step`.

Run: `cargo test -p bibcode-server --test production_git_vcs_rpc -- clone_retry_reuses`
Expected: `test result: ok.` (2 tests). A finished clone still has its index.

Run: `cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: exit 0.

- [ ] **Step 5: Checkpoint**

Record the checkpoint tree hash and results in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 3: Split the Git clone API into reservation, transfer, and cleanup (the registry stays)

The runtime (Task 4) needs reservation, the transfer, and identity-checked cleanup as separate steps. With them separate, it can run Git in its own task and still own the cleanup when that task panics (pre-flight item 1). This task only extracts them. `clone_repository` keeps its behaviour and its registry until Task 4, and every new item has a caller in `clone_repository`, so the build stays warning-free.

**Files:**
- Modify: `apps/server/src/git/repository.rs` (`clone_repository` 4811-4894 and `clone_into_owned_destination` 4896-4935; new items beside them)
- Test: `apps/server/src/git/repository.rs` (`mod clone_tests`)
- Read-only check: `apps/server/tests/git_coverage.rs:888,967` must stay green unchanged.

**Interfaces:**
- Produces (used by Task 4):
  - `pub(crate) fn clone_destination_leaf(url: &str, directory_name: Option<&str>) -> String`;
  - `pub(crate) enum CloneReservation { Reserved(ReservedClone), Existing(PathBuf) }`;
  - `pub(crate) struct ReservedClone` (`Send + Sync`; the runtime shares it through `Arc`) with:
    - `pub(crate) async fn transfer(&self, cancellation: &CancellationToken) -> Result<PathBuf, GitCommandError>`: Git only, no cleanup;
    - `pub(crate) async fn remove_destination(&self) -> Result<(), io::Error>`: identity-checked removal of the folder this clone created; `Ok(())` when it is already gone;
    - `pub(crate) fn with_cleanup_failure(&self, error: GitCommandError, cleanup_error: &io::Error) -> GitCommandError`: appends today's "could not be removed … Remove it before trying again." sentence;
    - `pub(crate) async fn run(self, cancellation: &CancellationToken) -> Result<PathBuf, GitCommandError>`: transfer, then cleanup on failure (today's behaviour);
  - `GitRepository::reserve_clone_destination(&self, url: &str, parent_dir: &Path, leaf: &str, cancellation: &CancellationToken) -> Result<CloneReservation, GitCommandError>`.
- Task 4 adds `inspect_clone_destination` and the `crate::git` re-exports together with their first consumer.

- [ ] **Step 1: Write the failing tests**

Append inside `mod clone_tests`:

```rust
    #[test]
    fn the_destination_leaf_is_the_directory_name_or_the_url_s_last_segment() {
        use super::clone_destination_leaf;
        assert_eq!(clone_destination_leaf("https://example.test/org/demo.git/", None), "demo");
        assert_eq!(clone_destination_leaf("git@example.test:org/demo.git", None), "demo");
        assert_eq!(clone_destination_leaf(r"C:\repos\demo", None), "demo");
        assert_eq!(clone_destination_leaf("https://example.test/org/demo.git", Some("custom")), "custom");
    }

    #[tokio::test]
    async fn reserving_a_finished_clone_returns_it_without_a_transfer() {
        let sandbox = TestSandbox::new("git-clone-reserve-existing");
        let parent = clone_parent(&sandbox);
        let url = source_repository(&sandbox);
        git(&parent, &["clone", "-q", "--", &url, "finished"]);
        let runner = Arc::new(FixtureGitRunner::new(&[]));
        let repository = GitRepository::with_runner_for_test(runner.clone());

        let reservation = repository
            .reserve_clone_destination(&url, &parent, "finished", &CancellationToken::new())
            .await
            .expect("a finished clone is reused");
        let super::CloneReservation::Existing(path) = reservation else {
            panic!("a finished clone must not be reserved again");
        };
        assert_eq!(path, parent.join("finished"));
        assert!(
            runner
                .requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .all(|request| request.operation != super::CLONE_OPERATION),
            "reuse runs no transfer"
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bibcode-server --lib git::repository::clone_tests`
Expected: FAIL to compile. `clone_destination_leaf`, `reserve_clone_destination`, and `CloneReservation` do not exist.

- [ ] **Step 3: Implement the split**

In `apps/server/src/git/repository.rs`, add at module level, next to `remove_owned_clone_destination`:

```rust
/// The folder a clone creates under its parent: `directory_name` when given, otherwise the
/// URL's last path segment without a trailing `.git`.
pub(crate) fn clone_destination_leaf(url: &str, directory_name: Option<&str>) -> String {
    directory_name.map_or_else(
        || {
            url.trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\', ':'])
                .next()
                .unwrap_or("repository")
                .trim_end_matches(".git")
                .to_owned()
        },
        str::to_owned,
    )
}

/// What reserving a clone destination found.
pub(crate) enum CloneReservation {
    /// The destination did not exist. This clone created it and owns its cleanup.
    Reserved(ReservedClone),
    /// A finished clone of the same URL is already there.
    Existing(PathBuf),
}

/// A destination one clone created. The transfer and the cleanup are separate steps, so an
/// owner that runs the transfer in another task keeps the cleanup even if that task panics.
pub(crate) struct ReservedClone {
    repository: GitRepository,
    url: String,
    parent_dir: PathBuf,
    leaf: String,
    destination: OwnedWorktreePath,
}

impl ReservedClone {
    /// Runs `git clone` into the reserved folder and nothing else. When it fails, the runner
    /// has already stopped and reaped Git's process group; removing the folder is the caller's.
    pub(crate) async fn transfer(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, GitCommandError> {
        self.repository
            .run(
                CLONE_OPERATION,
                &self.parent_dir,
                &[
                    "clone".into(),
                    "--".into(),
                    self.url.clone(),
                    self.leaf.clone(),
                ],
                cancellation,
            )
            .await?;
        Ok(self.destination.path().to_path_buf())
    }

    /// Removes the folder this clone created, after proving it is still that folder.
    pub(crate) async fn remove_destination(&self) -> Result<(), io::Error> {
        remove_owned_clone_destination(&self.destination).await
    }

    /// `error` with the failed removal appended, so the user learns which folder to remove.
    pub(crate) fn with_cleanup_failure(
        &self,
        mut error: GitCommandError,
        cleanup_error: &io::Error,
    ) -> GitCommandError {
        error.detail = format!(
            "{}\nThe incomplete clone at {} could not be removed ({cleanup_error}). Remove it before trying again.",
            error.detail,
            display_path(self.destination.path()),
        )
        .into();
        error
    }

    /// The transfer, then, on any failure, the removal of the folder this clone created.
    pub(crate) async fn run(self, cancellation: &CancellationToken) -> Result<PathBuf, GitCommandError> {
        match self.transfer(cancellation).await {
            Ok(path) => Ok(path),
            Err(error) => match self.remove_destination().await {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(self.with_cleanup_failure(error, &cleanup_error)),
            },
        }
    }
}
```

`GitRepository::run` takes `args: &[String]` (`repository.rs:1502-1508`). The argument list stays byte-identical to today's `clone -- <url> <leaf>`.

Inside `impl GitRepository`, add next to `clone_repository`:

```rust
    /// Creates the destination atomically, which records that it did not exist before. An
    /// existing destination is never cloned into or deleted: a finished clone of the same URL
    /// is returned as [`CloneReservation::Existing`], anything else is an actionable error.
    pub(crate) async fn reserve_clone_destination(
        &self,
        url: &str,
        parent_dir: &Path,
        leaf: &str,
        cancellation: &CancellationToken,
    ) -> Result<CloneReservation, GitCommandError> {
        let destination = parent_dir.join(leaf);
        match OwnedWorktreePath::reserve(destination.clone()) {
            Ok(owned) => Ok(CloneReservation::Reserved(ReservedClone {
                repository: self.for_network_transfer(),
                url: url.to_owned(),
                parent_dir: parent_dir.to_path_buf(),
                leaf: leaf.to_owned(),
                destination: owned,
            })),
            Err(error) if error.is_destination_collision() => self
                .reuse_existing_destination(url, parent_dir, &destination, cancellation)
                .await
                .map(CloneReservation::Existing),
            Err(error) => Err(simple_error(
                CLONE_OPERATION,
                parent_dir,
                &format!(
                    "Could not create {} ({}). Check that the parent folder exists and is writable, or choose another folder.",
                    display_path(&destination),
                    error.source
                ),
            )),
        }
    }
```

Delete `clone_into_owned_destination` (4896-4935); `ReservedClone::run` replaces it. Replace the body of `clone_repository` with the following. Only the steps move; the registry and its wait stay until Task 4.

```rust
        let leaf = clone_destination_leaf(url, directory_name);
        let destination = parent_dir.join(&leaf);
        // A retry right after Cancel waits here until the cancelled clone of the same
        // destination has stopped Git and removed its folder, then reserves normally.
        let Some(destination_lease) = CloneDestinationRegistry::global()
            .acquire(&destination, cancellation)
            .await
        else {
            return Err(simple_error(
                CLONE_OPERATION,
                parent_dir,
                "The clone was cancelled before it started.",
            ));
        };
        let reserved = match self
            .reserve_clone_destination(url, parent_dir, &leaf, cancellation)
            .await?
        {
            CloneReservation::Existing(path) => return Ok(path),
            CloneReservation::Reserved(reserved) => reserved,
        };
        // The transfer and its cleanup run as one owned task. An RPC interrupt drops this
        // future; the drop guard then cancels the transfer, and the task still stops Git and
        // removes the destination it created before it finishes.
        let transfer_cancellation = cancellation.child_token();
        let _cancel_transfer_on_drop = transfer_cancellation.clone().drop_guard();
        let task = tokio::spawn(async move {
            // Released only after the transfer and its cleanup have finished.
            let _destination_lease = destination_lease;
            reserved.run(&transfer_cancellation).await
        });
        match task.await {
            Ok(result) => result,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(error) => Err(simple_error(
                CLONE_OPERATION,
                parent_dir,
                &format!("The clone stopped before it finished: {error}"),
            )),
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bibcode-server --lib git::repository::clone_tests`
Expected: `test result: ok.` The two new tests pass, and every existing clone test stays green: registry, retry-after-cancel, slow, stalled, cancelled, dropped, failed, and timed-out cleanup.

Run: `cargo test -p bibcode-server --test git_coverage`
Expected: `test result: ok.`

Run: `cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: exit 0. Every new item already has a caller: `clone_repository` uses the leaf helper, the reservation, and `ReservedClone::run`, and `run` uses `transfer`, `remove_destination`, and `with_cleanup_failure`.

- [ ] **Step 5: Checkpoint**

Record the checkpoint tree hash and results in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 4: The clone runtime serves `vcs.clone` and `sourceControl.cloneRepository`

This task lands the runtime together with its first consumers, so the build stays warning-free. It covers start-or-join, `attach`/`detach`, retention, panic-safe cleanup, and attach revalidation. It also removes the static registry. `cancel` arrives in Task 5 with `vcs.cancelClone`. `close_and_drain` arrives in Task 6 with the shutdown wiring. The capability is advertised in Task 6, once the whole server contract exists; until then no client sends the new fields.

**Files:**
- Create: `apps/server/src/production/clone_operations.rs`
- Modify: `apps/server/src/production/mod.rs` (add `pub(crate) mod clone_operations;` after `pub mod agent_activity;`)
- Modify: `apps/server/src/git/repository.rs`:
  - add `inspect_clone_destination` beside `reserve_clone_destination`;
  - delete `CloneDestinationRegistry` and `CloneDestinationLease` (6886-6969);
  - simplify `clone_repository`;
  - in `mod clone_tests`, delete the three registry tests and `HeldCancellationRunner` (11138-11182).
- Modify: `apps/server/src/git/mod.rs` (re-exports after line 35)
- Modify: `apps/server/src/production/git_vcs.rs`:
  - imports 19-39;
  - the `GitVcsRpcServices` struct 199-217 and `with_repository_dependencies` 336-382;
  - the `vcs.clone` arm 856-874 and the `sourceControl.cloneRepository` arm 909-913;
  - `clone_source_repository` 1600-1638;
  - `CloneInput` 2001-2006.
- Test: `apps/server/src/production/clone_operations.rs` (`mod tests`), `apps/server/src/git/repository.rs` (`mod clone_tests`), `apps/server/tests/production_git_vcs_rpc.rs` (harness `impl GitServerHarness` 120-150; new cases)
- Read-only check: `apps/server/tests/git_coverage.rs` stays green unchanged.

**Interfaces:**
- Consumes (Task 3): `clone_destination_leaf`, `CloneReservation`, `ReservedClone::{transfer, remove_destination, with_cleanup_failure}`, `GitRepository::reserve_clone_destination`. It also uses `crate::git::{host_path_platform, normalize_worktree_path_key, GitCommandError}` and `crate::maintenance::RpcPermit`.
- Produces (used by Tasks 5 and 6):

```rust
pub(crate) const CLONE_OPERATION_CAPACITY: usize = 16;
pub(crate) const CLONE_OUTCOME_RETENTION: Duration = Duration::from_secs(5 * 60);
pub(crate) const CLONE_RETAINED_OUTCOME_CAPACITY: usize = 256;

#[derive(Clone, Debug)]
pub(crate) struct CloneRequest {
    pub(crate) url: String,
    pub(crate) parent_dir: PathBuf, // canonical; the handler resolves it (ruling 10)
    pub(crate) leaf: String,        // clone_destination_leaf(url, directoryName)
    pub(crate) attach: bool,
    pub(crate) detach: bool,
}

#[derive(Clone)]
pub(crate) struct CloneRuntime { /* Arc inner */ }
impl CloneRuntime {
    pub(crate) fn new(repository: Arc<GitRepository>) -> Self;
    /// Leaving is dropping the future; `cancellation` bounds only an attach's disk check.
    pub(crate) async fn start_or_join(&self, request: CloneRequest, admission: Option<RpcPermit>, cancellation: &CancellationToken) -> Result<PathBuf, Value>;
}
```

  - The `Err(Value)` is a serialized `GitCommandError` (a real failure, including a failed cleanup) or `{"_tag":"GitCloneOperationError","reason","destination","message"}`. Both are members of `vcs.clone`'s declared union.
  - The reason enum and the error builder stay private to the module.
  - The method is named `start_or_join`: an inherent `clone(…)` would shadow `Clone::clone`.
- `GitRepository::inspect_clone_destination(&self, url: &str, parent_dir: &Path, leaf: &str, cancellation: &CancellationToken) -> Result<Option<PathBuf>, GitCommandError>`. `Ok(None)` means nothing exists at the destination; nothing is reserved or created.
- `GitVcsRpcServices` gains the `clone_operations: CloneRuntime` field. `CloneInput` gains `#[serde(default)] attach` and `detach`.

**State model** (one entry per destination key; `closed`/`shutting-down` arrive in Task 6):

| Situation | New request (`attach: false`) | `attach: true` |
| --- | --- | --- |
| Live, same URL, root not cancelled | Join; share the outcome | Join |
| Live, same URL, root cancelled (cleaning up) | Wait for `Finished`, then admit again (start) | Join (receives the outcome) |
| Live, other URL | `busy` at once, without that URL | `busy` at once |
| Retained outcome under five minutes old, **same URL** | Drop it; start | Return it |
| Retained outcome of another URL | Drop it; start | Treat as nothing |
| Nothing (or expired) | Start, unless 16 clones are live or live clones plus retained outcomes reach 256 (`capacity`) | Remember the start generation, inspect the disk, and **admit again if any clone started meanwhile**. Otherwise: the finished clone's path, the incomplete-clone error, or `not-in-progress` |

- **Leaving** is dropping the `start_or_join` future. The RPC layer drops it on Interrupt, socket teardown, or a dropped handler, and answers the caller with an `Interrupt` exit. Only a starter with `detach: false` holds a drop guard on the root token, disarmed once it has the outcome. Joiners and detached starters hold none.
- **The clone's task:**
  - It checks the root before reserving, so a clone cancelled before reservation creates no folder.
  - It reserves, then runs `ReservedClone::transfer` in its **own** Tokio task.
  - It then removes the folder on any failure or panic, and publishes the outcome only after that removal has settled. A failed removal is a `Failed` outcome that names the leftover, even when the clone was cancelled.
  - It frees the capacity slot (`live -= 1`) in the same step as publishing.
  - It holds the starter's `RpcPermit` until after publishing.
- **Retained outcomes** are keyed by URL too, and expired ones are swept on every access. None is ever dropped before its five minutes (spec: "stay in memory 5 minutes"). The bound is enforced at admission instead: a new clone is refused with `capacity` when live clones plus retained outcomes reach 256. A start that replaces its own destination's retained outcome does not count that outcome.
- A `FinishGuard` publishes a failure if the clone's own task panics outside the transfer, so waiters never hang. Only reservation, cleanup, and publishing (the runtime's own code) run in that task. Such a panic does **not** re-run the cleanup: only a panicking transfer (Git and its runner) gets its folder removed before the outcome. A leftover from a panic in the runtime's own code is refused later by the reuse check. That is the scope pre-flight item 1 asked for, a residual stated here so it is not read as universal.
- The attach revalidation compares the runtime-wide start counter, not a per-destination one. So a concurrent start into **any** destination costs one extra inspect-and-admit round. That is safe (the re-admission joins or inspects again) and bounded in practice by the 16-slot cap, but it is not per-destination.

- [ ] **Step 1: Write the failing repository test**

Append inside `mod clone_tests` in `apps/server/src/git/repository.rs`:

```rust
    #[tokio::test]
    async fn inspecting_a_destination_reports_nothing_a_finished_clone_or_an_incomplete_one() {
        let sandbox = TestSandbox::new("git-clone-inspect");
        let parent = clone_parent(&sandbox);
        let url = source_repository(&sandbox);
        let repository = GitRepository::default();
        let token = CancellationToken::new();

        assert_eq!(
            repository
                .inspect_clone_destination(&url, &parent, "absent", &token)
                .await
                .expect("an absent destination is not an error"),
            None
        );
        assert!(!parent.join("absent").exists(), "inspecting never creates the folder");

        git(&parent, &["clone", "-q", "--", &url, "finished"]);
        assert_eq!(
            repository
                .inspect_clone_destination(&url, &parent, "finished", &token)
                .await
                .expect("a finished clone is found"),
            Some(parent.join("finished"))
        );

        let incomplete = parent.join("incomplete");
        fs::create_dir(&incomplete).expect("incomplete clone");
        git(&incomplete, &["init", "-q", "-b", "main"]);
        git(&incomplete, &["config", "remote.origin.url", &url]);
        let error = repository
            .inspect_clone_destination(&url, &parent, "incomplete", &token)
            .await
            .expect_err("an incomplete clone is reported");
        assert!(error.detail.contains("An incomplete clone exists at"));
        assert!(incomplete.join(".git").is_dir(), "inspecting keeps the folder");
    }
```

- [ ] **Step 2: Write the failing runtime tests**

Create `apps/server/src/production/clone_operations.rs` containing only this test module for now. Add `pub(crate) mod clone_operations;` to `apps/server/src/production/mod.rs`.

```rust
#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        process::Command,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use serde_json::Value;
    use tokio::{
        sync::{Notify, Semaphore},
        time::{Instant, timeout},
    };
    use tokio_util::sync::CancellationToken;

    use super::{
        CloneRequest, CloneRuntime,
        test_pauses::{PausePoint, TestPauses},
    };
    use crate::{
        git::{
            BoxGitProcessFuture, GitProcessRunner, GitRepository, ProcessError, ProcessRequest,
            ProcessRunner,
        },
        maintenance::{RpcAdmissionGate, RpcMutability},
    };

    const DEADLINE: Duration = Duration::from_secs(20);

    /// Stands in for `git clone` around the real command. The transfer waits until the test
    /// releases it or the clone is cancelled. Flags inject a held cancellation, a replaced
    /// folder, or a panic. Every other Git command runs unchanged.
    struct HeldCloneRunner {
        started: Notify,
        release: Semaphore,
        clones: AtomicUsize,
        /// On cancellation, report it only after `release_cancelled`: Git has exited, and its
        /// folder is still there.
        hold_after_cancel: AtomicBool,
        cancel_held: Notify,
        release_cancelled: Semaphore,
        /// On cancellation, put a different folder at the destination, so the identity-checked
        /// cleanup must refuse to remove it.
        replace_on_cancel: AtomicBool,
        /// Panic inside the transfer.
        panic_on_clone: AtomicBool,
    }

    impl HeldCloneRunner {
        fn new() -> Self {
            Self {
                started: Notify::new(),
                release: Semaphore::new(0),
                clones: AtomicUsize::new(0),
                hold_after_cancel: AtomicBool::new(false),
                cancel_held: Notify::new(),
                release_cancelled: Semaphore::new(0),
                replace_on_cancel: AtomicBool::new(false),
                panic_on_clone: AtomicBool::new(false),
            }
        }
    }

    impl GitProcessRunner for HeldCloneRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            Box::pin(async move {
                if !request.args.iter().any(|argument| argument == "clone") {
                    return ProcessRunner.run(request, cancellation).await;
                }
                self.clones.fetch_add(1, Ordering::SeqCst);
                assert!(
                    !self.panic_on_clone.load(Ordering::SeqCst),
                    "injected transfer panic"
                );
                self.started.notify_one();
                tokio::select! {
                    () = cancellation.cancelled() => {
                        let destination = request
                            .cwd
                            .join(request.args.last().expect("the clone's destination argument"));
                        if self.replace_on_cancel.load(Ordering::SeqCst) {
                            std::fs::rename(&destination, destination.with_extension("moved"))
                                .expect("move the clone's folder away");
                            std::fs::create_dir(&destination)
                                .expect("put a different folder in its place");
                        }
                        if self.hold_after_cancel.load(Ordering::SeqCst) {
                            self.cancel_held.notify_one();
                            self.release_cancelled
                                .acquire()
                                .await
                                .expect("the release semaphore stays open")
                                .forget();
                        }
                        return Err(ProcessError::Cancelled { operation: request.operation });
                    }
                    permit = self.release.acquire() => {
                        permit.expect("the release semaphore stays open").forget();
                    }
                }
                ProcessRunner.run(request, cancellation).await
            })
        }
    }

    struct Limits {
        capacity: usize,
        retention: Duration,
        retained: usize,
        pauses: TestPauses,
    }

    impl Default for Limits {
        fn default() -> Self {
            Self {
                capacity: super::CLONE_OPERATION_CAPACITY,
                retention: super::CLONE_OUTCOME_RETENTION,
                retained: super::CLONE_RETAINED_OUTCOME_CAPACITY,
                pauses: TestPauses::default(),
            }
        }
    }

    struct Harness {
        _root: tempfile::TempDir,
        base: PathBuf,
        parent: PathBuf,
        url: String,
        other_url: String,
        runner: Arc<HeldCloneRunner>,
        runtime: CloneRuntime,
    }

    impl Harness {
        /// A `file://` URL with no repository behind it: Git fails at once when released.
        fn missing_url(&self) -> String {
            file_url(&self.base.join("missing.git"))
        }
    }

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Clone Runtime Test")
            .env("GIT_AUTHOR_EMAIL", "clone-runtime@example.test")
            .env("GIT_COMMITTER_NAME", "Clone Runtime Test")
            .env("GIT_COMMITTER_EMAIL", "clone-runtime@example.test")
            .status()
            .expect("git starts");
        assert!(status.success(), "git {args:?} failed");
    }

    fn file_url(path: &Path) -> String {
        let normalized = path.to_string_lossy().replace('\\', "/");
        format!("file:///{}", normalized.trim_start_matches('/'))
    }

    fn source_repository(root: &Path, name: &str) -> String {
        let source = root.join(name);
        std::fs::create_dir(&source).expect("source repository");
        git(&source, &["init", "-q", "-b", "main"]);
        std::fs::write(source.join("tracked.txt"), "tracked\n").expect("tracked file");
        git(&source, &["add", "tracked.txt"]);
        git(&source, &["-c", "commit.gpgSign=false", "commit", "-q", "-m", "initial"]);
        file_url(&source)
    }

    fn harness(limits: Limits) -> Harness {
        let root = tempfile::tempdir().expect("temporary root");
        let base = std::fs::canonicalize(root.path()).expect("canonical root");
        let parent = base.join("clones");
        std::fs::create_dir(&parent).expect("clone parent");
        let url = source_repository(&base, "source");
        let other_url = source_repository(&base, "other-source");
        let runner = Arc::new(HeldCloneRunner::new());
        let repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
        Harness {
            _root: root,
            base,
            parent,
            url,
            other_url,
            runner,
            runtime: CloneRuntime::for_test(
                repository,
                limits.capacity,
                limits.retention,
                limits.retained,
                limits.pauses,
            ),
        }
    }

    fn standard() -> Harness {
        harness(Limits::default())
    }

    fn request(harness: &Harness, url: &str, leaf: &str) -> CloneRequest {
        CloneRequest {
            url: url.to_owned(),
            parent_dir: harness.parent.clone(),
            leaf: leaf.to_owned(),
            attach: false,
            detach: true,
        }
    }

    fn attach(mut request: CloneRequest) -> CloneRequest {
        request.attach = true;
        request
    }

    fn undetached(mut request: CloneRequest) -> CloneRequest {
        request.detach = false;
        request
    }

    fn spawn_clone(
        harness: &Harness,
        request: CloneRequest,
    ) -> tokio::task::JoinHandle<Result<PathBuf, Value>> {
        let runtime = harness.runtime.clone();
        tokio::spawn(async move {
            runtime
                .start_or_join(request, None, &CancellationToken::new())
                .await
        })
    }

    /// What an RPC interrupt does to a handler: drop its future. Awaiting the aborted task
    /// waits until the future, and any drop guard in it, is gone.
    async fn leave(handle: tokio::task::JoinHandle<Result<PathBuf, Value>>) {
        handle.abort();
        let _ = handle.await;
    }

    async fn transfer_started(harness: &Harness) {
        timeout(DEADLINE, harness.runner.started.notified())
            .await
            .expect("the clone reached its transfer");
    }

    async fn finished(
        handle: tokio::task::JoinHandle<Result<PathBuf, Value>>,
    ) -> Result<PathBuf, Value> {
        timeout(DEADLINE, handle)
            .await
            .expect("the clone call finished")
            .expect("the clone call did not panic")
    }

    async fn call(harness: &Harness, request: CloneRequest) -> Result<PathBuf, Value> {
        timeout(
            DEADLINE,
            harness
                .runtime
                .start_or_join(request, None, &CancellationToken::new()),
        )
        .await
        .expect("the call answered")
    }

    fn reason(error: &Value) -> &str {
        assert_eq!(error["_tag"], "GitCloneOperationError", "unexpected error {error}");
        error["reason"].as_str().expect("reason")
    }

    async fn wait_until(mut condition: impl FnMut() -> bool, context: &str) {
        let deadline = Instant::now() + DEADLINE;
        while !condition() {
            assert!(Instant::now() < deadline, "timed out: {context}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_detached_starter_leaves_the_clone_running_and_an_attach_joins_it() {
        let harness = standard();
        let destination = harness.parent.join("detached");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "detached"));
        transfer_started(&harness).await;
        leave(starter).await;
        assert!(destination.is_dir(), "the detached clone keeps running and keeps its folder");
        assert_eq!(harness.runtime.waiters(&destination), 0, "nobody waits once the starter left");

        let joiner = spawn_clone(&harness, attach(request(&harness, &harness.url, "detached")));
        // Prove the join before the transfer may finish: the attach waits on the live clone.
        wait_until(|| harness.runtime.waiters(&destination) == 1, "the attach joined").await;
        harness.runner.release.add_permits(1);
        assert_eq!(finished(joiner).await.expect("the joiner shares the outcome"), destination);
        assert_eq!(harness.runner.clones.load(Ordering::SeqCst), 1, "one transfer only");
        assert_eq!(harness.runtime.live(), 0);
        assert_eq!(harness.runtime.retained_len(), 0, "a success leaves no entry behind");
    }

    #[tokio::test]
    async fn a_starter_without_detach_cancels_on_leaving_and_a_retry_waits_for_its_cleanup() {
        let harness = standard();
        harness.runner.hold_after_cancel.store(true, Ordering::SeqCst);
        let destination = harness.parent.join("retried");
        let first = spawn_clone(&harness, undetached(request(&harness, &harness.url, "retried")));
        transfer_started(&harness).await;
        leave(first).await;
        timeout(DEADLINE, harness.runner.cancel_held.notified())
            .await
            .expect("leaving stopped Git");
        assert!(destination.is_dir(), "the cancelled clone's folder is still there");
        std::fs::write(destination.join("cancelled-clone-leftover"), "leftover\n")
            .expect("leftover marker");

        let retry = spawn_clone(&harness, undetached(request(&harness, &harness.url, "retried")));
        // A second retry that gives up while waiting disturbs nobody.
        let impatient =
            spawn_clone(&harness, undetached(request(&harness, &harness.url, "retried")));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!retry.is_finished(), "the retry waits for the cancelled clone's cleanup");
        assert_eq!(harness.runner.clones.load(Ordering::SeqCst), 1);
        leave(impatient).await;

        harness.runner.release_cancelled.add_permits(1);
        transfer_started(&harness).await;
        assert_eq!(harness.runner.clones.load(Ordering::SeqCst), 2, "the retry ran its own transfer");
        assert!(destination.is_dir(), "the retry reserved the folder again");
        assert!(
            !destination.join("cancelled-clone-leftover").exists(),
            "the retry reserved only after the cleanup removed the old folder"
        );
        harness.runner.release.add_permits(1);
        assert_eq!(finished(retry).await.expect("the retry succeeds"), destination);
    }

    #[tokio::test]
    async fn joiners_never_cancel_by_leaving() {
        let harness = standard();
        let destination = harness.parent.join("joined");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "joined"));
        transfer_started(&harness).await;
        let joiner = spawn_clone(&harness, undetached(request(&harness, &harness.url, "joined")));
        wait_until(|| harness.runtime.waiters(&destination) == 2, "the joiner joined").await;
        leave(joiner).await;
        harness.runner.release.add_permits(1);
        assert_eq!(
            finished(starter).await.expect("a leaving joiner never cancels the clone"),
            destination
        );
    }

    #[tokio::test]
    async fn another_url_is_busy_at_once_and_the_error_never_names_the_running_url() {
        let harness = standard();
        let destination = harness.parent.join("busy");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "busy"));
        transfer_started(&harness).await;
        for other in [
            request(&harness, &harness.other_url, "busy"),
            attach(request(&harness, &harness.other_url, "busy")),
        ] {
            let error = timeout(
                Duration::from_secs(1),
                harness
                    .runtime
                    .start_or_join(other, None, &CancellationToken::new()),
            )
            .await
            .expect("busy is answered at once")
            .expect_err("another URL is refused");
            assert_eq!(reason(&error), "busy");
            assert_eq!(error["destination"], destination.to_string_lossy().into_owned());
            assert!(
                !error.to_string().contains(&harness.url),
                "busy never names the running clone's URL, which may embed credentials"
            );
        }
        harness.runner.release.add_permits(1);
        assert_eq!(finished(starter).await.expect("the running clone is untouched"), destination);
    }

    #[tokio::test]
    async fn admission_is_bounded_without_waiting() {
        let harness = harness(Limits {
            capacity: 1,
            ..Limits::default()
        });
        let first = spawn_clone(&harness, request(&harness, &harness.url, "one"));
        transfer_started(&harness).await;
        let refused = timeout(
            Duration::from_secs(1),
            harness.runtime.start_or_join(
                request(&harness, &harness.url, "two"),
                None,
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("capacity is answered at once")
        .expect_err("a full runtime refuses");
        assert_eq!(reason(&refused), "capacity");
        assert!(!harness.parent.join("two").exists(), "a refused clone reserves nothing");

        harness.runner.release.add_permits(1);
        finished(first).await.expect("the first clone finishes");
        let second = spawn_clone(&harness, request(&harness, &harness.url, "two"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        finished(second).await.expect("a freed slot admits the next clone");
    }

    #[tokio::test]
    async fn attach_reports_nothing_a_finished_clone_or_the_same_url_s_retained_failure() {
        let harness = standard();
        let nothing = call(&harness, attach(request(&harness, &harness.url, "nothing")))
            .await
            .expect_err("nothing is in progress");
        assert_eq!(reason(&nothing), "not-in-progress");
        assert!(!harness.parent.join("nothing").exists(), "attach never reserves");

        // An ordinary failure is retained for its URL.
        let missing = harness.missing_url();
        let failing = spawn_clone(&harness, request(&harness, &missing, "failed"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        let failure = finished(failing).await.expect_err("a missing remote fails");
        assert_eq!(failure["_tag"], "GitCommandError");
        assert!(!harness.parent.join("failed").exists(), "published after its cleanup");
        let retained = call(&harness, attach(request(&harness, &missing, "failed")))
            .await
            .expect_err("the same URL learns the real reason");
        assert_eq!(retained, failure);
        // Another URL never receives it.
        let other = call(&harness, attach(request(&harness, &harness.url, "failed")))
            .await
            .expect_err("another URL sees no clone");
        assert_eq!(reason(&other), "not-in-progress");

        // A finished clone is found on disk.
        let done = spawn_clone(&harness, request(&harness, &harness.url, "done"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        let path = finished(done).await.expect("the clone succeeds");
        assert_eq!(
            call(&harness, attach(request(&harness, &harness.url, "done")))
                .await
                .expect("a finished clone is found on disk"),
            path
        );
    }

    #[tokio::test]
    async fn outcomes_are_never_dropped_early_and_a_full_runtime_refuses_until_they_expire() {
        assert_eq!(
            super::CLONE_OUTCOME_RETENTION,
            Duration::from_secs(5 * 60),
            "each outcome keeps five minutes in production"
        );
        let harness = harness(Limits {
            retention: Duration::from_secs(3),
            retained: 2,
            ..Limits::default()
        });
        let missing = harness.missing_url();
        for leaf in ["first", "second"] {
            let failing = spawn_clone(&harness, request(&harness, &missing, leaf));
            transfer_started(&harness).await;
            harness.runner.release.add_permits(1);
            finished(failing).await.expect_err("a missing remote fails");
        }

        // At the bound, a clone into another folder is refused at once, and nothing is dropped.
        let refused = call(&harness, request(&harness, &harness.url, "third"))
            .await
            .expect_err("the runtime is full");
        assert_eq!(reason(&refused), "capacity");
        assert!(!harness.parent.join("third").exists(), "a refused clone reserves nothing");
        for leaf in ["first", "second"] {
            let kept = call(&harness, attach(request(&harness, &missing, leaf)))
                .await
                .expect_err("kept");
            assert_eq!(kept["_tag"], "GitCommandError", "an outcome keeps its full retention");
        }

        // A start into a folder whose own outcome is retained replaces that outcome, so it is
        // admitted; failing again keeps the runtime at its bound.
        let replacing = spawn_clone(&harness, request(&harness, &missing, "first"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        finished(replacing).await.expect_err("the replacement fails again");
        let still_full = call(&harness, request(&harness, &harness.url, "third"))
            .await
            .expect_err("still full");
        assert_eq!(reason(&still_full), "capacity");

        // Once the outcomes have expired, the next access sweeps them and a clone is admitted.
        tokio::time::sleep(Duration::from_millis(3500)).await;
        let admitted = spawn_clone(&harness, request(&harness, &harness.url, "third"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        finished(admitted).await.expect("admitted again after the outcomes expired");
        assert_eq!(harness.runtime.retained_len(), 0, "the admission swept every expired outcome");
    }

    #[tokio::test]
    async fn a_new_start_replays_no_retained_outcome() {
        let harness = standard();
        let destination = harness.parent.join("restarted");
        let first = spawn_clone(&harness, undetached(request(&harness, &harness.url, "restarted")));
        transfer_started(&harness).await;
        leave(first).await;
        wait_until(|| harness.runtime.retained_len() == 1, "the cancelled outcome is retained").await;

        let restart = spawn_clone(&harness, request(&harness, &harness.url, "restarted"));
        transfer_started(&harness).await;
        assert_eq!(harness.runner.clones.load(Ordering::SeqCst), 2, "the new start ran its own transfer");
        harness.runner.release.add_permits(1);
        assert_eq!(finished(restart).await.expect("the restart succeeds"), destination);
    }

    #[tokio::test]
    async fn a_cancelled_clone_whose_folder_cannot_be_removed_reports_the_leftover() {
        let harness = standard();
        harness.runner.replace_on_cancel.store(true, Ordering::SeqCst);
        let destination = harness.parent.join("leftover");
        let starter = spawn_clone(&harness, undetached(request(&harness, &harness.url, "leftover")));
        transfer_started(&harness).await;
        let joiner = spawn_clone(&harness, attach(request(&harness, &harness.url, "leftover")));
        wait_until(|| harness.runtime.waiters(&destination) == 2, "the attach joined").await;
        leave(starter).await;

        let failure = finished(joiner).await.expect_err("the cleanup failed");
        assert_eq!(failure["_tag"], "GitCommandError", "not a clean cancel: {failure}");
        let detail = failure["detail"].as_str().expect("detail");
        assert!(detail.contains("could not be removed"), "{detail}");
        assert!(detail.contains(&*destination.to_string_lossy()), "{detail}");
        assert!(destination.is_dir(), "a folder the clone did not create is never removed");
        let retained = call(&harness, attach(request(&harness, &harness.url, "leftover")))
            .await
            .expect_err("retained");
        assert_eq!(retained, failure);
    }

    #[tokio::test]
    async fn a_panicking_transfer_still_removes_its_folder_before_its_slot_is_freed() {
        let harness = harness(Limits {
            capacity: 1,
            ..Limits::default()
        });
        harness.runner.panic_on_clone.store(true, Ordering::SeqCst);
        let destination = harness.parent.join("panicked");
        let failure = call(&harness, request(&harness, &harness.url, "panicked"))
            .await
            .expect_err("a panicking transfer fails");
        assert_eq!(failure["_tag"], "GitCommandError");
        assert!(
            failure["detail"].as_str().expect("detail").contains("stopped unexpectedly"),
            "{failure}"
        );
        assert!(!destination.exists(), "the folder was removed before the outcome was published");

        harness.runner.panic_on_clone.store(false, Ordering::SeqCst);
        let next = spawn_clone(&harness, request(&harness, &harness.url, "next"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        finished(next).await.expect("the freed slot admits the next clone");
    }

    #[tokio::test]
    async fn an_attach_that_raced_a_new_clone_joins_it_instead_of_reading_its_folder() {
        let (pauses, inspect) = TestPauses::at(PausePoint::BeforeInspect);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let destination = harness.parent.join("raced");
        let attaching = spawn_clone(&harness, attach(request(&harness, &harness.url, "raced")));
        timeout(DEADLINE, inspect.arrived())
            .await
            .expect("the attach reached its disk check");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "raced"));
        transfer_started(&harness).await;
        assert!(destination.is_dir(), "the new clone reserved the folder the attach will read");

        inspect.release();
        wait_until(|| harness.runtime.waiters(&destination) == 2, "the attach joined").await;
        harness.runner.release.add_permits(1);
        assert_eq!(finished(attaching).await.expect("the attach joined the clone"), destination);
        assert_eq!(finished(starter).await.expect("the clone succeeds"), destination);
    }

    #[tokio::test]
    async fn a_clone_that_finished_before_its_starter_left_is_kept() {
        let (pauses, transferred) = TestPauses::at(PausePoint::AfterTransfer);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let destination = harness.parent.join("finished-first");
        let starter =
            spawn_clone(&harness, undetached(request(&harness, &harness.url, "finished-first")));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        timeout(DEADLINE, transferred.arrived())
            .await
            .expect("Git finished the transfer");
        // The starter leaves after Git succeeded, before the clone's task looks at the result:
        // the root is cancelled when the success-or-cleanup branch runs.
        leave(starter).await;
        transferred.release();
        wait_until(|| harness.runtime.live() == 0, "the outcome was published").await;

        assert!(destination.join(".git").is_dir(), "a finished clone is never removed");
        assert_eq!(
            call(&harness, attach(request(&harness, &harness.url, "finished-first")))
                .await
                .expect("the finished clone is found"),
            destination
        );
    }

    #[tokio::test]
    async fn a_detached_clone_keeps_its_admission_permit_so_the_drain_names_it() {
        let harness = standard();
        let gate = RpcAdmissionGate::new();
        let permit = gate
            .admit_named(RpcMutability::Mutation, "vcs.clone")
            .expect("open gate");
        let runtime = harness.runtime.clone();
        let clone_request = request(&harness, &harness.url, "permit");
        let starter = tokio::spawn(async move {
            runtime
                .start_or_join(clone_request, Some(permit), &CancellationToken::new())
                .await
        });
        transfer_started(&harness).await;
        leave(starter).await;

        let drain = gate
            .close_and_drain(Instant::now() + Duration::from_millis(100))
            .await
            .expect_err("the detached clone still holds its permit");
        assert!(drain.to_string().contains("vcs.clone"), "the drain names the clone: {drain}");

        harness.runner.release.add_permits(1);
        wait_until(|| gate.snapshot().in_flight == 0, "the finished clone released its permit").await;
    }
}
```

- [ ] **Step 3: Write the failing integration tests**

In `apps/server/tests/production_git_vcs_rpc.rs`:

1. Add `collections::HashMap,` to the `std::{…}` import.
2. Add this method to `impl GitServerHarness` (after `fn socket`):

```rust
    /// Closes the current socket, as a dropped connection does, and opens a new one.
    async fn reconnect(&mut self) {
        if let Some(mut socket) = self.socket.take() {
            let _ = socket.close(None).await;
        }
        let handle = self.handle.as_ref().expect("running server");
        let (socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
            .await
            .expect("WebSocket reconnects");
        self.socket = Some(socket);
    }
```

3. Append these helpers after `wait_for_connection_close`. Task 5 adds `success_of`; this task adds only what its own tests use, because warnings are denied in test targets too.

```rust
async fn stalled_http_remote() -> (tokio::net::TcpListener, String) {
    let remote = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stalled remote listener");
    let url = format!(
        "http://{}/stalled.git",
        remote.local_addr().expect("stalled remote address")
    );
    (remote, url)
}

async fn accept_git(remote: &tokio::net::TcpListener) -> tokio::net::TcpStream {
    timeout(GIT_RPC_RESPONSE_DEADLOCK_BOUND, remote.accept())
        .await
        .expect("Git connects to the remote")
        .expect("accept Git's connection")
        .0
}

/// Git still holds its connection two seconds later: the clone is running.
async fn assert_connection_stays_open(connection: &mut tokio::net::TcpStream, context: &str) {
    use tokio::io::AsyncReadExt;

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut buffer = [0_u8; 4096];
    loop {
        match timeout_at(deadline, connection.read(&mut buffer)).await {
            Err(_) => return,
            Ok(Ok(0) | Err(_)) => panic!("{context}: Git's connection closed"),
            Ok(Ok(_)) => {}
        }
    }
}

async fn assert_no_reply(socket: &mut TestSocket, context: &str) {
    if let Ok(message) = timeout(Duration::from_millis(500), socket.next()).await {
        panic!("{context}: expected no reply yet, got {message:?}");
    }
}

async fn next_exits(socket: &mut TestSocket, count: usize) -> HashMap<String, RpcExit> {
    let mut exits = HashMap::new();
    while exits.len() < count {
        match next_server_message(socket).await {
            ServerMessage::Exit { request_id, exit } => {
                exits.insert(request_id.as_str().to_owned(), exit);
            }
            message => panic!("expected an Exit, got {message:?}"),
        }
    }
    exits
}

fn failure_of(exit: &RpcExit) -> Value {
    match exit {
        RpcExit::Failure { cause } => match cause.as_slice() {
            [CauseItem::Fail { error }] => error.clone(),
            cause => panic!("expected one failure, got {cause:?}"),
        },
        exit => panic!("expected failure, got {exit:?}"),
    }
}

fn with_flags(payload: &Value, attach: bool, detach: bool) -> Value {
    let mut payload = payload.clone();
    payload["attach"] = json!(attach);
    payload["detach"] = json!(detach);
    payload
}
```

4. Append the tests:

```rust
#[tokio::test]
async fn a_detached_clone_survives_a_socket_close_and_an_interrupt_and_attach_shares_its_outcome() {
    let parallelism_permit = acquire_git_rpc_fixture().await;
    if relaunch_with_isolated_git_config(
        "a_detached_clone_survives_a_socket_close_and_an_interrupt_and_attach_shares_its_outcome",
    ) {
        return;
    }
    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    // An explicit empty proxy keeps Git on the loopback remote even when the host sets one.
    run_git_in(root.path(), &["config", "--global", "http.proxy", ""]);
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");
    let (remote, url) = stalled_http_remote().await;
    let destination = clone_parent.join("detached");
    let clone = json!({ "url": url, "parentDir": clone_parent, "directoryName": "detached" });
    let mut server = GitServerHarness::start(&temp, parallelism_permit).await;

    request(server.socket(), "701", "vcs.clone", with_flags(&clone, false, true)).await;
    let mut connection = accept_git(&remote).await;
    assert!(destination.is_dir(), "the clone created its destination");

    // The socket drops. The detached clone keeps running on the server.
    server.reconnect().await;
    assert_connection_stays_open(&mut connection, "after the socket closed").await;
    assert!(destination.is_dir());

    // A new socket re-attaches. An Interrupt ends only that wait.
    let attach = with_flags(&clone, true, true);
    request(server.socket(), "702", "vcs.clone", attach.clone()).await;
    assert_no_reply(server.socket(), "a joined attach waits for the clone").await;
    interrupt_clone(server.socket(), "702", "vcs.clone").await;
    assert_connection_stays_open(&mut connection, "after the attach was interrupted").await;

    // Join again, then end the transfer from the remote's side: the attach shares the failure.
    request(server.socket(), "703", "vcs.clone", attach.clone()).await;
    assert_no_reply(server.socket(), "the second attach waits").await;
    drop(connection);
    let failure = failure_value(server.socket(), "703").await;
    assert_eq!(failure["_tag"], "GitCommandError");
    assert!(!destination.exists(), "the outcome was published after the cleanup");

    // Within five minutes, another socket's re-attach gets the same failure.
    server.reconnect().await;
    request(server.socket(), "704", "vcs.clone", attach).await;
    assert_eq!(failure_value(server.socket(), "704").await, failure);

    server.shutdown().await;
}

#[tokio::test]
async fn without_detach_a_socket_close_still_stops_the_clone_and_removes_its_folder() {
    let parallelism_permit = acquire_git_rpc_fixture().await;
    if relaunch_with_isolated_git_config(
        "without_detach_a_socket_close_still_stops_the_clone_and_removes_its_folder",
    ) {
        return;
    }
    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    run_git_in(root.path(), &["config", "--global", "http.proxy", ""]);
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");
    let (remote, url) = stalled_http_remote().await;
    let destination = clone_parent.join("legacy");
    let mut server = GitServerHarness::start(&temp, parallelism_permit).await;

    request(
        server.socket(),
        "711",
        "vcs.clone",
        json!({ "url": url, "parentDir": clone_parent, "directoryName": "legacy" }),
    )
    .await;
    let mut connection = accept_git(&remote).await;
    server.reconnect().await;
    wait_for_connection_close(&mut connection, "a socket close without detach").await;
    let deadline = Instant::now() + Duration::from_secs(20);
    while destination.exists() {
        assert!(Instant::now() < deadline, "the created folder was left behind");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    server.shutdown().await;
}

#[tokio::test]
async fn attach_reports_nothing_a_finished_clone_an_incomplete_one_and_busy() {
    let parallelism_permit = acquire_git_rpc_fixture().await;
    if relaunch_with_isolated_git_config(
        "attach_reports_nothing_a_finished_clone_an_incomplete_one_and_busy",
    ) {
        return;
    }
    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    run_git_in(root.path(), &["config", "--global", "http.proxy", ""]);
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");
    let source = TempDir::new().expect("clone source");
    initialize_repository(&source);
    commit_file(source.path(), "tracked.txt", "base\n", "initial");
    let source_url = local_file_url(source.path());
    let mut server = GitServerHarness::start(&temp, parallelism_permit).await;

    // Nothing there: not-in-progress, and attach never creates the folder.
    let nothing = json!({ "url": source_url, "parentDir": clone_parent, "directoryName": "nothing" });
    request(server.socket(), "721", "vcs.clone", with_flags(&nothing, true, true)).await;
    let error = failure_value(server.socket(), "721").await;
    assert_eq!(error["_tag"], "GitCloneOperationError");
    assert_eq!(error["reason"], "not-in-progress");
    assert!(!clone_parent.join("nothing").exists());

    // A finished clone: a later attach from a new socket gets its path from the disk.
    let finished = json!({ "url": source_url, "parentDir": clone_parent, "directoryName": "finished" });
    request(server.socket(), "722", "vcs.clone", with_flags(&finished, false, true)).await;
    let cloned = success_value(server.socket(), "722").await;
    server.reconnect().await;
    request(server.socket(), "723", "vcs.clone", with_flags(&finished, true, true)).await;
    assert_eq!(success_value(server.socket(), "723").await, cloned);

    // A leftover with the same origin but no commit: the incomplete-clone error.
    let leftover = clone_parent.join("leftover");
    fs::create_dir(&leftover).expect("leftover");
    initialize_repository_in(&leftover);
    run_git_in(&leftover, &["remote", "add", "origin", &source_url]);
    let incomplete = json!({ "url": source_url, "parentDir": clone_parent, "directoryName": "leftover" });
    request(server.socket(), "724", "vcs.clone", with_flags(&incomplete, true, true)).await;
    let error = failure_value(server.socket(), "724").await;
    assert_eq!(error["_tag"], "GitCommandError");
    assert!(
        error["detail"]
            .as_str()
            .expect("detail")
            .contains("An incomplete clone exists at")
    );
    assert!(leftover.join(".git").is_dir(), "attach keeps the leftover");

    // Another URL into a running clone's folder: busy at once, never naming the running URL.
    let (remote, stalled_url) = stalled_http_remote().await;
    let running = json!({ "url": stalled_url, "parentDir": clone_parent, "directoryName": "busy" });
    request(server.socket(), "725", "vcs.clone", with_flags(&running, false, true)).await;
    let connection = accept_git(&remote).await;
    let other = json!({ "url": source_url, "parentDir": clone_parent, "directoryName": "busy" });
    for (id, payload) in [
        ("726", with_flags(&other, false, true)),
        ("727", with_flags(&other, true, true)),
    ] {
        request(server.socket(), id, "vcs.clone", payload).await;
        let error = failure_value(server.socket(), id).await;
        assert_eq!(error["reason"], "busy");
        assert!(!error.to_string().contains(&stalled_url));
    }
    // End the running clone from the remote's side.
    drop(connection);
    let exits = next_exits(server.socket(), 1).await;
    assert_eq!(failure_of(&exits["725"])["_tag"], "GitCommandError");

    server.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn source_control_clone_through_a_symlinked_parent_joins_the_running_clone() {
    let parallelism_permit = acquire_git_rpc_fixture().await;
    if relaunch_with_isolated_git_config(
        "source_control_clone_through_a_symlinked_parent_joins_the_running_clone",
    ) {
        return;
    }
    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    run_git_in(root.path(), &["config", "--global", "http.proxy", ""]);
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");
    let link = root.path().join("clones-link");
    std::os::unix::fs::symlink(&clone_parent, &link).expect("symlinked parent");
    let (remote, url) = stalled_http_remote().await;
    let mut server = GitServerHarness::start(&temp, parallelism_permit).await;

    let clone = json!({ "url": url, "parentDir": clone_parent, "directoryName": "joined" });
    request(server.socket(), "731", "vcs.clone", with_flags(&clone, false, true)).await;
    let connection = accept_git(&remote).await;

    request(
        server.socket(),
        "732",
        "sourceControl.cloneRepository",
        json!({ "remoteUrl": url, "destinationPath": link.join("joined") }),
    )
    .await;
    assert_no_reply(server.socket(), "the aliased clone joins instead of failing").await;
    assert!(
        timeout(Duration::from_millis(500), remote.accept()).await.is_err(),
        "a join starts no second transfer"
    );

    // End the transfer from the remote's side: both callers get the one outcome.
    drop(connection);
    let exits = next_exits(server.socket(), 2).await;
    let failure = failure_of(&exits["731"]);
    assert_eq!(failure["_tag"], "GitCommandError");
    let joined = failure_of(&exits["732"]);
    assert_eq!(joined["_tag"], "SourceControlRepositoryError");
    assert_eq!(joined["operation"], "cloneRepository");
    assert_eq!(joined["detail"], failure["detail"], "the join shared the clone's outcome");

    server.shutdown().await;
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cargo test -p bibcode-server --lib -- git::repository::clone_tests::inspecting_a_destination production::clone_operations`
Expected: FAIL to compile. `inspect_clone_destination`, `CloneRuntime`, `CloneRequest`, `test_pauses`, and the constants do not exist.

Run: `cargo test -p bibcode-server --test production_git_vcs_rpc -- a_detached_clone_survives without_detach attach_reports source_control_clone_through`
Expected: three FAIL and one pass:
- the detached clone dies when the socket closes;
- the attach to nothing starts a clone instead of answering `not-in-progress`;
- the symlinked `sourceControl.cloneRepository` meets the running clone's folder and fails at once, instead of joining;
- `without_detach_…` passes already. It pins today's Cancel for older clients and must stay green.

- [ ] **Step 5: Implement `inspect_clone_destination`, remove the registry, and re-export**

In `apps/server/src/git/repository.rs`, add inside `impl GitRepository`, after `reserve_clone_destination`:

```rust
    /// The reuse check without reserving: `Ok(None)` when nothing exists at the destination,
    /// the finished clone's path, or the error that names why the folder cannot be reused.
    pub(crate) async fn inspect_clone_destination(
        &self,
        url: &str,
        parent_dir: &Path,
        leaf: &str,
        cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, GitCommandError> {
        let destination = parent_dir.join(leaf);
        match tokio::fs::symlink_metadata(&destination).await {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            _ => self
                .reuse_existing_destination(url, parent_dir, &destination, cancellation)
                .await
                .map(Some),
        }
    }
```

Replace `clone_repository` (doc comment and body) with the unserialized primitive:

```rust
    /// Clones `url` into `parent_dir` without serializing against other clones of the same
    /// destination. Production RPCs go through `CloneRuntime`, which owns one clone per
    /// destination; this primitive serves tests and the runtime-free coverage suite. Cancelling
    /// `cancellation` or dropping the future stops Git and removes the folder this call created.
    pub async fn clone_repository(
        &self,
        url: &str,
        parent_dir: &Path,
        directory_name: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, GitCommandError> {
        let leaf = clone_destination_leaf(url, directory_name);
        let reserved = match self
            .reserve_clone_destination(url, parent_dir, &leaf, cancellation)
            .await?
        {
            CloneReservation::Existing(path) => return Ok(path),
            CloneReservation::Reserved(reserved) => reserved,
        };
        let transfer_cancellation = cancellation.child_token();
        let _cancel_transfer_on_drop = transfer_cancellation.clone().drop_guard();
        let task = tokio::spawn(async move { reserved.run(&transfer_cancellation).await });
        match task.await {
            Ok(result) => result,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(error) => Err(simple_error(
                CLONE_OPERATION,
                parent_dir,
                &format!("The clone stopped before it finished: {error}"),
            )),
        }
    }
```

Delete `CloneDestinationRegistry`, `CloneDestinationLease`, and their `impl`/`Drop` blocks. They run from the doc comment "Serializes clones into one destination." through the end of `impl CloneDestinationRegistry`.

In `mod clone_tests`, delete three tests. Their behaviour moves to runtime tests with the same deterministic cleanup barrier:
- `a_retry_right_after_cancel_waits_for_the_cancelled_clone_to_clean_up` → `a_starter_without_detach_cancels_on_leaving_and_a_retry_waits_for_its_cleanup` (the runner holds the cancelled Git until released, exactly like the old `HeldCancellationRunner`);
- `a_waiting_retry_honours_its_own_cancellation_and_leaves_the_folder` → the `impatient` retry in that same test;
- `a_finished_clone_leaves_no_destination_entry_behind` → the `live() == 0` and `retained_len() == 0` assertions in `a_detached_starter_leaves_the_clone_running_and_an_attach_joins_it`.

Delete `HeldCancellationRunner` (11138-11182); its only user was the first deleted test (`rg -n HeldCancellationRunner apps/server/src/git/repository.rs` must print nothing). Remove any import that is now unused; Clippy names them.

In `apps/server/src/git/mod.rs`, add after `pub(crate) use repository::GitProcessRunner;` (35):

```rust
pub(crate) use repository::{CloneReservation, clone_destination_leaf};
```

`ReservedClone` needs no re-export: the runtime only moves it out of the `CloneReservation` it matches.

- [ ] **Step 6: Implement the runtime**

Prepend to `apps/server/src/production/clone_operations.rs`, above the test module:

```rust
//! Server-owned clone operations for `vcs.clone` and `sourceControl.cloneRepository`.
//!
//! A clone is keyed by its destination: the canonical parent folder plus the derived leaf.
//! One live clone per destination. A request for the same URL joins it and shares its
//! outcome; another URL gets `busy` at once. The clone owns a root cancellation token, so a
//! caller that detached can leave (socket close, Interrupt) without stopping Git. Git runs in
//! its own task, and the outcome is published only after the folder the clone created is gone
//! (or its removal failed, which the outcome then names). Failed and cancelled outcomes are
//! retained for five minutes, per URL, so a re-attach learns the real reason; a success needs
//! no record, because the folder on disk is the record.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;

use crate::{
    git::{
        CloneReservation, GitCommandError, GitRepository, host_path_platform,
        normalize_worktree_path_key,
    },
    maintenance::RpcPermit,
};

/// Live clones one server runs at once. Admission never waits: a full runtime answers
/// `capacity` at once, like the catalog-operation runtime.
pub(crate) const CLONE_OPERATION_CAPACITY: usize = 16;
/// How long a failed or cancelled outcome answers a re-attach for the same URL.
pub(crate) const CLONE_OUTCOME_RETENTION: Duration = Duration::from_secs(5 * 60);
/// Live clones plus retained outcomes kept at once. At this bound a new clone is refused with
/// `capacity`: no outcome is ever dropped before its retention ends (spec: failed and
/// cancelled outcomes "stay in memory 5 minutes"), and memory stays bounded.
pub(crate) const CLONE_RETAINED_OUTCOME_CAPACITY: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CloneOperationReason {
    Busy,
    Capacity,
    NotInProgress,
    Cancelled,
}

impl CloneOperationReason {
    fn wire(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Capacity => "capacity",
            Self::NotInProgress => "not-in-progress",
            Self::Cancelled => "cancelled",
        }
    }

    fn message(self, destination: &str) -> String {
        match self {
            Self::Busy => format!("Another clone into {destination} is in progress."),
            Self::Capacity => "Too many clones are running on this server.".to_owned(),
            Self::NotInProgress => format!("No clone is in progress for {destination}."),
            Self::Cancelled => format!("The clone into {destination} was cancelled."),
        }
    }
}

/// `GitCloneOperationError`. It never names another clone's URL, which may embed credentials.
fn clone_operation_error(reason: CloneOperationReason, destination: &Path) -> Value {
    let destination = destination.to_string_lossy().into_owned();
    json!({
        "_tag": "GitCloneOperationError",
        "reason": reason.wire(),
        "message": reason.message(&destination),
        "destination": destination,
    })
}

#[derive(Clone, Debug)]
pub(crate) struct CloneRequest {
    pub(crate) url: String,
    /// Canonical parent folder; the handler resolves it (ruling 10).
    pub(crate) parent_dir: PathBuf,
    /// `clone_destination_leaf(url, directoryName)`.
    pub(crate) leaf: String,
    /// Join-only: never starts a clone.
    pub(crate) attach: bool,
    /// The caller leaving does not cancel a clone it started.
    pub(crate) detach: bool,
}

impl CloneRequest {
    fn destination(&self) -> PathBuf {
        self.parent_dir.join(&self.leaf)
    }
}

fn destination_key(destination: &Path) -> String {
    normalize_worktree_path_key(destination, host_path_platform())
}

#[derive(Clone, Debug)]
enum CloneOutcome {
    Succeeded(PathBuf),
    Failed(Value),
    Cancelled,
}

#[derive(Clone, Debug)]
enum ClonePhase {
    Running,
    Finished(CloneOutcome),
}

struct CloneEntry {
    id: u64,
    url: String,
    root: CancellationToken,
    phase: watch::Sender<ClonePhase>,
    /// When a retained outcome expires; `None` while the clone is live.
    expires_at: Option<Instant>,
}

impl CloneEntry {
    fn is_live(&self) -> bool {
        self.expires_at.is_none()
    }
}

#[derive(Default)]
struct CloneRuntimeState {
    /// Counts starts; an attach compares it before and after reading the disk.
    next_id: u64,
    live: usize,
    entries: HashMap<String, CloneEntry>,
}

impl CloneRuntimeState {
    /// Drops expired retained outcomes. Runs on every access, so no outcome outlives its
    /// retention waiting for a later admission.
    fn sweep(&mut self, now: Instant) {
        self.entries
            .retain(|_, entry| entry.expires_at.is_none_or(|expires_at| expires_at > now));
    }

}

struct CloneRuntimeInner {
    repository: Arc<GitRepository>,
    capacity: usize,
    retention: Duration,
    retained_capacity: usize,
    state: Mutex<CloneRuntimeState>,
    #[cfg(test)]
    pauses: test_pauses::TestPauses,
}

#[derive(Clone)]
pub(crate) struct CloneRuntime {
    inner: Arc<CloneRuntimeInner>,
}

enum Admission {
    Join(watch::Receiver<ClonePhase>),
    WaitForCleanup(watch::Receiver<ClonePhase>),
    Started {
        receiver: watch::Receiver<ClonePhase>,
        root: CancellationToken,
    },
    Retained(CloneOutcome),
    Inspect {
        generation: u64,
    },
    Refused(CloneOperationReason),
}

impl CloneRuntime {
    pub(crate) fn new(repository: Arc<GitRepository>) -> Self {
        Self {
            inner: Arc::new(CloneRuntimeInner {
                repository,
                capacity: CLONE_OPERATION_CAPACITY,
                retention: CLONE_OUTCOME_RETENTION,
                retained_capacity: CLONE_RETAINED_OUTCOME_CAPACITY,
                state: Mutex::default(),
                #[cfg(test)]
                pauses: test_pauses::TestPauses::default(),
            }),
        }
    }

    #[cfg(test)]
    fn for_test(
        repository: Arc<GitRepository>,
        capacity: usize,
        retention: Duration,
        retained_capacity: usize,
        pauses: test_pauses::TestPauses,
    ) -> Self {
        Self {
            inner: Arc::new(CloneRuntimeInner {
                repository,
                capacity,
                retention,
                retained_capacity,
                state: Mutex::default(),
                pauses,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, CloneRuntimeState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Starts a clone, joins the running clone of the same URL, or (with `attach`) only reports
    /// on it. Leaving is dropping this future: the RPC layer does that on Interrupt, socket
    /// teardown, or a dropped handler, and answers with an `Interrupt` exit. Leaving ends this
    /// caller's wait, and stops the clone only when this caller started it without `detach`.
    /// `cancellation` bounds only the disk check an `attach` may run.
    pub(crate) async fn start_or_join(
        &self,
        request: CloneRequest,
        admission: Option<RpcPermit>,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, Value> {
        let destination = request.destination();
        let mut admission = admission;
        loop {
            match self.admit(&request, &mut admission) {
                Admission::Refused(reason) => {
                    return Err(clone_operation_error(reason, &destination));
                }
                Admission::WaitForCleanup(receiver) => {
                    wait_finished(receiver, &destination).await;
                }
                Admission::Join(receiver) => {
                    let outcome = wait_finished(receiver, &destination).await;
                    return outcome_result(outcome, &destination);
                }
                Admission::Retained(outcome) => return outcome_result(outcome, &destination),
                Admission::Inspect { generation } => {
                    #[cfg(test)]
                    self.inner
                        .pauses
                        .wait(test_pauses::PausePoint::BeforeInspect)
                        .await;
                    let inspected = self
                        .inner
                        .repository
                        .inspect_clone_destination(
                            &request.url,
                            &request.parent_dir,
                            &request.leaf,
                            cancellation,
                        )
                        .await;
                    // A clone admitted while the disk was being read may own what was seen:
                    // admit again (and join it) instead of reporting its half-written folder.
                    if self.lock().next_id != generation {
                        continue;
                    }
                    return match inspected {
                        Ok(Some(path)) => Ok(path),
                        Ok(None) => Err(clone_operation_error(
                            CloneOperationReason::NotInProgress,
                            &destination,
                        )),
                        Err(error) => Err(serialize(error)),
                    };
                }
                Admission::Started { receiver, root } => {
                    // Older clients keep today's Cancel: a starter without `detach` stops the
                    // clone when it leaves.
                    let cancel_on_leave = (!request.detach).then(|| root.drop_guard());
                    let outcome = wait_finished(receiver, &destination).await;
                    if let Some(guard) = cancel_on_leave {
                        let _ = guard.disarm();
                    }
                    return outcome_result(outcome, &destination);
                }
            }
        }
    }

    fn admit(&self, request: &CloneRequest, admission: &mut Option<RpcPermit>) -> Admission {
        let key = destination_key(&request.destination());
        let mut state = self.lock();
        state.sweep(Instant::now());
        if let Some(entry) = state.entries.get(&key) {
            if entry.is_live() {
                if entry.url != request.url {
                    return Admission::Refused(CloneOperationReason::Busy);
                }
                let receiver = entry.phase.subscribe();
                return if entry.root.is_cancelled() && !request.attach {
                    Admission::WaitForCleanup(receiver)
                } else {
                    Admission::Join(receiver)
                };
            }
            // A retained outcome answers only a re-attach for the same URL.
            if request.attach
                && entry.url == request.url
                && let ClonePhase::Finished(outcome) = &*entry.phase.borrow()
            {
                return Admission::Retained(outcome.clone());
            }
        }
        if request.attach {
            return Admission::Inspect {
                generation: state.next_id,
            };
        }
        // The bound is enforced here, at admission, never by dropping an outcome early. A start
        // replaces this destination's own retained outcome (any entry left under `key` is not
        // live), so that outcome does not count.
        let occupied = state.entries.len() - usize::from(state.entries.contains_key(&key));
        if state.live >= self.inner.capacity || occupied >= self.inner.retained_capacity {
            return Admission::Refused(CloneOperationReason::Capacity);
        }
        state.entries.remove(&key);
        state.next_id = state.next_id.wrapping_add(1);
        let id = state.next_id;
        let root = CancellationToken::new();
        let (phase, receiver) = watch::channel(ClonePhase::Running);
        state.entries.insert(
            key.clone(),
            CloneEntry {
                id,
                url: request.url.clone(),
                root: root.clone(),
                phase,
                expires_at: None,
            },
        );
        state.live += 1;
        drop(state);
        self.spawn(key, id, request.clone(), root.clone(), admission.take());
        Admission::Started { receiver, root }
    }

    fn spawn(
        &self,
        key: String,
        id: u64,
        request: CloneRequest,
        root: CancellationToken,
        admission: Option<RpcPermit>,
    ) {
        let runtime = self.clone();
        tokio::spawn(async move {
            // Held until the outcome is published: locals drop in reverse order, so `finish`
            // below publishes first and the permit goes last. The update drain therefore names
            // this clone, even after its caller detached, until its cleanup has settled.
            let _admission = admission;
            // Publishes a failure if this task itself panics, so waiters never hang. Only
            // reservation, cleanup, and publishing run here; the transfer has its own task.
            let mut finish = FinishGuard {
                runtime: runtime.clone(),
                destination: request.destination(),
                key,
                id,
                outcome: None,
            };
            finish.outcome = Some(runtime.run_clone(&request, &root).await);
        });
    }

    async fn run_clone(&self, request: &CloneRequest, root: &CancellationToken) -> CloneOutcome {
        // Cancelled before it reserved anything: nothing to remove.
        if root.is_cancelled() {
            return CloneOutcome::Cancelled;
        }
        let reserved = match self
            .inner
            .repository
            .reserve_clone_destination(&request.url, &request.parent_dir, &request.leaf, root)
            .await
        {
            Ok(CloneReservation::Existing(path)) => return CloneOutcome::Succeeded(path),
            Ok(CloneReservation::Reserved(reserved)) => Arc::new(reserved),
            // A failed reservation created no folder.
            Err(_) if root.is_cancelled() => return CloneOutcome::Cancelled,
            Err(error) => return CloneOutcome::Failed(serialize(error)),
        };
        // Git runs in its own task, so a panic there still leaves this task to remove the
        // folder before the outcome is published and the slot is freed.
        let transfer = {
            let reserved = Arc::clone(&reserved);
            let root = root.clone();
            tokio::spawn(async move { reserved.transfer(&root).await })
        };
        let transferred = transfer.await;
        #[cfg(test)]
        self.inner
            .pauses
            .wait(test_pauses::PausePoint::AfterTransfer)
            .await;
        let error = match transferred {
            Ok(Ok(path)) => return CloneOutcome::Succeeded(path),
            Ok(Err(error)) => error,
            Err(join_error) => stopped_unexpectedly(&request.destination(), &join_error.to_string()),
        };
        match reserved.remove_destination().await {
            Ok(()) if root.is_cancelled() => CloneOutcome::Cancelled,
            Ok(()) => CloneOutcome::Failed(serialize(error)),
            // A cancelled clone whose folder could not be removed reports the leftover, not a
            // clean cancel.
            Err(cleanup_error) => {
                CloneOutcome::Failed(serialize(reserved.with_cleanup_failure(error, &cleanup_error)))
            }
        }
    }

    /// Publishes the outcome and frees the slot in one step. Runs only after the transfer and
    /// its cleanup have settled.
    fn finish(&self, key: &str, id: u64, outcome: CloneOutcome) {
        let mut state = self.lock();
        if !state.entries.get(key).is_some_and(|entry| entry.id == id) {
            return;
        }
        if matches!(outcome, CloneOutcome::Succeeded(_)) {
            if let Some(entry) = state.entries.remove(key) {
                entry.phase.send_replace(ClonePhase::Finished(outcome));
            }
        } else if let Some(entry) = state.entries.get_mut(key) {
            entry.phase.send_replace(ClonePhase::Finished(outcome));
            entry.expires_at = Some(Instant::now() + self.inner.retention);
        }
        state.live = state.live.saturating_sub(1);
        state.sweep(Instant::now());
    }

    /// Callers waiting on the live clone of this destination.
    #[cfg(test)]
    fn waiters(&self, destination: &Path) -> usize {
        self.lock()
            .entries
            .get(&destination_key(destination))
            .filter(|entry| entry.is_live())
            .map_or(0, |entry| entry.phase.receiver_count())
    }

    #[cfg(test)]
    fn live(&self) -> usize {
        self.lock().live
    }

    #[cfg(test)]
    fn retained_len(&self) -> usize {
        self.lock()
            .entries
            .values()
            .filter(|entry| !entry.is_live())
            .count()
    }
}

/// Publishes the outcome when the clone's task ends, including by a panic outside the transfer,
/// so waiters never hang.
struct FinishGuard {
    runtime: CloneRuntime,
    destination: PathBuf,
    key: String,
    id: u64,
    outcome: Option<CloneOutcome>,
}

impl Drop for FinishGuard {
    fn drop(&mut self) {
        let outcome = self.outcome.take().unwrap_or_else(|| {
            CloneOutcome::Failed(serialize(stopped_unexpectedly(
                &self.destination,
                "the clone task stopped",
            )))
        });
        self.runtime.finish(&self.key, self.id, outcome);
    }
}

async fn wait_finished(mut receiver: watch::Receiver<ClonePhase>, destination: &Path) -> CloneOutcome {
    let _ = receiver
        .wait_for(|phase| matches!(phase, ClonePhase::Finished(_)))
        .await;
    // A succeeded entry is removed right after its final send, so read the last value whether
    // or not the sender is still alive.
    match &*receiver.borrow() {
        ClonePhase::Finished(outcome) => outcome.clone(),
        ClonePhase::Running => CloneOutcome::Failed(serialize(stopped_unexpectedly(
            destination,
            "the clone ended without an outcome",
        ))),
    }
}

fn outcome_result(outcome: CloneOutcome, destination: &Path) -> Result<PathBuf, Value> {
    match outcome {
        CloneOutcome::Succeeded(path) => Ok(path),
        CloneOutcome::Failed(error) => Err(error),
        CloneOutcome::Cancelled => Err(clone_operation_error(
            CloneOperationReason::Cancelled,
            destination,
        )),
    }
}

fn stopped_unexpectedly(destination: &Path, reason: &str) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: "GitVcsDriver.clone".into(),
        command: "git".into(),
        cwd: destination.to_string_lossy().into(),
        diagnostics: None,
        detail: format!("The clone stopped unexpectedly ({reason}). Try again.").into(),
    }
}

fn serialize(error: GitCommandError) -> Value {
    serde_json::to_value(error).unwrap_or_else(
        |error| json!({ "_tag": "RpcSerializationError", "message": error.to_string() }),
    )
}

/// Deterministic interleavings for the tests: a pause stops the runtime at one point, once,
/// until the test releases it. Nothing here compiles into the server.
#[cfg(test)]
mod test_pauses {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use tokio::sync::{Notify, Semaphore};

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) enum PausePoint {
        /// In the clone's task, after the transfer returned and before its result decides
        /// between success and cleanup.
        AfterTransfer,
        /// In an `attach` caller, before it reads the disk.
        BeforeInspect,
    }

    pub(super) struct Pause {
        point: PausePoint,
        fired: AtomicBool,
        arrival: Notify,
        release: Semaphore,
    }

    impl Pause {
        pub(super) async fn arrived(&self) {
            self.arrival.notified().await;
        }

        pub(super) fn release(&self) {
            self.release.add_permits(1);
        }
    }

    #[derive(Clone, Default)]
    pub(super) struct TestPauses(Option<Arc<Pause>>);

    impl TestPauses {
        pub(super) fn at(point: PausePoint) -> (Self, Arc<Pause>) {
            let pause = Arc::new(Pause {
                point,
                fired: AtomicBool::new(false),
                arrival: Notify::new(),
                release: Semaphore::new(0),
            });
            (Self(Some(Arc::clone(&pause))), pause)
        }

        pub(super) async fn wait(&self, point: PausePoint) {
            let Some(pause) = &self.0 else {
                return;
            };
            if pause.point != point || pause.fired.swap(true, Ordering::SeqCst) {
                return;
            }
            pause.arrival.notify_one();
            pause
                .release
                .acquire()
                .await
                .expect("the pause semaphore stays open")
                .forget();
        }
    }
}
```

Task 6 adds a third pause point, `BeforeReserve`, together with the admission-versus-shutdown test that uses it. An unused variant would fail `-D warnings` in the test build.

- [ ] **Step 7: Wire the handlers**

In `apps/server/src/production/git_vcs.rs`:

1. Imports. Add `clone_destination_leaf` to the `crate::git::{…}` list, and add:

```rust
use super::clone_operations::{CloneRequest, CloneRuntime};
```

2. In `struct GitVcsRpcServices`, add after `worktree_removal_tasks: WorktreeRemovalTaskTracker,`:

```rust
    /// Server-owned clones, keyed by destination.
    clone_operations: CloneRuntime,
```

3. In `with_repository_dependencies`, before `Self {`, add `let clone_operations = CloneRuntime::new(Arc::clone(&repository));`. In the struct literal, add `clone_operations,` after `worktree_removal_tasks: WorktreeRemovalTaskTracker::default(),`.
4. Replace the `"vcs.clone"` arm (856-874) with:

```rust
            "vcs.clone" => {
                let input: CloneInput = decode(request.payload, "vcs.clone")?;
                let parent_dir = resolve_host_directory(&input.parent_dir, false)
                    .await
                    .map_err(|error| {
                        vcs_error("vcs.clone", &input.parent_dir, &error.to_string())
                    })?;
                let leaf = clone_destination_leaf(&input.url, input.directory_name.as_deref());
                // The starter's permit rides with the clone, so an update drain names a
                // detached clone until Git has stopped and its cleanup has finished.
                let path = self
                    .clone_operations
                    .start_or_join(
                        CloneRequest {
                            url: input.url,
                            parent_dir,
                            leaf,
                            attach: input.attach,
                            detach: input.detach,
                        },
                        context.admission_permit(),
                        &cancellation,
                    )
                    .await?;
                Ok(json!({ "path": display_path(path) }))
            }
```

5. Change the `"sourceControl.cloneRepository"` arm to pass the permit:

```rust
            "sourceControl.cloneRepository" => {
                let input: CloneRepositoryInput =
                    decode(request.payload, "sourceControl.cloneRepository")?;
                self.clone_source_repository(input, context.admission_permit(), &cancellation)
                    .await
            }
```

6. In `clone_source_repository` (1600-1638), add the parameter `admission: Option<RpcPermit>` after `input`. Replace everything from `let directory_name = …` through the final `Ok(json!…)` with the version below. It canonicalizes the parent (ruling 10) and maps every runtime failure into the method's declared union (D3).

```rust
        let provider = input.provider.clone().unwrap_or_else(|| "unknown".to_owned());
        // Destination keys use the canonical parent, so a symlinked or `..` alias of a running
        // clone's folder joins it instead of meeting its half-written folder.
        let parent_dir = resolve_host_directory(parent, false)
            .await
            .map_err(|error| source_control_error(&provider, "cloneRepository", &error.to_string()))?;
        let directory_name = destination.file_name().and_then(|value| value.to_str());
        let leaf = clone_destination_leaf(&remote_url, directory_name);
        let cwd = self
            .clone_operations
            .start_or_join(
                CloneRequest {
                    url: remote_url.clone(),
                    parent_dir,
                    leaf,
                    attach: false,
                    detach: false,
                },
                admission,
                cancellation,
            )
            .await
            .map_err(|error| {
                // The declared union is [SourceControlRepositoryError, EnvironmentRpcError], so
                // every runtime failure travels as a SourceControlRepositoryError.
                let detail = error["detail"]
                    .as_str()
                    .or_else(|| error["message"].as_str())
                    .unwrap_or("The clone failed.");
                source_control_error(&provider, "cloneRepository", detail)
            })?;
        Ok(json!({ "cwd": display_path(cwd), "remoteUrl": remote_url, "repository": Value::Null }))
```

7. Replace `struct CloneInput` (2001-2006) with:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloneInput {
    url: String,
    parent_dir: PathBuf,
    directory_name: Option<String>,
    /// Join-only; sent only by clients that saw `vcsCloneReattach`.
    #[serde(default)]
    attach: bool,
    /// The caller leaving does not stop a clone it started.
    #[serde(default)]
    detach: bool,
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cargo test -p bibcode-server --lib -- git::repository::clone_tests production::clone_operations production::git_vcs`
Expected: `test result: ok.` That covers 13 runtime tests, the repository clone tests (with the three deleted), and the Git VCS unit tests (including the `vcs.clone` and `sourceControl.cloneRepository` round trip in `mod tests`).

Run: `cargo test -p bibcode-server --test production_git_vcs_rpc`
Expected: `test result: ok.` for the whole binary, including the four new tests and today's clone tests:
- `interrupting_a_clone_stops_git_and_removes_the_destination_it_created` (the retry after Cancel now waits for cleanup through the runtime);
- `clone_retry_reuses_*`, `clone_rejects_*`, and `clone_resolves_a_home_relative_parent_before_running_git`;
- `clone_pull_and_worktree_lifecycle_round_trip_over_rpc`.

The Git status tests are timing-sensitive; re-run a single failure once before investigating.

Run: `cargo test -p bibcode-server --test git_coverage`
Expected: `test result: ok.`

- [ ] **Step 9: Capture the red evidence**

Apply each break alone, run the named test with `cargo test -p bibcode-server --lib -- <test>` or `--test production_git_vcs_rpc -- <test>`, record the failing assertion in the ledger, then restore the code:

| Test | Deliberate break | Expected red |
| --- | --- | --- |
| `a_detached_starter_leaves_the_clone_running_and_an_attach_joins_it` | In `admit`, answer `Admission::Inspect` for every `attach`, even with a live entry | The attach returns an error at once; `wait_until` times out: "the attach joined" |
| `a_starter_without_detach_cancels_on_leaving_and_a_retry_waits_for_its_cleanup` | In `admit`, return `Join` even when the live entry's root is cancelled | The retry returns `cancelled` without a transfer; `transfer_started` times out |
| `joiners_never_cancel_by_leaving` | In the `Join` arm, arm a drop guard when `!request.detach` | The starter's result is `cancelled`: "a leaving joiner never cancels the clone" |
| `another_url_is_busy_at_once_and_the_error_never_names_the_running_url` | Add `entry.url` to the busy message | "busy never names the running clone's URL" |
| `admission_is_bounded_without_waiting` | Change `state.live >= self.inner.capacity` to `>` | `expect_err("a full runtime refuses")` panics |
| `attach_reports_nothing_a_finished_clone_or_the_same_url_s_retained_failure` | Drop `entry.url == request.url` from the retained lookup | `reason(&other)` panics on a `GitCommandError` |
| `outcomes_are_never_dropped_early_and_a_full_runtime_refuses_until_they_expire` | Drop the `occupied >= self.inner.retained_capacity` admission check | The third clone is admitted: `expect_err("the runtime is full")` panics |
| same test | Evict the oldest retained outcome in `finish` instead of refusing at admission | The third clone is admitted, and `attach` for "first" answers `not-in-progress` |
| same test | Count the destination's own retained outcome in `occupied` | The replacement into "first" is refused with `capacity`, so `transfer_started` times out: "the clone reached its transfer" |
| `a_new_start_replays_no_retained_outcome` | Return `Admission::Retained` for non-attach requests too | The restart returns `cancelled`; `transfer_started` times out |
| `a_cancelled_clone_whose_folder_cannot_be_removed_reports_the_leftover` | In `run_clone`, return `CloneOutcome::Cancelled` when `root.is_cancelled()` before looking at the cleanup | The joiner gets `cancelled`: "not a clean cancel" |
| `a_panicking_transfer_still_removes_its_folder_before_its_slot_is_freed` | Call `reserved.transfer(root).await` inline instead of in its own task | The folder is left behind: "the folder was removed before the outcome was published" |
| `an_attach_that_raced_a_new_clone_joins_it_instead_of_reading_its_folder` | Remove the `next_id != generation` revalidation | The attach returns "…is not a Git repository…" or the incomplete-clone error: "the attach joined the clone" |
| `a_clone_that_finished_before_its_starter_left_is_kept` | In `run_clone`, when the transfer succeeded but the root is cancelled, remove the folder and return `Cancelled`. The `AfterTransfer` pause guarantees the root is cancelled when this branch runs. | ".git" is missing: "a finished clone is never removed" |
| `a_detached_clone_keeps_its_admission_permit_so_the_drain_names_it` | Drop the permit at the start of the spawned task | `expect_err("the detached clone still holds its permit")` panics |
| `a_detached_clone_survives_a_socket_close_and_an_interrupt_and_attach_shares_its_outcome` | Pass `detach: false` from the `vcs.clone` handler regardless of input | "after the socket closed: Git's connection closed" |
| `attach_reports_nothing_a_finished_clone_an_incomplete_one_and_busy` | Pass `attach: false` from the handler regardless of input | Request 721 succeeds, and `failure_value` panics |
| `source_control_clone_through_a_symlinked_parent_joins_the_running_clone` | Use the raw `parent` instead of `resolve_host_directory(parent, …)` | "the aliased clone joins instead of failing" panics on an immediate failure |

- [ ] **Step 10: Task gate**

Run: `cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: exit 0. Every new item has a caller:
- `start_or_join` is used by both handlers;
- `inspect_clone_destination` by the runtime;
- the test pauses and accessors by the tests.

`cancel` and `close_and_drain` do not exist yet.

Run: `cargo fmt --all --check`
Expected: exit 0.

- [ ] **Step 11: Checkpoint**

Record the checkpoint tree hash, results, and red evidence in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 5: `vcs.cancelClone` — wire contract, handler, and runtime cancel

The TypeScript method, the Rust method spec and scope, the handler, and the runtime's `cancel` land together. Production startup validates that every `ACTIVE_RPC_METHODS` entry has a handler, and `rpc_wire` requires the Rust list to equal the TypeScript group. So no partial landing is green.

**Files:**
- Modify: `packages/contracts/src/git.ts` (after `GitCloneInput`), `packages/contracts/src/rpc.ts` (`WS_METHODS` `vcsClone` at 401; after `WsVcsCloneRpc`; `WsRpcGroup` entry at 1638)
- Test: `packages/contracts/src/git.test.ts`, `packages/contracts/src/rpc.test.ts`
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, its `.test.ts`, `packages/contracts/fixtures/rpc-wire/**`, `apps/server/tests/rpc_wire.rs`
- Modify: `apps/server/src/rpc/methods.rs` (`vcs.clone` at 167), `apps/server/src/auth/scope.rs` (`vcs.clone` at 116; test at ~283)
- Modify: `apps/server/src/production/clone_operations.rs` (`cancel`; tests)
- Modify: `apps/server/src/production/git_vcs.rs` (`GIT_VCS_UNARY_METHODS` 169-189; new arm after `"vcs.clone"`; `CancelCloneInput` after `CloneInput`)
- Test: `apps/server/tests/production_git_vcs_rpc.rs` (registrar test 161-195; new cases)

**Interfaces:**
- Consumes (Task 4): `CloneRuntime`, its private `wait_finished`, `destination_key`, `CloneOutcome`, and the test harness.
- Produces (used by Tasks 7 and 8):
  - TS: `GitCancelCloneInput = { url: string; parentDir: string; directoryName?: string }`, `GitCancelCloneResult = { cancelled: boolean }`, `WS_METHODS.vcsCancelClone = "vcs.cancelClone"`, `WsVcsCancelCloneRpc` with error union `[GitCommandError, EnvironmentRpcError]` (D1).
  - Rust: `pub(crate) async fn cancel(&self, url: &str, parent_dir: &Path, leaf: &str) -> bool`. It is infallible: a caller that leaves drops the future, and the RPC layer answers with an `Interrupt` exit (D1, D10).
  - The wire: `vcs.cancelClone` is a `mutation_unary` with scope `orchestration:operate`.

- [ ] **Step 1: Write the failing contract tests**

In `packages/contracts/src/git.test.ts`, add `GitCancelCloneInput` to the `./git.ts` import and, beside the other module-level decoders, `const decodeCancelCloneInput = Schema.decodeUnknownSync(GitCancelCloneInput);`. Append inside `describe("clone re-attach contracts", …)`:

```ts
  it("cancels by the clone's own input so only the server derives the destination", () => {
    expect(
      decodeCancelCloneInput({ url: "https://example.test/demo.git", parentDir: "~/code" }),
    ).toEqual({ url: "https://example.test/demo.git", parentDir: "~/code" });
  });
```

In `packages/contracts/src/rpc.test.ts`, add `WsVcsCancelCloneRpc` to the `./rpc.ts` import. Next to the other module-level decoders, add:

```ts
const decodeCancelCloneSuccess = Schema.decodeUnknownSync(WsVcsCancelCloneRpc.successSchema);
const decodeCancelCloneError = Schema.decodeUnknownSync(WsVcsCancelCloneRpc.errorSchema);
```

Append:

```ts
// The literals are exactly what `cancel_clone_answers_only_its_declared_shapes` in
// apps/server/tests/production_git_vcs_rpc.rs asserts the Rust handler sends.
describe("vcs.cancelClone wire shapes", () => {
  it("decodes every answer the handler sends against the declared union", () => {
    expect(decodeCancelCloneSuccess({ cancelled: true })).toEqual({ cancelled: true });
    expect(decodeCancelCloneSuccess({ cancelled: false })).toEqual({ cancelled: false });
    const unresolvable = decodeCancelCloneError({
      _tag: "GitCommandError",
      operation: "vcs.cancelClone",
      command: "git",
      cwd: "/missing-parent",
      detail: "host path does not exist: /missing-parent",
    });
    expect(unresolvable._tag).toBe("GitCommandError");
  });

  it("has no typed failure for a caller that left: that is the RPC interrupt path", () => {
    expect(() =>
      decodeCancelCloneError({
        _tag: "GitCloneOperationError",
        reason: "cancelled",
        destination: "/code/demo",
        message: "x",
      }),
    ).toThrow();
  });
});
```

Run: `vp test run packages/contracts/src/git.test.ts packages/contracts/src/rpc.test.ts`
Expected: FAIL. `GitCancelCloneInput` and `WsVcsCancelCloneRpc` are not exported.

- [ ] **Step 2: Add the contract**

In `packages/contracts/src/git.ts`, after the `GitCloneInput` type export, add:

```ts
export const GitCancelCloneInput = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
  parentDir: TrimmedNonEmptyStringSchema,
  directoryName: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitCancelCloneInput = typeof GitCancelCloneInput.Type;

export const GitCancelCloneResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type GitCancelCloneResult = typeof GitCancelCloneResult.Type;
```

In `packages/contracts/src/rpc.ts`:

1. Add `GitCancelCloneInput` and `GitCancelCloneResult` to the `./git.ts` import block.
2. After `vcsClone: "vcs.clone",` (401), add `vcsCancelClone: "vcs.cancelClone",`.
3. After `WsVcsCloneRpc`, add:

```ts
export const WsVcsCancelCloneRpc = Rpc.make(WS_METHODS.vcsCancelClone, {
  payload: GitCancelCloneInput,
  success: GitCancelCloneResult,
  error: Schema.Union([GitCommandError, EnvironmentRpcError]),
});
```

4. In `WsRpcGroup`, add `WsVcsCancelCloneRpc,` directly after `WsVcsCloneRpc,`.

Run the two contract test files again. Expected: PASS.

- [ ] **Step 3: Update the fixture pins**

Read the current manifest numbers first (the Task 1 command). After Task 1 they are `131 289 390 360`, or `131 289 391 360` if liveness Task 11 has landed. Apply these deltas:

| Pin | Delta | Target (from 131/289/390/360) |
| --- | --- | --- |
| RPC methods | +1 (`vcs.cancelClone`) | 132 |
| Typed failures | +2 (`vcs__cancelClone-00`, `vcs__cancelClone-01`) | 291 |
| Fixtures | +2 | 392 (393 after liveness Task 11) |
| Schema fingerprints | +2 | 362 |
| Streaming methods | 0 | 20 |

Edit these literals:
- `packages/contracts/scripts/export-rust-rpc-fixtures.ts`: `methods.length !== 131` and `typedFailureFixtures.length !== 289`, with their messages.
- `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`: `toHaveLength(131)`, the typed-failure, fixture, and fingerprint lengths. Beside the Task 1 assertion, add:

  ```ts
      expect(manifest.typedFailureFixtures).toEqual(
        expect.arrayContaining([
          "typed-failures/vcs__cancelClone-00.json",
          "typed-failures/vcs__cancelClone-01.json",
        ]),
      );
  ```

- `apps/server/tests/rpc_wire.rs`: `assert_eq!(rust_methods.len(), 131);` and `manifest.typed_failure_fixtures.len(), 289`.

Run: `vp test run packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing Rust tests**

In `apps/server/src/auth/scope.rs`, in the scope test, add after the activity loop (~283-292):

```rust
        assert_eq!(
            required_scope("vcs.cancelClone"),
            Some(SCOPE_ORCHESTRATION_OPERATE),
            "cancelling a clone needs the same scope as starting one"
        );
```

Append to `mod tests` in `apps/server/src/production/clone_operations.rs`:

```rust
    async fn cancel(harness: &Harness, url: &str, leaf: &str) -> bool {
        timeout(DEADLINE, harness.runtime.cancel(url, &harness.parent, leaf))
            .await
            .expect("the cancel answered")
    }

    fn spawn_cancel(harness: &Harness, leaf: &'static str) -> tokio::task::JoinHandle<bool> {
        let runtime = harness.runtime.clone();
        let (url, parent) = (harness.url.clone(), harness.parent.clone());
        tokio::spawn(async move { runtime.cancel(&url, &parent, leaf).await })
    }

    #[tokio::test]
    async fn cancel_stops_git_waits_for_the_cleanup_and_answers_true() {
        let harness = standard();
        harness.runner.hold_after_cancel.store(true, Ordering::SeqCst);
        let destination = harness.parent.join("cancelled");
        assert!(!cancel(&harness, &harness.url, "cancelled").await, "nothing to cancel yet");

        let starter = spawn_clone(&harness, request(&harness, &harness.url, "cancelled"));
        transfer_started(&harness).await;
        assert!(
            !cancel(&harness, &harness.other_url, "cancelled").await,
            "another URL's cancel is ignored"
        );
        assert!(destination.is_dir(), "and leaves the clone alone");

        let cancelling = spawn_cancel(&harness, "cancelled");
        timeout(DEADLINE, harness.runner.cancel_held.notified())
            .await
            .expect("the cancel stopped Git");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!cancelling.is_finished(), "the cancel waits for the cleanup");
        assert!(destination.is_dir());
        harness.runner.release_cancelled.add_permits(1);
        assert!(
            timeout(DEADLINE, cancelling).await.expect("answered").expect("no panic"),
            "the clone was cancelled"
        );
        assert!(!destination.exists(), "the answer came after the cleanup");
        assert!(harness.parent.is_dir(), "only the created folder was removed");
        assert_eq!(reason(&finished(starter).await.expect_err("cancelled")), "cancelled");
        assert!(
            !cancel(&harness, &harness.url, "cancelled").await,
            "idempotent: nothing is live any more"
        );
    }

    #[tokio::test]
    async fn a_cancel_after_git_succeeded_keeps_the_clone_and_answers_false() {
        let (pauses, transferred) = TestPauses::at(PausePoint::AfterTransfer);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let destination = harness.parent.join("won");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "won"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        timeout(DEADLINE, transferred.arrived())
            .await
            .expect("Git finished the transfer");
        // The cancel lands after Git succeeded, before the clone's task looks at the result.
        let cancelling = spawn_cancel(&harness, "won");
        wait_until(|| harness.runtime.waiters(&destination) == 2, "the cancel waits on the clone")
            .await;
        transferred.release();
        assert!(
            !timeout(DEADLINE, cancelling).await.expect("answered").expect("no panic"),
            "Git had already succeeded"
        );
        assert_eq!(finished(starter).await.expect("the clone succeeded"), destination);
        assert!(destination.join(".git").is_dir(), "a finished clone is never touched");
    }

    #[tokio::test]
    async fn a_dropped_cancel_still_cancels_and_its_outcome_is_retained() {
        let harness = standard();
        harness.runner.hold_after_cancel.store(true, Ordering::SeqCst);
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "dropped"));
        transfer_started(&harness).await;
        leave(starter).await;
        let cancelling = spawn_cancel(&harness, "dropped");
        timeout(DEADLINE, harness.runner.cancel_held.notified())
            .await
            .expect("the cancel stopped Git");
        // The RPC interruption path drops the handler: only its wait ends.
        cancelling.abort();
        let _ = cancelling.await;
        harness.runner.release_cancelled.add_permits(1);
        wait_until(|| harness.runtime.live() == 0, "the clone finished").await;
        let retained = call(&harness, attach(request(&harness, &harness.url, "dropped")))
            .await
            .expect_err("retained");
        assert_eq!(reason(&retained), "cancelled");
    }

    #[tokio::test]
    async fn cancel_sweeps_expired_outcomes() {
        let harness = harness(Limits {
            retention: Duration::from_millis(500),
            ..Limits::default()
        });
        let first = spawn_clone(&harness, undetached(request(&harness, &harness.url, "expiring")));
        transfer_started(&harness).await;
        leave(first).await;
        wait_until(|| harness.runtime.retained_len() == 1, "retained").await;
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(!cancel(&harness, &harness.url, "elsewhere").await);
        assert_eq!(harness.runtime.retained_len(), 0, "the cancel swept the expired outcome");
    }
```

In `apps/server/tests/production_git_vcs_rpc.rs`:

1. Add `"vcs.cancelClone",` after `"vcs.clone",` in `registrar_owns_the_complete_git_vcs_rpc_surface` (line 170).
2. Append this helper after `failure_of`:

```rust
fn success_of(exit: &RpcExit) -> Value {
    match exit {
        RpcExit::Success { value } => value.clone().unwrap_or(Value::Null),
        exit => panic!("expected success, got {exit:?}"),
    }
}
```

3. Append the tests:

```rust
#[tokio::test]
async fn cancel_clone_from_a_new_socket_stops_a_detached_clone_and_removes_only_its_folder() {
    let parallelism_permit = acquire_git_rpc_fixture().await;
    if relaunch_with_isolated_git_config(
        "cancel_clone_from_a_new_socket_stops_a_detached_clone_and_removes_only_its_folder",
    ) {
        return;
    }
    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    run_git_in(root.path(), &["config", "--global", "http.proxy", ""]);
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");
    let (remote, url) = stalled_http_remote().await;
    let destination = clone_parent.join("detached");
    let clone = json!({ "url": url, "parentDir": clone_parent, "directoryName": "detached" });
    let mut server = GitServerHarness::start(&temp, parallelism_permit).await;

    request(server.socket(), "741", "vcs.clone", with_flags(&clone, false, true)).await;
    let mut connection = accept_git(&remote).await;
    server.reconnect().await;
    let attach = with_flags(&clone, true, true);
    request(server.socket(), "742", "vcs.clone", attach.clone()).await;
    assert_no_reply(server.socket(), "the attach waits for the clone").await;

    request(server.socket(), "743", "vcs.cancelClone", clone.clone()).await;
    wait_for_connection_close(&mut connection, "vcs.cancelClone").await;
    let exits = next_exits(server.socket(), 2).await;
    assert_eq!(success_of(&exits["743"]), json!({ "cancelled": true }));
    let cancelled = failure_of(&exits["742"]);
    assert_eq!(cancelled["_tag"], "GitCloneOperationError");
    assert_eq!(cancelled["reason"], "cancelled");
    assert!(!destination.exists(), "the cancel answered after the cleanup");
    assert!(clone_parent.is_dir(), "only the created folder was removed");

    // Idempotent, and a re-attach within five minutes gets the real reason.
    request(server.socket(), "744", "vcs.cancelClone", clone).await;
    assert_success_eq(server.socket(), "744", json!({ "cancelled": false })).await;
    request(server.socket(), "745", "vcs.clone", attach).await;
    assert_eq!(failure_value(server.socket(), "745").await["reason"], "cancelled");

    server.shutdown().await;
}

#[tokio::test]
async fn cancel_clone_answers_only_its_declared_shapes() {
    let parallelism_permit = acquire_git_rpc_fixture().await;
    if relaunch_with_isolated_git_config("cancel_clone_answers_only_its_declared_shapes") {
        return;
    }
    let temp = TempDir::new().expect("temporary server directory");
    let root = TempDir::new().expect("temporary fixture root");
    run_git_in(root.path(), &["config", "--global", "http.proxy", ""]);
    let clone_parent = root.path().join("clones");
    fs::create_dir(&clone_parent).expect("clone parent");
    let (remote, url) = stalled_http_remote().await;
    let mut server = GitServerHarness::start(&temp, parallelism_permit).await;

    // Nothing live: exactly {"cancelled": false}.
    let none = json!({ "url": url, "parentDir": clone_parent, "directoryName": "none" });
    request(server.socket(), "751", "vcs.cancelClone", none).await;
    assert_eq!(success_value(server.socket(), "751").await, json!({ "cancelled": false }));

    // An unresolvable parent: a GitCommandError with exactly the handler's fields.
    let missing = json!({ "url": url, "parentDir": root.path().join("missing-parent") });
    request(server.socket(), "752", "vcs.cancelClone", missing).await;
    let error = failure_value(server.socket(), "752").await;
    let mut keys = error
        .as_object()
        .expect("an error object")
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(keys, ["_tag", "command", "cwd", "detail", "operation"]);
    assert_eq!(error["_tag"], "GitCommandError");
    assert_eq!(error["operation"], "vcs.cancelClone");
    assert_eq!(error["command"], "git");

    // A live clone: exactly {"cancelled": true}.
    let live = json!({ "url": url, "parentDir": clone_parent, "directoryName": "live" });
    request(server.socket(), "753", "vcs.clone", with_flags(&live, false, true)).await;
    let mut connection = accept_git(&remote).await;
    request(server.socket(), "754", "vcs.cancelClone", live).await;
    wait_for_connection_close(&mut connection, "vcs.cancelClone").await;
    let exits = next_exits(server.socket(), 2).await;
    assert_eq!(success_of(&exits["754"]), json!({ "cancelled": true }));
    assert_eq!(failure_of(&exits["753"])["reason"], "cancelled");

    server.shutdown().await;
}
```

Run: `cargo test -p bibcode-server --lib -- auth::scope::tests production::clone_operations::tests::cancel production::clone_operations::tests::a_cancel_after production::clone_operations::tests::a_dropped_cancel`
Expected: FAIL to compile (`CloneRuntime::cancel` does not exist).

- [ ] **Step 5: Implement the runtime cancel**

In `apps/server/src/production/clone_operations.rs`, add inside `impl CloneRuntime`, after `start_or_join`:

```rust
    /// Cancels the live clone of `url` into this destination and waits until its outcome is
    /// published, which happens after Git has stopped and the folder it created is gone.
    /// `true` when that clone did not finish successfully: it ended cancelled, or as a failure
    /// naming a folder it could not remove. `false` when no clone of that URL was live, or Git
    /// had already succeeded; a finished clone is never touched. A caller that leaves drops
    /// this future, and the RPC layer reports that as an interrupt. The clone stays cancelled.
    pub(crate) async fn cancel(&self, url: &str, parent_dir: &Path, leaf: &str) -> bool {
        let destination = parent_dir.join(leaf);
        let receiver = {
            let mut state = self.lock();
            state.sweep(Instant::now());
            let Some(entry) = state
                .entries
                .get(&destination_key(&destination))
                .filter(|entry| entry.is_live() && entry.url == url)
            else {
                return false;
            };
            entry.root.cancel();
            entry.phase.subscribe()
        };
        !matches!(
            wait_finished(receiver, &destination).await,
            CloneOutcome::Succeeded(_)
        )
    }
```

- [ ] **Step 6: Register the method and the handler**

In `apps/server/src/rpc/methods.rs`, insert `mutation_unary("vcs.cancelClone"),` directly **before** `mutation_unary("vcs.clone"),` (167). The TypeScript manifest sorts by `localeCompare`, and `vcs.cancelClone` sorts first.

In `apps/server/src/auth/scope.rs`, add `| "vcs.cancelClone"` directly before `| "vcs.clone"` (116).

In `apps/server/src/production/git_vcs.rs`:

1. In `GIT_VCS_UNARY_METHODS`, add `"vcs.cancelClone",` after `"vcs.clone",`.
2. After the `"vcs.clone"` arm, add:

```rust
            "vcs.cancelClone" => {
                let input: CancelCloneInput = decode(request.payload, "vcs.cancelClone")?;
                let parent_dir = resolve_host_directory(&input.parent_dir, false)
                    .await
                    .map_err(|error| {
                        vcs_error("vcs.cancelClone", &input.parent_dir, &error.to_string())
                    })?;
                let leaf = clone_destination_leaf(&input.url, input.directory_name.as_deref());
                let cancelled = self
                    .clone_operations
                    .cancel(&input.url, &parent_dir, &leaf)
                    .await;
                Ok(json!({ "cancelled": cancelled }))
            }
```

3. After `struct CloneInput`, add:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelCloneInput {
    url: String,
    parent_dir: PathBuf,
    directory_name: Option<String>,
}
```

- [ ] **Step 7: Regenerate the fixtures and run everything green**

Run the temporary-index contract gate from Task 1 Step 6.
Expected: status shows `?? …/typed-failures/vcs__cancelClone-00.json` and `-01.json` (a `GitCommandError` and an `EnvironmentRpcError` member), plus ` M …/manifest.json`, and `vp run check:contracts` exits **0**. Report `check:contracts: PASS (exit 0, temporary fixture index)`.

Run: `cargo test -p bibcode-server --lib -- auth::scope::tests production::clone_operations production::git_vcs`
Expected: `test result: ok.` (17 runtime tests).

Run: `cargo test -p bibcode-server --test production_git_vcs_rpc --test production_control --test rpc_wire`
Expected: `test result: ok.` `production_control`'s complete-registry tests include the new method.

Run: `vp test run packages/contracts/src/git.test.ts packages/contracts/src/rpc.test.ts packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`
Expected: PASS.

- [ ] **Step 8: Capture the red evidence**

| Test | Deliberate break | Expected red |
| --- | --- | --- |
| `cancel_stops_git_waits_for_the_cleanup_and_answers_true` | `return true;` right after `entry.root.cancel()` | "the cancel waits for the cleanup" |
| `a_cancel_after_git_succeeded_keeps_the_clone_and_answers_false` | Answer `true` whenever a live entry was found | "Git had already succeeded" |
| same test | In `run_clone`, treat a cancelled root as `Cancelled` even after a successful transfer | The folder is removed and the answer is `true` |
| `a_dropped_cancel_still_cancels_and_its_outcome_is_retained` | Cancel the root only after `wait_finished` returns | `cancel_held` never fires: "the cancel stopped Git" times out |
| `cancel_sweeps_expired_outcomes` | Remove `state.sweep(…)` from `cancel` | `retained_len()` is 1 |
| `cancel_clone_from_a_new_socket_stops_a_detached_clone_and_removes_only_its_folder` | Have the handler answer `{"cancelled": false}` without calling `cancel` | "interrupting vcs.cancelClone did not stop Git" (timeout in `wait_for_connection_close`) |
| `cancel_clone_answers_only_its_declared_shapes` | Add a `"reason"` field to the handler's answer | The exact `{"cancelled": false}` assertion fails |
| `has no typed failure for a caller that left…` (TS) | Add `GitCloneOperationError` to `WsVcsCancelCloneRpc`'s union | `toThrow` fails |

- [ ] **Step 9: Task gate**

Run: `cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: exit 0.

Run: `cargo fmt --all --check` and `vp check`
Expected: exit 0.

- [ ] **Step 10: Checkpoint**

Record the checkpoint tree hash, results, and red evidence in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 6: Drain clones at shutdown and advertise `vcsCloneReattach`

`close_and_drain` lands with its only caller, the production runtime's shutdown. The capability is advertised here, in the last server task, so no intermediate checkpoint advertises re-attach without the shutdown cleanup.

**Files:**
- Modify: `apps/server/src/production/clone_operations.rs`:
  - `ShuttingDown` reason, `closed` flag, `drained` notify, and `close_and_drain`;
  - `BeforeReserve` pause point;
  - tests.
- Modify: `apps/server/src/production/git_vcs.rs` (`clone_operations()` accessor after `worktree_removal_tasks()` at 433-435)
- Modify: `apps/server/src/production/runtime.rs`:
  - the import at 41;
  - the `ProductionRuntime` field list, `worktree_removal_tasks` at 108;
  - the construction at 326-335;
  - the struct literal at ~486;
  - `quiesce_for_update` at 606-639, drain line at 621.

  The PR-panel agent edits this file concurrently. Re-read these symbols first and edit only these four places.
- Modify: `apps/server/src/lifecycle.rs` (59-64; test 808-822), `apps/server/src/production/control.rs` (2152-2172; test ~5070-5076)
- Test: `apps/server/tests/production_maintenance.rs`

**Interfaces:**
- Consumes: Task 4's runtime and Task 5's `cancel`.
- Produces:
  - `pub(crate) async fn close_and_drain(&self)`;
  - `GitVcsRpcServices::clone_operations(&self) -> CloneRuntime` (`pub(crate)`);
  - `GitCloneOperationError { reason: "shutting-down" }` for starts and for attaches without a retained outcome (D9);
  - `vcsCloneReattach: true` in both environment descriptors.
- Shutdown, and a failed update preparation that shuts the backend down (`maintenance.rs:448`), both stop every live clone and remove its partial folder before the runtime finishes.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `apps/server/src/production/clone_operations.rs`:

```rust
    #[tokio::test]
    async fn shutdown_stops_live_clones_removes_their_folders_and_refuses_new_ones() {
        let harness = standard();
        // A failure retained before shutdown still answers a re-attach afterwards (D9).
        let missing = harness.missing_url();
        let failing = spawn_clone(&harness, request(&harness, &missing, "failed-before"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        let failure = finished(failing).await.expect_err("a missing remote fails");

        let destination = harness.parent.join("shutdown");
        let running = spawn_clone(&harness, request(&harness, &harness.url, "shutdown"));
        transfer_started(&harness).await;
        timeout(DEADLINE, harness.runtime.close_and_drain())
            .await
            .expect("the drain finished");
        assert!(!destination.exists(), "Git stopped and the partial folder is gone first");
        assert_eq!(reason(&finished(running).await.expect_err("cancelled")), "cancelled");
        for refused in [
            request(&harness, &harness.url, "late"),
            attach(request(&harness, &harness.url, "late")),
        ] {
            assert_eq!(reason(&call(&harness, refused).await.expect_err("closed")), "shutting-down");
        }
        assert!(!harness.parent.join("late").exists());
        assert_eq!(
            call(&harness, attach(request(&harness, &missing, "failed-before")))
                .await
                .expect_err("retained"),
            failure
        );
    }

    #[tokio::test]
    async fn shutdown_waits_for_a_clone_admitted_just_before_it_and_that_clone_creates_no_folder() {
        let (pauses, reserve) = TestPauses::at(PausePoint::BeforeReserve);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let raced = spawn_clone(&harness, request(&harness, &harness.url, "raced"));
        timeout(DEADLINE, reserve.arrived())
            .await
            .expect("the clone was admitted");
        let runtime = harness.runtime.clone();
        let drain = tokio::spawn(async move { runtime.close_and_drain().await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!drain.is_finished(), "the drain waits for the admitted clone");
        reserve.release();
        timeout(DEADLINE, drain).await.expect("the drain finished").expect("no panic");
        assert!(
            !harness.parent.join("raced").exists(),
            "a clone cancelled before reserving creates no folder"
        );
        assert_eq!(reason(&finished(raced).await.expect_err("cancelled")), "cancelled");
        assert_eq!(harness.runner.clones.load(Ordering::SeqCst), 0, "Git never ran");
    }
```

In `apps/server/src/lifecycle.rs` (`connect_descriptor_advertises_remote_update_support`, ~818) and `apps/server/src/production/control.rs` (`environment_descriptor_advertises_remote_update_control_and_support`, ~5075), add:

```rust
        assert_eq!(descriptor["capabilities"]["vcsCloneReattach"], true);
```

Append to `apps/server/tests/production_maintenance.rs`:

```rust
/// Exchanges the desktop bootstrap token and opens an authenticated RPC socket.
async fn authenticated_socket(
    server: &bibcode_server::ServerHandle,
    bootstrap: &str,
) -> tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
> {
    let base = format!("http://{}", server.local_addr());
    let client = reqwest::Client::new();
    let token = client
        .post(format!("{base}/oauth/token"))
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"),
            ("subject_token", bootstrap),
            ("subject_token_type", "urn:bibcode:params:oauth:token-type:environment-bootstrap"),
            ("requested_token_type", "urn:ietf:params:oauth:token-type:access_token"),
        ])
        .send()
        .await
        .expect("bootstrap exchange")
        .json::<Value>()
        .await
        .expect("bootstrap exchange JSON")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    let ticket = client
        .post(format!("{base}/api/auth/websocket-ticket"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("ticket response")
        .json::<Value>()
        .await
        .expect("ticket JSON")["ticket"]
        .as_str()
        .expect("ticket")
        .to_owned();
    connect_async(format!("ws://{}/ws?wsTicket={ticket}", server.local_addr()))
        .await
        .expect("authenticated socket")
        .0
}

#[tokio::test]
async fn shutdown_stops_a_detached_clone_and_removes_its_folder() {
    use tokio::io::AsyncReadExt;

    let root = tempfile::tempdir().expect("data root");
    disable_provider_processes(root.path());
    let clones = tempfile::tempdir().expect("clone parent");
    let destination = clones.path().join("detached");
    // `git://` has no HTTP proxy, so a host proxy setting cannot divert Git away from this
    // listener. The listener accepts and never answers, so the clone runs until stopped.
    let remote = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stalled remote");
    let url = format!("git://{}/stalled.git", remote.local_addr().expect("address"));
    let bootstrap = "clone-shutdown-bootstrap";
    let server = ServerRuntime::start(desktop_config(root.path(), bootstrap))
        .await
        .expect("desktop runtime");
    let mut socket = authenticated_socket(&server, bootstrap).await;

    socket
        .send(Message::Text(
            json!({
                "_tag": "Request", "id": "1", "tag": "vcs.clone", "headers": [],
                "payload": { "url": url, "parentDir": clones.path(), "directoryName": "detached", "detach": true }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("clone request");
    let (mut connection, _) = timeout(Duration::from_secs(30), remote.accept())
        .await
        .expect("Git connects")
        .expect("accept Git");
    assert!(destination.is_dir(), "the clone created its destination");
    // The client leaves; the detached clone keeps running until shutdown.
    let _ = socket.close(None).await;

    server.shutdown();
    timeout(Duration::from_secs(60), server.join())
        .await
        .expect("shutdown finishes")
        .expect("server joins");
    assert!(!destination.exists(), "shutdown removed the partial folder before finishing");
    let mut buffer = [0_u8; 1024];
    let closed = timeout(Duration::from_secs(5), async {
        loop {
            match connection.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "Git was stopped");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bibcode-server --lib -- production::clone_operations::tests::shutdown lifecycle::tests::connect_descriptor production::control::tests::environment_descriptor_advertises_remote_update`
Expected: FAIL. The shutdown tests fail to compile (`close_and_drain`, `PausePoint::BeforeReserve`), and the descriptors lack `vcsCloneReattach`.

Run: `cargo test -p bibcode-server --test production_maintenance -- shutdown_stops_a_detached_clone`
Expected: FAIL at `assert!(!destination.exists(), …)`. Nothing drains the clone runtime, so no one removes the folder. The process-group guard kills Git only as the runtime drops. If the runtime hangs instead, the 60 s `timeout` fails; either failure proves the gap.

- [ ] **Step 3: Implement the drain**

In `apps/server/src/production/clone_operations.rs`:

1. Imports: `use tokio::{sync::{Notify, watch}, time::Instant};`.
2. Add `ShuttingDown` to `CloneOperationReason`, with `Self::ShuttingDown => "shutting-down"` in `wire` and `Self::ShuttingDown => "The server is shutting down.".to_owned()` in `message`.
3. Add `closed: bool,` as the first field of `CloneRuntimeState`.
4. Add `drained: Notify,` after `state` in `CloneRuntimeInner`, and `drained: Notify::new(),` after `state: Mutex::default(),` in both `new` and `for_test`.
5. In `admit`, directly before `if request.attach { return Admission::Inspect { … } }`, add:

```rust
        // Closed: a retained outcome above still answers (D9); nothing new starts or inspects.
        if state.closed {
            return Admission::Refused(CloneOperationReason::ShuttingDown);
        }
```

6. In `finish`, replace the last two statements (`state.live = …; state.sweep(…);`) with:

```rust
        state.live = state.live.saturating_sub(1);
        state.sweep(Instant::now());
        let drained = state.live == 0;
        drop(state);
        if drained {
            self.inner.drained.notify_waiters();
        }
```

7. Add inside `impl CloneRuntime`:

```rust
    /// Shutdown: refuse new clones, cancel every live one, and wait until each has published
    /// its outcome, which happens after Git stopped and the folder it created was removed.
    pub(crate) async fn close_and_drain(&self) {
        {
            let mut state = self.lock();
            state.closed = true;
            for entry in state.entries.values().filter(|entry| entry.is_live()) {
                entry.root.cancel();
            }
        }
        loop {
            let notified = self.inner.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.lock().live == 0 {
                return;
            }
            notified.await;
        }
    }
```

8. Add the variant to `test_pauses::PausePoint`:

```rust
        /// In the clone's task, before it reserves the destination.
        BeforeReserve,
```

Then add its wait as the first statement of `run_clone`, before the `root.is_cancelled()` check:

```rust
        #[cfg(test)]
        self.inner
            .pauses
            .wait(test_pauses::PausePoint::BeforeReserve)
            .await;
```

In `apps/server/src/production/git_vcs.rs`, after `pub(crate) fn worktree_removal_tasks(&self) …`, add:

```rust
    pub(crate) fn clone_operations(&self) -> CloneRuntime {
        self.clone_operations.clone()
    }
```

In `apps/server/src/production/runtime.rs`:

1. Import `CloneRuntime` beside the `git_vcs::{…}` import (line 41), as `clone_operations::CloneRuntime` in the same `production::{…}` group, or through the existing `super::` path this file uses.
2. Field: add `clone_operations: CloneRuntime,` after `worktree_removal_tasks: WorktreeRemovalTaskTracker,` (108).
3. Construction: after `let worktree_removal_tasks = git_vcs.worktree_removal_tasks();` (335), add `let clone_operations = git_vcs.clone_operations();`.
4. Struct literal: add `clone_operations,` after `worktree_removal_tasks,` (~486).
5. In `quiesce_for_update`, directly after `self.worktree_removal_tasks.close_and_drain().await;` (621), add:

```rust
        // Stops every live clone, including detached ones, and waits until each removed the
        // folder it created, before providers and terminals shut down.
        self.clone_operations.close_and_drain().await;
```

- [ ] **Step 4: Advertise the capability**

In `apps/server/src/lifecycle.rs` `connect_environment_descriptor` (59-64) and `apps/server/src/production/control.rs` `environment_descriptor` (2152-2172), add after `"terminalSizeOwnership": true,`:

```rust
            "vcsCloneReattach": true,
```

Open question 1 below asks the controller whether the Connect MCP descriptor in `lifecycle.rs` should carry it. Until the controller rules, follow the spec.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p bibcode-server --lib -- production::clone_operations lifecycle::tests production::control::tests::environment_descriptor`
Expected: `test result: ok.` (19 runtime tests and the descriptor tests).

Run: `cargo test -p bibcode-server --test production_maintenance --test production_git_vcs_rpc`
Expected: `test result: ok.`

- [ ] **Step 6: Capture the red evidence**

| Test | Deliberate break | Expected red |
| --- | --- | --- |
| `shutdown_stops_live_clones_removes_their_folders_and_refuses_new_ones` | Skip `entry.root.cancel()` in `close_and_drain` | The drain never finishes: "the drain finished" times out |
| `shutdown_waits_for_a_clone_admitted_just_before_it_and_that_clone_creates_no_folder` | Return from `close_and_drain` right after setting `closed` | "the drain waits for the admitted clone" |
| same test | Remove the `root.is_cancelled()` check before reserving | "Git never ran": `clones` is 1 |
| `shutdown_stops_a_detached_clone_and_removes_its_folder` | Omit the `runtime.rs` drain line | "shutdown removed the partial folder before finishing" (Step 2's red) |

- [ ] **Step 7: Task gate**

Run: `cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: exit 0.

Run: `cargo fmt --all --check`
Expected: exit 0.

- [ ] **Step 8: Checkpoint**

Record the checkpoint tree hash, results, and red evidence in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

## Phase 3 — Client runtime

### Task 7: The re-attach loop, the pending-cancel registry, and the capability-gated cancel

**Files:**
- Create: `packages/client-runtime/src/state/vcsClone.ts`
- Test: `packages/client-runtime/src/state/vcsClone.test.ts`

**Interfaces:**
- Consumes (read only):
  - `packages/client-runtime/src/rpc/client.ts`: `currentSession`, `requestInSession(session, environmentId, tag, input)`, `EnvironmentRpcUnavailableError`;
  - `EnvironmentSupervisor` (`target`, `session: SubscriptionRef<Option<RpcSession>>`, `state: SubscriptionRef<SupervisorConnectionState>`);
  - `RpcSession.initialConfig` (capabilities);
  - Task 1's and Task 5's contracts (`GitCloneOperationError`, `GitCancelCloneInput`, `WS_METHODS.vcsCancelClone`).
- Produces (used by Tasks 8-10):

```ts
export interface VcsCloneProgress {
  readonly phase: "cloning" | "reconnecting";
  readonly reattach: boolean;
}
export interface VcsCloneCommandInput {
  readonly url: string;
  readonly parentDir: string;
  readonly directoryName?: string | undefined;
  readonly onProgress?: ((progress: VcsCloneProgress) => void) | undefined;
}
export class VcsCloneStoppedError /* _tag "VcsCloneStoppedError"; environmentId; reason: "environment-unavailable" | "reattach-unsupported"; message */ {}
export function isCloneTransportLoss(cause: Cause.Cause<unknown>): boolean;
export const cloneWithReattach: (input: VcsCloneCommandInput) => Effect.Effect<GitCloneResult, …, EnvironmentSupervisor>;
export const cancelCloneOnNextSession: (input: GitCancelCloneInput) => Effect.Effect<GitCancelCloneResult, …, EnvironmentSupervisor>;

export interface CloneDestinationInput {
  readonly url: string;
  readonly parentDir: string;
  readonly directoryName?: string | undefined;
}
/** The server's leaf rule: `directoryName`, else the URL's last segment without `.git`. */
export function cloneDestinationLeaf(url: string, directoryName: string | undefined): string;
/** Environment + parent folder as sent (trailing separators ignored) + leaf. */
export function cloneDestinationKey(environmentId: string, input: CloneDestinationInput): string;
/** Records a cancel in flight for this destination; the returned function ends the record. */
export function registerCloneCancel(environmentId: string, input: CloneDestinationInput): () => void;
```

**Pending-cancel registry** (controller ruling, round 2): cancel ownership lives here, not in the dialog.
- A module-level registry records every `vcs.cancelClone` still in flight, keyed by environment and destination. Task 8's command registers synchronously when invoked and ends the record when the command settles: acknowledged, stopped, or failed.
- `cloneWithReattach` waits until no cancel for its destination is pending before it dispatches anything. A dialog that unmounted and remounted therefore cannot start a clone that an old, still-retrying cancel would stop; the server keys the cancel by destination (spec ruling 5).
- Unmount never abandons a registered cancel.
- The key is lexical (the parent folder as the dialog sends it, with trailing separators ignored), because only the server can canonicalize. The server's own key still serializes aliases.
- The registry is per client runtime (one tab or desktop window). Another window's pending cancel is not visible here, the same limit as the spec's mixed-client residual.

`cancelCloneOnNextSession` sends `vcs.cancelClone` only on a session whose `initialConfig` advertises `vcsCloneReattach`. On a session without it (a downgraded host), it ends with `VcsCloneStoppedError { reason: "reattach-unsupported" }` instead of sending, so the dialog never waits forever in **Cancelling…** (pre-flight item 8). A session whose configuration failed is treated as lost: the cancel waits for the next one.

Two facts decide the loop design; both were verified on 2026-09-25:

- `EnvironmentRegistry.run` provides the **supervisor**, which outlives session swaps (`packages/client-runtime/src/connection/registry.ts:417-426`). One command effect can therefore follow several sessions.
- On socket close, Effect's RPC client resumes each pending call with `Exit.interrupt(…)` (`.repos/effect-smol/packages/effect/src/unstable/rpc/RpcClient.ts:286-302`); the calling fiber itself is not interrupted. Inside the loop, `Effect.exit(requestInSession(…))` therefore observes that interrupt as a value while the loop fiber stays alive. An abort (the user's Cancel without the capability, or unmount) instead interrupts the loop fiber itself, so the loop never sees it. This is the discriminator for "an interrupt it did not request".

  The test "re-attaches after every kind of transport loss" models the resumed interrupt with `Effect.failCause(Cause.interrupt())`. If that test shows Effect 4 turning such a cause into fiber interruption, the discriminator fails. **Stop and report**; do not work around it.

- [ ] **Step 1: Write the failing tests**

Create `packages/client-runtime/src/state/vcsClone.test.ts`:

```ts
import { EnvironmentId, GitCloneOperationError, WS_METHODS } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  cancelCloneOnNextSession,
  cloneDestinationKey,
  cloneWithReattach,
  registerCloneCancel,
  type VcsCloneProgress,
  VcsCloneStoppedError,
} from "./vcsClone.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const CLONE = { url: "https://example.test/demo.git", parentDir: "/code" } as const;
const CONNECTED: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
};
const LOST_SOCKET = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({
    message: "socket closed",
    cause: new Error("socket closed"),
  }),
});

type Answer = Effect.Effect<unknown, unknown>;

function session(
  capable: boolean | undefined,
  methods: {
    readonly clone?: (input: unknown) => Answer;
    readonly cancel?: (input: unknown) => Answer;
  },
): RpcSession {
  const capabilities = capable === undefined ? {} : { vcsCloneReattach: capable };
  return {
    client: {
      [WS_METHODS.vcsClone]: methods.clone ?? (() => Effect.never),
      [WS_METHODS.vcsCancelClone]: methods.cancel ?? (() => Effect.never),
    } as unknown as WsRpcProtocolClient,
    initialConfig: Effect.succeed({ environment: { capabilities } } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
}

const makeSupervisor = Effect.fn("TestVcsClone.makeSupervisor")(function* (
  initial: RpcSession | null,
) {
  const sessionRef = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
    initial === null ? Option.none() : Option.some(initial),
  );
  const stateRef = yield* SubscriptionRef.make<SupervisorConnectionState>(CONNECTED);
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID, label: "Remote" },
    session: sessionRef,
    state: stateRef,
  } as never);
  return { supervisor, sessionRef, stateRef };
});

function waitFor(predicate: () => boolean, message: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(message);
  });
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): unknown {
  return Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
}

describe("cloneWithReattach", () => {
  it.effect("sends today's single call without fields when the server lacks the capability", () =>
    Effect.gen(function* () {
      const inputs: Array<unknown> = [];
      const { supervisor } = yield* makeSupervisor(
        session(undefined, {
          clone: (input) => {
            inputs.push(input);
            return Effect.succeed({ path: "/code/demo" });
          },
        }),
      );
      const progress: Array<VcsCloneProgress> = [];
      const result = yield* cloneWithReattach({
        ...CLONE,
        onProgress: (next) => progress.push(next),
      }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ path: "/code/demo" });
      expect(inputs).toEqual([CLONE]);
      expect(progress).toEqual([{ phase: "cloning", reattach: false }]);
    }),
  );

  it.effect("keeps today's failure on a lost socket without the capability", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { supervisor } = yield* makeSupervisor(
        session(false, {
          clone: () => {
            calls += 1;
            return Effect.fail(LOST_SOCKET);
          },
        }),
      );
      const exit = yield* Effect.exit(
        cloneWithReattach(CLONE).pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
      );
      expect(failureOf(exit)).toBe(LOST_SOCKET);
      expect(calls).toBe(1);
    }),
  );

  it.effect("fails at once when no session exists, as today", () =>
    Effect.gen(function* () {
      const { supervisor } = yield* makeSupervisor(null);
      const exit = yield* Effect.exit(
        cloneWithReattach(CLONE).pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
      );
      expect(failureOf(exit)).toBeInstanceOf(EnvironmentRpcUnavailableError);
    }),
  );

  it.effect("re-attaches on the next session after every kind of transport loss", () =>
    Effect.gen(function* () {
      const inputs: Array<unknown> = [];
      const failing = (failure: Answer) =>
        session(true, {
          clone: (input) => {
            inputs.push(input);
            return failure;
          },
        });
      const first = failing(Effect.fail(LOST_SOCKET));
      const later = [
        // Effect's RPC client resumes a pending call with an interrupt when its socket closes.
        failing(Effect.failCause(Cause.interrupt())),
        failing(
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: ENVIRONMENT_ID,
              message: "Remote is not connected.",
            }),
          ),
        ),
        session(true, {
          clone: (input) => {
            inputs.push(input);
            return Effect.succeed({ path: "/code/demo" });
          },
        }),
      ];
      const { supervisor, sessionRef } = yield* makeSupervisor(first);
      const progress: Array<VcsCloneProgress> = [];
      const fiber = yield* cloneWithReattach({
        ...CLONE,
        onProgress: (next) => progress.push(next),
      }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.forkChild);

      for (let index = 0; index < later.length; index += 1) {
        yield* waitFor(
          () => inputs.length === index + 1 && progress.at(-1)?.phase === "reconnecting",
          `attempt ${index + 1} did not start reconnecting`,
        );
        yield* SubscriptionRef.set(sessionRef, Option.some(later[index]!));
      }

      expect(yield* Fiber.join(fiber)).toEqual({ path: "/code/demo" });
      expect(inputs).toEqual([
        { ...CLONE, detach: true },
        { ...CLONE, detach: true, attach: true },
        { ...CLONE, detach: true, attach: true },
        { ...CLONE, detach: true, attach: true },
      ]);
      expect(progress.map((entry) => entry.phase)).toEqual([
        "cloning",
        "reconnecting",
        "cloning",
        "reconnecting",
        "cloning",
        "reconnecting",
        "cloning",
      ]);
      expect(progress.every((entry) => entry.reattach)).toBe(true);
    }),
  );

  it.effect("returns a typed failure without re-attaching", () =>
    Effect.gen(function* () {
      const busy = new GitCloneOperationError({
        reason: "busy",
        destination: "/code/demo",
        message: "Another clone into /code/demo is in progress.",
      });
      let calls = 0;
      const { supervisor } = yield* makeSupervisor(
        session(true, {
          clone: () => {
            calls += 1;
            return Effect.fail(busy);
          },
        }),
      );
      const exit = yield* Effect.exit(
        cloneWithReattach(CLONE).pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
      );
      expect(failureOf(exit)).toBe(busy);
      expect(calls).toBe(1);
    }),
  );

  it.effect("ends without re-attaching when its own fiber is interrupted", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { supervisor } = yield* makeSupervisor(
        session(true, {
          clone: () => {
            calls += 1;
            return Effect.never;
          },
        }),
      );
      const progress: Array<VcsCloneProgress> = [];
      const fiber = yield* cloneWithReattach({
        ...CLONE,
        onProgress: (next) => progress.push(next),
      }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.forkChild);
      yield* waitFor(() => calls === 1, "the clone call did not start");
      yield* Fiber.interrupt(fiber);
      expect(progress).toEqual([{ phase: "cloning", reattach: true }]);
      expect(calls).toBe(1);
    }),
  );

  for (const [label, stopped] of [
    ["blocked", { ...CONNECTED, phase: "blocked" }],
    ["disconnected by the user", AVAILABLE_CONNECTION_STATE],
  ] as const) {
    it.effect(`stops re-attaching when the environment is ${label}`, () =>
      Effect.gen(function* () {
        const { supervisor, sessionRef, stateRef } = yield* makeSupervisor(
          session(true, { clone: () => Effect.fail(LOST_SOCKET) }),
        );
        const progress: Array<VcsCloneProgress> = [];
        const fiber = yield* cloneWithReattach({
          ...CLONE,
          onProgress: (next) => progress.push(next),
        }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.forkChild);
        yield* waitFor(() => progress.at(-1)?.phase === "reconnecting", "not reconnecting");
        yield* SubscriptionRef.set(sessionRef, Option.none());
        yield* SubscriptionRef.set(stateRef, stopped as SupervisorConnectionState);

        const error = failureOf(yield* Effect.exit(Fiber.join(fiber)));
        expect(error).toBeInstanceOf(VcsCloneStoppedError);
        expect((error as VcsCloneStoppedError).reason).toBe("environment-unavailable");
      }),
    );
  }

  it.effect("reports a session without the capability as stopped and starts nothing there", () =>
    Effect.gen(function* () {
      let legacyCalls = 0;
      const { supervisor, sessionRef } = yield* makeSupervisor(
        session(true, { clone: () => Effect.fail(LOST_SOCKET) }),
      );
      const progress: Array<VcsCloneProgress> = [];
      const fiber = yield* cloneWithReattach({
        ...CLONE,
        onProgress: (next) => progress.push(next),
      }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.forkChild);
      yield* waitFor(() => progress.at(-1)?.phase === "reconnecting", "not reconnecting");
      yield* SubscriptionRef.set(
        sessionRef,
        Option.some(
          session(false, {
            clone: () => {
              legacyCalls += 1;
              return Effect.succeed({ path: "/code/demo" });
            },
          }),
        ),
      );

      const error = failureOf(yield* Effect.exit(Fiber.join(fiber)));
      expect(error).toBeInstanceOf(VcsCloneStoppedError);
      expect((error as VcsCloneStoppedError).reason).toBe("reattach-unsupported");
      expect(legacyCalls).toBe(0);
    }),
  );
});

describe("clone destination keys", () => {
  it("follow the server's leaf rule and ignore trailing separators", () => {
    const key = cloneDestinationKey("env", {
      url: "https://example.test/org/demo.git/",
      parentDir: "/code/",
    });
    expect(cloneDestinationKey("env", { url: "git@example.test:org/demo.git", parentDir: "/code" })).toBe(
      key,
    );
    expect(
      cloneDestinationKey("env", {
        url: "https://example.test/other.git",
        parentDir: "/code",
        directoryName: "demo",
      }),
    ).toBe(key);
    expect(
      cloneDestinationKey("other-env", { url: "https://example.test/org/demo.git", parentDir: "/code" }),
    ).not.toBe(key);
    expect(
      cloneDestinationKey("env", { url: "https://example.test/org/other.git", parentDir: "/code" }),
    ).not.toBe(key);
  });
});

describe("pending clone cancels", () => {
  it.effect("hold a clone into the same folder until every earlier cancel has settled", () =>
    Effect.gen(function* () {
      const inputs: Array<unknown> = [];
      const { supervisor } = yield* makeSupervisor(
        session(true, {
          clone: (input) => {
            inputs.push(input);
            return Effect.succeed({ path: "/code/demo" });
          },
        }),
      );
      const releaseFirst = registerCloneCancel(ENVIRONMENT_ID, CLONE);
      const releaseSecond = registerCloneCancel(ENVIRONMENT_ID, { ...CLONE, parentDir: "/code/" });
      const releaseElsewhere = registerCloneCancel(ENVIRONMENT_ID, {
        ...CLONE,
        directoryName: "elsewhere",
      });
      const fiber = yield* cloneWithReattach(CLONE).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
      expect(inputs).toEqual([]);

      releaseFirst();
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
      expect(inputs).toEqual([]);

      releaseSecond();
      expect(yield* Fiber.join(fiber)).toEqual({ path: "/code/demo" });
      expect(inputs).toEqual([{ ...CLONE, detach: true }]);
      // A cancel for another folder never held this clone.
      releaseElsewhere();
    }),
  );
});

describe("cancelCloneOnNextSession", () => {
  it.effect("waits for a session and re-sends after a lost socket", () =>
    Effect.gen(function* () {
      const inputs: Array<unknown> = [];
      const { supervisor, sessionRef } = yield* makeSupervisor(null);
      const fiber = yield* cancelCloneOnNextSession(CLONE).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
      expect(inputs).toEqual([]);

      yield* SubscriptionRef.set(
        sessionRef,
        Option.some(
          session(true, {
            cancel: (input) => {
              inputs.push(input);
              return Effect.fail(LOST_SOCKET);
            },
          }),
        ),
      );
      yield* waitFor(() => inputs.length === 1, "the cancel did not go out");
      yield* SubscriptionRef.set(
        sessionRef,
        Option.some(
          session(true, {
            cancel: (input) => {
              inputs.push(input);
              return Effect.succeed({ cancelled: true });
            },
          }),
        ),
      );

      expect(yield* Fiber.join(fiber)).toEqual({ cancelled: true });
      expect(inputs).toEqual([CLONE, CLONE]);
    }),
  );

  it.effect("stops when the environment is blocked", () =>
    Effect.gen(function* () {
      const { supervisor, stateRef } = yield* makeSupervisor(null);
      const fiber = yield* cancelCloneOnNextSession(CLONE).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(stateRef, { ...CONNECTED, phase: "blocked" });
      const error = failureOf(yield* Effect.exit(Fiber.join(fiber)));
      expect(error).toBeInstanceOf(VcsCloneStoppedError);
      expect((error as VcsCloneStoppedError).reason).toBe("environment-unavailable");
    }),
  );

  it.effect("reports a host without the capability as stopped instead of sending", () =>
    Effect.gen(function* () {
      let sent = 0;
      const { supervisor, sessionRef } = yield* makeSupervisor(null);
      const fiber = yield* cancelCloneOnNextSession(CLONE).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      // The host came back as a build without re-attach: its restart already ended the clone.
      yield* SubscriptionRef.set(
        sessionRef,
        Option.some(
          session(false, {
            cancel: () => {
              sent += 1;
              return Effect.succeed({ cancelled: true });
            },
          }),
        ),
      );

      const error = failureOf(yield* Effect.exit(Fiber.join(fiber)));
      expect(error).toBeInstanceOf(VcsCloneStoppedError);
      expect((error as VcsCloneStoppedError).reason).toBe("reattach-unsupported");
      expect(sent).toBe(0);
    }),
  );

  it.effect("waits past a session whose configuration failed", () =>
    Effect.gen(function* () {
      const inputs: Array<unknown> = [];
      const broken: RpcSession = {
        ...session(true, {}),
        initialConfig: Effect.fail(
          new ConnectionTransientError({ reason: "transport", detail: "Remote dropped." }),
        ),
      };
      const { supervisor, sessionRef } = yield* makeSupervisor(broken);
      const fiber = yield* cancelCloneOnNextSession(CLONE).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
      yield* SubscriptionRef.set(
        sessionRef,
        Option.some(
          session(true, {
            cancel: (input) => {
              inputs.push(input);
              return Effect.succeed({ cancelled: false });
            },
          }),
        ),
      );

      expect(yield* Fiber.join(fiber)).toEqual({ cancelled: false });
      expect(inputs).toEqual([CLONE]);
    }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/state/vcsClone.test.ts`
Expected: FAIL. `./vcsClone.ts` does not resolve.

- [ ] **Step 3: Implement the loop**

Create `packages/client-runtime/src/state/vcsClone.ts`:

```ts
import {
  type GitCancelCloneInput,
  type GitCancelCloneResult,
  type GitCloneResult,
  WS_METHODS,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  currentSession,
  EnvironmentRpcUnavailableError,
  requestInSession,
} from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";

/** Where a clone stands, reported to the dialog. */
export interface VcsCloneProgress {
  readonly phase: "cloning" | "reconnecting";
  /**
   * The server keeps the clone across reconnects (`vcsCloneReattach`). Cancel and close must
   * then send `vcs.cancelClone`; an abort alone only stops following the clone.
   */
  readonly reattach: boolean;
}

export interface VcsCloneCommandInput {
  readonly url: string;
  readonly parentDir: string;
  readonly directoryName?: string | undefined;
  readonly onProgress?: ((progress: VcsCloneProgress) => void) | undefined;
}

/** The client stopped following a clone; the clone may still run on the server. */
export class VcsCloneStoppedError extends Schema.TaggedError<VcsCloneStoppedError>()(
  "VcsCloneStoppedError",
  {
    environmentId: Schema.String,
    reason: Schema.Literals(["environment-unavailable", "reattach-unsupported"]),
    message: Schema.String,
  },
) {}

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

/**
 * The connection went away before the server answered: an RPC transport error, no session,
 * or the interrupt Effect's RPC client resumes a pending call with when its socket closes.
 * A server answer (any typed failure) is never a transport loss.
 */
export function isCloneTransportLoss(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) =>
        Cause.isInterruptReason(reason) ||
        (Cause.isFailReason(reason) &&
          (isRpcClientError(reason.error) ||
            reason.error instanceof EnvironmentRpcUnavailableError)),
    )
  );
}

type NextSession =
  | { readonly _tag: "Session"; readonly session: RpcSession }
  | { readonly _tag: "Stopped" };

/**
 * Waits, as `subscribe()` does, for a session other than `lost`. Ends as `Stopped` when the
 * environment is blocked or the user disconnected it. No attempt limit and no timer.
 */
function nextSession(
  supervisor: EnvironmentSupervisor["Service"],
  lost: RpcSession | null,
): Effect.Effect<NextSession> {
  return Stream.merge(
    SubscriptionRef.changes(supervisor.session).pipe(
      Stream.filter((current) => Option.isSome(current) && current.value !== lost),
      Stream.map(
        (current): NextSession => ({ _tag: "Session", session: Option.getOrThrow(current) }),
      ),
    ),
    SubscriptionRef.changes(supervisor.state).pipe(
      Stream.filter((state) => state.phase === "blocked" || !state.desired),
      Stream.map((): NextSession => ({ _tag: "Stopped" })),
    ),
  ).pipe(
    Stream.runHead,
    Effect.map(Option.getOrElse((): NextSession => ({ _tag: "Stopped" }))),
  );
}

export interface CloneDestinationInput {
  readonly url: string;
  readonly parentDir: string;
  readonly directoryName?: string | undefined;
}

/** The server's leaf rule (`clone_destination_leaf`): `directoryName`, else the URL's last
 * path segment without a trailing `.git`. */
export function cloneDestinationLeaf(url: string, directoryName: string | undefined): string {
  if (directoryName !== undefined) {
    return directoryName;
  }
  const segments = url.replace(/[\\/]+$/, "").split(/[\\/:]/);
  return (segments.at(-1) ?? "repository").replace(/(?:\.git)+$/, "");
}

/**
 * The client's key for one clone destination: environment, parent folder as sent (trailing
 * separators ignored), and leaf. Lexical on purpose: only the server can canonicalize, and the
 * server's own key still serializes aliases.
 */
export function cloneDestinationKey(environmentId: string, input: CloneDestinationInput): string {
  return JSON.stringify([
    environmentId,
    input.parentDir.replace(/[\\/]+$/, ""),
    cloneDestinationLeaf(input.url, input.directoryName),
  ]);
}

/**
 * `vcs.cancelClone` requests still in flight in this client runtime, by destination key. The
 * server keys a cancel by destination (spec ruling 5), so a cancel that is still retrying could
 * stop a later clone into the same folder: a clone waits here until every earlier cancel for its
 * destination has settled. One registry per client runtime (a tab or a desktop window).
 */
const pendingCloneCancels = new Map<string, Set<Promise<void>>>();

/** Records a cancel in flight for this destination. The returned function ends the record. */
export function registerCloneCancel(environmentId: string, input: CloneDestinationInput): () => void {
  const key = cloneDestinationKey(environmentId, input);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const pending = pendingCloneCancels.get(key) ?? new Set<Promise<void>>();
  pending.add(settled);
  pendingCloneCancels.set(key, pending);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pending.delete(settled);
    if (pending.size === 0 && pendingCloneCancels.get(key) === pending) {
      pendingCloneCancels.delete(key);
    }
    settle();
  };
}

const awaitPendingCloneCancels = Effect.fn("Vcs.awaitPendingCloneCancels")(function* (
  environmentId: string,
  input: CloneDestinationInput,
) {
  const key = cloneDestinationKey(environmentId, input);
  while (true) {
    const pending = pendingCloneCancels.get(key);
    if (pending === undefined || pending.size === 0) {
      return;
    }
    const snapshot = [...pending];
    yield* Effect.promise(() => Promise.all(snapshot));
  }
});

function cloneFields(input: VcsCloneCommandInput) {
  return {
    url: input.url,
    parentDir: input.parentDir,
    ...(input.directoryName === undefined ? {} : { directoryName: input.directoryName }),
  };
}

/**
 * Clone from URL. Without the capability: today's single call. With it: the server keeps the
 * clone when this socket drops (`detach`), and each later session re-attaches (`attach`) until
 * an outcome, a stopped environment, or a session without the capability.
 */
export const cloneWithReattach = Effect.fn("Vcs.cloneWithReattach")(function* (
  input: VcsCloneCommandInput,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  // A cancel keyed by this destination may still be retrying: dispatch nothing until every
  // earlier cancel for this folder has settled, so none of them can stop this clone.
  yield* awaitPendingCloneCancels(environmentId, input);
  const clone = cloneFields(input);
  let session = yield* currentSession();
  let attach = false;
  while (true) {
    const config = yield* Effect.exit(session.initialConfig);
    if (Exit.isSuccess(config)) {
      if (config.value.environment.capabilities.vcsCloneReattach !== true) {
        if (attach) {
          return yield* new VcsCloneStoppedError({
            environmentId,
            reason: "reattach-unsupported",
            message: `${supervisor.target.label} can no longer resume this clone.`,
          });
        }
        input.onProgress?.({ phase: "cloning", reattach: false });
        return yield* requestInSession(session, environmentId, WS_METHODS.vcsClone, clone);
      }
      input.onProgress?.({ phase: "cloning", reattach: true });
      const result = yield* Effect.exit(
        requestInSession(session, environmentId, WS_METHODS.vcsClone, {
          ...clone,
          detach: true,
          ...(attach ? { attach: true } : {}),
        }),
      );
      if (Exit.isSuccess(result)) {
        return result.value satisfies GitCloneResult;
      }
      if (!isCloneTransportLoss(result.cause)) {
        return yield* Effect.failCause(result.cause);
      }
    } else if (!attach) {
      return yield* Effect.failCause(config.cause);
    }
    input.onProgress?.({ phase: "reconnecting", reattach: true });
    const next = yield* nextSession(supervisor, session);
    if (next._tag === "Stopped") {
      return yield* new VcsCloneStoppedError({
        environmentId,
        reason: "environment-unavailable",
        message: `Can't reconnect to ${supervisor.target.label}.`,
      });
    }
    session = next.session;
    attach = true;
  }
});

/**
 * `vcs.cancelClone`, sent on the current session or, while disconnected, on the next one that
 * advertises `vcsCloneReattach`. It runs on its own command lane because the clone holds the
 * destination's serial lane.
 */
export const cancelCloneOnNextSession = Effect.fn("Vcs.cancelCloneOnNextSession")(function* (
  input: GitCancelCloneInput,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  let lost: RpcSession | null = null;
  while (true) {
    const next = yield* nextSession(supervisor, lost);
    if (next._tag === "Stopped") {
      return yield* new VcsCloneStoppedError({
        environmentId,
        reason: "environment-unavailable",
        message: `Can't reconnect to ${supervisor.target.label}.`,
      });
    }
    const config = yield* Effect.exit(next.session.initialConfig);
    if (Exit.isFailure(config)) {
      // A session that failed to configure is as good as lost: wait for the next one.
      lost = next.session;
      continue;
    }
    if (config.value.environment.capabilities.vcsCloneReattach !== true) {
      // A host without re-attach has restarted since the clone began, so the clone is gone;
      // sending the RPC would fail as an unknown method and leave the dialog cancelling.
      return yield* new VcsCloneStoppedError({
        environmentId,
        reason: "reattach-unsupported",
        message: `${supervisor.target.label} can no longer resume or cancel this clone.`,
      });
    }
    const result = yield* Effect.exit(
      requestInSession(next.session, environmentId, WS_METHODS.vcsCancelClone, input),
    );
    if (Exit.isSuccess(result)) {
      return result.value satisfies GitCancelCloneResult;
    }
    if (!isCloneTransportLoss(result.cause)) {
      return yield* Effect.failCause(result.cause);
    }
    lost = next.session;
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/state/vcsClone.test.ts`
Expected: PASS (15 tests).

If the typechecker rejects `satisfies` on the returned values, drop the `satisfies` clauses; they only document the result types.

- [ ] **Step 5: Capture the red evidence**

| Test | Deliberate break | Expected red |
| --- | --- | --- |
| `re-attaches on the next session after every kind of transport loss` | Drop `Cause.isInterruptReason(reason) \|\|` from `isCloneTransportLoss` | The second attempt's interrupt ends the loop: `waitFor` dies with "attempt 2 did not start reconnecting" |
| `returns a typed failure without re-attaching` | Make `isCloneTransportLoss` return `true` for every failure | `calls` is 2 and the fiber never ends: the test times out |
| `reports a session without the capability as stopped and starts nothing there` | Remove the `attach` branch that stops on a missing capability | `legacyCalls` is 1 |
| `reports a host without the capability as stopped instead of sending` | Remove the capability check in `cancelCloneOnNextSession` | `sent` is 1 and the result is `{ cancelled: true }` |
| `stops re-attaching when the environment is blocked` | Remove the `state.phase === "blocked"` filter in `nextSession` | The fiber never ends: the test times out |
| `hold a clone into the same folder until every earlier cancel has settled` | Remove the `awaitPendingCloneCancels` call from `cloneWithReattach` | `inputs` is not empty after the first 20 yields |
| same test | Await only the first pending cancel instead of looping until none is left | `inputs` is not empty after `releaseFirst()` |
| `follow the server's leaf rule and ignore trailing separators` | Keep trailing separators in the key | The `/code/` and `/code` keys differ |

- [ ] **Step 6: Task gate**

Run: `vp check`
Expected: exit 0.

Run: `vp run --filter @bibcode/client-runtime typecheck`
Expected: exit 0.

- [ ] **Step 7: Checkpoint**

Record the checkpoint tree hash and results in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 8: `clone` runs the loop; `cancelClone` gets its own lane and owns its registration

**Files:**
- Modify: `packages/client-runtime/src/state/vcs.ts` (`clone` at 164-169; imports; re-export at the bottom)
- Modify: `packages/client-runtime/src/state/vcsCommandScheduler.ts`
- Test: `packages/client-runtime/src/state/vcs.test.ts`

**Interfaces:**
- Consumes (Task 7): `cloneWithReattach`, `cancelCloneOnNextSession`, `registerCloneCancel`, `VcsCloneCommandInput`.
- Produces (used by Task 10):
  - `vcsEnvironment.clone: AtomCommand<{ environmentId; input: VcsCloneCommandInput }, GitCloneResult, …>`. It stays on `vcsCommandScheduler` with `vcsCloneCommandConcurrency`, serial per destination. It waits for pending cancels of its destination (Task 7) before it dispatches.
  - `vcsEnvironment.cancelClone: AtomCommand<{ environmentId; input: GitCancelCloneInput }, GitCancelCloneResult, …>` on the new `vcsCloneCancelScheduler`. Its `run` registers the pending cancel **synchronously**, before anything is scheduled, and ends the record when the command settles. The record therefore never depends on the dialog that asked for it, which may unmount.
  - `@bibcode/client-runtime/state/vcs` re-exports `vcsClone.ts`.

- [ ] **Step 1: Write the failing tests**

In `packages/client-runtime/src/state/vcs.test.ts`:
- Add `AVAILABLE_CONNECTION_STATE` and `type SupervisorConnectionState` from `../connection/model.ts`.
- Add `isAtomCommandInterrupted` and `runAtomCommand` from `./runtime.ts`.
- Add `import { RpcClientError } from "effect/unstable/rpc";`.
- Append the helpers and tests below. They run inside `it.effect` and await the command promises with `Effect.promise`: the repository lint forbids `Effect.runSync`/`runPromise` in tests (`bibcode/no-manual-effect-runtime-in-tests`). `waitFor` (top of the file) yields 100 times; if the command path needs more on a loaded host, raise that bound. Never add sleeps.

```ts
const LOST_SOCKET = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({
    message: "socket closed",
    cause: new Error("socket closed"),
  }),
});

function cloneSession(client: Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>): RpcSession {
  return {
    client: client as unknown as WsRpcProtocolClient,
    initialConfig: Effect.succeed({
      environment: { capabilities: { vcsCloneReattach: true } },
    } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
}

const makeCommandHarness = Effect.fn("TestVcs.makeCommandHarness")(function* (initial: RpcSession) {
  const sessionRef = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.some(initial));
  const stateRef = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID, label: "Environment" },
    session: sessionRef,
    state: stateRef,
  } as never);
  const environmentRegistry = EnvironmentRegistry.of({
    run: (_environmentId: EnvironmentId, effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
  } as never);
  const vcs = createVcsEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
  );
  return { atomRegistry: AtomRegistry.make(), sessionRef, vcs };
});

describe("clone commands", () => {
  it.effect("cancels on its own lane while the clone holds the destination's lane", () =>
    Effect.gen(function* () {
      let cancelInput: unknown = null;
      const harness = yield* makeCommandHarness(
        cloneSession({
          [WS_METHODS.vcsClone]: () => Effect.never,
          [WS_METHODS.vcsCancelClone]: (input) => {
            cancelInput = input;
            return Effect.succeed({ cancelled: true });
          },
        }),
      );
      const controller = new AbortController();
      const input = { url: "https://example.test/demo.git", parentDir: "/code" };
      let cloneSettled = false;
      const clone = runAtomCommand(
        harness.atomRegistry,
        harness.vcs.clone,
        { environmentId: ENVIRONMENT_ID, input },
        { signal: controller.signal },
      ).then((result) => {
        cloneSettled = true;
        return result;
      });

      const cancelled = yield* Effect.promise(() =>
        runAtomCommand(harness.atomRegistry, harness.vcs.cancelClone, {
          environmentId: ENVIRONMENT_ID,
          input,
        }),
      );

      expect(AsyncResult.isSuccess(cancelled) ? cancelled.value : null).toEqual({
        cancelled: true,
      });
      expect(cancelInput).toEqual(input);
      expect(cloneSettled).toBe(false);
      controller.abort();
      expect(isAtomCommandInterrupted(yield* Effect.promise(() => clone))).toBe(true);
      harness.atomRegistry.dispose();
    }),
  );

  it.effect("a retry after a lost cancel acknowledgement and a remount waits for that cancel and is not cancelled", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const input = { url: "https://example.test/demo.git", parentDir: "/code" };
      const harness = yield* makeCommandHarness(
        cloneSession({
          [WS_METHODS.vcsClone]: () => {
            events.push("clone");
            return Effect.never;
          },
          // The host cancels the clone, but the answer is lost with the socket.
          [WS_METHODS.vcsCancelClone]: () => {
            events.push("cancel sent, answer lost");
            return Effect.fail(LOST_SOCKET);
          },
        }),
      );
      const firstDialog = new AbortController();
      const first = runAtomCommand(
        harness.atomRegistry,
        harness.vcs.clone,
        { environmentId: ENVIRONMENT_ID, input },
        { signal: firstDialog.signal },
      );
      yield* waitFor(() => events.includes("clone"), "the first clone was not dispatched");
      const cancel = runAtomCommand(harness.atomRegistry, harness.vcs.cancelClone, {
        environmentId: ENVIRONMENT_ID,
        input,
      });
      yield* waitFor(
        () => events.includes("cancel sent, answer lost"),
        "the cancel was not sent",
      );

      // The dialog unmounts: its clone wait ends; the cancel stays registered and keeps retrying.
      firstDialog.abort();
      expect(isAtomCommandInterrupted(yield* Effect.promise(() => first))).toBe(true);

      // A remounted dialog retries into the same folder: the retry waits for the pending cancel.
      const secondDialog = new AbortController();
      const retry = runAtomCommand(
        harness.atomRegistry,
        harness.vcs.clone,
        { environmentId: ENVIRONMENT_ID, input },
        { signal: secondDialog.signal },
      );
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow;
      expect(events).toEqual(["clone", "cancel sent, answer lost"]);

      // The host is reachable again: the cancel goes out once more and is acknowledged, and
      // only then does the retry dispatch. Nothing cancels the retry.
      yield* SubscriptionRef.set(
        harness.sessionRef,
        Option.some(
          cloneSession({
            [WS_METHODS.vcsClone]: () => {
              events.push("retry");
              return Effect.never;
            },
            [WS_METHODS.vcsCancelClone]: () => {
              events.push("cancel acknowledged");
              return Effect.succeed({ cancelled: true });
            },
          }),
        ),
      );
      const acknowledged = yield* Effect.promise(() => cancel);
      expect(AsyncResult.isSuccess(acknowledged) ? acknowledged.value : null).toEqual({
        cancelled: true,
      });
      yield* waitFor(() => events.includes("retry"), "the retry was not dispatched");
      expect(events).toEqual([
        "clone",
        "cancel sent, answer lost",
        "cancel acknowledged",
        "retry",
      ]);

      secondDialog.abort();
      yield* Effect.promise(() => retry);
      harness.atomRegistry.dispose();
    }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/state/vcs.test.ts`
Expected: FAIL. `vcs.cancelClone` is `undefined`, and the command run throws on it.

- [ ] **Step 3: Wire the commands**

In `packages/client-runtime/src/state/vcsCommandScheduler.ts`, add after `vcsGenerateScheduler`:

```ts
/**
 * Own lane for `vcs.cancelClone`: the clone it cancels holds the destination's serial lane on
 * `vcsCommandScheduler` for as long as it runs, so a cancel queued there would never go out.
 */
export const vcsCloneCancelScheduler = createAtomCommandScheduler();
```

In `packages/client-runtime/src/state/vcs.ts`:

1. Add `type GitCancelCloneInput` to the `@bibcode/contracts` import, `createEnvironmentCommand` to the `./runtime.ts` import, and `vcsCloneCancelScheduler` to the `./vcsCommandScheduler.ts` import. Add:

```ts
import {
  cancelCloneOnNextSession,
  cloneWithReattach,
  registerCloneCancel,
  type VcsCloneCommandInput,
} from "./vcsClone.ts";
```

2. Add above `createVcsEnvironmentAtoms`:

```ts
/**
 * `vcs.cancelClone` as a command. Its `run` records the pending cancel synchronously, before
 * anything is scheduled, so a clone into the same folder that starts afterwards waits for it,
 * even from a remounted dialog. The record ends when the command settles: acknowledged,
 * stopped, or failed. The dialog that asked never owns it.
 */
function createCancelCloneCommand<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const command = createEnvironmentCommand(runtime, {
    label: "environment-data:vcs:cancel-clone",
    scheduler: vcsCloneCancelScheduler,
    concurrency: vcsCloneCommandConcurrency,
    execute: (input: GitCancelCloneInput) => cancelCloneOnNextSession(input),
  });
  return {
    ...command,
    run: (...args: Parameters<typeof command.run>) => {
      const [, target] = args;
      const release = registerCloneCancel(target.environmentId, target.input);
      return command.run(...args).finally(release);
    },
  };
}
```

3. Replace the `clone:` entry (164-169) with:

```ts
    // React owns no retry loops: the re-attach loop lives in the command itself.
    clone: createEnvironmentCommand(runtime, {
      label: "environment-data:vcs:clone",
      scheduler: vcsCommandScheduler,
      concurrency: vcsCloneCommandConcurrency,
      execute: (input: VcsCloneCommandInput) => cloneWithReattach(input),
    }),
    cancelClone: createCancelCloneCommand(runtime),
```

4. Add `export * from "./vcsClone.ts";` after `export * from "./vcsStatus.ts";`.

If `createVcsEnvironmentAtoms`'s generic parameters are named differently (`<R, E>` today), match them in `createCancelCloneCommand`. It must accept the same `runtime` value.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/state/vcs.test.ts packages/client-runtime/src/state/vcsClone.test.ts`
Expected: PASS.

Run: `vp run --filter @bibcode/client-runtime typecheck`
Expected: exit 0.

- [ ] **Step 5: Capture the red evidence**

| Test | Deliberate break | Expected red |
| --- | --- | --- |
| `cancels on its own lane while the clone holds the destination's lane` | Give `cancelClone` the clone's scheduler (`scheduler: vcsCommandScheduler`) | The cancel queues behind the clone's serial lane and never resolves: the test times out |
| `a retry after a lost cancel acknowledgement and a remount waits for that cancel and is not cancelled` | Drop the `registerCloneCancel` call from `createCancelCloneCommand` | The retry dispatches while the cancel is pending: `events` gains "retry" before "cancel acknowledged" |
| same test | Release the record when the dialog's clone is aborted instead of when the cancel settles | Same: the retry dispatches before the cancel is acknowledged |

Run: `vp check`
Expected: exit 0.

- [ ] **Step 6: Checkpoint**

Record the checkpoint tree hash, results, and red evidence in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

## Phase 4 — Web

### Task 9: Clone phases, copy helpers, and the clone form

The phase union and the exhaustive `CLONE_SUBMIT_LABELS: Record<AddProjectCloneProgress, string>` change together, so the checkpoint typechecks (pre-flight item 4). The copy helpers land here too. The workflow that uses them lands in Task 10; unused exports do not fail the TypeScript gates.

**Files:**
- Modify: `apps/web/src/components/add-project/AddProjectDialog.logic.ts` (`AddProjectCloneProgress` at 16; new helpers)
- Test: `apps/web/src/components/add-project/AddProjectDialog.logic.test.ts`
- Modify: `apps/web/src/components/add-project/AddProjectSteps.tsx` (`CLONE_SUBMIT_LABELS` 480-484; Cancel condition ~589)
- Test: `apps/web/src/components/add-project/AddProjectSteps.test.tsx`

**Interfaces:**
- Consumes: `GitCloneOperationError` (Task 1) and `VcsCloneStoppedError` (Task 7, through `@bibcode/client-runtime/state/vcs`).
- Produces (used by Task 10):
  - `AddProjectCloneProgress = "idle" | "cloning" | "reconnecting" | "cancelling" | "registering"`;
  - `CLONE_CANCELLED_NOTICE`, `CLONE_STOPPED_ERROR`;
  - `cloneReconnectingNotice(hostLabel)`, `cloneCancelPendingNotice(hostLabel)`;
  - `interface AddProjectCloneFeedback { kind: "error" | "notice"; text: string }`;
  - `describeCloneOperationFailure(error: unknown, hostLabel: string, cancelRequested: boolean): AddProjectCloneFeedback | null`.
- The clone form shows **Cloning…** in `cloning` and `reconnecting`, **Cancelling…** in `cancelling`, and **Cancel clone** only in `cloning` and `reconnecting`. The notice renders in the existing `role="status"` line.

- [ ] **Step 1: Write the failing logic tests**

Append to `apps/web/src/components/add-project/AddProjectDialog.logic.test.ts`. Extend its imports with `describeCloneOperationFailure`, `cloneReconnectingNotice`, and `cloneCancelPendingNotice` from `./AddProjectDialog.logic`; `GitCloneOperationError` from `@bibcode/contracts`; and `VcsCloneStoppedError` from `@bibcode/client-runtime/state/vcs`.

```ts
describe("clone re-attach copy", () => {
  const error = (reason: GitCloneOperationError["reason"]) =>
    new GitCloneOperationError({ reason, destination: "/srv/code/demo", message: "server text" });

  it("names the host while reconnecting and while a cancel waits for it", () => {
    expect(cloneReconnectingNotice("Remote")).toBe(
      "Lost the connection to Remote. The clone continues on the server; reconnecting…",
    );
    expect(cloneCancelPendingNotice("Remote")).toBe("The clone stops when Remote reconnects.");
  });

  it("maps every clone runtime reason to the dialog copy", () => {
    expect(describeCloneOperationFailure(error("not-in-progress"), "Remote", false)).toEqual({
      kind: "error",
      text: "No clone is in progress for /srv/code/demo. Press Clone to start again.",
    });
    expect(describeCloneOperationFailure(error("cancelled"), "Remote", false)).toEqual({
      kind: "error",
      text: "The clone into /srv/code/demo was cancelled elsewhere. Press Clone to start again.",
    });
    expect(describeCloneOperationFailure(error("cancelled"), "Remote", true)).toEqual({
      kind: "notice",
      text: "Clone cancelled.",
    });
    expect(describeCloneOperationFailure(error("busy"), "Remote", false)).toEqual({
      kind: "error",
      text: "Another clone into /srv/code/demo is in progress. Wait for it to finish or choose another folder.",
    });
    expect(describeCloneOperationFailure(error("capacity"), "Remote", false)).toEqual({
      kind: "error",
      text: "Too many clones are running on Remote. Wait for one to finish and try again.",
    });
    expect(describeCloneOperationFailure(error("shutting-down"), "Remote", false)).toEqual({
      kind: "error",
      text: "Remote is shutting down. Press Clone again once it is back.",
    });
  });

  it("explains a clone the client stopped following", () => {
    const stopped = (reason: VcsCloneStoppedError["reason"]) =>
      new VcsCloneStoppedError({ environmentId: "remote", reason, message: "x" });
    expect(describeCloneOperationFailure(stopped("environment-unavailable"), "Remote", false)).toEqual({
      kind: "error",
      text: "Can't reconnect to Remote. The clone continues there; clone the same URL into the same folder to finish.",
    });
    expect(describeCloneOperationFailure(stopped("reattach-unsupported"), "Remote", false)).toEqual({
      kind: "error",
      text: "The clone stopped before it finished. Try again.",
    });
  });

  it("leaves other failures to the generic Clone failed copy", () => {
    expect(describeCloneOperationFailure(new Error("boom"), "Remote", false)).toBeNull();
    expect(describeCloneOperationFailure(null, "Remote", false)).toBeNull();
  });
});
```

Run: `vp test run apps/web/src/components/add-project/AddProjectDialog.logic.test.ts`
Expected: FAIL. The helpers are not exported.

- [ ] **Step 2: Implement the logic helpers**

In `apps/web/src/components/add-project/AddProjectDialog.logic.ts`:
- Add imports: `import { VcsCloneStoppedError } from "@bibcode/client-runtime/state/vcs";` and `import { GitCloneOperationError } from "@bibcode/contracts";`. The existing contracts import on line 1 is `import type`, so the class needs its own value import.
- Replace the `AddProjectCloneProgress` type and its doc comment (15-16) with:

```ts
/**
 * `cloning` and `reconnecting` can be cancelled; `cancelling` waits for the server to confirm;
 * `registering` adds the finished clone as a project.
 */
export type AddProjectCloneProgress =
  | "idle"
  | "cloning"
  | "reconnecting"
  | "cancelling"
  | "registering";

export const CLONE_CANCELLED_NOTICE = "Clone cancelled.";
export const CLONE_STOPPED_ERROR = "The clone stopped before it finished. Try again.";

export function cloneReconnectingNotice(hostLabel: string): string {
  return `Lost the connection to ${hostLabel}. The clone continues on the server; reconnecting…`;
}

export function cloneCancelPendingNotice(hostLabel: string): string {
  return `The clone stops when ${hostLabel} reconnects.`;
}

export interface AddProjectCloneFeedback {
  readonly kind: "error" | "notice";
  readonly text: string;
}

/**
 * The dialog's copy for a clone the server's clone runtime refused or ended, or that the client
 * stopped following. `null` for any other failure, which keeps "Clone failed: <detail>".
 */
export function describeCloneOperationFailure(
  error: unknown,
  hostLabel: string,
  cancelRequested: boolean,
): AddProjectCloneFeedback | null {
  if (error instanceof VcsCloneStoppedError) {
    return {
      kind: "error",
      text:
        error.reason === "environment-unavailable"
          ? `Can't reconnect to ${hostLabel}. The clone continues there; clone the same URL into the same folder to finish.`
          : CLONE_STOPPED_ERROR,
    };
  }
  if (!(error instanceof GitCloneOperationError)) {
    return null;
  }
  const path = error.destination;
  switch (error.reason) {
    case "cancelled":
      return cancelRequested
        ? { kind: "notice", text: CLONE_CANCELLED_NOTICE }
        : {
            kind: "error",
            text: `The clone into ${path} was cancelled elsewhere. Press Clone to start again.`,
          };
    case "not-in-progress":
      return { kind: "error", text: `No clone is in progress for ${path}. Press Clone to start again.` };
    case "busy":
      return {
        kind: "error",
        text: `Another clone into ${path} is in progress. Wait for it to finish or choose another folder.`,
      };
    case "capacity":
      return {
        kind: "error",
        text: `Too many clones are running on ${hostLabel}. Wait for one to finish and try again.`,
      };
    case "shutting-down":
      return { kind: "error", text: `${hostLabel} is shutting down. Press Clone again once it is back.` };
  }
}
```

Run the logic test again. Expected: PASS.


- [ ] **Step 3: Write the failing clone-form tests**

Append inside the clone-step `describe` of `AddProjectSteps.test.tsx`, using the file's `cloneStepProps` helper:

```ts
  it("keeps Cancel while reconnecting and announces the reconnecting line", async () => {
    const onCancel = vi.fn();
    const line =
      "Lost the connection to Local Mac. The clone continues on the server; reconnecting…";
    await mount(
      <AddProjectCloneStep
        {...cloneStepProps({ busy: true, progress: "reconnecting", notice: line, onCancel })}
      />,
    );

    expect(buttonWithText("Cloning…").disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(line);
    await click(buttonWithText("Cancel clone"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows Cancelling… without a second Cancel while the server confirms", async () => {
    const line = "The clone stops when Local Mac reconnects.";
    await mount(
      <AddProjectCloneStep {...cloneStepProps({ busy: true, progress: "cancelling", notice: line })} />,
    );

    expect(buttonWithText("Cancelling…").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Cancel clone");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(line);
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `vp test run apps/web/src/components/add-project/AddProjectSteps.test.tsx`
Expected: FAIL. `CLONE_SUBMIT_LABELS` has no `reconnecting` or `cancelling` entry (TypeScript), and Cancel is hidden in `reconnecting`.

- [ ] **Step 5: Implement the labels and Cancel visibility**

In `apps/web/src/components/add-project/AddProjectSteps.tsx`, replace `CLONE_SUBMIT_LABELS` with:

```ts
const CLONE_SUBMIT_LABELS: Record<AddProjectCloneProgress, string> = {
  idle: "Clone",
  cloning: "Cloning…",
  // The clone keeps running on the server while the connection is down.
  reconnecting: "Cloning…",
  cancelling: "Cancelling…",
  registering: "Adding project…",
};
```

Inside `AddProjectCloneStep`, add `const canCancel = progress === "cloning" || progress === "reconnecting";` next to `canSubmit`. Replace `{progress === "cloning" ? (` (the Cancel button condition) with `{canCancel ? (`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `vp test run apps/web/src/components/add-project`
Expected: PASS.

Run: `vp run --filter @bibcode/web typecheck`
Expected: exit 0. The workflow never produces the new phases yet, but every exhaustive map covers them.

- [ ] **Step 7: Capture the red evidence**

| Test | Deliberate break | Expected red |
| --- | --- | --- |
| `keeps Cancel while reconnecting and announces the reconnecting line` | Show Cancel only when `progress === "cloning"` | `buttonWithText("Cancel clone")` throws "Missing button" |
| `shows Cancelling… without a second Cancel while the server confirms` | Include `cancelling` in `canCancel` | "Cancel clone" is present |
| `maps every clone runtime reason to the dialog copy` | Swap the `busy` and `capacity` texts | The `busy` expectation fails |

- [ ] **Step 8: Task gate**

Run: `vp check`
Expected: exit 0.

- [ ] **Step 9: Checkpoint**

Record the checkpoint tree hash, results, and red evidence in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 10: Add Project workflow — re-attach, cancel settlement, Cancel and close

**Files:**
- Modify: `apps/web/src/components/add-project/addProjectOperations.ts`
- Test: `apps/web/src/components/add-project/addProjectOperations.test.ts`
- Modify: `apps/web/src/components/add-project/useAddProjectWorkflow.ts`:
  - `CLONE_*` constants at 159-164;
  - refs at 207-209;
  - the unmount effect at 257-266;
  - `submitClone` at 520-589;
  - `cancelClone` at 591-593;
  - the outer hook at 713 and 818-830.
- Test: `apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx`, `apps/web/src/components/add-project/useAddProjectWorkflow.public.test.tsx`

**Interfaces:**
- Consumes:
  - Task 8: `vcsEnvironment.clone` input `{ url, parentDir, onProgress }` and `vcsEnvironment.cancelClone`;
  - Task 9: the phase union and the copy helpers;
  - `VcsCloneProgress` and `VcsCloneStoppedError` from `@bibcode/client-runtime/state/vcs`, and `GitCloneOperationError` from `@bibcode/contracts`.
- Produces (operations):
  - `AddProjectCloneControl.onProgress?: (progress: VcsCloneProgress) => void`;
  - `AddProjectCloneControl.shouldRegister?: () => boolean`: checked once the repository is on disk; `false` skips registration (D12);
  - `AddProjectOperationsDependencies.cancelClone(input: { environmentId; url; parentDir }) => Promise<AddProjectCommandResult<{ readonly cancelled: boolean }>>`;
  - `operations.cancelClone(input)`.

Behaviour (D4-D7, D12):

- `onProgress({ reattach })` records whether Cancel and close must reach the server.
- **Cancel without re-attach** aborts, as today.
- **Cancel with re-attach:**
  - sets `cancelling`, and shows "The clone stops when <host> reconnects." if the phase was `reconnecting`;
  - starts the server cancel and stores its settlement promise on the attempt;
  - a failed or stopped settlement aborts the clone wait; an acknowledged one does not, so the clone request still reports its own outcome (a cleanup failure, for example);
  - `submitClone` first checks that its attempt is still current, then awaits the settlement before re-enabling the form. The form shows **Cancelling…** until the cancel settles.
  - The ordering guarantee itself lives in the client runtime (Tasks 7-8, round-2 ruling). The cancel command records itself in the pending-cancel registry, and any later clone into that destination waits for it, even after this dialog unmounted and a new one mounted.
- **Unmount with re-attach** sends the cancel as best effort, then aborts at once (D7). The cancel stays registered in the runtime until it settles; unmount never abandons it.
- Once Cancel is requested, progress updates no longer change the phase, and a clone that finishes anyway is not registered (D12).

- [ ] **Step 1: Write the failing operations test**

In `apps/web/src/components/add-project/addProjectOperations.test.ts`, `makeHarness` (36-71) builds the only shared `AddProjectOperationsDependencies` literal (`satisfies AddProjectOperationsDependencies`). Add `const cancelClone = vi.fn<AddProjectOperationsDependencies["cancelClone"]>(async () => ({ _tag: "Success", value: { cancelled: true } }));` beside `openProject`, and add `cancelClone` both to the returned object and to its `dependencies` literal. The existing exact `toHaveBeenCalledWith({ environmentId, url, parentDir })` assertions stay valid, because `onProgress` is forwarded only when given. Then append:

```ts
describe("clone re-attach plumbing", () => {
  function operationsWith(
    cloneRepository: AddProjectOperationsDependencies["cloneRepository"],
    createProject: AddProjectOperationsDependencies["createProject"] = vi.fn(async (input) => ({
      _tag: "Success" as const,
      value: { projectId: input.projectId },
    })),
  ) {
    const cancelClone = vi.fn<AddProjectOperationsDependencies["cancelClone"]>(async () => ({
      _tag: "Success",
      value: { cancelled: true },
    }));
    const operations = createAddProjectOperations({
      getProjects: () => [],
      createProject,
      cloneRepository,
      cancelClone,
      openProject: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
      reportFailure: vi.fn(),
    });
    return { operations, cancelClone };
  }
  const environmentId = EnvironmentId.make("remote");

  it("forwards progress to the clone command and passes cancel through", async () => {
    const progress = vi.fn();
    const { operations, cancelClone } = operationsWith(async (input) => {
      input.onProgress?.({ phase: "reconnecting", reattach: true });
      return { _tag: "Failure", error: null };
    });

    await operations.clone({
      environmentId,
      url: "https://example.test/demo.git",
      parentDir: "/code",
      shouldContinue: () => true,
      onProgress: progress,
    });
    expect(progress).toHaveBeenCalledWith({ phase: "reconnecting", reattach: true });

    await expect(
      operations.cancelClone({ environmentId, url: "https://example.test/demo.git", parentDir: "/code" }),
    ).resolves.toEqual({ _tag: "Success", value: { cancelled: true } });
    expect(cancelClone).toHaveBeenCalledWith({
      environmentId,
      url: "https://example.test/demo.git",
      parentDir: "/code",
    });
  });

  it("does not register a finished clone when shouldRegister says no", async () => {
    const createProject = vi.fn<AddProjectOperationsDependencies["createProject"]>();
    const onCloned = vi.fn();
    const { operations } = operationsWith(
      async () => ({ _tag: "Success", value: { path: "/code/demo" } }),
      createProject,
    );

    const outcome = await operations.clone({
      environmentId,
      url: "https://example.test/demo.git",
      parentDir: "/code",
      shouldContinue: () => true,
      shouldRegister: () => false,
      onCloned,
    });

    expect(outcome).toEqual({ _tag: "Stopped" });
    expect(onCloned).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });
});
```

Run: `vp test run apps/web/src/components/add-project/addProjectOperations.test.ts`
Expected: FAIL. `cancelClone` is not a dependency, and neither `onProgress` nor `shouldRegister` is forwarded.

- [ ] **Step 2: Implement the operations**

In `apps/web/src/components/add-project/addProjectOperations.ts`:
- Add `import type { VcsCloneProgress } from "@bibcode/client-runtime/state/vcs";`.
- In `AddProjectCloneControl`, add:

```ts
  /** Whether the clone runs or waits for a lost connection, and whether the server re-attaches. */
  readonly onProgress?: (progress: VcsCloneProgress) => void;
  /** Checked once the repository is on disk: `false` leaves it there unregistered (after Cancel). */
  readonly shouldRegister?: () => boolean;
```

- In `AddProjectOperationsDependencies`, add `readonly onProgress?: (progress: VcsCloneProgress) => void;` to the `cloneRepository` input, and add:

```ts
  readonly cancelClone: (input: {
    readonly environmentId: EnvironmentId;
    readonly url: string;
    readonly parentDir: string;
  }) => Promise<AddProjectCommandResult<{ readonly cancelled: boolean }>>;
```

- In `clone`, pass `...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),` into `dependencies.cloneRepository({…})`. Between `if (cloned._tag !== "Success") { return cloned; }` and `input.onCloned?.();`, add:

```ts
      if (input.shouldRegister !== undefined && !input.shouldRegister()) {
        return STOPPED;
      }
```

- Add to the returned object:

```ts
    /** `vcs.cancelClone`: stops the server-side clone, even across a reconnect. */
    cancelClone: (input: {
      readonly environmentId: EnvironmentId;
      readonly url: string;
      readonly parentDir: string;
    }) => dependencies.cancelClone(input),
```

Run the operations test again. Expected: PASS.

- [ ] **Step 3: Write the failing workflow tests**

In `apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx`:

1. Change `WorkflowOperations` to `Pick<…, "addFolder" | "clone" | "create" | "cancelClone">`.
2. Add `cancelClone: vi.fn(async () => ({ _tag: "Success" as const, value: { cancelled: true } })),` to `testState.operations`. In `beforeEach`, add `testState.operations.cancelClone.mockReset().mockResolvedValue({ _tag: "Success", value: { cancelled: true } });`.
3. In `makeIntegratedOperations`, add a `cancelClone` mock of type `AddProjectOperationsDependencies["cancelClone"]` that resolves `{ _tag: "Success", value: { cancelled: true } }`, pass it to `createAddProjectOperations`, and return it.
4. Add `GitCloneOperationError` to the contracts import, and add `import { VcsCloneStoppedError } from "@bibcode/client-runtime/state/vcs";`.
5. In the two existing abort-path tests, "keeps a running clone on the form until Cancel interrupts it" and "interrupts a running clone when the workflow unmounts", add `expect(harness.cancelClone).not.toHaveBeenCalled();`. `interruptibleClone` never reports progress, so those clones are not re-attachable and must keep today's abort-only path.
6. Append the helpers and tests:

```ts
const SERVER_CANCELLED = new GitCloneOperationError({
  reason: "cancelled",
  destination: "/srv/code/demo",
  message: "server text",
});

/** A re-attachable clone: reports progress through the captured callback and waits for its reply or an abort. */
function reattachingClone(harness: ReturnType<typeof makeIntegratedOperations>) {
  const calls: Array<Parameters<AddProjectOperationsDependencies["cloneRepository"]>[0]> = [];
  const replies: Array<(result: AddProjectCommandResult<{ readonly path: string }>) => void> = [];
  harness.cloneRepository.mockImplementation(
    (input) =>
      new Promise((resolve) => {
        calls.push(input);
        replies.push(resolve);
        input.onProgress?.({ phase: "cloning", reattach: true });
        input.signal?.addEventListener("abort", () => resolve({ _tag: "Failure", error: null }), {
          once: true,
        });
      }),
  );
  return { calls, replies };
}

/** A server cancel whose settlement the test controls. */
function heldCancel(harness: ReturnType<typeof makeIntegratedOperations>) {
  let settle!: (result: AddProjectCommandResult<{ readonly cancelled: boolean }>) => void;
  harness.cancelClone.mockReturnValueOnce(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return {
    acknowledge: () => settle({ _tag: "Success", value: { cancelled: true } }),
    fail: (error: unknown) => settle({ _tag: "Failure", error }),
  };
}

async function startClone(
  view: Awaited<ReturnType<typeof mountWorkflow>>,
): Promise<{ readonly submission: Promise<void> }> {
  act(() => view.current.selectHost(ENV_REMOTE));
  act(() => view.current.openClone());
  act(() => view.current.setCloneUrl("https://example.test/demo.git"));
  act(() => view.current.setCloneParent("/srv/code"));
  let submission!: Promise<void>;
  act(() => {
    submission = view.current.submitClone();
  });
  await flushPromises();
  // Wrapped: an async function that returned the bare promise would wait for the clone itself.
  return { submission };
}

describe("clone re-attach", () => {
  it("shows the reconnecting line while the connection is lost and registers after re-attach", async () => {
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);

    act(() => clone.calls[0]?.onProgress?.({ phase: "reconnecting", reattach: true }));
    expect(view.current.cloneProgress).toBe("reconnecting");
    expect(view.current.notice).toBe(
      "Lost the connection to Remote. The clone continues on the server; reconnecting…",
    );
    expect(view.current.busy).toBe(true);

    act(() => clone.calls[0]?.onProgress?.({ phase: "cloning", reattach: true }));
    expect(view.current.cloneProgress).toBe("cloning");
    expect(view.current.notice).toBeNull();

    await act(async () => {
      clone.replies[0]?.({ _tag: "Success", value: { path: "/srv/code/demo" } });
      await submission;
    });
    expect(harness.createProject).toHaveBeenCalledTimes(1);
    expect(testState.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cancels on the server while disconnected and ends with the server's answer", async () => {
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    const cancel = heldCancel(harness);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);
    act(() => clone.calls[0]?.onProgress?.({ phase: "reconnecting", reattach: true }));

    act(() => view.current.cancelClone());
    expect(view.current.cloneProgress).toBe("cancelling");
    expect(view.current.notice).toBe("The clone stops when Remote reconnects.");
    expect(harness.cancelClone).toHaveBeenCalledWith({
      environmentId: ENV_REMOTE,
      url: "https://example.test/demo.git",
      parentDir: "/srv/code",
    });
    // Progress after Cancel does not reopen Cancel.
    act(() => clone.calls[0]?.onProgress?.({ phase: "cloning", reattach: true }));
    expect(view.current.cloneProgress).toBe("cancelling");

    await act(async () => {
      cancel.acknowledge();
      await Promise.resolve();
    });
    expect(view.current.cloneProgress).toBe("cancelling");
    await act(async () => {
      clone.replies[0]?.({ _tag: "Failure", error: SERVER_CANCELLED });
      await submission;
    });

    expect(clone.calls[0]?.signal?.aborted).toBe(false);
    expect(view.current.notice).toBe("Clone cancelled.");
    expect(view.current.error).toBeNull();
    expect(view.current.cloneUrl).toBe("https://example.test/demo.git");
    expect(view.current.busy).toBe(false);
  });

  it("keeps Cancelling… until the server cancel settles, so a retry is never cancelled by it", async () => {
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    const cancel = heldCancel(harness);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);
    act(() => clone.calls[0]?.onProgress?.({ phase: "reconnecting", reattach: true }));
    act(() => view.current.cancelClone());

    // The clone's own cancelled answer arrives while the cancel's acknowledgement was lost and
    // the cancel is still retrying on the next session.
    await act(async () => {
      clone.replies[0]?.({ _tag: "Failure", error: SERVER_CANCELLED });
      await Promise.resolve();
    });
    expect(view.current.cloneProgress).toBe("cancelling");
    expect(view.current.busy).toBe(true);
    await act(async () => {
      await view.current.submitClone();
    });
    expect(harness.cloneRepository).toHaveBeenCalledTimes(1);

    await act(async () => {
      cancel.acknowledge();
      await submission;
    });
    expect(view.current.notice).toBe("Clone cancelled.");
    expect(view.current.busy).toBe(false);

    // Only now can a retry start, and the settled cancel cannot reach it.
    let retry!: Promise<void>;
    act(() => {
      retry = view.current.submitClone();
    });
    await flushPromises();
    expect(harness.cloneRepository).toHaveBeenCalledTimes(2);
    expect(harness.cancelClone).toHaveBeenCalledTimes(1);
    expect(clone.calls[1]?.signal?.aborted).toBe(false);
    await act(async () => {
      clone.replies[1]?.({ _tag: "Success", value: { path: "/srv/code/demo" } });
      await retry;
    });
    expect(testState.onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    [
      "cancelled elsewhere",
      new GitCloneOperationError({ reason: "cancelled", destination: "/srv/code/demo", message: "x" }),
      "The clone into /srv/code/demo was cancelled elsewhere. Press Clone to start again.",
    ],
    [
      "not in progress",
      new GitCloneOperationError({ reason: "not-in-progress", destination: "/srv/code/demo", message: "x" }),
      "No clone is in progress for /srv/code/demo. Press Clone to start again.",
    ],
    [
      "busy",
      new GitCloneOperationError({ reason: "busy", destination: "/srv/code/demo", message: "x" }),
      "Another clone into /srv/code/demo is in progress. Wait for it to finish or choose another folder.",
    ],
    [
      "capacity",
      new GitCloneOperationError({ reason: "capacity", destination: "/srv/code/demo", message: "x" }),
      "Too many clones are running on Remote. Wait for one to finish and try again.",
    ],
    [
      "shutting down",
      new GitCloneOperationError({ reason: "shutting-down", destination: "/srv/code/demo", message: "x" }),
      "Remote is shutting down. Press Clone again once it is back.",
    ],
    [
      "unreachable",
      new VcsCloneStoppedError({ environmentId: "remote", reason: "environment-unavailable", message: "x" }),
      "Can't reconnect to Remote. The clone continues there; clone the same URL into the same folder to finish.",
    ],
  ])("shows the %s copy and keeps the form values", async (_label, failure, copy) => {
    const harness = makeIntegratedOperations();
    harness.cloneRepository.mockResolvedValueOnce({ _tag: "Failure", error: failure });
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);
    await act(async () => submission);

    expect(view.current.error).toBe(copy);
    expect(view.current.cloneUrl).toBe("https://example.test/demo.git");
    expect(view.current.cloneParent).toBe("/srv/code");
    expect(view.current.cloneProgress).toBe("idle");
    expect(view.current.busy).toBe(false);
  });

  it("shows the can't-reconnect copy when a cancel cannot reach the host", async () => {
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    const cancel = heldCancel(harness);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);
    act(() => clone.calls[0]?.onProgress?.({ phase: "reconnecting", reattach: true }));
    act(() => view.current.cancelClone());

    await act(async () => {
      cancel.fail(
        new VcsCloneStoppedError({ environmentId: "remote", reason: "environment-unavailable", message: "x" }),
      );
      await submission;
    });
    expect(clone.calls[0]?.signal?.aborted).toBe(true);
    expect(view.current.error).toBe(
      "Can't reconnect to Remote. The clone continues there; clone the same URL into the same folder to finish.",
    );
    expect(view.current.busy).toBe(false);
  });

  it("never stays in Cancelling… when the host comes back without re-attach", async () => {
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    const cancel = heldCancel(harness);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);
    act(() => clone.calls[0]?.onProgress?.({ phase: "reconnecting", reattach: true }));
    act(() => view.current.cancelClone());

    await act(async () => {
      cancel.fail(
        new VcsCloneStoppedError({ environmentId: "remote", reason: "reattach-unsupported", message: "x" }),
      );
      await submission;
    });
    expect(view.current.cloneProgress).toBe("idle");
    expect(view.current.busy).toBe(false);
    expect(view.current.error).toBe("The clone stopped before it finished. Try again.");
  });

  it("shows a folder the cancelled clone could not remove instead of a clean cancel", async () => {
    const detail =
      "Git command was interrupted.\nThe incomplete clone at /srv/code/demo could not be removed (the folder was replaced after the clone started). Remove it before trying again.";
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    const cancel = heldCancel(harness);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);
    act(() => view.current.cancelClone());

    await act(async () => {
      cancel.acknowledge();
      clone.replies[0]?.({
        _tag: "Failure",
        error: new GitCommandError({
          operation: "GitVcsDriver.clone",
          command: "git",
          cwd: "/srv/code/demo",
          detail,
        }),
      });
      await submission;
    });
    expect(view.current.error).toBe(`Clone failed: ${detail}`);
    expect(view.current.notice).toBeNull();
  });

  it("does not add a clone that finished while its cancel was pending", async () => {
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    const cancel = heldCancel(harness);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);
    act(() => view.current.cancelClone());

    await act(async () => {
      clone.replies[0]?.({ _tag: "Success", value: { path: "/srv/code/demo" } });
      await Promise.resolve();
    });
    expect(harness.createProject).not.toHaveBeenCalled();
    await act(async () => {
      cancel.acknowledge();
      await submission;
    });
    expect(view.current.notice).toBe("Clone cancelled.");
    expect(harness.createProject).not.toHaveBeenCalled();
    expect(testState.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("asks the host to cancel, as best effort, and stops waiting when the workflow unmounts", async () => {
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);

    await act(async () => {
      workflowRoot?.unmount();
      await submission;
    });
    workflowRoot = null;

    expect(harness.cancelClone).toHaveBeenCalledWith({
      environmentId: ENV_REMOTE,
      url: "https://example.test/demo.git",
      parentDir: "/srv/code",
    });
    expect(clone.calls[0]?.signal?.aborted).toBe(true);
    expect(harness.createProject).not.toHaveBeenCalled();
  });

  it("a stale attempt returns without waiting for its cancel", async () => {
    const harness = makeIntegratedOperations();
    const clone = reattachingClone(harness);
    heldCancel(harness); // never settles in this test
    testState.operationOverride = harness.operations;
    const view = await mountWorkflow({ open: true });
    const { submission } = await startClone(view);
    act(() => view.current.cancelClone());

    // The selected host leaves the catalog: the workflow resets, so the attempt is stale.
    await view.rerender(true, [primaryHost, wslHost]);
    await act(async () => {
      clone.replies[0]?.({ _tag: "Failure", error: SERVER_CANCELLED });
      await submission;
    });

    expect(view.current.busy).toBe(false);
    expect(view.current.cloneProgress).toBe("idle");
    expect(view.current.error).toBe("The selected host disconnected. Choose a host and try again.");
  });
});
```

The ordering guarantee across unmount and remount (a lost acknowledgement, then a retry that must wait and must not be cancelled) is proven in the client runtime: Task 8's `a retry after a lost cancel acknowledgement and a remount waits for that cancel and is not cancelled`. This task's tests mock the operations layer, so they cannot observe it; they prove the dialog's part: the cancel goes out on unmount and is never aborted.

In `apps/web/src/components/add-project/useAddProjectWorkflow.public.test.tsx`:
- add `cancelClone: vi.fn()` to `harness` (line ~38), and reset it in the file's `beforeEach` to resolve `AsyncResult.success({ cancelled: true })`;
- add `cancelClone: { key: "vcs.cancelClone" },` to the `~/state/vcs` mock;
- add a `command.key === "vcs.cancelClone"` branch to the `useAtomCommand` mock returning `(input: unknown) => harness.cancelClone(input)`;
- in "interrupts the clone command when the clone is cancelled", change the expected input to `{ url: "https://example.test/repository.git", parentDir: "/code", onProgress: expect.any(Function) }` and add `expect(harness.cancelClone).not.toHaveBeenCalled();`.

Run: `vp test run apps/web/src/components/add-project/useAddProjectWorkflow.test.tsx apps/web/src/components/add-project/useAddProjectWorkflow.public.test.tsx`
Expected: FAIL. The workflow's operations lack `cancelClone`, progress and cancel settlement are not handled, and the public test's input lacks `onProgress`.

- [ ] **Step 4: Implement the workflow**

In `apps/web/src/components/add-project/useAddProjectWorkflow.ts`:

1. Imports: from `./AddProjectDialog.logic`, add `CLONE_CANCELLED_NOTICE`, `CLONE_STOPPED_ERROR`, `cloneCancelPendingNotice`, `cloneReconnectingNotice`, `describeCloneOperationFailure`, and `type AddProjectCloneFeedback`. Delete the local `CLONE_CANCELLED_NOTICE` and `CLONE_STOPPED_ERROR` constants and the comment above them (159-162). Keep `CLONE_REGISTRATION_STOPPED_ERROR`. Add `type AddProjectCommandResult` to the `./addProjectOperations` import.
2. `AddProjectWorkflowStateInput.operations`: `Pick<…, "addFolder" | "clone" | "create" | "cancelClone">`.
3. Add above `useAddProjectWorkflowState`:

```ts
/** How a server cancel ended. */
type CloneCancellation =
  | { readonly _tag: "Acknowledged"; readonly cancelled: boolean }
  | { readonly _tag: "Failed"; readonly error: unknown };

/** One running clone request. Cleared once the repository is on disk (registration is not cancelled). */
interface CloneAttempt {
  readonly controller: AbortController;
  readonly hostLabel: string;
  readonly requestCancel: () => Promise<AddProjectCommandResult<{ readonly cancelled: boolean }>>;
  phase: "cloning" | "reconnecting";
  /** The server keeps this clone across reconnects: Cancel and close must reach it. */
  reattach: boolean;
  /**
   * The server cancel, once requested. It settles when the host acknowledged it, the
   * environment stopped, or it failed. Until then no new clone may start: the cancel is keyed
   * by destination, so a cancel that is still retrying would stop a new clone into this folder.
   */
  cancellation: Promise<CloneCancellation> | null;
}

function settleCancellation(
  result: Promise<AddProjectCommandResult<{ readonly cancelled: boolean }>>,
): Promise<CloneCancellation> {
  return result.then(
    (settled): CloneCancellation =>
      settled._tag === "Success"
        ? { _tag: "Acknowledged", cancelled: settled.value.cancelled }
        : { _tag: "Failed", error: settled.error },
    (cause: unknown): CloneCancellation => ({ _tag: "Failed", error: cause }),
  );
}

function cloneFeedback(
  outcome: Exclude<AddProjectOutcome, { readonly _tag: "Opened" }>,
  attempt: CloneAttempt,
  cancellation: CloneCancellation | null,
  cloned: boolean,
): AddProjectCloneFeedback {
  const cancelRequested = cancellation !== null;
  // The clone's own outcome comes first: a folder a cancelled clone could not remove must show.
  if (outcome._tag === "Failed") {
    return (
      describeCloneOperationFailure(outcome.error, attempt.hostLabel, cancelRequested) ?? {
        kind: "error",
        text: `${outcome.title}: ${addProjectFailureMessage(outcome.error)}`,
      }
    );
  }
  if (cancellation?._tag === "Failed") {
    return (
      describeCloneOperationFailure(cancellation.error, attempt.hostLabel, true) ?? {
        kind: "error",
        text: `Clone failed: ${addProjectFailureMessage(cancellation.error)}`,
      }
    );
  }
  if (cancelRequested || attempt.controller.signal.aborted) {
    return { kind: "notice", text: CLONE_CANCELLED_NOTICE };
  }
  // Interrupted by something other than Cancel; never re-enable the form silently, and name
  // the step that stopped.
  return { kind: "error", text: cloned ? CLONE_REGISTRATION_STOPPED_ERROR : CLONE_STOPPED_ERROR };
}
```

4. Replace `const cloneAbortRef = useRef<AbortController | null>(null);` (208) with:

```ts
  /** Set only while the clone request itself runs, so Cancel cannot interrupt registration. */
  const cloneAttemptRef = useRef<CloneAttempt | null>(null);
```

5. Replace the unmount effect body (257-266) with:

```ts
  useEffect(
    () => () => {
      generationRef.current += 1;
      openRef.current = false;
      // Nothing can register the result after unmount, so stop the server-side clone too. With
      // re-attach an abort alone only detaches; the cancel is best effort, because a closing or
      // disconnected window may never get it out, and then the clone continues on the host. The
      // client runtime keeps the cancel registered until it settles, so a remounted dialog's
      // clone into this folder waits for it.
      const attempt = cloneAttemptRef.current;
      if (attempt === null) return;
      if (attempt.reattach && attempt.cancellation === null) {
        attempt.cancellation = settleCancellation(attempt.requestCancel());
      }
      attempt.controller.abort();
    },
    [],
  );
```

6. Replace `submitClone` from `const controller = new AbortController();` to the end of its body with the code below. Keep the dependency list and add `selectedHost.label` to it.

```ts
    const url = cloneUrl.trim();
    const parentDir = cloneParent.trim();
    const environmentId = selectedHost.environmentId;
    const attempt: CloneAttempt = {
      controller: new AbortController(),
      hostLabel: selectedHost.label,
      requestCancel: () => input.operations.cancelClone({ environmentId, url, parentDir }),
      phase: "cloning",
      reattach: false,
      cancellation: null,
    };
    cloneAttemptRef.current = attempt;
    setCloneProgress("cloning");
    let cloned = false;
    let outcome: AddProjectOutcome;
    try {
      outcome = await input.operations.clone({
        environmentId,
        url,
        parentDir,
        shouldContinue: () => isCurrent(generation),
        // After Cancel, a clone that finished anyway stays on disk unregistered.
        shouldRegister: () => attempt.cancellation === null,
        signal: attempt.controller.signal,
        onProgress: (progress) => {
          attempt.phase = progress.phase;
          attempt.reattach = progress.reattach;
          if (attempt.cancellation !== null || !isCurrent(generation)) return;
          setCloneProgress(progress.phase);
          setNotice(
            progress.phase === "reconnecting" ? cloneReconnectingNotice(attempt.hostLabel) : null,
          );
        },
        onCloned: () => {
          cloned = true;
          if (cloneAttemptRef.current === attempt) {
            cloneAttemptRef.current = null;
          }
          if (isCurrent(generation)) {
            setNotice(null);
            setCloneProgress("registering");
          }
        },
      });
    } catch (cause) {
      outcome = { _tag: "Failed", title: "Clone failed", error: cause };
    } finally {
      if (cloneAttemptRef.current === attempt) {
        cloneAttemptRef.current = null;
      }
    }
    // A stale attempt returns at once; the client runtime still holds any new clone into this
    // folder until its cancel has settled.
    if (!isCurrent(generation)) {
      return;
    }
    // Keep Cancelling… until the cancel settles.
    const cancellation = attempt.cancellation === null ? null : await attempt.cancellation;
    if (!isCurrent(generation)) {
      return;
    }
    setCloneProgress("idle");
    setNotice(null);
    if (outcome._tag === "Opened") {
      closeAfterSuccess(generation);
      return;
    }
    finishAsync(generation);
    const feedback = cloneFeedback(outcome, attempt, cancellation, cloned);
    if (feedback.kind === "notice") {
      setNotice(feedback.text);
    } else {
      setError(feedback.text);
    }
```

7. Replace `cancelClone` (591-593) with:

```ts
  const cancelClone = useCallback(() => {
    const attempt = cloneAttemptRef.current;
    if (attempt === null || attempt.cancellation !== null) {
      return;
    }
    if (!attempt.reattach) {
      // Older server: interrupting the request is what stops the clone.
      attempt.controller.abort();
      return;
    }
    setCloneProgress("cancelling");
    setNotice(
      attempt.phase === "reconnecting" ? cloneCancelPendingNotice(attempt.hostLabel) : null,
    );
    const cancellation = settleCancellation(attempt.requestCancel());
    attempt.cancellation = cancellation;
    // A failed or stopped cancel leaves nothing to wait for: stop following the clone. An
    // acknowledged one lets the clone request report its own outcome.
    void cancellation.then((settled) => {
      if (settled._tag === "Failed") {
        attempt.controller.abort();
      }
    });
  }, []);
```

8. In the outer `useAddProjectWorkflow`:
   - Add `const cancelCloneCommand = useAtomCommand(vcsEnvironment.cancelClone, { reportFailure: false });` after `cloneRepository` (713).
   - In `createAddProjectOperations({…})`, replace `cloneRepository` and add `cancelClone`:

```ts
        cloneRepository: async (commandInput) =>
          adaptAtomResult(
            await cloneRepository(
              {
                environmentId: commandInput.environmentId,
                input: {
                  url: commandInput.url,
                  parentDir: commandInput.parentDir,
                  ...(commandInput.onProgress === undefined
                    ? {}
                    : { onProgress: commandInput.onProgress }),
                },
              },
              // Aborting ends this dialog's wait. Without re-attach it also interrupts the RPC,
              // and the server stops Git; with re-attach only vcs.cancelClone stops the clone.
              { signal: commandInput.signal },
            ),
          ),
        cancelClone: async (commandInput) =>
          adaptAtomResult(
            await cancelCloneCommand({
              environmentId: commandInput.environmentId,
              input: { url: commandInput.url, parentDir: commandInput.parentDir },
            }),
          ),
```

   - Add `cancelCloneCommand` to that `useMemo`'s dependency array.

- [ ] **Step 5: Run the web tests to verify they pass**

Run: `vp test run apps/web/src/components/add-project`
Expected: PASS (every file in the folder).

Run: `vp run --filter @bibcode/web typecheck`
Expected: exit 0.

- [ ] **Step 6: Capture the red evidence**

| Test | Deliberate break | Expected red |
| --- | --- | --- |
| `keeps Cancelling… until the server cancel settles, so a retry is never cancelled by it` | Do not await `attempt.cancellation` in `submitClone` | `cloneProgress` is `idle` after the clone's reply: "cancelling" expected |
| `cancels on the server while disconnected and ends with the server's answer` | Abort the clone as soon as the cancel is acknowledged | `signal.aborted` is `true` |
| `never stays in Cancelling… when the host comes back without re-attach` | Do not abort on a failed settlement | The submission never resolves; the test times out |
| `shows a folder the cancelled clone could not remove instead of a clean cancel` | In `cloneFeedback`, return the cancelled notice before looking at a `Failed` outcome | "Clone cancelled." instead of the detail |
| `does not add a clone that finished while its cancel was pending` | Drop `shouldRegister` from the clone call | `createProject` is called |
| `asks the host to cancel, as best effort, and stops waiting when the workflow unmounts` | Only abort in the unmount effect | `cancelClone` is not called |
| `a stale attempt returns without waiting for its cancel` | Await `attempt.cancellation` before the first staleness check | The submission never resolves: the test times out |

- [ ] **Step 7: Task gate**

Run: `vp check`
Expected: exit 0.

- [ ] **Step 8: Checkpoint**

Record the checkpoint tree hash, results, and red evidence in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

## Phase 5 — Documentation, gates, and verification

### Task 11: Living architecture and user docs

Other agents hold uncommitted edits in all four files. Use targeted `Edit`s on the exact passages quoted below, and never reformat surrounding text. If a quoted passage has moved or changed, re-find it by its first sentence.

**Files:**
- Modify: `docs/architecture/rpc-and-orchestration.md` (cancellation bullet, ~1985-1998; clone-runtime paragraph after the catalog-runtime paragraph, ~1038-1044)
- Modify: `docs/architecture/overview.md` (Git driver clone paragraph, 164-171)
- Modify: `docs/architecture/connection-runtime.md` (atom-command abort paragraph, 496-502)
- Modify: `docs/user/workspace-ui.md` (clone paragraph, 117-123)

**Interfaces:** documentation only; it describes Tasks 1-10.

- [ ] **Step 1: `rpc-and-orchestration.md` — the cancellation handoff**

Replace:

```text
  Work that must finish cleanup before the caller continues cancels its token
  instead: clone's owned transfer task stops the process group and removes the
  destination it created.
```

with:

```text
  Work that must finish cleanup before the caller continues cancels its token
  instead: a clone's owned transfer task stops the process group and removes the
  destination it created. With `detach`, admission into the clone runtime is
  the clone's handoff: caller cancellation (Interrupt, socket teardown, a
  dropped handler) then ends only that caller's wait, and only
  `vcs.cancelClone` or shutdown stops the clone. Without `detach`, a starter's
  cancellation still cancels its clone; a caller that joined a running clone
  never cancels it by leaving.
```

- [ ] **Step 2: `rpc-and-orchestration.md` — the clone runtime bound**

Insert after the paragraph ending "…shutdown closes admission before draining all accepted tasks." (the catalog-operation runtime paragraph):

```text
The clone runtime (`apps/server/src/production/clone_operations.rs`, owned by
`GitVcsRpcServices`) serves `vcs.clone` and `sourceControl.cloneRepository`. It
keys one live clone per destination: the canonical parent folder plus the leaf
derived from `directoryName` or the URL. A request for the same URL joins the
live clone and shares its outcome; another URL gets `GitCloneOperationError`
`busy` at once, without naming the running clone's URL. A new clone of the same
URL waits for a cancelled one's cleanup, then starts. Admission never waits: at
most 16 clones are live, and a full or closed runtime answers `capacity` or
`shutting-down`. Each clone owns a root cancellation token, a tracked task, and
a clone of its starter's admission permit, so the update drain names a detached
`vcs.clone` until Git has stopped and its cleanup has finished. Git runs in a
task of its own: the clone's task removes the folder it created after any
failure, cancellation, or panic of that transfer, and only then publishes the
outcome and frees its slot. A cancelled clone whose folder could not be removed
reports that folder, not a clean cancel. `attach: true` is join-only: it joins
a live clone, returns a failed or cancelled outcome retained for the same URL,
or runs the reuse check without reserving (the finished clone's path, the
incomplete-clone error, or `not-in-progress`). An attach that raced a new clone
admits again and joins it. Outcomes are retained for five minutes per
destination and URL and swept on every access. None is dropped early: once
live clones plus retained outcomes reach 256, a new clone is refused with
`capacity` until outcomes expire.
`vcs.cancelClone` takes the clone's own input, cancels a live clone of that
URL, and answers `{ cancelled }` after that clone's outcome is published:
`true` unless Git had already succeeded, and it never touches a finished clone.
A caller that leaves a waiting `vcs.clone` or `vcs.cancelClone` gets an
`Interrupt` exit, never a typed failure. Shutdown closes admission, cancels
every live clone, and drains beside the worktree-removal tasks, so Git stops
and each partial folder is removed before providers and terminals shut down.
Clients send `attach` and `detach` only when the server advertises
`vcsCloneReattach`: `CloneInput` accepts unknown fields, so an older server
would run an `attach` as a new clone.
```

- [ ] **Step 3: `overview.md` — the clone lifecycle**

Replace the text from "Clone\n  reserves its\n  destination before Git runs," through "…asks the user to remove it or choose another folder." (lines 164-171) with:

```text
  Clone runs in a server-owned clone runtime keyed by
  destination (canonical parent plus leaf). It reserves its destination before
  Git runs, and its owned task removes only a destination that clone created
  after a failure, timeout, stall, cancellation, or panic of the transfer,
  before it reports the outcome. A caller that asked to
  `detach` can lose its socket without stopping the clone; a later session
  re-attaches, and `vcs.cancelClone` or shutdown stops it. An orphaned clone runs
  to completion under the 24-hour bound and, for HTTP(S), the stall guard. A new
  clone into a destination still being cleaned up waits for that cleanup.
  Reusing an existing destination requires a `HEAD` that resolves to a commit
  and an index file (`git rev-parse --git-path index`); otherwise the error
  names the incomplete clone and asks the user to remove it or choose another
  folder.
```

- [ ] **Step 4: `connection-runtime.md` — Cancel clone and the re-attach loop**

Replace the sentence "Add Project's **Cancel clone** uses this on the `serial` clone command." (end of the atom-command abort paragraph, ~502) with:

```text
Add Project's clone command is `serial` per destination. Against a server
without `vcsCloneReattach`, it is today's single `vcs.clone` call, and **Cancel
clone** or closing the dialog aborts it, so the interrupt stops the clone.

With the capability, the command (`state/vcsClone.ts`) owns the re-attach loop;
React owns no retry loop. It sends `detach: true`. On `RpcClientError`,
`EnvironmentRpcUnavailableError`, or an interrupt it did not request (the RPC
client resumes pending calls with an interrupt when the socket closes), it
reports `reconnecting`, waits for the next session as `subscribe()` does, and
re-issues with `attach: true`. Typed failures never re-attach. There is no
attempt limit and no timer. The loop ends at an outcome, at an abort, when the
environment is blocked or disconnected by the user, or on a session without the
capability; the last two end with `VcsCloneStoppedError`.

**Cancel clone** then sends `vcs.cancelClone` on its own command lane, because
the clone holds the destination's serial lane. The cancel waits for a session
that advertises `vcsCloneReattach` (it stops with `VcsCloneStoppedError` on one
that does not). The form stays in **Cancelling…** until both the clone request
and that cancel have settled: the cancel is keyed by destination, so a new
clone into the same folder must not start while a cancel may still be retrying.
The client runtime enforces this, not the dialog. The cancel command records
itself in a module-level registry keyed by environment and destination, and a
clone into that folder waits for every pending cancel to settle before it
dispatches, even after the dialog unmounted and a new one mounted.
Only a failed or stopped cancel ends the clone wait early; otherwise the clone
request reports its own outcome, including a folder that could not be removed.
A clone that finishes while its cancel is pending is not added as a project.
Closing the dialog's window sends `vcs.cancelClone` as best effort: a closing
or disconnected window may never get it out, and then the clone keeps running
on the host (the orphan policy). An abort alone only stops following the clone.
```

- [ ] **Step 5: `workspace-ui.md` — user behaviour**

Replace the paragraph beginning "While a clone runs, the clone form stays open with **Cancel clone**." (117-123) with:

```text
While a clone runs, the clone form stays open with **Cancel clone**. If the
connection to the host drops, the clone keeps running there: the form shows
"Lost the connection to <host>. The clone continues on the server;
reconnecting…", and when the connection returns it resumes following the clone
and adds the project once it finishes. Cancelling stops Git, shows "Clone
cancelled.", and removes the folder the clone created; while disconnected, the
form shows **Cancelling…** until the host is back, and it accepts a new clone
only once the host has confirmed the cancel. If the clone had already finished,
the folder stays and the next **Clone** into it adds it. Closing the window
during a clone asks the host to cancel it, but a closing or disconnected window
may not reach the host; the clone then keeps running there, and cloning the
same URL into the same folder later joins it or adds the finished repository.
A failed clone shows the reason in the form,
including a stalled transfer or an incomplete earlier clone in the chosen
folder (remove it or choose another folder). If the host cannot be reached
again, the form says so; cloning the same URL into the same folder later joins
the clone or adds the finished repository. The dialog closes once the project
has been added and opened.
```

- [ ] **Step 6: Verify**

Run: `vp check`
Expected: exit 0 (formatting of Markdown included). If `vp check` flags only files other agents own, record that and continue.

Run: `rg -n "CloneDestinationRegistry|waits for that cleanup|Closing the window also cancels" docs/architecture docs/user`
Expected:
- no reference to the removed registry;
- no promise that closing a window cancels a clone. That would contradict the orphan policy (pre-flight item 11).
- The "waits for that cleanup" hit in `overview.md` is intended.

- [ ] **Step 7: Checkpoint**

Record the checkpoint tree hash and results in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 12: Testing runbooks (AGENTS.md "Testing Runbook Maintenance")

This change alters process cancellation, ownership, and cleanup, and a UI flow, so the runbooks must change in the same change.

**Files:**
- Modify: `docs/testing/cross-platform-validation.md` ("Clone from URL network scenario", 1117-1140)
- Modify: `docs/testing/execution-report-template.md` ("Clone from URL network scenario", 215-220)
- Review only: `docs/testing/README.md`, `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md`, `docs/testing/ssh-environments.md`. None describes Clone from URL today (`rg -n -i clone docs/testing` confirms). Report them as **reviewed and remain accurate** unless that search finds a clone step.

**Interfaces:** documentation only.

- [ ] **Step 1: Add the reconnect scenarios to the runbook**

In `docs/testing/cross-platform-validation.md`, after step 4 of "Clone from URL network scenario" (the pre-existing half clone, ending "…offers Fetch."), insert:

```text
Steps 5-8 need the clone to still be running when the outage, the Cancel, or
the restart reaches the host. Either use a fixture whose clone lasts at least
three times the longest outage (for example 120 MB or more of incompressible
data at about 600 KB/s, over 200 seconds), or switch the throttled server to a
slow rate during the event. Keep that rate above 1 KB/s, or Git's stall guard
ends the clone. Record which method was used.

5. Connection drop during a throttled clone: after the clone has run for about
   ten seconds, drop the client's connection for at least 40 seconds (take the
   network offline, or stop a TCP proxy between client and server). The form
   keeps **Cloning…** and shows "Lost the connection to <host>. The clone
   continues on the server; reconnecting…". The destination folder keeps
   growing on the server. After the connection returns, the line clears, the
   clone completes, and the dialog closes once the project appears. If the
   clone finished during the outage, the re-attach finds the finished clone
   and adds it the same way.
6. Cancel across a reconnect: start a throttled clone and drop the connection.
   Press **Cancel clone** while disconnected. The form shows **Cancelling…**
   and "The clone stops when <host> reconnects.". Restore the connection: the
   form shows "Clone cancelled.". State the outcome for the case that
   occurred: a partial clone (Git still running when the Cancel reached the
   host) has its folder removed; a completed clone (Git finished first) keeps
   its folder with a full checkout, and the next Clone into it adds it. Repeat
   with the connection restored before pressing Cancel, with the same two
   outcomes.
7. Server restart mid-clone: stop the server gracefully during a throttled
   clone and start it again. For a partial clone, the destination folder is
   removed during shutdown, and after reconnecting the form shows "No clone is
   in progress for <path>. Press Clone to start again.". A clone that
   completed before the stop is found again after reconnecting, and the
   project is added.
8. Window closed mid-clone (orphan policy): close the client window during a
   throttled clone against a remote host. The cancel is best effort, so the
   clone may keep running on the host. Reopen the client, and clone the same
   URL into the same folder: it joins the running clone or adds the finished
   repository. It must never report an incomplete clone while the orphan runs.
```

- [ ] **Step 2: Add the evidence lines to the report template**

In `docs/testing/execution-report-template.md`, append to the "Clone from URL network scenario" list:

```text
- Connection drop: outage length, reconnecting line shown, clone duration, registration after reconnect:
- Fixture duration or slow-rate method used to keep the clone running through each event:
- Cancel across a reconnect: Cancelling… line, "Clone cancelled." after reconnect, whether the clone was partial (folder removed) or completed (folder kept), for the disconnected and reconnected variants:
- Server restart mid-clone: partial or completed at the stop; partial folder removed at shutdown and the exact "No clone is in progress…" message, or the completed clone added:
- Window closed mid-clone: whether the host kept cloning, and the result of re-cloning the same URL into the same folder (joined or added):
```

- [ ] **Step 3: Verify**

Run: `vp check`
Expected: exit 0 for these files.

- [ ] **Step 4: Checkpoint**

Record the checkpoint tree hash and results in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 13: Gates

**Files:** none changed; this task is evidence only.

- [ ] **Step 1: Contract gate (temporary fixture index)**

Run the exact temporary-index block from Task 1 Step 6.
Expected: `vp run check:contracts` exits **0**. Report `check:contracts: PASS (exit 0, temporary fixture index)`.

- [ ] **Step 2: Workspace gates**

Run: `vp check`
Expected: exit 0.

Run: `vp run typecheck`
Expected: exit 0.

- [ ] **Step 3: Rust gates**

Run: `cargo fmt --all --check`
Expected: exit 0.

Run: `cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: exit 0.

- [ ] **Step 4: Broader tests across the changed packages**

Run: `vp test run packages/contracts packages/client-runtime/src/state apps/web/src/components/add-project`
Expected: all files pass.

Run: `cargo test -p bibcode-server --lib`
Expected: `test result: ok.` Classify known host flakes (see Global Constraints) with a focused re-run.

Run: `rg -n "Deliberate break" docs/superpowers/plans/2026-09-24-clone-reconnect.md`, and check that the ledger holds the recorded red for every row of every task's red-evidence table.

Run: `cargo test -p bibcode-server --test production_git_vcs_rpc --test production_maintenance --test rpc_wire --test git_coverage --test production_control`
Expected: `test result: ok.` for each binary.

- [ ] **Step 5: Record**

Record every command with its exit code in the ledger. Name any command that could not run and why.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 14: Live Playwright verification (isolated dev server)

The **controller runs these commands on the host**, because the Codex sandbox cannot bind loopback sockets. The implementer writes the scratch scripts under `$LIVE` and hands off the exact commands. Nothing here touches the repository or port 3773. Never stop a process you did not start.

**Files (scratch only):**
- `$LIVE/serve-git.mjs`
- `$LIVE/pair.mjs`
- `$LIVE/drive.mjs`
- `$LIVE/run-restart.sh`
- evidence in `$LIVE/shots/` and `$LIVE/logs/`

**Interfaces:**
- Consumes: Tasks 1-10 on a dev server.
- Produces: screenshots and a JSON log per scenario, plus a ledger entry.

- [ ] **Step 1: Prepare the live root and a large throttled remote**

```bash
S=/tmp/claude-1000/-work-workspaces-orca-BibCode-main-3/2c4f97f1-0ee1-4c37-b2bb-432255e2f351/scratchpad
LIVE=$S/clone-live
mkdir -p $LIVE/home $LIVE/git $LIVE/shots $LIVE/logs $LIVE/clones
# Playwright: reuse an existing scratch install, else install one into the scratch root only.
if [ -d $S/s2-liveness/node_modules/playwright ]; then ln -sfn $S/s2-liveness/node_modules $LIVE/node_modules
else npm install --prefix $LIVE playwright@1 && npx --prefix $LIVE playwright install chromium; fi
# About 30 MB of incompressible data: about 150 s at 200 KiB/s.
rm -rf $LIVE/src && mkdir $LIVE/src && git -C $LIVE/src init -q -b main
head -c 31457280 /dev/urandom > $LIVE/src/blob.bin
git -C $LIVE/src add blob.bin
git -C $LIVE/src -c user.name=live -c user.email=live@example.invalid -c commit.gpgSign=false commit -q -m blob
rm -rf $LIVE/git/big.git && git clone -q --bare $LIVE/src $LIVE/git/big.git
```

Write `$LIVE/serve-git.mjs`, a smart-HTTP server (`git http-backend`) whose response bodies are throttled:

```js
// Scratch only. Smart-HTTP Git over `git http-backend`, response bodies throttled to RATE B/s.
// While SLOW_FILE exists, bodies go out at 4 KiB/s: above Git's 1 KB/s stall guard, so the
// clone keeps running, but far too slowly to finish during an outage or before a Cancel lands.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";

const root = process.env.GIT_ROOT;
const port = Number(process.env.PORT ?? 19480);
const rate = Number(process.env.RATE ?? 204800);
const slowFile = process.env.SLOW_FILE;
const SLOW_RATE = 4096;
const currentRate = () => (slowFile !== undefined && existsSync(slowFile) ? SLOW_RATE : rate);

createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: req.headers["content-length"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  req.pipe(cgi.stdin);
  const queue = [];
  let header = Buffer.alloc(0);
  let started = false;
  let ended = false;
  cgi.stdout.on("data", (chunk) => {
    if (started) return void queue.push(chunk);
    header = Buffer.concat([header, chunk]);
    const split = header.indexOf("\r\n\r\n");
    if (split < 0) return;
    let status = 200;
    const headers = {};
    for (const line of header.subarray(0, split).toString("latin1").split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    queue.push(header.subarray(split + 4));
    started = true;
  });
  cgi.stdout.on("end", () => (ended = true));
  const timer = setInterval(() => {
    let budget = Math.ceil(currentRate() / 10);
    while (budget > 0 && queue.length > 0) {
      const head = queue[0];
      const part = head.subarray(0, budget);
      res.write(part);
      budget -= part.length;
      if (part.length === head.length) queue.shift();
      else queue[0] = head.subarray(part.length);
    }
    if (ended && started && queue.length === 0) {
      clearInterval(timer);
      res.end();
    }
  }, 100);
  res.on("close", () => {
    clearInterval(timer);
    cgi.kill();
  });
}).listen(port, "127.0.0.1", () => console.log(`git on http://127.0.0.1:${port}/`));
```

- [ ] **Step 2: Start the remote and an isolated dev server**

Pick an unused offset (this plan uses `41`: server `13814`, web `5774`). Start the server and the web client separately, so the server can be restarted alone in scenario C. Record every PID you start.

```bash
cd /work/workspaces/orca/BibCode/main-3
GIT_ROOT=$LIVE/git PORT=19480 RATE=204800 SLOW_FILE=$LIVE/slow node $LIVE/serve-git.mjs > $LIVE/logs/git.log 2>&1 & echo $! > $LIVE/git.pid
BIBCODE_PORT_OFFSET=41 BIBCODE_HOME=$LIVE/home vp run dev:server > $LIVE/logs/server.log 2>&1 & echo $! > $LIVE/server.pid
BIBCODE_PORT_OFFSET=41 BIBCODE_HOME=$LIVE/home vp run dev:web > $LIVE/logs/web.log 2>&1 & echo $! > $LIVE/web.pid
```

Wait until `$LIVE/logs/server.log` prints the one-time pairing URL (the server's startup token; `bibcode pairing offer` cannot target a dev data root). Save only the token to `$LIVE/.token`. Never print it; write `<REDACTED>` in logs.

Write `$LIVE/pair.mjs`, which exchanges the token in a persistent browser profile:

```js
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const LIVE = process.env.LIVE, WEB = process.env.WEB;
const token = readFileSync(`${LIVE}/.token`, "utf8").trim();
const context = await chromium.launchPersistentContext(`${LIVE}/profile`, { headless: true });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`http://localhost:${WEB}/pair#token=${token}`, { waitUntil: "domcontentloaded" });
await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 90_000 });
await page.screenshot({ path: `${LIVE}/shots/paired.png` });
await context.close();
```

Run: `LIVE=$LIVE WEB=5774 node $LIVE/pair.mjs`
Expected: exit 0 and `shots/paired.png` shows the app.

- [ ] **Step 3: Write the driver**

Write `$LIVE/drive.mjs`. It takes the scenario from `SCENARIO` (`drop`, `cancel-offline`, `cancel-online`, `restart`):

```js
import { chromium } from "playwright";
import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LIVE = process.env.LIVE, WEB = process.env.WEB, SCENARIO = process.env.SCENARIO;
const URL_ = "http://127.0.0.1:19480/big.git";
// While this file exists, the remote sends 4 KiB/s, so the clone is still partial whenever the
// outage, the Cancel, or the restart reaches the host.
const SLOW = `${LIVE}/slow`;
rmSync(SLOW, { force: true });
const PARENT = `${LIVE}/clones/${SCENARIO}`;
const DEST = `${PARENT}/big`;
rmSync(PARENT, { recursive: true, force: true });
execFileSync("mkdir", ["-p", PARENT]);
const T0 = Date.now();
const log = (label, extra = {}) =>
  console.log(JSON.stringify({ t: ((Date.now() - T0) / 1000).toFixed(1), label, ...extra }));
const context = await chromium.launchPersistentContext(`${LIVE}/profile`, {
  headless: true,
  viewport: { width: 1400, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
const dialog = () => page.locator('[role="dialog"]:has(#add-project-clone-url)').first();
const dialogText = async () => (await dialog().innerText().catch(() => "")).replace(/\s+/g, " ");
const shot = (name) => page.screenshot({ path: `${LIVE}/shots/${SCENARIO}-${name}.png` });
const until = async (predicate, ms, label) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return log(label);
    await page.waitForTimeout(250);
  }
  await shot(`timeout-${label.replace(/\W+/g, "-")}`);
  throw new Error(`timed out: ${label}; dialog: ${await dialogText()}`);
};

await page.goto(`http://localhost:${WEB}/`, { waitUntil: "domcontentloaded" });
await page.getByTestId("sidebar-add-project-trigger").click({ timeout: 90_000 });
await page.getByRole("button", { name: /Clone from URL/ }).first().click();
await page.locator("#add-project-clone-url").fill(URL_);
await page.locator("#add-project-clone-parent").fill(PARENT);
await dialog().locator('button[type="submit"]').click();
await until(async () => existsSync(DEST), 30_000, "destination created");
await page.waitForTimeout(10_000);
writeFileSync(SLOW, "");
log("remote slowed: the clone cannot finish before the scenario's event");
await shot("running");

const reconnecting = /Lost the connection to .+\. The clone continues on the server; reconnecting…/;
if (SCENARIO === "drop" || SCENARIO === "cancel-offline" || SCENARIO === "cancel-online") {
  await context.setOffline(true);
  await until(async () => reconnecting.test(await dialogText()), 20_000, "reconnecting line");
  await shot("reconnecting");
  if (SCENARIO === "cancel-offline") {
    await dialog().getByRole("button", { name: "Cancel clone" }).click();
    await until(async () => /Cancelling…/.test(await dialogText()) && /The clone stops when .+ reconnects\./.test(await dialogText()), 5_000, "cancelling line");
    await shot("cancelling");
  }
  await page.waitForTimeout(40_000);
  log("folder still present during the outage", { exists: existsSync(DEST) });
  await context.setOffline(false);
}
if (SCENARIO === "drop") {
  await until(async () => !reconnecting.test(await dialogText()), 60_000, "reconnecting line cleared");
  // Back to full speed, so the re-attached clone completes and registers.
  rmSync(SLOW, { force: true });
  await until(async () => !(await dialog().isVisible().catch(() => false)), 600_000, "dialog closed after registration");
  log("clone on disk", { head: execFileSync("git", ["-C", DEST, "rev-parse", "HEAD"]).toString().trim() });
  await shot("registered");
} else if (SCENARIO === "cancel-online") {
  await until(async () => !reconnecting.test(await dialogText()), 60_000, "reconnected");
  await dialog().getByRole("button", { name: "Cancel clone" }).click();
}
if (SCENARIO === "cancel-offline" || SCENARIO === "cancel-online") {
  await until(async () => /Clone cancelled\./.test(await dialogText()), 60_000, "Clone cancelled.");
  await until(async () => !existsSync(DEST), 30_000, "destination removed");
  await shot("cancelled");
}
if (SCENARIO === "restart") {
  const pid = Number(readFileSync(`${LIVE}/server.pid`, "utf8"));
  log("stopping the dev server gracefully", { pid });
  process.kill(pid, "SIGTERM");
  await until(async () => !existsSync(DEST), 60_000, "partial folder removed at shutdown");
  console.log("RESTART-NOW");
  await until(async () => /No clone is in progress for .+\. Press Clone to start again\./.test(await dialogText()), 180_000, "not-in-progress copy");
  await shot("restarted");
}
rmSync(SLOW, { force: true });
await context.close();
```

`process.kill(pid, "SIGTERM")` targets the PID recorded when `vp run dev:server` was started. If that PID is the runner and not the `bibcode` server, confirm with `pgrep -P <pid>` that the server is its child, and signal only that child. Never use `pkill -f`.

- [ ] **Step 4: Run the scenarios**

Run the three connection scenarios. `pipefail` makes a failing driver fail its pipeline even though the output goes through `tee`. Every scenario runs, so all the evidence is collected, and the block's final status is non-zero if any scenario failed:

```bash
set -o pipefail
failed=0
for scenario in drop cancel-offline cancel-online; do
  if ! LIVE=$LIVE WEB=5774 SCENARIO=$scenario node $LIVE/drive.mjs | tee $LIVE/logs/$scenario.jsonl; then
    echo "scenario $scenario failed"
    failed=1
  fi
done
test "$failed" -eq 0
```

The restart scenario must restart the server while the driver keeps running. Write `$LIVE/run-restart.sh`, which captures the driver's own PID and waits on exactly that process (a bare `wait %1` could wait on the Git server job started in Step 2):

```bash
#!/usr/bin/env bash
set -euo pipefail
LIVE=$1
REPO=/work/workspaces/orca/BibCode/main-3
LIVE=$LIVE WEB=5774 SCENARIO=restart node "$LIVE/drive.mjs" > "$LIVE/logs/restart.jsonl" 2>&1 &
driver=$!
until grep -q RESTART-NOW "$LIVE/logs/restart.jsonl"; do
  if ! kill -0 "$driver" 2>/dev/null; then
    cat "$LIVE/logs/restart.jsonl"
    exit 1
  fi
  sleep 1
done
# Start the server again with the same environment, and record the new PID for cleanup.
(cd "$REPO" && BIBCODE_PORT_OFFSET=41 BIBCODE_HOME="$LIVE/home" vp run dev:server \
  > "$LIVE/logs/server-2.log" 2>&1 & echo $! > "$LIVE/server.pid")
wait "$driver"
```

Run it as one background command (`bash $LIVE/run-restart.sh $LIVE`). Its exit status is the driver's.

Expected:
- `drop`: the reconnecting line appears within 20 s of going offline. The folder is still present after the 40 s outage. The line clears after reconnecting. The dialog closes after registration, and `git rev-parse HEAD` succeeds.
- `cancel-offline`: **Cancelling…** and "The clone stops when <host> reconnects." show while offline. "Clone cancelled." follows after reconnecting, and the folder is removed.
- `cancel-online`: after reconnecting, **Cancel clone** gives "Clone cancelled.", and the folder is removed.
- `restart`: the partial folder is removed during shutdown. After the restart, the form shows "No clone is in progress for <path>. Press Clone to start again.".

Every scenario slows the remote to 4 KiB/s once the clone is running, which stays above Git's 1 KB/s stall guard. So the clone is still partial when the outage, the Cancel, or the restart reaches the host, and the outcomes above are the partial-clone outcomes. A clone that had already completed when a Cancel arrived would keep its folder (D10, D12). This run never reaches that case; the runbook records it (Task 12).

The drop uses the browser `offline` event, which ends the connection lease at once. The outage length (40 s) exceeds both the current ~5 s Pong timeout and the 30 s ±10 % silence bound after liveness Task 2, so this step stays valid whether or not that plan has landed.

- [ ] **Step 5: Clean up what you started**

Stop exactly the PIDs in `$LIVE/git.pid`, `$LIVE/server.pid`, and `$LIVE/web.pid` (and the runner children you confirmed with `pgrep -P`). Leave `$LIVE` in place as evidence.

- [ ] **Step 6: Record**

Record the scenario results, durations, exact copy, and screenshot names in the ledger.

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

### Task 15: React and UI reviews, final diff review

**Files:** no planned changes. Fix only what a review finds, then re-run that task's focused tests.

- [ ] **Step 1: `vercel-react-best-practices` review**

Read `/home/mauro/.agents/skills/vercel-react-best-practices/SKILL.md` (and its `AGENTS.md` or `rules/`). Review the changed parts of `useAddProjectWorkflow.ts` and `AddProjectSteps.tsx`. Check at least:
- no state derived in effects;
- stable callbacks (`cancelClone` has an empty dependency list and reads refs; `submitClone`'s dependency list includes `selectedHost.label`);
- no new re-render cascade from `onProgress` (it sets state only when the phase or notice changes);
- the unmount effect's ref read is safe (`cloneAttemptRef` is not a DOM ref);
- the attempt's mutable fields (`phase`, `reattach`, `cancellation`) live on the ref object and never drive rendering directly; rendering follows only `cloneProgress`, `notice`, and `error` state;
- the fire-and-forget promise chains (`settleCancellation`, the abort on a failed settlement) cannot set state after unmount (they touch only the attempt and its `AbortController`).

Report findings, or "no findings". An agent without the skill reports this review as "not run".

- [ ] **Step 2: `UI.md` review**

Read `UI.md` at the repository root. Check the dialog against it:
- the reconnecting line tells the user the clone is safe and what is happening, so they do not restart a live clone;
- the disabled **Cloning…** and **Cancelling…** buttons have a visible reason next to them;
- every error is actionable (each one names the next step);
- form values survive every outcome;
- `busy` never shows the other clone's URL;
- **Cancel clone** is hidden while a cancel is pending, and the form stays **Cancelling…** until the host settled the cancel, so the user cannot start a clone that an old cancel would stop;
- nothing promises that closing the window cancels a clone (the orphan policy keeps it running; re-cloning joins it).

Report findings, or "no findings".

- [ ] **Step 3: Final diff review**

```bash
git status --short > $S/clone-reconnect-status-end.txt
diff $S/clone-reconnect-status-start.txt $S/clone-reconnect-status-end.txt
git diff --stat
git status --short -- packages/contracts/fixtures
```

Expected:
- only the files in this plan's File structure changed or were added, plus the three new fixture files;
- no debug output, no `.codegraph/`, no scratch files in the repository, no dependency or lockfile drift;
- other agents' files are unchanged by this work.

- [ ] **Step 4: Report**

Report:
- every validation command with its exit code;
- the two review results, and the runbook review statement ("`docs/testing/README.md` and the native runbooks were **reviewed and remain accurate**");
- any command that could not run;
- the residual risks (the spec's Residuals section, plus any flake classified during Task 13).

- [ ] **Stop: the controller runs a Codex review and asks the user before committing.**

---

## Self-review

Re-run on 2026-09-25 after the pre-flight corrections, and again after round 2, against the spec, section by section.

**Spec coverage**

| Spec requirement | Task |
| --- | --- |
| Runtime owned by `GitVcsRpcServices`, replaces `CloneDestinationRegistry` | 4 |
| Entry: URL, root token, state watch, detach, admission-permit clone, tracked task; bound 16, non-waiting | 4 |
| Start-or-join: same URL joins; cleaning up waits then starts; another URL `busy` at once | 4 (unit and integration) |
| `attach` join-only: join, retained outcome, disk check (path / incomplete / `not-in-progress`) | 4 (with D14 revalidation) |
| Caller cancellation rules (detach, joiners) | 4 |
| `vcs.cancelClone` input, semantics, idempotence, scope, `mutation_unary` | 5 |
| Failure retention five minutes; success not retained | 4 (D11: never dropped early, bounded at admission), 5 (cancel sweeps) |
| Shutdown closes, cancels, drains beside worktree removals | 6 |
| Orphan policy (no orphan deadline; 24 h bound and stall guard unchanged) | 4 (no deadline added), 11, 12 (runbook step 8) |
| Updates: the drain names `vcs.clone`; the failed preparation's shutdown cleans up | 4 (permit test), 6 (shutdown drain) |
| Closing the dialog cancels; with the capability, Cancel and close send `vcs.cancelClone` (close is best effort) | 10 (D6, D7), 11 |
| The client registers after success or re-attach | 10 |
| Scope: `sourceControl.cloneRepository` uses the runtime without new fields; canonical parent | 4 (D3) |
| Capability `vcsCloneReattach`, default false | 1 (contract), 6 (advertised), 7 (loop and cancel gating) |
| Ruling 5 (cancel keyed by destination) | 5; the client runtime never lets a pending cancel meet a later clone into the same folder, across unmount and remount (7, 8; round-2 item 1), and the dialog shows **Cancelling…** until it settles (10) |
| Ruling 6 (index required; lock not the test) | 2 |
| Ruling 8 (error-path hardening) | Already in tree (`f05100a1`); no task |
| Ruling 9 (no duplicate-project change) | No task, by ruling |
| Ruling 10 (canonical parent plus lexical leaf) | 3, 4 |
| Wire changes and fixtures | 1 (`vcs.clone`), 5 (`vcs.cancelClone`) |
| Client runtime loop, lane, end conditions | 7, 8 |
| UI phases, Cancel visibility, the full copy table | 9, 10 |
| Validation: server, client runtime, web, gates, live | 2-10, 13, 14 |
| Documentation to update | 11, 12 |

**Green-checkpoint audit (pre-flight item 4).** Each task lands a producer with its first consumer:

| Task | Lands together | Why it compiles green alone |
| --- | --- | --- |
| 1 | `vcs.clone` contract, capability, `testSupport.ts`, fixtures | The only full capabilities literal is fixed in the same task. No Rust method changes. |
| 2 | Index check | Self-contained. |
| 3 | Clone API split | Every new item is called by `clone_repository`. |
| 4 | Runtime (`start_or_join`), `inspect_clone_destination`, both handlers, registry removal | No `cancel` or `close_and_drain` yet. Test-only helpers (`success_of`, `BeforeReserve`) are deferred to their first users. |
| 5 | `cancel`, handler, Rust method spec and scope, TS contract, fixtures | `validate_complete` and `rpc_wire` both see the method with its handler. |
| 6 | `close_and_drain`, accessor, runtime drain, capability | The only caller of `close_and_drain` lands with it. |
| 7 | `vcsClone.ts`, including the pending-cancel registry and the clone's wait on it | Unused TypeScript exports do not fail the gates. |
| 8 | Commands wired; the cancel command registers itself in the registry | |
| 9 | Phase union, exhaustive label map, copy helpers | The `Record<AddProjectCloneProgress, string>` is updated with the union. |
| 10 | Workflow and operations | |

**Placeholder scan:** no "TBD", "TODO", or "similar to Task N". Every code step carries code. Every test step carries test code, an exact command, and the expected result. Every new lifecycle test has a red-evidence row.

**Type consistency:**
- Rust:
  - `CloneRequest { url, parent_dir, leaf, attach, detach }`, `CloneRuntime::{new, for_test, start_or_join, cancel, close_and_drain}`, the test accessors `waiters`/`live`/`retained_len`, and `clone_operations()` are used identically in Tasks 4-6.
  - `clone_destination_leaf`, `CloneReservation`, `ReservedClone::{transfer, remove_destination, with_cleanup_failure, run}`, `reserve_clone_destination`, and `inspect_clone_destination` are used identically in Tasks 3-4.
  - `cancel` returns `bool` everywhere (D1, D10).
  - The pause points are `AfterTransfer` and `BeforeInspect` (Task 4) and `BeforeReserve` (Task 6); no task names another.
  - `CLONE_RETAINED_OUTCOME_CAPACITY` bounds live plus retained entries at admission in Tasks 4-6. Nothing evicts.
- TypeScript:
  - `VcsCloneProgress { phase, reattach }`, `VcsCloneCommandInput`, and `VcsCloneStoppedError { reason: "environment-unavailable" | "reattach-unsupported" }` are consistent across Tasks 7-10;
  - so are `GitCancelCloneInput`, `GitCloneOperationError { reason, destination, message }`, `vcsEnvironment.cancelClone`, `AddProjectCloneControl.{onProgress, shouldRegister}`, and the workflow's `CloneAttempt`/`CloneCancellation`;
  - and so are `CloneDestinationInput`, `cloneDestinationLeaf`, `cloneDestinationKey`, and `registerCloneCancel`: defined in Task 7, used by Task 8's `createCancelCloneCommand`.
- The method name `start_or_join` deliberately avoids shadowing `Clone::clone`.

## Open questions for the controller

None blocks implementation, and no spec requirement proved unimplementable against the current source. These points need the controller's attention:

1. **`lifecycle.rs` advertisement.** The spec cites `apps/server/src/lifecycle.rs:63` as a second place to advertise `vcsCloneReattach`. That descriptor (`connect_environment_descriptor`) feeds only the Connect MCP service and omits the whole Git Manager set; RPC clients read `production/control.rs`'s descriptor. Task 6 follows the spec and adds the capability to both. That is harmless, but it does not match how the MCP list was curated. The controller should confirm this or drop the `lifecycle.rs` line (and its test assertion).
2. **Plan-authored decisions D1-D14** fill gaps the spec leaves open. They remain pending until the user approves them. Two deserve a direct look:
   - **D3** also changes today's behaviour: `sourceControl.cloneRepository` used to pass an undeclared `GitCommandError` through, which the client could not decode.
   - **D11**'s cap of 256 retained outcomes. *Resolved in round 2:* the bound is enforced at admission (`capacity`), and no unexpired outcome is ever dropped.
3. **Stale spec citations.** The spec's line numbers predate concurrent edits:
   - the cancellation paragraph is at `rpc-and-orchestration.md:1985-1998`, not 1931-1940;
   - the atom-command paragraph is at `connection-runtime.md:496-502`, not 450-456;
   - the clone paragraph is at `workspace-ui.md:117-123`, not 86-92.

   The spec's pinned fixture counts (131/288/389) end at 132/291/392, or 393 with liveness Task 11. The plan anchors every edit by symbol or quoted text.
4. **Panic coverage (pre-flight item 1) is transfer-only.** A panic in the transfer (Git and its runner) still removes the folder before the outcome is published. A panic in the runtime's own reservation, cleanup, or publishing code publishes a failure without re-running the cleanup, and the reuse check later refuses the leftover. The controller should confirm this scope (Task 4, state-model notes).

## Pre-flight corrections applied (2026-09-25)

The controller accepted all 12 corrections from the Codex pre-flight (`$S/clone/preflight-corrections.md`). Spec ruling 5 stands: cancel stays keyed by destination, so item 2 is fixed on the client.

| Item | Correction | Tasks changed |
| --- | --- | --- |
| 1 | Keep cleanup errors; publish only after cleanup; own the cleanup across a transfer panic | 3 (transfer, removal, and error annotation split out of `ReservedClone::run`); 4 (Git in its own task; publish and free the slot after cleanup; cleanup-failure and panic tests); 5 (D10 answer after publication); 10 (the dialog shows a cleanup failure after Cancel) |
| 2 | A pending cancel must settle before another attempt | 10 (`CloneAttempt.cancellation`, `submitClone` awaits it, lost-acknowledgement-then-retry test); D6 |
| 3 | `startClone` must not await the clone | 10 (`startClone` returns `{ submission }`; every test destructures it) |
| 4 | Every task green on its own | 1 (adds `packages/shared/src/testSupport.ts`; `vcs.cancelClone`'s contract moved to 5); 4-6 re-cut so every producer lands with its consumer; 9 and 10 swapped so the phase union and the exhaustive label map land together; Working conventions and Global Constraints (warnings denied in every target, `validate_complete`, lint rules); 8 (test rewritten without `Effect.runSync`) |
| 5 | An attach must not report a racing clone's folder | 4 (start-generation revalidation and a `BeforeInspect` pause test); D14 |
| 6 | Retained outcomes: match the URL, expire actively, bound them | 4 (URL match, sweep on every access, cap 256 with oldest-first eviction, tests; the eviction was superseded in round 2 by the admission-time bound); 5 (cancel sweeps); D11 |
| 7 | The cancel error contract | 5 (`cancel` is infallible, leaving uses the RPC interruption path, exact-shape Rust test and TypeScript decode test); D1 |
| 8 | Capability-gate the next-session cancel | 7 (`cancelCloneOnNextSession` checks `vcsCloneReattach`, with downgrade and failed-configuration tests); 10 (downgrade while Cancelling… test) |
| 9 | Deterministic lifecycle tests with red evidence | 4 (held-cleanup retry test replacing the deleted barrier test, join proven before release, success-before-leave, retained ordinary failures); 5 (cancel-before-success and success-before-cancel); 6 (admission-versus-shutdown race); red-evidence tables in Tasks 4-10 |
| 10 | Liveness Task 11 fixture count | `2026-09-24-connection-liveness.md` Task 11: the count is stated as a delta relative to the tree it runs on, with 393 expected after this plan (132 methods / 291 typed failures / 362 fingerprints preserved) |
| 11 | Docs contradicted the orphan policy | 11 (unmount cancel documented as best effort, window-close orphan behaviour kept); 12 (runbook step 8 and its report line); D7; 15 (review item) |
| 12 | Validation commands | Working conventions (several filters go after `--`); 4-6 commands; 14 (`set -o pipefail`, `run-restart.sh` waits on the captured driver PID) |

Revising the plan against the source surfaced further fixes, beyond the 12 items:
- Production startup validates every `ACTIVE_RPC_METHODS` entry against the handlers. So `vcs.cancelClone`'s method spec moved from Task 1 to Task 5, where its handler lands; the old Task 1 would have broken production startup.
- `bibcode/no-manual-effect-runtime-in-tests` forbids the old Task 8 test's `Effect.runSync`.
- `bibcode/no-inline-schema-compile` requires module-level decoders.
- The old busy assertion checked the requester's URL rather than the running clone's.

### Round 2 (2026-09-25)

Codex's re-pre-flight found 8 of the 12 items fixed. The controller accepted fixes for the four partial items and a new finding:

| Round-2 item | Correction | Tasks changed |
| --- | --- | --- |
| 1 (item 2, partial) | A cancel outlived unmount and could stop a remounted dialog's retry; `submitClone` awaited the cancel before its staleness check | 7: pending-cancel registry keyed by environment and destination, `cloneDestinationKey`, `cloneWithReattach` waits before dispatch, tests. 8: the cancel command registers synchronously and releases on settle; test for a lost acknowledgement, then unmount, remount, and retry. 10: staleness check before awaiting the cancel, stale-attempt test, notes. D6, the Task 11 connection-runtime text, and Controller rulings item 5 |
| 2 (item 6, partial) | Eviction broke the spec's five-minute retention | 4: admission-time bound (`capacity` at 256 live plus retained), no eviction, test rewritten with red evidence. D11 and the Task 11 rpc text. Controller rulings item 2 marked revised |
| 3 (item 9, partial) | The success-before-leave red evidence could not fail | 4: `AfterTransfer` pause point replaces `BeforePublish`, and the success-before-leave test cancels at it. 5: success-before-cancel uses it too. Red-evidence rows and D13 |
| 4 (item 12, partial) | The live loop exited 0 after a failure | 14: a failure flag and `test "$failed" -eq 0` give a non-zero final status |
| 5 (new) | Fixtures could finish during the outage, so Cancel outcomes were not deterministic | 12: the fixture outlasts the outage three times over, or a slow rate above the stall guard is used; completed and partial outcomes are stated separately, with report lines. 14: slow mode in `serve-git.mjs` (4 KiB/s while `$LIVE/slow` exists); the driver holds the clone partial through the outage, Cancel, and restart |

## Controller rulings on the open questions (2026-09-25)

1. **`lifecycle.rs` advertisement: keep it, as Task 6 does.** The spec is binding. `connect_environment_descriptor` already mirrors client-behaviour capabilities (`terminalOrderedInput`, `terminalSizeOwnership`), so `vcsCloneReattach` fits that pattern. If this is wrong, the cost is one unused flag in the Connect descriptor.
2. **D1–D14 are accepted** as implementation decisions inside the approved spec; none adds new architecture. The report must name D3 (it also fixes today's undecodable `GitCommandError` pass-through), D11 (the cap of 256) and D12 (Cancel beats a racing success) so the user can override them.
   - **D11 revised on 2026-09-25 (round 2): admission-time bound, no eviction.** The spec says failed and cancelled outcomes "stay in memory 5 minutes" (design line 71), and that binds. So the earlier acceptance of oldest-first eviction is withdrawn. When live clones plus retained outcomes reach 256, a new clone gets `capacity`, and no unexpired outcome is ever dropped.
3. **Stale citations: no action.** The plan anchors every edit by symbol or quoted text.
4. **Panic coverage stays transfer-only.** The runtime's own reservation, cleanup and publishing code is short bookkeeping. A panic there publishes a failure, and the reuse check still refuses the leftover folder, so a half-written clone is never adopted; that is the safety property from the clone-timeout fix. If this is wrong, the cost is a leftover folder the user removes by hand after a runtime bug.
5. **Round 2 (2026-09-25): cancel ownership moves into the client runtime.** A module-level registry in `state/vcsClone.ts`, keyed by environment and destination, records every pending `vcs.cancelClone`. A clone into a destination with a pending cancel waits for it to settle (acknowledged, stopped, or failed) before it dispatches. Unmount leaves the cancel registered and never abandons it.
