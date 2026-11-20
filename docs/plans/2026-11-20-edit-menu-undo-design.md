# Edit menu Undo and Redo reach the Files editor (#398)

Status: Draft for review, 2026-11-20. Scope is macOS; Windows and Linux are
pending measurement and keep their current menu until a measured cell needs a
change.
Evidence: [diagnosis-398.md](2026-11-20-undo-remote-delete-antigravity/diagnosis-398.md).
Requirements: spec R5 and decision D10, with R1, R2 and R4.

## Problem

In the packaged macOS app, Cmd+Z, Shift+Cmd+Z and Edit > Undo or Redo do not
move the Files source history, and in the rendered view they miss formatting
steps and a redo after a toolbar Undo. The editors bind the chords correctly:
every cell passes when the page receives a `keydown`. The predefined Edit menu
items take the chords first and run WebKit's own undo, which reaches the page
only for edits WebKit recorded itself. The source editor applies every edit
itself, so WebKit has nothing to undo and the page receives nothing.

## Decision

1. On macOS, the Edit menu's Undo and Redo become custom items with the menu
   ids `bibcode:edit-undo` and `bibcode:edit-redo` and the accelerators
   `CmdOrCtrl+Z` and `CmdOrCtrl+Shift+Z`, replacing the predefined items.
   `menu_action_for_id` maps them to the actions `edit-undo` and `edit-redo`,
   like the existing items. This follows the precedent of the custom Quit
   item.
2. The host's menu handler checks the key window's first responder.
   - If it is the main window's webview or a view inside it, the host emits the
     id over the existing `MENU_ACTION_EVENT` (`desktop:menu-action`), which
     the web receives through `DesktopBridge.onMenuAction`.
   - Otherwise the host sends `undo:` or `redo:` to the first responder with
     `NSApplication::sendAction_to_from` and a nil target. That is the action
     the predefined item sends today, so native Save and Open panels and the
     preview's child webview keep their own undo.
3. The web's existing menu listener in `AppSidebarLayout.tsx` handles the two
   ids. It finds the focused element, looking through open shadow roots, and
   dispatches at it a cancelable, bubbling, composed `keydown` that matches
   the chord (`key` "z" or "Z", `code` "KeyZ", `keyCode` 90, `metaKey`, and
   `shiftKey` for redo). If no handler cancels that `keydown`, it runs
   `document.execCommand("undo")` or `document.execCommand("redo")`.

No new bridge command or event is added, and the contracts do not change. The
existing string-valued menu action carries the two ids.

## Routing by focused element

| Focus                                      | What handles the action                                                                                       | Evidence                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Files source view                          | The source editor's own `cmdOrCtrl+z` binding cancels the `keydown`; one step.                                | Measured, every source page-keydown cell passes.                                                   |
| Files rendered view                        | TipTap's `Mod-z` binding cancels the `keydown`; one step, no `execCommand`.                                   | Measured, rendered page-keydown cells pass, the formatting step included.                          |
| Inline comment textarea in the source view | Not cancelled by the source editor, so `execCommand` runs its native undo.                                    | To verify in Task 1.2 (React renders it outside the editor's content element; inferred from code). |
| Chat composer (Lexical)                    | Lexical's history cancels the `keydown`; one step.                                                            | Measured, composer page-keydown cell passes.                                                       |
| Plain `input` or `textarea`                | Nothing cancels the `keydown`, so `execCommand` runs its native undo.                                         | Measured, `execCommand("undo")` emptied a typed textarea.                                          |
| Terminal                                   | xterm does not cancel Cmd+Z, so `execCommand` runs on its hidden textarea, as the predefined item does today. | Inferred from code; Task 1.2 re-measures it.                                                       |
| Preview child webview, native panels       | The host sends `undo:` to that first responder, as today.                                                     | To verify in Task 1.2.                                                                             |

Redo follows the same table with `historyRedo`, Shift+Cmd+Z and
`execCommand("redo")`.

## Alternatives

1. Keep the predefined items and handle `historyUndo` on the Files editing
   host (disposition A). Rejected, because for the source view and toolbar steps no
   event arrives (measured).
2. Custom items with no accelerator, so the chord reaches the page as a
   `keydown`. Rejected, because WebKit would then have no Cmd+Z for plain text fields,
   the preview webview or native panels (inferred), and the menu would show no
   shortcut.
3. A web registry of Files histories that the menu action calls directly.
   Rejected, because it needs its own rule for which history (source or rendered) and
   which element (the comment textarea), which the editors' own bindings
   already make. The re-dispatched `keydown` reuses them.
4. Always emit to the main webview. Rejected, because the preview webview and native
   panels would lose undo.

## Files

- `apps/desktop/src-tauri/src/window.rs`: the two custom items on macOS, the
  ids in `menu_action_for_id`, and the first-responder check.
- `apps/web/src/components/AppSidebarLayout.tsx`: the two ids in the menu
  listener, through a small exported function so it can be tested alone.
- `docs/architecture/overview.md`: the DesktopBridge section describes the
  Edit menu actions.
- `docs/user/keybindings.md`: the Files chords (Task 1.3).

No file outside Phase 1's ownership changes. The AppKit classes the check
needs (`NSApplication`, `NSWindow`, `NSResponder`, `NSView`) are default
features of the pinned `objc2-app-kit` 0.3.2, which the desktop crate already
depends on, so `Cargo.toml` and `Cargo.lock` stay as they are.

## Tests

- Rust: on macOS the Edit menu's Undo and Redo carry `edit-undo` and
  `edit-redo` with `CmdOrCtrl+Z` and `CmdOrCtrl+Shift+Z`, and
  `menu_action_for_id` maps both.
- Web: the menu function cancels nothing and runs `execCommand` for a real
  `textarea`; runs no `execCommand` when a `keydown` handler on the focused
  element cancels the chord; reaches an element inside an open shadow root;
  and sends Shift for redo.
- Packaged, macOS lab: every matrix cell again (keystroke, menu, page), the
  comment textarea, the composer, a terminal, and a typed field in the preview
  webview.

## Risks

- The dispatched `keydown` is untrusted. No editor in the table checks
  `isTrusted` (searched in `@pierre/diffs`, prosemirror-view, Lexical and
  xterm). The app's keybinding handlers also see it; no default binding uses
  `mod+z`.
- The host's first-responder check runs on the main thread inside the menu
  handler. If it cannot tell, it sends `undo:` natively, which is today's
  behavior.
- `document.execCommand` is deprecated but implemented by WebKit, and it is
  the fallback only.

## Review record

Pending, Codex and the advisor.
