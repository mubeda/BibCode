# Sidebar Open in File Explorer Design

## Summary

Add a `File Explorer` entry to the `Open in` submenu for project and worktree
rows in the left-panel project manager. The action opens the row's effective
local checkout directory in the operating system's file manager.

## Approved Product Decision

- Put `File Explorer` first in the existing `Open in` submenu, before external
  editor entries.
- Show the entry only when the row belongs to the primary local desktop
  environment and `DesktopBridge.openInFileManager` is available.
- Omit the entry for SSH and other remote environments, and in browser mode.
- For a primary project row, open the project's `workspaceRoot`.
- For a worktree row, open `thread.worktreePath`.
- Preserve the existing editor entries and their behavior.

## Component Ownership and Boundaries

`apps/web/src/components/Sidebar.tsx` owns left-panel context-menu composition,
selects the effective checkout path, and decides whether the local-only action
is available.

The existing optional `DesktopBridge.openInFileManager` contract remains the
native boundary. The Tauri adapter and Rust host already implement this
operation for files and directories, so this feature does not add a contract,
RPC method, or native command. The sidebar invokes it with `isDirectory: true`.

The server is not involved. In particular, a remote repository path must never
be forwarded to the local operating-system file manager.

## Interaction and Data Flow

1. The user opens the context menu for a primary project row or worktree row.
2. The sidebar checks that the row's `environmentId` equals the primary local
   environment id and that the desktop bridge exposes `openInFileManager`.
3. When eligible, the sidebar prepends `File Explorer` to the existing
   `Open in` submenu.
4. Selecting it resolves the same effective workspace path used by the row:
   `worktreePath` when present, otherwise the owning project's
   `workspaceRoot`.
5. The sidebar calls `openInFileManager(path, true)` and leaves native OS
   selection to the existing Tauri bridge.

If no editor is installed but File Explorer is eligible, the `Open in` submenu
remains enabled and contains only `File Explorer`. If neither File Explorer nor
an editor is eligible, the existing disabled `Open in` item remains.

## Failure Handling

If the desktop bridge rejects the request, show an error toast titled
`Unable to open File Explorer`. Use the rejection's message when it is an
`Error`; otherwise use the repository's generic unexpected-error wording.
Menu cancellation and unavailable capabilities remain silent.

## Testing

Use test-driven development in the closest Sidebar tests:

1. Prove a primary local project row includes `File Explorer` and opens its
   `workspaceRoot` as a directory.
2. Prove a local worktree row opens `worktreePath`, not the repository root.
3. Prove remote-environment rows omit `File Explorer`.
4. Prove rows omit the entry when the desktop bridge capability is absent.
5. Prove a rejected native launch produces the specified error toast.
6. Preserve existing editor submenu and action tests.

Run the focused Sidebar test, the applicable web package tests, `vp check`, and
`vp run typecheck`, followed by final diff and worktree-status review.

## Acceptance Criteria

1. Local primary project rows expose `Open in` → `File Explorer` and open the
   repository root in the OS file manager.
2. Local worktree rows expose the same action and open the worktree directory.
3. Remote projects and worktrees never expose the local File Explorer action.
4. Browser mode and desktop hosts without the optional capability do not expose
   the action.
5. Existing editor options and disabled-menu behavior continue to work.
6. Native-launch failures are visible to the user without changing navigation
   or project state.

## Out of Scope

- Adding file-manager support for remote environments.
- Downloading, mounting, or mapping remote repositories locally.
- Changing the existing Tauri file-manager command.
- Changing editor discovery or editor launch behavior.
