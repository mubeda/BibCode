# Terminal selection under mouse tracking, and image paste: Orca vs BiBCode

Date: 2026-10-06. Historical research note, not living documentation.

Sources:

- Orca at `/work/github/orca`, HEAD `b75213100b`. Orca pins `@xterm/xterm`
  `6.1.0-beta.303` with a local patch (`package.json:264`,
  `pnpm-workspace.yaml:62`).
- BiBCode `main-2` at `9232e7c8`, using `@xterm/xterm` `^6.0.0`
  (`apps/web/package.json:36`). Its xterm source is in
  `node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/src`.
  `ThreadTerminalPanel.tsx` line numbers refer to the committed file at
  `9232e7c8`. While this note was being written, the working tree gained
  uncommitted edits to that file from separate work. They add a "Copy" item to
  the selection menu, flip the force-selection key on a right-button mousedown
  while text is selected, and stop hover `mousemove` events in the capture
  phase while text is selected under `"any"` tracking. Those edits are close to
  options C and F below, and this research did not evaluate them.

Orca paths are relative to `/work/github/orca`. BiBCode paths are relative to
the repository root. `xterm6.0:` means the BiBCode xterm 6.0.0 `src/` tree.

Orca's `node_modules` is not installed, so readable xterm 6.1 source and
typings are not on disk. Every 6.1 claim below comes from the minified bundle
embedded in the patch file (`config/patches/@xterm__xterm@6.1.0-beta.303.patch:6`
is the unpatched line and `:7` the patched one). Treat those claims as
"read from the minified bundle".

## Summary

- **Orca does not keep an xterm selection alive under `?1003`.** It has no
  selection-gated suppression of motion reports, no selection snapshot, and no
  xterm patch for this. A Shift/Option-forced selection in a tracking TUI is
  wiped on the first mouse move, just as in BiBCode. Orca handles the problem
  differently: (a) the TUI owns the mouse and its own highlight, (b) on macOS
  an unselected Cmd+C goes to apps that negotiated the kitty keyboard protocol,
  so the TUI's own copy works, (c) the TUI's OSC 52 clipboard writes are
  accepted by default, and (d) an opt-in copy-on-select copies the selection at
  mouseup, before any motion report arrives. Only (d) makes selection lifetime
  irrelevant.
- Orca keeps xterm's default modifier. A plain drag goes to the TUI. Option+drag
  on macOS (`macOptionClickForcesSelection: true`) or Shift+drag elsewhere makes
  an xterm selection. This is the reverse of BiBCode's inversion.
- xterm `6.1.0-beta.303` has an **upstream** option, `mouseEventsRequireAlt`. It
  is not an Orca patch. When it is on and mouse tracking is active, xterm drops
  every non-wheel mouse report unless Alt is held, and plain drags select. Orca
  turns it on only for a moment, during a link click. It is the only upstream
  switch that stops the wipe. xterm 6.0.0 does not have it.
- Orca keyboard copy is a keybinding action, `terminal.copySelection`: Cmd+C on
  macOS, and Ctrl+Shift+C or Ctrl+C on Linux and Windows. It consumes the key
  only when a selection exists. It writes through Electron `clipboard` over IPC
  and reads the text back to verify it. The web build uses
  `navigator.clipboard.writeText` and falls back to `execCommand('copy')`.
- Orca's right-click opens a Radix menu with Copy, Select All and Paste.
  Right-click-to-paste (copy if there is a selection, otherwise paste) is the
  default on Windows only. In tracking mode the right-button report has already
  cleared a forced selection before the menu reads it. This is inferred from
  event order and was not verified at runtime.
- **Orca image paste.** Orca takes over Cmd+V, Ctrl+V, Ctrl+Shift+V and
  Shift+Insert itself. It reads clipboard text first. If there is no text, it
  saves the clipboard image as a PNG and pastes the file path inside a forced
  bracketed-paste frame (`ESC[200~<path>ESC[201~`). Orca never forwards Ctrl+V
  (`\x16`) so the CLI can read the clipboard.
- **Orca on remote and SSH hosts.** The desktop main process reads the image
  with Electron `clipboard.readImage()`. For an SSH workspace it writes
  `orca-paste-<ms>-<uuid>.png` into the remote `os.tmpdir()`, using system-ssh
  raw transfer or SFTP. For a workspace owned by a remote Orca runtime it
  uploads the PNG through chunked runtime RPC
  (`clipboard.startImageUpload`/`appendImageUploadChunk`/`commitImageUpload`),
  and the runtime writes the file on its own host. The web client reads the
  image with `navigator.clipboard.read()` and uses the same chunked RPC.
- **BiBCode today.** It inverts xterm's force-selection modifier so that a plain
  drag selects. It has no OSC 52 handler and no copy-on-select. Its right-click
  menu offers only "Add to chat". Paste is xterm's native `paste` event, which
  reads `text/plain` only. With an image-only clipboard and bracketed paste on,
  that sends an empty `ESC[200~ESC[201~` frame. Nothing uploads images to the
  terminal. The desktop bridge has no clipboard read or write.
- **BiBCode can reuse the upload transport (`uploads.begin/append`) but not its
  target.** `UploadTarget` has only the `chat-attachment` variant, and no RPC
  returns a filesystem path. BiBCode's server runs in the same environment as
  the PTY, so one upload-then-paste-the-path flow covers local, SSH-launched
  and remote environments. It needs no SFTP hop like Orca's.

## 1. Orca: selection, copy and context menu

### 1.1 Mouse tracking and the selection wipe

- Terminal options set `macOptionIsMeta: false` and
  `macOptionClickForcesSelection: true`, and never set `mouseEventsRequireAlt`
  (`src/renderer/src/lib/pane-manager/pane-terminal-options.ts:31-75`, `:53-55`).
- Orca's middle-click handling restates xterm's rule: a click is forced to a
  selection by Option on macOS or Shift elsewhere. Otherwise the click goes to
  a tracking TUI as a mouse report
  (`src/renderer/src/components/terminal-pane/use-terminal-pane-mobile-actions.ts:23-28`,
  `:134-146`).
- **The only mouse-report suppression is temporary and limited to links.**
  `installTerminalLinkPtyMouseSuppression` turns `mouseEventsRequireAlt` on
  during a link-activation mousedown (capture phase) and restores it in a
  microtask after mouseup or on window blur. The comment reads "an Orca-owned
  link gesture must not also reach a mouse-aware child TUI." It can also defer
  and drop the PTY mouse reports for a claimed link action
  (`src/renderer/src/components/terminal-pane/terminal-link-pty-mouse-suppression.ts:39-55`,
  `:76-96`, `:163-184`).
- Orca recognises mouse reports by their shape, either X10 `CSI M` or SGR
  `CSI <` (`src/renderer/src/components/terminal-pane/terminal-pointer-input-sequences.ts:5-10`).
  Its consumers are the replay guard, which drops pointer input while a pane
  replays (`.../pty-connection/pty-input-forward.ts:40-47`), the link deferral
  above, and the scroll-intent tracker, which keeps a pinned viewport
  (`src/renderer/src/lib/pane-manager/terminal-scroll-intent-dom-tracking.ts:48-90`).
  None of them checks selection state.
- A search for `hasSelection` in `components/terminal-pane` and
  `lib/pane-manager` finds keyboard bypass policy, copy paths, link-gesture
  bookkeeping and keydown fit. It finds no mouse-event or `onUserInput`
  handling gated on selection. Therefore no selection-preserving mechanism
  exists.
- `installTerminalSelectionFitGuard` only pauses output-driven refits while a
  primary-button drag is in progress, so rows do not reflow under the selection
  (`.../terminal-selection-fit-guard.ts:16-58`, commit `76d87604ff`). It does
  not affect mouse reports.
- Orca's xterm patch changes `CompositionHelper` (IME), `WidthCache` and
  `SortedList`. It does not touch `SelectionService` or mouse handling
  (`config/patches/@xterm__xterm@6.1.0-beta.303.patch:62-1314`, file headers).

xterm behaviour behind the wipe. It is unchanged in 6.1, as read from the
minified bundle at patch `:7`:

- `SelectionService` clears the selection on every `onUserInput`
  (`xterm6.0:browser/services/SelectionService.ts:139-143`; 6.1 bundle:
  `this._coreService.onUserInput(()=>{this.hasSelection&&this.clearSelection()})`).
- `triggerDataEvent(data, true)` fires `onUserInput` before `onData`
  (`xterm6.0:common/services/CoreService.ts:61-82`). Filtering reports in
  `onData` is therefore too late to save a selection.
- Mouse reports go through `triggerDataEvent(report, true)` for every encoding
  except DEFAULT (X10), which uses `triggerBinaryEvent` and does not fire
  `onUserInput` (`xterm6.0:common/services/CoreMouseService.ts:325-332`).
  The wipe therefore happens only with SGR and other non-default encodings,
  which are the ones Codex and opencode enable.
- Motion with no button held is reported from a listener on the terminal
  element (`xterm6.0:browser/CoreBrowserTerminal.ts:720-725`, `:747`). On
  mousedown, xterm sends a report unless `shouldForceSelection` is true
  (`:779-788`). A right-click therefore sends a button-2 press. The
  "right-click with selection keeps the context menu" guard exists only in
  `SelectionService.handleMouseDown` (`SelectionService.ts:453-457`), not in the
  report path.

### 1.2 `mouseEventsRequireAlt` (upstream xterm 6.1.0-beta)

From the minified bundle at patch `:7`. The same text, including 10 occurrences
of the identifier, is on the unpatched line `:6`, which shows the option is
upstream:

- `_sendEvent`: `if(4!==s && mouseEventsRequireAlt && areMouseEventsActive && !t.altKey) return!1`.
  Every non-wheel report is dropped unless Alt is held. When a report is sent,
  its alt bit is cleared.
- `shouldForceSelection(e)`: with the option on and tracking active, it returns
  `!e.altKey`. A plain drag selects and Alt+drag goes to the app, on every
  platform.
- `_syncMouseModeState`: with the option on, the selection service is enabled.
  With it off and tracking active, it calls `_selectionService.disable()`,
  which clears the selection (`xterm6.0:SelectionService.ts:173-176`; same in
  the 6.1 bundle). It runs again on `onSpecificOptionChange("mouseEventsRequireAlt")`.
- The doc comment in the typings could not be read because Orca's
  `node_modules` is absent. BiBCode's xterm 6.0.0 typings do not contain the
  option (verified with grep).

### 1.3 Who owns the selection in a TUI

- Commit `9b46c3f0f2` (#23597) gives the intent: "a full-screen TUI like Codex,
  which captures the mouse and keeps its highlight out of xterm's selection,
  never received its own copy chord." `isAppOwnedCopyChord` returns true on
  macOS when there is no xterm selection, the kitty keyboard flags are non-zero
  and the chord is Mod+C. In that case the chord goes to the PTY
  (`src/renderer/src/components/terminal-pane/xterm-bypass-policy.ts:285-300`,
  `:376-378`). Whether Codex actually draws and copies its own selection was
  not checked against Codex itself; this is Orca's claim.
- OSC 52 writes from TUIs are accepted by default. Clipboard queries stay
  blocked and the payload size is capped
  (`.../terminal-pane/osc52-clipboard.ts:1-31`, commit `9042ef9792`).

### 1.4 Capturing a selection when it is made

- `onSelectionChange` copies to the clipboard when `terminalClipboardOnSelect`
  is on. It reads `getSelection()` synchronously in the callback
  (`.../terminal-pane/terminal-pane-pane-links.ts:123-168`). The setting
  defaults to `false` (`src/shared/default-global-settings.ts:111`).
- The same callback fills the primary selection, which defaults on for Linux
  and macOS (`src/shared/terminal-platform-defaults.ts:13-15`). It does this
  after a 100 ms timer and checks `hasSelection()` again when the timer fires
  (`terminal-pane-pane-links.ts:141-160`). A motion report within that 100 ms
  would therefore lose the primary selection (inferred).
- xterm fires `onSelectionChange` on mouseup through
  `_fireEventIfSelectionChanged` (`xterm6.0:SelectionService.ts:703-724`). That
  is before the next mousemove can send a report, so copy-on-select copies
  before the wipe.

### 1.5 Keyboard copy

- Default bindings for `terminal.copySelection`: macOS `Mod+C`; Linux and
  Windows `Ctrl+Shift+C` and `Ctrl+C`
  (`src/shared/keybindings/definitions-core-3.ts:213-224`).
- The dispatcher returns without `preventDefault` when there is no selection,
  so Ctrl+C still reaches the shell as SIGINT. With a selection it calls
  `copyTerminalSelection` with `window.api.ui.writeTerminalClipboardText`
  (`.../terminal-pane/terminal-keyboard-action-dispatch.ts:82-96`). The copied
  text has the agent gutter removed
  (`.../terminal-clipboard-selection-text.ts:9-17`).
- Electron: IPC `clipboard:writeTerminalText` calls `clipboard.writeText` and
  then `readText` to verify the write
  (`src/main/window/clipboard-ipc-handlers.ts:213-216`;
  `src/main/window/clipboard-text-write-verify.ts:6-12`). The sender must be
  the trusted renderer or the dashboard popout (`clipboard-ipc-handlers.ts:292-324`).
- Web: `navigator.clipboard.writeText`, falling back to a synchronous
  `execCommand('copy')` with a `copy` event listener
  (`src/renderer/src/web/preload-api/web-clipboard-api.ts:143-161`;
  `src/renderer/src/web/web-clipboard-copy-fallback.ts:4-29`).
- When the kitty protocol is active, xterm would encode Cmd+C as CSI-u. The
  bypass policy returns `false` from `attachCustomKeyEventHandler` so the
  browser's copy pipeline runs instead
  (`xterm-bypass-policy.ts:9-19`, `:340-415`). Native `copy` events are also
  rewritten in the capture phase to trim the gutter
  (`.../terminal-native-copy-gutter.ts:17-31`).

### 1.6 Context menu

- `onContextMenuCapture` resolves the pane under the cursor and opens a Radix
  dropdown (`.../use-terminal-context-menu-trigger.ts:48-108`). The menu has
  Copy, Select All and Paste, always enabled
  (`.../TerminalContextMenu.tsx:194-208`).
- Copy reads the selection when it is clicked, then refocuses xterm
  (`.../terminal-pane-menu-copy-actions.ts:9-22`;
  `.../terminal-copy-rejection-guards.ts:8-23`). Paste uses the same
  text-then-image flow as the keyboard (`.../terminal-pane-menu-paste.ts:110-160`).
- With right-click-to-paste enabled and no Ctrl held, a right-click copies the
  selection (and clears it on success) or pastes when nothing is selected
  (`use-terminal-context-menu-trigger.ts:66-85`). It defaults on for `win32`
  only (`src/shared/terminal-platform-defaults.ts:17-19`).
- The selection is read in the `contextmenu` handler. That event fires after
  xterm's `mousedown` listener has sent the button-2 report (§1.1), so a forced
  selection in a tracking TUI is already gone. This is inferred from event
  order and not verified at runtime.

## 2. Orca: image paste, local vs remote

### 2.1 Trigger (renderer)

- A capture-phase `keydown` listener on the pane container matches
  `terminal.paste`. The bindings are macOS `Mod+V`; Linux and Windows `Ctrl+V`,
  `Ctrl+Shift+V` and `Shift+Insert`
  (`src/shared/keybindings/definitions-core-3.ts:237-247`). The listener calls
  `preventDefault`, arms a suppression of the follow-up native `paste` event
  and calls `pasteFromClipboard(pane, 'keyboard')`
  (`.../terminal-pane-paste-listeners.ts:67-117`, `:233-234`).
- A capture-phase `paste` listener catches pastes that did not come from those
  keys and routes them the same way. On an insecure web origin it uses the
  event's `text/plain` (`terminal-pane-paste-listeners.ts:119-155`;
  `.../terminal-clipboard-event-paste.ts:6-22`). The app-menu paste, the
  context menu and right-click paste all reach `pasteTerminalClipboard`
  (`terminal-pane-paste-listeners.ts:157-197`).
- Ctrl+V is never forwarded as `\x16`: a search for `x16`/`u0016` in `src/`
  finds nothing relevant. On Linux and Windows, Ctrl+V is Orca's paste key.
  On macOS, Ctrl+V is not bound to paste and goes through xterm as `\x16`
  (inferred; no Orca code handles it explicitly).

### 2.2 Text first, then image

`pasteTerminalClipboard`
(`.../terminal-pane/terminal-clipboard-paste.ts:43-100`) works as follows:

1. Read clipboard text, capped at `TERMINAL_PASTE_MAX_BYTES`. A read failure
   other than "too large" is ignored, so image-only clipboards still work
   (`:54-64`).
2. If there is text, paste it (`:65-79`).
3. Otherwise call `saveClipboardImageAsTempFile({ connectionId, runtimeEnvironmentId })`
   (`:82`) and paste the returned path with `forceBracketedPaste: true`
   (`:86-91`).

`connectionId` and `runtimeEnvironmentId` come from the worktree
(`.../terminal-pane-paste-execution.ts:121-147`).

The path is written as `ESC[200~<path>ESC[201~` through `terminal.input()`,
whether or not the TUI enabled DECSET 2004. It is not shell-quoted. The
generated name has no spaces
(`.../terminal-bracketed-paste.ts:87-91`, `:115-133`;
`src/shared/terminal-bracketed-paste-text.ts:36-39`). Orca's stated reason:
Claude Code and Codex "detect [images] from a _bracketed paste_ of the file
path", and Codex splits a raw path with spaces into separate tokens
(`.../terminal-drop-image-path.ts:5-11`).

### 2.3 Saving the image (desktop main process)

- `clipboard:saveImageAsTempFile` reads `clipboard.readImage()`. On Windows it
  falls back to a copied image file. It checks the dimensions and passes
  `image.toPNG()` on (`src/main/window/clipboard-ipc-handlers.ts:141-168`).
- `saveClipboardImageBufferForTarget` (`clipboard-ipc-handlers.ts:56-74`)
  chooses where the file goes:
  - **Local:** `os temp/orca-paste-<ms>-<uuid>.png`
    (`src/main/window/clipboard-image-temp-file.ts:33`, `:45-54`). Terminal
    pastes stay in OS temp and are not swept. The comment at `:45-46` says so,
    and a grep for `orca-paste` found sweeping only for the native-chat paste
    folder.
  - **SSH workspace (`connectionId`):** the remote temp dir comes from relay
    `fs.tempDir`, which is `os.tmpdir()` on the remote and falls back to
    `/tmp`. The file is written with `writeFileBase64`, through system-ssh raw
    transfer when available and otherwise SFTP. The remote path is returned
    (`clipboard-image-temp-file.ts:35-43`;
    `src/main/providers/ssh-filesystem-provider.ts:176-188`, `:194-219`;
    `src/relay/fs-handler.ts:107`, `:206-208`).
  - **Runtime-owned workspace (`runtimeEnvironmentId`, possibly with the
    runtime's own SSH `connectionId`):** chunked RPC to that runtime:
    `clipboard.startImageUpload`, then `appendImageUploadChunk` in 512 KiB
    base64 chunks, then `commitImageUpload`, with `abortImageUpload` on
    failure. Old runtimes get a single-frame `clipboard.saveImageAsTempFile`
    for payloads up to 256 KiB
    (`src/main/window/clipboard-runtime-image-upload.ts:4-6`, `:27-106`;
    intent in commits `5f8b04e0f1`, #6380, and `1e693edee4`, #17679).
- On the runtime side, uploads are capped at 8 concurrent, use a 5-minute TTL
  and enforce in-order offsets and the expected length. Commit calls the same
  `saveClipboardImageBufferAsTempFile`, so the file is written locally on the
  runtime host or over SSH from there
  (`src/main/runtime/rpc/methods/clipboard.ts:14-15`, `:110-176`).

### 2.4 Web client

`saveClipboardImageAsTempFile` uses `navigator.clipboard.read()`, takes the
first `image/*` item, converts it to PNG through a canvas if needed, encodes it
as base64 and uploads it with the same chunked runtime RPC
(`src/renderer/src/web/preload-api/web-ui-api.ts:149-161`;
`.../web-clipboard-api.ts:45-93`, `:122-141`, `:163-224`; commit `7ca12ec252`).
`navigator.clipboard` does not exist on an insecure origin, so image paste
returns "empty" there (inferred from `web-clipboard-api.ts:126-128`).

## 3. BiBCode today (`apps/web/src/components/ThreadTerminalPanel.tsx`, `TerminalViewport`)

- **Options.** `new Terminal({ macOptionClickForcesSelection: true, ... })`
  (`:1074-1082`).
- **Selection.** For a left-button mousedown while `mouseTrackingMode !== "none"`,
  a capture listener flips the force-selection key (`altKey` on macOS,
  `shiftKey` elsewhere) with `Object.defineProperty`. A plain drag therefore
  selects, and Shift or Option+drag reaches the app. For gestures sent to the
  app, the flip also applies to the following document mousemove and mouseup
  (`:1585-1612`). Nothing protects the selection after mouseup: with
  SGR + `?1003`, the first motion report clears it (§1.1). A replay also calls
  `terminal.clearSelection()` (`:1293`).
- **Copy.** The custom key handler calls `terminalClipboardShortcut`. On macOS,
  Cmd+C/V; elsewhere Ctrl+C (only with a selection), Ctrl+Shift+C and Ctrl+V
  (`apps/web/src/keybindings.ts:491-521`). Ctrl+Shift+C copies through
  `execCommand("copy")` on xterm's textarea and prints a message if that fails
  (`:1409-1433`). Every other clipboard chord returns `false`, so the browser
  fires native `copy` and `paste` events at xterm's own handlers (`:1436-1439`;
  `xterm6.0:browser/CoreBrowserTerminal.ts:334-343`). With no selection, Ctrl+C
  passes through as `\x03` (`:1411`). On macOS a physical Ctrl+V does not match,
  because Cmd is the primary modifier there, so it goes to the PTY as `\x16`
  (`keybindings.ts:502-510`).
- **Context menu.** `handleContextMenu` acts only when there is a selection and
  a local API. It shows a single "Add to chat" item through
  `localApi.contextMenu.show` (`:1350-1380`, `:1573-1579`). Otherwise the
  browser or webview default menu appears, and xterm's `rightClickHandler`
  copies the selection into its textarea for that menu
  (`xterm6.0:browser/Clipboard.ts:83-93`). In tracking mode the button-2 report
  clears the selection before `contextmenu` fires, so "Add to chat" never
  appears for a TUI selection.
- **Paste.** Pasting is left entirely to xterm's `handlePasteEvent`, which reads
  `text/plain` only (`xterm6.0:browser/Clipboard.ts:43-56`). With an image-only
  clipboard and DECSET 2004 on, it sends an empty `ESC[200~ESC[201~`
  (`Clipboard.ts:21-26`). Whether Claude Code then reads a clipboard on its own
  host is unverified. No image upload exists.
- **Input path.** `terminal.onData` calls `sendTerminalInput` (`:1562-1564`).
  This is the only place outgoing bytes can be filtered, and it runs after
  `onUserInput` has fired.
- **No OSC 52 handler.** Only an OSC 4 reply guard is registered
  (`apps/web/src/components/terminalReplyGuard.ts:41-43`).
- **Uploads that could be reused.**
  - The typed RPC methods `uploads.begin/append/get/cancel` exist
    (`packages/contracts/src/rpc.ts:392-395`).
  - `UploadTarget` has only `chat-attachment` (`packages/contracts/src/uploads.ts:8-14`).
  - `UploadGetResult` returns no path (`uploads.ts:36-42`).
  - The server stages `<id>.upload` files, and the chat attachment consumer
    commits them (`apps/server/src/transfer/staging.rs:337`, `:647-660`).
  - On the client, `stageAttachmentsWithPort` is built around chat attachments
    (`packages/client-runtime/src/operations/attachmentStaging.ts:101-150`).
  - The composer already accepts pasted images from
    `event.clipboardData.files` (`apps/web/src/components/chat/ChatComposer.tsx:1985-1991`).
- **Desktop bridge.** The `DesktopBridge` contract has no clipboard read or
  write. `copyArtifactToClipboard` is in the preview bridge contract
  (`packages/contracts/src/ipc.ts:1408`) but is an `unsupported` stub in Tauri
  (`apps/web/src/tauriPreviewBridge.ts:21-27`, `:177`). A case-insensitive grep
  for `clipboard` under `apps/desktop/src-tauri` finds nothing. Native context
  menus exist through `desktopBridge.showContextMenu`, with a browser fallback
  (`apps/web/src/localApi.ts:42-51`; `ipc.ts:1452-1457`).
- **Topology.** A BiBCode server is one execution environment that owns the
  terminals (`docs/architecture/remote.md:3-7`). A file the server writes is
  therefore always on the PTY's host.

## 4. Gaps and options for BiBCode

### 4.1 Keeping a selection alive under `?1003`

Orca has no direct precedent for keeping a selection alive. Options:

**A. Upgrade to xterm 6.1 and set `mouseEventsRequireAlt: true` permanently.**

- _Precedent:_ the upstream option Orca uses for link gestures
  (`terminal-link-pty-mouse-suppression.ts:91-93`).
- _Fixes:_ both the motion wipe and the right-click wipe. Reports are never
  sent without Alt, so nothing fires `onUserInput`. The force-selection
  inversion (`ThreadTerminalPanel.tsx:1585-1612`) can be deleted, because xterm
  then makes a plain drag select and Alt+drag reach the app.
- _Costs:_
  - The app modifier becomes Alt on every platform, so Linux loses Shift.
  - TUIs never get plain hover or click reports.
  - It requires a beta xterm. The stable 6.1 release status was not verified.
  - The addons would move to matching betas; Orca pins addon-fit
    `0.12.0-beta.300` and addon-webgl `0.20.0-beta.299` (`package.json:257`,
    `:263`).

**B. xterm 6.1, with `mouseEventsRequireAlt` on only while a selection exists.**

- Turn it on in `onSelectionChange` when `hasSelection()` is true, and off when
  the selection becomes empty.
- _Precedent:_ Orca's temporary toggle-and-restore pattern
  (`terminal-link-pty-mouse-suppression.ts:39-55`).
- _Costs:_
  - Turning it off runs `_syncMouseModeState` and then `disable()`, which calls
    `clearSelection()`. That is harmless, because it only happens when the
    selection is already empty.
  - The first plain click while text is selected deselects instead of reaching
    the TUI.
  - The existing inversion would have to work alongside the option's own
    `!altKey` rule.
  - It still requires the 6.1 beta.
- _Benefit:_ hover reports keep flowing whenever nothing is selected.

**C. Stay on 6.0 and stop events in the capture phase while a selection exists.**

- While `terminal.hasSelection()` and `mouseTrackingMode` is `"any"`, call
  `stopPropagation` in a mount capture listener for:
  - `mousemove` with no buttons held. xterm's listener sits on the inner
    `.xterm` element (`xterm6.0:CoreBrowserTerminal.ts:747`).
  - right-button `mousedown` (`:779-788`).
- _Precedent:_ none in Orca. BiBCode already intercepts in the capture phase
  (`ThreadTerminalPanel.tsx:1610-1612`).
- _Costs:_
  - It depends on where xterm attaches its listeners internally.
  - Link hover and cursor-style updates stop while text is selected.
  - The selection still clears on any keypress (`onUserInput`), which is
    intended.

**D. Copy-on-select, or a snapshot of the selection text.**

- _Precedent:_ Orca copy-on-select (`terminal-pane-pane-links.ts:123-168`),
  shipped off by default.
- _Fixes:_ copy works even after the wipe.
- _Costs:_ every drag overwrites the clipboard, and the highlight still
  disappears on the next motion, which breaks the user's mental model
  (`UI.md`). A private snapshot used for Cmd+C and the menu avoids overwriting
  the clipboard but has the same disappearing highlight.

**E. Orca's model: drop the inversion and let the TUI own selection.**

- Requires adding an OSC 52 write handler, gated and size-capped like Orca's
  (`osc52-clipboard.ts:1-31`), and forwarding an unselected Cmd+C to apps that
  negotiated the kitty protocol (`xterm-bypass-policy.ts:285-300`).
- _Costs:_ behaviour depends on each TUI; the CLIs' own copy support is
  unverified. It reverses the decision BiBCode already shipped.

### 4.2 Context menu Copy and Paste

**F. Capture the selection on right-button mousedown, then show Copy, Paste and Add to chat.**

- Read the selection in the capture phase, before xterm sends the report, and
  build the menu through `localApi.contextMenu.show`.
- _Precedent:_ Orca's menu items (`TerminalContextMenu.tsx:194-208`).
- _Costs:_
  - Copy needs a clipboard write that works without a live key gesture: in
    the browser, `navigator.clipboard.writeText` with the `execCommand`
    fallback Orca uses (`web-clipboard-api.ts:143-161`).
  - Paste needs a clipboard read. `navigator.clipboard.readText`/`read` inside
    the Tauri webviews is unverified. A `DesktopBridge` clipboard command would
    be a new privileged surface and needs an approved design (AGENTS.md).
  - Options A, B or C are still needed so the TUI does not lose the selection
    first.

### 4.3 Image paste, local and remote

**G. Intercept the paste event, upload to the environment server, and paste the path in brackets.**

1. Add a capture-phase `paste` listener on the terminal mount. When
   `clipboardData.files` holds an `image/*` and there is no `text/plain`, call
   `preventDefault` and `stopPropagation`. This also stops xterm sending the
   empty bracketed frame.
2. Upload the bytes through `uploads.begin/append`, using a **new**
   `UploadTarget` variant such as `terminal-paste` that is scoped to the
   thread or terminal.
3. Add a server step that commits the upload to a server-generated file with
   no spaces, such as `<tmp>/bibcode-paste-<uuid>.png`, and returns its
   absolute path.
4. Send `ESC[200~<path>ESC[201~` through `sendTerminalInput`.

- _Precedent:_ Orca's runtime and web chunked-upload paths
  (`clipboard-runtime-image-upload.ts:27-106`;
  `web-clipboard-api.ts:163-224`), its forced bracketed paste of the path
  (`terminal-clipboard-paste.ts:81-91`), and BiBCode's own composer reading
  `clipboardData.files` (`ChatComposer.tsx:1985-1991`). Reading from the paste
  event works on insecure origins, where `navigator.clipboard.read()` (Orca's
  web path) does not.
- _Benefit:_ the server is colocated with the PTY, so one path serves local,
  desktop-SSH and remote-endpoint environments. Orca needs a separate SFTP
  branch (`clipboard-image-temp-file.ts:35-43`).
- _Costs and risks:_
  - It is a new contract variant and a new server write path, which needs a
    size cap, a TTL or sweep for temp files (Orca has none for terminal
    pastes), and ownership checks.
  - The living docs for uploads and RPC must be updated.
  - Whether WKWebView and WebKitGTK expose macOS screenshot clipboards in
    `clipboardData.files` is unverified. The composer relies on it, but no test
    in this research proved it.
  - It needs a Windows ConPTY and path-quoting policy if Windows servers
    matter.

**H. Forward Ctrl+V (`\x16`) so the CLI reads its own clipboard.**

- _Precedent:_ none. Orca takes Ctrl+V for itself on Linux and Windows.
- This only works when the CLI runs on the same machine as the clipboard. On
  macOS BiBCode already passes Ctrl+V through as `\x16`. It does not help
  remote or browser clients.

## Not verified

- xterm 6.1 behaviour was read from a minified bundle only.
- Whether a stable `@xterm/xterm` 6.1 is published.
- Whether Codex or opencode draw their own selection and emit OSC 52.
- Whether Claude Code reacts to an empty bracketed paste by reading a local
  clipboard.
- Clipboard `files` and `read()` support inside the Tauri webviews.
- The Orca right-click wipe, which is inferred from event order only.

CodeGraph was not run for this read-only research. Findings come from `rg`,
`grep` and direct source reading.
