# Git Manager / Phase 05 — Ref tree with server-authored guards

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Render the Branches / Remotes / Tags / Worktrees tree, colour-mark branches that own a worktree, and disable every blocked action with the server's own reason on hover.

**Architecture:** Implements the ref-tree half of § "Phase 2" and the guard surface of § "Technical Requirements → Web — components" in `../master-plan.md`. Owns `RefTreeRegion.tsx` (the placeholder Phase 02 created) and the `RefTree` component tree. Every disabled state and every tooltip string comes from `VcsGraphBlockedReason.message` — this phase must not compute Git policy.

**Tech Stack:** React 19 + TypeScript, `@base-ui/react` (tooltip, collapsible), `lucide-react`, Tailwind via `cn()`. Test: `vp test apps/web/src/components/git-manager`. Gates: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/git-manager/RefTree.tsx` — the four sections and their rows.
- **Create:** `apps/web/src/components/git-manager/RefTree.test.tsx` — guard, colour-marking and filter tests.
- **Create:** `apps/web/src/components/git-manager/refBlockedReason.ts` + `refBlockedReason.test.ts` — pure helper resolving the reason to show for a given ref + operation.
- **Modify:** `apps/web/src/components/git-manager/RefTreeRegion.tsx` — replace the Phase 02 placeholder with the real tree.

## Dependencies

- Phase 00: Wire contracts for the whole feature.
- Phase 02: Project route, panel shell, store, sidebar button.

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium (this is the surface `issue.specs` calls out explicitly — wrong tooltips defeat the feature's purpose). Effort: ~2 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the guard rendering tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="web-design-guidelines")` — disabled controls must expose their reason accessibly
6. `Skill(skill="vercel-react-best-practices")` — stable keys and memoization across long ref lists

## Documents to Read

- `../master-plan.md` — § Technical Requirements → Web — components, § Acceptance Criteria 3–5.
- `../issue.specs` — the worktree-marking and hover-hint requirements in the author's own words, plus § Interview Notes → Guards.
- `../screenshots/SCR-20260817-pzbr.png` — the tree sections and the branch context menu (menu itself lands in Phase 10).
- `apps/web/src/components/git-manager/GitManagerView.tsx` — how the region is mounted (Phase 02).
- `apps/web/src/state/gitManager.ts` — `useGitManagerReads`; the refs snapshot shape you consume.
- `apps/web/src/gitManagerStore.ts` — `selectedRef` and `filter` live here, not in local state.
- `apps/web/src/components/ui/` — the existing `Tooltip`/`TooltipTrigger`/`TooltipPopup` and collapsible primitives; do not introduce new ones.

---

## Pre-execution check

- [ ] **Step 05.0: Claim the phase.** Set Phase 05 in `../tasks.md` → `in_progress`, `Agent = phase-05`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 05.1: Locate the surface area.**

	```bash
	ls apps/web/src/components/git-manager/
	grep -n "TooltipPopup\|Collapsible" apps/web/src/components/Sidebar.tsx | head -10
	```

	Read Phase 02's `RefTreeRegion.tsx` placeholder and `useGitManagerReads`. Confirm the exact field names on `VcsGraphBranch` / `VcsGraphRemoteBranch` / `VcsGraphTag` / `VcsGraphWorktree`. Record deviations in `../tasks.md`.

- [ ] **Step 05.2: Author the first failing test** — `refBlockedReason.test.ts`:

	```ts
	import { describe, expect, it } from "vite-plus/test";
	import { resolveBlockedReason } from "./refBlockedReason";

	describe("resolveBlockedReason", () => {
	  it("returns the server message for the requested operation", () => {
	    const reason = resolveBlockedReason(
	      [{ operation: "checkout", code: "worktree-checked-out", message: "Checkout is blocked: this branch is already checked out in the worktree at X:/wt/foo." }],
	      "checkout",
	    );
	    expect(reason?.message).toContain("already checked out in the worktree");
	  });

	  it("returns null when nothing blocks the operation", () => {
	    expect(resolveBlockedReason([], "checkout")).toBeNull();
	  });
	});
	```

- [ ] **Step 05.3: Run it; expect FAIL** — module not found.

	```bash
	vp test apps/web/src/components/git-manager/refBlockedReason.test.ts
	```

- [ ] **Step 05.4: Implement `refBlockedReason.ts`** — a lookup over the server-supplied list. It must **not** contain any policy of its own: no "if dirty then…", no branch-name checks. If the list is empty the operation is allowed.

- [ ] **Step 05.5: Run the test; expect PASS.**

- [ ] **Step 05.6: Write the failing tree test.** `RefTree.test.tsx` with a fixture refs snapshot: assert the four section headings render, a branch with `worktreePath` is colour-marked (assert the state via a `data-*` attribute or accessible description, not a CSS class string), its checkout control is `disabled`, and its accessible description carries the server message verbatim.

- [ ] **Step 05.6b: Decide the tree primitive before writing one.** `@pierre/trees` is already a dependency (`apps/web/package.json`) and is used elsewhere in the app. Try it first: if it carries the four sections with per-row actions, guard states and colour marking, use it. If a bespoke component wins, write the reason in your completion notes — an unexplained hand-rolled tree next to an installed tree library is the kind of thing a reviewer will (rightly) challenge.

- [ ] **Step 05.7: Implement `RefTree.tsx`** — four collapsible sections (Branches, Remotes, Tags, Worktrees). It takes no props: read the project from the route params and the data from `useGitManagerReads`, per the convention Phase 02 established. Branch rows show current/default markers and ahead/behind counts; remote rows show whether a local tracking branch exists; tag rows show annotated/lightweight; worktree rows show the path and **no actions at all** (`issue.specs`: worktrees are listed only). Wire `selectedRef` and `filter` through `gitManagerStore` actions.

- [ ] **Step 05.8: Run the tree test; expect PASS**, then mount the tree in `RefTreeRegion.tsx` and assert via the shell test that the region renders it.

- [ ] **Step 05.9: Add the remaining guard tests** — one per code the server can emit (`dirty-working-tree`, `operation-in-flight`, `merge-in-progress`, `protected-branch`, `current-branch`, `no-upstream`, `detached-head`, `no-remote`): the control is disabled and the tooltip/description shows that exact message. A ref with no reasons has an enabled control and no tooltip.

- [ ] **Step 05.10: Add the empty/large-list tests** — a repository with no tags renders an empty-section state; a snapshot with 500 branches renders without duplicated React keys (assert no key warnings and that the filter narrows the list).

- [ ] **Step 05.11: Accessibility pass.** Every disabled control exposes its reason through `aria-describedby` as well as the hover tooltip (hover alone is unreachable by keyboard); sections are keyboard-expandable; rows are reachable by arrow/tab order. Add a test for the `aria-describedby` wiring.

- [ ] **Step 05.12: Full gate.**

	```bash
	vp test apps/web/src/components/git-manager
	vp run typecheck
	vp check
	```

- [ ] **Step 05.13: Run it for real.** Open the Git Manager on a project that has at least one worktree; confirm the owning branch is colour-marked, its checkout is disabled, and hovering names the worktree path. `superpowers:verification-before-completion` is mandatory here.

- [ ] **Step 05.14: TDD proof.** Make `resolveBlockedReason` always return `null` and re-run — every disabled-state test must fail. Restore, re-run, confirm green.

- [ ] **Step 05.15: Mark complete.** Phase 05 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] Branches, Remotes, Tags and Worktrees each render as their own section, with empty states.
- [ ] A branch that owns a worktree is colour-marked and cannot be checked out; the tooltip names the worktree path.
- [ ] Every blocked code the server can emit renders a disabled control plus the server's message, reachable by keyboard via `aria-describedby`.
- [ ] Worktree rows expose their path and no operations.
- [ ] No Git policy is computed client-side: `refBlockedReason.ts` only looks up server-supplied reasons.
- [ ] Selection and filter round-trip through `gitManagerStore` (so the LRU cache restores them).
- [ ] `vp test` (scoped), `vp run typecheck`, `vp check` clean; change exercised in the running app.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 10 adds the ref context menu and the create/delete/rename dialogs; it will modify `RefTree.tsx`. Export a `onRefAction?: (action: RefAction, ref: RefTreeItem) => void` prop (or an equivalent seam) and name it in your completion notes so Phase 10 wires into it instead of restructuring the tree.
- Phase 09's toolbar needs the same disabled/reason treatment for repository-wide operations — reuse `resolveBlockedReason` rather than writing a second lookup.
- If the server ever sends a blocked code the UI does not recognise, render the message anyway and disable the control (fail closed). Confirm you did this in your notes.
