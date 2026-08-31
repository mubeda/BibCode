# Git Manager / Phase 11 — Server hunk and line staging

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Stage, unstage and discard an arbitrary line selection within a file by constructing a patch server-side and applying it with `git apply`.

**Architecture:** This is Slice 5's server half in `git-manager-plan.md`. A new pure module `apps/server/src/git/manager/patch.rs` turns a parsed working-tree-source diff plus a set of selected unified-diff line indices into a minimal zero-context patch; `apps/server/src/git/manager/operations.rs` applies it to the index with `git apply --cached --unidiff-zero --whitespace=nowarn -`, removes selected staged lines from the index without touching the working tree with `git apply --cached --reverse --unidiff-zero --whitespace=nowarn -`, and applies its reverse to the working tree without `--cached` for partial discard. The patch construction is the only new algorithm here, so it is unit-tested without a repository. BiBCode keeps its visible-index staging model (plan § Server, "The staging model") — this phase adds sub-file granularity to it, it does not adopt the reference implementation's hidden-index rebuild.

**Tech Stack:** Rust 2021 / Axum / Tokio — apps/server. Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Inline `#[cfg(test)]` unit tests; integration tests in `apps/server/tests/`.

---

## Files

- **Create:** `apps/server/src/git/manager/patch.rs` — the pure diff parser and selection-to-patch formatter with its inline tests.
- **Modify:** `apps/server/src/git/manager/mod.rs` — declare the new submodule.
- **Modify:** `apps/server/src/git/manager/operations.rs` — the stage-partial, unstage-partial and discard-partial executors.
- **Modify:** `apps/server/src/git/repository.rs` — a stdin-capable git execute variant and the `apply`/`diff` primitives this phase needs.
- **Modify:** `apps/server/src/production/git_manager_rpc.rs` — replace the `gitManager.stagePartial` / `gitManager.unstagePartial` / `gitManager.discardPartial` stub handlers with real ones.
- **Modify:** `apps/server/tests/production_git_manager_rpc.rs` — integration coverage for staging, unstaging and discarding a partial selection.

## Dependencies

- Phase 00: Wire contracts for the whole feature
- Phase 04: Server staging and commit operations

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
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 3.1 (hunk- and line-level staging) and § 6.5 (partial discard confirmation).
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; the Server section's "The staging model" paragraph decides what is and is not ported.
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 3.2 (the exact `apply --cached` contract and the rename handling) and § 3.3 (the working-tree diff command line).
- `docs/architecture/rpc-and-orchestration.md` — handler and mutation-fence conventions.
- `docs/reference/scripts.md` — the exact command names used below.

---

## Pre-execution check

- [ ] **Step 11.0: Claim the phase.** Open `../tasks.md`. Change Phase 11 row → `Status = in_progress`, `Agent = phase-11`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 11.1: Locate the surface area being changed.**

	```bash
	rg -n "fn execute_with_environment" -A 30 apps/server/src/git/repository.rs
	rg -n "stdin" apps/server/src/git/repository.rs apps/server/src/git/process.rs
	rg -n "fn stage_files|fn unstage_files|fn discard_files|fn validate_pathspecs" apps/server/src/git/repository.rs
	rg -n "GitManagerOperationRegistry|run_branch_or_sync_operation" apps/server/src/git/manager/operations.rs
	rg -n "gitManager" apps/server/src/rpc/methods.rs
	```

	Preconditions, each a stop-and-record item in `tasks.md` if it fails: the partial-staging methods are present in `ACTIVE_RPC_METHODS` **with stub handlers already registered** (`RpcRegistry::validate_complete()` fails server startup otherwise). The landed `packages/contracts/src/gitManager.ts` is authoritative for the method and field names (expected: `gitManager.stagePartial`, `gitManager.unstagePartial`, `gitManager.discardPartial`, all gated on `gitManagerPartialStaging` and carrying `{ cwd, projectId, path, selectedLines, baseGeneration }`).

	**Stdin note:** `ProcessRequest` in `apps/server/src/git/process.rs` already carries `stdin: Option<Vec<u8>>`, but `GitRepository::execute_with_environment` hard-codes `stdin: None` (indicative `apps/server/src/git/repository.rs:366` — re-verify). PHASE-04 needs the same capability for `git commit -F -`. **If PHASE-04 already added a stdin-capable execute variant, reuse it; otherwise add `execute_with_stdin(operation, cwd, args, stdin, options, cancellation)` alongside `execute_with_options` and route both through it.** Do not duplicate the runner call site.

- [ ] **Step 11.2: Author the first failing test.**

	Path: `apps/server/src/git/manager/patch.rs` (inline `#[cfg(test)] mod tests`)

	```rust
	#[test]
	fn a_selection_of_one_added_line_produces_a_zero_context_patch_for_that_line_only() {
	    let diff = "diff --git a/f.txt b/f.txt\n\
	                --- a/f.txt\n\
	                +++ b/f.txt\n\
	                @@ -1,1 +1,3 @@\n\
	                 keep\n\
	                +one\n\
	                +two\n";
	    // Unified-diff line indices are 0-based over the body of the diff.
	    let patch = format_selection_patch(&parse_working_tree_diff(diff), &[1]).expect("a patch");
	    assert!(patch.contains("@@ -1,0 +2,1 @@"));
	    assert!(patch.contains("+one"));
	    assert!(!patch.contains("+two"));
	}
	```

- [ ] **Step 11.3: Run the new test; expect FAIL** (the module does not exist yet).

	```bash
	cargo test -p bibcode-server a_selection_of_one_added_line_produces_a_zero_context_patch_for_that_line_only
	```

- [ ] **Step 11.4: Implement the minimum to make Step 11.2 pass.**

	In `apps/server/src/git/manager/patch.rs` add `parse_working_tree_diff(&str) -> ParsedFileDiff` (file headers plus hunks with `@@` ranges and typed lines) and `format_selection_patch(&ParsedFileDiff, &[usize]) -> Option<String>`. The formatter emits `--unidiff-zero` patches: unselected **added** lines are dropped, unselected **deleted** lines become context, and each contiguous run of selected lines becomes its own `@@` header with recomputed old/new offsets. `None` means the selection is empty, so the caller runs no git command.

- [ ] **Step 11.5: Run the test; expect PASS.**

- [ ] **Step 11.6: Add the remaining patch-construction tests.** One at a time, each failing first: a selection of one deleted line; a mixed selection across two hunks; a selection spanning a file with no trailing newline (`\ No newline at end of file` must be preserved on the line it belongs to); an empty selection returning `None`; a selection of every line reproducing the whole diff. These are the cases that corrupt an index when they are wrong, so they are non-optional.

- [ ] **Step 11.7: Add the stage-partial executor.**

	In `operations.rs`, `stage_partial(...)` — the executor behind `gitManager.stagePartial` — performs, in PHASE-07's mandatory order — in-flight registry → catalog lock → guard re-validation → `broadcaster.begin_mutation(&cwd)` → execute → `mutation.finish()`:

	1. Take a fresh working-tree diff for the path:

	   ```text
	   git diff --no-ext-diff --patch-with-raw -z --no-color HEAD -- <path>
	   ```

	   An untracked path has no `HEAD` diff; run `git add --intent-to-add -- <path>` first so it becomes diffable, then re-read.
	2. Reject with a stale-selection error if the diff no longer matches the generation the client passed — an agent may have rewritten the file between selection and submission.
	3. `format_selection_patch`, then apply it to the index:

	   ```text
	   git apply --cached --unidiff-zero --whitespace=nowarn -
	   ```

	   with the patch on stdin via the Step 11.1 stdin variant.

	Tests: a partial selection leaves the unselected change unstaged; a stale generation is rejected without running `apply`; an empty selection runs no git command.

- [ ] **Step 11.8: Add the unstage-partial and discard-partial executors.**

	`unstage_partial(...)` — the executor behind `gitManager.unstagePartial` — takes a fresh staged diff for the path with `git diff --cached --no-ext-diff --patch-with-raw -z --no-color HEAD -- <path>`, rejects a stale generation, builds the selected patch with the existing `parse_working_tree_diff` / `format_selection_patch` algorithm, and applies the reverse patch to the **index only**:

	```text
	git apply --cached --reverse --unidiff-zero --whitespace=nowarn -
	```

	This removes the selected lines from the index without touching the working tree. Test a successful partial unstage, assert the working-tree bytes are unchanged, and test that a stale generation runs no `git apply`.

	`discard_partial(...)` — the executor behind `gitManager.discardPartial` — builds the same patch and applies its reverse to the **working tree** (never `--cached`):

	```text
	git apply --reverse --unidiff-zero --whitespace=nowarn -
	```

	(The reference implementation builds an already-reversed patch and applies it without `--reverse`; `--reverse` is the same operation with the intent visible. Record whichever you use in the phase notes.) Partial discard is destructive, so the handler must fail closed on a stale generation rather than discarding the wrong lines. Test both the success path and the stale-generation rejection. Unstaging and discarding are deliberately separate: the former changes only the index; the latter changes only the working tree.

- [ ] **Step 11.9: Implement the handlers.** In `apps/server/src/production/git_manager_rpc.rs` replace the `gitManager.stagePartial`, `gitManager.unstagePartial` and `gitManager.discardPartial` stubs, delegating to `stage_partial` / `unstage_partial` / `discard_partial`. All three are mutations and use the operate scope, all three validate the pathspec with the existing `validate_pathspecs` helper before doing anything, and all three log stable codes plus lengths and counts only — never a file path, a patch body, a line of file content or git stderr.

- [ ] **Step 11.10: Add the integration tests.** In `apps/server/tests/production_git_manager_rpc.rs`, against a temporary repository: stage a two-line selection out of a four-line change and assert `git diff --cached` contains exactly the selected lines; unstage one of those lines and assert it leaves the index while the working-tree file remains byte-for-byte unchanged; discard a one-line selection and assert the file content changes while the index is left alone and the other working-tree change survives.

- [ ] **Step 11.11: Full build + test gate.**

	```bash
	cargo fmt --all --check
	cargo test -p bibcode-server
	cargo clippy -p bibcode-server --all-targets -- -D warnings
	vp check
	vp run typecheck
	```

	Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 11.12: Stack-specific verification.** In a scratch repository, stage a partial selection through the RPC and verify with `git diff --cached` and `git diff` that exactly the intended lines moved; unstage part of that selection and verify only the index changed; then repeat partial discard and verify only the working tree changed. Repeat for an untracked file, for a file without a trailing newline, and against a remote-hosted project (spec § 10 requires both).

- [ ] **Step 11.13: TDD proof.** Temporarily make `format_selection_patch` ignore its selection argument and emit the whole diff. Re-run `cargo test -p bibcode-server` and confirm the partial-selection unit tests and the integration test fail. Restore the real implementation and re-run.

- [ ] **Step 11.14: Mark phase complete.** Change Phase 11 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This decomposition is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] Staging a line selection moves exactly those lines into the index; the rest of the file's change stays unstaged.
- [ ] Partial unstaging removes exactly the selected lines from the index and leaves the working tree byte-for-byte unchanged.
- [ ] Partial discard reverses exactly the selected lines in the working tree and leaves the index alone.
- [ ] A stale selection (the file changed since the client read it) is rejected with a structured error and runs no `git apply`.
- [ ] `format_selection_patch` is pure and unit-tested without a repository, covering added, deleted, mixed, no-trailing-newline, empty and full selections.
- [ ] The patch is delivered on stdin through the supervised process path with its timeout, output cap and cancellation token; no temporary patch file is written to disk.
- [ ] Mutations follow PHASE-07's order: in-flight registry → catalog lock → guard re-validation → `begin_mutation` → execute → `mutation.finish()`.
- [ ] Log strings contain no file path, patch body, file content or git stderr.
- [ ] All new tests green; `cargo test -p bibcode-server` passes.
- [ ] `cargo fmt --all --check` clean; `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean; `vp check` and `vp run typecheck` clean.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counters, remote feature flags, avatar or identity fetches, third-party host contact, and no new crate in `apps/server/Cargo.toml`. This phase performs no network operation at all.
- [ ] Final `git diff` and `git status --short` reviewed for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **`parse_working_tree_diff(&str) -> ParsedFileDiff`** and **`format_selection_patch(&ParsedFileDiff, &[usize]) -> Option<String>`** live in `apps/server/src/git/manager/patch.rs`. **PHASE-13** reuses the parser for conflict-marker inspection rather than writing a second diff parser.
- **Method contract for PHASE-14:** the three methods are `gitManager.stagePartial`, `gitManager.unstagePartial` and `gitManager.discardPartial` (all gated on `gitManagerPartialStaging`). Unstage applies a reverse patch to the index with `--cached`; discard applies a reverse patch to the working tree without `--cached`. They must never be substituted for one another.
- **Selection index contract for PHASE-14:** `selectedLines` is a set of **0-based indices over the unified-diff body of the current working-tree-source diff** — staged (index versus `HEAD`) for unstage, unstaged (working tree versus index) for stage or discard. The client sends indices, never line contents. PHASE-14's gutter must derive its indices from the same diff payload the server produced, or the selection will not line up.
- **Staleness contract for PHASE-14:** every selection request carries the generation the diff was read at. A mismatch returns a structured stale error; the UI must re-read the diff and ask the user to re-select rather than retrying blindly. Partial discard fails closed.
- **Untracked files** are made diffable with `git add --intent-to-add` before the diff is taken. PHASE-14 may therefore offer the gutter on untracked files.
- **Divergence recorded:** `GitRepository::execute_with_environment` hard-codes `stdin: None` even though `ProcessRequest` supports stdin. This phase (or PHASE-04, whichever lands first) adds the stdin-capable variant; the later one must reuse it rather than adding a second.
- **Renames:** the reference implementation recreates a rename in the index before applying a partial patch (`git add --update <old>`, `git ls-tree HEAD <old>`, `git update-index --add --cacheinfo`). That path is **not** implemented here; a renamed path falls back to whole-file staging with a stated reason. PHASE-14 must render that reason rather than offering a gutter that cannot work.
