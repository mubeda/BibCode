# Project Toolbar Actions Design

## Goal

Make the project-row actions clearer without changing their behavior or layout.

## Design

- Keep the existing main-branch chat button rendered, including its handler and tooltip, but apply CSS `invisible` to its button. This hides it from view and interaction while preserving its layout footprint.
- Replace the worktree action's `SquarePenIcon` with `FolderGit2Icon`. This reuses the icon already used for worktrees in the branch toolbar and workspace mode selector.
- Keep the existing worktree button label, tooltip, click behavior, sizing, spacing, hover behavior, and mobile behavior unchanged.

## Testing

Update the existing Sidebar tests to verify that:

- the main-branch chat button remains rendered and has the `invisible` class;
- the worktree action renders `FolderGit2Icon` instead of `SquarePenIcon`;
- the existing worktree click behavior remains covered.

## Non-goals

- Do not delete the main-branch chat action or its code path.
- Do not change how chats or worktrees are created.
- Do not change toolbar spacing, tooltip text, or responsive behavior.
- Do not add dependencies or introduce a new icon abstraction.
