# Phase 10: Hidden virtual list no longer crashes the app (#360)

- Goal: A virtual list that sits in a hidden, kept-mounted popup no longer drives React into its nested-update limit when its data changes, proven by a test that fails first with the real list library, and the Git Manager branch picker does no list work while it is closed.
- Round: 2
- Depends on: 6
- Owns: `patches/@legendapp__list@3.3.10.patch`, `pnpm-lock.yaml` (only the patch hash), `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx` and its tests, a new real-library regression test next to it, `apps/web/src/components/chat/ModelPickerContent.tsx` and its test (only if Task 10.1 shows the model picker has the same exposure and the library guard alone does not cover it)
- Must not touch: `apps/web/src/components/ui/popover.tsx` (Phase 6 changed it; the shared `keepMounted` stays), `apps/web/src/components/chat/MessagesTimeline*.tsx`, `apps/server/**`
- Skills: mstack-diagnose (the cause is supported, not confirmed: no probe has flipped it yet); tdd (each fix is red first); vercel-react-best-practices (required review of the changed component)
- Read first: `sources/issue-360.md` (the symbolized stack, the ranked hypotheses and the confirmation plan); `patches/@legendapp__list@3.3.10.patch` (the ten existing hunks, mirrored for both bundle formats); `apps/web/src/components/chat/MessagesTimeline.itemTypes.test.tsx` (the precedent for a real-library test with stubbed measurements); `AGENTS.md` (vendored dependency and patch rules); `UI.md` (the picker keeps its filter and selection)
- Checkpoint: from `apps/web`, `vp test run --project unit src/components/gitManager src/components/chat/MessagesTimeline.itemTypes.test.tsx src/components/chat/ModelPickerContent.test.tsx` exits 0, then `vp check <changed files>` and `vp run typecheck` exit 0, and `git grep -n '\[DEBUG-' -- apps packages patches` prints nothing.

## Tasks

### Task 10.1: Reproduce the nested-update crash with the real list library

- Satisfies: R48, R49 (diagnosis: Phase 1 to 4 of the diagnose method)
- Depends on: none
- Files: create `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.hidden.dom.test.tsx`
- Interfaces: consumes the real `@legendapp/list` and the real shared `Popover` (no mock of either); produces a failing test named "a closed branch picker survives a refs update with thousands of branches" and a logged verdict that names the list instance and the first wrong decision
- Skills: mstack-diagnose (reproduce, minimise, flip one variable before any fix)
- Read first: `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.test.tsx` (it mocks both the list and the popover, so it cannot see this failure); the installed `@legendapp/list` measurement path named in the issue
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `vp test run --project unit src/components/gitManager/toolbar/GitManagerBranchDropdown.hidden.dom.test.tsx` fails on current code with React's nested-update error (or, if the DOM test environment cannot produce it, the task ends with the recorded reason and the narrower reproduction it did achieve)

Steps

1. [ ] Write the test: mount the real branch dropdown with 4,000 local branches, measurements stubbed so that a row under a hidden ancestor measures 0 by 0 and a visible row measures 30 px high; open the picker, close it through the real popover, then replace the refs with a new array of the same size. Expected: the test file compiles and is the one the next step runs.
2. [ ] Run `vp test run --project unit src/components/gitManager/toolbar/GitManagerBranchDropdown.hidden.dom.test.tsx` from `apps/web`. Expected: FAIL with "Maximum update depth exceeded" (React error 185) raised from the list's layout effect.
3. [ ] Minimise: find the smallest row count that fails and which sequence is needed (never opened, opened then closed, refs replaced after close). Then flip one variable: make the hidden rows measure 30 px instead of 0. Expected: PASS with that one change, which confirms that the 0 by 0 measurement is the cause; restore the 0 by 0 stub and see it FAIL again.
4. [ ] Repeat the same sequence with the model picker's list (also in a kept-mounted popover) and record whether it fails too. Expected: a recorded yes or no with the row count used.
5. [ ] Log the verdict for the plan log: the list instance, the first wrong decision (the library recording a 0 by 0 rectangle as a row size, or the caller keeping the list mounted while hidden), the minimal sequence and count, and the confidence tier.

### Task 10.2: The list library ignores a 0 by 0 measurement

- Satisfies: R49
- Depends on: 10.1
- Files: modify `patches/@legendapp__list@3.3.10.patch`; modify `pnpm-lock.yaml` (patch hash only); test `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.hidden.dom.test.tsx` and a new `apps/web/src/lib/legendListHiddenMeasurement.dom.test.tsx`
- Interfaces: consumes the patched package through the normal dependency (`vp install` applies the patch); produces a guard in both bundle formats (ESM and CJS) on the direct layout-effect measurement path and on the deferred shrink confirmation
- Skills: tdd (the Task 10.1 test is the red test); mstack-diagnose (prove the guard, not a nearby change, flips the result)
- Read first: the upstream reports the issue links (the open pull request that proposes the same guard), read for the shape of the change only; `docs/reference/scripts.md` for how dependency patches are regenerated in this repository
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `vp test run --project unit src/components/gitManager/toolbar/GitManagerBranchDropdown.hidden.dom.test.tsx src/lib/legendListHiddenMeasurement.dom.test.tsx src/components/chat/MessagesTimeline.itemTypes.test.tsx` exits 0

Steps

1. [ ] Write `legendListHiddenMeasurement.dom.test.tsx` with a bare real list: visible 30 px rows, then hidden 0 by 0, then a data update, then visible again; assert no nested-update error, that the total size after hiding equals the size before, and that rows measure and render again after the reveal; include a case where a row really shrinks while visible and is accepted. Expected: the file compiles and is the one the next step runs.
2. [ ] Run the Done-when command. Expected: FAIL on the hidden cases, PASS on the visible shrink case.
3. [ ] Extend the patch: skip a 0 by 0 rectangle before the baseline is written on the direct measurement path, and add the same check in the deferred shrink confirmation, in both bundle formats; regenerate the patch the way the repository does and run `vp install`. Expected: the lockfile changes only in the patch hash.
4. [ ] Run the Done-when command. Expected: PASS.
5. [ ] Prove the tests can fail: remove the guard from the installed file by hand and rerun. Expected: FAIL. Reinstall and rerun. Expected: PASS.
6. [ ] Run the web unit suites that use the list: from `apps/web`, `vp test run --project unit src/components/chat src/components/gitManager src/components/pullRequests src/components/pipelines`. Expected: PASS, no change in the timeline tests.

### Task 10.3: The closed branch picker does no list work

- Satisfies: R50, R48
- Depends on: 10.2
- Files: modify `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx`; test `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.hidden.dom.test.tsx`, `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.test.tsx`
- Interfaces: consumes the popover's open state already held by the component; produces a list that is rendered only while the picker is open, with the filter text and the selection kept across close and reopen
- Skills: tdd (red first); vercel-react-best-practices (no effect added for derived state); better-interface (the picker reopens with its filter and the current branches)
- Read first: `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx` (the popup and list are not gated by the open flag today)
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `vp test run --project unit src/components/gitManager/toolbar` exits 0

Steps

1. [ ] Add a test: with the picker closed, a refs update renders no list row and calls no measurement; after reopening, the current branches show, the earlier filter text is still applied, and selecting a branch then fetching sends one checkout and one fetch. Expected: the test compiles and is the one the next step runs.
2. [ ] Run the Done-when command with the library guard temporarily removed by hand. Expected: FAIL (rows are rendered and measured while closed). Restore the guard.
3. [ ] Render the list only while the picker is open; keep the filter and selection state in the component, outside the gated part. Expected: the change is in place, and the next command step checks it.
4. [ ] Run the Done-when command. Expected: PASS.
5. [ ] Prove the test can fail: undo this task's change by hand and rerun the closed-picker case. Expected: FAIL on "renders no list row while closed". Restore it. Expected: PASS.
6. [ ] Run the phase Checkpoint. Expected: exit 0.
