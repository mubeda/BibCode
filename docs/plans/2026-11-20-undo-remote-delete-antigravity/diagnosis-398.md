# Diagnosis: Files undo and redo shortcuts (#398)

Status: macOS, Windows and Linux measured 2026-11-20.

## Question

Issue #398 says only the toolbar moves the Files editor history. Its stated
cause, that nothing binds the chords, is wrong. The source editor
(`@pierre/diffs` 1.3.6, `dist/editor/command.js`) binds `cmdOrCtrl+z`,
`cmdOrCtrl+shift+z` and, on Windows and Linux, `ctrl+y`, and the rendered
editor's TipTap history binds `Mod-z`, `Shift-Mod-z` and `Mod-y`. This record
locates where the chord and the Edit menu fail, per platform.

## Method

Spec: `apps/desktop/e2e/specs/files-undo-shortcuts.e2e.ts`, run on the
packaged app with the Profiler on. Each case writes a fresh file, seeds one
history step, sends one input, and checks the editor text and the toolbar's
Undo and Redo enabled states. It appends what reached the page to
`files-undo-matrix.jsonl` in the artifact directory: every `keydown`,
`beforeinput` and `input` at `window` in the capture and bubble phases, and on
the focused element inside a shadow root, with `inputType`, `cancelable`,
`isTrusted` and `defaultPrevented`.

Paths:

- Keystroke: a real operating-system key event (System Events on macOS,
  `SendKeys` on Windows, `xdotool` under Xvfb on Linux).
- Menu: Edit > Undo or Edit > Redo chosen in the native menu bar (System
  Events on macOS, UI Automation on Windows). The item's enabled state is read
  first.
- Page: a `keydown` dispatched at the focused element, the way a browser
  delivers the chord. This replaces the WebDriver driver's keys (see Rulings).

Seeds: typed text (real keys on the keystroke and menu paths, a `beforeinput`
or WebDriver text on the page path), or in the rendered view a toolbar Heading
2 change. A redo case undoes first, either by the same path or by the toolbar
button, and the two are separate cells.

Native input runs only with `BIBCODE_E2E_NATIVE_INPUT=1`, so the default
suite never types into the session in front.

## Matrix

C means the history moved one step and the toolbar agreed. F means it did not.
"Nothing" means no `keydown`, `beforeinput` or `input` reached the page, at
`window` or on the focused element inside the shadow root.

### macOS (packaged app, macOS 27.2, WebKit 605.1.15)

| View     | Direction | Seed or undo before redo | Keystroke                           | Menu (item enabled)                 | Page keydown |
| -------- | --------- | ------------------------ | ----------------------------------- | ----------------------------------- | ------------ |
| Source   | Undo      | typed text               | F, nothing                          | F, nothing                          | C            |
| Source   | Redo      | after toolbar Undo       | F, nothing                          | F, nothing                          | C            |
| Source   | Redo      | after same-path Undo     | not measurable, that Undo fails     | not measurable, that Undo fails     | C            |
| Rendered | Undo      | typed text               | C, trusted cancelable `historyUndo` | C, trusted cancelable `historyUndo` | C            |
| Rendered | Undo      | toolbar Heading 2        | F, nothing                          | F, nothing                          | C            |
| Rendered | Redo      | after same-path Undo     | C, trusted cancelable `historyRedo` | C, trusted cancelable `historyRedo` | C            |
| Rendered | Redo      | after toolbar Undo       | F, nothing                          | F, nothing                          | C            |
| Composer | Undo      | typed text               | C, trusted cancelable `historyUndo` | C, trusted cancelable `historyUndo` | C            |
| Textarea | Undo      | typed text               | C, native undo                      | C, native undo                      | not run      |
| Terminal | Undo      | focused, no step         | nothing reached the page            | not run                             | not run      |

Ctrl/Cmd+S saved the source view on the page path. A real Cmd+Z or
Shift+Cmd+Z never produced a `keydown` in any cell.

### Windows (packaged app, Windows 11 arm64, WebView2 157)

Every cell passed (32 of 32 cases, measured). A real Ctrl+Z, Shift+Ctrl+Z
and Ctrl+Y each reached the page as a trusted `keydown` that the focused
editor cancelled.

| View     | Direction | Seed or undo before redo | Keystroke                                                                                                                      | Menu                            | Page keydown |
| -------- | --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------ |
| Source   | Undo      | typed text               | C, `keydown` Ctrl+Z                                                                                                            | C, injected Ctrl+Z `keydown`    | C            |
| Source   | Redo      | after same-path Undo     | C, Shift+Ctrl+Z and Ctrl+Y                                                                                                     | C, injected Ctrl+Y `keydown`    | C            |
| Source   | Redo      | after toolbar Undo       | C, Shift+Ctrl+Z and Ctrl+Y                                                                                                     | C, injected Ctrl+Y `keydown`    | C            |
| Rendered | Undo      | typed text               | C                                                                                                                              | C, injected Ctrl+Z              | C            |
| Rendered | Undo      | toolbar Heading 2        | C                                                                                                                              | C, injected Ctrl+Z              | C            |
| Rendered | Redo      | after same-path Undo     | C, Shift+Ctrl+Z and Ctrl+Y                                                                                                     | C, injected Ctrl+Y              | C            |
| Rendered | Redo      | after toolbar Undo       | C, Shift+Ctrl+Z and Ctrl+Y                                                                                                     | C, injected Ctrl+Y              | C            |
| Composer | Undo      | typed text               | C, `keydown` cancelled                                                                                                         | C, injected Ctrl+Z              | C            |
| Textarea | Undo      | typed text               | C, native `historyUndo`                                                                                                        | C, injected Ctrl+Z, native undo | not run      |
| Terminal | Undo      | focused, no step         | `keydown` seen in capture only; xterm stopped it (it sends Ctrl+Z to the shell, inferred from xterm 6.0 `Keyboard.ts:308-310`) | not run                         | not run      |

The menu column chose Edit > Undo or Redo from the keyboard (F10, Right,
Down, Enter). UI Automation lists no menu bar for the packaged window,
although `GetMenuItemCount(GetMenu(hwnd))` reports its five menus. Each menu
choice then delivered the chord `muda` 0.19.3 injects with `SendInput`
(`src/platform_impl/windows/mod.rs:1264-1292`): Ctrl+Z for Undo and Ctrl+Y
for Redo. So the Windows menu path is the chord path, measured.

### Linux (packaged AppImage, Ubuntu 22.04 arm64 under Xvfb, WebKitGTK 2.50.4)

A real Ctrl+Z, Shift+Ctrl+Z and Ctrl+Y each reached the page as a trusted
`keydown`, and every Files cell passed (measured). The pinned menu library
(`muda` 0.19.3, `src/platform_impl/gtk/mod.rs:30-43`) creates no predefined
Undo or Redo item on GTK, so the menu column is N.

| View     | Direction | Seed or undo before redo | Keystroke                                        | Menu | Page keydown |
| -------- | --------- | ------------------------ | ------------------------------------------------ | ---- | ------------ |
| Source   | Undo      | typed text               | C, `keydown` Ctrl+Z cancelled                    | N    | C            |
| Source   | Redo      | after same-path Undo     | C, Shift+Ctrl+Z and Ctrl+Y                       | N    | C            |
| Source   | Redo      | after toolbar Undo       | C, Shift+Ctrl+Z and Ctrl+Y                       | N    | C            |
| Rendered | Undo      | typed text               | C                                                | N    | C            |
| Rendered | Undo      | toolbar Heading 2        | C                                                | N    | C            |
| Rendered | Redo      | after same-path Undo     | C, Shift+Ctrl+Z and Ctrl+Y                       | N    | C            |
| Rendered | Redo      | after toolbar Undo       | C, Shift+Ctrl+Z and Ctrl+Y                       | N    | C            |
| Composer | Undo      | typed text               | C, `keydown` cancelled                           | N    | C            |
| Textarea | Undo      | typed text               | F, `keydown` not cancelled, no undo              | N    | not run      |
| Terminal | Undo      | focused, no step         | `keydown` seen in capture only; xterm stopped it | N    | not run      |

The textarea cell failed in 2 of 2 runs. In the same app,
`document.execCommand("undo")` emptied the same kind of textarea and the
composer, so WebKitGTK holds the undo entry but has no Ctrl+Z binding for it,
and the GTK menu has no Undo item to supply one (inferred from both
measurements). This is outside the Files editor and older than this change.

## Cause on macOS

1. The Edit menu holds the predefined Undo and Redo items
   (`apps/desktop/src-tauri/src/window.rs:116-124`). `muda` 0.19.3 maps them
   to the `undo:` and `redo:` responder actions
   (`src/platform_impl/macos/mod.rs:977-986`) with the Cmd+Z and Shift+Cmd+Z
   key equivalents. The menu takes those chords before the page sees a
   `keydown` (measured, no `keydown` in any keystroke cell).
2. `undo:` runs WebKit's own undo. WebKit sends the page a `historyUndo` or
   `historyRedo` `beforeinput` only when its own undo or redo stack holds an
   entry for the focused editable element (measured, typed text in the
   rendered view and the composer gets the event; a toolbar step does not).
3. The source editor cancels every `beforeinput` and applies the edit itself
   (`@pierre/diffs` `dist/editor/editor.js:1036-1040`), so WebKit records no
   undo entry and the menu action reaches nothing. Its `beforeinput` handler
   also has no case for `historyUndo` or `historyRedo`
   (`editor.js:1731-1765`), but no such event arrives.
4. The rendered editor's toolbar commands and its own history do not go
   through WebKit's undo either, so a formatting step, and a redo after a
   toolbar Undo, reach nothing. Typed text works because WebKit recorded it
   and prosemirror-history handles the resulting `historyUndo`.

The editors themselves are correct. Every page-keydown cell passes, including
redo with Shift and the formatting step.

Windows and Linux do not have this failure. There the real chord reaches the
page as a `keydown`, and the focused editor cancels it (measured in every
keystroke cell). The Windows menu items inject the same chords. So #398
reproduces only in the macOS desktop app.

Root-cause tier: Confirmed for steps 1, 3 and 4 by the measured cells.
Step 2 is Supported. It fits every cell, and `document.execCommand("undo")`
in the same app (which runs the same WebKit undo) gave the same results, but
WebKit's undo stack was not read directly.

## Design evidence

`document.execCommand("undo")` run in the packaged macOS app after real typing:

| Focus            | Result                                                                |
| ---------------- | --------------------------------------------------------------------- |
| Chat composer    | trusted cancelable `historyUndo`, handled, text undone                |
| Plain `textarea` | trusted cancelable `historyUndo`, not cancelled, native undo, emptied |
| Rendered view    | trusted cancelable `historyUndo`, handled, one step undone            |
| Source view      | nothing                                                               |

So in the main webview, `execCommand` reproduces what the predefined menu item
does today, for every element.

## Rulings

1. The page column replaces the WebDriver driver keys. The embedded driver
   (`tauri-plugin-wdio-webdriver`) dispatched its keys at the shadow host
   `diffs-container`, outside the source editor's content element, and set
   `keyCode` to the character code (122 for "z", measured). The source editor
   ignores a key whose target is outside its content, and the rendered
   editor's keymap reads Shift+Cmd with keyCode 122 as F11. With the focused
   element as target and `keyCode` 90, every page cell passes. These were
   harness artifacts, not product defects.

## Profiler

No run on any platform recorded a finding or a crash. On every platform the
only repeated event, `rpc.disconnect` with `client-closed` and close code
1001, comes once per case from the harness reloading the page between cases.
The Windows run also logged 22 `rpc.timing` events at the warn tier (1.0 s to
2.8 s, first items of subscriptions and `server.discoverSourceControl`) while
a Linux build loaded the same host (inferred as host load, not measured in
isolation).

## Dispositions

| Cells                                                                                                                    | Disposition  | Reason                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, keystroke and menu: source undo and redo; rendered undo of a formatting step; rendered redo after a toolbar Undo  | B            | Nothing reaches the webview. The menu takes the chord, and WebKit's undo has no entry for these steps.                                                                 |
| macOS, keystroke and menu: rendered undo of typed text, rendered redo after a same-path Undo, composer and textarea undo | C            | Pass.                                                                                                                                                                  |
| macOS, page keydown: every cell                                                                                          | C            | Pass.                                                                                                                                                                  |
| Windows, every cell (keystroke, menu, page)                                                                              | C            | Pass. The menu items inject the same chords.                                                                                                                           |
| Linux, keystroke and page cells in Files and the composer                                                                | C            | Pass.                                                                                                                                                                  |
| Linux, menu cells                                                                                                        | N            | `muda` 0.19.3 creates no predefined Undo or Redo item on GTK.                                                                                                          |
| Linux, plain textarea keystroke undo                                                                                     | outside #398 | Fails today, outside Files. WebKitGTK gets the `keydown` and has no undo binding. Proposed as a follow-up issue. R4 only requires that this change leaves it as it is. |
| Terminal, every platform                                                                                                 | recorded     | No undo history. On macOS the chord reaches nothing. On Windows and Linux xterm takes Ctrl+Z, which a change reaching those platforms must not intercept.              |
