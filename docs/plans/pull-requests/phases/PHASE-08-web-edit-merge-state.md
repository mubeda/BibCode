# Pull Requests / Phase 08 — Web: editing, side-column pickers, merge box, secondary actions

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session (Playwright, `vercel-react-best-practices`, `UI.md`). Tick checkboxes as you go. Red → green.

**Goal:** Make every remaining control on the detail page real: in-place title and description editing, base-branch picker, reviewers/assignees/labels/milestone pickers with a five-second undo toast, lock/unlock, the merge box (method, subject/body, delete branch, auto-merge enable/disable, Merge, bypass with confirmation, Update branch / Rebase), Mark ready / Convert to draft, Close / Reopen, Delete (GitLab, confirm), Revert (navigate to the new PR).

**Architecture:** Same write path as Phase 06 (`useRunPullRequestsAction`) with the refresh table extended. Pickers load `getVocabulary` lazily on open and search server-side when `truncated`. Undo is implemented as the inverse action queued behind a 5 s toast; the inverse runs only if the user clicks Undo. Merge subject/body and title/body edits are store drafts.

**Tech Stack:** React 19, `@base-ui/react` Dialog/Menu/Combobox (or the repo's existing combobox), Vitest.

---

## Files

- **Create:** `apps/web/src/components/pullRequests/edit/PullRequestsTitleEditor.tsx`, `PullRequestsBodyEditor.tsx`, `PullRequestsPicker.tsx` (generic multi/single select over vocabulary), `PullRequestsBaseBranchPicker.tsx`, `undoToast.logic.ts` (+ tests)
- **Modify:** `detail/PullRequestsHeader.tsx` (title edit, base picker, overflow menu), `detail/PullRequestsSideColumn.tsx` (pickers), `detail/PullRequestsMergeBox.tsx` (controls), `detail/PullRequestsConversation.tsx` (description edit), `usePullRequestsAction.ts` (refresh table)
- **Modify:** `apps/web/src/pullRequestsStore.ts` — `titleEdit`, `bodyEdit`, `mergeSubject`, `mergeBody` already exist

## Dependencies

- Phase 06, Phase 07.

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator.

## Risk / Effort

Risk: Medium-High (merge UX, confirmations). Effort: ~7 h.

---

## Discipline

- `AGENTS.md`, `UI.md`: confirm only destructive or hard-to-undo actions (merge bypass, delete, revert, close on someone else's PR? no — close is reversible, no confirm), make metadata edits recoverable with undo, keep primary actions distinct, disabled states explain themselves.
- Merge confirmation dialog states exactly what will happen: method, target branch, delete-branch, auto-merge, bypass wording.
- Changing the base branch clears pending inline comments after a confirmation (they no longer anchor).

## Documents to Read

- `pull-requests-spec.md` § 8.2 header/side column/merge box, § 8.4 editing, § 8.6 revert and delete, § 9 undo and errors
- `tasks.md` Phase 07 notes (result kinds, milestone id decision)

---

## Pre-execution check

- [x] **Step 08.0: Claim the phase** (`codex-08`).

## Atomic steps

- [x] **Step 08.1: Undo logic test first.** `undoToast.logic.ts`: `inverseOf(action)` → for `setLabels {add, remove}` returns `setLabels {add: remove, remove: add}`; same for reviewers/assignees; `setMilestone {milestoneId}` → previous id; `lock` ↔ `unlock`; `setDraft` ↔ inverse; others → null (no undo). `scheduleUndo(run, inverse, toast)`: shows a toast with an Undo button for 5 s; Undo runs the inverse. Tests: inverse mapping table; Undo triggers exactly once; expiry does nothing.

- [x] **Step 08.2: Refresh table.** Extend the hook: editPullRequest → get + timeline; setReviewers/Assignees/Labels/Milestone → get; lock/unlock → get; updateBranch → get + commits + checks + files; merge → get + timeline + commits; disableAutoMerge → get; setDraft/close/reopen → get + timeline; delete → navigate to the list; revert → navigate to the new number.

- [x] **Step 08.3: Title and description editors.** Pencil next to the title (`permissions.editPullRequest`) → inline input with Save/Cancel (draft `titleEdit`); description "Edit" → `PullRequestsBodyEditor` (textarea + preview, draft `bodyEdit`) → `editPullRequest { title|body }`. Escape cancels and keeps the draft; Save clears it on success. Tests.

- [x] **Step 08.4: Base branch picker.** In the header, the base chip becomes a `PullRequestsBaseBranchPicker` when `editPullRequest.allowed`: combobox over `getVocabulary { kind: "branches", query }`; choosing a branch → confirm if `pendingReview.length > 0` ("Changing the base clears N pending review comments") → `editPullRequest { baseBranch }` → clear pending. Tests.

- [x] **Step 08.5: Side-column pickers.** `PullRequestsPicker` props `{ kind: "users"|"labels"|"milestones", multiple, selected, permission, onChange(add, remove) }`: opens on the pencil, loads vocabulary lazily, filters client-side, server search when `truncated` (debounced 300 ms), checkboxes for multiple, radio for milestone, "Clear" for milestone. Applying sends `setReviewers|setAssignees|setLabels|setMilestone` and schedules the undo toast (`"Added 2 labels — Undo"`). Reviewers picker excludes the PR author. Tests.

- [x] **Step 08.6: Merge box controls.** Method `Select` over `permissions.merge.methods` (hidden when one method; GitLab shows the project method as text since `mergeMethodsSource == project_setting`), subject/body fields (draft `mergeSubject`/`mergeBody`; prefilled: subject `"<title> (#N)"` for merge/squash on GitHub, empty for rebase; GitLab default from the project convention "Merge branch 'x' into 'y'" — leave empty and let the host default when blank), "Delete branch after merge" checkbox (default `deleteBranchDefault`), auto-merge checkbox labelled `capabilities.autoMergeLabel` (enabled when `permissions.enableAutoMerge.allowed`), the primary Merge button (`permissions.merge`) → confirmation dialog listing method, target, delete-branch, auto-merge → `merge { method, deleteBranch, auto, bypass: false, headSha, subject, body }`. Result `merged` → toast "Merged" / "Auto-merge enabled"; error `stale_head` → toast with Refresh. Bypass secondary action (`permissions.mergeBypass`) with its own confirmation that names what is bypassed ("Merge without waiting for requirements" / "Merge despite requested changes"). "Disable auto-merge" when `readiness.autoMerge.enabled`. "Update branch" split (merge / rebase per `updateBranch.methods`) or "Rebase" (+ "Skip CI" checkbox on GitLab) when `readiness.status == behind`. Tests for each state and for the confirmation text.

- [x] **Step 08.7: Overflow menu.** Mark ready / Convert to draft (`markReady`/`convertToDraft`), Lock (GitHub: reason submenu from `capabilities.lockReasons`) / Unlock, Close / Reopen, Revert (merged only; confirm "This creates a new pull request that reverts #N") → navigate to `pullRequestCreated.number`, Delete (GitLab; `capabilities.deletePullRequest`; confirm with the MR number and "This cannot be undone on <host>") → navigate to the list, Copy URL, Open in browser. Each item through the permission with reason. Tests.

- [x] **Step 08.8: Gate.**

  ```bash
  vp test run apps/web/src/components/pullRequests
  vp run typecheck
  vp check
  ```

- [x] **Step 08.9: TDD proof.** Remove the head SHA from the merge request; the merge test fails. Make Undo run on expiry; the undo test fails. Restore.

- [x] **Step 08.10: Mark complete** in `tasks.md`.

---

## Verification (coordinator, Playwright on a throwaway PR in `mubeda/BibCode`)

- [x] Edit title and description; add and undo a label; assign and unassign self; set and clear a milestone; lock with a reason and unlock.
- [x] Merge box: on the throwaway PR (own repo, admin) the method select lists three methods; the confirmation names the target; merging with "Delete branch" merges and refreshes to the Merged state; Revert creates a new PR and navigates to it; close/reopen the revert PR; convert to draft and back.
- [x] On `openai/codex` #35882 every write control is disabled with the server reason; the bypass action is absent.
- [x] Drafts survive reload; `vercel-react-best-practices` and `UI.md` reviews recorded; gates green.

## Notes for downstream phases

- Phase 09 adds the Checkout split button to the header next to Open in browser and "Open Git Manager there" after success; it does not touch the merge box.
- Phase 10 documents the confirmation wording and the undo behaviour in `docs/user/workspace-ui.md`.
