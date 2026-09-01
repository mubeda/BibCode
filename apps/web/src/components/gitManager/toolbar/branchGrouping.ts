import type { GitManagerRefEntry } from "@bibcode/contracts";

const RECENT_BRANCH_LIMIT = 5;

export interface BranchGroups {
  readonly default: ReadonlyArray<GitManagerRefEntry>;
  readonly recent: ReadonlyArray<GitManagerRefEntry>;
  readonly other: ReadonlyArray<GitManagerRefEntry>;
}

export function groupBranches(input: {
  readonly refs: ReadonlyArray<GitManagerRefEntry>;
  readonly recentNames: ReadonlyArray<string>;
  readonly filter: string;
}): BranchGroups {
  const query = input.filter.trim().toLocaleLowerCase();
  const visible =
    query.length === 0
      ? input.refs
      : input.refs.filter((ref) => ref.name.toLocaleLowerCase().includes(query));
  const byName = new Map(visible.map((ref) => [ref.name, ref]));
  const defaultBranches = visible.filter((ref) => ref.isDefault);
  const assigned = new Set(defaultBranches.map((ref) => ref.name));
  const recentBranches: GitManagerRefEntry[] = [];

  for (const name of input.recentNames) {
    if (recentBranches.length >= RECENT_BRANCH_LIMIT) break;
    if (assigned.has(name)) continue;
    const ref = byName.get(name);
    if (ref === undefined) continue;
    assigned.add(name);
    recentBranches.push(ref);
  }

  return {
    default: defaultBranches,
    recent: recentBranches,
    other: visible.filter((ref) => !assigned.has(ref.name)),
  };
}
