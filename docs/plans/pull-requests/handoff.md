# Pull Requests — Hand-off for code review

**Last touched:** 2026-09-21 09:45 UTC (coordinator, after Phase 10)
**Branch:** main-3 (worktree `/work/workspaces/orca/BibCode/main-3`, base commit `1bbc8d1a`)
**Status:** Phases 00–09 accepted; Phase 10 `in_progress` — GitLab end-to-end and live host-write acceptance pending (see TODOs). Nothing is committed.

## What this iteration delivered

1. A project-scoped **Pull Requests** module (sidebar button next to Git Manager, routes `…/pull-requests` and `…/pull-requests/$number?tab=`), gated by **Settings → Source Control → Pull requests** and by server capabilities (`pullRequestsReads` / `pullRequestsMutations`).
2. Host support for **GitHub** (github.com and GitHub Enterprise hosts configured in `gh`) and **GitLab** (gitlab.com and self-hosted hosts configured in `glab`), with availability states `no_remote`, `unsupported_provider`, `unknown_host`, `cli_missing`, `not_authenticated` and a missing-checkout explanation.
3. Reads: list with tabs/filters/sort/search and pagination, detail header with server-computed readiness and permissions, conversation timeline (comments, reviews, threads, suggestions, reactions, system events), commits, checks/pipelines, files with lazy diffs and viewed state.
4. Review writes: comments (create/edit/delete/minimize), replies, reactions, resolve/unresolve, inline review comments with suggestions, pending review submitted as Comment/Approve/Request changes with the reviewed head pinned, dismiss/re-request, GitLab revoke approval / remove own change request / apply suggestions.
5. Editing and merge: title/description/base, reviewers/assignees/labels/milestone with five-second Undo, lock/unlock (GitHub reasons), update branch/rebase, merge (methods from permissions, subject/body, delete branch, auto-merge, bypass with confirmation), disable auto-merge, draft/ready, close/reopen, revert (navigates to the new request), GitLab delete.
6. Checkout for local verification: split button with the current checkout, other worktrees and **New worktree…** (managed worktree, branch `<head>` or `<head>-pr-<n>` on collision); Git Manager guards reused; a started Git write always completes even if the client disconnects.
7. Zero telemetry: no browser HTTP to hosts, no avatar/image fetches, no timers; enforced by `pullRequestsTelemetry.test.tsx` and server `mod tripwires`.

**Out of scope this iteration (acknowledged)** — spec § 3.2: Azure DevOps and Bitbucket; applying GitHub suggestions (no public API); branch-protection / approval-rule / merge-train administration; GitHub pull-request deletion (no API).

Verdicts and evidence per phase live in `tasks.md` → "Coordination notes"; the phase files’ Verification boxes were ticked from those notes.

## Background docs (read in this order)

1. `pull-requests-spec.md` (approved for full functionality, decisions D1–D20)
2. `pull-requests-plan.md`
3. `tasks.md` (per-phase Codex reports and the coordinator's "Coordination notes" with verdicts and evidence)
4. `phases/PHASE-00-…` … `phases/PHASE-10-…`
5. `research/` (integration surface, server provider layer, settings and capabilities, GitHub/GitLab specs, live verification)

## Files touched

Counts from `git status --short -uall` against `1bbc8d1a` (248 paths, all uncommitted):

| Layer                                        | Paths              | Notes                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`                         | 23                 | `src/pullRequests.ts` (schemas, 10 RPC methods), `environment.ts`, `settings.ts`, `sourceControl.ts`, `rpc.ts`, fixtures (131 methods / 288 typed failures / 380 fixtures / 358 fingerprints), 636 tests                                                                                                                                                    |
| `apps/server/src`                            | 41                 | `pull_requests/` (mod, model, host, context, error, permissions, read, checkout, action, github/_, gitlab/_), `production/pull_requests_rpc.rs`, `source_control/*` (create transport, discovery hosts), `git/repository.rs` + `production/worktree_catalog_rpc.rs` (managed creation reuse), `state/query`-side docs                                       |
| `apps/server/tests`                          | 20                 | `pull_requests_context_list` 18, `pull_requests_detail_reads` 21, `pull_requests_review_actions` 30, `pull_requests_edit_merge_actions` 25, `pull_requests_checkout` 31, `rpc_wire` 13; library `pull_requests` 156 incl. 9 tripwires                                                                                                                       |
| `packages/client-runtime`, `packages/shared` | 5                  | environment atoms for `pullRequests.*`, test support                                                                                                                                                                                                                                                                                                        |
| `apps/web/src`                               | 124                | `components/pullRequests/**` (panel, list, detail, review, edit, shared, checkout menu, hooks), `pullRequestsStore.ts`, `state/pullRequests.ts`, `state/query.ts`, routes, Sidebar, Settings; 418 tests in 51 module files, whole web suite 6615                                                                                                            |
| `apps/desktop`                               | 1                  | packaged e2e sibling in `e2e/specs/pierre-diffs.e2e.ts` (clicks the Pull Requests button, asserts the route)                                                                                                                                                                                                                                                |
| `docs`                                       | 11 + 22 plan files | `user/workspace-ui.md` § Pull Requests, `integrations/source-control-providers.md` (capability matrix, command inventory, self-hosted setup), `architecture/rpc-and-orchestration.md`, `architecture/worktree-catalog.md`, `architecture/overview.md`, `user/keybindings.md`, `testing/*` runbooks and report template, `docs/plans/README.md`, `README.md` |

## Key deviations from the plan

1. **GitHub milestone ids** are the milestone number (resolved to the title before `gh pr edit --milestone`), not the title as the phase note first said (tasks.md Phase 07 ruling 4).
2. **GitHub auto-merge + bypass** cannot be combined: `gh pr merge` rejects `--auto` with `--admin`; the server answers `invalid_request` and the merge box disables one while the other is selected (Phase 07 round 1).
3. **GitLab REST merge body** sends both `auto_merge` and the deprecated `merge_when_pipeline_succeeds` (GitLab ORs them; 17.11 deprecation) (Phase 07 round 1).
4. **GitLab immediate CLI merges pass `--auto-merge=false`** because the installed `glab` defaults auto-merge to true (Phase 07 ruling 7).
5. **Per-PR serialization** is a service-level gate keyed by provider/host/repository/number held across the fresh read and the mutation, not the cwd-keyed local scheduler (Phase 07 ruling 10).
6. **Checkout write phase is shielded**: after guards and branch planning, the CLI checkout / fetch / managed creation run under an independent token with a 24-hour per-command ceiling and keep the project lock and availability admission; client cancellation only stops the wait (Phase 09 round 1, after a live data-loss finding).
7. **Occupied-branch naming**: a matching branch checked out elsewhere counts as a collision → `<head>-pr-<n>` (Phase 09 round 2).
8. **Effect stream atoms keep `waiting: true`** until the stream ends; the Pull Requests and Git Manager toolbars now show "Loading worktrees…" only while no catalog data exists (Phase 09 round 2; fixes a pre-existing Git Manager symptom).
9. **Title/description/base edits have no Undo** (Save + retained drafts + base confirmation); five-second Undo covers reviewer/assignee/label/milestone/lock/draft changes (Phase 10 ruling).
10. **GitLab `glab mr list` has no `--state`**; tabs map to `--closed`/`--merged`/`--all` (spec correction before Phase 01).

## TODOs / known limitations left in code

- **GitLab end-to-end verification pending**: needs a GitLab host with an authenticated `glab` (company server or a gitlab.com token). All GitLab GraphQL documents were validated against gitlab.com's schema and every GitLab command shape against the installed `glab` 1.114.0, but no live GitLab read or write ran. `tasks.md` keeps Phase 10 `in_progress` with "GitLab e2e pending: needs a GitLab host with an authenticated `glab`".
- **Live host writes not exercised**: comment/edit/react/delete, label with undo, milestone, lock, merge, revert and GitLab delete were verified only through exact-command tests and read-only browser checks (controls, confirmations, disabled reasons). They need a repository the requester designates for writes.
- GitLab review-status list filters return advice to clear the filter (list data lacks approvals); GitHub search results have no total count or further page; GitLab multi-line review drafts post at the end line.
- Three pre-existing `provider_terminal` timing tests (`codex::…still_reaps_the_child`, `opencode::…transfers_exact_child…`, `opencode::…retained_child_true_reap`) can fail in the full `-j 2` server run and pass individually; their files are untouched by this work.
- Native Windows private-file ACL path and native desktop packaged e2e were not executed here (typechecked only).

## How to verify before merging

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo test -p bibcode-server --lib pull_requests -j 2
cargo test -p bibcode-server --test pull_requests_context_list --test pull_requests_detail_reads \
  --test pull_requests_review_actions --test pull_requests_edit_merge_actions \
  --test pull_requests_checkout --test rpc_wire -j 2
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures && git diff --stat packages/contracts/fixtures
vp test run apps/web/src/components/pullRequests apps/web/src/components/gitManager apps/web/src/state
vp run typecheck && vp check
vp run test          # whole graph; see the provider_terminal note above
```

Browser checks (dev server `vp run dev`, web http://localhost:5733, Playwright persistent profile `pw/profile-pr2` in the coordinator scratchpad, scratch clones under `pr-verify/`): `pw/pull-requests-phase02.mjs` (shell, list, settings), `pw/pull-requests-phase06.mjs` (review UI), `pw/pull-requests-phase08.mjs` (editors, pickers, merge box, menu; read-only), `pw/pull-requests-phase09.mjs` (checkout; `MODE=menu|checkout|cancel|worktree`), `pw/e2e-github-readonly.mjs` (list/filters/detail tabs/files/settings). Screenshots: `shots-pr02/`, `shots-pr04/`, `shots-pr06/`, `shots-pr08/`, `shots-pr09/`, `shots-e2e/`.

## Recommended code review order

1. `apps/server/src/pull_requests/permissions.rs` and `model.rs` (permission table, reasons, capabilities)
2. `github/*.rs` and `gitlab/*.rs` adapters (command shapes, GraphQL documents, parsers) with `apps/server/tests/pull_requests_*`
3. `pull_requests/mod.rs` (service, pre-checks, per-PR gate) and `checkout.rs`; `production/pull_requests_rpc.rs`
4. `packages/contracts/src/pullRequests.ts` and fixtures
5. `packages/client-runtime` atoms, `apps/web/src/state/pullRequests.ts`, `pullRequestsStore.ts`
6. `components/pullRequests/PullRequestsPanel.tsx`, `list/*`, `detail/*`
7. `review/*`, `usePullRequestsAction.ts`
8. `edit/*` (editors, pickers, merge controls, secondary actions, undo)
9. `PullRequestsCheckoutMenu.tsx`, `useRunPullRequestsCheckout.ts`
10. Docs listed above

## Open questions for the reviewer

1. Which repository may be used for live write acceptance (comment, label + undo, milestone, lock, merge, revert; GitLab delete)?
2. Which GitLab host and account should run the GitLab end-to-end pass?
3. Should the iteration be committed as one commit per accepted phase or as a single feature commit (both need the task-resume commit body)?
