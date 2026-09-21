# Pull Requests / Phase 03 — Server: detail, permissions, timeline, commits, checks, files

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session. Tick checkboxes as you go. Red → green for every behaviour.

**Goal:** Implement `pullRequests.get`, `getTimeline`, `getCommits`, `getChecks`, `getFiles` for both hosts, including the server-computed `PullRequestsPermissions` and `PullRequestsMergeReadiness`.

**Architecture:** Each adapter gains `detail` (returns `DetailRaw`: the normalised detail plus the host answers permissions need), `timeline`, `commits`, `checks`, `files`. `permissions.rs` is a pure function from `(HostContext, DetailRaw, HostCapabilities)` to `Permissions` + `MergeReadiness`, unit-tested exhaustively against the spec § 7.2 table. `PullRequestsService::get` composes them. Reads are independent unary methods so the client can mount them per tab.

**Tech Stack:** Rust, `serde_json`, the Phase 01 runner/trait, existing `source_control::checks::aggregate_github_checks` (reuse for the GitHub fold), cargo test with stub scripts.

---

## Files

- **Modify:** `apps/server/src/pull_requests/model.rs` — `Detail`, `MergeReadiness`, `Timeline*`, `Commits`, `Checks`, `Files`, `DetailRaw`, `PermissionInputs`
- **Create/modify:** `apps/server/src/pull_requests/permissions.rs` — `compute(inputs) -> (Permissions, MergeReadiness)`
- **Modify:** `apps/server/src/pull_requests/github/{mod,graphql,parse}.rs`, `gitlab/{mod,parse}.rs`
- **Modify:** `apps/server/src/pull_requests/mod.rs` — `get`, `timeline`, `commits`, `checks`, `files`
- **Modify:** `apps/server/src/production/pull_requests_rpc.rs` — dispatch the five reads
- **Modify:** `apps/server/src/source_control/checks.rs` — make `aggregate_github_checks` and `ProviderCheck` reusable (`pub(crate)`) if not already
- **Create:** `apps/server/tests/pull_requests_detail_reads.rs`
- **Modify:** `packages/contracts/src/pullRequests.ts` only if a field proves missing (then regenerate fixtures)

## Dependencies

- Phase 01.

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator.

## Risk / Effort

Risk: High (permission table correctness; large payloads). Effort: ~8 h.

---

## Discipline

- Read `AGENTS.md`. Permissions are computed here and nowhere else; every reason string is authored here and rendered verbatim by the client.
- Unknown enum strings from the host map to `unknown`/`neutral` variants; never panic on shape drift.
- Output caps: 1 MiB JSON reads, 8 MiB patch (`Budget::Large`); a per-file patch over 1 MiB is dropped (`patch: null, tooLarge: true`) but the file row stays.

## Documents to Read

- `pull-requests-spec.md` § 7 (whole section; the table is the acceptance test), § 8.2 detail (what each tab needs), § 11 limits
- `pull-requests-plan.md` § Contracts (Detail, Timeline, Commits, Checks, Files)
- `research/live-verification-2026-09-20.md` (both sections) and `research/github-gitlab-web-specs.md` § 3, § 4, § 6
- `apps/server/src/source_control/checks.rs` (GitHub rollup fold to reuse)

---

## Pre-execution check

- [x] **Step 03.0: Claim the phase** (`codex-03`).

## Atomic steps

- [x] **Step 03.1: Model additions.** Add to `model.rs` the structs for `Detail`, `MergeReadiness` (+ `ReadinessStatus` enum), `ReactionSummary`, `ApprovalRule`, `LinkedIssue`, `TimelineItem` (`#[serde(tag = "kind", rename_all = "snake_case")]` enum `Comment | Review | Thread | Event`), `ThreadComment`, `Suggestion`, `Timeline`, `Commit`, `Commits`, `CheckGroup`, `Check`, `Checks`, `File`, `Files`, `DiffRefs`, plus internal `DetailRaw { detail_without_permissions: Detail, inputs: PermissionInputs }` and

  ```rust
  pub struct PermissionInputs {
      pub viewer_login: String, pub repository_permission: RepositoryPermission,
      pub state: PullRequestState, pub is_draft: bool, pub locked: bool, pub viewer_is_author: bool,
      pub is_cross_repository: bool, pub maintainer_can_modify: bool, pub merged: bool, pub merge_commit_known: bool,
      // GitHub
      pub gh: Option<GitHubInputs>, // viewer_can_update, viewer_can_merge_as_admin, viewer_can_enable_auto_merge, viewer_can_disable_auto_merge, viewer_can_apply_suggestion, merge_state_status: String, mergeable: String, review_decision: Option<String>, viewer_allowed_to_dismiss_reviews: Option<bool>, auto_merge_enabled: bool, behind_by: Option<u32>
      // GitLab
      pub gl: Option<GitLabInputs>, // can_merge, detailed_merge_status: String, has_conflicts, blocking_discussions_resolved, discussion_locked, user_can_approve, user_has_approved, approvals_left: u32, viewer_reviewer_state: Option<String>, is_reviewer: bool, merge_when_pipeline_succeeds: bool, pipeline_status: Option<String>, host_version: (u32,u32), access_level: u32, project_allows_maintainer_delete: bool
      pub merge_policy: MergePolicy, pub capabilities: HostCapabilities,
  }
  ```

- [x] **Step 03.2: Permissions test first.** `permissions.rs` `#[cfg(test)]`: build a `PermissionInputs` fixture helper and write one test per row of spec § 7.2 for each host, e.g.:

  ```rust
  #[test] fn github_author_cannot_approve_own_pull_request() {
      let mut i = github_inputs(); i.viewer_is_author = true;
      let (p, _) = compute(&i);
      assert!(!p.approve.allowed);
      assert_eq!(p.approve.reason.as_deref(), Some("You cannot approve your own pull request."));
  }
  #[test] fn github_blocked_merge_names_required_reviews() {
      let mut i = github_inputs(); i.gh.as_mut().unwrap().merge_state_status = "BLOCKED".into(); i.gh.as_mut().unwrap().review_decision = Some("REVIEW_REQUIRED".into());
      let (p, r) = compute(&i);
      assert!(!p.merge.allowed); assert_eq!(r.status, ReadinessStatus::ReviewRequired);
      assert!(p.merge.reason.as_deref().unwrap().starts_with("Merging is blocked:"));
  }
  #[test] fn gitlab_request_changes_needs_17_2() {
      let mut i = gitlab_inputs(); i.gl.as_mut().unwrap().host_version = (16, 11);
      let (p, _) = compute(&i);
      assert_eq!(p.request_changes.reason.as_deref(), Some("This GitLab instance is 16.11; requesting changes needs 17.2."));
  }
  #[test] fn gitlab_merge_reason_from_detailed_status() {
      let mut i = gitlab_inputs(); i.gl.as_mut().unwrap().detailed_merge_status = "not_approved".into();
      let (p, r) = compute(&i);
      assert_eq!(r.status, ReadinessStatus::ReviewRequired);
      assert_eq!(p.merge.reason.as_deref(), Some("Merging is blocked: 1 approval required."));
  }
  ```

  Cover: comment/react on locked (read-only unless write), minimizeComment GitHub-only, approve, requestChanges (GitHub same as approve; GitLab reviewer + version), revokeApproval (GitLab `user_has_approved`), removeOwnChangeRequest (state `requested_changes` + ≥17.8), dismissReview (GitHub write or allowed; review state APPROVED/CHANGES_REQUESTED), rerequestReview, applySuggestion (GitHub never with the "no public API" reason; GitLab developer+), editPullRequest/reviewers/assignees/labels/milestone, lock/unlock, updateBranch (methods), merge (methods filtered by policy and state; draft; every `mergeStateStatus`/`detailed_merge_status` value → reason + readiness), mergeBypass, enable/disableAutoMerge, markReady/convertToDraft, close/reopen, delete (GitHub never; GitLab owner or maintainer-when-allowed), revert (merged + merge commit), checkout (always allowed). Readiness `details` lines: e.g. `"2 of 3 required approvals"`, `"3 checks failing"`, `"Branch is 4 commits behind main"`.

- [x] **Step 03.3: Implement `compute`.** Pure, no I/O. Reason strings are constants in this file (a `mod reasons`) so the client tests can import the same text through fixtures. Merge readiness mapping — GitHub `mergeStateStatus`: CLEAN/HAS_HOOKS → mergeable; UNSTABLE → checks_failing (allowed, with the detail line); BLOCKED → review_required if `reviewDecision == REVIEW_REQUIRED`, changes_requested if CHANGES_REQUESTED, else blocked ("Blocked by branch rules"); BEHIND → behind; DIRTY → conflicts; DRAFT → draft; UNKNOWN → unknown (merge not allowed, reason "GitHub is still computing mergeability; refresh in a moment", `retryable`-style wording); merged → merged; closed → closed. GitLab `detailed_merge_status`: mergeable → mergeable; not_approved → review_required; requested_changes → changes_requested; ci_must_pass / ci_still_running → checks_pending or checks_failing by `pipeline_status`; conflict → conflicts; need_rebase → behind; draft_status → draft; discussions_not_resolved → blocked ("Unresolved threads must be resolved"); blocked_status / policies_denied / external_status_checks / jira_association_missing / broken_status → blocked with the status named; checking / unchecked / preparing → unknown; not_open → merged or closed by state.

- [x] **Step 03.4: GitHub detail.** `gh pr view <n> --repo … --json number,title,body,state,isDraft,createdAt,updatedAt,mergedAt,closedAt,mergedBy,author,headRefName,baseRefName,headRefOid,baseRefOid,isCrossRepository,headRepository,headRepositoryOwner,maintainerCanModify,additions,deletions,changedFiles,labels,milestone,assignees,reviewRequests,latestReviews,closingIssuesReferences,reactionGroups,autoMergeRequest,mergeStateStatus,mergeable,reviewDecision,url,commits` (commits only for the count: `commits | length` — if the payload is large, request `commits` separately via `getCommits` and use GraphQL `commits { totalCount }` here instead). Plus one GraphQL document (`github/graphql.rs::DETAIL_VIEWER_QUERY`): `pullRequest(number){ locked activeLockReason viewerCanUpdate viewerDidAuthor viewerCanMergeAsAdmin viewerCanEnableAutoMerge viewerCanDisableAutoMerge viewerCanApplySuggestion commits{totalCount} baseRef{ refUpdateRule{ requiredApprovingReviewCount viewerAllowedToDismissReviews } } reviewThreads{ totalCount } comments{ totalCount } }` and `repository { viewerPermission }`. Reviewers = `reviewRequests` (state unreviewed) ∪ `latestReviews` (state from review state). `reactions` from `reactionGroups` (`content`, `users.totalCount`, `viewerHasReacted`). `tabCounts.conversation` = comments + reviews totals. `behind_by`: GraphQL has no direct field; leave `None` and let readiness say "Branch is behind main" without a count.

- [x] **Step 03.5: GitHub timeline.** REST `issues/{n}/comments?per_page=100` (paginate ≤10 pages) → `comment` items (`viewerIsAuthor` = `user.login == viewer`, `minimized` is REST-invisible → use GraphQL `comments{ nodes{ id isMinimized minimizedReason } }` merged by id; simpler: fetch comments via GraphQL `pullRequest.comments(first:100, after)` with `id databaseId author{login} body createdAt updatedAt isMinimized viewerDidAuthor reactionGroups{content users{totalCount} viewerHasReacted}`), `pullRequest.reviews(first:100)` → `review` items (`state` lower-cased, `commit{oid}`, `viewerDidAuthor`, `canDismiss` = `state ∈ {APPROVED, CHANGES_REQUESTED}` && permissions.dismissReview), `pullRequest.reviewThreads(first:100)` → `thread` items with `comments{ nodes{ id databaseId author body createdAt updatedAt viewerDidAuthor reactionGroups diffHunk path line startLine originalLine } }`, `isResolved isOutdated viewerCanResolve path line startLine diffSide`; suggestions parsed from a comment body containing a ` ```suggestion ` fence (`applicable: false`, id null on GitHub). Events from `pullRequest.timelineItems(first:100, itemTypes:[LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, REVIEW_REQUESTED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, MERGED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, RENAMED_TITLE_EVENT, LOCKED_EVENT, UNLOCKED_EVENT])` with `__typename actor{login} createdAt` and the per-type detail (`label{name}`, `assignee{login}`, `requestedReviewer{login}`, `milestoneTitle`, `previousTitle/currentTitle`). Sort all items by `createdAt`. `truncated` when any connection had `hasNextPage` after the page cap.

- [x] **Step 03.6: GitHub commits, checks, files.** Commits: `gh pr view --json commits` → `oid`, `messageHeadline`, `messageBody`, `authors[0]` (login/name), `authoredDate`, url = `<pr url>/commits/<oid>`. Checks: `gh pr view --json statusCheckRollup` → reuse `aggregate_github_checks` → group by `workflow` (null → "Status checks"), map state (SUCCESS→success, FAILURE/ERROR/TIMED_OUT→failure, CANCELLED→cancelled, SKIPPED→skipped, NEUTRAL→neutral, else pending), duration from `startedAt`/`completedAt`; `summary` = failure if any failure, pending if any pending, none if empty, else success. Files: `gh pr view --json files` for the list (`path`, `additions`, `deletions`, `changeType` → added/modified/removed/renamed/copied) and `gh pr diff <n> --patch` (`Budget::Large`) split per file on `^diff --git` into `patch`; a file whose patch exceeds 1 MiB or a binary marker (`Binary files … differ` / `GIT binary patch`) → `patch: null`, `tooLarge` or `changeType: binary`. `diffRefs = { baseSha: baseRefOid, startSha: baseRefOid, headSha: headRefOid }`. If the whole patch exceeds the 8 MiB cap → return the file list with every `patch: null, tooLarge: true` and `truncated: true` (never an error).

- [x] **Step 03.7: GitLab detail.** `glab api projects/:path/merge_requests/:iid` + `…/approvals` + `…/reviewers` (+ `…/approval_state` when the instance answers 200; ignore 404/403). Map: `iid`, `title`, `description`, state, `draft`, dates, `author`, `merge_user`, `source_branch`/`target_branch`, `sha` (head), `diff_refs.base_sha` (if present; else from `…/versions[0]`), `source_project_id != target_project_id` → cross-repository, `allow_maintainer_to_push`, `changes_count`, labels (names; colours from vocabulary cache when available, else null), `milestone`, `assignees`, reviewers with `state` from `/reviewers`, approval rules from `approval_state.rules` (name, approved_by count, approvals_required, eligible_approvers) or one synthetic rule from `/approvals` (`approvals_required`, `approved_by`), `references`, `user_notes_count`, `blocking_discussions_resolved`, `detailed_merge_status`, `has_conflicts`, `discussion_locked`, `merge_when_pipeline_succeeds`, `head_pipeline.status`, `web_url`. Reactions: `…/award_emoji` (map GitLab names to the eight GitHub contents: thumbsup→+1, thumbsdown→-1, smile/laughing→laugh, confused→confused, heart→heart, tada→hooray, rocket→rocket, eyes→eyes; others dropped), `viewerReacted` by `user.username`. `viewer_reviewer_state` from `/reviewers` where `user.username == viewer`.

- [x] **Step 03.8: GitLab timeline, commits, checks, files.** Timeline: `…/discussions?per_page=100` (≤10 pages) → notes with `system: true` → `event` items (`event` derived from the body prefix: "added ~label" → labeled, "assigned to" → assigned, "requested review" → review_requested, "closed" → closed, "reopened" → reopened, "marked this merge request as ready" → ready_for_review, "marked this merge request as draft" → converted_to_draft, "merged" → merged, "changed title" → renamed, "added N commits" → head_ref_force_pushed? no → `commits_added` (add this event string), else the raw first line in `detail`); non-system individual notes → `comment`; discussions with `position` → `thread` (`path = position.new_path`, `line = new_line ?? old_line`, `side` right if `new_line` else left, `isResolved = notes.all(resolved)`, `canResolve = notes[0].resolvable`, suggestions via `…/discussions/:id/notes/:note_id` body fence + `GET /projects/:id/merge_requests/:iid/discussions` does not expose suggestion ids — use `glab api …/notes/:note_id` `suggestions[]` field when present (`id`, `applicable`, `applied`, `from_line`, `to_line`, `from_content`, `to_content`)); approvals appear as `review` items built from `approved_by` (`state: approved`, `submittedAt` from `…/resource_state_events`? not available → use `approvals.approved_by[].user` with `submittedAt = detail.updated_at`) and reviewer states `requested_changes` → `review` item `changes_requested`. Label/milestone/state events: `…/resource_label_events`, `…/resource_milestone_events`, `…/resource_state_events` (each ≤100). Commits: `…/commits?per_page=100` → `id`, `short_id`, `title`, `message` minus title, `author_name`/`author_email`(login = `author_email` local part? no: `Actor { login: author_name, name: null }`), `authored_date`, `web_url`. Checks: `…/pipelines?per_page=1` → latest → `projects/:id/pipelines/:pid/jobs?per_page=100` → groups by `stage`, `status` (success→success, failed→failure, canceled→cancelled, skipped/manual→skipped, running/pending/created/waiting_for_resource/preparing→pending), `web_url`, duration; `pipelineUrl` = pipeline `web_url`; no pipeline → `summary: none`. Files: `…/diffs?per_page=50&page=N` (≤20 pages) → `old_path`/`new_path`, `new_file`/`renamed_file`/`deleted_file` → changeType, `diff` (already a unified hunk body without headers → prefix a synthetic `--- a/<old>\n+++ b/<new>\n` so `@pierre/diffs` parses it; verify with the web FileDiff in Phase 04 and adjust here), `too_large`/`collapsed` → `tooLarge`, binary → `binary`; `diffRefs` from `…/versions[0]` (`base_commit_sha`, `start_commit_sha`, `head_commit_sha`).

- [x] **Step 03.8b: Timeline ids and reviewer states.** Every timeline id carries a kind prefix the client passes back verbatim in Phase 05: GitHub `ic:<databaseId>:<nodeId>` (issue comment), `rc:<databaseId>:<nodeId>` (review comment), `rv:<databaseId>:<nodeId>` (review), `th:<nodeId>:<firstCommentDatabaseId>` (thread); GitLab `nt:<discussionId>:<noteId>` (note), `ds:<discussionId>` (thread/discussion), `ap:<userId>` (synthetic approval review). Reviewer `state` mapping — GitHub: `reviewRequests` → `unreviewed`, latest review COMMENTED → `commented`, APPROVED → `approved`, CHANGES_REQUESTED → `changes_requested`, DISMISSED → `dismissed`; GitLab `/reviewers` `unreviewed` → `unreviewed`, `reviewed` → `commented`, `approved` → `approved`, `requested_changes` → `changes_requested`, `unapproved` → `commented`, `review_started` → `review_started`. Unit-test both mappings.

- [x] **Step 03.9: Service + RPC.** `PullRequestsService::get(cwd, number)` = scope → `host.context` (cached per call? no: call once) → `host.detail` → `permissions::compute` → `Detail { …, permissions, readiness, tabCounts }`. `timeline`/`commits`/`checks`/`files` = scope → adapter. Dispatch in `pull_requests_rpc.rs` for `pullRequests.get|getTimeline|getCommits|getChecks|getFiles` with `PullRequestsNumberInput`.

- [x] **Step 03.10: Integration tests** `apps/server/tests/pull_requests_detail_reads.rs` with stub scripts returning the addendum's recorded shapes (`openai/codex` #35882 for READ viewer: `merge.allowed == false`, `approve.allowed == true`, `applySuggestion.reason` mentions no public API, readiness `review_required` with "1 approving review" detail; `mubeda/BibCode` #14 merged: readiness `merged`, `revert.allowed == true`, `merge.allowed == false`; GitLab `gitlab-org/cli` !3941 with `user.can_merge: false`, `detailed_merge_status: not_approved`, approvals `user_can_approve: false`: `approve.allowed == false` with reason, readiness `review_required`, reviewers states parsed (`unreviewed`, `reviewed`), pipeline `success` from `head_pipeline`; GitLab version 17.9.1 → `requestChanges.allowed` depends on `is_reviewer`; version 16.11 → reason names 17.2). Timeline: GitHub thread with a line comment on `codex-rs/rust-toolchain.toml:2` (from the addendum) parses `path`, `line`, `side: right`, `isResolved: false`, `canResolve: false`; GitLab discussion with `position.new_path`. Files: a patch with two files, one binary; a 9 MiB stub patch → `truncated: true`, no error. Checks: GitHub rollup with a failing check → `summary: failure`; GitLab jobs grouped by stage.

- [x] **Step 03.11: Gate.**

  ```bash
  cargo fmt --all --check
  cargo clippy -p bibcode-server --all-targets -- -D warnings
  cargo test -p bibcode-server pull_requests -j 2
  cargo test -p bibcode-server --test pull_requests_detail_reads -j 2
  cargo test -p bibcode-server --test pull_requests_context_list -j 2
  ```

- [x] **Step 03.12: TDD proof.** Invert the author check in `compute`; the self-approve test fails. Drop the 1 MiB per-file guard; the large-file test fails. Restore.

- [x] **Step 03.13: Mark complete** with the list of reason strings (the client will assert on them) in `tasks.md`.

---

## Verification

- [x] Every row of spec § 7.2 has a passing unit test per applicable host; every `mergeStateStatus` and `detailed_merge_status` value maps to a readiness status and a reason.
- [x] `get`, `getTimeline`, `getCommits`, `getChecks`, `getFiles` return the contract shapes for both hosts from recorded fixtures; shape drift produces `unknown` variants, not errors. **Contract ruling:** unknown lifecycle states have no corresponding wire literal and retain typed `invalid_response`; unknown merge/check/reviewer states use conservative variants. See `tasks.md`.
- [x] Patch cap behaviour: per-file `tooLarge`, whole-patch `truncated`, never an error for size.
- [x] No new process surface: still only `gh`, `glab`, `git` through the runner; tripwires green.
- [x] `cargo fmt`, clippy, all `pull_requests*` tests green. **Environment-limited:** format/Clippy and the focused/detail tests pass; the existing TCP registry test is blocked by sandbox `PermissionDenied: Operation not permitted`. See Phase 03 in `tasks.md` for exact output and contract/API rulings.

## Notes for downstream phases

- Reason strings live in `permissions.rs::reasons`; Phase 04 asserts on them through fixtures, never by re-deriving.
- `DetailRaw` and `PermissionInputs` are internal; Phase 05/07 reuse `permissions::compute` **only** for pre-checks inside `run_action` (a stale pre-check must not block: the host decides).
- `diffRefs` from `getFiles` is what Phase 05's `submitReview` needs for GitLab positions; Phase 06 must carry it from the files query into the pending review.
- GitLab reactions map to the eight GitHub contents; Phase 05 must map back on write (`+1` → `thumbsup`, …).
