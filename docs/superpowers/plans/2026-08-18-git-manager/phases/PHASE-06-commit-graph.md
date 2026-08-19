# Git Manager / Phase 06 — Virtualized commit graph

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Render the paged commit DAG as a virtualized list of rows with SVG lanes, ref badges, author, short sha and date — Fork-style — loading the next page as the user scrolls.

**Architecture:** Implements the rendering half of § "Phase 3 — Lane commit graph" of `../master-plan.md`. Consumes Phase 03's pure `commitGraphLayout` module and Phase 02's `useGitManagerReads`; owns `CommitGraphRegion.tsx`. Each row draws its own SVG band at a fixed lane width, so appending a page never relayouts earlier rows.

**Tech Stack:** React 19 + TypeScript, `@legendapp/list` for virtualization (already a dependency — do not add another), inline SVG, Tailwind via `cn()`. Test: `vp test apps/web/src/components/git-manager`. Gates: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/git-manager/CommitGraph.tsx` — virtualized list, page loading, lane-state carry.
- **Create:** `apps/web/src/components/git-manager/CommitGraphRow.tsx` — one row: SVG lane band + columns.
- **Create:** `apps/web/src/components/git-manager/CommitGraph.test.tsx` — rendering, paging and selection tests.
- **Create:** `apps/web/src/components/git-manager/CommitGraphRow.test.tsx` — lane/edge rendering and badge tests.
- **Modify:** `apps/web/src/components/git-manager/CommitGraphRegion.tsx` — replace the Phase 02 placeholder.

## Dependencies

- Phase 02: Project route, panel shell, store, sidebar button.
- Phase 03: Incremental lane-layout module.

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium (virtualization + SVG; performance is an explicit success criterion). Effort: ~2.5 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for row and paging tests
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="vercel-react-best-practices")` — virtualization, stable keys, avoiding re-render storms
6. `Skill(skill="frontend-design:frontend-design")` — lane colours and row rhythm that read like the reference client

## Documents to Read

- `../master-plan.md` — § Phase 3 (rendering paragraph, `MAX_GRAPH_LANES`), § Success Criteria (first page under ~1 s on a large repository).
- `../screenshots/SCR-20260817-pywo.jpeg`, `../screenshots/SCR-20260817-pytb.png` — column order, badge styling, lane density.
- `apps/web/src/components/git-manager/commitGraphLayout.ts` — Phase 03's exports; the renderer adds no layout logic of its own.
- `apps/web/src/state/gitManager.ts` — `useGitManagerReads` (`graphPages`, `loadNextPage`, `generation`).
- `apps/web/src/gitManagerStore.ts` — `selectedCommitSha`, `scrollIndex`, `loadedPages` live here.
- An existing `@legendapp/list` usage in `apps/web/src` (grep for `LegendList`) — copy the established virtualization pattern.

---

## Pre-execution check

- [ ] **Step 06.0: Claim the phase.** Set Phase 06 in `../tasks.md` → `in_progress`, `Agent = phase-06`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 06.1: Locate the surface area.**

	```bash
	grep -rn "@legendapp/list" apps/web/src | head -10
	grep -n "export" apps/web/src/components/git-manager/commitGraphLayout.ts
	```

	Read the existing virtualized-list usage and Phase 03's exports. Record deviations in `../tasks.md`.

- [ ] **Step 06.2: Author the first failing test** — `CommitGraphRow.test.tsx`:

	```tsx
	it("draws one lane band and the commit's ref badges", () => {
	  render(
	    <CommitGraphRow
	      row={{ sha: "c1", lane: 1, colorIndex: 1, isMerge: false, edges: [{ fromLane: 1, toLane: 1, kind: "straight", colorIndex: 1 }] }}
	      commit={{ sha: "c1", shortSha: "c1abcde", parents: ["c0"], refs: [{ name: "develop", kind: "local-branch" }], subject: "Fix the thing", authorName: "mubeda", authorEmail: "m@example.invalid", authoredAtMs: 1780000000000, committedAtMs: 1780000000000 }}
	      isSelected={false}
	      onSelect={() => {}}
	    />,
	  );
	  expect(screen.getByText("Fix the thing")).toBeInTheDocument();
	  expect(screen.getByText("develop")).toBeInTheDocument();
	  expect(screen.getByTestId("graph-lane-band").querySelectorAll("path")).toHaveLength(1);
	});
	```

- [ ] **Step 06.3: Run it; expect FAIL** — component not found.

	```bash
	vp test apps/web/src/components/git-manager/CommitGraphRow.test.tsx
	```

- [ ] **Step 06.4: Implement `CommitGraphRow.tsx`** — fixed lane width, one SVG `path` per edge (`straight` vertical, `branch`/`merge` curved), the commit dot at `row.lane`, then the columns: subject + ref badges | author | short sha | date. Colour comes from `colorIndex`; never recompute lanes here.

- [ ] **Step 06.5: Run the test; expect PASS.**

- [ ] **Step 06.6: Add row cases** — a merge row renders one extra edge and is flagged; a row at the lane cap renders the overflow indicator; a commit with `HEAD` and `tag:` decorations renders both badge kinds distinctly.

- [ ] **Step 06.7: Write the failing list test.** `CommitGraph.test.tsx`: given two mocked pages, the list renders the first page, calls `loadNextPage` once when scrolled near the end, and renders the second page appended with lane state carried (no re-render of earlier rows' lanes). Assert `loadNextPage` is not called twice for one threshold crossing.

- [ ] **Step 06.8: Implement `CommitGraph.tsx`** — hold the lane state in a `useRef`, feed each arriving page through `appendCommits`, keep the accumulated rows, render through `@legendapp/list`, and drive `loadNextPage` from the virtualizer's end-reached signal. Echo the first page's `tips` back on every subsequent page so the server keeps paging against the pinned snapshot. Reset lane state only when the **project** changes or the server reports the pinned tips are no longer usable (`tipsPinned: false`, or a resolve failure) — **not** on every `generation` bump.

- [ ] **Step 06.9: Wire selection.** Clicking a row sets `selectedCommitSha` via the store; the selected row is visually and accessibly marked (`aria-selected`). Persist `scrollIndex` to the store on scroll so the LRU cache restores position. Add tests for both.

- [ ] **Step 06.10: Add the generation-bump tests** — when `generation` changes, new commits are **spliced above** the pinned snapshot and the already-loaded rows, scroll position and selection are preserved; the lane state is extended, not rebuilt. A full reset happens only when the pinned tips become unusable or the user explicitly refreshes. Assert both paths, and assert that pages from two different tip snapshots are never mixed.

- [ ] **Step 06.11: Mount in `CommitGraphRegion.tsx`** and assert through the shell test that the region renders the graph.

- [ ] **Step 06.12: Keyboard + a11y pass.** The list is focusable, up/down moves the selection, Enter selects; rows expose an accessible name containing the subject and short sha. Add a test.

- [ ] **Step 06.13: Full gate.**

	```bash
	vp test apps/web/src/components/git-manager
	vp run typecheck
	vp check
	```

- [ ] **Step 06.14: Run it for real on a big repository and measure.** Open the Git Manager on this repo (tens of thousands of commits). **Record a number, not an impression:** time from route mount to first painted page, via `performance.now()` around the first render or a Chrome DevTools performance trace. The master plan's success criterion is ~1 s — write the measured value into your progress notes and flag it in `../tasks.md` § Coordination Notes if it misses. Then scroll several pages and confirm lanes stay continuous across page boundaries and colours do not jump. `superpowers:verification-before-completion` is mandatory here.

- [ ] **Step 06.15: TDD proof.** Reset the lane state on every page instead of carrying it, re-run — the paging/lane-continuity tests must fail. Restore, re-run, confirm green.

- [ ] **Step 06.16: Mark complete.** Phase 06 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] Rows render subject, ref badges, author, short sha and date, with SVG lanes matching `GraphRow.edges`.
- [ ] Scrolling loads the next page exactly once per threshold crossing, and lanes stay continuous across the boundary.
- [ ] A `generation` change resets accumulated rows instead of mixing generations.
- [ ] Selection updates `selectedCommitSha` in the store and is exposed via `aria-selected`; scroll position round-trips through the store.
- [ ] No layout logic was added here — all lane/edge data comes from Phase 03's module.
- [ ] Verified on a real repository with tens of thousands of commits: first page fast, scrolling smooth.
- [ ] `vp test` (scoped), `vp run typecheck`, `vp check` clean.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 08 renders the detail pane for `selectedCommitSha`. Confirm in your notes that selection is written to the store (not held locally), and name the accessible row pattern so Phase 08's "click a parent sha to select it" wiring matches.
- Phase 11 revalidates on a live `generation` bump; your reset rule is what makes that safe. State it explicitly in your notes: what resets, what is preserved (scroll should be preserved when the head is unchanged).
- If you had to extend `GraphRow` to render the overflow indicator, say so — Phase 03 owns that type and the master plan cites it.
