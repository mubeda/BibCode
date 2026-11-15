# Phase 4: Update install guard

- Goal: A remote update install keeps Files edits held across a reload, a lost ended event and a source registered mid-install, the installing dialog always has a way out, and the desktop event names are tied by a test, each with a failing-first test.
- Round: 1
- Depends on: none
- Owns: `apps/web/src/tauriDesktopBridge.ts` and `apps/web/src/tauriDesktopBridge.test.ts` (only the `getUpdateState` entry and its tests, Task 4.2), `apps/web/src/components/files/unsavedFileEdits.ts`, `apps/web/src/components/files/unsavedFileEdits.test.ts`, `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx`, `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx`, new `scripts/desktop-event-names.test.ts`
- Must not touch: `apps/desktop/src-tauri/**` (read only), the rest of `apps/web/src/tauriDesktopBridge.ts` (every entry other than `getUpdateState`), `apps/web/src/components/ThreadTerminalPanel.tsx`, `apps/web/src/components/ui/**`
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
5. [ ] Prove the test can fail: revert this task's change by hand (git stash is not allowed) and rerun the step 2 command. Expected: FAIL. Restore it and rerun. Expected: PASS.
6. [ ] Run `vp check apps/web/src/components/files/unsavedFileEdits.ts apps/web/src/components/files/unsavedFileEdits.test.ts`. Expected: no errors.

### Task 4.2: Restore the block when the window loads during an install

- Satisfies: R35. Given a reload during an install this window allowed, Then saving stays held at once, the installing dialog shows with its "Check again" button, and the first state query rejecting changes nothing. Only a confirmed "no remote install in progress" answer (a query answer, an `onUpdateState` push, or the `onUpdateInstallEnded` event) clears the block. A query that fails (rejects, or gives no answer within 5 seconds) is retried and clears nothing. A fresh window with no marker holds nothing until an answer says a remote install is running. A desktop without `getUpdateState` counts as "not installing".
- Depends on: 4.1
- Files: modify `apps/web/src/components/files/unsavedFileEdits.ts`, `apps/web/src/tauriDesktopBridge.ts` (the `getUpdateState` entry and one new helper); test `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx`, `apps/web/src/tauriDesktopBridge.test.ts`
- Interfaces: consumes `DesktopBridge["getUpdateState"]` and `["onUpdateState"]`; changes `respondToDesktopCloseRequests(bridge: Pick<DesktopBridge, "onCloseRequest" | "replyCloseRequest" | "onUpdateInstallEnded" | "getUpdateState" | "onUpdateState">): () => void` (the last two optional at runtime); produces the non-exported `isRemoteInstallRunning(state: DesktopUpdateState | null | undefined): boolean`, `askInstallState(bridge, onAnswer: (running: boolean) => void): () => void` (returns its cancel function), and the marker helpers `readInstallMarker(): boolean` and `writeInstallMarker(on: boolean): void`, used again by Task 4.3.
- Real boundary (class C): the real bridge's `getUpdateState` is `tauriInvokeOr("desktop_bridge_get_update_state", undefined, defaultUpdateState)` in `tauriDesktopBridge.ts`, which catches every rejection and returns `defaultUpdateState()` (`enabled: false`, `requestedBy: null`). A failed native call therefore reads as a confirmed "not installing" answer and would release the block; fake-bridge tests bypass this. Fix at the source, for this query only: add a helper `tauriInvokeOrWhenUnsupported<T>(command: string, args: Record<string, unknown> | undefined, fallback: () => T): Promise<T>` next to `tauriInvokeOr`. It returns `fallback()` only for the compatibility case (the desktop does not know the command: the rejection is a string containing `Command <command> not found`, as Tauri 2 words it; confirm the exact text in the Tauri crate source before relying on it; or the `tauri_capability_unsupported` payload `isTauriDesktopCapabilityUnsupportedPayload` already recognizes). Any other rejection is rethrown through `normalizeTauriDesktopError`. `tauriInvokeOr` itself is not changed, so every other entry keeps its behavior; `getUpdateState` alone moves to the new helper.
- Other callers of `getUpdateState` (`rg getUpdateState` over `apps/web/src` and `packages`): `apps/web/src/state/desktopUpdate.ts` (`createDesktopUpdateStateAtom`) retries three times then logs `DesktopUpdateStateReadError` and publishes `null`; today that branch never runs because the bridge never rejects, so it relied on the fallback only by dead code. With the change a failure now ends in the existing `null` state instead of the disabled default; consumers already handle `null` (`state?.requestedBy ?? null` in `RemoteUpdateRequestNotifier`). `apps/web/src/components/desktop/UpdateProtectionDialog.tsx` calls `bridge?.getUpdateState().catch(() => latestState.current)`: it already tolerates rejection. Tests that read the fallback: `tauriDesktopBridge.test.ts` (`await expect(bridge.getUpdateState()).resolves.toEqual({ enabled: false, ... })` where the harness rejects unknown commands with `unsupported fallback command: ...`, an `Error`, not the Tauri wording; that expectation is rewritten in step 3 to reject with the Tauri-shaped string, which is the real compatibility case). Add a `desktopUpdate.test.ts` case only if the file asserts the old default after a failed read (open it first).
- Marker: key `bibcode:update-install-allowed`, value `"1"`, kept in `window.sessionStorage` (it survives a reload of the same window and ends with the window). `rg sessionStorage` finds no per-window persisted-flag helper outside tests, so these two helpers are new and live in `unsavedFileEdits.ts`; every read and write is wrapped in `try`/`catch` and a failure means "no marker". Writers: `blockForUpdateInstall()` writes it (the one place a block starts: the allowed `update` reply, the load-time restore and a confirmed running answer). Clearers: `endUpdateInstall()` only, which every confirmed end already reaches (the ended event, a pushed state, a confirmed query answer, the cancelled late answer). Nothing else removes it, and no failure path does.
- Rule on load: a present marker calls `blockForUpdateInstall()` at once, before any query, so the installing dialog shows (its "Check again" button is Task 4.3's) and no save runs silently. With no marker, nothing is held until an answer says `isRemoteInstallRunning`. If the desktop has no `getUpdateState`, a present marker cannot be confirmed either way, so it is cleared and nothing is held.
- Retry rule: `askInstallState` calls `getUpdateState()` with a 5 second timeout. A rejection or timeout is not an answer: it logs once with `console.warn` and asks again every 2 seconds, without limit. The loop stops on the first confirmed answer, on any state pushed by `onUpdateState`, and on cleanup.
- Limit stated plainly: a unit test cannot prove the marker survives a relaunched web process. The tests below reload by resetting the module registry (`vi.resetModules()` and importing `unsavedFileEdits` and the dialog again) with the same `sessionStorage`. The proof that a real reload keeps the marker is a packaged check in Phase 8: reload the window during a mocked remote install and assert the DOM state `[role="alertdialog"]` containing the text "Installing an update" and a button named "Check again" while the marker `sessionStorage["bibcode:update-install-allowed"] === "1"`.
- Skills: tdd (red-green cycle)
- Read first: `apps/web/src/components/files/unsavedFileEdits.ts` (`respondToDesktopCloseRequests`, `blockForUpdateInstall`, `endUpdateInstall`; every writer of `updateInstall`); `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx` (describe "a remote update install the window allowed": its fake bridge and `afterTheSaveDelay`; the file uses the real modules, no mock replaces `unsavedFileEdits`)
- Tier: most capable
- TDD: red-green
- Done when: `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx` exits 0 with the new tests passed

Steps

1. [ ] In the describe "a remote update install the window allowed", extend the fake bridge so `getUpdateState` and `onUpdateState` can be set per test. Time is controlled with `vi.useFakeTimers()` in the new tests; every wait is `vi.waitFor(..., { timeout: 30_000 })` or an explicit timer advance, never a yield loop (restore real timers in `afterEach`); replace `afterTheSaveDelay` in them with `await vi.advanceTimersByTimeAsync(700)`; after advancing time past a rejected query, `await` the pending promise (`await vi.advanceTimersByTimeAsync(0)`) before asserting.
2. [ ] Write the failing test `reload during an install: the marker restores the block while the first query rejects`: allow an install through the close protocol (marker written), reset modules and remount the host, `getUpdateState` rejects; assert the dialog text contains "Installing an update", the session's `persist` is not called after advancing 700 ms, and the query is asked again after 2 seconds.
3. [ ] Write the failing test `reload during an install: a confirmed not-running answer clears the block and the marker`: continue from step 2, the retry answers `{ requestedBy: null, phase: "idle" }`; assert the dialog is gone, `sessionStorage.getItem("bibcode:update-install-allowed")` is null and saving resumes.
4. [ ] Write the failing bridge tests in `tauriDesktopBridge.test.ts` with the existing harness (real `window.desktopBridge` from `tauriDesktopBridgeReady`, native `invoke` mocked): `getUpdateState rejects when the native call fails` (`harness.invoke` rejects `desktop_bridge_get_update_state` with `new Error("boom")`; expect `bridge.getUpdateState()` rejects with it), `getUpdateState answers the default when the desktop lacks the command` (reject with the string `Command desktop_bridge_get_update_state not found`; expect the `enabled: false` default), the same for a `tauri_capability_unsupported` payload, and `other entries still fall back on a native failure` (for example `getClientSettings`, unchanged). Rewrite the existing `resolves.toEqual({ enabled: false ...` expectation to reject with the Tauri-shaped string. Then add `a native failure through the real bridge keeps the restored block` in the same file: install the bridge, set the marker, call the real `respondToDesktopCloseRequests(window.desktopBridge)` from `./components/files/unsavedFileEdits`, make `invoke` reject, advance fake timers past two retries and assert `isUpdateInstalling()` is still true and the marker is still set.
5. [ ] Write the failing test `a fresh window with no marker holds nothing until an answer says an install runs`: no marker, query pending; assert no dialog and `session.flush()` saves; then answer `{ requestedBy: { label: "Test User", detail: null }, phase: "installing" }`; assert the dialog shows and the marker is written. Add `a failed query never releases a known block` (timeout past 5 seconds and rejection: dialog and marker stay), `a pushed update state ends the wait`, `a desktop without getUpdateState clears a stale marker and holds nothing`, and `an unusable sessionStorage means no marker and no crash` (make `getItem` and `setItem` throw).
6. [ ] Run `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx src/tauriDesktopBridge.test.ts -t "reload during an install|fresh window|failed query never|pushed update state ends|without getUpdateState|unusable sessionStorage|getUpdateState rejects|lacks the command|other entries still fall back|through the real bridge"`. Expected: FAIL (no marker, no dialog, no retry; the bridge still swallows the rejection). Every selector is a substring of a title written here.
7. [ ] Implement the bridge helper and the `getUpdateState` change, then the marker helpers, `isRemoteInstallRunning` and `askInstallState`; write the marker in `blockForUpdateInstall`, clear it in `endUpdateInstall`, restore on load as the rules above say, and cancel the loop in the cleanup `respondToDesktopCloseRequests` returns.
8. [ ] Run the step 6 command, then `cd apps/web && vp test run --project unit src/tauriDesktopBridge.test.ts src/state src/components/desktop`. Expected: PASS (no other entry changed behavior).
9. [ ] Prove the tests can fail: revert this task's change by hand (git stash is not allowed) and rerun the step 6 command. Expected: FAIL. Restore it and rerun. Expected: PASS.
10. [ ] Run `cd apps/web && vp check src/components/files/unsavedFileEdits.ts src/tauriDesktopBridge.ts src/tauriDesktopBridge.test.ts src/components/files/UnsavedChangesCloseDialog.test.tsx`. Expected: no errors.

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
2. [ ] Write the failing test `Check again asks the desktop for the state and closes the dialog when no install runs`: dialog shows a button named "Check again"; `getUpdateState` resolves a not-running state; click; assert the dialog closes. Also `Check again with an install still running keeps the dialog`, `a block restored after a reload shows the Check again button` (the Task 4.2 reload setup: marker present, the first query rejecting; assert the dialog has a button named "Check again", click it with the next query answering not-running, and assert the dialog closes and the marker is gone; this is where the button assertions of the reload scenario live), and `a rejecting state query keeps the dialog, the block, the marker and the button, and the 4.2 retry keeps asking`.
3. [ ] Run `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx -t "pushed update state with no remote install|Check again|restored after a reload|rejecting state query"`. Expected: FAIL (no such button, dialog stays).
4. [ ] Implement the `onUpdateState` subscription and `recheckUpdateInstall`, and add the "Check again" `Button variant="outline"` in a footer of `UpdateInstallingDialog` with a disabled state while the query runs. The description keeps its current text and gains one sentence: "If it seems stuck, check again." UI.md review: confirm the dialog now has a visible exit, the button is not the primary action, and Escape still does nothing while an install may restart the app.
5. [ ] Run the same command. Expected: PASS.
6. [ ] Prove the tests can fail: revert this task's change by hand (git stash is not allowed) and rerun the step 3 command. Expected: FAIL. Restore it and rerun. Expected: PASS.
7. [ ] Run `vp check` on the changed files and `vp run typecheck`. Expected: no errors. Record the React and UI.md review outcome in the final report.

### Task 4.4: Decide whether the dialog hides the Manage devices toast

- Satisfies: R39 (decide by test). Given the installing dialog open over the remote-update toast, Then either the toast action is reachable (the test stays as proof) or it is inert (a defect).
- Depends on: 4.3
- Files: modify `apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx`
- Interfaces: consumes `RemoteUpdateRequestNotifier({ onManageDevices })` and the toast manager from `~/components/ui/toast` (the real `Toast.Portal` and `Toast.Viewport`, not the mocked manager); produces the verdict only
- Skills: mstack-diagnose (the result of a DOM probe picks the branch)
- Read first: `apps/web/src/components/ui/toast.tsx` (`Toast.Portal`, `Toast.Viewport`); `apps/web/src/components/RemoteUpdateRequestNotifier.tsx`; `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx` (`UpdateInstallingDialog`)
- Tier: most capable
- TDD: exempt (the test is the deliverable)
- Done when: `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx -t "toast action"` exits 0 or fails only on the reachability assertion, and the verdict is logged as a Ruling

Steps

1. [ ] Write the DOM test `the toast action is reachable while the installing dialog is open`: mount the real toast viewport, add a toast with an action as the notifier does, open the installing dialog, then assert that the action element has no `[inert]` or `[aria-hidden="true"]` ancestor and that a click on it (`dispatchEvent` through the real DOM, not `.click()` on a detached node) reaches its handler. Use an explicit signal for the dialog being open (`await vi.waitFor(..., { timeout: 30_000 })`).
2. [ ] Run `cd apps/web && vp test run --project unit src/components/files/UnsavedChangesCloseDialog.test.tsx -t "toast action"`. A pass means no defect; a failure on the reachability assertion means defect. Expected: the change is in place, and the next command step checks it.
3. [ ] Verdict "no defect": keep the test as proof and log "R39: no defect, the toast action is reachable over the installing dialog" as a Ruling.
4. [ ] Verdict "defect": open a new task in this phase for the fix, stating the failing test (this one) and the first wrong decision that step 2 names (which element is inert and what made it so); its requirement is spec R39's wording: device management usable while the installing dialog is up, reached from the dialog and shown above it, with Files saving still held, not a callback that navigates the page beneath the dialog. Log the verdict as a Ruling. Write no fix here.
5. [ ] Run `cd apps/web && vp check src/components/files/UnsavedChangesCloseDialog.test.tsx`. Expected: no errors.

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
2. [ ] Run `vp test run scripts/desktop-event-names.test.ts` from the repository root. Expected: PASS on current code. If it fails, the failure message names a real mismatch: report it, do not edit the bridge or Rust files (not owned by this phase).
3. [ ] Prove the test can fail: in the test only, make the collector read the Rust text with `desktop:update-install-ended` replaced by `desktop:update-install-finished`, run `vp test run scripts/desktop-event-names.test.ts`. Expected: FAIL naming the event on each side. Undo the edit by hand (git stash is not allowed) and rerun. Expected: PASS.
4. [ ] Run `vp check scripts/desktop-event-names.test.ts`. Expected: no errors.
