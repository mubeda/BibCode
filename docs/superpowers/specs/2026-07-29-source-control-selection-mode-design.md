# Source Control Selection Mode Design

**Date:** 2026-07-29
**Status:** Approved in brainstorming; pending written-spec review

## Summary

Replace the two always-visible checkboxes in each Source Control file row with one
contextual checkbox:

- in normal mode, it stages or unstages the file;
- in selection mode, it selects the file for bulk discard, delete, or ignore.

Selection mode is explicit and visually distinct. It preserves the existing bulk
actions without making users infer why two identical controls sit beside every
file.

## Goals

- Show at most one checkbox per file row.
- Preserve arbitrary multi-file **Discard/Delete Selected** and **Ignore
  Selected** workflows.
- Make the current checkbox purpose clear from the active mode and accessible
  label.
- Reuse the existing selection state, Git actions, confirmations, and failure
  handling.

## Non-Goals

- Changing Git staging, discard, delete, or ignore semantics.
- Adding keyboard range selection, drag selection, or a new selection framework.
- Changing file-row navigation or the navigation-only context menu.
- Refactoring unrelated Source Control panel behavior.

## Current Behavior and Root Cause

`SourceControlChangesList` currently renders two independent `Checkbox`
components when the panel supplies both prop sets:

1. `checked` and `onToggle` control Git staging.
2. `selected` and `onSelect` control bulk actions.

`SourceControlPanel` always supplies both sets for staged, unstaged, and untracked
sections. The controls are visually identical and adjacent, so their different
purposes are discoverable only through accessible labels or by clicking them.

## Approaches Considered

### Dedicated selection mode — selected

Reuse one leading checkbox slot and change its behavior only after the user enters
an explicit selection mode. This removes the ambiguity while preserving bulk
actions.

### Keep both checkboxes and distinguish them

Labels, spacing, or different icons could explain the controls, but every row
would remain visually dense and the panel would still expose two competing
selection models simultaneously.

### Remove bulk selection

Keeping only per-file and all-files actions would be the smallest UI, but it would
remove the existing ability to discard or ignore an arbitrary subset of files.

## Interaction Design

### Normal mode

- Each row shows one Stage/Unstage checkbox using its existing checked state,
  handler, and `Stage <path>` or `Unstage <path>` accessible label.
- For repositories with staging-area support, the primary action strip gains a
  **Select** button. Legacy flat-list servers do not expose selection mode.
- Existing **Discard All**, primary Git action, dropdown, section actions, and
  per-row Git actions remain unchanged.

### Entering selection mode

Activating **Select**:

- keeps the panel, commit message, file groups, and scroll position in place;
- replaces the primary Git action strip with a selection strip;
- changes the single leading checkbox in every row from staging to selection;
- hides section and per-row Git mutation actions until selection mode ends.

The selection strip contains:

1. **Cancel**
2. `N files selected`
3. **Discard** or **Delete**
4. **Ignore**

With no selection, the count reads `0 files selected` and the destructive actions
are disabled.

### Selecting files

- Row checkboxes use `Select <path>` and `Deselect <path>` accessible labels.
- Selected rows receive the existing accent-style highlight without changing file
  text or diff statistics.
- Each section header offers **Select all**. When every file in that section is
  selected, the action becomes **Clear section**.
- Selection may span staged, unstaged, and untracked sections.
- Clicking the file body continues to open its diff and does not toggle selection.

### Bulk actions

- If every selected file is untracked, the destructive action is **Delete**.
- Otherwise, it is **Discard**.
- **Discard/Delete** uses the existing confirmation dialog and staged-file
  unstage-before-discard behavior.
- **Ignore** uses the existing `.gitignore` update and discard behavior.

After a successful bulk action, selection is cleared and the panel returns to
normal mode. On failure or interruption, selection mode and the surviving
selection remain so the user can retry or cancel.

### Exiting selection mode

**Cancel** and Escape clear the selection and restore normal staging controls.
Files removed by a status refresh are pruned through the existing selection
cleanup before the count and action labels are derived.

## Component Changes

- `SourceControlPanel` owns the boolean selection-mode state alongside the
  existing `selectedFilePaths`.
- `SourceControlSection` receives the active mode and section-level select/clear
  action.
- `SourceControlChangesList` renders one checkbox branch per row, deriving its
  checked state, handler, and accessible label from the active mode.
- Existing Git action functions and confirmation dialogs remain the only mutation
  paths; no new state store, component abstraction, or dependency is introduced.

## Accessibility

- The **Select** button exposes its text label.
- The mode change is announced through the visible selected-count text.
- Every row checkbox names both its action and file path.
- Disabled bulk actions remain focusable only according to the existing `Button`
  primitive behavior.
- Escape is an additional exit path; **Cancel** remains the visible and
  keyboard-accessible path.
- Focus moves to **Cancel** when selection mode opens and returns to **Select**
  when it closes.

## Testing Strategy

- Normal mode renders exactly one checkbox per row and invokes Stage/Unstage.
- Selection mode renders exactly one checkbox per row and invokes selection
  without invoking staging.
- Enter, Cancel, and Escape transition modes and clear selection as specified.
- Section **Select all** and **Clear section** affect only that section.
- Selection can span sections and produces the correct count.
- All-untracked selection shows **Delete**; mixed or tracked selection shows
  **Discard**.
- Successful actions clear and exit; failed actions preserve mode and selection.
- File-row navigation and navigation-only context menus remain available.
- Legacy servers that omit staging areas retain their existing flat-list
  behavior and do not gain unsupported staging controls.

## Completion Gates

- Focused Source Control component and behavior tests pass.
- `vp check` passes.
- `vp run typecheck` passes.
