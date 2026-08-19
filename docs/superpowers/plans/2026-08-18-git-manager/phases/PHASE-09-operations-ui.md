# Git Manager / Phase 09 — Toolbar, progress banner, fetch/pull/push/merge dialogs

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Let the user run fetch, pull, push and merge from the Git Manager, watch them stream, cancel them, read the real git output, and decide what happens on a merge conflict.

**Architecture:** Implements the client half of § "Phase 5 — Mutating operations, progress, serialization" of `../master-plan.md`. Owns `OperationsRegion.tsx`; adds a separate write-side state module `state/gitManagerOperations.ts` (read atoms stay in Phase 02's `state/gitManager.ts`). The conflict dialog is driven by `mergeInProgress` from the refs snapshot, not only by the stream event, so a reload or reconnect still surfaces a pending merge.

**Tech Stack:** React 19 + TypeScript, `@base-ui/react` dialogs, `@effect/atom-react` for the streaming RPC, Tailwind via `cn()`. Test: `vp test apps/web/src/components/git-manager`. Gates: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/state/gitManagerOperations.ts` — streaming operation atom, event accumulation, cancel.
- **Create:** `apps/web/src/components/git-manager/GitManagerToolbar.tsx` + test — Fetch / Pull / Push / Merge / Refresh, each with guard-driven disabled state.
- **Create:** `apps/web/src/components/git-manager/GitOperationProgress.tsx` + test — inline banner, cancel, collapsible full output.
- **Create:** `apps/web/src/components/git-manager/PushDialog.tsx` + test.
- **Create:** `apps/web/src/components/git-manager/MergeDialog.tsx` + test.
- **Create:** `apps/web/src/components/git-manager/MergeConflictDialog.tsx` + test.
- **Modify:** `apps/web/src/components/git-manager/OperationsRegion.tsx` — replace the Phase 02 placeholder with toolbar + banner + dialogs.

## Dependencies

- Phase 02: Project route, panel shell, store, sidebar button.
- Phase 04: Streaming repository operations.
- Phase 05: Ref tree with server-authored guards (reuse `resolveBlockedReason`).

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: High (destructive actions, streaming state, the conflict decision path). Effort: ~3 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the streaming and dialog tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="vercel-react-best-practices")` — streaming state without re-render storms on every output chunk
6. `Skill(skill="web-design-guidelines")` — destructive-action confirmation and focus management
7. `Skill(skill="frontend-design:frontend-design")` — a progress banner that reads like the reference client

## Documents to Read

- `../master-plan.md` — § Phase 5 (client paragraph, event union, failure codes), § Acceptance Criteria 8–9.
- `../issue.specs` — § Interview Notes → "Merge conflicts" and "Progress and errors".
- `../screenshots/SCR-20260817-pylr.png` — the progress dialog with Cancel, "Show full output" and the literal git command.
- `../screenshots/SCR-20260817-pzjt.png` — the Push dialog (branch, remote, push all tags, force push).
- `../screenshots/SCR-20260817-pzmn.png` — the Merge dialog (source, target, merge-option dropdown, conflict warning).
- `apps/web/src/components/CreateWorktreeDialog.tsx` — dialog structure and the RPC-command pattern with interruption handling (`isAtomCommandInterrupted`, `squashAtomCommandFailure`).
- `apps/web/src/state/gitManager.ts` — the refs snapshot (`runningOperation`, `mergeInProgress`, `conflictedPaths`, blocked reasons).
- Phase 04's completion notes in `../tasks.md` — the exact `label` and `summary` strings the server emits.

---

## Pre-execution check

- [ ] **Step 09.0: Claim the phase.** Set Phase 09 in `../tasks.md` → `in_progress`, `Agent = phase-09`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 09.1: Locate the surface area.**

	```bash
	grep -n "isAtomCommandInterrupted\|squashAtomCommandFailure" apps/web/src/components/CreateWorktreeDialog.tsx
	grep -rn "subscribeVcsStatus\|stream" apps/web/src/state/vcs.ts | head
	```

	Read how an existing streaming RPC is consumed on the client and how cancellation is surfaced. Record deviations in `../tasks.md`.

- [ ] **Step 09.2: Author the first failing test** — `gitManagerOperations.test.ts`:

	```ts
	it("accumulates output chunks and ends in failed with the server's code", async () => {
	  const state = createOperationState();
	  applyOperationEvent(state, { _tag: "started", operationId: "op1", label: "Fetching origin", startedAtMs: 1 });
	  applyOperationEvent(state, { _tag: "output", operationId: "op1", stream: "stderr", chunk: "fatal: Authentication failed\n" });
	  applyOperationEvent(state, { _tag: "failed", operationId: "op1", code: "authentication", detail: "…" });
	  expect(state.status).toBe("failed");
	  expect(state.code).toBe("authentication");
	  expect(state.output).toContain("Authentication failed");
	});
	```

- [ ] **Step 09.3: Run it; expect FAIL** — module not found.

	```bash
	vp test apps/web/src/state/gitManagerOperations.test.ts
	```

- [ ] **Step 09.4: Implement the operation state reducer** — pure functions over the event union, with a bounded output buffer (cap the retained text and mark it truncated rather than growing without limit).

- [ ] **Step 09.5: Run the test; expect PASS.**

- [ ] **Step 09.6: Add reducer cases + tests** — `finished` sets the summary and the new `generation`; `conflict` records the conflicted paths and moves to a `conflicted` status; a `cancelled` failure is distinguished from a real error; events for a stale `operationId` are ignored.

- [ ] **Step 09.7: Wire the streaming atom.** `state/gitManagerOperations.ts` exposes `runOperation(projectRef, operation)` returning `{ start, cancel }`, feeding events into the reducer and re-validating reads on `finished`. Cancellation must interrupt the RPC (not just stop listening) so the server releases its lock.

- [ ] **Step 09.8: Write the failing banner test, then implement `GitOperationProgress.tsx`** — running state with the operation label and a Cancel button; a collapsible "Show full output" area rendering the accumulated stdout/stderr; failures stay pinned with a Dismiss control; the `authentication` code additionally renders the "configure a credential helper or SSH agent" hint. Assert the output area is not rendered until expanded.

- [ ] **Step 09.9: Write the failing toolbar test, then implement `GitManagerToolbar.tsx`** — Fetch, Pull, Push, Merge, Tag/Branch (placeholders wired in Phase 10), Refresh. Each button's disabled state and tooltip come from `resolveBlockedReason` (Phase 05) against the refs snapshot; while `runningOperation` is non-null every mutating button is disabled with the in-flight reason.

- [ ] **Step 09.10: Implement `PushDialog.tsx` (test first)** — branch selector, target remote selector, "Push all tags", "Force push". Force push requires an explicit confirmation step before dispatch. Assert the dispatched payload matches the tags/force/setUpstream selection.

- [ ] **Step 09.11: Implement `MergeDialog.tsx` (test first)** — source ref, target (current branch, read-only), and the mode dropdown: Default / No Fast-Forward / Squash / Don't Commit. Assert the selected mode reaches the dispatched operation, and that the dialog refuses to dispatch when the refs snapshot says the tree is dirty (showing the server's reason).

- [ ] **Step 09.12: Implement `MergeConflictDialog.tsx` (test first)** — lists the conflicted paths, offers **Abort merge** (default focus) and **Keep conflicted state** (explaining resolution happens outside this panel). It opens from the `conflict` event **and** whenever the refs snapshot reports `mergeInProgress`. Add a test that a fresh mount with `mergeInProgress: true` and no stream event still surfaces the resolve affordance, and that Abort dispatches `resolveMergeConflict` with `decision: "abort"`.

- [ ] **Step 09.13: Add the persistent pending-merge bar** — when `mergeInProgress` is true and the dialog is dismissed, a bar remains in the region with a "Resolve" action. Test the dismiss-then-still-visible path.

- [ ] **Step 09.14: Mount everything in `OperationsRegion.tsx`** and assert through the shell test that the region renders the toolbar and banner.

- [ ] **Step 09.15: Full gate.**

	```bash
	vp test apps/web/src/components/git-manager apps/web/src/state/gitManagerOperations.test.ts
	vp run typecheck
	vp check
	```

- [ ] **Step 09.16: Run it for real** against a scratch repository with a local bare remote: fetch, pull, push, a force push, and a merge that conflicts — take both the Abort and the Keep path, and reload the page mid-conflict to confirm the pending-merge bar returns. `superpowers:verification-before-completion` is mandatory here; record what you observed.

- [ ] **Step 09.17: TDD proof.** Make the reducer ignore `output` events, re-run — the accumulation tests must fail. Restore, re-run, confirm green.

- [ ] **Step 09.18: Mark complete.** Phase 09 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] Fetch, Pull, Push and Merge dispatch the right operation payload and stream progress into the banner.
- [ ] Cancel interrupts the RPC; afterwards a new operation can start (the server lock was released).
- [ ] Full git output is available behind "Show full output"; failures stay pinned; an `authentication` failure shows the credential hint.
- [ ] Force push requires explicit confirmation; "Push all tags" reaches the payload.
- [ ] Merge modes Default / No-FF / Squash / Don't-Commit each reach the payload; a dirty tree blocks the dispatch with the server's reason.
- [ ] A conflict opens the decision dialog; Abort dispatches `resolveMergeConflict`; a reload with `mergeInProgress: true` still surfaces the resolve affordance.
- [ ] While an operation runs, every mutating control is disabled with the in-flight reason.
- [ ] `vp test` (scoped), `vp run typecheck`, `vp check` clean; exercised end to end against a real remote.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 10 adds Branch and Tag buttons to `GitManagerToolbar.tsx` and the context-menu actions. Leave a documented seam (e.g. a `slots` or `extraActions` prop, or clearly-marked placeholder buttons) and name it in your completion notes.
- Phase 10's destructive dialogs should reuse `GitOperationProgress` and `runOperation` rather than adding a second dispatch path — say in your notes exactly how to call them.
- Record the output-buffer cap you chose; the docs phase states it as a known limitation.
