# Pull Requests / Phase 04 — Web: read-only detail view

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session (Playwright, `vercel-react-best-practices`, `UI.md`). Tick checkboxes as you go. Red → green.

**Goal:** Render a pull request the way the host's page does: header, four tabs (Conversation, Commits, Checks/Pipelines, Files changed/Changes) with counts, the side column, the merge box in every readiness state, markdown with remote images turned into links, and diffs through `@pierre/diffs`. No mutations yet: every action control renders disabled with its server reason or is absent until Phase 06/08.

**Architecture:** `PullRequestsDetailView` mounts `get` immediately and each tab's query only when that tab is shown (`getTimeline`, `getCommits`, `getChecks`, `getFiles`). The active tab lives in the route search param. `PullRequestsMarkdown` wraps `react-markdown` with the existing sanitiser schema from `ChatMarkdown.tsx` plus an `img` component that renders a link. Diffs reuse `FileDiff` and the Git Manager size ladder. Everything is memoised per item id + `updatedAt`.

**Tech Stack:** React 19, `react-markdown` + `remark-gfm` + `rehype-sanitize`, `@pierre/diffs/react`, `@base-ui/react` Tabs, `@legendapp/list`, `lucide-react`, Vitest.

---

## Files

- **Create:** `apps/web/src/components/pullRequests/detail/PullRequestsDetailView.tsx`, `PullRequestsHeader.tsx`, `PullRequestsSideColumn.tsx`, `PullRequestsConversation.tsx`, `PullRequestsTimelineItem.tsx`, `PullRequestsCommits.tsx`, `PullRequestsChecks.tsx`, `PullRequestsFiles.tsx`, `PullRequestsFileDiff.tsx`, `PullRequestsMergeBox.tsx`, `pullRequestsDetail.logic.ts` (+ `.test.tsx`/`.test.ts` each)
- **Create:** `apps/web/src/components/pullRequests/shared/PullRequestsMarkdown.tsx` + test, `PullRequestsReactions.tsx` (read-only this phase) + test, `PullRequestsPermissionButton.tsx` + test, `PullRequestsSuggestionBlock.tsx` + test
- **Modify:** `apps/web/src/components/pullRequests/PullRequestsPanel.tsx` — mount the detail view for `number`
- **Modify:** `apps/web/src/pullRequestsStore.ts` — nothing new expected; `viewedFiles` already exists

## Dependencies

- Phase 02 (shell, store, shared components), Phase 03 (server reads).

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator.

## Risk / Effort

Risk: Medium-High (diff rendering, markdown sanitising, many states). Effort: ~8 h.

---

## Discipline

- `AGENTS.md`, `UI.md`. Every disabled control carries its reason (`title` + visually hidden `aria-describedby` span, like `GitManagerPanel.tsx:844-866`).
- No `<img>` reaches the DOM from host content; no avatar; no `fetch`; no timer.
- Copy from `context.capabilities.vocabulary`.
- Large lists (timeline, files) virtualised; diffs mount lazily when scrolled into view (IntersectionObserver).

## Documents to Read

- `pull-requests-spec.md` § 8.2 detail, § 9 behaviour, § 11 client performance, § 12 zero telemetry
- `pull-requests-plan.md` § Client
- `apps/web/src/components/ChatMarkdown.tsx` (sanitiser schema at ~:157, `urlTransform`), `apps/web/src/components/gitManager/history/GitManagerCommitDetail.tsx` (FileDiff usage), `history/diffLadder.ts`, `GitManagerPullRequestPanel.tsx` (checks rows)
- Reference screenshots the coordinator captured: GitHub conversation/files, GitLab overview/changes (ask the coordinator through `tasks.md` if you need them)

---

## Pre-execution check

- [x] **Step 04.0: Claim the phase** (`codex-04`).

## Atomic steps

- [x] **Step 04.1: Markdown test first.** `PullRequestsMarkdown.test.tsx`: renders GFM tables and task lists; a remote image `![shot](https://user-images.githubusercontent.com/x.png)` renders an `<a>` with text `image: shot — open in browser` and **no** `<img>`; a `<script>` is stripped; links get `rel="noreferrer"` and open through `shell.openExternal` on click (mock `useLocalApi`/the existing hook). Implement with `react-markdown`, `remarkGfm`, `rehypeSanitize` using the schema exported from `ChatMarkdown.tsx` (export it if it is module-private; do not copy it) and `components={{ img: ImageAsLink, a: ExternalLink }}`. Memo on `text`.

- [x] **Step 04.2: Permission button.** `PullRequestsPermissionButton` props `{ permission: PullRequestsPermission; onClick; children; variant?; size? }` → `<Button disabled={!permission.allowed} title={permission.reason ?? undefined} aria-describedby={id}>` + `<span id={id} className="sr-only">{permission.reason}</span>` when not allowed. Test: disabled button exposes the reason to assistive tech.

- [x] **Step 04.3: Detail logic tests.** `pullRequestsDetail.logic.ts`: `headerSentence(detail, vocabulary)` ("mubeda wants to merge 3 commits into main from feature" / "requested to merge feature into main"), `readinessPresentation(readiness, vocabulary)` → `{ tone: "success"|"warning"|"danger"|"neutral", title, lines }`, `groupTimeline(items)` (stable sort by createdAt, threads keep comment order), `checksSummaryLabel(checks)`, `fileTree(files)` (folder grouping like Source Control's folder rows). Tests for each with fixtures typed from contracts.

- [x] **Step 04.4: Detail view.** `PullRequestsDetailView` props `{ scope, projectRef, context, number, tab }`. Mount `get`; pending → skeleton with the number; error → the unavailable/error component with Retry; data → `PullRequestsHeader` + `Tabs` (values `conversation|commits|checks|files`, labels from vocabulary, counts from `tabCounts`; changing a tab navigates with `search: { tab }` replace) + panels that mount their own query only when active; `PullRequestsSideColumn` on the right (hidden under 1024 px, then rendered above the merge box). Refresh button refreshes `get` and the active tab's query. Store `lastNumber` on mount.

- [x] **Step 04.5: Header.** Title (`h1`), `#N`/`!N`, state pill (Open / Draft / Merged / Closed with the host colours), the header sentence with branch chips (copy button on head branch), fork marker `"from a fork"` when cross-repository, "Open in browser" (`shell.openExternal`), a Checkout button placeholder (disabled with reason "Checkout arrives in a later build" — Phase 09 replaces), Refresh. Overflow menu placeholder listing the secondary actions as disabled items with reasons from `permissions` (Phase 08 enables).

- [x] **Step 04.6: Conversation.** Description block (`PullRequestsMarkdown`, author, createdAt, "Edit" placeholder disabled with reason). Then `getTimeline` virtualised list of `PullRequestsTimelineItem`: `comment` (actor initials, login, relative time, "edited" marker, body, reactions read-only, minimized → collapsed with "Show comment"), `review` (state icon + "approved these changes" / "requested changes" / "commented", body), `thread` (path + line header linking to the Files tab with `?tab=files#file=<path>`, `diffHunk` rendered in a `<pre>` mono block, comments, resolved/outdated badges; suggestion blocks via `PullRequestsSuggestionBlock` showing from/to lines as a mini diff with "Apply" placeholder disabled by `permissions.applySuggestion`), `event` (one-line system row with icon). Comment box placeholder at the end: a disabled textarea with the reason from `permissions.comment` (Phase 06 enables). `truncated` → a note "Older activity is on the host page" with the link.

- [x] **Step 04.7: Side column.** Sections Reviewers (state icon per reviewer: unreviewed grey dot, commented speech icon, approved green check, changes_requested red x, dismissed strike), Assignees, Labels (chips), Milestone, Linked issues (links), Approval rules (GitLab: `x of y` per rule with names). Each section header shows an "Edit" pencil rendered through `PullRequestsPermissionButton` with the matching permission — disabled this phase (Phase 08 wires it).

- [x] **Step 04.8: Commits tab.** `getCommits` list: short sha (mono, copy), subject, author initials + login, relative date, link to `url` via `shell.openExternal`.

- [x] **Step 04.9: Checks tab.** `getChecks` groups → collapsible group headers with counts, rows with state icon, name, duration, link. Empty → "No checks reported" / "No pipeline for this merge request" (vocabulary). `pipelineUrl` link at the top for GitLab.

- [x] **Step 04.10: Files tab.** Left tree (`fileTree`), each file row: change icon, path, `+a −d`, "Viewed" checkbox bound to the store (`toggleViewedFile`), click scrolls to the file. Right: `PullRequestsFileDiff` per file, rendered lazily (IntersectionObserver, root margin 600 px), header with path + stats + "Viewed", body: `FileDiff` from `@pierre/diffs/react` with `classifyDiffPayload` (size ladder: over the parse cap → "Diff too large to render — open on host"; long lines → plain text), `tooLarge` → the host link, `binary` → "Binary file". Whitespace toggle in the tab header (`diffIgnoreWhitespace` client setting is the existing precedent; reuse it). Anchor support: `#file=<path>` selects and scrolls.

- [x] **Step 04.11: Merge box.** `PullRequestsMergeBox` props `{ detail, context }`. Renders `readinessPresentation` (icon, title, lines) and, this phase, the merge controls disabled through `permissions.merge` (method select listing `permissions.merge.methods`, default `defaultMethod`; delete-branch checkbox default `deleteBranchDefault`; auto-merge toggle labelled by `capabilities.autoMergeLabel`), the primary Merge button disabled with its reason, and the bypass secondary action only when `permissions.mergeBypass.allowed`. Merged state shows "Merged by <login> <time>" and a Revert placeholder; closed shows "Closed". Conflicts state text points to Checkout.

- [x] **Step 04.12: Tests.** Failing-first per component: header sentence for both hosts; tabs mount only the active query (assert mocked atoms called); markdown image → link; timeline renders each kind; thread link goes to files tab anchor; suggestion block renders from/to; side column shows approval rules for GitLab only; checks group and summary; files tree, viewed toggle persists in store, lazy diff mounts on intersection (mock `IntersectionObserver`), tooLarge shows host link; merge box renders each readiness status with tone and lines; every disabled control has `title` and sr-only reason.

- [x] **Step 04.13: Gate.**

  ```bash
  vp test run apps/web/src/components/pullRequests
  vp run typecheck
  vp check
  ```

- [x] **Step 04.14: TDD proof.** Remove the `img` component override; the markdown test fails. Make every tab mount its query eagerly; the lazy-mount test fails. Restore.

- [x] **Step 04.15: Mark complete** in `tasks.md` (component props, anchor format, any contract field you needed and did not have — report, do not add silently).

---

## Verification (coordinator, Playwright against `mubeda/BibCode` #14 and an open PR; `openai/codex` #35882 for the read-only case)

- [x] Detail route renders header, tabs with counts, side column, merge box; reload keeps `?tab=files`.
- [x] Conversation shows comments, reviews, a thread with a line comment and its hunk, system events; no `<img>`; remote images are links.
- [x] Files tab renders real diffs through `FileDiff`; Viewed checkbox persists across reload; large/binary files degrade correctly.
- [x] Checks tab groups by workflow with states; GitLab (fixture via a stubbed `glab` on the dev server, if the coordinator provides one) groups by stage.
- [x] Merge box shows `review_required` with "1 approving review required" on the read-only repo and `merged` on #14; every disabled control has a reason on hover and for screen readers.
- [x] No network requests besides the RPC socket; no timers (Playwright: `page.evaluate(() => performance.getEntriesByType("resource").length)` stable across 60 s idle).
- [x] `vercel-react-best-practices` and `UI.md` reviews recorded; `vp check`, `vp run typecheck`, tests green.

## Notes for downstream phases

- `PullRequestsDetailView` owns the tab queries; Phase 06/08 add mutation calls through `pullRequestsEnvironment.runAction` and then call the relevant query's `refresh()` (get + the affected tab) — never optimistic writes to the query cache.
- Placeholders to replace: Checkout button (Phase 09), overflow menu items (Phase 08), comment box and Apply (Phase 06), side-column Edit pencils (Phase 08), merge controls (Phase 08).
- `PullRequestsFileDiff` exposes `onLineClick(path, line, side)` and `onLineRangeSelect(path, startLine, line, side)` props (no-ops this phase) for Phase 06's inline comments.
- The files query result's `diffRefs` must be passed to Phase 06's pending-review submission.
