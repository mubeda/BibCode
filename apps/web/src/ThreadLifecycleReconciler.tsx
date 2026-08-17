import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@bibcode/contracts";
import * as Option from "effect/Option";
import { useEffect, useMemo, useRef } from "react";

import { useCenterPanelStore } from "./centerPanelStore";
import { useComposerDraftStore } from "./composerDraftStore";
import { useArchivedThreadSnapshots } from "./lib/archivedThreadsState";
import { useRightPanelStore } from "./rightPanelStore";
import { useEnvironments } from "./state/environments";
import { environmentShell } from "./state/shell";

function collectPersistedThreadIds(environmentId: EnvironmentId): Set<ThreadId> {
  const threadIds = new Set<ThreadId>();
  for (const [threadKey, state] of Object.entries(useCenterPanelStore.getState().byThreadKey)) {
    const hostRef = parseScopedThreadKey(threadKey);
    if (!hostRef || hostRef.environmentId !== environmentId) continue;
    threadIds.add(hostRef.threadId);
    for (const surface of state.surfaces) {
      if (surface.kind === "chat") {
        threadIds.add(surface.threadId);
      }
    }
  }
  for (const threadKey of Object.keys(useRightPanelStore.getState().byThreadKey)) {
    const ref = parseScopedThreadKey(threadKey);
    if (ref?.environmentId === environmentId) {
      threadIds.add(ref.threadId);
    }
  }
  return threadIds;
}

export function reconcileThreadPanelState(
  environmentId: EnvironmentId,
  retainedThreadIds: ReadonlySet<ThreadId>,
): void {
  const centerPanelState = useCenterPanelStore.getState();
  for (const threadId of collectPersistedThreadIds(environmentId)) {
    const threadRef = scopeThreadRef(environmentId, threadId);
    if (retainedThreadIds.has(threadId)) {
      centerPanelState.releaseChatPanelReservation(threadRef);
      continue;
    }
    if (centerPanelState.pendingChatPanelThreadKeys.has(scopedThreadKey(threadRef))) {
      continue;
    }
    centerPanelState.removeThread(threadRef);
    useRightPanelStore.getState().removeThread(threadRef);
  }
}

function EnvironmentThreadLifecycleReconciler({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const archivedEnvironmentIds = useMemo(() => [environmentId], [environmentId]);
  const archivedState = useArchivedThreadSnapshots(archivedEnvironmentIds);
  const draftThreadsByThreadKey = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  const draftThreadIds = useMemo(
    () =>
      new Set<ThreadId>(
        Object.values(draftThreadsByThreadKey).flatMap((draft) =>
          draft.environmentId === environmentId ? [draft.threadId] : [],
        ),
      ),
    [draftThreadsByThreadKey, environmentId],
  );
  const lastArchivedRefreshSequenceRef = useRef<number | null>(null);

  useEffect(() => {
    if (shellState.status !== "live" || Option.isNone(shellState.snapshot)) {
      lastArchivedRefreshSequenceRef.current = null;
      return;
    }
    if (archivedState.isLoading) return;

    const liveSnapshot = shellState.snapshot.value;
    const archivedSnapshot = archivedState.snapshots[0]?.snapshot;
    const snapshotsAreAuthoritative =
      archivedState.error === null &&
      archivedSnapshot !== undefined &&
      archivedSnapshot.snapshotSequence === liveSnapshot.snapshotSequence;
    if (snapshotsAreAuthoritative) {
      lastArchivedRefreshSequenceRef.current = null;
      const retainedThreadIds = new Set<ThreadId>([
        ...liveSnapshot.threads.map((thread) => thread.id),
        ...archivedSnapshot.threads.map((thread) => thread.id),
        ...draftThreadIds,
      ]);
      reconcileThreadPanelState(environmentId, retainedThreadIds);
      return;
    }

    if (
      archivedSnapshot !== undefined &&
      archivedSnapshot.snapshotSequence > liveSnapshot.snapshotSequence
    ) {
      return;
    }
    if (lastArchivedRefreshSequenceRef.current === liveSnapshot.snapshotSequence) {
      return;
    }
    lastArchivedRefreshSequenceRef.current = liveSnapshot.snapshotSequence;
    archivedState.refresh();
  }, [
    archivedState.error,
    archivedState.isLoading,
    archivedState.refresh,
    archivedState.snapshots,
    draftThreadIds,
    environmentId,
    shellState,
  ]);

  return null;
}

/** Reconciles renderer-persisted thread UI state from authoritative server lifecycle knowledge. */
export function ThreadLifecycleReconciler() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <EnvironmentThreadLifecycleReconciler
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}
