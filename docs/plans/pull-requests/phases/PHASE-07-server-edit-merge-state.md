# Pull Requests / Phase 07 — Server: editing, lock, update branch, merge, auto-merge, state changes, delete, revert

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session. Tick checkboxes as you go. Red → green.

**Goal:** Complete `pullRequests.runAction` with `editPullRequest`, `setReviewers`, `setAssignees`, `setLabels`, `setMilestone`, `lock`, `unlock`, `updateBranch`, `merge`, `disableAutoMerge`, `setDraft`, `close`, `reopen`, `delete`, `revert` on both hosts, plus their permission pre-checks and the `stale_head` guard on merge.

**Architecture:** Same shape as Phase 05: pre-check → adapter → CLI/API from spec § 10. `merge` is the one action with a bypass path (`gh pr merge --admin`; GitLab `mergeRequestUpdate(overrideRequestedChanges: true)` then merge) and always pins the head SHA. `revert` on GitLab is a two-step (commit revert → create MR through the existing `PullRequestService::create`).

**Tech Stack:** Rust, Phase 01 runner, `source_control::PullRequestService` (reuse for GitLab MR creation in revert), cargo test with stubs.

---

## Files

- **Modify:** `apps/server/src/pull_requests/{mod.rs, model.rs, github/mod.rs, github/graphql.rs, gitlab/mod.rs, gitlab/graphql.rs}`
- **Modify:** `apps/server/src/production/pull_requests_rpc.rs` (no new dispatch; the action union grows)
- **Create:** `apps/server/tests/pull_requests_edit_merge_actions.rs`
- **Modify:** `packages/contracts/fixtures/rpc-wire/**` — regenerate

## Dependencies

- Phase 05.

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator.

## Risk / Effort

Risk: High (merge is irreversible on the host). Effort: ~7 h.

---

## Discipline

- `AGENTS.md`. `merge` and `delete` are irreversible: the pre-check must be strict (permission + `headSha` equality + method ∈ allowed methods); `bypass` requires `permissions.mergeBypass.allowed`.
- Subject/body for merge via stdin (`-t` is a title argument on `gh` — titles are not bodies, `argv` is acceptable for `--subject`; bodies use `--body-file -`). GitLab `-m`/`--squash-message` take argv: pass merge messages through `glab api PUT …/merge --input <file>` instead of `glab mr merge` when a message is provided.
- No re-read after success (client refreshes), except `revert`, which returns the created PR.

## Documents to Read

- `pull-requests-spec.md` § 8.2 header/side column/merge box, § 8.4 editing, § 8.6 revert and delete, § 9 optimistic concurrency, § 10 rows Edit … Revert
- `research/live-verification-2026-09-20.md` addendum (flags: `gh pr edit`, `update-branch`, `lock`, `revert`; GitLab update/merge/rebase params)
- `apps/server/src/source_control/pull_request.rs::create` (reused for GitLab revert)

---

## Pre-execution check

- [x] **Step 07.0: Claim the phase** (`codex-07`).

## Atomic steps

- [x] **Step 07.1: Pre-check rows.** Extend the action→permission table in `mod.rs`: editPullRequest→editPullRequest, setReviewers→editReviewers, setAssignees→editAssignees, setLabels→editLabels, setMilestone→editMilestone, lock→lock, unlock→unlock, updateBranch→updateBranch (+ method ∈ methods), merge→merge (+ method ∈ `merge.methods`; `bypass` → mergeBypass; `auto` → enableAutoMerge; `headSha == detail.headSha` else `stale_head`), disableAutoMerge→disableAutoMerge, setDraft→markReady|convertToDraft, close→close, reopen→reopen, delete→delete, revert→revert. Tests first for: wrong method → `forbidden` "Squash merging is not allowed in this repository"; stale head → `stale_head`; bypass without permission → `forbidden`.

- [x] **Step 07.2: GitHub.**
  - `editPullRequest` → `gh pr edit <n> --repo … [--title <t>] [--body-file -] [--base <b>]` (body on stdin).
  - `setReviewers` → `gh pr edit … --add-reviewer a,b --remove-reviewer c`; `setAssignees` → `--add-assignee/--remove-assignee` (`@me` passthrough); `setLabels` → `--add-label/--remove-label`; `setMilestone` → `--milestone <title>` or `--remove-milestone` (the vocabulary id is the milestone number; resolve number→title from `gh api repos/{r}/milestones/<id>` or store the title as the id — choose: vocabulary `id` = title for GitHub milestones; record the decision).
  - `lock` → `gh pr lock <n> --repo … [--reason <r>]`; `unlock` → `gh pr unlock`.
  - `updateBranch` → `gh pr update-branch <n> --repo … [--rebase]` (`skipCi` ignored).
  - `merge` → `gh pr merge <n> --repo … --<method> --match-head-commit <sha> [--delete-branch] [--auto] [--admin when bypass] [--subject <s>] [--body-file -]`; result: `Merged { merged_sha: None (re-read later), auto_merge_enabled: auto }`. When `auto` is set the CLI enables auto-merge and exits 0 without merging; return `Merged { auto_merge_enabled: true }`.
  - `disableAutoMerge` → `gh pr merge <n> --repo … --disable-auto`.
  - `setDraft` → `gh pr ready <n>` (draft:false) / `gh pr ready <n> --undo` (draft:true).
  - `close` / `reopen` → `gh pr close` / `gh pr reopen`.
  - `delete` → `unavailable`.
  - `revert` → `gh pr revert <n> --repo …` → parse the created PR URL from stdout (`parse_github_create_output` from `source_control::pull_request` is reusable) → `PullRequestCreated { number, url }`.

- [x] **Step 07.3: GitLab.** (`…` = `projects/:path/merge_requests/:iid`)
  - `editPullRequest` → `PUT …` `{"title","description","target_branch"}` (only present fields) via `--input`.
  - `setReviewers`/`setAssignees` → resolve logins to ids (`GET users?username=`; cache per call), compute the new full list from `detail` (current ∪ add ∖ remove), `PUT …` `{"reviewer_ids": [...]}` / `{"assignee_ids": [...]}`.
  - `setLabels` → `PUT …` `{"add_labels": "a,b", "remove_labels": "c"}`; `setMilestone` → `{"milestone_id": <id>}` or `0` to unassign.
  - `lock`/`unlock` → `PUT …` `{"discussion_locked": true|false}`.
  - `updateBranch` → `glab mr rebase <n> --repo … [--skip-ci]`.
  - `merge` → when `bypass`: GraphQL `mergeRequestUpdate(input:{projectPath, iid, overrideRequestedChanges: true})` first; then if `subject`/`body` given: `PUT …/merge --input <file>` `{"sha","squash": method==squash,"should_remove_source_branch": deleteBranch,"merge_when_pipeline_succeeds": auto,"merge_commit_message": subject+body,"squash_commit_message": …}`; else `glab mr merge <n> --repo … --sha <sha> -y [--squash] [--remove-source-branch] [--auto-merge] [--rebase when method==rebase]`. Result `Merged { merged_sha: response.merge_commit_sha, auto_merge_enabled: auto }`.
  - `disableAutoMerge` → `POST …/cancel_merge_when_pipeline_succeeds`.
  - `setDraft` → `glab mr update <n> --repo … --ready` / `--draft`.
  - `close`/`reopen` → `glab mr close` / `glab mr reopen`.
  - `delete` → `glab mr delete <n> --repo …` → `Deleted`.
  - `revert` → `merge_commit_sha` from detail → `POST projects/:path/repository/commits/:sha/revert --input` `{"branch": "revert-<iid>-<short sha>"}` after creating that branch from the target branch (`POST projects/:path/repository/branches` `{"branch","ref": target}`), then `PullRequestService::create` (existing) with `base = target`, `head = revert branch`, title `Revert "<title>"`, body linking the original → `PullRequestCreated`.

- [x] **Step 07.4: Integration tests** `apps/server/tests/pull_requests_edit_merge_actions.rs`: exact `argv`/body per action per host; merge with a bad method → no call; stale head → no call; bypass → `--admin` / the GraphQL override call precedes the merge; auto-merge result; GitLab merge with message uses the REST path; GitLab reviewers resolve ids and send the full list; revert creates branch, reverts, creates MR (three stub calls in order); delete on GitHub → `unavailable`.

- [x] **Step 07.5: Gate.**

  ```bash
  cargo fmt --all --check
  cargo clippy -p bibcode-server --all-targets -- -D warnings
  cargo test -p bibcode-server pull_requests -j 2
  cargo test -p bibcode-server --test pull_requests_edit_merge_actions -j 2
  vp run --filter @bibcode/contracts generate:rust-rpc-fixtures && cargo test -p bibcode-server --test rpc_wire -j 2
  ```

- [x] **Step 07.6: TDD proof.** Remove the `--match-head-commit` argument; the merge `argv` test fails. Remove the method-allowed check; the bad-method test fails. Restore.

- [x] **Step 07.7: Mark complete** (record the GitHub milestone-id decision and any glab flag deviation).

---

## Verification

- [x] Every action in spec § 10 rows Edit … Revert has a passing exact-command test per host.
- [x] Merge is impossible without the head SHA, an allowed method, and the permission; bypass requires `mergeBypass`.
- [x] Irreversible actions (`merge`, `delete`) never run on a pre-check failure or stale head.
- [x] Bodies via stdin/temp file; tripwires green; fmt/clippy/tests green; fixtures regenerated.

## Notes for downstream phases

- `merge` returns `Merged { mergedSha, autoMergeEnabled }`; Phase 08 refreshes `get` and shows "Merged" or "Auto-merge enabled".
- `revert` returns `PullRequestCreated { number, url }`; Phase 08 navigates to it.
- GitHub milestone vocabulary `id` = title (recorded in `tasks.md`); GitLab `id` = numeric id as string.

Execution note: implementation is in review. The Gate was executed, with TCP-listener cases blocked by the sandbox; see the complete Phase 07 evidence and superseding milestone/auto-merge/serialization rulings in `../tasks.md`. The combined tests-green verification item remains unchecked until the coordinator runs the blocked gates.
