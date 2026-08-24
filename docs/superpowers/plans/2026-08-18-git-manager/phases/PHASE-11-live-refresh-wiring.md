# Git Manager / Phase 11 — Client live-refresh wiring

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Keep the open Git Manager current by subscribing to the server's repository-change generation and revalidating exactly what changed — without losing the user's scroll or selection.

**Architecture:** Implements the client half of § "Phase 7 — Live change signal" of `../master-plan.md`. A hook subscribes to `subscribeVcsGraph` for the open project, compares generations, revalidates the refs snapshot and the first commit page, and discards pages from a superseded generation. Only this phase touches `GitManagerView.tsx` after Phase 02.

**Tech Stack:** React 19 + TypeScript, `@effect/atom-react` streaming subscription. Test: `vp test apps/web/src/components/git-manager`. Gates: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/git-manager/useGitGraphLiveRefresh.ts` + test — subscription, generation comparison, revalidation policy.
- **Modify:** `apps/web/src/state/gitManager.ts` — expose the graph subscription and a generation-aware invalidation entry point.
- **Modify:** `apps/web/src/components/git-manager/GitManagerView.tsx` — mount the hook for the active project only.

## Dependencies

- Phase 02: Project route, panel shell, store, sidebar button.
- Phase 07: Live repository change signal.

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium (a wrong invalidation policy causes either staleness or constant refetching). Effort: ~1.5 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the generation tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="vercel-react-best-practices")` — subscription lifecycle, stale closures, no refetch storms

## Documents to Read

- `../master-plan.md` — § Phase 7 (client paragraph), § Acceptance Criteria 11.
- `../issue.specs` — § Interview Notes → "Live updates".
- Phase 07's completion notes in `../tasks.md` — event shape, whether the current generation arrives on connect, reconnect semantics, and the real poll interval.
- Phase 06's completion notes — what a generation change resets in the graph and what is preserved.
- `apps/web/src/state/gitManager.ts` — the read atoms this hook invalidates.
- `apps/web/src/gitManagerStore.ts` — the cached per-project state that must survive a refresh.

---

## Pre-execution check

- [ ] **Step 11.0: Claim the phase.** Set Phase 11 in `../tasks.md` → `in_progress`, `Agent = phase-11`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 11.1: Locate the surface area.**

	```bash
	grep -rn "subscribeVcsStatus" apps/web/src packages/client-runtime/src | head
	```

	Read how an existing subscription is consumed and torn down on unmount. Confirm Phase 07's event shape. Record deviations in `../tasks.md`.

- [ ] **Step 11.2: Author the first failing test** — `useGitGraphLiveRefresh.test.ts`:

	```ts
	it("revalidates refs and the first page when the generation increases", async () => {
	  const refresh = vi.fn();
	  const { emit } = renderLiveRefreshHarness({ initialGeneration: 4, refresh });
	  emit({ generation: 4, changedAtMs: 1 });   // same generation → no work
	  expect(refresh).not.toHaveBeenCalled();
	  emit({ generation: 5, changedAtMs: 2 });
	  expect(refresh).toHaveBeenCalledTimes(1);
	});
	```

- [ ] **Step 11.3: Run it; expect FAIL** — hook not found.

	```bash
	vp test apps/web/src/components/git-manager/useGitGraphLiveRefresh.test.ts
	```

- [ ] **Step 11.4: Implement the hook** — subscribe for the active project's cwd, hold the last-seen generation in a ref, and call the revalidation entry point only when the incoming generation is greater.

- [ ] **Step 11.5: Run the test; expect PASS.**

- [ ] **Step 11.6: Add the coalescing test** — several bumps arriving in quick succession trigger at most one in-flight revalidation; a bump during a revalidation schedules exactly one follow-up.

- [ ] **Step 11.7: Add the splice test** — on a generation bump the new commits are fetched against the **same pinned tip snapshot** and spliced above the loaded rows; already-loaded pages, scroll position and selection are kept. Pages belonging to a *different* tip snapshot are discarded rather than mixed. A full reload happens only when the server reports the pinned tips are unusable (`tipsPinned: false` or a resolve failure) or the user explicitly refreshes.

- [ ] **Step 11.8: Add the preservation test** — after a revalidation the user's `selectedRef`, `selectedCommitSha`, `selectedFilePath` and scroll position survive when those refs still exist; a selection whose commit disappeared falls back cleanly to no selection rather than erroring.

- [ ] **Step 11.9: Add the lifecycle tests** — the subscription starts when the project view mounts, stops when it unmounts or the project changes, and is not started for cached-but-hidden projects (only the visible project subscribes); a reconnect re-reads the current generation and revalidates once if it advanced while disconnected.

- [ ] **Step 11.10: Mount in `GitManagerView.tsx`** for the active project only, and assert through the shell test that exactly one subscription exists per visible project.

- [ ] **Step 11.11: Full gate.**

	```bash
	vp test apps/web/src/components/git-manager
	vp run typecheck
	vp check
	```

- [ ] **Step 11.12: Run it for real.** With the Git Manager open, make a commit and create a branch from an external terminal; confirm both appear without touching Refresh, and that your scroll position and selected commit survive. Then kill and restore the connection and confirm one revalidation follows. `superpowers:verification-before-completion` is mandatory here.

- [ ] **Step 11.13: TDD proof.** Make the hook revalidate on every event regardless of generation, re-run — the "same generation → no work" and coalescing tests must fail. Restore, re-run, confirm green.

- [ ] **Step 11.14: Mark complete.** Phase 11 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] An external commit, branch, tag, or worktree change appears in the panel without a manual refresh.
- [ ] A repeated generation triggers no work; bursts coalesce into at most one in-flight revalidation plus at most one follow-up.
- [ ] A generation bump splices new commits above the pinned snapshot and preserves loaded pages, scroll and selection; a full reload happens only when the tips become unusable or the user refreshes. Pages from a different tip snapshot are never mixed in.
- [ ] Scroll position and selection survive a refresh; a vanished selection degrades to empty rather than erroring.
- [ ] Exactly one subscription exists per visible project; hidden cached projects do not subscribe; unmount tears it down.
- [ ] A reconnect revalidates once if the generation advanced while disconnected.
- [ ] `vp test` (scoped), `vp run typecheck`, `vp check` clean; verified against a real external change.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 12 documents the staleness guarantee: record the observed end-to-end latency (external change → visible) and the poll interval Phase 07 reported, so the docs state a real number.
- If you had to change any read atom's signature in `state/gitManager.ts`, list it — Phases 05/06/08/09 all consume that module and the docs describe it.
