# Merge into another branch and Source Control merge — design

Status: approved in conversation 2026-10-08; spec awaiting review. This spec is
the AGENTS.md design note for the two architectural decisions it records: the
`merge-into` ref-write primitive and the `vcs.status` conflict-state shape.

## Goal

1. **Git Manager, merge into another branch.** From the **Merge…** dialog the
   user merges a source branch into a target branch that is not checked out.
   The selected worktree's HEAD, index and files do not change.
2. **Source Control, merge into the current branch.** From the Source Control
   panel the user picks a local or remote branch, fetches its remote, and merges
   it into the current worktree's branch, then resolves conflicts in the panel.

What the user asked for: both actions. Assumed (approved): defaults from the
research report's decision table, plus the shared fixes both actions depend on.

## Scope

In scope:

- Shared groundwork: the `vcs.status` conflict decode fix and an in-progress
  signal; hardened merge-tree exit classification; a Git 2.38 runtime check for
  merge previews and `merge-into`; remote branches as merge sources in the
  Merge dialog.
- Feature 2: Source Control menu item, reused merge dialog with Fetch, merge
  commit only, conflict strip (Commit merge / Abort) and conflicted-file list
  with Ours/Theirs.
- Feature 1: `merge-into` operation, capability flag, Into picker, plumbing
  merge published with fast-forward-only `fetch .`.

Out of scope: squash-merge conflict recovery (existing Git Manager gap), squash
for `merge-into`, fast-forward-only `merge-into`, single-branch refspec fetch,
fast-forwarding a local branch without checkout, a three-way merge editor, a
fallback for Git older than 2.38, a per-branch "Merge into…" row action,
running a merge inside another worktree.

## Verified facts this design rests on

- The Rust status model emits `"conflicted"` for unmerged paths
  (`apps/server/src/git/model.rs:16`, `parser.rs:24`, `parser.rs:87-88`) and
  emits each unmerged path twice (staged and unstaged). The TypeScript
  `VcsWorkingTreeFileStatus` (`packages/contracts/src/git.ts:48-55`) lacks the
  value, so a status event containing a conflict fails to decode.
- `docs/architecture/overview.md:1362-1365` forbids plumbing `update-ref` in
  Git Manager execution paths.
- Scratch repositories, Git 2.55.0 and Debian 12 Git 2.39.5:
  `git fetch . <oid>:refs/heads/<target>` publishes an unreachable commit fresh
  from `commit-tree` (also with protocol v0/v2 and
  `uploadpack.allow*SHA1InWant=false`, because local fetch transfers no objects
  it already has), writes a reflog entry using `GIT_REFLOG_ACTION`, and refuses
  with exit 128 "refusing to fetch into branch … checked out at …" when the
  target is checked out in any worktree, including from a linked-worktree cwd.
- Server capabilities are static booleans in `production/control.rs` and
  `lifecycle.rs`; Git's version is probed only for display
  (`source_control/discovery.rs:138-148`).

## Decision: how `merge-into` publishes the branch

| Option | Gains | Costs |
| --- | --- | --- |
| **`fetch . <merge>:refs/heads/<target>` (chosen)** | Git refuses a branch checked out, rebased or bisected in any worktree; fast-forward only; allowed by overview.md | No exact old-value check: an external backward reset or delete of the target in the milliseconds between re-read and write is not caught; the reflog records it |
| `update-ref <ref> <new> <old>` | Exact compare-and-swap | Banned by overview.md; silently moves a branch in use by a mid-rebase worktree, which BiBCode's snapshot reports as detached |
| `push . --force-with-lease` | Compare-and-swap and in-use refusal | Runs the client `pre-push` hook on every merge; depends on `receive.denyCurrentBranch` |

BiBCode is worktree-heavy, so Git owning the "branch in use" check outweighs an
exact compare-and-swap. overview.md gains one sentence saying `merge-into`
publishes with fast-forward-only `fetch .`, which Git refuses for any
worktree's branch.

## Design

### G1. Status conflict state (`vcs.status`)

- Contract (`packages/contracts/src/git.ts`): add `"conflicted"` to
  `VcsWorkingTreeFileStatus`. Wrap the file `status` field's literal in
  `Schema.catchDecoding(() => Effect.succeedNone)` (the pattern at
  `packages/contracts/src/vcs.ts:75-77`) so an unknown future value decodes as
  absent instead of failing the stream.
- Add `operationInProgress: Schema.optionalKey(Schema.Literals(["merge",
  "rebase", "cherry-pick", "revert", "squash"]))` to the local status shape,
  with the same `catchDecoding` treatment. Absent means none. Older clients
  ignore the key.
- Server: emit each unmerged path once, area `unstaged`, status `conflicted`.
  Fill `operationInProgress` with the authoritative detector the Git Manager
  RPC already uses, `apps/server/src/git/manager/in_progress.rs`
  `detect_in_progress_operation` (it handles both `rebase-merge` and
  `rebase-apply`; the `refs.rs` probe does not).
- Shared runtime (`packages/shared/src/git.ts`): `toLocalStatusPart`
  rebuilds the local part field by field and is used when a `remoteUpdated`
  event arrives, so it must carry `operationInProgress`; otherwise any remote
  refresh during a merge hides the conflict strip.
- The Git Manager contract keeps its own `"unmerged"` literal; the two
  surfaces are separate contracts and neither is renamed.

### G2. Merge-tree classification and Git version check

- Preview and `merge-into` classify `git merge-tree --write-tree` results as:
  exit 0 → clean; exit 1 **and** stdout starts with a tree OID → conflicted;
  exit 128 with "refusing to merge unrelated histories" → unrelated histories;
  anything else → an explicit error carrying Git's stderr. Today every
  non-0/1 exit becomes "unrelated histories" (`merge.rs:38-47`).
- Git version: the server parses `git --version` once per process (leading
  `major.minor.patch`, tolerating suffixes such as `(Apple Git-155)` and
  `.windows.N`) and caches it. Below 2.38, `previewMerge` fails with
  "Merge preview needs Git 2.38 or later on this environment (found X)." and
  `merge-into` fails with code `git-too-old` and "Merging into another branch
  needs Git 2.38 or later on this environment (found X)." In-checkout `merge`
  keeps working on old Git; the dialog shows the preview error and still
  allows Merge for the current branch.
- Each WSL/SSH/Connect environment runs its own server, so the check applies
  to that host's Git.

### G3. Remote branches as merge sources

`GitManagerMergeDialog` lists local and remote branches in groups (reusing
`branchGrouping.ts`) and sends full refs (`refs/heads/x`, `refs/remotes/o/x`),
as the New Branch dialog does. The server already accepts any revision as a
merge source. When the source is remote, the dialog applies the repository's
blocked reasons (dirty tree, operation in progress) before the click, because
per-branch guards exist only for local branches.

### Feature 2. Source Control merge into the current branch

- **Entry:** "Merge into current branch…" in the panel menu's remote group
  (`SourceControlPrimaryAction.logic.ts`), never the primary button. Disabled
  reasons, first match wins: `gitManagerStashMergeOperations` or
  `gitManagerBranchSyncOperations` not advertised; detached HEAD ("Check out a
  branch to merge into."); merge or other operation in progress ("Finish or
  abort the current merge first."); dirty working tree ("Commit your changes
  before merging.").
- **Dialog:** the panel mounts `GitManagerMergeDialog` in current-branch mode
  (Into picker hidden, merge commit only). The panel gains a `projectId` prop
  from `ChatView`'s `activeProjectRef`; `getRefs` loads only while the dialog
  is open.
- **Fetch:** a Fetch button in the dialog runs `fetch{remote}` for the
  selected remote branch's remote (longest-prefix match against
  `snapshot.remotes`, since remote names may contain `/`), or every remote in
  turn when no remote source is selected, then revalidates refs and the
  preview. Merge stays a separate click after a fresh preview.
- **Merge:** `merge{source: <full ref>}` through `gitManager.runOperation`.
- **Busy state:** while a Git Manager operation started from the panel runs,
  the panel's Commit, Stage, Pull and Push are disabled with "A merge is
  running." Cancel uses the existing operation banner.
- **Conflicts:** the dialog closes on code `conflicts`. When
  `operationInProgress === "merge"`, the panel shows a strip reusing
  `GitManagerInProgressStrip`: **Commit merge** sends `continue{merge}` and is
  disabled with "Resolve and stage every conflicted file first." while any
  file is `conflicted`; **Abort** sends `abort{merge}` with the existing
  destructive confirmation and stays enabled while conflicts remain. The
  strip's single `disabledReason` (which disables both buttons today) gains a
  separate continue-only reason; operation-wide busy or capability reasons
  still disable both. A Merge Changes section lists conflicted files
  with Ours, Theirs (`resolve-conflict`) and open-in-editor. The stacked
  Commit button is hidden during a merge, so the merge always completes
  through `continue` (the commit-by-paths path runs a bare `git reset`, which
  would drop `MERGE_HEAD`).
- Stale comments claiming fetch/rebase/stash have no backing RPC
  (`SourceControlPrimaryAction.logic.ts:23`, `:290-291`) are corrected.

### Feature 1. Merge into another branch (`merge-into`)

**Contract** (`packages/contracts/src/gitManager.ts`):

- `Schema.TaggedStruct("merge-into", { ...GitManagerOperationBase.fields,
  source, target })`. `source` is a full ref; `target` is a local branch name.
  No `noVerify`: commit and merge hooks never run on this path. A
  `reference-transaction` hook does run during the publish and can reject it.
- `GitManagerPreviewMergeInput` gains optional `target`. The preview then
  compares against the target instead of `HEAD` and returns `current = target`.
- Capability `gitManagerMergeIntoOperations`, `withDecodingDefault(false)`,
  advertised wherever `gitManagerStashMergeOperations` is advertised. The client sends
  `merge-into` and preview `target` only when it is advertised, because older
  servers fail to decode an unknown operation tag and silently ignore an
  unknown preview field.

**Server executor** (new arm in `run_branch_or_sync_operation`, inside the
existing project lock; every Git call is a `git_manager_*` method on
`GitRepository` with the default deadline and registered in the
non-interactive process test):

1. Guard on the in-lock snapshot: target must be a local branch
   (`local-branch-not-found`); target equal to `headRef` fails with
   `target-is-current`; target checked out in another worktree is blocked with
   the existing `worktree-checked-out` reason. A dirty selected worktree does
   not block. An operation in progress in the selected worktree blocks, like
   every mutation.
2. Git version ≥ 2.38, else `git-too-old`.
3. Resolve both refs once to commit OIDs
   (`rev-parse --verify --end-of-options <ref>^{commit}`), the target always
   as `refs/heads/<target>` so a tag with the same name cannot shadow it.
   Steps 4-8 use only these OIDs and the qualified target ref.
4. `merge-base --is-ancestor <source> <target>` exit 0 → finished,
   "Already up to date." No write.
5. `merge-tree --write-tree -z --name-only --no-messages <target> <source>`,
   with `git --attr-source=<target>` on Git ≥ 2.43 so merge attributes come
   from the target. Classified per G2. Conflict → `conflicts` with "N files
   would conflict. Check out <target> and merge there to resolve them." No
   write.
6. `commit-tree <tree> -p <target> -p <source> -F -` with the message on
   stdin: `Merge branch '<x>' into <target>` for local sources,
   `Merge remote-tracking branch '<r>/<x>' into <target>` for remote ones.
   Pass `-S` when `config --bool commit.gpgSign` is true (commit-tree ignores
   that setting). Signing or identity failure fails the operation with Git's
   message; nothing is written.
7. Re-read the target tip; if it moved, fail `non-fast-forward` with "<target>
   changed while merging. Review the preview and try again."
8. Publish: `git -c maintenance.auto=false -c fetch.writeCommitGraph=false
   fetch --no-tags --no-prune --no-recurse-submodules --no-write-fetch-head
   --quiet . <merge>:refs/heads/<target>` with
   `GIT_REFLOG_ACTION="merge-into <source>"`. "refusing to fetch into branch"
   → blocked `worktree-checked-out` with Git's path; "(non-fast-forward)" or
   "rejected" → `non-fast-forward` as in step 7; any other failure, including
   a `reference-transaction` hook rejection → `unknown` carrying Git's stderr.

**Admission order (shared fix).** `run_branch_or_sync_operation` builds the
snapshot and evaluates guards inside the project lock but acquires the cwd
mutation guard (`broadcaster.begin_mutation`) only afterwards
(`operations.rs:945-980`). `vcs.*` writes take that cwd guard but not the
project lock, so a `vcs.switchRef` can change HEAD between validation and
execution. The cwd mutation guard is acquired before the snapshot is built,
for every Git Manager branch/sync operation, so validation and execution see
the same HEAD.

The operation reports `changes_worktree_heads() == true` so the catalog
rescans. Guards add `merge-into` to `MUTATING_OPERATIONS` and to the
worktree-occupancy reasons keyed on the target, appended after existing
reasons, and keep it off the dirty-tree list.

**Dialog** (`GitManagerMergeDialog`): an **Into** combobox (New Branch
pattern), shown only with the capability, defaults to the checked-out branch.
Target = current branch → today's `merge`/`squash-merge` unchanged. Other
target → sends `merge-into`, hides Squash, titles "Merge into <target>", and
shows: "<target> is updated without checking it out. Your files don't change
and commit hooks don't run." The source list excludes the selected target,
not the checked-out branch (today's `.filter((branch) => !branch.current)` at
`GitManagerMergeDialog.tsx:96-99`), and recomputes when Into changes, so the
checked-out branch can be merged into another branch; a source equal to the
new target is cleared. Merge is enabled only when the preview is clean
or a fast-forward, `preview.current === target`, and the target is not
blocked; a conflicted preview disables it with "N files would conflict. Check
out <target> to merge and resolve them." Blocked targets show the server's
blocked message. The toolbar tooltip becomes "Merge one branch into another".

## Failure codes

New Rust `GitManagerFailureCode` values: `target-is-current`, `git-too-old`,
`unrelated-histories`. Reused: `conflicts`, `already-up-to-date`,
`non-fast-forward`, `operation-in-flight`, `local-branch-not-found`, blocked
`worktree-checked-out`. Every message names the next step.

## Acceptance criteria

1. A status stream event whose file has `status: "conflicted"` decodes; a
   status with an unknown future literal decodes with the field absent.
2. During a real conflicted `git merge`, `vcs.status` reports each conflicted
   path once as `conflicted` and `operationInProgress: "merge"`; after all
   conflicts are staged, `operationInProgress` is still `"merge"`.
3. From the Source Control panel: Fetch, then merge
   `refs/remotes/origin/<b>` into the current branch with a conflict; the
   strip appears; resolving and Commit merge produces a two-parent commit via
   `continue{merge}`; Abort restores the pre-merge state.
4. `merge-into` run with a linked worktree as cwd creates a commit on the
   target whose parents are `[old target, source]`, and the cwd worktree's
   HEAD, index and files are unchanged.
5. A conflicting `merge-into` fails with `conflicts`, leaves the target ref
   unchanged, and leaves no `MERGE_HEAD` in any worktree.
6. `merge-into` on a target checked out in another worktree is blocked with
   `worktree-checked-out`; on a target mid-rebase in another worktree Git's
   refusal is mapped to the same blocked reason.
7. With `commit.gpgSign=true` and a failing `gpg.program`, `merge-into` fails
   and does not move the target.
8. On Git below 2.38 (simulated version string), `merge-into` fails with
   `git-too-old` and the preview error names the required version.
9. A client without the capability never shows the Into picker; a client with
   it sends `merge-into` only for a non-current target.
10. A `localUpdated` event with `operationInProgress: "merge"` followed by a
    `remoteUpdated` event leaves `operationInProgress` set in the shared
    reduced status.
11. While conflicts remain, the strip's Commit merge is disabled with the
    continue-only reason and Abort stays enabled.
12. In the Merge dialog with a non-current target, the checked-out branch is
    offered as a source and the target is not.
13. `merge-into` with a tag named like the target branch updates the branch,
    not the tag, and does not report "Already up to date" from the tag.
14. Every Git Manager branch/sync operation holds the cwd mutation guard while
    its snapshot is built and its guards are evaluated.

## Testing

- Contracts: `git.test.ts` (conflicted literal, unknown literal, optional
  `operationInProgress`); `gitManager.test.ts` (`merge-into` and preview
  `target` decode); `environment.test.ts` (capability default).
- Shared: `packages/shared/src/git.test.ts` (criterion 10).
- Rust unit: version parser cases (`2.34.1`, `2.50.1 (Apple Git-155)`,
  `2.55.0.windows.1`); merge-tree classifier (exit 1 empty stdout, exit 128);
  guard admission for `merge-into`; argument builders.
- Rust integration (`apps/server/tests/production_git_manager_rpc.rs`,
  `production_git_vcs_rpc.rs`), real Git, linked-worktree cwd: criteria 2,
  4, 5, 6, 7, 13, already-up-to-date, dirty selected worktree not blocking,
  remote source merge after fetch, a rejecting `reference-transaction` hook
  leaving the target unchanged. Rust unit test for criterion 14.
- Web: `GitManagerMergeDialog.test.tsx` (remote group and full-ref payload,
  Into routing, conflicted preview disables Merge in Into mode, capability
  fallback, preview/target mismatch, criterion 12);
  `GitManagerInProgressStrip.test.tsx` (criterion 11);
  `SourceControlPrimaryAction.logic.test.ts` (gating order);
  `SourceControlPanel.test.tsx` (dialog opens, fetch before revalidation,
  strip and Commit merge/Abort, busy state).
- Gates: `vp check`, `vp run typecheck`, `cargo fmt --all --check`, Clippy
  with warnings denied, `apps/server` tests, `vercel-react-best-practices` and
  `UI.md` reviews of changed components.

## Documentation

- `docs/user/workspace-ui.md`: Merge section (Into, remote sources, merge-into
  behaviour, hooks and signing) and Source Control section (merge, conflicts).
- `docs/architecture/rpc-and-orchestration.md`: `merge-into` operation,
  preview `target`, status `operationInProgress`.
- `docs/architecture/overview.md`: the `fetch .` sentence beside the
  `update-ref` ban.
- `docs/integrations/source-control-providers.md` (Source Control panel
  description), `CHANGELOG.md`.
- `docs/testing/` runbooks reviewed.

## Risks

- External backward reset or delete of the target within milliseconds of the
  publish is not caught (reflog records it).
- Below Git 2.43 merge attributes come from the cwd worktree, not the target.
- `fetch .` from a linked worktree on reftable repositories, Windows and WSL
  is untested before implementation; integration tests cover linked
  worktrees on Linux.
- `vcs.*` mutations take the cwd mutation guard but not the Git Manager
  project lock; the admission-order fix closes the validation/execution gap
  for one worktree, but a `vcs.*` write in a different worktree of the same
  repository can still move a branch between preview and Merge (the in-lock
  re-read and fast-forward-only publish catch it for `merge-into`).
- A repository `reference-transaction` hook can reject the publish; the
  operation then fails with Git's message and the target is unchanged.
