# Phase 4: Update install guard

- Goal: A remote update install keeps Files edits held across a reload, a lost ended event and a source registered mid-install, the installing dialog always has a way out, and the desktop event names are tied by a test, each with a failing-first test.
- Round: 1
- Depends on: none
- Owns: `apps/web/src/components/files/unsavedFileEdits.ts`, `apps/web/src/components/files/unsavedFileEdits.test.ts`, `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx`, `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx`, `apps/web/src/components/RemoteUpdateRequestNotifier.tsx` and its test (only if Task 4.4 shows the action is unreachable), new `scripts/desktop-event-names.test.ts`
- Must not touch: `apps/web/src/tauriDesktopBridge.ts` and `apps/desktop/src-tauri/**` (read only), `apps/web/src/components/ThreadTerminalPanel.tsx`, `apps/web/src/components/ui/**`
- Skills: `tdd` (every task is a behavior change with a failing test first), `vercel-react-best-practices` (the dialog and host are React), `better-interface` (new button and text need the UI.md review)
- Read first: `AGENTS.md` (completion rules, sensitive data); `UI.md` (a dialog needs a way out, disabled states explain themselves); `docs/architecture/overview.md` section on the desktop close protocol and `desktop:update-install-ended` (current contract); `docs/plans/2026-11-10-desktop-save-and-close-design.md` (R62 and the event table)
- Checkpoint: `cd apps/web && vp test run --project unit src/components/files/unsavedFileEdits.test.ts src/components/files/UnsavedChangesCloseDialog.test.tsx` and `vp test run scripts/desktop-event-names.test.ts` from the repository root both exit 0, then `vp check` and `vp run typecheck` exit 0

Facts confirmed in source (bridge contract, `packages/contracts/src/ipc.ts`): `getUpdateState: () => Promise<DesktopUpdateState>`, `onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void`, `onUpdateInstallEnded?: (listener: () => void) => () => void`. `DesktopUpdateState.requestedBy` is a requester or `null`/absent; `phase` is one of `idle`, `checking`, `available`, `protecting`, `installing`, `failed`. In Rust, `requestedBy` is cleared when the remote flow returns on every path, and `phase` becomes `protecting` then `installing` only after the window allowed the install. "A remote install is in progress" therefore means `requestedBy` is set and `phase` is `protecting` or `installing`.

## Tasks

### Task 4.1: Hold a source registered during the install

- Satisfies: R37. Given an install the window allowed, When a registry registers a source after the block began, Then its saving is held until the install ends.
- Depends on: none
- Files: modify `apps/web/src/components/files/unsavedFileEdits.ts`; test `apps/web/src/components/files/unsavedFileEdits.test.ts`
- Interfaces: consumes `UnsavedSource.holdSavingForLeave(): () => void`, `registerUnsavedSource(source: UnsavedSource): () => void`; produces the module-level `updateInstall` as `{ readonly holds: (() => void)[]; readonly release: () => void } | null`, where `release` releases every hold in `holds`, and `registerUnsavedSource` pushes `source.holdSavingForLeave()` onto `holds` while `updateInstall !== null`. No exported signature changes.
- Skills: tdd (red-green cycle)
- Read first: `apps/web/src/components/files/unsavedFileEdits.ts` (`blockForUpdateInstall`, `endUpdateInstall`, `registerUnsavedSource`); `apps/web/src/components/files/fileEditingSessionRegistry.ts` (`holdSavingForLeave` is idempotent)
- Tier: standard
- TDD: red-green
- Done when: `cd apps/web && vp test run --project unit src/components/files/unsavedFileEdits.test.ts` exits 0 and the new test is listed as passed

Steps

1. [ ] Write the failing test `a source registered during an update install is held until the install ends` in `unsavedFileEdits.test.ts`, inside the "desktop close requests" describe. Use `fakeSource` for one source, start an `update` close request, answer allow, then register a second `fakeSource` and assert its `holdSavingForLeave` was called once; fire the ended event and assert the returned release ran once.
2. [ ] Run `cd apps/web && vp test run --project unit src/components/files/unsavedFileEdits.test.ts -t "registered during an update install"`. Expected: FAIL with `holdSavingForLeave` called 0 times.
3. [ ] In `unsavedFileEdits.ts` change `blockForUpdateInstall` to keep its holds in a mutable array on `updateInstall`, and make `registerUnsavedSource` push a hold onto it while `updateInstall !== null`.
4. [ ] Run the same command. Expected: PASS.
5. [ ] Prove the test can fail: remove the push in `registerUnsavedSource`, run the command. Expected: FAIL. Restore it and run again. Expected: PASS.
6. [ ] Run `vp check apps/web/src/components/files/unsavedFileEdits.ts apps/web/src/components/files/unsavedFileEdits.test.ts`. Expected: no errors.

### Task 4.2: Restore the block when the window loads during an install

- Satisfies: R35. Given a window that reloads while the desktop reports `requestedBy` set and `phase` `protecting` or `installing`, Then edits are blocked again and the installing dialog shows. A desktop without `getUpdateState` counts as "not installing". A query that fails (rejects, or gives no answer within 5 seconds) is retried and never releases a block.
- Depends on: 4.1
- Files: modify `apps/web/src/components/files/unsavedFileEdits.ts`; test `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx`
- Interfaces: consumes `DesktopBridge["getUpdateState"]` and `["onUpdateState"]`; changes `respondToDesktopCloseRequests(bridge: Pick<DesktopBridge, "onCloseRequest" | "replyCloseRequest" | "onUpdateInstallEnded" | "getUpdateState" | "onUpdateState">): () => void` (the last two optional at runtime); produces the non-exported `isRemoteInstallRunning(state: DesktopUpdateState | null | undefined): boolean` and `askInstallState(bridge, onAnswer: (running: boolean) => void): () => void`, which returns its cancel function. Used again by task 4.3.
- Retry rule: `askInstallState` calls `getUpdateState()` with a 5 second timeout. A rejection or timeout is not an answer: it logs once with `console.warn` and asks again every 2 seconds, without limit. The loop stops on the first confirmed answer, on any state pushed by `onUpdateState` (a push is a confirmed answer), and on cleanup. A confirmed answer that is not `isRemoteInstallRunning` releases a block; a failure never does.
- Before the first answer: a fresh load or reload holds nothing. The window cannot know, a reload has lost the block, and holding every save on a guess would stall editing on every start. If the answer is "running", `blockForUpdateInstall()` holds all sources, including ones registered meanwhile (4.1). This differs from a known block (the module already has `updateInstall`): there a failed query changes nothing, so the block stays.
- Skills: tdd (red-green cycle)
- Read first: `apps/web/src/components/files/unsavedFileEdits.ts` (`respondToDesktopCloseRequests`); `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx` (describe "a remote update install the window allowed")
- Tier: most capable
- TDD: red-green
- Done when: `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx` exits 0 with the new tests passed

Steps

1. [ ] In the describe "a remote update install the window allowed", extend the fake bridge so `getUpdateState` and `onUpdateState` can be set per test; use fake timers for the retry tests. Write the failing test `a window that loads during an install blocks saving and shows the installing dialog`: state `{ requestedBy: { label: "Test User", detail: null }, phase: "installing" }`, an unsaved session, mount the host, assert the dialog text contains "Installing an update" and that no write happens after the autosave delay (`afterTheSaveDelay`).
2. [ ] Write the failing test `a reload during an install whose first query rejects keeps asking and then ends the block`: first call rejects; assert nothing is blocked yet and the query is asked again after 2 seconds; the second call answers running, so the dialog shows and saving is held; a third (via the next recheck or a pushed state) answers `{ requestedBy: null, phase: "idle" }` and the block ends and saving resumes. Add `a failed query never releases a known block` (block started through the close protocol, `getUpdateState` rejects or hangs past 5 seconds: the dialog stays and the query repeats) and `a pushed update state ends the wait`.
3. [ ] Write `a desktop without getUpdateState does not block` (member absent: no dialog, `session.flush()` saves, no timer left running).
4. [ ] Run `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx -t "loads during an install|first query rejects|known block|pushed update state ends|without getUpdateState"`. Expected: FAIL (no dialog, no retry); the absent-member test passes already.
5. [ ] Implement `isRemoteInstallRunning` and `askInstallState` and call it from `respondToDesktopCloseRequests` on subscribe; cancel it in the returned cleanup.
6. [ ] Run the same command. Expected: PASS.
7. [ ] Prove the tests can fail: make a rejection count as "not running", run. Expected: the rejects and known-block tests FAIL. Restore and run. Expected: PASS.
8. [ ] Run `vp check` on the two files. Expected: no errors.

### Task 4.3: Give the installing dialog a way out

- Satisfies: R36. Given the ended event never arrives, When the update state shows no remote install in progress, Then the dialog closes and editing resumes. Given the dialog is up, Then a button asks the desktop for the state again.
- Depends on: 4.2
- Files: modify `apps/web/src/components/files/unsavedFileEdits.ts`, `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx`; test `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx`
- Interfaces: consumes `onUpdateState(listener)` and `getUpdateState()` from the bridge, `isRemoteInstallRunning` from 4.2; produces `export function recheckUpdateInstall(): Promise<void>` in `unsavedFileEdits.ts` (asks through `askInstallState` from 4.2 and, only on a confirmed answer with `!isRemoteInstallRunning(state)`, calls the existing `endUpdateInstall`; a rejection or timeout keeps the dialog and the block, logs, and the 4.2 retry rule applies). The dialog button label is "Check again". Subscription: `respondToDesktopCloseRequests` also subscribes to `onUpdateState` and ends the install when a pushed state is not a running remote install, unsubscribed in its returned cleanup. No polling.
- Skills: tdd (red-green cycle); better-interface (new button, new text, UI.md review); vercel-react-best-practices (dialog component change)
- Read first: `UI.md` (Buttons and Actions, Errors, Progress and Feedback); `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx` (`UpdateInstallingDialog`, `UnsavedChangesCloseHost`)
- Tier: standard
- TDD: red-green
- Done when: `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx src/components/files/unsavedFileEdits.test.ts` exits 0

Steps

1. [ ] Write the failing test `a pushed update state with no remote install closes the installing dialog` (fake bridge captures the `onUpdateState` listener; after allow, push `{ requestedBy: null, phase: "idle" }`; assert the dialog is gone, saving resumes, and the "The update did not install" toast was added).
2. [ ] Write the failing test `Check again asks the desktop for the state and closes the dialog when no install runs`: dialog shows a button named "Check again"; `getUpdateState` resolves a not-running state; click; assert the dialog closes. Also `Check again with an install still running keeps the dialog`, and `a rejecting state query keeps the dialog, the block and the button, and the 4.2 retry keeps asking`.
3. [ ] Run `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx -t "pushed update state|Check again|rejecting state"`. Expected: FAIL (no such button, dialog stays).
4. [ ] Implement the `onUpdateState` subscription and `recheckUpdateInstall`, and add the "Check again" `Button variant="outline"` in a footer of `UpdateInstallingDialog` with a disabled state while the query runs. The description keeps its current text and gains one sentence: "If it seems stuck, check again." UI.md review: confirm the dialog now has a visible exit, the button is not the primary action, and Escape still does nothing while an install may restart the app.
5. [ ] Run the same command. Expected: PASS.
6. [ ] Prove the tests can fail: remove the `endUpdateInstall` call in `recheckUpdateInstall`, run. Expected: FAIL. Restore and run. Expected: PASS.
7. [ ] Run `vp check` on the changed files and `vp run typecheck`. Expected: no errors. Record the React and UI.md review outcome in the final report.

### Task 4.4: Decide whether the dialog hides the Manage devices toast

- Satisfies: R39 (decide by test). Given the installing dialog open over the remote-update toast, Then either the toast action is reachable (the test stays as proof) or the action is made reachable from the dialog.
- Depends on: 4.3
- Files: modify `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx`; only on a defect, modify `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx` and `apps/web/src/components/RemoteUpdateRequestNotifier.tsx`; test `apps/web/src/components/RemoteUpdateRequestNotifier.test.tsx` on a defect
- Interfaces: consumes `RemoteUpdateRequestNotifier({ onManageDevices })` and the toast manager from `~/components/ui/toast`; on a defect produces an optional `onManageDevices?: () => void` prop on `UnsavedChangesCloseHost`, shown as a secondary button "Manage devices" in the installing dialog
- Skills: mstack-diagnose (the result of a DOM probe picks the branch); better-interface (any new action needs the UI.md review)
- Read first: `apps/web/src/components/ui/toast.tsx` (`Toast.Portal`, `Toast.Viewport`); `apps/web/src/components/RemoteUpdateRequestNotifier.tsx`; `apps/web/src/AppRoot.tsx` (where the notifier and host mount)
- Tier: most capable
- TDD: exempt (the test is the deliverable; code changes only on a defect, and then red-green)
- Done when: `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx -t "toast"` exits 0 and the outcome line is recorded in the final report

Steps

1. [ ] Write the DOM test `the Manage devices toast action is reachable while the installing dialog is open`: mount the real toast viewport (not the mocked manager), add a toast with an action as the notifier does, open the installing dialog, then assert whether the action element has an `[inert]` or `[aria-hidden="true"]` ancestor and whether `document.elementFromPoint` or a keyboard Tab can reach it.
2. [ ] Run `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx -t "toast"`. Expected: either PASS (no defect) or FAIL on the inert assertion (defect).
3. [ ] Result "no defect" (PASS): keep the test as proof, add no code, and write "R39: no defect, toast action reachable over the dialog" in the final report.
4. [ ] Result "defect" (FAIL): add the "Manage devices" secondary button to `UpdateInstallingDialog` through an `onManageDevices` prop passed from where `AppRoot.tsx` mounts the host; add a test in the dialog test file that the click calls it; run `vp test run --project unit` on both test files. Expected: PASS. Run the UI.md review on the new action.
5. [ ] Run `vp check` on changed files. Expected: no errors.

### Task 4.5: Fail when a desktop event name exists on one side only

- Satisfies: R38. Given a `desktop:` event name in the web bridge with no matching Rust literal, or the reverse, Then the test fails.
- Depends on: none
- Files: create `scripts/desktop-event-names.test.ts`
- Interfaces: consumes `apps/web/src/tauriDesktopBridge.ts` string literals matching `"desktop:[a-z-]+"` and the same pattern in `apps/desktop/src-tauri/src/*.rs`; produces the test `every desktop event name exists on both sides of the bridge`. Follow the file style of `scripts/module-case-collisions.test.ts` (`node:fs`, `NodePath`, `import.meta.dirname`, `vite-plus/test`, the `@effect-diagnostics nodeBuiltinImport:off` comment).
- Skills: tdd (red-green cycle)
- Read first: `scripts/module-case-collisions.test.ts` (naming and imports); `apps/web/src/tauriDesktopBridge.ts` (the `*_EVENT` constants and `desktop:ssh-password-prompt`); `apps/desktop/src-tauri/src/window.rs`, `updates.rs`, `remote_update_delegate.rs` (the Rust constants)
- Tier: cheap
- TDD: red-green
- Done when: `vp test run scripts/desktop-event-names.test.ts` exits 0

Steps

1. [ ] Write `every desktop event name exists on both sides of the bridge`: collect the literal sets, assert both are non-empty, and assert set equality, with a failure message that lists the names missing on each side. Allow an explicit `WEB_ONLY` or `RUST_ONLY` list, empty unless a name is emitted by a plugin; justify any entry in a comment.
2. [ ] Run `vp test run scripts/desktop-event-names.test.ts`. Expected: PASS on current code. If it fails, the failure message names a real mismatch: report it, do not edit the bridge or Rust files (not owned by this phase).
3. [ ] Prove the test can fail: temporarily change one string in a scratch copy of the collected set inside the test (for example rename `desktop:update-install-ended` in the in-memory text), run. Expected: FAIL naming the event. Remove the break and run again. Expected: PASS.
4. [ ] Run `vp check scripts/desktop-event-names.test.ts`. Expected: no errors.
