# OS File Drop Import

Status: proposal awaiting approval. Nothing here is implemented.

## Goal

Let a user add files to the workspace by dragging them from the operating
system's file manager onto the Files tree.

This is what the user was reaching for when they reported "I cannot drag and drop
files" while pasting screenshots into a workspace folder with Windows Explorer.
The workaround that exists today is to paste in Explorer and press Refresh.

## What already exists

In-tree drag-to-move shipped: dragging a row onto a folder row, or onto the tree
root, moves it via `projects.renameEntry`
(`apps/web/src/components/files/FileBrowserPanel.tsx`, the `dragAndDrop` option
passed to `useFileTree` and the `moveDroppedEntries` handler). Pierre's
`FileTreeDropTarget` already distinguishes `kind: 'directory'` from
`kind: 'root'`, so the drop target plumbing this feature needs is in place.

Relevant server ground truth:

- `projects.writeFile` takes `contents: Schema.String`
  (`packages/contracts/src/project.ts:203`) and writes it with `tokio::fs::write`
  (`apps/server/src/workspace/service.rs:108`). Its relative path is capped at
  512 characters (`packages/contracts/src/project.ts:202`).
- Path safety is centralised: `resolve_relative` rejects absolute paths, `..`,
  and prefix components; `safe_mutation_target` and `canonical_existing_within`
  refuse targets that resolve outside the root, including through symlinks
  (`apps/server/src/workspace/paths.rs:33`, `:63`, `:75`, `:107`).
- `write_file` creates missing parent directories and **overwrites an existing
  file without asking** (`apps/server/src/workspace/service.rs:103-110`).
  `rename_entry`, by contrast, refuses when the destination exists
  (`apps/server/src/workspace/service.rs:167`).
- `projects.writeFile` invalidates the cached workspace index on success
  (`apps/server/src/workspace/rpc.rs:115`), so imported files become visible.

## The two problems that shape everything

**There is no binary write path.** `contents` is a `String`, and the files users
drag are screenshots - PNG, JPEG. Text-only is not an oversight to route around;
it is the reason this feature needs a design rather than a patch.

**Desktop and browser modes are different features wearing one name.** BiBCode
runs as a Tauri desktop host and as a browser client talking to
`apps/server` over WebSocket (`docs/architecture/runtime-modes.md`). A drop in
the desktop host can carry real OS paths, which the server could copy from
directly. A drop in a browser carries `File` handles and no usable path, so the
bytes must travel over the wire. Any design that pretends these are one mechanism
will be wrong in one of them.

A Tauri-specific detail that must be settled before writing code: the workspace
pins Tauri 2.11.5 (`Cargo.toml:55`), the desktop host contains no drag-drop
handling today (nothing matches `drag_drop`/`DragDrop`/`file_drop` under
`apps/desktop/src-tauri/src/`), and `dragDropEnabled` is not set in
`apps/desktop/src-tauri/tauri.conf.json`. Tauri's OS-level drag-drop interception
and the webview's own HTML5 file-drop events are mutually exclusive: whichever is
enabled determines whether the app receives OS paths or `File` handles in the
desktop build. In-page element dragging - what in-tree move relies on - is a
separate mechanism, but the interaction must be verified rather than assumed,
because breaking the move feature to gain the import feature would be a poor
trade.

## Alternatives

**A. Do nothing; document paste-then-Refresh.** Zero risk and it works today,
now that Refresh performs a real rescan. Costs the user a context switch and some
knowledge they have to acquire. This is the baseline.

**B. Server-side copy from a host path (desktop only).** The drop hands the
server absolute source paths; the server copies them into the workspace. No bytes
cross the RPC boundary, so arbitrarily large files are cheap and progress is
simple. Costs: desktop only, and it fails for remote workspaces, where a path on
the user's machine is not a path in the workspace's filesystem. It also introduces
a server operation that reads outside the workspace root, which is a new trust
boundary rather than an extension of an existing one.

**C. Byte upload over the existing WebSocket RPC.** One mechanism for both modes.
Costs: the WebSocket carries interactive traffic - provider streams, terminal
I/O - and a multi-megabyte screenshot upload competes with it. Needs chunking and
a framing/size budget, and the RPC surface is not currently shaped for bulk
transfer.

**D. A dedicated HTTP upload endpoint.** Bulk bytes over HTTP, where they belong,
keeping the WebSocket for interactive traffic; streams to disk without buffering a
whole file in memory; works identically in both modes and for remote workspaces.
Costs: a new authenticated HTTP route with its own limits, and it is a second
write path alongside `projects.writeFile` that must share the same path-safety
helpers rather than reimplement them.

**E. Extend `projects.writeFile` with binary support.** Add a base64 or byte-array
variant. Smallest surface change and it inherits every existing safety check.
Costs: base64 inflates payloads by a third on a transport already carrying
interactive traffic; no streaming, so the whole file sits in memory on both
sides; and it silently overwrites, which is wrong for an import gesture.

## Recommendation

**D, with the drop gesture supplying only paths-or-handles and a single
server-side import path shared by both modes.** Reject B as the primary
mechanism, and keep A documented as the fallback for remote workspaces if
the first cut does not cover them.

The reasoning: bytes-over-HTTP is the only option that behaves the same in the
browser and the desktop, does not put bulk transfer on the interactive WebSocket,
and can stream to disk. B is genuinely cheaper in the desktop case and worth
keeping as a later optimisation once the shared path exists, but choosing it first
would make the browser a second-class citizen and bake in a host-path assumption
that remote workspaces break.

What this trades away: a new HTTP route to authenticate and bound, and no
zero-copy fast path on day one even in the desktop build.

Collision policy should follow `rename_entry`, not `write_file`: an import must
not silently overwrite. Refuse, or import under a non-colliding name, and report
what happened. This is the one place where reusing `projects.writeFile` semantics
would be actively harmful.

## Behavior to settle

- **Where a drop lands.** Onto a folder row, into that folder; onto the tree
  root or background, into the workspace root. Reuse the existing
  `FileTreeDropTarget` handling so import and move agree on the target.
- **Distinguishing the two gestures.** An in-tree move and an OS import are both
  "a drop on a folder row". The handler must branch on whether the drag
  originated inside the tree or outside it, and must not treat an external drop
  as a move of a path the tree does not own.
- **Directories.** A dropped folder is a recursive import. Decide whether that is
  in the first cut; if not, refuse it with a clear message rather than importing
  a flattened subset.
- **Limits.** Per-file size, total batch size, and file count, all enforced
  server-side and surfaced before the transfer rather than after.
- **Partial failure.** A ten-file import where the seventh fails must leave a
  comprehensible state and say which files landed.
- **Progress and cancellation.** Large imports need both, and cancellation must
  not leave a half-written file in the workspace.
- **Index visibility.** The import must invalidate the cached index the way
  `projects.writeFile` already does (`apps/server/src/workspace/rpc.rs:115`), so
  imported files appear without a manual Refresh.

## Trust boundaries

- Destination paths must go through `resolve_relative` and
  `safe_mutation_target` (`apps/server/src/workspace/paths.rs:33`, `:75`) - no
  new path arithmetic. The outward-symlink refusal
  (`WorkspaceError::ResolvedPathOutsideRoot`, `:107`) already has UI treatment in
  `FileBrowserPanel`.
- Filenames arrive from outside the app and are attacker-influenced in the
  general case: reserved Windows device names, trailing dots and spaces, path
  separators inside a name, and names differing only by case on a
  case-insensitive filesystem all need a decision.
- A new HTTP route must sit behind the same authentication and workspace
  admission as the RPC surface (`acquire_path`, `WorkspaceAdmissionLease`), and
  must not become an unauthenticated write primitive.
- If B is ever added, reading an arbitrary host path on the user's behalf is a
  genuinely new capability and belongs behind `DesktopBridge`, not the shared RPC
  surface.

## Remote environments

For WSL and SSH workspaces (`docs/architecture/remote.md`) the bytes must reach
the machine that owns the workspace filesystem. D handles this by construction,
since the upload terminates wherever the server runs. B cannot. If the first cut
excludes remote workspaces, the drop should be refused there with a reason rather
than appearing to work.

## Scope boundary

Not in this design: dragging files out of BiBCode to the OS file manager;
clipboard paste of image data into the tree; watching the filesystem for external
changes (its own proposal); and any change to in-tree drag-to-move, which is
shipped and stays as it is.

## Verification

- Server-side import: unit-test path safety and the collision policy directly,
  including a name that resolves outside the root through a symlink, reusing the
  fixtures in `apps/server/src/workspace/paths.rs` tests.
- Binary round-trip: import a small PNG fixture and assert the bytes on disk are
  identical, since text-vs-binary corruption is the specific failure this design
  exists to avoid.
- Limits and partial failure: assert an oversized file is refused before transfer,
  and that a mid-batch failure reports precisely which files landed.
- Web: test the drop handler's branch between in-tree move and external import at
  the existing mocked `@pierre/trees/react` seam in
  `apps/web/src/components/files/FileBrowserPanel.test.tsx`, so the two gestures
  are proven not to be confused.
- The native drag gesture itself cannot be unit-tested. It belongs in the
  packaged visual validation in `docs/testing/cross-platform-validation.md`,
  which will need a Files import step, and it must be exercised on Windows,
  macOS, and Linux because the OS drag source differs on each.

Gates: focused Rust and web tests, `cargo fmt --all --check`, Clippy with
warnings denied, `vp check`, and `vp run typecheck`. On Windows, `cargo` needs the
repo launcher `node scripts/run-msvc-x64.mjs`
(`docs/testing/windows-desktop.md:146`). User-visible behavior changes, so
`docs/user/workspace-ui.md` - which currently states that dragging files to or
from the OS file manager is not supported - must change in the same patch.

## Open questions for approval

1. Confirm D (HTTP upload) over B (desktop-only host-path copy), accepting no
   zero-copy fast path in the first cut.
2. Are recursive directory imports in scope initially, or refused with a message?
3. On collision: refuse, or import under a non-colliding name? Refusing is
   simpler to reason about; auto-renaming is friendlier for a batch of
   screenshots.
4. Are remote (WSL/SSH) workspaces in the first cut?
