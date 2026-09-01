# Git Manager / Phase 08 — Web staging and commit UI

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Turn the Git Manager's Changes tab into a working commit surface — inclusion, commit box, amend, undo-commit and confirmed discard — sharing one commit draft with the existing Source Control panel.

**Architecture:** This is Slice 2's client half in `git-manager-plan.md`. The commit box, options and co-author trailers live in `apps/web/src/components/gitManager/changes/`, driving PHASE-04's standalone commit/undo/discard RPCs through the environment-scoped Effect Atom families and the existing per-`(environmentId, cwd)` mutation lane — never a raw RPC call. Spec decision 12 requires exactly one commit draft per checkout shared with `apps/web/src/components/SourceControlPanel.tsx`, so this phase migrates the existing thread-keyed draft store to a `(environmentId, cwd)`-keyed source of truth and points both surfaces at it.

**Tech Stack:** React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web. Tailwind CSS 4 + @base-ui/react + lucide-react. Virtualization @legendapp/list; diffs @pierre/diffs. Test: `vp test <path>` (happy-dom, msw). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/gitManager/changes/GitManagerCommitBox.tsx` — summary, description, options, co-authors, amend.
- **Create:** `apps/web/src/components/gitManager/changes/commitBox.logic.ts` — pure validation, trailer formatting and button-label derivation.
- **Create:** `apps/web/src/components/gitManager/changes/commitBox.logic.test.ts`
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerCommitBox.test.tsx`
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerUndoCommitStrip.tsx`
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerDiscardDialog.tsx`
- **Create:** `apps/web/src/components/gitManager/changes/GitManagerDiscardDialog.test.tsx`
- **Create:** `apps/web/src/sourceControlDraft.ts` — the shared `(environmentId, cwd)` draft selector/hook consumed by both surfaces.
- **Create:** `apps/web/src/sourceControlDraft.test.ts`
- **Modify:** `apps/web/src/sourceControlPanelStore.ts` — add the cwd-keyed draft slice, bump the persisted version and migrate the existing thread-keyed drafts.
- **Modify:** `apps/web/src/components/SourceControlPanel.tsx` — read and write the shared draft instead of its own thread-keyed one.
- **Modify:** `apps/web/src/components/gitManager/changes/` Changes view landed by PHASE-05 — mount the commit box, the undo strip and the discard confirmations.
- **Modify:** `apps/web/src/state/gitManager.ts` — add the commit / undo-commit / discard action hooks if PHASE-04 did not already export them.

## Dependencies

- Phase 04: Server staging and commit operations
- Phase 05: Web changes view

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium. Effort: ~3 h.

---

## Skills to Invoke (teammate-side)

Invoke these skills via the `Skill` tool BEFORE doing any work. Order matters: always-on first, then matched.

**Always-on (every phase):**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the new tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="web-design-guidelines")` — _destructive confirmations, labels and focus order for discard and undo_
6. `Skill(skill="codebase-design")` — _one draft source of truth shared by two panels without duplicating policy_

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules.
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 6.5 (confirmations) and decision 12 (shared draft).
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; the Client section governs atoms, lanes and shared state.
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 1.1 for the commit box, options, co-authors, amend, undo and discard behaviour contracts.
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 3.4 for the existing panel, draft store and action hooks.
- `docs/architecture/connection-runtime.md` — reconnect and capability-gating behaviour the commit button must tolerate.
- `docs/reference/scripts.md` — the exact `vp` command names used below.

---

## Pre-execution check

- [ ] **Step 08.0: Claim the phase.** Open `../tasks.md`. Change Phase 08 row → `Status = in_progress`, `Agent = phase-08`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 08.1: Locate the surface area being changed.**

  ```bash
  sed -n '1,70p' apps/web/src/sourceControlPanelStore.ts
  rg -n "useSourceControlPanelStore|selectThreadSourceControlDraft" apps/web/src
  rg -n "SourceControlActionScope|useVcsStageAction|useGitStackedAction" apps/web/src/state/sourceControlActions.ts
  rg --files apps/web/src/components/gitManager
  rg -n "commit|undoCommit|discard" apps/web/src/gitManagerStore.ts
  ```

  Two preconditions, each a stop-and-record item in `tasks.md` if it fails:
  1.  The landed `apps/web/src/gitManagerStore.ts` (PHASE-03) must hold **view state only**. If PHASE-03 also cached a commit-message draft in its LRU-2, that duplicate must be removed here — the draft has exactly one home, and two independent drafts for one checkout is the defect spec decision 12 forbids. Coordinate the removal through `tasks.md` before editing PHASE-03's store.
  2.  The commit / undo-commit / discard method names in the landed `packages/contracts/src/gitManager.ts` are authoritative; the names used below are the expected ones.

- [ ] **Step 08.2: Author the first failing test.**

  Path: `apps/web/src/sourceControlDraft.test.ts`

  ```ts
  import { describe, expect, it } from "vitest";
  import { sourceControlDraftKey } from "./sourceControlDraft";

  describe("sourceControlDraftKey", () => {
    it("keys a draft by environment and cwd, so ids cannot collide across environments", () => {
      const a = sourceControlDraftKey({ environmentId: "env-a", cwd: "/repo" });
      const b = sourceControlDraftKey({ environmentId: "env-b", cwd: "/repo" });
      expect(a).not.toEqual(b);
      expect(sourceControlDraftKey({ environmentId: "env-a", cwd: "/repo/" })).toEqual(a);
    });
  });
  ```

- [ ] **Step 08.3: Run the new test; expect FAIL** (the module does not exist yet).

  ```bash
  vp test apps/web/src/sourceControlDraft.test.ts
  ```

- [ ] **Step 08.4: Implement the minimum to make Step 08.2 pass.**

  Path: `apps/web/src/sourceControlDraft.ts`. Export `sourceControlDraftKey({ environmentId, cwd })` returning `` `${environmentId}::${normalizedCwd}` `` with a single trailing-separator normalisation. A bare `cwd` or bare `projectId` key is a review rejection — ids collide across environments.

- [ ] **Step 08.5: Run the test; expect PASS.**

- [ ] **Step 08.6: Migrate the draft store.** In `apps/web/src/sourceControlPanelStore.ts` add `byCwdKey: Record<string, SourceControlDraft>` alongside the existing `byThreadKey`, bump `version` from 1 to 2 under the same persisted name `bibcode:source-control-panel-state:v1`, and add a `migrate` that leaves v1 drafts in place (they are keyed by thread and cannot be re-keyed without a cwd). Add `setCwdMessage`, `clearCwdDraft` and `selectCwdSourceControlDraft`. Test: a v1 persisted payload loads without loss; a v2 payload round-trips; `clearCwdDraft` removes only its own key.

- [ ] **Step 08.7: Point both surfaces at the shared draft.** Export `useSourceControlDraft({ environmentId, cwd })` from `apps/web/src/sourceControlDraft.ts` returning `{ message, setMessage, clear }` over the cwd-keyed slice. Change `apps/web/src/components/SourceControlPanel.tsx` to use it. Test in `apps/web/src/sourceControlDraft.test.ts` that a message written through the hook for `(env, cwd)` is read back by a second consumer of the same scope — this is the one behaviour that proves decision 12.

- [ ] **Step 08.8: Build the commit-box logic, test first.**

  Path: `apps/web/src/components/gitManager/changes/commitBox.logic.ts`. Pure functions only:
  - `isCommitEnabled({ summary, includedCount, allowEmpty, isAmending, isBusy })` — a commit needs a non-empty summary unless exactly one file is included (then the single-file placeholder summary applies) or `allowEmpty` is set;
  - `buildPlaceholderSummary(paths)` → `Update <basename>` for a single path;
  - `formatCoAuthorTrailers(coAuthors)` → one `Co-Authored-By: Name <email>` line per entry, de-duplicated case-insensitively by email;
  - `buildCommitMessage({ summary, description, coAuthors })` — summary, blank line, description, blank line, trailers;
  - `isSummaryOverIdealLength(summary)` at 50 characters (research § 1.1, `IdealSummaryLength = 50`).

  One failing test per function before its implementation.

- [ ] **Step 08.9: Build the commit box component.**

  Path: `apps/web/src/components/gitManager/changes/GitManagerCommitBox.tsx`. Summary input, description textarea, a co-author input, an options popover carrying **Bypass commit hooks** (`--no-verify`), **Signed-off-by** (`--signoff`) and **Allow empty** (`--allow-empty`), and an amend mode with a visible "Stop amending" affordance that suppresses the undo strip. The commit button label is `Commit N files to <branch>`; Cmd/Ctrl+Enter commits. It runs the commit action from `apps/web/src/state/gitManager.ts` on the existing per-`(environmentId, cwd)` lane. Tests: disabled without a summary; enabled with the single-file placeholder; the over-50-character hint appears; the options flags reach the action payload; amend hides the undo strip.

- [ ] **Step 08.10: Build the undo-commit strip.**

  Path: `apps/web/src/components/gitManager/changes/GitManagerUndoCommitStrip.tsx`. Shows `Committed <relative time>` with an Undo control for the most recent local commit; hidden while amending and while an operation is in flight; a dirty working tree or a merge commit routes through a confirmation stating exactly what will happen (spec § 6.5). Tests cover the hidden cases and the confirmation gate.

- [ ] **Step 08.11: Build the discard confirmations.**

  Path: `apps/web/src/components/gitManager/changes/GitManagerDiscardDialog.tsx`. One dialog serving whole-file discard and discard-all, listing at most 10 paths and then `and N more` (research § 1.1, `MaxFilesToList = 10`). The dialog states whether the files go to the OS trash or are discarded permanently, using the outcome the **server** reports — the client derives no policy. Tests: the 10-path cap, the confirm/cancel paths, and that cancel issues no RPC.

- [ ] **Step 08.12: Mount everything in the Changes view.** Wire the three components into the Changes view PHASE-05 landed. Do not re-implement inclusion state or the file list — extend what PHASE-05 owns.

- [ ] **Step 08.13: Full build + test gate.**

  ```bash
  vp test apps/web/src/components/gitManager/changes
  vp test apps/web/src/sourceControlDraft.test.ts
  vp test apps/web/src/components/SourceControlPanel.test.tsx
  vp check
  vp run typecheck
  ```

  Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 08.14: Stack-specific verification.** Launch the app. Type a commit message in the Git Manager, open the per-thread Source Control panel for the same checkout, and confirm the same text is there — and the reverse. Commit, amend, undo, and discard a file. Repeat against a remote-hosted project (spec § 10 requires both).

- [ ] **Step 08.15: TDD proof.** Temporarily make `isCommitEnabled` return `true` unconditionally and `sourceControlDraftKey` ignore `environmentId`. Re-run the two test paths from Step 08.13 and confirm the commit-gating and key-collision tests fail. Restore both and re-run.

- [ ] **Step 08.16: Mark phase complete.** Change Phase 08 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This decomposition is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] One commit draft per `(environmentId, cwd)`, shared by the Git Manager and the existing Source Control panel, proven by a test that writes in one scope and reads in another consumer.
- [ ] Commit options (`--no-verify`, `--signoff`, `--allow-empty`), co-author trailers and amend all reach the server payload.
- [ ] Undo-commit and every discard path are behind an explicit confirmation stating what will happen; cancel issues no RPC.
- [ ] All server-authored blocked reasons and trash-vs-permanent outcomes are rendered verbatim; no git policy is computed client-side.
- [ ] Mutations run through the existing per-`(environmentId, cwd)` lane, not raw RPC calls.
- [ ] All new tests green; the three `vp test` paths in Step 08.13 pass.
- [ ] `vp check` clean and `vp run typecheck` clean.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counters, remote feature flags, avatar or identity fetches, third-party host contact, and no new dependency in `apps/web/package.json`.
- [ ] Final `git diff` and `git status --short` reviewed for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **`apps/web/src/sourceControlDraft.ts`** exports `sourceControlDraftKey({ environmentId, cwd })` and `useSourceControlDraft({ environmentId, cwd }) => { message, setMessage, clear }`. **This is the only commit draft in the app.** PHASE-12, PHASE-14 and PHASE-15 read it; none of them may add a second draft, and `apps/web/src/gitManagerStore.ts` must stay view-state-only.
- **`apps/web/src/sourceControlPanelStore.ts`** is now at persisted `version: 2` with both `byThreadKey` (legacy) and `byCwdKey` (current). Any later migration must preserve both.
- **`commitBox.logic.ts`** exports `isCommitEnabled`, `buildPlaceholderSummary`, `formatCoAuthorTrailers`, `buildCommitMessage`, `isSummaryOverIdealLength`. **PHASE-15** reuses `buildCommitMessage` for squash and reword rather than re-deriving trailer formatting.
- **`GitManagerCommitBox`** takes `onCommit: (input: { message: string; noVerify: boolean; signoff: boolean; allowEmpty: boolean; amend: boolean }) => Promise<void>` and `disabledReason: string | null` (rendered verbatim in a tooltip and via `aria-describedby`). Pass stable, memoised callbacks.
- **PHASE-14 (partial staging gutter)** must set inclusion through the state PHASE-05 owns and commit through this phase's commit box — it does not add a second commit path.
