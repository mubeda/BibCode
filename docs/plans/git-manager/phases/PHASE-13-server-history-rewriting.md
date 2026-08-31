# Git Manager / Phase 13 — Server history-rewriting operations

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Add rebase, cherry-pick, squash, reorder, revert, reset, continue and abort to the server's Git Manager operation surface, together with the conflict model that makes them resolvable.

**Architecture:** This phase extends `apps/server/src/git/manager/` with a pure `rewrite.rs` (interactive-rebase todo construction and progress parsing) and a `conflicts.rs` (unmerged-state model, `diff --check` marker counting, ours/theirs resolution), and adds the corresponding arms to `operations.rs` and the handler in `apps/server/src/production/git_manager_rpc.rs`. Every new operation is a variant of the single streaming operation RPC established by PHASE-07, runs under the worktree catalog's existing repository lock, passes the status broadcaster's mutation fence, and re-validates PHASE-02's guards immediately before execution. It implements Slice 6's server half (`git-manager-plan.md` § Slices).

**Tech Stack:** Rust 2021 / Axum / Tokio — apps/server. Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Inline `#[cfg(test)]` unit tests; integration tests in `apps/server/tests/`.

---

## Files

- **Create:** `apps/server/src/git/manager/rewrite.rs` — pure todo-list construction, `lastRetainedCommitRef` resolution, progress parsing
- **Create:** `apps/server/src/git/manager/conflicts.rs` — conflict state model, marker counting, ours/theirs resolution plan
- **Modify:** `apps/server/src/git/manager/mod.rs` — declare the two new submodules
- **Modify:** `apps/server/src/git/manager/operations.rs` — add the rebase / cherry-pick / squash / reorder / revert / reset / continue / abort execution arms
- **Modify:** `apps/server/src/git/repository.rs` — add the rewrite/conflict command methods and a stdin-capable execution helper if PHASE-11 has not already added one
- **Modify:** `apps/server/src/git/parser.rs` — add porcelain-v2 `u` (unmerged) state parsing that does not collapse to `Modified`
- **Modify:** `apps/server/src/git/model.rs` — add the unmerged/conflicted state the parser now distinguishes
- **Modify:** `apps/server/src/git/manager/in_progress.rs` — extend PHASE-09's probes with rebase progress from `rebase-merge/{msgnum,end}` and the sequencer snapshot
- **Modify:** `apps/server/src/production/git_manager_rpc.rs` — dispatch the new operation variants
- **Modify:** `apps/server/tests/production_git_manager_rpc.rs` — integration coverage over a real temp repository with a real conflict
- **Modify:** `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`, `packages/contracts/src/rpc.ts`, `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, `apps/server/tests/rpc_wire.rs` — ONLY if a method PHASE-00 did not declare turns out to be required (see Step 13.2)

## Dependencies

- Phase 00: Wire contracts for the whole feature
- Phase 01: Server read modules and read RPCs
- Phase 02: Pure guards module
- Phase 09: Server stash, merge, in-progress detection, live signal

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

_(no domain-specific matches for this phase in the current skill inventory; always-on superpowers cover it)_

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 6.5 (destructive confirmations), § 6.6 (externally started operations), § 7 (guards)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; § Server (mutation discipline, serialisation, error classification), § Global Constraints (log hygiene, non-interactive git, force-with-lease)
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 3.7 is the command specification for this phase; also § 3.1 (`.git` state probes), § 3.9 (reset), § 4.3 (result classification)
- `docs/plans/git-manager/research/worktree-checkout-restrictions.md` — § A.1 (git refuses `rebase` on a branch held by another worktree), § "Recommended guard set"
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 3.1 server modules, § 4 the registration checklist
- `docs/architecture/rpc-and-orchestration.md` — § VCS status and mutation coordination; the mutation fence and status-owner contract
- `docs/architecture/worktree-catalog.md` — the repository lock this phase must reuse
- `docs/reference/scripts.md` — the exact commands used below

---

## Pre-execution check

- [ ] **Step 13.0: Claim the phase.** Open `../tasks.md`. Change Phase 13 row → `Status = in_progress`, `Agent = phase-13` (or your subagent name), `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 13.1: Locate the surface area being changed.**

	```bash
	rg --files apps/server/src/git/manager
	rg -n "GitManagerOperationRequest|GitManagerOperationEvent|GitManagerConflictState|GitManagerOperationError" packages/contracts/src/gitManager.ts
	rg -n "fn git_environment|fn git_read_environment|fn execute_with_environment|stdin:" apps/server/src/git/repository.rs
	rg -n "with_project_mutation_lock_cancellation" apps/server/src/worktree_catalog/service.rs
	rg -n "begin_mutation" apps/server/src/git/broadcaster.rs apps/server/src/production/git_vcs.rs
	```

	Read `apps/server/src/git/manager/operations.rs` as PHASE-07/09/11 left it and follow its existing operation-arm shape exactly. PHASE-07 published three contracts this phase must reuse rather than duplicate:

	- **`GitManagerOperationRegistry::try_begin(&Path) -> Option<GitManagerOperationLease>`**, keyed by canonical common dir, is the single in-flight source of truth and the in-progress input to PHASE-02's guards. Do not add a second registry.
	- **`classify_operation_failure(exit_code, stderr) -> GitManagerFailureCode`** is the **only** stderr matcher in the feature. Extend its code list; do not add a second matcher, and never use it for occupancy.
	- **`run_branch_or_sync_operation`** establishes the mandatory order: in-flight registry → catalog lock → guard re-validation → `begin_mutation` → execute → `mutation.finish()`. Every arm added here follows it.

	Also reuse PHASE-09's `detect_in_progress_operation` in `apps/server/src/git/manager/in_progress.rs` and PHASE-11's `parse_working_tree_diff` in `apps/server/src/git/manager/patch.rs` rather than writing a second probe or a second diff parser. Read `apps/server/src/production/git_vcs.rs` `run_owned_git_mutation` (indicative :626 — re-verify) as the underlying mutation template.

- [ ] **Step 13.2: Confirm the wire surface, and only cross the registration gate if you must.**

	PHASE-00 declared the whole `gitManager.*` surface. Confirm every request variant this phase needs — `rebase`, `cherry-pick`, `squash`, `reorder`, `revert`, `reset`, `continue`, `abort`, `resolve-conflict` — already exists as a `GitManagerOperationRequest` variant. If one is missing, add it to `packages/contracts/src/gitManager.ts` and re-run the whole gate: `WS_METHODS` + `Rpc.make` + the exported `RpcGroup.make` in `packages/contracts/src/rpc.ts`; `pnpm --filter @bibcode/contracts generate:rust-rpc-fixtures`; `ACTIVE_RPC_METHODS` in `apps/server/src/rpc/methods.rs` (mutation variants use `mutation_stream`); exactly one `required_scope` arm in `apps/server/src/auth/scope.rs` using the operate scope; and the two hard-coded count sites — `packages/contracts/scripts/export-rust-rpc-fixtures.ts` and `apps/server/tests/rpc_wire.rs` (counts currently at indicative :85 `101`, :90 `18`, :92-95 `65`/`23`/`65`/`242` — **re-read them from the working tree; earlier phases have already moved them**). Read-only methods must not require a write scope; a method omitted from `ACTIVE_RPC_METHODS` still dispatches but is classified as a mutation during update maintenance.

- [ ] **Step 13.3: Author the first failing test — the interactive-rebase todo builder.**

	Path: `apps/server/src/git/manager/rewrite.rs`, inline `#[cfg(test)] mod tests`.

	Pin one behaviour: `build_squash_todo(log_order, squashed_shas, onto_sha)` replays the commit list in log order emitting `pick <sha>` for retained commits and `squash <sha>` for every commit folded into its predecessor, in the exact order git's sequencer expects (oldest first). Assert the todo ends with a trailing newline and contains no branch names.

- [ ] **Step 13.4: Run the new test; expect FAIL.**

	```bash
	cargo test -p bibcode-server git::manager::rewrite
	```

- [ ] **Step 13.5: Implement the minimum to make Step 13.3 pass.** Write `rewrite.rs` with `build_squash_todo` only — pure functions over owned `String`s, no filesystem, no process access.

- [ ] **Step 13.6: Run the test; expect PASS.**

- [ ] **Step 13.7: Add the remaining pure `rewrite.rs` tests and implementation, one at a time.**

	- `build_reorder_todo(log_order, moved_shas, insert_before_sha)` — reorder todo, same `pick` grammar.
	- `resolve_last_retained_commit_ref(oldest_touched_sha, parent_of_oldest)` → `Some("<sha>^")`, or `None` meaning the caller must pass `--root` (research § 3.7; reference at `commit-list.tsx:322-330`).
	- `parse_rebase_progress(stderr) -> Option<(u32, u32)>` — reads git's `Rebasing (n/m)` lines out of a **completed** command's captured stderr and nothing else. PHASE-07 recorded that the supervised process path has no incremental output observer, so there is no per-line progress stream; live progress instead comes from PHASE-09's `.git` probes, which this phase extends in Step 13.8b.
	- `parse_cherry_pick_progress(stdout) -> Option<String>` — reads git's `[<branch> <sha>] <summary>` stdout lines from a completed command and returns the sha only.
	- The rebase outcome codes — completed, already-up-to-date (git's "is up to date"), conflicts-encountered, outstanding-files-not-staged — are added to PHASE-07's `classify_operation_failure` code list, **not** to a second matcher. That function is the only place stderr text is inspected in this feature, and it is for error reporting alone: occupancy and every other guard condition is pre-computed by PHASE-02, never matched from stderr (git's wording is version-specific).

- [ ] **Step 13.8: Add the conflict-model tests and implement `conflicts.rs`.**

	- `count_conflict_markers(diff_check_output) -> BTreeMap<String, u32>` parses `git diff --check` output for `leftover conflict marker` lines and returns markers per path. Export `conflicts_from_markers(markers) = markers.div_ceil(3)` so the client's "N conflicts" matches the reference contract exactly.
	- `plan_manual_resolution(path, side)` for `side: Ours | Theirs` returns the ordered command plan: `checkout --ours <path>` or `checkout --theirs <path>`, then `add <path>` — or `rm <path>` when the chosen side deleted the file.
	- `GitManagerConflictState` construction from porcelain-v2 `u` records plus binary detection (`diff --numstat -z` rows reading `-\t-\t`, and `check-attr --stdin -z merge` reporting `merge=binary`).
	- Cover the negative case: a repository with no unmerged entries yields an empty conflict state, not `None`-vs-empty ambiguity.
	- Reuse PHASE-11's `parse_working_tree_diff` from `apps/server/src/git/manager/patch.rs` for any diff inspection; do not write a second diff parser.

- [ ] **Step 13.8b: Extend PHASE-09's in-progress probes with live progress.**

	In `apps/server/src/git/manager/in_progress.rs`, add the rebase progress snapshot from `.git/rebase-merge/{msgnum,end}` and the cherry-pick sequencer snapshot from `.git/sequencer/{abort-safety,head,todo}` (research § 3.1) to the existing `GitManagerInProgressOperation`. Resolve the `.git` path with `rev-parse --git-path`, as PHASE-09 does — never by joining `cwd` with `.git`, which is wrong in a linked worktree. This is where the client's "Commit i of N" comes from, because there is no per-line progress stream. Test that a mid-rebase repository reports `{ current, total }` and a clean repository reports none.

- [ ] **Step 13.9: Add the `parser.rs` / `model.rs` unmerged-state tests and implementation.**

	`apps/server/src/git/parser.rs` already accepts `u` records (kind guard and the `'u' => 10` field offset, indicative :59/:70) but `status_char` has no `'U'` arm, so both sides collapse to `VcsWorkingTreeFileStatus::Modified` and the enum in `apps/server/src/git/model.rs` (indicative :9) has no unmerged variant. Add the variant and the parse arm, and assert every existing `VcsWorkingTreeFileStatus` consumer still compiles. This is a public wire shape — confirm the contracts schema PHASE-00 landed already carries it; if not, that is a Step 13.2 gate crossing.

- [ ] **Step 13.10: Add the command-construction tests using a recording runner, then implement the `repository.rs` methods.**

	Use `GitRepository::with_runner_for_test(Arc<dyn GitProcessRunner>)` (indicative `repository.rs:260`) with a recording runner in the style of `RecordingGitRunner` (indicative `repository.rs:5035`). Assert the exact argv and environment of each command. These are the command lines this phase must produce, taken from `research/github-desktop-analysis.md` § 3.7 and § 3.9:

	```text
	rebase          git -c rebase.backend=merge rebase <base> <target>
	rebase (progress)  stderr lines "Rebasing (n/m)"
	interactive     git -c rebase.backend=merge -c sequence.editor='cat "<todo-file>" >' rebase [--no-verify] -i <lastRetainedCommitRef | --root>
	                    with GIT_EDITOR=:  — git invokes the sequence editor as `<editor> <git-generated-todo>`,
	                    so the value `cat "<todo-file>" >` expands to `cat "<todo-file>" > <git-generated-todo>`,
	                    overwriting git's todo with the prepared one. Used for squash and reorder.
	squash message  GIT_EDITOR='cat "<message-file>" >'   (same overwrite trick for the squashed message)
	cherry-pick     git cherry-pick --empty=keep -m 1 <sha> [<sha> …]
	                    progress from stdout "[<branch> <sha>] <summary>"
	revert          git revert <sha>          (non-merge commit)
	revert (merge)  git revert -m 1 <sha>
	reset           git reset --hard <sha>  |  git reset --soft <sha>  |  git reset --mixed <sha>
	continue        GIT_EDITOR=: git rebase --continue      (or --skip when the current commit became empty)
	                GIT_EDITOR=: git cherry-pick --continue
	                GIT_EDITOR=: git revert --continue
	abort           git rebase --abort | git cherry-pick --abort | git revert --abort | git merge --abort
	markers         git diff --check
	resolve ours    git checkout --ours <path>   then  git add <path>  (or git rm <path> if that side deleted it)
	resolve theirs  git checkout --theirs <path> then  git add <path>  (or git rm <path>)
	```

	Every one of these is a mutation and must run with `git_environment()` extended by the operation-specific `GIT_EDITOR` / `-c` settings — never `git_read_environment()`, and never a bare inherited environment. `git_environment()` (indicative `repository.rs:4759`) already sets `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`, `SSH_ASKPASS_REQUIRE=never`, `GIT_CONFIG_NOSYSTEM=1`, `GCM_INTERACTIVE=never`, `LC_ALL=C`, `LANG=C`.

	**Note on stdin:** `execute_with_environment` (indicative `repository.rs:349`) hard-codes `stdin: None`, while `ProcessRequest` (`apps/server/src/git/process.rs:20`) supports `stdin: Option<Vec<u8>>`. PHASE-04 or PHASE-11 — whichever landed first — already added the stdin-capable variant and recorded it; find it and reuse it. Do not add a second one. The todo and message files above are real temporary files (written under a per-operation temp directory that is removed on every exit path), not stdin — only pipe through stdin where the reference does.

- [ ] **Step 13.11: Add the operation-arm tests and implement them in `operations.rs`.**

	Each arm follows PHASE-07's `run_branch_or_sync_operation` order exactly: `GitManagerOperationRegistry::try_begin` → the worktree catalog lock via `WorktreeCatalogService::with_project_mutation_lock_cancellation` (indicative `service.rs:1579`), which takes the project lock first and then the repository lock keyed by the canonical common dir → **re-validate PHASE-02's guards under that lock** → `StatusBroadcaster::begin_mutation(&cwd)` → run the command through the supervised path with the request's cancellation token → always `mutation.finish()`. Introduce no second lock and no second registry. A second concurrent Git Manager operation on the same repository is rejected with the `operation-in-flight` blocked reason, never queued silently. Emit `started`, zero or more `output` (one per completed underlying git command, carrying capped `stdout`/`stderr`), then exactly one of `finished` / `failed`, matching PHASE-07's published stream contract. Test at minimum: a concurrent second operation is rejected rather than serialised; a client cancellation kills the child process and yields a `cancelled` failure code; a stale guard produces a structured `GitManagerOperationError` and not raw stderr.

	**Guard interaction to test explicitly:** rebasing a branch held by another worktree is refused by git itself (exit 128, `worktree-checkout-restrictions.md` § A.1). The panel must pre-compute this from the worktree inventory or `git for-each-ref --format='%(worktreepath)'` — never by matching stderr — and must never use `--ignore-other-worktrees`, `git worktree add -f`, or plumbing `update-ref` to get around it.

- [ ] **Step 13.12: Add log-hygiene tests.**

	Assert no new `tracing` call site interpolates a branch name, ref name, absolute path, remote URL or git stderr. Mirror the existing source-text tripwire style in `apps/server/tests/git_rpc.rs` (indicative :36, `production_vcs_observation_has_no_periodic_ref_worker`, which `include_str!`s the production half of a module and asserts forbidden substrings are absent). Log stable codes plus lengths and counts, exactly as `GitCommandError`/`GitCommandDiagnostics` do (`apps/server/src/git/model.rs`, indicative :286-310).

- [ ] **Step 13.13: Add the integration test over a real repository.**

	Extend `apps/server/tests/production_git_manager_rpc.rs` (created by PHASE-01/09), following the repository's integration-test harness style: `tempfile::TempDir` plus local `fn git(cwd, args)` / `fn init_repo()` helpers shelling to the real `git` binary, as `apps/server/tests/git_rpc.rs` does (indicative :62 / :94). Build a real conflicting cherry-pick, then assert end to end: the conflict state lists the unmerged path with a marker count; `checkout --theirs` + `add` resolves it; `--continue` completes; and `abort` from a mid-operation state restores the original tip.

- [ ] **Step 13.14: Full build + test gate.**

	```bash
	cargo fmt --all --check
	cargo test -p bibcode-server git::manager
	cargo test -p bibcode-server --test production_git_manager_rpc
	cargo test -p bibcode-server --test git_rpc
	cargo test -p bibcode-server --test rpc_wire
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	vp check
	vp run typecheck
	```

	If Step 13.2 required a contract change, also run `vp run check:contracts`.

	Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 13.15: TDD proof.** Make `count_conflict_markers` return an empty map and `resolve_last_retained_commit_ref` always return `None`. Re-run `cargo test -p bibcode-server git::manager` and confirm the affected tests DO fail. Restore the real implementations.

- [ ] **Step 13.16: Mark phase complete.** Change Phase 13 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry under your Detailed Progress section: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] Every command line in Step 13.10 is asserted by a recording-runner unit test, argv for argv, including `--empty=keep -m 1`, `-m 1` on merge reverts, `-c sequence.editor=…`, and `GIT_EDITOR=:` on every continue.
- [ ] `rg -n "ignore-other-worktrees|worktree add -f|update-ref" apps/server/src/git/manager` returns nothing; `rg -n '\-\-force\b' apps/server/src/git/manager` finds only `--force-with-lease`.
- [ ] Occupancy is never derived from stderr: `rg -n "already used by worktree|is already checked out" apps/server/src/git` finds no matcher in production code.
- [ ] A second concurrent operation on the same repository is rejected with `operation-in-flight`; a test proves it is not queued.
- [ ] Every new mutation passes through `begin_mutation` and calls `finish()` on all exit paths, including cancellation and error.
- [ ] No log line interpolates a branch name, ref name, absolute path, remote URL or git stderr.
- [ ] `cargo fmt --all --check` clean; `cargo test -p bibcode-server` green; `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean.
- [ ] `vp check` clean and `vp run typecheck` clean; `vp run check:contracts` clean if any contract changed, with both hard-coded count sites bumped.
- [ ] Validated end to end against **both** a local project and a remote-hosted project.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counter, remote feature flag, avatar or identity fetch, third-party host contact, or new dependency. Confirm `git diff apps/server/Cargo.toml Cargo.lock` is empty and that every process this phase spawns has `command: PathBuf::from("git")`.
- [ ] Final `git diff` and `git status --short` review for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **PHASE-15 (web history-rewriting and conflict UI) consumes exactly this surface.** The operation variants are `GitManagerOperationRequest` members named `rebase`, `cherry-pick`, `squash`, `reorder`, `revert`, `reset`, `continue`, `abort`, `resolve-conflict`; take the authoritative spelling from `packages/contracts/src/gitManager.ts` in the working tree.
- The stream emits `GitManagerOperationEvent` with the four kinds `started`, `output`, `finished`, `failed` established by PHASE-07, one `output` per **completed** underlying git command. **There is no per-line progress stream** — the supervised process path has no incremental output observer (PHASE-07 recorded this). PHASE-15's "Commit i of N" must therefore read `{ current, total }` from the refs snapshot's `GitManagerInProgressOperation`, which this phase extends from `.git/rebase-merge/{msgnum,end}` and the sequencer snapshot. The client parses no git text in either case.
- `GitManagerConflictState` carries, per conflicted path: `path`, `kind` (`text` | `binary` | `submodule`), `markerCount: number`, and `resolution: "ours" | "theirs" | null`. The client renders "N conflicts" as `ceil(markerCount / 3)` — the server also exports `conflicts_from_markers` so both sides agree; if the contract exposes a pre-divided field, prefer it and do not divide twice.
- Ours/theirs resolution is requested through the `resolve-conflict` variant with `{ path, side: "ours" | "theirs" }`. The server owns the `checkout --ours|--theirs` + `add`/`rm` sequence; the client never sends git arguments.
- The reset variant carries `{ sha, mode: "hard" | "soft" | "mixed" }`. PHASE-15 must put `hard` behind an explicit confirmation that names what is discarded (spec § 6.5).
- `apps/server/src/git/manager/rewrite.rs` and `conflicts.rs` are pure and have no repository dependency; any later phase needing marker counting or todo construction imports them rather than re-implementing.
- **Divergence, already recorded by PHASE-07 and reconfirmed here:** the plan describes a "maintenance allowlist for read-only methods" in `apps/server/src/maintenance.rs`. There is no allowlist constant there — `maintenance.rs` derives mutability from `method_mutability` over `ACTIVE_RPC_METHODS` in `apps/server/src/rpc/methods.rs` (indicative :161), and an unlisted method fails safe as a mutation. Declaring the method with the right `read_*` / `mutation_*` constructor is the whole of that gate.
- **Divergence:** the reference implementation classifies rebase results with a dedicated function. Here those outcome codes join PHASE-07's `classify_operation_failure`, so the feature keeps exactly one stderr matcher.
