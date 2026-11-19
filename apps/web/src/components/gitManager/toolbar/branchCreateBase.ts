import type { GitManagerRefsSnapshot } from "@bibcode/contracts";

import type { GitManagerBranchDialog } from "../dialogs/GitManagerBranchDialogs";

/**
 * The "New branch" dialog every entry point opens. It starts from the checked-out
 * branch's own entry, whose name comes from its full ref, never from HEAD's short
 * name (`heads/main` when a tag `main` exists). The repository's default branch is
 * deliberately not a fallback: a user on `alpha` expects a branch forked from `alpha`.
 * A detached HEAD starts from the current commit (no start point). An unborn branch
 * has no ref yet, so it also has no start point, and Git can only create the branch
 * by switching to it.
 */
export function newBranchDialog(
  snapshot: GitManagerRefsSnapshot | null,
): Extract<GitManagerBranchDialog, { kind: "create" }> {
  const current = snapshot?.localBranches.find((branch) => branch.current) ?? null;
  return {
    kind: "create",
    baseBranch: current?.name ?? null,
    baseCommit: null,
    unborn: snapshot !== null && current === null && snapshot.detachedSha === null,
  };
}
