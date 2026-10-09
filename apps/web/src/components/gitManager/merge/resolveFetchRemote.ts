/** Remotes to fetch before merging `sourceRef`; remote names may contain `/`. */
export function resolveFetchRemote(
  sourceRef: string | null,
  remotes: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const tracking = sourceRef?.startsWith("refs/remotes/")
    ? sourceRef.slice("refs/remotes/".length)
    : null;
  if (tracking === null) return remotes;
  const owner = remotes
    .filter((remote) => tracking.startsWith(`${remote}/`))
    .toSorted((left, right) => right.length - left.length)[0];
  return owner === undefined ? remotes : [owner];
}
