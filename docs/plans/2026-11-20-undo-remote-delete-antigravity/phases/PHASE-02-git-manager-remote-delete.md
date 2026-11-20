# Phase 2: Git Manager remote branch delete

- Goal: A remote branch row can be deleted after a confirmation, each remote's default branch is blocked with a reason, sign-in and refusals are visible, and the branch dialogs show the server's block reasons, with tests.
- Round: 1
- Depends on: none
- Owns: `apps/web/src/components/gitManager/**`, `apps/web/src/components/gitSignIn/**`, `apps/server/src/git/manager/refs.rs`, `apps/server/src/git/manager/operations.rs`, `apps/server/src/git/repository.rs`, `docs/reference/mcp.md`
- Must not touch: `apps/web/src/components/files/**`, `apps/web/src/components/chat/**`, `packages/contracts/**`, `apps/server/src/production/**`, `apps/server/src/provider/**`, `apps/desktop/**`, `docs/user/workspace-ui.md` (phase 4 updates it)
- Skills: tdd (failing test first on both sides)
- Read first: issue #397 (the request and its code references); `reviews/plan-review-1.md` findings 1, 2 and 7; `packages/contracts/src/gitManager.ts:40-75,205-214,251-259` (ref entry, snapshot, the `remote-branch-delete` request with its exact fields); `UI.md` (destructive confirmation and disabled reasons)
- Checkpoint: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager src/components/gitSignIn` exits 0 and `cargo test -p bibcode-server refs` exits 0; in the app, a remote row shows Delete and each remote's default branch shows it disabled with a visible reason.

Facts this phase starts from, checked on 2026-11-20:

- The server emits the guard operations `checkout`, `delete-branch` and `rename-branch` (`guards.rs:173-198`), while the dialogs look up `branch-delete` and `branch-rename` (`GitManagerBranchDialogs.tsx:316,399`) and the dropdown `branch-checkout` (`GitManagerBranchDropdown.tsx:149`). The request tags (`branch-delete`, `branch-checkout`) are a different thing and stay as they are.
- Remote entries are named `<remote>/<branch>` (`refs.rs:411`), `is_default` is set for local entries only, and `<remote>/HEAD` rows are dropped (`refs.rs:315-346`).
- The sign-in offer of a failed network operation is handled only in `GitManagerPanel.tsx:498-523`; the toolbar's runner (`GitManagerToolbar.tsx:338-371`) records a failure message and revalidates refs.
- The server already has a test that deleting a remote branch leaves its local namesake (`operations.rs:6085-6148`).

## Tasks

### Task 2.1: Make the dialogs and the dropdown read the server's guard names

- Satisfies: R9, R15
- Depends on: none
- Files: modify `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.tsx`; test `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.test.tsx`; modify `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx`; test `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.test.tsx`
- Interfaces: consumes `GitManagerBlockedReason.operation` values `checkout`, `delete-branch`, `rename-branch`; produces the exported constants `GUARD_DELETE_BRANCH = "delete-branch"`, `GUARD_RENAME_BRANCH = "rename-branch"` and `GUARD_CHECKOUT = "checkout"` in a new `apps/web/src/components/gitManager/gitManagerGuardOperations.ts`, which Task 2.3 imports
- Skills: vercel-react-best-practices (required review for the changed dialogs)
- Read first: `apps/server/src/git/manager/guards.rs:152-257,305-320` (every emitted name); `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.tsx:310-330,397-404`; `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx:140-176`; `apps/web/src/components/gitManager/GitManagerToolbar.tsx:444-453` (the dirty checkout dialog)
- Tier: standard
- TDD: red-green
- Done when: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager/dialogs src/components/gitManager/toolbar` exits 0

Steps

1. [ ] File the follow-up issue with `gh issue create --repo mubeda/BibCode`, titled "Git Manager: branch dialogs do not read the server's block reasons", stating the names on each side with file lines and placeholders only. Record its number in the task report; the pull request closes it.
2. [ ] Write failing tests with mixed guard arrays, so a test cannot pass on `blocked[0]`: the Delete dialog for a branch blocked with `[{ operation: "merge", ... }, { operation: "delete-branch", code: "default-branch", message: "Delete is blocked: this is the default branch." }]` shows the delete message and disables Delete; a branch blocked only for `merge` can still be deleted and renamed; the Rename dialog shows the `rename-branch` reason and not an unrelated one; in the dropdown, a branch blocked for `checkout` with code `dirty-working-tree` still opens the Stash or Bring dialog, a `merge` or `rebase` dirty reason does not stop checkout, a worktree-held branch still redirects, and a real checkout block shows its reason.
3. [ ] Run the Done when command. Expected: FAIL, on the missing delete message and on the checkout cases that pick an unrelated reason.
4. [ ] Create `gitManagerGuardOperations.ts` with the three constants and use them in the dialog lookups and the dropdown predicate, selecting each action's own reason. The server and the request tags are not changed (plan decision P2).
5. [ ] Run the Done when command. Expected: PASS.
6. [ ] Prove the tests can fail: set `GUARD_DELETE_BRANCH` to `"branch-delete"`, run the Done when command. Expected: FAIL. Restore and run again. Expected: PASS.

### Task 2.2: Make the server the authority for a remote branch delete

- Satisfies: R7
- Depends on: none
- Files: modify `apps/server/src/git/manager/refs.rs`; modify `apps/server/src/git/manager/operations.rs`; modify `apps/server/src/git/repository.rs`; modify `docs/reference/mcp.md`
- Interfaces: consumes the existing ref listing and `git symbolic-ref refs/remotes/<remote>/HEAD`; produces `GitManagerRefEntry.isDefault === true` on the remote entry that its remote's `HEAD` points to, with no contract change, which Task 2.3 reads
- Skills: rust-best-practices (ref reader change stays idiomatic and Clippy clean)
- Read first: `apps/server/src/git/manager/refs.rs:270-370,405-425,720-790` (the reader, the name parsing, and the existing symbolic-HEAD test); `apps/server/src/git/repository.rs:6229-6267` (how the one local default is derived)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server refs`, `cargo test -p bibcode-server operations` and `cargo test -p bibcode-server repository`, each run on its own, exit 0 with the new tests

Rules for this task

The remote delete push has three callers: the `remote-branch-delete` operation (the new UI and the MCP tool `git_delete_remote_branch`), and local `branch-delete` with `deleteRemote` (`operations.rs:1565-1621`). The rules below apply to all three, through one shared helper, each with a failing test first in a temporary repository with a bare remote:

- The push names the destination explicitly, `:refs/heads/<branch>`, in `git_manager_delete_remote_branch` (`repository.rs:4560-4575`). Test: the branch is already gone and a same-named tag exists; the tag survives and the operation fails with the Git error.
- Before the push, one `git ls-remote --symref <remote> HEAD refs/heads/<branch>` through the same network runner and sign-in path gives the remote's default branch and the branch's current commit. Refuse, deleting nothing, when: the branch is the remote's default ("Delete is blocked: this is the remote's default branch."); the default cannot be read ("The remote's default branch could not be checked."); or a local tracking ref `refs/remotes/<remote>/<branch>` exists and points to a different commit than the remote branch ("This branch changed on the remote since the last fetch. Fetch, then delete it."). The last rule also covers a remote whose fetch mapping makes the tracking name point at another branch. A branch with no local tracking ref (an MCP caller naming a branch never fetched) is not compared.
- The check runs again when a request is resumed after sign-in.
- `remote-branch-delete` stays allowed during an in-progress merge, rebase, cherry-pick, revert and squash: one test over the five states (spec D5).
- Local `branch-delete` with `deleteRemote` whose upstream is the remote's default is refused before the local branch is deleted. Test it.
- Add the new refusals to the `git_delete_remote_branch` entry of `docs/reference/mcp.md`.
- File two follow-up issues with `gh issue create` (placeholders only) for the defects this task fixes that were there before: the unqualified push destination can delete a tag, and a local delete can remove a remote's default branch. Record the numbers in the task report.

Steps

1. [ ] Write the failing tests the Rules above list, and failing tests in `refs.rs`, in temporary repositories built the way the existing test at `:723` builds one: with remotes `origin` (HEAD to `origin/main`) and `upstream` (HEAD to `upstream/trunk`), `origin/main` and `upstream/trunk` have `is_default` true and `upstream/main`, `origin/feature` false; a remote with no `HEAD` ref marks none of its branches; the `<remote>/HEAD` rows stay excluded; the local `is_default` is unchanged.
2. [ ] Run `cargo test -p bibcode-server refs`, then `cargo test -p bibcode-server operations`, then `cargo test -p bibcode-server repository`. Expected: FAIL, on the two remote defaults and on each new refusal.
3. [ ] Implement the shared helper and the explicit destination of the Rules above. Then, while reading refs, keep each `refs/remotes/<remote>/HEAD` symbolic target and set `is_default` on the remote entry whose full ref equals it. Use the data the ref listing already returns when it carries the symbolic target; add at most one extra Git call per snapshot otherwise, through the same cancellable repository runner. Log a failure to read a symbolic target with `tracing::warn!` and treat that remote's default as unknown.
4. [ ] Run the three `cargo test` commands of step 2, one at a time. Expected: PASS.
5. [ ] Prove the tests can fail: skip the assignment for remote entries, run the command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors. If the snapshot's wire shape changed in any way, run `vp run check:contracts` and report it to the executor, since phase 3 owns the fixtures.

### Task 2.3: Delete a remote branch from the branch list

- Satisfies: R6, R7, R8
- Depends on: 2.1, 2.2
- Files: create `apps/web/src/components/gitManager/toolbar/remoteBranchRef.ts`; create `apps/web/src/components/gitManager/toolbar/remoteBranchRef.test.ts`; modify `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx`; test `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.test.tsx`; modify `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.tsx`; test `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.test.tsx`; modify `apps/web/src/components/gitManager/GitManagerToolbar.tsx`; test `apps/web/src/components/gitManager/GitManagerToolbar.test.tsx`; modify `apps/web/src/components/gitManager/GitManagerPanel.tsx`
- Interfaces: consumes the `remote-branch-delete` request (`_tag`, `cwd`, `projectId`, `remote`, `branch`, optional `expectedDestination`; read the exact shape at `packages/contracts/src/gitManager.ts:251-259`), `GitManagerRefsSnapshot.remotes` and `.defaultBranch`, `GitManagerRefEntry.isDefault` from Task 2.2, the guard constants from Task 2.1, and `useGitSignInFlow` (`apps/web/src/components/gitSignIn/useGitSignInFlow.ts`). Produces `splitRemoteBranchRef(name: string, remotes: ReadonlyArray<string>): { remote: string; branch: string } | "ambiguous" | null` and `remoteDeleteBlockedReason(ref: GitManagerRefEntry, split: ReturnType<typeof splitRemoteBranchRef>, snapshot: Pick<GitManagerRefsSnapshot, "defaultBranch">): string | null`
- Skills: vercel-react-best-practices (required review for the changed components); better-ui (destructive confirm copy and disabled-state reasons)
- Read first: `apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.tsx:228-253`; `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.tsx:385-458`; `apps/web/src/components/gitManager/GitManagerToolbar.tsx:338-371,461-465,512-520`; `apps/web/src/components/gitManager/GitManagerPanel.tsx:498-523,1048-1054` (the sign-in offer and its resume); `apps/web/src/state/gitManager.ts:35-52`
- Tier: most capable
- TDD: red-green
- Done when: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager src/components/gitSignIn` exits 0

Rules for this task

- The client's checks give an early, visible reason; the server of Task 2.2 decides. A server refusal is shown in the dialog like any Git error.
- Use the real event shape in tests: a rejection arrives as `output` events on stderr followed by a `failed` summary, and the dialog shows the stderr text. After an accepted sign-in, the resumed request's success must reach the dialog that owns the request, which then closes and refreshes; `GitManagerPanel.tsx:505-523` discards that result today, so the shared hook returns it. A declined sign-in leaves the dialog open.
- A symbolic `HEAD` row never reaches the client (`refs.rs` drops it): assert that in a test and give the helper no `HEAD` case.
- File a follow-up issue for the defect this task fixes that was there before: the toolbar's branch delete never offers sign-in. Record its number in the task report.

Steps

1. [ ] Write failing tests in `remoteBranchRef.test.ts`. `splitRemoteBranchRef("origin/feature/a", ["origin"])` gives `{ remote: "origin", branch: "feature/a" }`; a name no remote prefixes gives `null`; with remotes `["team", "team/fork"]`, `"team/fork/x"` gives `"ambiguous"`, because two remotes prefix it; with `["origin", "origin-fork"]`, `"origin-fork/x"` gives remote `origin-fork`, because `origin/` does not prefix it. `remoteDeleteBlockedReason` returns "Delete is blocked: this is the remote's default branch." when `ref.isDefault` is true; "Delete is blocked: two remotes match this name. Delete it from a terminal." for `"ambiguous"`; "Delete is blocked: the remote of this branch is unknown." for `null`; and `null` otherwise, including when the remote's default is unknown: the server checks it before deleting (Task 2.2), and the dialog says so.
2. [ ] Write failing component tests. A remote row renders Delete and no Rename; a blocked row's button is disabled, its reason is visible in the row's description and exposed as the accessible description, and activating it sends nothing. Choosing Delete opens a dialog titled "Delete Remote Branch?" that names the remote and the branch, says the local branch is kept and that the remote may refuse a protected branch, and requires the confirmation checkbox. Confirming sends exactly one request with `_tag: "remote-branch-delete"`, the snapshot's `cwd` and `projectId`, and that `remote` and `branch`; if the row is gone from a newer snapshot when Confirm is pressed, nothing is sent and the dialog says the branch no longer exists. A failed event that carries a sign-in offer shows the existing sign-in prompt, and accepting it sends the offer's `resume` request unchanged, `expectedDestination` included; declining leaves the dialog open with the failure. A protected-branch rejection shows the Git error text in the dialog, which stays open. After success the dialog closes and, with a refreshed snapshot that lacks the row, the row is gone, both when a local branch of the same name exists (still listed) and for a remote-only branch. The existing local delete with "Also delete the branch from its remote" still sends `branch-delete` with `deleteRemote`, and now also reaches the sign-in prompt.
3. [ ] Run the Done when command. Expected: FAIL, on the missing module, the missing Delete button and the missing sign-in handling.
4. [ ] Implement `remoteBranchRef.ts`; the remote row's Delete button; a `delete-remote` dialog kind that reuses the local dialog's layout and `GitManagerDisabledReasonButton`; and the toolbar submission. Move the panel's sign-in wrapper (`GitManagerPanel.tsx:498-523`) into a hook in `apps/web/src/components/gitManager/` that both the panel and the toolbar's runner use, so there is one implementation of offer and resume; do not copy it.
5. [ ] Run the Done when command. Expected: PASS.
6. [ ] Prove the tests can fail: make `remoteDeleteBlockedReason` return `null` always, run the Done when command. Expected: FAIL in the default-branch and ambiguity tests. Restore and run again. Expected: PASS.
7. [ ] Review the changed components against `vercel-react-best-practices` and the dialog and disabled states against `UI.md`; record both in the task report, with the user-visible text for the phase 4 update of `docs/user/workspace-ui.md`.
8. [ ] Run `vp check`. Expected: no errors in the files this phase owns.
