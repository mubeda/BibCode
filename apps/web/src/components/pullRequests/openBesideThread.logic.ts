import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import type { ScopedThreadRef } from "@bibcode/contracts";

export interface BesideThreadCandidate {
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly onBranch: boolean;
}

/** Threads to open a request beside: on its branch first, then the most recently active. */
export function rankBesideThreadCandidates(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  headBranch: string | null,
): BesideThreadCandidate[] {
  const targetBranch = headBranch !== null && headBranch.length > 0 ? headBranch : null;
  return threads
    .filter((thread) => thread.archivedAt === null && thread.kind !== "panel")
    .map((thread) => ({
      thread,
      onBranch: targetBranch !== null && thread.branch === targetBranch,
    }))
    .toSorted(
      (left, right) =>
        Number(right.onBranch) - Number(left.onBranch) ||
        right.thread.updatedAt.localeCompare(left.thread.updatedAt),
    )
    .map(({ thread, onBranch }) => ({
      ref: scopeThreadRef(thread.environmentId, thread.id),
      title: thread.title,
      onBranch,
    }));
}

/**
 * Picks the host chat thread for opening a project surface (Git Manager, Pipelines,
 * Pull Requests) in the right panel:
 * 1. If the user is already on an eligible (non-archived, non-panel) thread in the target
 *    project, stay on it even if another thread is newer.
 * 2. Otherwise rank eligible threads with `rankBesideThreadCandidates` (branch match when
 *    provided, then most recently updated).
 * 3. Returns `null` when the project has no eligible host threads (caller falls back to
 *    the standalone project route).
 */
export function selectHostThreadForProjectSurface(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly currentThreadRef?: ScopedThreadRef | null | undefined;
  readonly preferredBranch?: string | null | undefined;
}): ScopedThreadRef | null {
  const { threads, currentThreadRef = null, preferredBranch = null } = input;
  if (currentThreadRef !== null) {
    const current = threads.find(
      (thread) =>
        thread.archivedAt === null &&
        thread.kind !== "panel" &&
        thread.environmentId === currentThreadRef.environmentId &&
        thread.id === currentThreadRef.threadId,
    );
    if (current) {
      return scopeThreadRef(current.environmentId, current.id);
    }
  }
  return rankBesideThreadCandidates(threads, preferredBranch)[0]?.ref ?? null;
}
