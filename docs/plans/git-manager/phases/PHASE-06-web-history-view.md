# Git Manager / Phase 06 — Web history view and diffs

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax for tracking — tick them off in this file as you go.

**Goal:** Render the Git Manager's History tab — a virtualised, tip-pinned commit list with commit detail and per-file diffs — entirely from server-supplied data, with no third-party contact.

**Architecture:** This is the read-only History half of Slice 1 in `git-manager-plan.md` (§ Slices). It consumes the `gitManager.*` read RPCs landed by PHASE-00/PHASE-01 through the environment-scoped Effect Atom families in `packages/client-runtime/src/state/gitManager.ts`, never through raw RPC calls. Paging is pinned to the tip snapshot the server returns, so a generation bump splices new commits above the pinned pages instead of discarding them. Diffs reuse the existing `@pierre/diffs` worker pool (`apps/web/src/components/DiffWorkerPoolProvider.tsx`, `apps/web/src/lib/diffRendering.ts`) with the reference implementation's size ladder applied before parsing. Author identity is derived locally from the commit's name and email — no avatar host is contacted.

**Tech Stack:** React 19 / Vite+ / TanStack Router / zustand / Effect Atom — apps/web. Tailwind CSS 4 + @base-ui/react + lucide-react. Virtualization @legendapp/list; diffs @pierre/diffs. Test: `vp test <path>` (happy-dom, msw). Checks: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/gitManager/history/GitManagerHistoryView.tsx` — History tab shell: commit list + detail split.
- **Create:** `apps/web/src/components/gitManager/history/GitManagerCommitList.tsx` — virtualised 50px-row commit list with infinite paging.
- **Create:** `apps/web/src/components/gitManager/history/GitManagerCommitDetail.tsx` — commit metadata, changed-file list, per-file diff.
- **Create:** `apps/web/src/components/gitManager/history/commitPaging.ts` — pure paging/splicing logic and the LRU-backed commit lookup.
- **Create:** `apps/web/src/components/gitManager/history/commitPaging.test.ts`
- **Create:** `apps/web/src/components/gitManager/history/authorIdentity.ts` — deterministic local initials/identicon derivation.
- **Create:** `apps/web/src/components/gitManager/history/authorIdentity.test.ts`
- **Create:** `apps/web/src/components/gitManager/history/diffLadder.ts` — the size ladder classifier (spec § 8).
- **Create:** `apps/web/src/components/gitManager/history/diffLadder.test.ts`
- **Create:** `apps/web/src/components/gitManager/history/GitManagerHistoryView.test.tsx`
- **Create:** `apps/web/src/components/gitManager/history/GitManagerCommitDetail.test.tsx`
- **Modify:** `apps/web/src/gitManagerStore.ts` — add the History view-state slice only (selected commit sha, selected file path, loaded page cursors, scroll anchor). Do not touch slices owned by PHASE-03 or PHASE-05.
- **Modify:** `apps/web/src/state/gitManager.ts` — add the web wrapper for the `getCommits` / `getDiff` atoms if PHASE-01 did not already export it.

## Dependencies

- Phase 01: Server read modules and read RPCs
- Phase 03: Web panel shell: route, sidebar button, view-state store

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

5. `Skill(skill="vercel-react-best-practices")` — _keeping the virtualised commit list and diff renders from re-rendering per page_
6. `Skill(skill="web-design-guidelines")` — _keyboard navigation and labels for the commit list and diff controls_

## Documents to Read

- `AGENTS.md` — repo-wide required pre-work, evidence and completion rules.
- `docs/plans/git-manager/git-manager-spec.md` — scope and constraints; § 6.7 (local identity), § 8 (paging and diff ladder).
- `docs/plans/git-manager/git-manager-plan.md` — architecture and global constraints; the Client section governs atoms, caches and accessibility.
- `docs/plans/git-manager/research/github-desktop-analysis.md` — § 1.2 (history behaviour contracts), § 3.4 (exact diff limits), § 4.4 (row heights, batch size).
- `docs/plans/git-manager/research/bibcode-integration-surface.md` — § 3.4 and § 4 for the existing diff renderer and atom families.
- `docs/architecture/connection-runtime.md` — capability gating and reconnect behaviour the History tab must tolerate.
- `docs/reference/scripts.md` — the exact `vp` command names used below.

---

## Pre-execution check

- [ ] **Step 06.0: Claim the phase.** Open `../tasks.md`. Change Phase 06 row → `Status = in_progress`, `Agent = phase-06`, `Started = YYYY-MM-DD HH:MM`. Append a "started — picked up" entry under your Detailed Progress section.

## Atomic steps

- [ ] **Step 06.1: Locate the surface area being changed.**

  ```bash
  rg --files apps/web/src/components/gitManager
  rg -n "GitManagerCommitPage|GitManagerCommitEntry|GitManagerDiffSource|gitManager\." packages/contracts/src/gitManager.ts
  rg -n "export const|createEnvironmentRpcQueryAtomFamily" packages/client-runtime/src/state/gitManager.ts
  rg -n "getRenderablePatch|resolveFileDiffPath|buildFileDiffRenderKey" apps/web/src/lib/diffRendering.ts
  rg -n "FileDiff" apps/web/src/components/chat/MessagesTimeline.tsx
  sed -n '1,40p' apps/web/src/lib/lruCache.ts
  ```

  The landed `packages/contracts/src/gitManager.ts` is authoritative for the method names and field names used below (`gitManager.getCommits` and `gitManager.getDiff` are the expected names). There is **no** per-commit diff method: a commit diff is `gitManager.getDiff` carrying a `GitManagerDiffSource` of `{ _tag: "commit", sha, path }`, the same method the working-tree source (`{ _tag: "working-tree", path, staged }`) uses. Read `apps/web/src/gitManagerStore.ts` as PHASE-03 actually landed it before adding a slice. Record any deviation in the per-phase notes of `tasks.md`.

- [ ] **Step 06.2: Author the first failing test.**

  Path: `apps/web/src/components/gitManager/history/commitPaging.test.ts`

  ```ts
  import { describe, expect, it } from "vitest";
  import { spliceCommitGeneration } from "./commitPaging";

  describe("spliceCommitGeneration", () => {
    it("prepends new commits above the pinned pages and keeps loaded rows and their order", () => {
      const loaded = [{ sha: "b" }, { sha: "a" }];
      const result = spliceCommitGeneration({
        loaded,
        incoming: [{ sha: "c" }, { sha: "b" }],
        pinnedTips: ["b"],
      });
      expect(result.commits.map((commit) => commit.sha)).toEqual(["c", "b", "a"]);
      expect(result.requiresReset).toBe(false);
    });
  });
  ```

- [ ] **Step 06.3: Run the new test; expect FAIL** (the module does not exist yet).

  ```bash
  vp test apps/web/src/components/gitManager/history/commitPaging.test.ts
  ```

- [ ] **Step 06.4: Implement the minimum to make Step 06.2 pass.**

  Path: `apps/web/src/components/gitManager/history/commitPaging.ts`

  Export `spliceCommitGeneration({ loaded, incoming, pinnedTips })` returning `{ commits, requiresReset }`. Splice by sha identity: keep every loaded commit, prepend incoming commits not already loaded, and set `requiresReset` only when none of `pinnedTips` is present in `incoming` (the pinned snapshot can no longer be resolved). Never de-duplicate by index or `--skip` offset.

- [ ] **Step 06.5: Run the test; expect PASS.**

- [ ] **Step 06.6: Add the paging-trigger test and implementation.** In the same pair of files add `shouldLoadNextPage({ renderedIndex, totalRows, isLoading, lastRequestAtMs, nowMs })`: true only when `totalRows - renderedIndex <= 10`, not already loading, and at least 500 ms since the last request (GitHub Desktop's `CloseToBottomThreshold = 10` and its 500 ms re-entrancy guard; research § 1.2). Test the boundary at exactly 10 rows and the guard at 499/500 ms.

- [ ] **Step 06.7: Add the LRU commit-lookup test and implementation.** Add `createCommitLookup(maxEntries, maxMemoryBytes)` in `commitPaging.ts`, built on the existing `LRUCache` from `apps/web/src/lib/lruCache.ts` — do not write a new cache. Test that inserting beyond `maxEntries` evicts the least-recently-read sha and that a `get` promotes an entry. The spec forbids reproducing the reference implementation's unbounded map (spec § 8).

- [ ] **Step 06.8: Add the size-ladder test and implementation.**

  Path: `apps/web/src/components/gitManager/history/diffLadder.ts` and its test. Export `classifyDiffPayload({ byteLength, longestLineLength })` returning `"unrenderable" | "large-text" | "renderable"` using the reference constants verbatim (research § 3.4): `>= 70_000_000` bytes → `unrenderable` (never parsed); `>= 4_375_000` bytes → `large-text` (rendered only after an explicit "Show diff anyway"); any line longer than `5_000` characters → `large-text`. Call this **before** `getRenderablePatch`, so an oversized payload is never handed to the parser.

- [ ] **Step 06.9: Add the local author-identity test and implementation.**

  Path: `apps/web/src/components/gitManager/history/authorIdentity.ts` and its test. Export `deriveAuthorIdentity({ name, email })` returning `{ initials, hue, title }`, computed with the existing `fnv1a32` from `apps/web/src/lib/diffRendering.ts` over the lower-cased email. Assert determinism (same input → same output), that a name-less author falls back to the email local part, and — the constraint that matters — that the module contains **no URL and no fetch**: no `avatars.`, no `gravatar`, no `https://`.

- [ ] **Step 06.10: Build the commit list component.**

  Path: `apps/web/src/components/gitManager/history/GitManagerCommitList.tsx`. Use `LegendList` from `@legendapp/list/react` exactly as `apps/web/src/components/BranchToolbarBranchSelector.tsx` does (indicative: import at :7, usage at :749 — re-verify). Fixed 50px rows (spec § 8). Props: `{ commits, selectedSha, onSelect, onReachEnd, isLoadingMore }`. Every row is a `<button type="button">` with an accessible name of `${shortSha} ${subject}`; arrow keys move selection. Test in `GitManagerHistoryView.test.tsx` that reaching the tenth-from-last row calls `onReachEnd` once, not twice.

- [ ] **Step 06.11: Build the commit detail component.**

  Path: `apps/web/src/components/gitManager/history/GitManagerCommitDetail.tsx`. Render subject, body, short sha with a copy button, ref decorations, both identities (author and committer) via `deriveAuthorIdentity`, and the changed-file list at 29px rows. Selecting a file requests `gitManager.getDiff` through the atom family with `source: { _tag: "commit", sha, path }` (the selected commit's sha and the selected file's path), runs `classifyDiffPayload`, then `getRenderablePatch(patch, "git-manager-history:" + resolvedTheme)` and renders with `FileDiff` from `@pierre/diffs/react` inside the existing `DiffWorkerPoolProvider` — do not instantiate a second worker pool. Test: a `large-text` classification renders the "Show diff anyway" affordance and does **not** call the parser until it is pressed.

- [ ] **Step 06.12: Wire the view to the store and the atoms.**

  Path: `apps/web/src/components/gitManager/history/GitManagerHistoryView.tsx`. Read and write only the History slice of `apps/web/src/gitManagerStore.ts`, keyed by `(environmentId, projectId)`. Server data comes exclusively from the atoms in `apps/web/src/state/gitManager.ts`; a raw `request`/`runStream` call in this phase is a review rejection. Render the unavailable state PHASE-03 landed when the environment has no live session or lacks the capability flag — never dial a deliberately disconnected environment.

- [ ] **Step 06.13: Full build + test gate.**

  ```bash
  vp test apps/web/src/components/gitManager/history
  vp check
  vp run typecheck
  ```

  Expected: zero warnings, zero errors, all tests green.

- [ ] **Step 06.14: Stack-specific verification.** Launch the app, open the Git Manager on a repository with more than 200 commits, scroll the history past three pages, select a commit, select a file, and confirm the diff renders. Repeat against a remote-hosted project (spec § 10 requires both). With the browser devtools Network tab filtered to third-party hosts, confirm zero requests leave the app while the History tab is used.

- [ ] **Step 06.15: TDD proof.** Temporarily make `spliceCommitGeneration` return `incoming` unchanged and `classifyDiffPayload` return `"renderable"` unconditionally. Re-run `vp test apps/web/src/components/gitManager/history` and confirm the paging and ladder tests fail. Restore the real implementations and re-run.

- [ ] **Step 06.16: Mark phase complete.** Change Phase 06 row in `tasks.md` → `Status = completed`, `Finished = YYYY-MM-DD HH:MM`. Append a final summary entry: what was delivered, how many tests landed, any deviations from the plan.

> **No commit step.** This decomposition is commit-free: no phase ever produces or requests a git commit. Whether and when to commit the resulting work is a decision the user makes after execution, outside the scope of any phase.

---

## Verification

- [ ] History paging is tip-pinned: a new commit arriving mid-scroll splices above the loaded pages, preserving scroll position and selection; no row is duplicated or dropped.
- [ ] The commit lookup is LRU-bounded and reuses `apps/web/src/lib/lruCache.ts`.
- [ ] The diff size ladder (70MB / ~4.375MB / 5000-char line) is applied before parsing, and `large-text` requires an explicit user action.
- [ ] Author identity renders from local data only; the phase's files contain no URL, `fetch`, or image host.
- [ ] Every icon-only control has an `aria-label`; the commit list is keyboard-navigable.
- [ ] All new tests green; `vp test apps/web/src/components/gitManager/history` passes.
- [ ] `vp check` clean and `vp run typecheck` clean.
- [ ] **Zero-telemetry check:** this phase added no analytics, crash reporting, usage counters, remote feature flags, avatar or identity fetches, third-party host contact, and no new dependency in `apps/web/package.json`.
- [ ] Final `git diff` and `git status --short` reviewed for unintended edits, generated files, debug output and dependency drift.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- **Exports other phases consume.** `spliceCommitGeneration`, `shouldLoadNextPage`, `createCommitLookup` from `apps/web/src/components/gitManager/history/commitPaging.ts`; `classifyDiffPayload` from `./diffLadder.ts`; `deriveAuthorIdentity({ name, email }) => { initials, hue, title }` from `./authorIdentity.ts`.
- **PHASE-14 (partial staging gutter)** renders on top of `getRenderablePatch` output, not on a second parser. It must reuse `classifyDiffPayload` so an oversized file is never made interactive.
- **PHASE-15 (history rewriting UI)** owns commit context menus and drag-to-cherry-pick. `GitManagerCommitList` exposes `onSelect: (sha: string) => void` and `onContextMenu: (sha: string, event: React.MouseEvent) => void` — pass stable, memoised callbacks; the list is virtualised and re-renders on identity change.
- **PHASE-16 (image diffs)** extends `classifyDiffPayload` with an image branch rather than bypassing it.
- **Store contract:** the History slice of `apps/web/src/gitManagerStore.ts` is keyed by `(environmentId, projectId)` and holds `{ selectedSha, selectedFilePath, loadedCursors, scrollAnchor }`. It holds **view state only** — the commit-message draft is not stored here (see PHASE-08).
- **Divergence recorded:** `apps/web/src/components/DiffWorkerPoolProvider.tsx` already caps highlighting via `tokenizeMaxLineLength: 1_000`; the reference implementation's 1MB syntax-highlight cap is therefore already satisfied by the existing pool and is not re-implemented.
