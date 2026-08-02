# Shared Workspace Folder Picker Design

## Goal

Make Settings → General → Workspace use the same native folder-selection behavior as Add Project → Browse folder when the selected environment is hosted by the desktop application. Preserve the existing in-app directory browser for SSH, relay, and other remote environments.

## Architecture

Move the native host-folder selection logic out of the Add Project feature directory into a shared web module. The shared picker will remain responsible for:

- deciding whether an environment can use the desktop-native picker;
- passing the initial directory and desktop-local target to `LocalApi.dialogs.pickFolder`;
- translating WSL UNC selections back to the matching Linux environment and path;
- returning explicit selected, cancelled, and failure results.

Add Project and Workspace will call this shared module. The Tauri command and Rust dialog implementation will not change.

## Workspace Behavior

For the primary environment labelled “This device,” Browse opens the operating system's native folder picker. Desktop-local WSL environments use the same native picker and WSL path translation as Add Project.

SSH, relay, and other remote environments continue opening `RemoteDirectoryPickerDialog`, because a native operating-system picker cannot browse those server filesystems. Manual path entry remains available for every connected environment.

The selected directory is saved only for the environment that initiated the picker. Changing hosts or unmounting the setting invalidates an outstanding selection.

## Errors and Cancellation

Cancelling either picker leaves the setting unchanged. Native picker failures use the existing Workspace status area. Remote-picker behavior and server-side validation remain unchanged.

## Testing

- Extend the Workspace setting tests to prove the primary/local host uses the shared native picker and does not open the custom dialog.
- Prove remote hosts retain the custom directory picker.
- Prove cancellation does not update settings and a successful native selection does.
- Keep the shared WSL routing tests as coverage for Add Project and Workspace consumers.
- Run the focused web tests, `vp check`, and `vp run typecheck`.

## Out of Scope

No visual redesign, backend RPC change, native Rust dialog change, or change to remote filesystem browsing is included.
