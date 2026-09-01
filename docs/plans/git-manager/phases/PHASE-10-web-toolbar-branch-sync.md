# Git Manager / Phase 10 — Web toolbar, branch dropdown and sync UI

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Complete the Git Manager toolbar — worktree selector, branch dropdown and the push/pull state machine — with the branch lifecycle dialogs and an inline progress banner over PHASE-07's streaming operation RPC.

**Architecture:** This is Slice 3's client half in `git-manager-plan.md` and the toolbar of spec § 5. Segment 1 (worktree selector with repository information) was skeletonised by PHASE-03; segments 2 and 3 land here. The branch dropdown is the reference implementation's plain non-GitHub variant — filter box, Default / Recent / Other grouping, current-branch marker, "New branch", and a "merge into current branch" action at the foot; there is no pull-requests tab. The sync button reproduces the reference push/pull/fetch state machine minus its two "Publish repository" states, which constraint 1 forbids. Every blocked control renders the server-authored `{ operation, code, message }` verbatim; the client derives no git policy. An occupied branch **redirects** the panel to the owning worktree rather than failing, matching what `apps/web/src/components/BranchToolbarBranchSelector.tsx` already does for threads.

**Tech Stack:** React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web. Tailwind CSS 4 + @base-ui/react + lucide-react. Virtualization @legendapp/list; diffs @pierre/diffs. Test: `vp test <path>` (happy-dom, msw). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx` — filterable, grouped, virtualised 30px-row branch list.
- **Create:** `apps/web/src/components/gitManager/toolbar/branchGrouping.ts` — pure Default / Recent / Other grouping and filtering.
- **Create:** `apps/web/src/components/gitManager/toolbar/branchGrouping.test.ts`
- **Create:** `apps/web/src/components/gitManager/toolbar/GitManagerSyncButton.tsx`
- **Create:** `apps/web/src/components/gitManager/toolbar/syncButton.logic.ts` — the pure push/pull/fetch state derivation.
- **Create:** `apps/web/src/components/gitManager/toolbar/syncButton.logic.test.ts`
- **Create:** `apps/web/src/components/gitManager/toolbar/GitManagerOperationBanner.tsx` — inline progress, cancel, collapsible output.
- **Create:** `apps/web/src/components/gitManager/toolbar/GitManagerOperationBanner.test.tsx`
- **Create:** `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.tsx` — create / rename / delete.
- **Create:** `apps/web/src/components/gitManager/dialogs/GitManagerSwitchWithChangesDialog.tsx`
- **Create:** `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.test.tsx`
- **Create:** `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.test.tsx`
- **Modify:** `apps/web/src/components/gitManager/GitManagerToolbar.tsx` — mount segments 2 and 3 into the skeleton PHASE-03 landed (locate the actual filename first).
- **Modify:** `apps/web/src/gitManagerStore.ts` — add the toolbar view-state slice only (branch filter text, open dropdown, selected worktree already owned by PHASE-03).
- **Modify:** `apps/web/src/state/gitManager.ts` — add the operation-stream command wrapper if PHASE-07 did not already export one.

## Dependencies

- Phase 07: Server branch and sync operations (streaming)

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

**Matched for this phase:**

5. `Skill(skill="web-design-guidelines")` — _disabled controls must expose the server reason via tooltip and `aria-describedby`_
6. `Skill(skill="vercel-react-best-practices")` — _keeping the virtualised branch list and the live progress banner from re-rendering the toolbar_

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules.
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 5 (toolbar), § 6.4 (switch with changes), § 7 and § 7.1 (guards and the occupied-branch redirect).
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; the Client section governs atoms, lanes and accessibility.
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 1.3 (branch foldout, create/rename/delete dialogs) and § 2.2 (the exact nine-state push/pull evaluation order).
- `docs/plans/git-manager/research/worktree-checkout-restrictions.md` — § C.2 for the redirect BiBCode already implements, § A for what git refuses.
- `docs/architecture/connection-runtime.md` — reconnect, capability gating, and never dialling a deliberately disconnected environment.
- `docs/reference/scripts.md` — the exact `vp` command names used below.

---

## Pre-execution check

- [ ] **Step 10.0: Claim the phase.** Open `../tasks.md`. Change Phase 10 row → `Status = in_progress`, `Agent = phase-10`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 10.1: Locate the surface area being changed.**

  ```bash
  rg --files apps/web/src/components/gitManager
  rg -n "resolveBranchSelectionTarget" -A 30 apps/web/src/components/BranchToolbar.logic.ts
  rg -n "LegendList" apps/web/src/components/BranchToolbarBranchSelector.tsx
  rg -n "runStackedAction|runStreamInEnvironment|createRuntimeCommand" packages/client-runtime/src/state/vcsAction.ts
  rg -n "GitManagerBlockedReason|GitManagerOperationEvent|GitManagerOperationRequest" packages/contracts/src/gitManager.ts
  ```

  The landed `packages/contracts/src/gitManager.ts` is authoritative for method and field names (`gitManager.runOperation` is the expected stream-command name). `packages/client-runtime/src/state/vcsAction.ts` (indicative :417-520) is the template for consuming a streaming command as an atom command — copy that shape, do not call `runStream` directly from a component. Note that a streaming _command_ joins `EnvironmentStreamCommandRpcTag` (`packages/client-runtime/src/rpc/client.ts`, indicative :60), not the subscription union.

- [ ] **Step 10.2: Author the first failing test.**

  Path: `apps/web/src/components/gitManager/toolbar/syncButton.logic.test.ts`

  ```ts
  import { describe, expect, it } from "vitest";
  import { resolveSyncState } from "./syncButton.logic";

  describe("resolveSyncState", () => {
    it("offers publish-branch when the current branch has no upstream", () => {
      expect(
        resolveSyncState({
          isOperationRunning: false,
          hasRemote: true,
          isUnborn: false,
          isDetached: false,
          aheadBehind: null,
          forcePushRecommended: false,
        }).kind,
      ).toBe("publish-branch");
    });
  });
  ```

- [ ] **Step 10.3: Run the new test; expect FAIL** (the module does not exist yet).

  ```bash
  vp test apps/web/src/components/gitManager/toolbar/syncButton.logic.test.ts
  ```

- [ ] **Step 10.4: Implement the minimum to make Step 10.2 pass.**

  Path: `apps/web/src/components/gitManager/toolbar/syncButton.logic.ts`. Export `resolveSyncState(input)` returning `{ kind, label, ahead, behind, disabledReason }` where `kind` is one of `"running" | "no-remote" | "fetch-unborn" | "detached" | "publish-branch" | "fetch" | "force-push" | "pull" | "push"`, evaluated in exactly that order (research § 2.2). The reference implementation's two "Publish repository" states are replaced by `"no-remote"`, a **disabled, explanatory** state — constraint 1 forbids repository lifecycle, so the button must never offer to publish or create a repository.

- [ ] **Step 10.5: Run the test; expect PASS.**

- [ ] **Step 10.6: Cover the remaining sync states.** One failing test per state before extending the implementation: running (disabled, progress), no-remote, unborn → fetch, detached → disabled, ahead=behind=0 → `Fetch <remote>`, force-push-recommended, behind>0 → `Pull <remote>`, otherwise `Push <remote>`. Assert that `force-push` is only ever reachable when the server reports genuine divergence — never as a default (spec § 5).

- [ ] **Step 10.7: Build the branch grouping, test first.**

  Path: `apps/web/src/components/gitManager/toolbar/branchGrouping.ts`. Export `groupBranches({ refs, recentNames, filter })` returning `{ default: [...], recent: [...], other: [...] }` with the recent group capped at 5 (research § 1.3, `RecentBranchesLimit = 5`), case-insensitive substring filtering, and the current branch marked. It is a **pure re-shaping of server data** — it computes no blocked state and no policy. Tests: the cap, filter behaviour, a branch appearing in exactly one group.

- [ ] **Step 10.8: Build the branch dropdown.**

  Path: `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx`. `LegendList` at fixed 30px rows (spec § 8), a filter box, group headers, a current-branch check mark, a "New branch" action, and a "Choose a branch to merge into <current>" action at the foot. Each row carries the server's `GitManagerBlockedReason[]`: a blocked row is disabled and exposes `message` verbatim through both a tooltip and `aria-describedby`; an **unknown code fails closed** (disabled). A row whose `worktreePath` differs from the selected checkout shows a worktree badge; activating it **switches the panel's selected worktree** and says so, rather than attempting a checkout (spec § 7.1). Tests: the redirect changes the selected worktree and issues no checkout operation; a blocked row renders the server message verbatim; an unknown code is disabled.

- [ ] **Step 10.9: Build the branch dialogs.**

  Path: `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.tsx`. Create (name validation with an immediate duplicate check and a debounced ref-rules check, base = default branch or current branch); Rename (local branches only; **blocked when the branch is held by another worktree** — the server authors that message, spec § 7.2); Delete (confirmation stating it cannot be undone, with an optional "also delete on the remote" checkbox only when the branch exists upstream). Tests: the rename block renders the server message and disables submit; delete requires explicit confirmation.

- [ ] **Step 10.10: Build the switch-with-changes dialog.**

  Path: `apps/web/src/components/gitManager/dialogs/GitManagerSwitchWithChangesDialog.tsx`. Two options: "Leave my changes" (stash) and "Bring my changes". The stash copy must state that an ordinary, visible stash entry is created (spec § 6.3 / § 6.4) — not a hidden marker-scoped one. Test both branches produce the expected operation payload.

- [ ] **Step 10.11: Build the operation banner.**

  Path: `apps/web/src/components/gitManager/toolbar/GitManagerOperationBanner.tsx`. Consumes the `gitManager.runOperation` stream through the atom command: `started` opens the banner with `role="status"`, each `output` event appends to a collapsible output area (collapsed by default), `finished` closes it, `failed` keeps it open with the server message and the stable failure code. A Cancel control aborts the stream, which cancels the child process server-side. Tests: the event sequence drives the banner states; cancel invokes the abort path; the output area is collapsed by default and expandable by keyboard.

- [ ] **Step 10.12: Mount segments 2 and 3.** Wire the dropdown, the sync button, the dialogs and the banner into the toolbar PHASE-03 landed. Server data comes exclusively from the atoms in `apps/web/src/state/gitManager.ts`; operations run through the atom command on the existing per-`(environmentId, cwd)` lane. A raw `request`/`runStream` call from a component is a review rejection.

- [ ] **Step 10.13: Full build + test gate.**

  ```bash
  vp test apps/web/src/components/gitManager/toolbar
  vp test apps/web/src/components/gitManager/dialogs
  vp check
  vp run typecheck
  ```

  Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 10.14: Stack-specific verification.** Launch the app against a repository with a linked worktree. Confirm: selecting an occupied branch switches the panel to that worktree and says so; the sync button walks fetch → publish-branch → push → pull as the repository state changes; a long fetch shows the banner with working cancel; a blocked delete shows the server message. Repeat against a remote-hosted project (spec § 10 requires both).

- [ ] **Step 10.15: TDD proof.** Temporarily make `resolveSyncState` always return `{ kind: "push" }` and make `groupBranches` return every branch in the `other` group. Re-run the two `vp test` paths from Step 10.13 and confirm the state-machine and grouping tests fail. Restore both and re-run.

- [ ] **Step 10.16: Mark phase complete.** Change Phase 10 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This decomposition is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] The sync button implements the nine states in the reference evaluation order, with the two "Publish repository" states replaced by a disabled `no-remote` state; force-push is offered only on genuine divergence.
- [ ] The branch dropdown is the plain non-GitHub variant: no pull-requests tab, no repository switcher, no add/clone/remove affordance anywhere in the toolbar.
- [ ] Selecting an occupied branch switches the panel's selected worktree visibly and issues no checkout; the switch is never silent.
- [ ] Every disabled control renders the server-authored `message` verbatim via tooltip and `aria-describedby`; unknown blocked codes fail closed.
- [ ] The operation banner reflects `started` / `output` / `finished` / `failed`, has a working cancel, and keeps its output area collapsed by default.
- [ ] All new tests green; both `vp test` paths in Step 10.13 pass.
- [ ] `vp check` clean and `vp run typecheck` clean.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counters, remote feature flags, avatar or identity fetches, third-party host contact, and no new dependency in `apps/web/package.json`. The only outbound traffic is the user-initiated git network operation the sync button triggers.
- [ ] Final `git diff` and `git status --short` reviewed for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **`resolveSyncState(input) => { kind, label, ahead, behind, disabledReason }`** in `apps/web/src/components/gitManager/toolbar/syncButton.logic.ts`. **PHASE-16** adds the tags-to-push contribution to `ahead` here rather than in the component.
- **`groupBranches({ refs, recentNames, filter })`** in `./branchGrouping.ts` is the only branch-list shaping function. **PHASE-12** and **PHASE-15** reuse it for their branch pickers.
- **`<GitManagerOperationBanner>`** takes `operation: GitManagerOperationEvent | null` and `onCancel: () => void`. **PHASE-12, PHASE-13 and PHASE-15 must render their operations through this one banner** — the app shows one operation at a time, matching the server's `operation-in-flight` rejection.
- **`<GitManagerBranchDropdown>`** props: `onSelectBranch: (ref: GitManagerRefEntry) => void`, `onSwitchWorktree: (worktreePath: string) => void`, `onCreateBranch: () => void`, `onMergeInto: (ref: GitManagerRefEntry) => void`. Pass stable, memoised callbacks; the list is virtualised.
- **`<GitManagerSwitchWithChangesDialog>`** resolves to `{ strategy: "stash" | "bring" }`. **PHASE-12** reuses the same stash semantics: the stash it creates is an ordinary visible entry.
- **Divergence recorded:** `gitManager.runOperation` is a streaming _command_, so it belongs in `EnvironmentStreamCommandRpcTag`, not `EnvironmentSubscriptionRpcTag`. Consume it via a `createRuntimeCommand` wrapper mirroring `packages/client-runtime/src/state/vcsAction.ts`, never `runStream` from a component.
- **Divergence recorded:** the server captures each git command's output on completion rather than streaming per-line progress, so the banner's output area fills in chunks, not continuously. Design the collapsible area for that and do not add a fake progress percentage.
