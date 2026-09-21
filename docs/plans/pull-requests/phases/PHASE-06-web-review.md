# Pull Requests / Phase 06 — Web: comments, reactions, threads, inline review, suggestions

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session (Playwright, `vercel-react-best-practices`, `UI.md`). Tick checkboxes as you go. Red → green.

**Goal:** Turn the read-only detail into a review surface: comment box with preview, edit/delete/minimize own comments, reactions, thread replies and resolve, inline comments from the diff gutter (single and multi-line) collected into a pending review, the review popover (Comment / Approve / Request changes; GitLab Revoke approval / Remove my change request), suggestion blocks with "insert suggestion" and Apply (GitLab), partial-failure handling, and draft preservation.

**Architecture:** All writes go through `pullRequestsEnvironment.runAction` (a command atom); after success the view calls `refresh()` on `get` and on the affected tab query. Pending inline comments live in the store draft (`pendingReview`) keyed by PR number so they survive navigation and reload. `PullRequestsFileDiff` gains real `onLineClick`/`onLineRangeSelect` handlers that open an inline composer anchored under the line.

**Tech Stack:** React 19, `@base-ui/react` Popover/Menu/Dialog, `react-markdown` preview, `@pierre/diffs` line hooks, zustand store, Vitest.

---

## Files

- **Create:** `apps/web/src/components/pullRequests/review/PullRequestsCommentBox.tsx`, `PullRequestsCommentActions.tsx`, `PullRequestsInlineComposer.tsx`, `PullRequestsReviewPopover.tsx`, `PullRequestsPendingReviewBar.tsx`, `inlineCommentGutter.logic.ts`, `pendingReview.logic.ts` (+ tests)
- **Modify:** `shared/PullRequestsReactions.tsx` (toggle), `shared/PullRequestsSuggestionBlock.tsx` (Apply), `detail/PullRequestsConversation.tsx`, `detail/PullRequestsTimelineItem.tsx`, `detail/PullRequestsFiles.tsx`, `detail/PullRequestsFileDiff.tsx`, `detail/PullRequestsDetailView.tsx`
- **Create:** `apps/web/src/components/pullRequests/usePullRequestsAction.ts` + test — `useRunPullRequestsAction(scope, number)` returning `{ run(action), pending, error }` with toast on error and the refresh policy
- **Modify:** `apps/web/src/pullRequestsStore.ts` — `commentEdits`, `pendingReview` already exist; add `replyDrafts: Record<string, string>` if missing

## Dependencies

- Phase 04, Phase 05.

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator.

## Risk / Effort

Risk: Medium-High (gutter interactions, partial failure UX). Effort: ~8 h.

---

## Discipline

- `AGENTS.md`, `UI.md`: preserve user work (drafts survive failure, navigation, reload); destructive actions (delete comment) confirm; errors are actionable and keep the draft.
- No optimistic cache writes; refresh after success.
- Every action control uses `PullRequestsPermissionButton` with the server permission.

## Documents to Read

- `pull-requests-spec.md` § 8.2 Conversation/Files, § 8.3 reviewing, § 9 draft preservation and errors
- `pull-requests-plan.md` § Client, § Contracts (Actions, `PullRequestsActionResult`)
- `tasks.md` Phase 05 notes (id prefixes), Phase 04 notes (`PullRequestsFileDiff` hooks, `diffRefs`)
- `apps/web/src/components/gitManager/staging/*` for gutter selection precedent (line/hunk selection UI)

---

## Pre-execution check

- [x] **Step 06.0: Claim the phase** (`codex-06`).

## Atomic steps

- [x] **Step 06.1: Action hook test first.** `usePullRequestsAction.test.tsx`: `run({ action: "comment", body })` calls the mocked `runAction` command with `{ cwd, number, action, body }`, then calls `refreshGet` and `refreshTimeline`; on `PullRequestsOperationError` it surfaces `message` in a toast and rethrows so callers keep drafts. Refresh policy table (in the hook): comment/editComment/deleteComment/minimizeComment/react/replyThread/resolveThread → get + timeline; submitReview → get + timeline + files; revokeApproval/removeOwnChangeRequest/dismissReview/rerequestReview → get + timeline; applySuggestions → get + timeline + files + commits. Implement with `useAtomCommand`-style API the repo uses for `gitManagerEnvironment.commit` (copy the pattern from `GitManagerChangesView`/commit box).

- [x] **Step 06.2: Comment box.** `PullRequestsCommentBox` props `{ permission, draft, onDraftChange, onSubmit(body) }`: textarea (auto-grow, `Ctrl/Cmd+Enter` submits), Write/Preview tabs (preview via `PullRequestsMarkdown`), "Comment" primary through `PullRequestsPermissionButton`. Draft bound to `store.setCommentDraft`; cleared only on success. Tests: draft persists across unmount; failure keeps text; permission reason shown.

- [x] **Step 06.3: Comment actions.** `PullRequestsCommentActions` (kebab on each comment/thread comment): Edit (own, → inline textarea with Save/Cancel, draft in `commentEdits[id]`), Delete (own, confirm dialog "Delete this comment? This cannot be undone on <host>."), Minimize/Unminimize (GitHub, `permissions.minimizeComment`), Copy link, Open on host. Reactions bar: `PullRequestsReactions` becomes interactive — an emoji picker with the eight contents; clicking toggles via `react { targetId, content, on }` (targetId null for the PR description). Tests for each.

- [x] **Step 06.4: Threads.** Reply composer under each thread (draft in `replyDrafts[threadId]`), Resolve/Unresolve button (`permissions.resolveThreads` && `thread.canResolve`), outdated badge stays. Tests.

- [x] **Step 06.5: Gutter + inline composer.** `inlineCommentGutter.logic.ts`: `beginSelection(path, line, side)`, `extendSelection(line)`, `selectionRange()` → `{ path, startLine, line, side }` (normalised so `startLine <= line`; a single click is a single line). Wire `PullRequestsFileDiff`'s `onLineClick`/`onLineRangeSelect` (from Phase 04) to open `PullRequestsInlineComposer` anchored under the last selected line: textarea, "Insert suggestion" button (wraps the selected source lines in a ` ```suggestion ` fence pre-filled with the current lines from the patch), "Add review comment" (adds to `pendingReview` in the store with a generated id), "Add single comment" (submits `submitReview { event: comment, comments: [one], body: null }` immediately). Pending comments render inline in the diff as amber cards with Edit/Remove. Existing thread comments render anchored under their lines too (read from timeline threads by `path`+`line`). Tests: click → composer; shift-drag → range; suggestion insert text; pending card persisted in store.

- [x] **Step 06.6: Pending review bar + popover.** `PullRequestsPendingReviewBar` (sticky at the top of Files and Conversation): "Review · N pending comments" → opens `PullRequestsReviewPopover`: body textarea, radio Comment / Approve / Request changes (each through the corresponding permission; labels from vocabulary), GitLab extras: "Revoke approval" (when `permissions.revokeApproval.allowed`) and "Remove my change request" (when `removeOwnChangeRequest.allowed`) as separate buttons, Submit. Submit calls `submitReview { event, body, headSha: detail.headSha, comments: pending }`; result `reviewSubmitted`: `failed.length === 0` → clear pending + toast "Review submitted"; else keep exactly the failed ones in `pendingReview` (match by path+line+body), toast "N of M comments could not be posted" listing the host messages, and keep the popover open. `stale_head` error → toast "The pull request changed since you loaded it — refresh and review the new commits" with a Refresh action. Tests for both partial-failure paths.

- [x] **Step 06.7: Suggestions.** `PullRequestsSuggestionBlock` gets Apply (GitLab; `permissions.applySuggestion`) → `applySuggestions { suggestionIds: [id], commitMessage: null }` with an optional commit-message popover; a "Apply N selected" batch action in the Files tab header when several suggestion checkboxes are ticked. On GitHub the block shows the reason text from the permission (no public API) and a Copy button. Tests.

- [x] **Step 06.8: Dismiss / re-request.** On `review` items with `canDismiss`: "Dismiss review" → dialog with a required message → `dismissReview { reviewId, message }`. In the side column reviewers list: "Re-request" icon per reviewer with `canRerequest` → `rerequestReview { login }` (this is the only side-column write this phase). Tests.

- [x] **Step 06.9: Gate.**

  ```bash
  vp test run apps/web/src/components/pullRequests apps/web/src/pullRequestsStore.test.ts
  vp run typecheck
  vp check
  ```

- [x] **Step 06.10: TDD proof.** Clear the draft before the action resolves; the "failure keeps text" test fails. Drop the failed-comment filtering; the partial-failure test fails. Restore.

- [x] **Step 06.11: Mark complete** in `tasks.md`.

---

## Verification (coordinator, Playwright on a throwaway PR in `mubeda/BibCode`)

- [x] Post a comment, edit it, react 👍, remove the reaction, delete it (confirm dialog); each step refreshes the timeline without a page reload.
- [x] Add two inline comments (one multi-line with a suggestion), see the pending bar, submit as Comment; both appear as threads; resolve one; reply to the other.
- [x] Approve is disabled with "You cannot approve your own pull request" on the user's own PR; Request changes likewise.
- [x] Reload mid-draft: comment text and pending inline comments are still there.
- [x] Simulate a failure (stub `gh` returning 422 through `GH_PATH`-style override on the dev server, or by editing the PR head from the CLI before submitting): the draft stays and the toast is actionable.
- [x] No `<img>`, no extra network; `vercel-react-best-practices` and `UI.md` reviews recorded; gates green.

## Notes for downstream phases

- `useRunPullRequestsAction` is the single write path; Phase 08/09 extend its refresh table.
- The pending review shape is `PendingInlineComment` from the store; Phase 08 does not touch it.
- Inline composer anchors use `path + line + side`; Phase 08's base-branch change must clear pending comments (they no longer anchor) with a confirmation.
