/**
 * The start point for "New Branch": always the branch the user has checked
 * out, or the current HEAD commit (no explicit start point) when HEAD is
 * detached. The repository's default branch is deliberately not a fallback:
 * a user working on `alpha` expects a new branch to fork from `alpha`, and
 * the dialog names the base so the choice is visible before confirming.
 */
export function resolveBranchCreateBase(input: {
  readonly currentBranchName: string | null;
  readonly defaultBranch: string | null;
}): string | null {
  return input.currentBranchName;
}
