import { LRUCache } from "../../../lib/lruCache";

interface CommitIdentity {
  readonly sha: string;
}

interface SpliceCommitGenerationInput<T extends CommitIdentity> {
  readonly loaded: ReadonlyArray<T>;
  readonly incoming: ReadonlyArray<T>;
  readonly pinnedTips: ReadonlyArray<string>;
}

interface SpliceCommitGenerationResult<T extends CommitIdentity> {
  readonly commits: ReadonlyArray<T>;
  readonly requiresReset: boolean;
}

export function spliceCommitGeneration<T extends CommitIdentity>({
  loaded,
  incoming,
  pinnedTips,
}: SpliceCommitGenerationInput<T>): SpliceCommitGenerationResult<T> {
  const loadedShas = new Set(loaded.map((commit) => commit.sha));
  const incomingAdditions = incoming.filter((commit) => {
    if (loadedShas.has(commit.sha)) return false;
    loadedShas.add(commit.sha);
    return true;
  });
  const incomingShas = new Set(incoming.map((commit) => commit.sha));
  return {
    commits: [...incomingAdditions, ...loaded],
    requiresReset: pinnedTips.length > 0 && !pinnedTips.some((tipSha) => incomingShas.has(tipSha)),
  };
}

interface ShouldLoadNextPageInput {
  readonly renderedIndex: number;
  readonly totalRows: number;
  readonly isLoading: boolean;
  readonly lastRequestAtMs: number;
  readonly nowMs: number;
}

export function shouldLoadNextPage({
  renderedIndex,
  totalRows,
  isLoading,
  lastRequestAtMs,
  nowMs,
}: ShouldLoadNextPageInput): boolean {
  return (
    totalRows > 0 && totalRows - renderedIndex <= 10 && !isLoading && nowMs - lastRequestAtMs >= 500
  );
}

export interface CommitLookup<T extends CommitIdentity> {
  readonly get: (sha: string) => T | null;
  readonly set: (commit: T) => void;
  readonly clear: () => void;
}

function approximateCommitSize(commit: CommitIdentity): number {
  return Math.max(1, JSON.stringify(commit).length * 2);
}

export function createCommitLookup<T extends CommitIdentity>(
  maxEntries: number,
  maxMemoryBytes: number,
): CommitLookup<T> {
  const cache = new LRUCache<T>(maxEntries, maxMemoryBytes);
  return {
    get: (sha) => cache.get(sha),
    set: (commit) => cache.set(commit.sha, commit, approximateCommitSize(commit)),
    clear: () => cache.clear(),
  };
}
