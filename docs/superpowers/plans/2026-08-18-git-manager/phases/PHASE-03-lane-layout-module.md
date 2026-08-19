# Git Manager / Phase 03 — Incremental lane-layout module

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Turn a paged stream of commits-with-parents into stable lane assignments and edge segments, incrementally, with no React involved.

**Architecture:** Implements the algorithm half of § "Phase 3 — Lane commit graph" of `../master-plan.md`. A pure module: given the carried lane state and the next page of commits, it returns the new state plus the rows for those commits. Purity is what makes page-boundary stability testable and what keeps the renderer (Phase 06) dumb.

**Tech Stack:** TypeScript (no React, no DOM). Test: `vp test apps/web/src/components/git-manager/commitGraphLayout.test.ts`. Gates: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/git-manager/commitGraphLayout.ts` — the pure layout algorithm.
- **Create:** `apps/web/src/components/git-manager/commitGraphLayout.test.ts` — algorithm tests.

## Dependencies

- Phase 00: Wire contracts for the whole feature (for the `VcsGraphCommit` type).

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium (subtle algorithm; wrong lanes are visually obvious but hard to debug later). Effort: ~1.5 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor drives the lane cases
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="ponytail:ponytail")` — one array of active lanes, no graph library, no classes

## Documents to Read

- `../master-plan.md` — § Phase 3, especially the `GraphRow` / `GraphEdge` interfaces and the algorithm paragraph. Those names are the contract Phase 06 renders against.
- `../screenshots/SCR-20260817-pywo.jpeg` and `../screenshots/SCR-20260817-pytb.png` — what the lanes and merge curves must look like.
- `apps/web/src/lib/` — check for an existing hashing/util helper before writing one.

---

## Pre-execution check

- [ ] **Step 03.0: Claim the phase.** Set Phase 03 in `../tasks.md` → `in_progress`, `Agent = phase-03`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 03.1: Locate the surface area.** Read the `GraphRow`, `GraphEdge`, `GraphLaneState`, `createLaneState`, `appendCommits` and `MAX_GRAPH_LANES` declarations in `../master-plan.md` § Phase 3 and reproduce those exact names — Phase 06 imports them. Confirm `VcsGraphCommit` from `@bibcode/contracts` exposes `sha` and `parents`.

- [ ] **Step 03.2: Author the first failing test** — `commitGraphLayout.test.ts`:

	```ts
	import { describe, expect, it } from "vite-plus/test";
	import { appendCommits, createLaneState } from "./commitGraphLayout";

	const commit = (sha: string, parents: string[]) => ({
	  sha, shortSha: sha.slice(0, 7), parents, refs: [],
	  subject: sha, authorName: "a", authorEmail: "a@example.invalid",
	  authoredAtMs: 0, committedAtMs: 0,
	});

	describe("appendCommits", () => {
	  it("keeps linear history in a single lane", () => {
	    const { rows } = appendCommits(createLaneState(), [
	      commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1", []),
	    ]);
	    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
	  });
	});
	```

- [ ] **Step 03.3: Run it; expect FAIL** — module not found.

	```bash
	vp test apps/web/src/components/git-manager/commitGraphLayout.test.ts
	```

- [ ] **Step 03.4: Implement the minimum** — active-lane array; for each commit take the first lane expecting its sha (else the lowest free lane), record the row lane, and replace that slot with the commit's first parent.

- [ ] **Step 03.5: Run the test; expect PASS.**

- [ ] **Step 03.6: Add the fork case.** Two children of one parent occupy two lanes and converge: the second child's lane is released once its parent is claimed. Assert lanes and that the released lane is reused by the next unrelated commit.

- [ ] **Step 03.7: Add the two-parent merge case.** A merge commit emits a `merge` edge to the lane of its second parent, allocating that lane if no lane expects it. Assert the row `isMerge` flag and the edge's `fromLane`/`toLane`.

- [ ] **Step 03.8: Add the octopus case.** A commit with three parents produces one edge per extra parent and never drops one.

- [ ] **Step 03.9: Add the page-boundary stability test** — the master plan's key requirement:

	```ts
	it("produces identical rows whether laid out in one page or four", () => {
	  const commits = /* 100 synthetic commits with forks and merges */;
	  const single = appendCommits(createLaneState(), commits).rows;
	  let state = createLaneState();
	  const paged = [0, 25, 50, 75].flatMap((start) => {
	    const result = appendCommits(state, commits.slice(start, start + 25));
	    state = result.state;
	    return result.rows;
	  });
	  expect(paged).toEqual(single);
	});
	```

- [ ] **Step 03.10: Add the lane-cap test.** Beyond `MAX_GRAPH_LANES` (24) commits collapse into the overflow indicator instead of widening rows: assert no row reports a lane ≥ 24 and that overflowed rows are flagged.

- [ ] **Step 03.11: Add the colour-stability test.** `colorIndex` is derived from the lane index and does not change for a commit already laid out when a later page arrives.

- [ ] **Step 03.12: Full gate.**

	```bash
	vp test apps/web/src/components/git-manager/commitGraphLayout.test.ts
	vp run typecheck
	vp check
	```

- [ ] **Step 03.13: TDD proof.** Change the first-parent rule to use `parents[1]` and re-run — the linear, fork and stability tests must fail. Restore, re-run, confirm green.

- [ ] **Step 03.14: Mark complete.** Phase 03 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary naming the exported symbols.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] `appendCommits` is pure: same inputs produce the same outputs, and it never touches the DOM, timers, or randomness.
- [ ] Linear, fork, two-parent merge, octopus, lane-reuse, lane-cap and colour-stability cases are covered by tests.
- [ ] Laying out 100 commits in one call and in four calls of 25 produces byte-identical rows.
- [ ] Exported names match `../master-plan.md` § Phase 3 exactly (`GraphRow`, `GraphEdge`, `GraphLaneState`, `createLaneState`, `appendCommits`, `MAX_GRAPH_LANES`).
- [ ] `vp test` (scoped), `vp run typecheck`, `vp check` clean.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 06 imports this module and must not re-implement any layout: the renderer's only job is turning `GraphRow.edges` into SVG paths at a fixed lane width.
- If you needed to add a field to `GraphRow` (e.g. an overflow flag), name it in your completion notes — Phase 06 renders exactly the fields you export.
- The lane state must be carried in the caller's memo/store across pages; document in your notes where you expect Phase 06 to hold it (recommended: a `useRef` in `CommitGraph.tsx`, reset only when the **project** changes or the server's pinned tip snapshot becomes unusable — **not** on every `generation` bump, since a bump splices new commits above the snapshot rather than reloading).
- Splicing at the top is the one operation `appendCommits` does not cover: it appends *older* commits. If Phase 06 needs to prepend newer commits on a generation bump, either export a `prependCommits` that extends the lane state upward or state clearly in your notes that a prepend requires a full relayout — decide it here rather than leaving Phase 06 to improvise.
