# #357 Desktop update install: the leave guard after a reload or a lost event

Follow-ups to the unsaved-edits guard around a remote update install in #349. Found by reading the code.

- A renderer reload during an allowed install forgets the block. `updateInstall` is a module variable in `apps/web/src/components/files/unsavedFileEdits.ts`, so the Files block is dropped and saving runs again while the install may still restart the app.
- If the `desktop:update-install-ended` event is missed or the allow reply is rejected, the "Installing an update" dialog (`UnsavedChangesCloseDialog.tsx`) stays up with no way out. Add one, such as asking the desktop for the install state again.
- A Files source registered during the install is not held. `blockForUpdateInstall` holds a snapshot of the sources, and `registerUnsavedSource` adds a source without taking a hold.
- Nothing ties the event name in `apps/web/src/tauriDesktopBridge.ts` to the one in `apps/desktop/src-tauri/src/remote_update_delegate.rs`. Add a test or a shared constant.
- Not decided: whether the always-open installing dialog makes the Manage devices toast unreachable.


