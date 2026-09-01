# Git Manager / Phase 04 — Server staging and commit operations

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Implement the standalone commit, undo-commit and discard mutations behind `gitManager.commit`, `gitManager.undoCommit` and `gitManager.discard`, replacing the PHASE-00 stubs.

**Architecture:** New operation code in `apps/server/src/git/manager/operations.rs` plus handlers in `apps/server/src/production/git_manager_rpc.rs`. The Git Manager keeps BiBCode's **visible-index** staging model — it reuses the existing `vcs.stageFiles` / `vcs.unstageFiles` RPCs rather than rebuilding the index at commit time, so it matches the Source Control panel it shares state with and cannot race an agent's concurrent `git add`. Every mutation passes through the status broadcaster's mutation fence and the supervised process path. Implements the master plan's § Server (The staging model, Mutation discipline) and Slice 2's server half.

**Tech Stack:** Rust 2021 / Axum / Tokio — apps/server. Build: `cargo build -p bibcode-server`. Test: `cargo test -p bibcode-server`. Lint: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Format: `cargo fmt --all --check`. Inline `#[cfg(test)]` unit tests; integration tests in `apps/server/tests/`.

---

## Files

- **Modify:** `apps/server/src/git/manager/operations.rs` — commit-argument construction, trailer handling, undo and discard logic (skeleton created by PHASE-00)
- **Modify:** `apps/server/src/production/git_manager_rpc.rs` — replace the `commit` / `undoCommit` / `discard` stubs
- **Modify:** `apps/server/src/git/repository.rs` — add the commit/undo/discard primitives the module calls
- **Modify:** `apps/server/src/git/mod.rs` — re-export new public types
- **Create:** `apps/server/tests/git_manager_commit.rs` — integration tests over a real temporary repository

**This is the only registry/handler-touching Rust phase in its round.** Do not edit `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs` or `packages/contracts/` — PHASE-00 declared everything. If a schema field is genuinely missing, stop and escalate through `tasks.md`.

## Dependencies

- Phase 00: Wire contracts for the whole feature
- Phase 01: Server read modules and read RPCs

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
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints (§ 3.1 commit options, § 6.5 destructive actions)
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints (§ Server, The staging model)
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 3.2 (commit flags and staging), § 3.9 (undo commit, reset), § 1.1 (co-author trailers, amend, undo strip)
- `docs/architecture/rpc-and-orchestration.md` — the mutation fence and admission-lease contract
- `docs/plans/git-manager/phases/PHASE-00-contracts.md` § Notes for downstream phases — the request/error shapes
- `docs/plans/git-manager/phases/PHASE-01-server-read-rpcs.md` § Notes for downstream phases — the module names this phase builds on

If a file does not exist, report it back in the per-phase notes section of `tasks.md` and continue with what's available.

---

## Pre-execution check

- [ ] **Step 04.0: Claim the phase.** Open `../tasks.md`. Change Phase 04 row → `Status = in_progress`, `Agent = phase-04`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 04.1: Locate the surface area being changed.** Line numbers are indicative; re-verify.

  ```bash
  rg -n 'pub async fn commit|pub async fn stage_files|pub async fn unstage_files|pub async fn discard_files' apps/server/src/git/repository.rs
  rg -n 'vcs.stageFiles" \| "vcs.unstageFiles"' -A45 apps/server/src/production/git_vcs.rs
  rg -n 'async fn run_owned_git_mutation' -A30 apps/server/src/production/git_vcs.rs
  rg -n 'fn validate_pathspecs' apps/server/src/git/repository.rs
  ```

  The stage/unstage/discard arm (indicative git_vcs.rs:522-568) is the exact template: decode → `validate_pathspecs` → `run_owned_git_mutation(method, cwd, workspace_admission, cancellation, …)`, which takes the mutation fence via `broadcaster.begin_mutation(cwd)` before running. Read `GitRepository::commit` (indicative repository.rs:3110-3173) — it hard-codes `-m` and rebuilds the index with `reset` + `add -A`. **Do not change it**; existing callers (`git.runStackedAction`) depend on it.

- [ ] **Step 04.2: Author the first failing test.** Path: `apps/server/src/git/manager/operations.rs` (inline `#[cfg(test)]`)

  ```rust
  #[test]
  fn builds_commit_arguments_from_the_request_options() {
      let request = CommitRequest {
          summary: "Fix the parser".into(),
          description: Some("Handles NUL records.".into()),
          amend: true,
          no_verify: true,
          signoff: true,
          allow_empty: false,
          co_authors: vec![CoAuthor {
              name: "Ann Author".into(),
              email: "ann@example.test".into(),
          }],
      };
      let args = commit_arguments(&request);
      assert_eq!(args[0], "commit");
      assert!(args.contains(&"--amend".to_owned()));
      assert!(args.contains(&"--no-verify".to_owned()));
      assert!(args.contains(&"--signoff".to_owned()));
      assert!(!args.contains(&"--allow-empty".to_owned()));
      assert!(args.contains(&"-F".to_owned()) && args.contains(&"-".to_owned()));
      assert_eq!(
          commit_message_body(&request),
          "Fix the parser\n\nHandles NUL records.\n\nCo-Authored-By: Ann Author <ann@example.test>\n"
      );
  }
  ```

- [ ] **Step 04.3: Run the new test; expect FAIL** (`commit_arguments` does not exist).

  ```bash
  cargo test -p bibcode-server git::manager::operations
  ```

- [ ] **Step 04.4: Implement the minimum to make Step 04.2 pass.** Path: `apps/server/src/git/manager/operations.rs`. Add `CommitRequest`, `CoAuthor`, `commit_arguments(&CommitRequest) -> Vec<String>` and `commit_message_body(&CommitRequest) -> String`. The message goes on **stdin** via `git commit -F -`, never as an argument — a summary or description can contain anything. `ProcessRequest` already carries a `stdin` field.

- [ ] **Step 04.5: Run the test; expect PASS.**

- [ ] **Step 04.6+: Add the remaining behaviour, one failing test at a time.**
  1.  **`gitManager.commit`** — a new `GitRepository::commit_with_options(cwd, args, message, cancellation)` that runs `git commit -F -` with the constructed arguments and returns the new sha via `rev-parse HEAD`. It **does not** call `reset` or `add -A`: staging is already visible in the index, set by `vcs.stageFiles` / `vcs.unstageFiles`. Take a fresh status snapshot immediately before committing (spec § 6.2) and return an empty-commit outcome rather than an error when nothing is staged and `--allow-empty` was not requested.
  2.  **`gitManager.undoCommit`** — `git reset --mixed <parentSha>` for the normal case; for the initial commit, restore deleted files with `git checkout HEAD -- <paths>`, delete the ref with `git update-ref -d HEAD`, then unstage. Return the undone commit's message and co-author trailers so the client can restore the draft. Refuse when the commit carries tags, when a rebase is in progress, or when the head commit is not local — return a structured `GitManagerOperationError`, never raw stderr. **`update-ref -d HEAD` here is the documented initial-commit path and is not a worktree-guard bypass**; plumbing `update-ref` to move a branch remains forbidden.
  3.  **`gitManager.discard`** — whole-file and discard-all. Move files to the OS trash where the platform supports it, then `git checkout HEAD -- <paths>`; when trashing fails, return a distinguishable `trash-unavailable` outcome so the client can offer a permanent-discard confirmation rather than silently deleting. Untracked files are removed, not checked out.
  4.  Every handler calls `validate_pathspecs` before touching the filesystem and runs inside `run_owned_git_mutation` so the mutation fence and the admission lease apply.
  5.  A concurrent second Git Manager mutation on the same repository is rejected with `operation-in-flight` — **never queued silently**.

- [ ] **Step 04.7: Add integration tests.** Path: `apps/server/tests/git_manager_commit.rs`, following `apps/server/tests/production_git_vcs_rpc.rs` for harness shape. Over the wire: staging a file with `vcs.stageFiles` then `gitManager.commit` produces exactly that commit; `--amend` rewrites the head; a co-author trailer appears in `git log --format=%B`; `gitManager.undoCommit` restores the working tree and returns the message; `gitManager.discard` restores a modified file; a commit attempt with only the **read** scope is rejected; a second concurrent mutation is rejected with `operation-in-flight`.

- [ ] **Step 04.8: Full build + test gate.**

  ```bash
  cargo fmt --all --check
  cargo test -p bibcode-server
  cargo clippy -p bibcode-server --all-targets -- -D warnings
  vp check
  vp run typecheck
  ```

  Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 04.9: Constraint review.**

  ```bash
  rg -n 'ignore-other-worktrees|worktree add -f|--force\b|update-ref' apps/server/src/git/manager apps/server/src/production/git_manager_rpc.rs
  git diff -- apps/server/src | rg 'tracing::(info|warn|error|debug)!' -A3
  ```

  The first must return only the documented initial-commit `update-ref -d HEAD`. The second must show no interpolated branch name, ref name, absolute path, remote URL or git stderr — stable codes plus lengths and counts only. Confirm nothing added here can add, create, clone, publish or remove a repository.

- [ ] **Step 04.10: TDD proof.** Make `commit_arguments` drop every flag and make `gitManager.discard` a no-op. Re-run `cargo test -p bibcode-server git::manager::operations` and the new integration test; confirm they fail. Restore.

- [ ] **Step 04.11: Mark phase complete.** Change Phase 04 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary: what landed, how many tests, the exact request field names, and any deviation.

> **No commit step.** This skill is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] `gitManager.commit` honours summary, description, `--amend`, `--no-verify`, `--signoff`, `--allow-empty` and co-author trailers, and passes the message on stdin via `-F -`.
- [ ] The commit path does **not** rebuild the index (`reset` + `add -A`); it commits what `vcs.stageFiles` / `vcs.unstageFiles` already staged, after a fresh status snapshot.
- [ ] `gitManager.undoCommit` handles the normal and initial-commit cases and returns the message and co-authors for draft restoration; it refuses tagged commits and mid-rebase state with a structured error.
- [ ] `gitManager.discard` trashes where supported and reports `trash-unavailable` instead of deleting permanently on failure.
- [ ] Every mutation passes through `run_owned_git_mutation` (mutation fence + admission lease) and the supervised process path with a timeout, output cap and cancellation token.
- [ ] A second concurrent mutation is rejected with `operation-in-flight`, never queued.
- [ ] No `--ignore-other-worktrees`, no `git worktree add -f`, no bare `--force`, and no plumbing `update-ref` used to move a branch.
- [ ] Nothing added can add, create, clone, publish or remove a repository (constraint 1).
- [ ] No log string interpolates a branch name, ref name, absolute path, remote URL or git stderr.
- [ ] `cargo fmt --all --check`, `cargo test -p bibcode-server`, `cargo clippy -p bibcode-server --all-targets -- -D warnings` clean; `vp check` and `vp run typecheck` clean.
- [ ] Validated end to end against **both** a local project and a remote-hosted project.
- [ ] **Zero telemetry:** this phase adds no analytics, crash reporting, usage counter, remote feature flag, avatar/identity fetch, third-party host contact, or new dependency. `git diff apps/server/Cargo.toml Cargo.lock` shows no change.
- [ ] Final `git diff` and `git status --short` review: no generated files, no debug output, no unrelated edits; `GitRepository::commit` and the `vcs.*` handlers unchanged.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **PHASE-08 (web staging and commit UI)** calls, in this order: `vcs.stageFiles` / `vcs.unstageFiles` for inclusion, then `gitManager.commit`. It must **not** send an inclusion list to `gitManager.commit` — staging is the index, and the index is already correct.
- **`gitManager.commit` request fields** are `{ cwd, summary, description, amend, noVerify, signoff, allowEmpty, coAuthors: [{ name, email }] }`; the response carries `{ sha, empty }`. `gitManager.undoCommit` responds with `{ summary, description, coAuthors }` so PHASE-08 can refill the shared draft. `gitManager.discard` request is `{ cwd, paths, permitPermanent }` and responds with `{ trashed, permanentlyDiscarded, trashUnavailable }`.
- **Discard outcomes drive the confirmation flow.** PHASE-08 shows the permanent-discard confirmation only when the server reports `trashUnavailable`; it never decides trashability itself.
- **`operation-in-flight` is a `GitManagerOperationError`** carrying a `blocked` reason, produced by PHASE-02's guard codes. PHASE-08 renders `message` verbatim.
- **PHASE-11** extends `operations.rs` with patch construction and `git apply --cached --unidiff-zero --whitespace=nowarn`. Keep `commit_arguments` and `commit_message_body` public within the module so partial staging composes with the same commit path.
- **PHASE-07/09/13 share `operations.rs`** but land in later rounds. Keep this phase's additions in a clearly delimited section so those phases append rather than rewrite.
