# Git Manager / Phase 01 — Server read modules and read RPCs

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Implement the three Git Manager read RPCs — refs snapshot, tip-pinned commit page, and read-scoped diff — replacing the PHASE-00 stubs with real git-backed handlers.

**Architecture:** Two new modules under `apps/server/src/git/manager/`: `refs.rs` builds a `GitManagerRefsSnapshot` from `for-each-ref`, the worktree inventory, ahead/behind counts and `.git` state probes; `graph.rs` pages commits against a resolved tip snapshot rather than a raw `--skip` offset, so concurrent agent commits cannot duplicate or drop rows. Handlers land in `apps/server/src/production/git_manager_rpc.rs`. All three are read-scoped and run through the existing supervised process path with the lock-avoiding read environment. Implements the master plan's § Server (History paging) and Slice 0.

**Tech Stack:** Rust 2021 / Axum / Tokio — apps/server. Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Inline `#[cfg(test)]` unit tests; integration tests in `apps/server/tests/`.

---

## Files

- **Modify:** `apps/server/src/git/manager/refs.rs` — refs snapshot assembly and parsing (skeleton created by PHASE-00)
- **Modify:** `apps/server/src/git/manager/graph.rs` — tip-pinned commit paging and parsing (skeleton created by PHASE-00)
- **Modify:** `apps/server/src/production/git_manager_rpc.rs` — replace the `getRefs` / `getCommits` / `getDiff` stubs
- **Modify:** `apps/server/src/git/repository.rs` — add the read helpers the two modules call (`for-each-ref` with `%(worktreepath)`, `worktree list --porcelain` inventory, repo-state probes, `log` paging, per-source diff)
- **Modify:** `apps/server/src/git/mod.rs` — re-export the new public types
- **Create:** `apps/server/tests/git_manager_reads.rs` — integration tests over a real temporary repository

## Dependencies

- Phase 00: Wire contracts for the whole feature

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

> _(no domain-specific matches for this phase in the current skill inventory; always-on superpowers cover it)_

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints (§ 8 performance constants)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints (§ Server, History paging)
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 3.1, § 3.3, § 3.5 carry the exact command lines and parse formats; treat them as the specification for each git call
- `docs/plans/git-manager/research/worktree-checkout-restrictions.md` — § A.4 on `%(worktreepath)` and `worktree list --porcelain` fields
- `docs/architecture/overview.md` — the read environment and `GIT_OPTIONAL_LOCKS=0` contract
- `docs/architecture/rpc-and-orchestration.md` — handler shape, admission leases, and scope rules
- `docs/plans/git-manager/phases/PHASE-00-contracts.md` § Notes for downstream phases — the schema symbols this phase must produce

If a file does not exist, report it back in the per-phase notes section of `tasks.md` and continue with what's available.

---

## Pre-execution check

- [ ] **Step 01.0: Claim the phase.** Open `../tasks.md`. Change Phase 01 row → `Status = in_progress`, `Agent = phase-01`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 01.1: Locate the surface area being changed.** Line numbers are indicative; re-verify.

  ```bash
  rg -n 'pub async fn list_refs|async fn worktree_map|pub async fn list_commits|async fn default_ref' apps/server/src/git/repository.rs
  rg -n 'fn git_read_environment|async fn run_read|async fn execute_read' apps/server/src/git/repository.rs
  rg -n 'guard_git_path|handle_admitted_unary|await_git_rpc_operation' apps/server/src/production/git_vcs.rs
  rg -n 'gitManager' apps/server/src/production/git_manager_rpc.rs
  ```

  Read `list_refs` (indicative repository.rs:1574-1660) and `worktree_map` (indicative :3376-3403) — they are the template. Note that `list_refs` currently uses `--format=%(refname:short)%09%(HEAD)%09%(committerdate:unix)` and gets occupancy from a **separate** `worktree list --porcelain` call. **Do not modify `list_refs`, `VcsRef` or `VcsCommit`** — existing callers depend on them.

- [ ] **Step 01.2: Author the first failing test.** Path: `apps/server/src/git/manager/graph.rs` (inline `#[cfg(test)]`)

  ```rust
  #[test]
  fn parses_a_nul_delimited_log_record_into_a_commit_entry() {
      let record = "abc1234def\u{1f}abc1234\u{1f}Subject line\u{1f}Body\u{1f}\
  Ann Author\u{1f}ann@example.test\u{1f}1735689600\u{1f}\
  Cara Committer\u{1f}cara@example.test\u{1f}1735689660\u{1f}\
  parent1 parent2\u{1f}HEAD -> main, origin/main";
      let entry = parse_commit_record(record).expect("record parses");
      assert_eq!(entry.short_sha, "abc1234");
      assert_eq!(entry.parents, vec!["parent1", "parent2"]);
      assert_eq!(entry.decorations, vec!["HEAD -> main", "origin/main"]);
  }
  ```

- [ ] **Step 01.3: Run the new test; expect FAIL** (`parse_commit_record` does not exist).

  ```bash
  cargo test -p bibcode-server git::manager::graph
  ```

- [ ] **Step 01.4: Implement the minimum to make Step 01.2 pass.** Path: `apps/server/src/git/manager/graph.rs`. Add `parse_commit_record(record: &str) -> Option<GitManagerCommitEntry>` splitting on `\u{1f}` with the field order above. Use an explicit record separator (`\u{1e}`) and field separator (`\u{1f}`) in the `--format` string so subjects and bodies containing newlines parse correctly.

- [ ] **Step 01.5: Run the test; expect PASS.**

- [ ] **Step 01.6: Add the tip-pinned paging logic and its tests.** In `graph.rs`:
  - `resolve_tips(cwd) -> Vec<(refName, sha)>` via one `for-each-ref --format='%(refname)%09%(objectname)' refs/heads refs/remotes refs/tags`, capped (adopt a constant, e.g. `MAX_PINNED_TIPS = 512`).
  - `page(cwd, pinned_tips, offset, limit)` issues `git log --no-show-signature --no-color -z --date=raw --skip=<offset> --max-count=<limit> <tip shas…> --` so offsets stay valid however much the repository moves.
  - When the repository exceeds `MAX_PINNED_TIPS`, fall back to `--all` paging and set `degradedToAllPaging: true` in the page so the UI can state it rather than silently degrading.
  - Page size is 100 commits (spec § 8).
  - Tests: an offset past the end returns `exhausted: true`; a tip that can no longer be resolved returns a distinguishable error the handler maps to a full reset; the degraded flag is set above the cap.

- [ ] **Step 01.7: Implement `refs.rs` and its tests.** Assemble a `GitManagerRefsSnapshot` from:
  - `git for-each-ref --format='%(refname:short)%09%(objectname)%09%(upstream:short)%09%(worktreepath)%09%(HEAD)' refs/heads refs/remotes refs/tags` — one call gives occupancy directly (`%(worktreepath)`, git ≥ 2.22; verified on 2.55.0).
  - `git worktree list --porcelain` for the worktree inventory including `locked` / `prunable` / `detached`, which `%(worktreepath)` does not supply. **Occupancy must count registered worktrees whose directory is missing** — deletion protection outlives the directory.
  - ahead/behind per local branch with an upstream (`rev-list --left-right --count`).
  - repository state: `HEAD` ref or detached sha, dirty flag, default branch, remotes, and the in-progress operation probed from `MERGE_HEAD`, `rebase-merge/*`, `sequencer/*`, `CHERRY_PICK_HEAD`, `SQUASH_MSG`.
  - `blocked: vec![]` on every ref for now — PHASE-02 supplies the pure guards module that fills it, and PHASE-07 wires it in.
  - a monotonically increasing `generation`.
    Tests cover: an occupied branch reports its `worktreePath`; a registered-but-missing worktree still reports occupancy; a detached HEAD sets `detachedSha` and leaves `headRef` null; a merge in progress is reported.

- [ ] **Step 01.8: Implement `gitManager.getDiff` and replace the three stubs.** In `apps/server/src/production/git_manager_rpc.rs`, mirror the read arms of `handle_admitted_unary` in `apps/server/src/production/git_vcs.rs`: decode the input, take the workspace admission lease via `guard_git_path`, then run the operation with the child cancellation token. Diff sources:
  - `working-tree`: `git diff --no-ext-diff --patch-with-raw -z --no-color HEAD -- <path>`, untracked via `--no-index -- /dev/null <path>`.
  - `commit`: `git log <sha> -m -1 --first-parent --patch-with-raw --format= -z --no-color -- <path>`.
  - `stash`: the same shape against `stash@{n}` (PHASE-09 exercises it; return the not-implemented code until then only if the stash plumbing is absent — otherwise implement it now).
    Apply the size ladder from spec § 8: above ~70 MB do not parse at all; above ~4.375 MB return a `large-text` marker instead of content; any line longer than 5000 characters degrades the file to large-text. Enforce these as **server-side output caps**, not client policy.

- [ ] **Step 01.9: Add integration tests.** Path: `apps/server/tests/git_manager_reads.rs`. Following `apps/server/tests/production_git_vcs_rpc.rs` for harness shape, create a temporary repository with a linked worktree and assert over the wire that: `gitManager.getRefs` reports the occupied branch's worktree path; `gitManager.getCommits` returns a stable second page after a new commit lands between pages; `gitManager.getDiff` returns a working-tree diff for a modified file; and all three succeed with only the **read** scope granted.

- [ ] **Step 01.10: Full build + test gate.**

  ```bash
  cargo fmt --all --check
  cargo test -p bibcode-server
  cargo clippy -p bibcode-server --all-targets -- -D warnings
  vp check
  vp run typecheck
  ```

  Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 01.11: Log-hygiene review.** Grep your diff for interpolated branch names, ref names, absolute paths, remote URLs and git stderr in log strings:

  ```bash
  git diff -- apps/server/src | rg 'tracing::(info|warn|error|debug)!' -A3
  ```

  Every log line must carry stable codes plus lengths and counts only — mirroring the existing `GitCommandError`, which carries `stdoutLength`/`stderrLength` and not the text.

- [ ] **Step 01.12: TDD proof.** Make `parse_commit_record` return `None` unconditionally and make `refs.rs` return an empty worktree inventory. Re-run `cargo test -p bibcode-server git::manager` and the new integration test; confirm they fail. Restore.

- [ ] **Step 01.13: Mark phase complete.** Change Phase 01 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary: what landed, how many tests, any deviation from the plan.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] `gitManager.getRefs` returns a snapshot whose local branches carry `worktreePath`, upstream, ahead/behind, `current` and `isDefault`, plus repository-level head/detached/dirty/default/remotes/in-progress/conflicted fields and a `generation`.
- [ ] `gitManager.getCommits` pages against pinned tips; a commit landing between page 1 and page 2 neither duplicates nor drops a row (proven by the integration test).
- [ ] `gitManager.getDiff` works for the `working-tree` and `commit` sources and enforces the size ladder server-side.
- [ ] All three succeed with only `orchestration:read` — no read requires a write scope.
- [ ] Every new git invocation goes through the supervised process path with the read environment (`GIT_OPTIONAL_LOCKS=0`) and a cancellation token; none uses `--ignore-other-worktrees`, `worktree add -f`, or plumbing `update-ref`.
- [ ] Occupancy comes from `%(worktreepath)` / `worktree list --porcelain`, never from matching git stderr.
- [ ] No log string interpolates a branch name, ref name, absolute path, remote URL or git stderr.
- [ ] `cargo fmt --all --check`, `cargo test -p bibcode-server`, `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean; `vp check` and `vp run typecheck` clean.
- [ ] **Zero telemetry:** this phase adds no analytics, crash reporting, usage counter, remote feature flag, avatar/identity fetch, third-party host contact, or new dependency. `git diff apps/server/Cargo.toml Cargo.lock` shows no dependency change.
- [ ] Final `git diff` and `git status --short` review: no generated files, no debug output, no unrelated edits; `VcsRef`, `VcsCommit` and `list_refs` unchanged.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **PHASE-02** supplies `apps/server/src/git/manager/guards.rs`. This phase leaves `GitManagerRefEntry.blocked` as an empty vector. The guards function's input is exactly what `refs.rs` already assembles: parsed refs, worktree inventory, dirty flag, default branch, in-progress operation and lock state.
- **PHASE-05** consumes `gitManager.getRefs` for the worktree list and the conflicted-path set, and joins `conflictedPaths` to the existing `subscribeVcsStatus` file list — `VcsWorkingTreeFileStatus` has no unmerged state, so conflict presentation comes from the refs snapshot, not from the status stream's `status` field.
- **PHASE-06** consumes `gitManager.getCommits` and `gitManager.getDiff` with `{ _tag: "commit", sha, path }`. Pages carry `pinnedTips`, which the client passes back verbatim on every subsequent page; a `generation` bump splices new commits **above** the pinned snapshot rather than discarding loaded pages. A page returning the tips-unresolvable error means a full reset.
- **PHASE-09** extends `refs.rs`'s in-progress probe and reuses `resolve_tips` for the refs/HEAD/worktree signature. Do not add a second poller — the signature check belongs on the existing `StatusBroadcaster` ref tick.
- **Public Rust names other phases depend on:** `git::manager::refs::build_refs_snapshot`, `git::manager::graph::{resolve_tips, page, parse_commit_record}`, and `MAX_PINNED_TIPS`. Keep these names stable.
- The diff size-ladder constants live in `apps/server/src/git/manager/` and are the **server's** policy; PHASE-06 renders the resulting marker and must not re-derive the thresholds client-side.
