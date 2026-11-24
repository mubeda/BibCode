# Phase 5: View PR opens the PR panel

- Goal: The View PR / View MR button in Source Control opens BiBCode's own PR/MR panel, the menu keeps a browser entry, with tests.
- Round: 1
- Depends on: none
- Owns: `apps/web/src/components/SourceControlPanel.tsx`, `apps/web/src/components/GitActionsControl.logic.ts`, `apps/web/src/components/SourceControlPrimaryAction.logic.ts`, and their tests
- Must not touch: `apps/web/src/components/gitManager/**`, `apps/web/src/components/gitSignIn/**`, `apps/web/src/components/files/**`, `apps/web/src/components/chat/**`, `apps/web/src/rightPanelStore.ts`, `apps/server/**`
- Skills: tdd (failing test first for the action kinds)
- Read first: issue #400 (the report and acceptance criteria); `UI.md` (a button does what its label says; safe defaults)
- Checkpoint: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/GitActionsControl.logic.test.ts src/components/SourceControlPrimaryAction.logic.test.ts src/components/SourceControlPanel.test.tsx` exits 0; in the app, View PR opens the PR panel and the browser stays closed.

## Tasks

### Task 5.1: Route View PR to the panel and keep a browser menu item

- Satisfies: R16
- Depends on: none
- Files: modify `apps/web/src/components/GitActionsControl.logic.ts`; test `apps/web/src/components/GitActionsControl.logic.test.ts`; modify `apps/web/src/components/SourceControlPrimaryAction.logic.ts` and its test; modify `apps/web/src/components/SourceControlPanel.tsx`; test `apps/web/src/components/SourceControlPanel.test.tsx`
- Interfaces: consumes the action kinds `open_pr` (browser, through `openPullRequestLink`) and `open_pr_panel` (through `useRightPanelStore.getState().openPullRequest(threadRef, { number, provider })`), and `canOpenInPanel` (`SourceControlPanel.tsx:431`, `GitActionsControl.logic.ts:100`); produces no new kind
- Skills: vercel-react-best-practices (required review for the changed components); better-ui (menu labels say where the PR opens)
- Read first: `apps/web/src/components/GitActionsControl.logic.ts:90-180,225-310`; `apps/web/src/components/SourceControlPrimaryAction.logic.ts:90-130` and every place it returns `open_pr`; `apps/web/src/components/SourceControlPanel.tsx:250-260,425-470,1018-1090`; `apps/web/src/components/pullRequests/pullRequestsAvailability.ts:41-52` and `PullRequestPanelSurface.tsx:61-66,91-103` (what the panel needs to show a pull request); `apps/web/src/components/chat/ChatHeaderActions.tsx:184-193` (the chat-header control's trigger is hidden)
- Tier: standard
- TDD: red-green
- Done when: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/GitActionsControl.logic.test.ts src/components/SourceControlPrimaryAction.logic.test.ts src/components/SourceControlPanel.test.tsx` exits 0

Rules for this task

- "The panel can open" means it can show the pull request: combine the existing check (`canOpenPullRequestInPanel`, `SourceControlPanel.tsx:427-437`) with the server capability `pullRequestsReads` that the panel surface requires. On a server without that capability View PR opens the browser. A transient disconnect is not lack of support.
- Add `open_pr_panel` to both primary action types (`GitActionsControl.logic.ts:19-33`, `SourceControlPrimaryAction.logic.ts:28-37`), and give `resolveQuickAction` the panel flag as a parameter.
- Do not edit `GitActionsControl.tsx`: its trigger is hidden in production. If typecheck requires a change there, make the smallest compatibility change, name it in the task report, and tell the executor, because the file is outside this phase's ownership.
- Run the click tests for both action ladders (legacy and staging-area), for GitHub and GitLab wording, and for the browser fallback at component level.

Steps

1. [ ] Write failing tests. Logic: with an open PR and a panel that can show it (the combined flag of the Rules above), the quick action and the primary action labelled "View PR" have kind `open_pr_panel`, and the menu holds one panel-opening item "View PR" and one item "Open PR in browser" of kind `open_pr` (no item named "Open PR in panel"); with `canOpenInPanel` false, the quick and primary actions keep kind `open_pr` and the menu has the single browser item, as today; with GitLab terminology the labels say MR. Panel: clicking View PR calls `openPullRequest` with the PR's number and provider and does not call `openPullRequestLink`; choosing "Open PR in browser" calls `openPullRequestLink` with the PR URL.
2. [ ] Run the Done when command. Expected: FAIL, because View PR still has kind `open_pr`.
3. [ ] Implement: return `open_pr_panel` for the View actions when the panel can open, rename the menu items, handle `open_pr_panel` in `onPrimaryAction` and `onScPrimaryAction` of `SourceControlPanel.tsx`. Update the existing tests that pin "View PR" to `open_pr` only where the rule changed them.
4. [ ] Run the Done when command. Expected: PASS.
5. [ ] Prove the tests can fail: make the logic ignore `canOpenInPanel`, run the Done when command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors. Review the change against `vercel-react-best-practices` and `UI.md`; record both in the task report, with the user-visible text for the phase 4 update of `docs/user/workspace-ui.md`.
