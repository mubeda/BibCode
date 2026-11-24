import type { GitManagerRefEntry } from "@bibcode/contracts";

export type RemoteBranchSplit =
  | { readonly remote: string; readonly branch: string }
  | "ambiguous"
  | null;

/**
 * Splits a remote-tracking row name (`<remote>/<branch>`) on the configured remote that prefixes
 * it. Two prefixing remotes (`team` and `team/fork`) make it ambiguous; none makes it unknown.
 * The server drops symbolic `<remote>/HEAD` rows, so no such name reaches here.
 */
export function splitRemoteBranchRef(
  name: string,
  remotes: ReadonlyArray<string>,
): RemoteBranchSplit {
  const matches = remotes.filter(
    (remote) => name.startsWith(`${remote}/`) && name.length > remote.length + 1,
  );
  if (matches.length > 1) return "ambiguous";
  const remote = matches[0];
  return remote === undefined ? null : { remote, branch: name.slice(remote.length + 1) };
}

/**
 * An early, visible reason to keep Delete off a remote row. The server decides: it checks the
 * remote's default branch again before it deletes anything, including when it is unknown here.
 */
export function remoteDeleteBlockedReason(
  ref: GitManagerRefEntry,
  split: RemoteBranchSplit,
): string | null {
  if (split === "ambiguous") {
    return "Delete is blocked: two remotes match this name. Delete it from a terminal.";
  }
  if (split === null) return "Delete is blocked: the remote of this branch is unknown.";
  return ref.isDefault ? "Delete is blocked: this is the remote's default branch." : null;
}
