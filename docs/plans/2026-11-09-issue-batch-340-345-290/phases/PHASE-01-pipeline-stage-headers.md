# Phase 1: Pipeline stage headers

- Goal: Every stage header in the pipeline detail view reads as a group label, distinct from job rows at wide and stacked widths, with tests (#340).
- Round: 1
- Depends on: none
- Owns: `apps/web/src/components/pipelines/detail/PipelineStageColumns.tsx`, `apps/web/src/components/pipelines/detail/PipelinesDetailView.test.tsx`
- Must not touch: `apps/web/src/index.css` (Phase 7), `apps/web/src/components/pullRequests/**`, every other file
- Skills: test-driven-development (write the header assertions before restyling); vercel-react-best-practices (AGENTS.md requires it for changed React components)
- Read first: `spec.md` section A (R1, R2, D10); `UI.md` (Typography and Colors rules bind the header style); `AGENTS.md` (completion requirements)
- Checkpoint: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/pipelines/detail/PipelinesDetailView.test.tsx` exits 0. A reader of the detail view sees each stage name on a muted strip in small uppercase text.

## Tasks

### Task 1.1: Restyle the stage header as a group label

- Satisfies: R1 (multi-stage pipeline; other column kinds and neighbors stay as they are), R2 (heading content)
- Depends on: none
- Files: modify `apps/web/src/components/pipelines/detail/PipelineStageColumns.tsx`; test `apps/web/src/components/pipelines/detail/PipelinesDetailView.test.tsx`
- Interfaces: consumes `ROW_CLASS` and `NAME_CLASS` (module constants, lines 26-28) and the private `PipelineStage` component (lines 176-215); produces a module constant `STAGE_HEADER_CLASS` used by the `h3` at line 189. No export changes.
- Skills: ui-ux-pro-max (pick header weight and surface that hold in dark mode)
- Read first: `apps/web/src/components/SourceControlSection.tsx` line 27 and `apps/web/src/components/ui/dialog.tsx` line 127 (the existing group-label text style and muted strip to reuse)
- Tier: standard
- TDD: red-green
- Done when: `node ../../scripts/run-local-vp.mjs test run --project unit src/components/pipelines/detail/PipelinesDetailView.test.tsx` (run from `apps/web`) exits 0 with the three new tests passing and no existing test changed except by addition

Steps

1. [ ] In `PipelinesDetailView.test.tsx`, add `stage headers use a header surface and text style no job row uses`: render the three-stage fixture, read each `li h3` class list and each job row class list, and assert the header has `bg-muted`, `text-xs`, `font-semibold`, `uppercase` and `tracking-wide`, that no job row has `bg-muted` or `uppercase`, and that the header has none of `text-sm` or `hover:bg-accent`. Assert the same for the `Layer 1` header in the job-dependencies fixture and the `Jobs` header in the GitHub fixture.
2. [ ] Add `stage header keeps one treatment when columns stack`: assert the header class list contains no `@min-[720px]/pipeline:` variant that removes `bg-muted`, `uppercase` or `text-xs`.
3. [ ] Add `stage header is a heading with status, name and count`: for stage `test` with status passed and 3 jobs, assert `getByRole("heading", { level: 3, name: /passed.*test.*3 jobs/i })` exists and that the existing `h3` `textContent` expectations at lines 505-508 and 592 (`"build1 job"`, `"Jobs2 jobs"`) still hold.
4. [ ] Run `node ../../scripts/run-local-vp.mjs test run --project unit src/components/pipelines/detail/PipelinesDetailView.test.tsx` from `apps/web`. Expected: FAIL, the first new test reports the header lacks `bg-muted`.
5. [ ] In `PipelineStageColumns.tsx`, add `const STAGE_HEADER_CLASS = "flex min-h-7 min-w-0 items-center gap-2 rounded-md bg-muted px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"` and use it on the `h3`. Keep the status icon span, the `truncate` name span and the count span and their order. The count span drops `font-normal` to `font-medium normal-case`. Change no visible text.
6. [ ] Run the same command. Expected: PASS, all tests in the file.
7. [ ] Prove the test can fail: replace `bg-muted` with `bg-transparent` in `STAGE_HEADER_CLASS`, run the same command. Expected: FAIL. Restore the class and run it again. Expected: PASS.
8. [ ] Review the changed component against `vercel-react-best-practices` and `UI.md`, and record both results for the final report. Solid `text-muted-foreground` is required; alpha-reduced text is not allowed (UI.md, Colors).
9. [ ] Run `vp check` from the repository root and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.
