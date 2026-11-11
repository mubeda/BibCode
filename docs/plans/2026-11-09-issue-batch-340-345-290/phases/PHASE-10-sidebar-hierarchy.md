# Phase 10: Sidebar hierarchy

- Goal: The left panel shows the repository card, environment band, primary checkout, worktrees and chat rows as five distinct levels in every built-in theme, and themes can style each level, with a reviewed design note, a fixture preview and tests (amendment A9; R63 to R65).
- Round: 3
- Depends on: 7, 9
- Owns: `packages/contracts/src/theme.ts`, `apps/web/src/index.css` (sidebar tokens and level rules), `apps/web/src/themes/**`, `apps/web/src/components/settings/ThemeEditor.tsx` and its preview, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/Sidebar.logic.ts`, `apps/web/src/components/sidebar/**`, their tests, `scripts/lib/theme-bootstrap*` (token list only), `docs/plans/2026-11-09-custom-themes-design.md`, `docs/plans/2026-11-11-sidebar-hierarchy-design.md`
- Must not touch: `apps/server/**`, `apps/desktop/**` (Task 8.2 adds the end-to-end case), `apps/web/src/components/files/**`, `apps/web/src/components/settings/AppearanceSettingsPanel.tsx`, `docs/plans/2026-11-09-issue-batch-340-345-290/**`
- Skills: test-driven-development (tokens, attributes and contrast start from failing tests); ui-ux-pro-max and better-colors (the level look and its contrast); vercel-react-best-practices (AGENTS.md requires it; the sidebar is a hot path)
- Read first: `spec.md` R63 to R65 and D21, R50, R54 to R57; issue #290 section "Extension"; `UI.md`; `apps/web/src/components/Sidebar.logic.ts` lines 1008-1040 (the card states the user refined on 2026-09-25, which R64 keeps); `docs/plans/2026-11-09-custom-themes-design.md`
- Checkpoint: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/themes src/components/settings src/components/Sidebar.test.tsx src/components/sidebar` exits 0. In the app, the theme editor's Sidebar group previews five levels, and the left panel shows them in Light, Dark and Tokyo Night.

The user approves the look between the two tasks, from screenshots of the fixture preview in Light, Dark and Tokyo Night. Task 10.2 does not start before that approval. One lane at a time writes `Sidebar.tsx`.

## Tasks

### Task 10.1: Sidebar level tokens, their styles and the editor preview

- Satisfies: R65 (old theme file; custom worktree color; unreadable level), R63 (fixture sidebar, on the preview)
- Depends on: none
- Files: create `docs/plans/2026-11-11-sidebar-hierarchy-design.md`; create `apps/web/src/components/settings/SidebarLevelsPreview.tsx` and its test; modify `packages/contracts/src/theme.ts`; modify `apps/web/src/index.css`; modify `apps/web/src/themes/baseTokenValues.ts`; modify `apps/web/src/themes/themeColor.ts`; modify the four files in `apps/web/src/themes/builtin/`; modify `apps/web/src/components/settings/ThemeEditor.tsx`; modify `docs/plans/2026-11-09-custom-themes-design.md`
- Interfaces: produces the eight tokens of R65 in `UI_COLOR_TOKENS`, their base formulas and resolved values for light and dark, their values in each built-in file where the base value does not fit, new entries in `FIXED_PAIRS` for the level text and surface pairs, CSS rules keyed on `[data-sidebar-level="repo|environment|checkout|worktree|chat"]` and `[data-primary]`, and a `SidebarLevelsPreview` component that renders fixture data with those attributes. Task 10.2 consumes the attributes and rules.
- Skills: none
- Read first: `apps/web/src/themes/themeColor.ts` lines 185-215 (`FIXED_PAIRS`); `apps/web/src/components/settings/ThemeEditor.tsx` lines 60-100 (token groups)
- Tier: most capable
- TDD: red-green
- Done when: the phase checkpoint command exits 0 with the new tests passing, and `vp test run scripts` exits 0

Steps

1. [ ] Write the design note: the five levels and how each differs without color (surface, accent rule, badge with icon, label weight, branch icon, indent guide, size), the eight tokens with their base formulas, the computed contrast of every new pair in all six built-ins, how R64's states sit on top, the alternatives of D21, and where the styles live. Expected: every pair is at or above 4.5:1, or the built-in file sets a value that is.
2. [ ] Write failing tests: every R65 token is in the contracts list and has a base value for light and dark; a theme file without them decodes and resolves them from its base; each built-in resolves the level surfaces and markers to pairwise distinct values and passes the fixed pairs; the editor's Sidebar group lists them; the preview renders the five levels with their attributes and `data-primary`; an import with an unreadable badge pair falls back per R55. Run the checkpoint command. Expected: FAIL on the missing tokens and component.
3. [ ] Add the tokens, formulas, CSS rules, built-in values, pairs, the preview and its place in the editor. Run the checkpoint command. Expected: PASS.
4. [ ] Prove a test can fail: set `sidebar-worktree` equal to `sidebar-card` in one built-in and see the distinctness test fail, then restore.
5. [ ] Take screenshots of the preview in Light, Dark and Tokyo Night from an isolated dev build, saved outside the repository, for the user's approval.
6. [ ] Run `vp check`, `vp run typecheck` and `vp test run scripts`. Expected: no errors.

### Task 10.2: The left panel draws the five levels

- Satisfies: R63 (fixture sidebar; primary without reading the badge), R64 (states on a worktree)
- Depends on: 10.1
- Files: modify `apps/web/src/components/Sidebar.tsx`; modify `apps/web/src/components/Sidebar.logic.ts`; modify `apps/web/src/components/sidebar/SidebarRepositoryGroup.tsx`, `WorkspaceCard.tsx` and `WorkspaceMoreChats.tsx`; modify their tests
- Interfaces: consumes the attributes and rules of Task 10.1; produces `data-sidebar-level` on the repository card, the environment band, checkout rows, worktree rows and chat rows (the "N more chats" and hidden-worktrees rows count as chat level) and `data-primary` on the primary checkout, in the Environments and the Repositories view. Task 8.2 reads these attributes.
- Skills: none
- Read first: `apps/web/src/components/Sidebar.tsx` lines 1170-1190, 1520-1535, 3380-3395, 3840-3855 and 4195-4210; `apps/web/src/components/sidebar/WorkspaceCard.tsx`
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run` exits 0 with the new tests passing

Steps

1. [ ] Write failing tests in the Sidebar tests: a fixture with one repository, two environments, a primary checkout, two worktrees and chats carries each level attribute in both views; the primary checkout has `data-primary`, its icon and its heavier label; a worktree has the branch icon; the selected, active, multi-selected and unavailable states still produce their classes. Run them. Expected: FAIL on the missing attributes.
2. [ ] Set the attributes and markers, keeping `SIDEBAR_CARD_CLASS` and `resolveWorkspaceCardClassName` states. Add no subscription or effect. Run the tests. Expected: PASS.
3. [ ] Run the full web suite. Expected: PASS.
4. [ ] Check the left panel in an isolated dev build in Light, Dark and Tokyo Night with fixture projects; save screenshots outside the repository.
5. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors.
