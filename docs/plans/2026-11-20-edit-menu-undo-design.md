# Edit menu Undo and Redo reach the Files editor (#398)

Status: Revision 2 for review, 2026-11-20. Revision 1 had Codex review
"Needs rework" with six findings; the outcome of each is under Review record.
Scope is macOS only. Windows and Linux keep their menu: every Files cell
passed there by the real chord, and the Windows menu items inject the same
chords (measured, see the diagnosis). On those platforms Ctrl+Z also stays
the terminal's suspend key, because nothing here intercepts it.

Issue #408, ticketed for this PR, adds one Linux desktop rule outside the
Edit menu: an uncancelled Ctrl+Z, Shift+Ctrl+Z or Ctrl+Y in an `input` or
`textarea` runs `document.execCommand`, because WebKitGTK binds no undo key
for those fields and GTK has no Edit > Undo item. Editors, the composer and
xterm cancel their own chords first, so only plain fields change.
Evidence: [diagnosis-398.md](2026-11-20-undo-remote-delete-antigravity/diagnosis-398.md).
Requirements: spec R5 and decision D10, with R1, R2 and R4.

## Problem

In the packaged macOS app, Cmd+Z, Shift+Cmd+Z and Edit > Undo or Redo do not
move the Files source history. In the rendered view they miss formatting steps
and a redo after a toolbar Undo. The editors bind the chords correctly: every
cell passes when the page receives a `keydown`. The predefined Edit items take
the chords first and send `undo:` or `redo:`, which WebKit turns into a
`historyUndo` or `historyRedo` event only when its own undo stack holds an
entry for the focused element. The Files editors apply their edits themselves,
so for most Files steps nothing arrives.

## Decision

1. On macOS the Edit menu's Undo and Redo become custom items with the menu
   ids `bibcode:edit-undo` and `bibcode:edit-redo` and the accelerators
   `CmdOrCtrl+Z` and `CmdOrCtrl+Shift+Z`. They replace the predefined items,
   as the custom Quit item replaced the predefined Quit. `menu_action_for_id`
   maps them to new variants, not to `Emit`, because they need the routing in
   step 2.
2. The host decides on the main thread, in the menu handler, whether the page
   may handle the action.
   - The page may handle it when `NSApplication::keyWindow` is the main
     window's `NSWindow` and the window's `firstResponder`, downcast to
     `NSView`, is the main webview's `WKWebView` or a descendant of it
     (`isDescendantOf:`). The `WKWebView` is the one Tauri returns for the main
     webview, not the window, its content view or Wry's `WryWebViewParent`.
     The preview's child webview is a sibling of the main `WKWebView` under
     that parent (`wry` 0.55.1 `src/wkwebview/mod.rs:665-686`), so it fails
     the check.
   - Then the host emits `edit-undo` or `edit-redo` over `MENU_ACTION_EVENT`
     to the main webview only (`emit_to` with the main label), not app-wide as
     the existing actions are.
   - Otherwise, or if any step of the check cannot be completed, the host
     calls `sendAction:to:from:` with `undo:` or `redo:` and a nil target.
     AppKit then walks the responder chain from the key window's first
     responder, as the predefined item does today. Native Save and Open
     panels, the preview webview and a modal sheet keep today's behavior.
3. The web decides at delivery, in one listener mounted on every route of the
   main webview.
   - It finds the focused element, looking through open shadow roots.
   - If that element is editable text (`isContentEditable`, which the source
     editor's content element and the rendered editor are, and a `textarea`
     or `input` is not) inside a registered Files region (containment, across
     shadow roots), and no composition is in progress, it calls that
     region's undo or redo: the same operation
     the toolbar buttons call (`FilePreviewPanel.tsx:1125-1126`), shared with
     the toolbar, not copied. With an empty history this changes nothing, like
     the disabled toolbar button.
   - Otherwise it calls `document.execCommand("undo")` or
     `document.execCommand("redo")`, which in WebKit runs the same native undo
     the predefined item runs (measured for the composer, a textarea and the
     rendered view).
4. No keyboard event is dispatched. The app's keybinding layer and
   `shortcutModifierState` never see a menu action.

No new bridge command or event is added, and the contracts do not change. The
existing string-valued menu action carries the two ids.

## Routing by focused element

| Focus at delivery                       | Result                                                             | Evidence                                                                |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Files source editor                     | That panel's history, one step.                                    | Shares the toolbar operation (measured to move one step).               |
| Files rendered editor                   | That panel's rich-editor history, one step.                        | Same.                                                                   |
| Files editor with an active composition | `execCommand`, today's behavior.                                   | Task 1.2 web test with composition events. A real IME is not automated. |
| Inline comment textarea, Link URL field | `execCommand`, native undo of that field. Files history unchanged. | Not editable text. Measured for the comment field; Link URL not run.    |
| Chat composer (Lexical)                 | `execCommand`, Lexical handles `historyUndo`.                      | Measured: keystroke and menu cells pass today; `execCommand` probe.     |
| Plain `input` or `textarea`             | `execCommand`, native undo.                                        | Measured: `execCommand` emptied a typed textarea.                       |
| Terminal                                | `execCommand` on xterm's textarea, as the predefined item does.    | Measured: today a real Cmd+Z delivers nothing there.                    |
| Preview webview, native panel, sheet    | Native `undo:` through the responder chain, as today.              | Host check in step 2. Not run in a packaged test.                       |
| Main webview with no listener mounted   | Not possible: the listener is mounted on every route.              | Step 3 and Files below.                                                 |

Redo follows the same table.

## Timing and repeat

The menu event carries only the id and reaches the page a few milliseconds
later. The page acts on the element focused when it arrives, as it would for
a queued keystroke. The host check runs at the menu event, so an action whose
first responder was a native panel or the preview never reaches the page.

AppKit sends one `performKeyEquivalent:` per key repeat, so a held Cmd+Z fires
one menu action per repeat. Each moves the history one step, as each repeat
of the predefined item does today. The page cannot tell a click from a repeat
and does not need to.

The custom items stay enabled, as the predefined ones are: `muda` 0.19.3 turns
off `autoenablesItems` on the submenu (`src/platform_impl/macos/mod.rs:791`)
and both item kinds report enabled (measured: Undo enabled with an empty
history).

## Alternatives

1. Keep the predefined items and handle `historyUndo` on the Files editing
   host (disposition A). Rejected, because for the source view and toolbar
   steps no event arrives (measured).
2. Keep custom items but clear their accelerators, so the chord reaches the
   page as a `keydown`. Rejected, because a plain textarea then loses Cmd+Z
   (measured, see Probe), and a menu click still needs the routing above.
3. Dispatch a synthetic chord `keydown` at the focused element (revision 1).
   Rejected, because it reaches the app's keybinding layer and modifier
   tracking, and it bypasses the editors' composition guards (Codex findings 1
   and 2).
4. Emit app-wide and let the page fall back. Rejected, because the preview
   webview and native panels would lose undo (Codex finding 3).

## Probe

A lab-only macOS build, not committed, gave the Edit menu's Undo and Redo no
accelerator and no action, and ran the matrix spec with real keystrokes.

- A real Cmd+Z and Shift+Cmd+Z then reached the page as a `keydown` in every
  cell, and the focused editor cancelled it.
- Every Files keystroke cell passed, the formatting step and redo after a
  toolbar Undo included, and so did the composer.
- A plain textarea did not undo. Its `keydown` arrived, nothing cancelled it,
  and WebKit ran no native undo, because no menu item holds Cmd+Z.
- The terminal received the `keydown`, which xterm leaves alone on macOS.

So the menu key equivalent is what takes the chord from the page, and plain
fields depend on it for their undo. The custom items keep the accelerators.

## Files

- `apps/desktop/src-tauri/src/window.rs`: the two custom items on macOS, their
  `ApplicationMenuAction` variants, the first-responder check, the native
  fallback and the targeted emit.
- `apps/web/src/components/files/`: the registry of Files editing hosts, the
  menu listener function and its hook. `FilePreviewPanel.tsx` registers both
  surfaces with the toolbar's shared history.
- `apps/web/src/routes/__root.tsx`: outside Phase 1's ownership, handed to the
  executor. One call of the listener hook in `RootRouteView`, so it runs on
  `/pair` and unauthenticated routes too. `AppSidebarLayout.tsx` is not
  mounted there.
- `docs/architecture/overview.md`: the DesktopBridge section describes the
  Edit menu actions and the native fallback.
- `docs/user/keybindings.md`: the Files chords (Task 1.3).

The AppKit classes the check needs (`NSApplication`, `NSWindow`,
`NSResponder`, `NSView`) are default features of the pinned `objc2-app-kit`
0.3.2, which the desktop crate already depends on, so `Cargo.toml` and
`Cargo.lock` stay as they are.

## Tests

- Rust: on macOS the Edit menu's Undo and Redo carry `bibcode:edit-undo` and
  `bibcode:edit-redo` with `CmdOrCtrl+Z` and `CmdOrCtrl+Shift+Z`, and
  `menu_action_for_id` maps both to the routed variants.
- Web: with two registered hosts holding independent histories, the action
  moves only the focused one, one step; a focused comment textarea or input
  runs `execCommand` and moves no Files history; an active composition runs
  `execCommand`; an empty history changes nothing and runs no `execCommand`;
  redo mirrors undo.
- Packaged, macOS lab, for each of keystroke and menu click (run, 38 of 38
  passed): two independent seeded steps in each Files view (catches a double
  step); a formatting step; redo after a toolbar Undo; independent edits in
  Files and in the inline comment field, proving which history moved; the
  composer and a plain textarea in both directions.
- Not run: the Link URL field, a held chord, a typed field in the preview
  webview or a native panel (so the native `undo:` branch never ran in a
  packaged test), and a custom `mod+z` keybinding. The last cannot fire from
  the menu by construction, because no keyboard event is dispatched.
- Not automated: a real input method with marked text (System Events cannot
  drive one reliably); the web test covers the composition guard.
- When a file is deleted on disk, the toolbar disables Undo and Redo, but the
  chord already reaches the editor's own binding there on every platform
  (inferred from the code, not measured). The menu follows the chord, not the
  button.

## Risks

- `document.execCommand` is deprecated but implemented by WebKit, and it is the
  fallback only.
- If the host check misjudges focus, the result is today's behavior (native
  `undo:`), never a Files step in another surface.

## Review record

Revision 1, Codex review: Needs rework, six findings. Revision 2 handles them
as follows.

| Finding                                                                      | Label      | Outcome                                                                                                                                                        | Where                           |
| ---------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1. A synthetic `keydown` reaches the keybinding layer and modifier tracking  | blocking   | Fixed. No keyboard event is dispatched; a Files host gets its history call, anything else gets `execCommand`.                                                  | Decision 3 and 4                |
| 2. A synthetic `keydown` bypasses composition guards                         | blocking   | Fixed. No synthetic event; an active composition on a Files host takes the native path.                                                                        | Decision 3, Routing table       |
| 3. Stale focus, an app-wide emit, routes without the listener                | blocking   | Fixed. Targeted `emit_to` the main webview; the web decides at delivery; the listener is mounted in `__root.tsx` on every route.                               | Decision 2 and 3, Timing, Files |
| 4. The native check needs a precise boundary; a nil target walks the chain   | suggestion | Fixed. `keyWindow` equals the main window and `firstResponder` descends from the main `WKWebView`; the text now says the nil target walks the responder chain. | Decision 2                      |
| 5. Enabled state, empty history, key repeat                                  | question   | Answered. Items stay enabled as today; an empty Files history changes nothing; each repeat moves one step, as today.                                           | Decision 3, Timing              |
| 6. Windows and Linux need packaged evidence; Linux menu disposition; tooltip | blocking   | Fixed. Both measured: every Files cell passes, so the design stays macOS-only; Linux menu is N. The Redo tooltip stays in Task 1.3.                            | Status, diagnosis               |

The coordinator accepted revision 2 on 2026-11-20. The advisor reviewed the
implementation against it and its remaining points are recorded in the lane
report.
