# Terminal image paste — design (approved 2026-10-06)

Research: [terminal selection and image paste](2026-10-06-terminal-selection-and-image-paste-research.md).

## Problem

Copying an image on the client (for example a macOS screenshot) and pasting it
into a provider terminal (Codex, Claude Code) does nothing. xterm reads only
`text/plain` from the paste event, so an image-only clipboard produces an empty
bracketed paste. Forwarding Ctrl+V for the CLI to read its own clipboard cannot
work when the PTY runs on another machine: the CLI sees the server's clipboard,
not the client's.

Codex and Claude Code attach an image when a path to it is pasted. Orca relies
on this: it saves the clipboard image to a file on the PTY's host and pastes the
path (research §2).

## Decision

Upload the pasted image to the terminal's environment server, which writes it to
a server-owned file and returns the absolute path; the client pastes that path
into the terminal through xterm.

1. **Trigger (web).** A capture-phase `paste` listener on the terminal mount.
   When `clipboardData` has no `text/plain` and holds one `image/*` file, it
   calls `preventDefault` and `stopPropagation`, so xterm sends no empty paste.
   Text pastes are untouched. The chat composer already reads
   `clipboardData.files` the same way (`ChatComposer.tsx` `onComposerPaste`).
2. **Transport.** The existing typed `uploads.begin/append` RPCs and the
   client-runtime `stageUpload` helper, with the existing `chat-attachment`
   upload target (type `image`). No new upload transport.
3. **Commit.** New typed RPC `terminal.stageImagePaste`
   `{ threadId, terminalId, uploadId, name, mimeType, sizeBytes } -> { path }`.
   The server binds the completed upload (`UploadRegistry::bind`), checks the
   terminal exists for that thread, accepts `image/png|jpeg|gif|webp` up to the
   existing 10 MiB chat limit, moves it to
   `<state>/terminal-pastes/<uuid>.<ext>` (server-chosen name, no spaces from
   user input), commits the upload, and returns the absolute path. It is added
   to the terminal auth scope in `auth/scope.rs`.
4. **Insert.** `terminal.paste(path)`: xterm adds the bracketed-paste markers
   when the running program enabled mode 2004 (Codex, Claude Code and opencode
   do), and plain text otherwise. Input flows through the existing ordered
   terminal input path.
5. **Retention.** Files older than 24 hours in `terminal-pastes/` are removed
   at server startup and by the existing upload sweeper tick. Pasted images are
   not tied to thread persistence.
6. **Compatibility.** Servers advertise `terminalImagePaste: true`, which decodes
   as false for older servers. Against an older server, the paste writes
   `[terminal] Image paste needs a newer BiBCode server on <environment>.` into
   the terminal instead of failing silently. Upload or commit failures write a
   one-line `[terminal] Image paste failed: <reason>` message.

**Implementation notes (2026-10-06).** Three details changed while building:

- `terminal.stageImagePaste` takes `{ uploadId, name, mimeType, sizeBytes }`
  without thread or terminal IDs, and is registered next to the upload RPCs,
  which own the registry and the caller's session. The terminal check guarded
  nothing: the file is not tied to a terminal, and the caller already holds
  `terminal:operate`.
- Expiry runs when an image is pasted, not at startup or on the upload sweeper
  tick. Stale copies on a server that stops receiving pastes stay until the
  next paste.
- The copy is a bounded file copy of the bound stage, not a move, so the
  upload registry retires its own file as usual.
- The path goes through the terminal input path with bracketed-paste markers
  added by the client (from `terminal.modes.bracketedPasteMode`), not
  `terminal.paste`. The paste reserves a slot in the terminal input scheduler
  (`TerminalInputScheduler.reserve`), so typed input waits behind it under the
  existing pending limit, generation reset and renderer-independent ownership.
  A status with Cancel shows while an upload is pending.
  The commit resolves the environment's current connection, releases the stage
  if it fails, and the viewport aborts the upload on teardown.

One flow serves local, WSL, desktop-SSH and remote-endpoint environments,
because the server always runs on the PTY's host.

## Alternatives rejected

- **Store pastes in the chat attachment store.** Couples terminal input to
  thread persistence and its startup reconcile, which removes files no message
  references.
- **Forward Ctrl+V (`\x16`) to the CLI.** Works only when the CLI shares the
  client's clipboard; never for remote environments or browser clients.
- **Write the image into the workspace and paste a relative path.** Pollutes
  the user's working tree and Git status.
- **Dedicated base64 RPC without the upload registry.** Duplicates size, chunk,
  ownership and expiry handling that `uploads.*` already owns.

## Risks and checks

- Whether WKWebView (macOS) and WebKitGTK (Linux) expose clipboard images in
  `clipboardData.files` is unverified. The chat composer depends on the same
  behaviour, so a screenshot pasted into the composer is the quick check.
- Windows servers: ConPTY receives a Windows path; Codex and Claude Code accept
  it, but this is unverified.
- Drag-and-drop of image files onto the terminal could reuse the same pipeline;
  out of scope unless requested.

## Living documents to update on implementation

`docs/architecture/overview.md` (terminal clipboard paragraph),
`docs/architecture/rpc-and-orchestration.md` (new RPC and capability),
`docs/testing/cross-platform-validation.md` (image paste step for local and
remote environments).
