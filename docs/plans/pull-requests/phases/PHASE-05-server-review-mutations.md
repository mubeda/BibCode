# Pull Requests / Phase 05 — Server: conversation and review mutations

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session. Tick checkboxes as you go. Red → green.

**Goal:** Implement `pullRequests.runAction` for every conversation and review action on both hosts: `comment`, `editComment`, `deleteComment`, `minimizeComment`, `react`, `replyThread`, `resolveThread`, `submitReview`, `revokeApproval`, `removeOwnChangeRequest`, `dismissReview`, `rerequestReview`, `applySuggestions`. Every other `action` variant returns `unavailable` until Phase 07.

**Architecture:** `PullRequestsService::run_action` resolves the scope, decodes the request, runs a permission pre-check (`permissions::compute` on a fresh `detail` read; a denied pre-check returns `forbidden` with the same reason the client showed), then delegates to `host.run_action`. Each adapter maps the action to the CLI/API calls from spec § 10, with bodies through stdin (`gh`) or the private temp file (`glab api --input`). `submitReview` is the one multi-call action and reports partial failure precisely.

**Tech Stack:** Rust, `serde_json`, Phase 01 runner (`gh`, `glab_api_with_body`), GraphQL documents in `github/graphql.rs` and a new `gitlab/graphql.rs`, cargo test with stub scripts that record `argv`, env, and stdin/body files.

---

## Files

- **Modify:** `apps/server/src/pull_requests/model.rs` — `ActionRequest` (tagged enum on `action`), `ActionResult`
- **Modify:** `apps/server/src/pull_requests/mod.rs` — `run_action`
- **Modify:** `apps/server/src/pull_requests/github/{mod,graphql,parse}.rs`, `gitlab/{mod,parse}.rs`; **Create:** `gitlab/graphql.rs`
- **Modify:** `apps/server/src/production/pull_requests_rpc.rs` — dispatch `pullRequests.runAction`
- **Create:** `apps/server/tests/pull_requests_review_actions.rs`
- **Modify:** `packages/contracts/fixtures/rpc-wire/**` — regenerate (no count change)

## Dependencies

- Phase 03.

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator.

## Risk / Effort

Risk: High (side effects on real hosts; partial failure semantics). Effort: ~8 h.

---

## Discipline

- `AGENTS.md`. Bodies never in `argv`; the stub scripts assert it (`$*` must not contain the body text).
- Idempotency where the host allows: `react` with `on: true` when already reacted is a no-op success; `resolveThread` to the current state is a no-op success.
- The pre-check never bypasses the host: a `host_rejected` error carries the host's sentence in `hostDetail`.
- After any successful action the server does **not** re-read; the client refreshes.

## Documents to Read

- `pull-requests-spec.md` § 8.3 reviewing, § 9 behaviour (partial failure, stale head), § 10 command inventory (rows Comment … Reactions)
- `pull-requests-plan.md` § Contracts (Actions)
- `research/live-verification-2026-09-20.md` addendum (mutation names, REST paths), `research/github-gitlab-web-specs.md` § 2 (`gh api` body flags), § 5 (`glab api`)

---

## Pre-execution check

- [x] **Step 05.0: Claim the phase** (`codex-05`).

## Atomic steps

- [x] **Step 05.1: Model.** `ActionRequest` as `#[serde(tag = "action", rename_all = "camelCase")] enum` with the variants and fields from the contracts (`Comment { cwd, number, body }`, … — `cwd` and `number` on every variant; use a flattened `ActionTarget { cwd, number }` if the serde shape allows it, else repeat). `ActionResult` `#[serde(tag = "kind", rename_all = "camelCase")] enum { Done, ReviewSubmitted { landed: u32, failed: Vec<FailedComment> }, Merged { merged_sha, auto_merge_enabled }, PullRequestCreated { number, url }, Deleted }`. Round-trip test against the contracts typed-failure/request fixture for `pullRequests.runAction`.

- [x] **Step 05.2: Service pre-check test first.** In `mod.rs` tests: a fake host whose `detail` returns inputs where `viewer_is_author == true` and a `SubmitReview { event: Approve }` request → `Err(code: "forbidden", message: "You cannot approve your own pull request.")` and the fake host's `run_action` was **not** called. Implement `run_action`: scope → `host.detail` → `compute` → map action → permission field (table: comment→comment, editComment/deleteComment→editOwnComment/deleteOwnComment, minimizeComment→minimizeComment, react→react, replyThread→comment, resolveThread→resolveThreads, submitReview→review + (approve→approve | request_changes→requestChanges), revokeApproval→revokeApproval, removeOwnChangeRequest→removeOwnChangeRequest, dismissReview→dismissReview, rerequestReview→rerequestReview, applySuggestions→applySuggestion) → if `!allowed` return `forbidden` with the reason → else `host.run_action`. `submitReview` with `headSha != detail.headSha` → `stale_head` before any call.

- [x] **Step 05.3: GitHub actions.** In `github/mod.rs::run_action`:
  - `comment` → `gh pr comment <n> --repo … --body-file -` with body on stdin.
  - `editComment` → REST `PATCH repos/{r}/issues/comments/{id}` when the id is an issue comment, `PATCH repos/{r}/pulls/comments/{id}` when it is a review comment. The timeline gives ids as strings; encode the kind in the id: `ic:<databaseId>` for issue comments, `rc:<databaseId>` for review comments, `rv:<databaseId>` for reviews, `th:<nodeId>` for threads (Phase 03 Step 03.8b emits these prefixes). Body via `gh api --method PATCH --input -` with `{"body": …}`.
  - `deleteComment` → `DELETE` on the same paths.
  - `minimizeComment` → GraphQL `minimizeComment(input:{subjectId, classifier: OUTDATED})` / `unminimizeComment`; subject id = the node id (store `node:<id>` alongside — simplest: the timeline `id` is `ic:<databaseId>:<nodeId>`; parse both).
  - `react` → REST `POST repos/{r}/issues/{n}/reactions` (target null), `…/issues/comments/{id}/reactions`, `…/pulls/comments/{id}/reactions` with `{"content": …}`; `on: false` → list reactions (`GET …/reactions?content=<c>&per_page=100`), find the viewer's, `DELETE …/reactions/{reaction_id}`.
  - `replyThread` → REST `POST repos/{r}/pulls/{n}/comments/{first_comment_id}/replies` `{"body"}` (thread id `th:<nodeId>:<firstCommentDatabaseId>`).
  - `resolveThread` → GraphQL `resolveReviewThread(input:{threadId})` / `unresolveReviewThread`.
  - `submitReview` → REST `POST repos/{r}/pulls/{n}/reviews` with `{"commit_id": headSha, "event": "APPROVE"|"REQUEST_CHANGES"|"COMMENT", "body", "comments": [{path, line, side: "LEFT"|"RIGHT", start_line?, start_side?, body}]}` via `gh api --input -`. On HTTP 422 mentioning a comment (`"Pull request review comment"`/`"position"` in stderr): retry once **without** the offending comments? No — GitHub rejects the whole review; report `ReviewSubmitted { landed: 0, failed: [all comments with the host message] }` and `hostDetail`. On success → `ReviewSubmitted { landed: comments.len(), failed: [] }`. An empty-body `REQUEST_CHANGES`/`COMMENT` is rejected by the host → pre-validate: `body` required for those events (error `host_rejected` with message "A comment is required when requesting changes.").
  - `revokeApproval`, `removeOwnChangeRequest` → `unavailable` (capabilities false).
  - `dismissReview` → REST `PUT repos/{r}/pulls/{n}/reviews/{reviewId}/dismissals` `{"message"}`.
  - `rerequestReview` → `gh pr edit <n> --repo … --add-reviewer <login>`.
  - `applySuggestions` → `unavailable` with the "no public API" reason.

- [x] **Step 05.4: GitLab actions.** In `gitlab/mod.rs::run_action` (`…` = `projects/:path/merge_requests/:iid`):
  - `comment` → `glab api -X POST …/notes --input <file>` `{"body"}`.
  - `editComment` → `PUT …/discussions/:discussionId/notes/:noteId` `{"body"}`; ids `nt:<discussionId>:<noteId>` from Phase 03 Step 03.8b.
  - `deleteComment` → `DELETE …/discussions/:discussionId/notes/:noteId`.
  - `minimizeComment` → `unavailable`.
  - `react` → `POST …/award_emoji` / `POST …/notes/:noteId/award_emoji` `{"name": <gitlab name>}` (reverse map from Phase 03: +1→thumbsup, -1→thumbsdown, laugh→laughing, confused→confused, heart→heart, hooray→tada, rocket→rocket, eyes→eyes); `on: false` → `GET` list, find viewer's by `user.username`, `DELETE …/award_emoji/:id`.
  - `replyThread` → `POST …/discussions/:discussionId/notes` `{"body"}`.
  - `resolveThread` → `PUT …/discussions/:discussionId?resolved=true|false`.
  - `submitReview` → for each inline comment: `POST …/discussions` with `{"body", "position": {"base_sha","start_sha","head_sha","position_type":"text","new_path","old_path","new_line"|"old_line", "line_range"?}}` where the three SHAs come from `…/versions` (first entry) — fetch once; `side: right` → `new_line`, `left` → `old_line`; `startLine` → `line_range: { start: {line_code?}, end: … }` — GitLab's `line_range` needs `line_code`s (`<sha1 of path>_<old>_<new>`): compute `line_code = format!("{}_{}_{}", sha1_hex(path), old_line_or_0, new_line_or_0)` (implement sha1 via the crate already in the workspace — check `Cargo.lock` for `sha1`; if absent, use `git hash-object --stdin`? No: GitLab's line code uses SHA-1 of the file path; if no sha1 crate exists, send multi-line comments as single-line on the end line and record the deviation). Collect failures per comment (continue on error). Then the general body: `POST …/notes` when `body` non-empty. Then the event: `approve` → `glab mr approve <n> --repo … --sha <headSha>`; `request_changes` → GraphQL `mutation { mergeRequestRequestChanges(input:{projectPath, iid}) { errors } }` via `glab api graphql -f query=… ` (verify `glab api graphql` syntax in `glab api --help`: `glab api graphql -f query='…'`); `comment` → nothing more. Result `ReviewSubmitted { landed, failed }`; if the event call fails after comments landed, return `Err(host_rejected)` with `hostDetail` and the landed count in the message ("3 comments were posted; approval failed: …").
  - `revokeApproval` → `glab mr revoke <n> --repo …`.
  - `removeOwnChangeRequest` → GraphQL `mergeRequestDestroyRequestedChanges`.
  - `dismissReview` → `unavailable`.
  - `rerequestReview` → GraphQL `mergeRequestReviewerRereview(input:{projectPath, iid, userId: "gid://gitlab/User/<id>"})` — resolve the login to a user id via `glab api users?username=<login>`.
  - `applySuggestions` → one id → `PUT /suggestions/:id/apply` (`commit_message` optional); many → `PUT /suggestions/batch_apply` `{"ids": […], "commit_message"}`.

- [x] **Step 05.5: Body helpers.** For `gh api --input -` and `gh pr comment --body-file -`, pass `stdin: Some(bytes)` through the runner; for `glab api --input <file>` use `glab_api_with_body`. Unit tests: the stub `gh` script writes its stdin to a file; assert the JSON body arrived and `argv` contains neither the body nor `--body`; the stub `glab` copies `--input`'s file and asserts mode 0600 at call time; after the call the file is gone.

- [x] **Step 05.6: Integration tests** `apps/server/tests/pull_requests_review_actions.rs`: for each action on each host, a stub that records `argv`, env, stdin/body, and returns the recorded response; assert the exact command shape from spec § 10 and the `ActionResult`. Partial failure: GitLab stub fails the second of three discussions with 400 → `ReviewSubmitted { landed: 2, failed: [{ path, line, message }] }` and the approve call still runs; GitHub 422 on reviews → `landed: 0`. Stale head → no process call. Pre-check denial → no process call. Reaction toggle off → list then delete. `rerequestReview` on GitLab resolves the user id first.

- [x] **Step 05.7: Gate.**

  ```bash
  cargo fmt --all --check
  cargo clippy -p bibcode-server --all-targets -- -D warnings
  cargo test -p bibcode-server pull_requests -j 2
  cargo test -p bibcode-server --test pull_requests_review_actions -j 2
  vp run --filter @bibcode/contracts generate:rust-rpc-fixtures && cargo test -p bibcode-server --test rpc_wire -j 2
  ```

- [x] **Step 05.8: TDD proof.** Skip the pre-check; the "no process call on denial" test fails. Put the body into `argv` for `comment`; the stdin test fails. Restore.

- [x] **Step 05.9: Mark complete** with the id-prefix scheme (`ic:`, `rc:`, `rv:`, `th:`, `nt:`, `ds:`) recorded in `tasks.md` § Notes for Phase 06.

---

## Verification

- [x] Every review/conversation action maps to the exact spec § 10 command on both hosts (stub `argv` assertions).
- [x] Bodies never in `argv`; temp files 0600 and deleted; stdin used for `gh`.
- [x] Partial failure semantics for `submitReview` on both hosts; `stale_head` before side effects; permission pre-check denies without side effects; host rejection surfaces `hostDetail`.
- [x] Unsupported-on-host actions return `unavailable` with the capability reason.
- [x] Tripwires (logs, process surface, no pollers) still green; fmt/clippy/tests green; fixtures regenerated. Local focused/static checks pass and fixtures are unchanged; broad context/list and rpc_wire listener gates remain sandbox-blocked. See Phase 05 tasks.md for exact errors and coordinator reruns.

## Notes for downstream phases

- Timeline ids carry a kind prefix (`ic:`/`rc:`/`rv:`/`th:` on GitHub; `nt:`/`ds:` on GitLab); the client passes them back verbatim as `commentId`/`threadId`/`reviewId`.
- `submitReview` needs `headSha` (from `get`) and, for GitLab, the server fetches versions itself — the client sends only `path/line/side/startLine/body`.
- Phase 07 extends `run_action`'s match with the remaining variants; the pre-check table in `mod.rs` gets the new rows there.
