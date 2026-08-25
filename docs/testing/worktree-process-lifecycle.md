# Worktree Process Lifecycle Validation

Use this runbook when environment routing, project admission, worktree
discovery/adoption/removal, provider execution, terminals, VCS observation, or
remote folder selection changes. Read [Cross-platform
validation](./cross-platform-validation.md), [Process
lifecycle](./process-lifecycle.md), and the native OS page first.

## Invariants

- A project and its Main/thread/worktree rows belong to exactly one environment.
- One verified Git common directory may back only one active project in that
  environment. An independent clone is a different project; the same repository
  on another environment is also independent.
- Worktree display paths may preserve useful spelling, but physical identity and
  repository claims own duplicate prevention and destructive authorization.
- Worktree processes run on the environment that owns the project. WSL and SSH
  workspaces never fall back to desktop Git, filesystem, terminal, or provider
  execution.
- Detach/remove-from-BiBCode is distinct from verified Git worktree deletion.

## Disposable native fixture

Create a unique repository and at least two linked worktrees outside user
project and BiBCode-managed roots. Include a path with spaces plus the native
alias case: Windows drive/separator/case and junction spelling, or Unix symlink
and physical path. Record `git worktree list --porcelain`, common-directory
identity, worktree physical identity, display paths, branches, and exact fixture
root.

Run the fixture independently on the desktop environment, one accepted WSL
environment on Windows, and one enrolled SSH environment when those hosts are in
scope. Folder picking must browse the selected environment and return that
environment's path semantics.

## Admission and persistence

For every environment:

1. add the primary checkout and record `created`, Project, and Main IDs;
2. add the same primary path, its alias, and one linked worktree and record
   `existing` with the same Project/Main IDs;
3. add an independent clone and record a new project;
4. add the original repository family on another environment and record an
   independent project;
5. discover and adopt a linked worktree, repeat adoption, and prove one row;
6. hide and reveal a candidate without deleting it;
7. retarget only with the expected generation and verified identity;
8. restart/reconnect and prove identities, adoption, and display paths persist;
9. detach from BiBCode and prove the Git worktree remains; and
10. delete only a fixture-owned worktree after the removal preview proves
    identity, dirty/lock state, and selected mode.

Replace a fixture path between preview and mutation and prove removal fails
closed. Exercise missing-registered and missing-unregistered states without
guessing that an absent path is safe to delete.

## Execution routing and child ownership

In Main and an adopted worktree, run bounded Git status, file read/write,
terminal, and provider fixtures. Capture the execution host, working directory,
PID/process-group or Job identity, and route. Prove worktree children inherit
the exact worktree root and that cancellation, thread closure, environment
disconnect, Forget, and desktop/server shutdown reap only their owned roots.

Keep VCS subscriptions active through content, index, `HEAD`, packed-ref, and
nested-ref changes. Verify watcher fallback and safety refresh do not duplicate
Git work across aliases or environments. Reconnection must not allow an older
environment/route generation to publish worktree state into the new owner.

## Final evidence

After restart and cleanup, show that every non-deleted fixture worktree still
exists, deleted fixtures are exactly the authorized targets, repository claims
have no duplicates, unrelated repositories/processes remain intact, and no
run-owned provider, terminal, Git, WSL, SSH, or server process survives.

Record native evidence separately for Windows, Linux, macOS, WSL, and SSH.
Cross-target fixtures remain compatibility evidence only.
