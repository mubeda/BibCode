# Diagnosis: Files undo and redo shortcuts (#398)

Status: macOS measured 2026-11-20. Windows and Linux pending.

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
| Composer | Undo      | typed text               | C, trusted cancelable `historyUndo` | not run                             | C            |

Ctrl/Cmd+S saved the source view on the page path. A real Cmd+Z or
Shift+Cmd+Z never produced a `keydown` in any cell.

### Windows

Pending. It needs a packaged build in the Windows lab.

### Linux

Pending. It needs a packaged build in the Linux lab. The pinned menu library
(`muda` 0.19.3, `src/platform_impl/gtk/mod.rs:30-43`) creates no predefined
Undo or Redo item on GTK, so the menu column is N there.

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

The macOS runs recorded no findings and no crashes. The only repeated event,
`rpc.disconnect` with `client-closed` and close code 1001, comes once per case
from the harness reloading the page between cases.

## Dispositions

| Cells                                                                                                                   | Disposition | Reason                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| macOS, keystroke and menu: source undo and redo; rendered undo of a formatting step; rendered redo after a toolbar Undo | B           | Nothing reaches the webview. The menu takes the chord, and WebKit's undo has no entry for these steps. |
| macOS, keystroke and menu: rendered undo of typed text, rendered redo after a same-path Undo, composer undo             | C           | Pass.                                                                                                  |
| macOS, page keydown: every cell                                                                                         | C           | Pass.                                                                                                  |
| Windows, every cell                                                                                                     | pending     | Not yet measured.                                                                                      |
| Linux, keystroke and page cells                                                                                         | pending     | Not yet measured.                                                                                      |
| Linux, menu cells                                                                                                       | N           | `muda` 0.19.3 creates no predefined Undo or Redo item on GTK.                                          |
