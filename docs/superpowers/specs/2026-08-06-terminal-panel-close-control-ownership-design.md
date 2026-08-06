# Terminal Panel Close-Control Ownership Design

## Summary

BiBCode terminal surfaces currently expose a top-level trash button inside the terminal renderer even though the surrounding center or right-panel tab already owns surface closure. Remove that duplicate top-level trash control and make the panel/tab close button the single control for closing an entire terminal surface.

## Approved Product Decision

- Remove the top-level trash/`Close Terminal` action from both terminal-renderer toolbar variants:
  - the floating toolbar used without the terminal sidebar;
  - the compact toolbar above the terminal sidebar.
- Apply the removal to both `center-panel` and `right-panel` renderer owners.
- Keep the surrounding panel/tab close button as the authoritative whole-surface close action.
- Keep per-terminal close controls in the right-panel split/group list. Those controls remove one terminal session from a multi-terminal surface and are not duplicates of whole-panel closure.
- Keep keyboard close behavior, including `Cmd/Ctrl+W`, unchanged.

## Component Ownership

`ThreadTerminalPanel` owns terminal rendering and terminal-local actions such as creating or splitting terminals. It must no longer render a whole-surface deletion control.

The surrounding center/right workspace owns surface tabs and their close controls. Those existing close callbacks remain responsible for removing the surface and calling the shared terminal-retirement path, including `terminal.close({ deleteHistory: true })` and its interruption-aware fallback behavior.

The right-panel terminal list continues owning individual-session close controls for split/grouped terminals.

## Toolbar Layout

Removing the trash action must also remove its adjacent separator. The toolbar must not leave a trailing divider or an empty bordered control shell:

- render split/new actions exactly as today;
- render separators only between actions that are actually present;
- omit a toolbar container or sidebar toolbar row when it has no remaining actions.

The change must preserve the existing right inset, panel content geometry, focus behavior, and accessible names for every retained action.

## Lifecycle and Error Handling

No terminal lifecycle implementation changes are required. Panel/tab close already routes through the durable terminal-retirement behavior. Removing the duplicate renderer button must not bypass, duplicate, or weaken that path.

Individual split-terminal close controls retain their existing lifecycle and failure handling.

## Testing

Use test-driven development:

1. Add renderer tests that fail while an exact top-level `Close Terminal` toolbar action remains.
2. Cover both toolbar variants and both renderer owners where their markup differs.
3. Assert retained split/new controls do not gain a trailing separator or empty toolbar shell.
4. Assert per-terminal split/group close controls remain available.
5. Retain or strengthen surrounding panel/tab-close tests proving surface removal invokes terminal retirement.
6. Run focused terminal renderer/workspace tests, then `vp test`, `vp check`, and `vp run typecheck`.
7. Rebuild the desktop release and use Codex Computer Use on the exact worktree bundle to verify the trash icon is absent and the panel/tab close button removes the terminal surface/session.

## Acceptance Criteria

1. No top-level trash/delete button appears inside a center or right terminal panel.
2. Closing the terminal panel/tab removes its surface and retires its backend session.
3. Per-terminal close controls remain available for right-panel split/group sessions.
4. No empty toolbar shell or trailing separator remains after the deletion control is removed.
5. Keyboard terminal-close behavior remains unchanged.
6. Focused and full automated verification, desktop build, and exact-bundle visual/interaction QA pass.

## Out of Scope

- Changing terminal split/new behavior.
- Removing per-terminal split/group close controls.
- Changing keyboard shortcuts or keybinding migration.
- Changing the shared terminal-retirement policy.
