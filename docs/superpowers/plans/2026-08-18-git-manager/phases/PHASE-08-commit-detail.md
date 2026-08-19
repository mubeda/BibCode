# Git Manager / Phase 08 — Commit detail pane with diff

> **For agentic workers:** REQUIRED SUB-SKILL: invoke `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` before touching code. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go.

**Goal:** Show the selected commit's metadata, parents, refs and changed files, and render the diff of the selected file.

**Architecture:** Implements the client half of § "Phase 4 — Commit detail and diff" of `../master-plan.md`. Owns `CommitDetailRegion.tsx`; consumes `useGitManagerReads` (Phase 02) for `vcs.commitDetail` / `vcs.commitDiff` and the existing diff helpers in `apps/web/src/lib/diffRendering.ts` with `@pierre/diffs` — no new diff machinery, no new dependency.

**Tech Stack:** React 19 + TypeScript, `@pierre/diffs`, existing `lib/diffRendering.ts` helpers, Tailwind via `cn()`. Test: `vp test apps/web/src/components/git-manager`. Gates: `vp check`, `vp run typecheck`.

---

## Files

- **Create:** `apps/web/src/components/git-manager/CommitDetailPane.tsx` + `CommitDetailPane.test.tsx` — metadata, parents, refs, and the diff viewport.
- **Create:** `apps/web/src/components/git-manager/CommitFileList.tsx` + `CommitFileList.test.tsx` — changed files with status and ± counts.
- **Modify:** `apps/web/src/components/git-manager/CommitDetailRegion.tsx` — replace the Phase 02 placeholder.

## Dependencies

- Phase 02: Project route, panel shell, store, sidebar button.
- Phase 06: Virtualized commit graph (provides `selectedCommitSha` in the store).

## Owner Agent

`general-purpose`

## Risk / Effort

Risk: Medium (diff rendering has real edge cases: binary, rename, truncation, root commit). Effort: ~2.5 h.

---

## Skills to Invoke (teammate-side)

**Always-on:**

1. `Skill(skill="superpowers:using-superpowers")` — establish skill discipline
2. `Skill(skill="superpowers:subagent-driven-development")` — execution discipline for this phase
3. `Skill(skill="superpowers:test-driven-development")` — red-green-refactor for the file-list and diff states
4. `Skill(skill="superpowers:verification-before-completion")` — required gate before marking complete

**Matched for this phase:**

5. `Skill(skill="vercel-react-best-practices")` — avoid re-rendering the diff on every selection change
6. `Skill(skill="web-design-guidelines")` — readable diff typography and keyboard-navigable file list

## Documents to Read

- `../master-plan.md` — § Phase 4 (client paragraph), § Acceptance Criteria 7.
- `../screenshots/SCR-20260817-pytb.png` (Commit tab: author, refs, sha, parents, file list) and `../screenshots/SCR-20260817-pywo.jpeg` (Changes tab: file tree + diff).
- `apps/web/src/lib/diffRendering.ts` — `getRenderablePatch`, `resolveDiffThemeName`, `buildFileDiffRenderKey`, `resolveFileDiffPath`; use these rather than parsing patches yourself.
- `apps/web/src/components/DiffPanel.tsx` — reference only. It is thread-scoped and coupled to checkpoints; copy the rendering approach, not the component.
- `apps/web/src/state/gitManager.ts` — `commitDetail` and `commitDiff` reads.
- `apps/web/src/gitManagerStore.ts` — `selectedCommitSha`, `selectedFilePath`.

---

## Pre-execution check

- [ ] **Step 08.0: Claim the phase.** Set Phase 08 in `../tasks.md` → `in_progress`, `Agent = phase-08`, `Started = YYYY-MM-DD HH:MM`; append a "picked up" line.

## Atomic steps

- [ ] **Step 08.1: Locate the surface area.**

	```bash
	grep -n "export function" apps/web/src/lib/diffRendering.ts
	grep -rn "@pierre/diffs" apps/web/src | head
	```

	Read how an existing consumer feeds a patch into `@pierre/diffs` and what theme handling it does. Record deviations in `../tasks.md`.

- [ ] **Step 08.2: Author the first failing test** — `CommitFileList.test.tsx`:

	```tsx
	it("renders status, path and counts, and selects a file on click", async () => {
	  const onSelect = vi.fn();
	  render(<CommitFileList files={[
	    { path: "apps/web/src/a.ts", previousPath: null, status: "modified", additions: 3, deletions: 1, isBinary: false },
	    { path: "assets/logo.png", previousPath: null, status: "added", additions: 0, deletions: 0, isBinary: true },
	  ]} selectedFilePath={null} onSelect={onSelect} truncated={false} />);
	  await userEvent.click(screen.getByText("apps/web/src/a.ts"));
	  expect(onSelect).toHaveBeenCalledWith("apps/web/src/a.ts");
	  expect(screen.getByText("assets/logo.png")).toBeInTheDocument();
	});
	```

- [ ] **Step 08.3: Run it; expect FAIL** — component not found.

	```bash
	vp test apps/web/src/components/git-manager/CommitFileList.test.tsx
	```

- [ ] **Step 08.4: Implement `CommitFileList.tsx`** — status icon/letter, path (with `previousPath → path` for renames), `+n/−m` counts, binary marker, selection state.

- [ ] **Step 08.5: Run the test; expect PASS.**

- [ ] **Step 08.6: Add file-list cases** — a rename shows both paths; a binary file shows the binary marker and no counts; `truncated: true` renders a "file list truncated" notice naming that more files exist.

- [ ] **Step 08.7: Write the failing detail-pane test.** Given a mocked `commitDetail`, assert: subject, full body, author name + date, short sha, ref badges, and parent shas render; clicking a parent sha calls the selection action with that sha.

- [ ] **Step 08.8: Implement `CommitDetailPane.tsx`** — metadata block + `CommitFileList` + diff viewport. Selecting a file sets `selectedFilePath` in the store and triggers the `commitDiff` read; the patch renders through `getRenderablePatch` with the theme from `resolveDiffThemeName`.

- [ ] **Step 08.9: Add the diff-state tests** — loading state while the diff resolves; a binary file renders the placeholder instead of a patch; a truncated diff renders the truncation notice; a root commit (`baseRef: null`) renders its full added content without erroring; a failed read renders an error state with a retry that re-issues the read.

- [ ] **Step 08.10: Add the empty-selection test** — with no commit selected, the pane renders a neutral empty state and issues no reads.

- [ ] **Step 08.11: Mount in `CommitDetailRegion.tsx`** and assert through the shell test that the region renders the pane.

- [ ] **Step 08.12: Accessibility + performance pass.** File list is keyboard-navigable with an accessible selected state; the diff container scrolls independently; changing selection does not re-render the graph (assert with a render counter or memo boundary test).

- [ ] **Step 08.13: Full gate.**

	```bash
	vp test apps/web/src/components/git-manager
	vp run typecheck
	vp check
	```

- [ ] **Step 08.14: Run it for real.** Select several commits including a merge, a rename-heavy commit, and one touching a binary file; confirm the diff renders and the pane stays responsive. `superpowers:verification-before-completion` is mandatory here.

- [ ] **Step 08.15: TDD proof.** Make `CommitFileList` ignore its `selectedFilePath` prop, re-run — the selection tests must fail. Restore, re-run, confirm green.

- [ ] **Step 08.16: Mark complete.** Phase 08 row → `completed`, `Finished = YYYY-MM-DD HH:MM`, plus a summary.

> **No commit step.** This plan is commit-free.

---

## Verification

- [ ] Selecting a commit shows subject, body, author, dates, short sha, refs, parents and the changed-file list.
- [ ] Clicking a parent sha selects that commit.
- [ ] Selecting a file renders its patch; binary, truncated, root-commit and error states each render a clear, distinct state.
- [ ] No commit is selected → neutral empty state, no reads issued.
- [ ] Diff rendering goes through `lib/diffRendering.ts` + `@pierre/diffs`; no new parsing and no new dependency.
- [ ] Changing the selected file does not re-render the commit graph.
- [ ] `vp test` (scoped), `vp run typecheck`, `vp check` clean; exercised in the running app.
- [ ] TDD-proof step performed and described in the per-phase notes.

## Notes for downstream phases

- Phase 12 documents the panel layout; record in your notes where the detail pane sits (bottom band vs right column) and whether it is resizable, so the docs match what shipped.
- If the server's `filesTruncated` cap turned out to be too small for real commits, say so in `../tasks.md` § Coordination Notes rather than raising it unilaterally — the cap lives in Phase 01's `graph.rs`.
- Note the memoization boundary you used between graph and detail; Phase 11's live refresh must not invalidate it on every generation bump.
