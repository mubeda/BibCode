# Git Manager / Phase 09 — Server stash, merge, in-progress detection and the live signal

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Give the server the native stash list, merge with a mergeability preview, detection of externally started operations, and a refs/HEAD/worktree generation signal on the existing broadcaster tick.

**Architecture:** This is Slice 4's server half in `git-manager-plan.md`. Stash and merge join the operation executor PHASE-07 built, reusing its in-flight registry, catalog lock, guard re-validation and mutation fence in the same order. In-progress detection probes repository state so a merge, rebase or cherry-pick started by an agent or on the command line is visible (spec § 6.6). The live signal extends the existing `StatusBroadcaster` (`apps/server/src/git/broadcaster.rs`) with a per-repository refs/HEAD/worktree signature computed on the **existing** remote/ref reconciliation tick — no new poller task and no new watcher subsystem.

**Tech Stack:** Rust 2021 / Axum / Tokio — apps/server. Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Inline `#[cfg(test)]` unit tests; integration tests in `apps/server/tests/`.

---

## Files

- **Create:** `apps/server/src/git/manager/stash.rs` — stash list/diff parsing and the stash operation primitives.
- **Create:** `apps/server/src/git/manager/merge.rs` — merge, squash-merge and the `merge-tree` mergeability preview.
- **Create:** `apps/server/src/git/manager/in_progress.rs` — repository-state probes for merge / rebase / cherry-pick / revert.
- **Modify:** `apps/server/src/git/manager/mod.rs` — declare the three new submodules.
- **Modify:** `apps/server/src/git/manager/operations.rs` — add the stash and merge operation kinds to the executor and their failure codes.
- **Modify:** `apps/server/src/git/broadcaster.rs` — add the signature/generation fields to `RepositoryState`, compute them on the existing ref tick, and expose the git-manager signal subscription.
- **Modify:** `apps/server/src/git/repository.rs` — the stash, merge, merge-tree and `rev-parse --git-path` primitives.
- **Modify:** `apps/server/src/production/git_manager_rpc.rs` — replace the `gitManager.getStashes` / `gitManager.previewMerge` / `subscribeGitManagerSignal` stub handlers with real ones, and fill in the `stash` source arm of the `gitManager.getDiff` handler PHASE-01 landed.
- **Modify:** `apps/server/tests/production_git_manager_rpc.rs` — integration coverage for stash listing, the merge preview and the generation bump.

## Dependencies

- Phase 00: Wire contracts for the whole feature
- Phase 01: Server read modules and read RPCs
- Phase 02: Pure guards module

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

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules.
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 6.3 (full native stash list) and § 6.6 (externally started operations).
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; the Server section's "Live signal" paragraph governs the broadcaster change.
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 3.1, § 3.7 and § 3.8 carry the exact command lines and parse formats this phase must use.
- `docs/plans/git-manager/research/worktree-checkout-restrictions.md` — § A.4: stashes live in the common dir and are repository-wide, never per-worktree.
- `docs/architecture/overview.md` and `docs/architecture/rpc-and-orchestration.md` — the existing status-stream freshness model this phase extends.
- `docs/reference/scripts.md` — the exact command names used below.

---

## Pre-execution check

- [ ] **Step 09.0: Claim the phase.** Open `../tasks.md`. Change Phase 09 row → `Status = in_progress`, `Agent = phase-09`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 09.1: Locate the surface area being changed.**

	```bash
	rg -n "struct RepositoryState" -A 20 apps/server/src/git/broadcaster.rs
	rg -n "fn refresh_remote_for_lifecycle" -A 60 apps/server/src/git/broadcaster.rs
	rg -n "fn spawn_local_status_poller|fn spawn_remote_reconciliation|fn subscribe_inner" apps/server/src/git/broadcaster.rs
	rg -n "GitManagerOperationRegistry|classify_operation_failure|run_branch_or_sync_operation" apps/server/src/git/manager/operations.rs
	rg -n "gitManager" apps/server/src/rpc/methods.rs
	```

	Preconditions, each a stop-and-record item in `tasks.md` if it fails: the stash, merge-preview and live-signal methods are present in `ACTIVE_RPC_METHODS` **with stub handlers already registered** (`RpcRegistry::validate_complete()` fails server startup otherwise); `gitManager.getDiff` is already a **real** handler from PHASE-01, not a stub, so this phase extends it rather than replacing it; and PHASE-07's `GitManagerOperationRegistry` and `classify_operation_failure` exist. The landed `packages/contracts/src/gitManager.ts` is authoritative for the method and field names used below (expected: `gitManager.getStashes`, `gitManager.previewMerge`, `subscribeGitManagerSignal` — a bare stream identifier with no dot — and `gitManager.getDiff` with a `GitManagerDiffSource` of `{ _tag: "stash", sha, path }` for the stash diff; there is no separate stash-diff method).

- [ ] **Step 09.2: Author the first failing test.**

	Path: `apps/server/src/git/manager/stash.rs` (inline `#[cfg(test)] mod tests`)

	```rust
	#[test]
	fn parses_a_nul_delimited_stash_log_into_ordered_entries() {
	    let stdout = "stash@{0}\u{1f}abc123\u{1f}WIP on feature: 1234567 tidy\u{1f}1735689600\u{1f}p1 p2 p3\0\
	                  stash@{1}\u{1f}def456\u{1f}On master: wip\u{1f}1735689000\u{1f}q1 q2\0";
	    let entries = parse_stash_list(stdout);
	    assert_eq!(entries.len(), 2);
	    assert_eq!(entries[0].selector, "stash@{0}");
	    assert_eq!(entries[0].sha, "abc123");
	    assert_eq!(entries[0].parents, vec!["p1", "p2", "p3"]);
	    assert_eq!(entries[1].message, "On master: wip");
	}
	```

- [ ] **Step 09.3: Run the new test; expect FAIL** (the module does not exist yet).

	```bash
	cargo test -p bibcode-server parses_a_nul_delimited_stash_log_into_ordered_entries
	```

- [ ] **Step 09.4: Implement the minimum to make Step 09.2 pass.**

	In `apps/server/src/git/manager/stash.rs` add `parse_stash_list(stdout: &str) -> Vec<GitManagerStashRecord>` splitting on NUL, then on `\u{1f}`. The producing command is (research § 3.8):

	```text
	git log -g -z --no-show-signature --format=%gD%x1f%H%x1f%gs%x1f%ct%x1f%P refs/stash --
	```

	run through `execute_read` with `allow_non_zero_exit = true`: exit 128 means "no stash" and yields an empty list. **Every entry surfaces** — the reference implementation's `!!GitHub_Desktop<branch>` marker filter is deliberately not ported (spec § 6.3), and the list is repository-wide, never scoped per worktree.

- [ ] **Step 09.5: Run the test; expect PASS.**

- [ ] **Step 09.6: Add the stash diff and stash operations.** In `stash.rs` and `repository.rs`, using the research § 3.8 command lines verbatim. The stash-diff wire payload identifies a stash by its stable `sha`. Before running a diff command, resolve that sha against the current `parse_stash_list` output to obtain the matching `stash@{n}` selector. If the sha is no longer present because the stash was dropped or popped, fail with a structured error; never reinterpret a shifted list index as the requested stash. Mutation arms continue to use the current selector required by their `GitManagerOperationRequest` variant:
	- file list: `git stash show <selector> --raw --numstat -z --format=format: --no-show-signature --` (whole-stash; it feeds `GitManagerStashEntry`, not a per-path diff)
	- patch: `git stash show -p <selector> --no-color`, filtered to the requested `path` — this is what the `{ _tag: "stash", sha, path }` source of `gitManager.getDiff` returns
	- create: stage untracked paths first, then `git stash push -m "<message>"` — an ordinary, visible entry with no magic marker (spec § 6.3)
	- apply: `git stash apply --quiet <selector>`; pop: `git stash pop --quiet <selector>`; drop: `git stash drop <selector>`

	A pop that conflicts exits non-zero and **leaves the entry in place**; the executor must report that outcome rather than dropping the entry. Tests: parse of a `--raw --numstat -z` payload including a rename row; sha-to-current-selector resolution for a present stash; structured failure for a sha no longer in the current list; the conflicting-pop outcome.

- [ ] **Step 09.7: Add the merge preview, test first.**

	In `apps/server/src/git/manager/merge.rs` add `parse_merge_tree_preview(exit_code: i32, stdout: &str) -> GitManagerMergePreview`. The producing command is (research § 3.7):

	```text
	git merge-tree --write-tree --name-only --no-messages -z <oursTip> <theirsTip>
	```

	Exit 0 → clean. Exit 1 → conflicted; the conflicted-file count is the NUL count minus one. Any other exit → `unrelated-histories`. Unit-test all three, including the off-by-one on the NUL count.

- [ ] **Step 09.8: Add merge and squash-merge to the executor.** In `operations.rs` add the operation kinds `merge`, `squash-merge`, `stash-push`, `stash-apply`, `stash-pop`, `stash-drop`, each running `git merge [--no-verify] <branch>` / `git merge --squash <branch>` followed by `git commit --no-edit`, through PHASE-07's exact order: in-flight registry → catalog lock → guard re-validation → `begin_mutation` → execute → `mutation.finish()`. `Already up to date.` on stdout classifies as `already-up-to-date`, not a failure. Extend `classify_operation_failure` with `conflicts` coverage rather than adding a second stderr matcher.

- [ ] **Step 09.9: Add the in-progress probes, test first.**

	In `apps/server/src/git/manager/in_progress.rs` add `detect_in_progress_operation(...)`. Resolve the paths with git, never by joining `cwd/.git/<name>` — `.git` is a **file** in a linked worktree, which is BibCode's primary scenario:

	```text
	git rev-parse --git-path MERGE_HEAD --git-path CHERRY_PICK_HEAD --git-path REVERT_HEAD \
	  --git-path SQUASH_MSG --git-path rebase-merge --git-path rebase-apply --git-path sequencer/todo
	```

	one resolved path per output line, in argument order; then probe each for existence. Precedence: `rebase-merge`/`rebase-apply` → rebase; `CHERRY_PICK_HEAD` or `sequencer/todo` → cherry-pick; `REVERT_HEAD` → revert; `MERGE_HEAD` → merge; `SQUASH_MSG` alone → squash. Unit-test the mapping from a probe-result set to the reported operation, including "nothing in progress" and the rebase-beats-merge precedence.

- [ ] **Step 09.10: Add the live signal to the broadcaster, test first.** Extend `RepositoryState` (indicative `apps/server/src/git/broadcaster.rs:70` — re-verify) with `git_manager_signature: Option<u64>` and a `watch::Sender<u64>` generation channel. On the **existing** ref tick inside `refresh_remote_for_lifecycle` (indicative :837), compute the signature from one additional lock-avoiding read:

	```text
	git for-each-ref --format=%(objectname)%09%(refname)%09%(worktreepath) refs/heads refs/remotes refs/tags
	```

	combined with the current HEAD, hashed to a `u64`. When it differs from the stored value, store it and bump the generation. Add `StatusBroadcaster::subscribe_git_manager_signal(&self, cwd) -> …` — the source for the `subscribeGitManagerSignal` stream — that goes through the **same** `subscribe_inner` entry point the status stream uses, so the existing subscribe-driven poller startup happens even when no status subscriber exists. Add no new task, no new timer and no new watcher. Tests: two ticks with identical refs bump the generation once; a changed ref bumps it again; subscribing with no status subscriber starts the pollers exactly as `subscribe` does.

- [ ] **Step 09.11: Implement the handlers.** In `apps/server/src/production/git_manager_rpc.rs` replace the stubs for `gitManager.getStashes`, `gitManager.previewMerge` and the `subscribeGitManagerSignal` stream, and fill in the `{ _tag: "stash", sha, path }` arm of the existing `gitManager.getDiff` handler (resolving the sha against the current stash list to obtain its `stash@{n}` selector as in Step 09.6). Return a structured error when the sha is absent. Reads use `execute_read` (`GIT_OPTIONAL_LOCKS=0`) and the read scope; the signal stream is registered with `registry.register_stream(...)` against `subscribe_git_manager_signal`. Log stable codes plus lengths and counts only — never a branch name, ref name, absolute path, remote URL, stash message or git stderr.

- [ ] **Step 09.12: Full build + test gate.**

	```bash
	cargo fmt --all --check
	cargo test -p bibcode-server
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	vp check
	vp run typecheck
	```

	Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 09.13: Stack-specific verification.** In a scratch repository with a linked worktree: create a stash from the command line and confirm it appears in the list; start `git merge` to a conflict outside BiBCode and confirm the in-progress probe reports it; commit in the worktree and confirm the generation bumps within one ref tick. Repeat against a remote-hosted project (spec § 10 requires both).

- [ ] **Step 09.14: TDD proof.** Temporarily make `parse_merge_tree_preview` always return clean and make the signature computation return a constant. Re-run `cargo test -p bibcode-server` and confirm the merge-preview and generation tests fail. Restore both and re-run.

- [ ] **Step 09.15: Mark phase complete.** Change Phase 09 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This decomposition is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] The stash list is the full native list, repository-wide, with no message-marker filtering and no per-worktree scoping.
- [ ] A stash diff resolves its sha against the current stash list, uses the matching `stash@{n}` selector, and returns a structured error when that sha was dropped or popped.
- [ ] `merge-tree --write-tree --name-only --no-messages -z` drives the mergeability preview; the conflicted count is NUL count minus one.
- [ ] In-progress detection resolves paths through `git rev-parse --git-path` and works in a linked worktree where `.git` is a file.
- [ ] The refs/HEAD/worktree generation is computed on the existing ref tick; `rg -n "tokio::spawn|interval\(" apps/server/src/git/broadcaster.rs` shows no new poller task added by this phase.
- [ ] Stash and merge mutations follow PHASE-07's order: in-flight registry → catalog lock → guard re-validation → `begin_mutation` → execute → `mutation.finish()`.
- [ ] Reads use the lock-avoiding environment; log strings contain no branch name, ref name, path, remote URL, stash message or git stderr.
- [ ] All new tests green; `cargo test -p bibcode-server` passes.
- [ ] `cargo fmt --all --check` clean; `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean; `vp check` and `vp run typecheck` clean.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counters, remote feature flags, avatar or identity fetches, third-party host contact, and no new crate in `apps/server/Cargo.toml`. No git network operation is added here.
- [ ] Final `git diff` and `git status --short` reviewed for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **`parse_stash_list(stdout) -> Vec<GitManagerStashRecord>`** and `GitManagerStashRecord { selector, sha, message, committedAtMs, parents }` in `apps/server/src/git/manager/stash.rs`. **PHASE-12** renders these verbatim; stash entries are repository-wide, so the UI must not present them as belonging to one worktree. There is **no** stash-diff method: **PHASE-12** reads a stash's per-file patch through `gitManager.getDiff` with `source: { _tag: "stash", sha, path }`. The server resolves that stable sha to the current `stash@{n}` selector and fails structurally if the stash is no longer present.
- **`parse_merge_tree_preview(exit_code, stdout) -> GitManagerMergePreview`** with variants `clean`, `conflicted { fileCount }`, `unrelated-histories` in `apps/server/src/git/manager/merge.rs`. **PHASE-12** and **PHASE-15** consume it; neither may re-derive mergeability.
- **`detect_in_progress_operation(...) -> Option<GitManagerInProgressOperation>`** in `apps/server/src/git/manager/in_progress.rs`, reported on the refs snapshot. **PHASE-12** shows the continue/abort affordance from it regardless of who started the operation; **PHASE-13** reuses it and extends it with rebase progress from `rebase-merge/{msgnum,end}`.
- **`StatusBroadcaster::subscribe_git_manager_signal(cwd)`** backs the `subscribeGitManagerSignal` stream and yields a monotonically increasing generation. **PHASE-06's** history splicing and **PHASE-10's** toolbar both key their revalidation on that stream. It goes through `subscribe_inner`, so subscribing starts the existing pollers.
- **Operation kinds added to PHASE-07's executor:** `merge`, `squash-merge`, `stash-push`, `stash-apply`, `stash-pop`, `stash-drop`. **PHASE-13** adds `rebase`, `cherry-pick`, `squash`, `reorder`, `revert`, `reset`, `continue`, `abort` to the same executor and the same registry — it must not add a parallel one.
- **Divergence recorded:** the broadcaster's "ref tick" is `refresh_remote_for_lifecycle`, driven by `spawn_remote_reconciliation` plus the `RepositoryFetchOwner` interval — not a standalone timer. The signature belongs there, and the local status poller is left untouched.
