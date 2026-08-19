# Git Manager / Phase 10 — Branch and tag lifecycle

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Create branches and tags, check out refs (including remote branches as local tracking branches), and delete or rename local refs behind explicit confirmations.

**Architecture:** Implements § "Phase 6 — Branch and tag lifecycle, destructive confirms" of `../master-plan.md`. Adds the dialogs and the ref context menu, wired into Phase 05's `RefTree` seam and Phase 09's toolbar seam, dispatching through Phase 09's `runOperation`. All blocking rules come from the server's guards; the client only renders them and asks for confirmation.

**Tech Stack:** React 19 + TypeScript, `@base-ui/react` (dialog, menu), Tailwind via `cn()`. Test: `vp test apps/web/src/components/git-manager`. Gates: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/git-manager/CreateBranchDialog.tsx` + test.
- **Create:** `apps/web/src/components/git-manager/CreateTagDialog.tsx` + test.
- **Create:** `apps/web/src/components/git-manager/ConfirmRefActionDialog.tsx` + test — delete / rename / force confirmations.
- **Create:** `apps/web/src/components/git-manager/RefContextMenu.tsx` + test — per-ref actions with guard-driven disabled entries.
- **Create:** `apps/web/src/components/git-manager/refNameValidation.ts` + test — pure client-side name validation for immediate feedback.
- **Modify:** `apps/web/src/components/git-manager/RefTree.tsx` — wire the context menu into Phase 05's action seam.
- **Modify:** `apps/web/src/components/git-manager/GitManagerToolbar.tsx` — wire the Branch and Tag buttons into Phase 09's seam.

## Dependencies

- Phase 04: Streaming repository operations.
- Phase 05: Ref tree with server-authored guards.
- Phase 09: Toolbar, progress banner, fetch/pull/push/merge dialogs.

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium-High (destructive ref operations; a wrong confirmation flow deletes work). Effort: ~2.5 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for validation and confirmation tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="web-design-guidelines")` — destructive-confirmation patterns, focus trapping, keyboard access
6. `Skill(skill="vercel-react-best-practices")` — controlled inputs and validation without render churn

## Documents to Read

- `../master-plan.md` — § Phase 6, § Out of scope (remote branch and remote tag deletion are excluded), § Acceptance Criteria 10.
- `../issue.specs` — § Interview Notes → "Operations in v1".
- `../screenshots/SCR-20260817-pzpc.png` — Create Branch dialog (base ref, name, "Check out after create").
- `../screenshots/SCR-20260817-pzho.png` — Create Tag dialog (target, name, message, Push, "already exists" warning).
- `../screenshots/SCR-20260817-pzbr.png` — the branch context menu; only the in-scope entries are implemented.
- Phase 05's and Phase 09's completion notes in `../tasks.md` — the exact seams to wire into.
- `apps/web/src/components/CreateWorktreeDialog.tsx` — inline validation and disabled-submit conventions.

---

## Pre-execution check

- [ ] **Step 10.0: Claim the phase.** Set Phase 10 in `../tasks.md` → `in_progress`, `Agent = phase-10`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 10.1: Locate the surface area.**

	```bash
	grep -n "onRefAction\|RefAction" apps/web/src/components/git-manager/RefTree.tsx
	grep -n "extraActions\|slots\|placeholder" apps/web/src/components/git-manager/GitManagerToolbar.tsx
	```

	Read both seams and Phase 09's `runOperation` signature. Record deviations in `../tasks.md`.

- [ ] **Step 10.2: Author the first failing test** — `refNameValidation.test.ts`:

	```ts
	it("rejects names git itself would reject and duplicates", () => {
	  expect(validateBranchName("feature/ok", ["develop"])).toEqual({ ok: true });
	  expect(validateBranchName("", ["develop"]).reason).toMatch(/empty/i);
	  expect(validateBranchName("bad name", ["develop"]).reason).toMatch(/space/i);
	  expect(validateBranchName("feature..x", ["develop"]).reason).toMatch(/\.\./);
	  expect(validateBranchName("develop", ["develop"]).reason).toMatch(/already exists/i);
	});
	```

- [ ] **Step 10.3: Run it; expect FAIL** — module not found.

	```bash
	vp test apps/web/src/components/git-manager/refNameValidation.test.ts
	```

- [ ] **Step 10.4: Implement `refNameValidation.ts`** — mirror `git check-ref-format` rules for immediate feedback only (empty, whitespace, `..`, leading/trailing `/`, `~^:?*[`, trailing `.lock`), plus duplicate detection against the current ref list. This is **UX feedback, not policy**: the server remains the authority and its rejection still wins.

- [ ] **Step 10.5: Run the test; expect PASS.**

- [ ] **Step 10.6: Implement `CreateBranchDialog.tsx` (test first)** — "Create branch at: `<ref>`", name input with live validation, "Check out after create" checkbox, submit disabled while invalid. Assert the dispatched operation carries `{ name, baseRef, checkout }`, and that a server `blocked` failure surfaces in the banner without closing the dialog.

- [ ] **Step 10.7: Implement `CreateTagDialog.tsx` (test first)** — target ref, tag name with the inline `Tag '<name>' already exists` warning from the screenshot, optional message (annotated when present), Push checkbox. Assert `{ name, targetRef, message, push }` reaches the dispatch.

- [ ] **Step 10.8: Implement `ConfirmRefActionDialog.tsx` (test first)** — a single confirmation surface for delete branch, delete tag, rename branch and force-delete. It states exactly what will happen and which ref is affected, requires an explicit confirm click, and defaults focus to Cancel. Assert Cancel dispatches nothing.

- [ ] **Step 10.9: Implement `RefContextMenu.tsx` (test first)** — per-ref entries: Checkout, Checkout as local tracking branch (remote refs without a local branch), Create branch here, Create tag here, Rename, Delete, Copy ref name. Entries the server blocks are disabled and carry the server's reason; the menu never hides a blocked entry silently.

- [ ] **Step 10.10: Wire the seams** — context menu into `RefTree.tsx`, Branch/Tag buttons into `GitManagerToolbar.tsx`. Assert through the ref-tree and toolbar tests that opening each entry opens the right dialog.

- [ ] **Step 10.11: Add the guard tests** — deleting the current branch, deleting or renaming the default branch, and checking out a branch that owns a worktree are all disabled with the server's message; a remote-branch checkout offers the tracking-branch option only when no local branch exists.

- [ ] **Step 10.12: Add the refresh test** — a successful create/checkout/delete revalidates the refs snapshot so the tree reflects the change without a manual refresh.

- [ ] **Step 10.13: Accessibility pass.** Dialogs trap focus and restore it on close; the context menu is keyboard-openable and navigable; disabled entries expose their reason via `aria-describedby`, not hover alone.

- [ ] **Step 10.14: Full gate.**

	```bash
	vp test apps/web/src/components/git-manager
	vp run typecheck
	vp check
	```

- [ ] **Step 10.15: Run it for real** on a scratch repository: create a branch with checkout, check out a remote branch as local, create and push a tag, rename a branch, delete a branch, and attempt each blocked case to confirm the reason text. `superpowers:verification-before-completion` is mandatory here.

- [ ] **Step 10.16: TDD proof.** Make `ConfirmRefActionDialog` dispatch immediately on open, re-run — the "Cancel dispatches nothing" tests must fail. Restore, re-run, confirm green.

- [ ] **Step 10.17: Mark complete.** Phase 10 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] Create branch (with optional checkout), create tag (with optional push), checkout, checkout-remote-as-local, rename, delete branch and delete tag all work end to end.
- [ ] Every destructive action requires an explicit confirmation that names the affected ref; Cancel dispatches nothing.
- [ ] Duplicate and malformed names are caught inline, and a server rejection still surfaces if the client validator misses one.
- [ ] Blocked entries are visibly disabled with the server's reason, reachable by keyboard.
- [ ] Remote branch deletion and remote tag deletion are absent — they are out of scope.
- [ ] Successful operations revalidate the refs snapshot automatically.
- [ ] `vp test` (scoped), `vp run typecheck`, `vp check` clean; exercised in the running app.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 12 documents the supported operations; list in your completion notes exactly which entries shipped in the context menu so the docs do not over-promise.
- If a client-side validation rule turned out stricter than git's, record it — an over-strict validator silently blocks legal names.
- Note whether the tracking-branch option defaulted on or off; the acceptance criteria and the user guide both describe it.
