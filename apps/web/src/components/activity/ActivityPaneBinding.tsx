import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  EMPTY_ENVIRONMENT_ACTIVITY_STATE,
  type EnvironmentActivityState,
} from "@bibcode/client-runtime/state/activity";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import {
  ActivityError,
  type ActivityRecordId,
  type ActivityRecordKind,
  type ActivityScopeRef,
  type EnvironmentId,
} from "@bibcode/contracts";
import type { TimestampFormat } from "@bibcode/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, type Atom } from "effect/reactivity";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  type KeyedActivityPage,
  reconcileBoundedActivityPages,
  resolveActivityPageLoadAction,
} from "~/components/ChatView.logic";
import { environmentActivity } from "~/state/activity";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  ActivityPanel,
  type ActivityDetailPageData,
  type ActivityDetailQueryResult,
  type ActivityQueryResult,
  type ActivityRosterPageData,
} from "./ActivityPanel";
import type { ActivityPaneRoute } from "./activityPaneState";
import { activitySnapshotForState } from "./activityPresentation";

type ActivityPageData = ActivityRosterPageData | ActivityDetailPageData;

interface BoundedActivityQuery<Page extends ActivityPageData> extends ActivityQueryResult<Page> {
  readonly failure: unknown | null;
  readonly loadMore: () => void;
  /** Explicit user Retry from the newest page. */
  readonly refresh: () => void;
  /** Automatic re-read from the newest page; keeps an exhausted cut-off latched. */
  readonly revalidate: () => void;
}

function useBoundedActivityQuery<Page extends ActivityPageData>(
  queryKey: string | null,
  atomForCursor: (
    cursor: string | null,
  ) => Atom.Atom<AsyncResult.AsyncResult<Page, unknown>> | null,
): BoundedActivityQuery<Page> {
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly cursor: string | null;
    readonly pages: ReadonlyArray<KeyedActivityPage<Page>>;
    /** The query page last folded into `pages` for this key and cursor. */
    readonly reconciled: Page | null;
  }>({ key: queryKey, cursor: null, pages: [], reconciled: null });
  const current =
    state.key === queryKey ? state : { key: queryKey, cursor: null, pages: [], reconciled: null };
  const queryAtom = useMemo(
    () => (queryKey === null ? null : atomForCursor(current.cursor)),
    [atomForCursor, current.cursor, queryKey],
  );
  const query = useEnvironmentQuery<Page, unknown>(queryAtom);
  const { refresh: refreshQuery, revalidate: revalidateQuery } = query;
  const newestRefreshKeyRef = useRef<{ key: string; retry: boolean } | null>(null);

  const data = query.data;
  if (queryKey !== null && data !== null && current.reconciled !== data) {
    setState((previous) => {
      const pages = previous.key === queryKey ? previous.pages : [];
      return {
        key: queryKey,
        cursor: current.cursor,
        pages: reconcileBoundedActivityPages<Page>(pages, current.cursor, data),
        reconciled: data,
      };
    });
  }

  useEffect(() => {
    const pending = newestRefreshKeyRef.current;
    if (queryKey === null || current.cursor !== null || pending?.key !== queryKey) return;
    newestRefreshKeyRef.current = null;
    if (pending.retry) refreshQuery();
    else revalidateQuery();
  }, [current.cursor, queryKey, refreshQuery, revalidateQuery]);

  const pages = useMemo(() => current.pages.map((entry) => entry.page), [current.pages]);
  const failure = Option.getOrNull(AsyncResult.error(query.emission));
  const loadMore = useCallback(() => {
    const nextCursor = pages.at(-1)?.nextCursor ?? null;
    if (
      resolveActivityPageLoadAction({
        currentCursor: current.cursor,
        nextCursor,
        failed: failure !== null,
      }) === "refresh"
    ) {
      refreshQuery();
      return;
    }
    setState((previous) => ({
      key: queryKey,
      cursor: nextCursor,
      pages: previous.key === queryKey ? previous.pages : [],
      reconciled: null,
    }));
  }, [current.cursor, failure, pages, queryKey, refreshQuery]);
  // Returning to the newest page keeps whether the initiating action was an
  // explicit Retry or an automatic re-read.
  const refreshNewest = useCallback(
    (retry: boolean) => {
      if (queryKey === null) return;
      if (current.cursor === null) {
        if (retry) refreshQuery();
        else revalidateQuery();
        return;
      }
      newestRefreshKeyRef.current = { key: queryKey, retry };
      setState((previous) => ({
        key: queryKey,
        cursor: null,
        pages: previous.key === queryKey ? previous.pages : [],
        reconciled: null,
      }));
    },
    [current.cursor, queryKey, refreshQuery, revalidateQuery],
  );
  const refresh = useCallback(() => refreshNewest(true), [refreshNewest]);
  const revalidate = useCallback(() => refreshNewest(false), [refreshNewest]);

  return useMemo(
    () => ({
      pages,
      loading: query.isPending,
      error: query.error,
      failure,
      loadMore,
      refresh,
      revalidate,
    }),
    [failure, loadMore, pages, query.error, query.isPending, refresh, revalidate],
  );
}

export interface ActivityStateTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ActivityScopeRef;
}

const isActivityError = Schema.is(ActivityError);

function isRemovedActivityFailure(failure: unknown): failure is ActivityError {
  return isActivityError(failure) && failure.reason === "notFound";
}

function activityCancellationFailureMessage(failure: unknown): string {
  if (!isActivityError(failure)) {
    return "Unable to stop agents. Try again.";
  }
  switch (failure.reason) {
    case "cancellationUnsupported":
      return "Stopping this agent is not supported.";
    case "staleScope":
    case "staleActor":
    case "staleOperation":
      return "Activity changed before the request could be applied. Refresh and try again.";
    case "providerUnavailable":
      return "The provider is unavailable. Try again when it reconnects.";
    case "targetUnavailable":
      return "This agent can no longer be stopped.";
    case "partialCancellation":
      return "Some agents are still running.";
    case "dispatchTimeout":
      return "Stopping agents timed out. Some agents may still be running.";
    default:
      return "Unable to stop agents. Try again.";
  }
}

/**
 * Reads one Activity scope's roster, detail, and cancellation state and renders
 * the panel for a route. It mounts only while its pane's panel is expanded, so
 * a collapsed pane keeps no roster or detail query alive.
 */
export const ActivityPanelBinding = memo(function ActivityPanelBinding({
  target,
  route,
  timestampFormat,
  onNavigate,
  focusRequested,
  onFocusRequestHandled,
}: {
  readonly target: ActivityStateTarget;
  readonly route: ActivityPaneRoute;
  readonly timestampFormat: TimestampFormat;
  readonly onNavigate: (route: ActivityPaneRoute) => void;
  readonly focusRequested: boolean;
  readonly onFocusRequestHandled: () => void;
}) {
  const stateValueAtom = useMemo(() => environmentActivity.stateValueAtom(target), [target]);
  const stateSourceAtom = useMemo(() => environmentActivity.stateAtom(target), [target]);
  const activityState =
    useAtomValue(stateValueAtom) ?? (EMPTY_ENVIRONMENT_ACTIVITY_STATE as EnvironmentActivityState);
  const refreshSnapshot = useAtomRefresh(stateSourceAtom);
  const cancelSubtree = useAtomCommand(environmentActivity.cancelSubtree, {
    reportFailure: false,
  });
  const retrySubtreeCancellation = useAtomCommand(environmentActivity.retrySubtreeCancellation, {
    reportFailure: false,
  });
  const [cancellationFailure, setCancellationFailure] = useState<{
    readonly message: string;
    readonly targetKey: string;
    readonly controlRevision: number;
  } | null>(null);
  const snapshot = useMemo(() => activitySnapshotForState(activityState), [activityState]);
  const section = route.section;
  const queryBaseKey =
    snapshot === null ? null : `${target.environmentId}:${snapshot.scopeId}:${section}`;
  const activeRosterAtomForCursor = useCallback(
    (cursor: string | null) =>
      snapshot === null
        ? null
        : (environmentActivity.roster({
            environmentId: target.environmentId,
            input: {
              scope: snapshot.scope,
              scopeId: snapshot.scopeId,
              section,
              bucket: "active",
              ...(cursor === null ? {} : { cursor }),
              limit: 200,
            },
          }) as Atom.Atom<AsyncResult.AsyncResult<ActivityRosterPageData, unknown>>),
    [section, snapshot, target.environmentId],
  );
  const doneRosterAtomForCursor = useCallback(
    (cursor: string | null) =>
      snapshot === null
        ? null
        : (environmentActivity.roster({
            environmentId: target.environmentId,
            input: {
              scope: snapshot.scope,
              scopeId: snapshot.scopeId,
              section,
              bucket: "done",
              ...(cursor === null ? {} : { cursor }),
              limit: 200,
            },
          }) as Atom.Atom<AsyncResult.AsyncResult<ActivityRosterPageData, unknown>>),
    [section, snapshot, target.environmentId],
  );
  const activeRoster = useBoundedActivityQuery(
    queryBaseKey === null ? null : `${queryBaseKey}:active`,
    activeRosterAtomForCursor,
  );
  const doneRoster = useBoundedActivityQuery(
    queryBaseKey === null ? null : `${queryBaseKey}:done`,
    doneRosterAtomForCursor,
  );
  const selectedRecordKind = route.selectedRecordKind;
  const selectedRecordId = route.selectedRecordId;
  const detailQueryKey =
    queryBaseKey !== null && selectedRecordKind !== null && selectedRecordId !== null
      ? `${queryBaseKey}:${selectedRecordKind}:${selectedRecordId}`
      : null;
  const detailAtomForCursor = useCallback(
    (cursor: string | null) =>
      snapshot === null || selectedRecordKind === null || selectedRecordId === null
        ? null
        : (environmentActivity.detail({
            environmentId: target.environmentId,
            input: {
              scope: snapshot.scope,
              scopeId: snapshot.scopeId,
              recordKind: selectedRecordKind,
              recordId: selectedRecordId as ActivityRecordId,
              ...(cursor === null ? {} : { cursor }),
              limit: 200,
            },
          }) as Atom.Atom<AsyncResult.AsyncResult<ActivityDetailPageData, unknown>>),
    [selectedRecordId, selectedRecordKind, snapshot, target.environmentId],
  );
  const detailQuery = useBoundedActivityQuery(detailQueryKey, detailAtomForCursor);
  const revalidateActiveRoster = activeRoster.revalidate;
  const revalidateDoneRoster = doneRoster.revalidate;
  const revalidateDetail = detailQuery.revalidate;
  const refreshQueriesRef = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    refreshQueriesRef.current = () => {
      revalidateActiveRoster();
      revalidateDoneRoster();
      revalidateDetail();
    };
  }, [revalidateActiveRoster, revalidateDetail, revalidateDoneRoster]);
  // Every change to the queried scope, record, or snapshot revision schedules
  // one coalesced revalidation.
  const queryRevalidationKey =
    snapshot === null
      ? null
      : JSON.stringify([queryBaseKey, detailQueryKey, snapshot.revision, snapshot.scopeId]);
  const refreshTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  useEffect(() => {
    if (queryRevalidationKey === null) {
      return;
    }
    if (refreshTimerRef.current !== null) {
      return;
    }
    refreshTimerRef.current = globalThis.setTimeout(() => {
      refreshTimerRef.current = null;
      refreshQueriesRef.current();
    }, 100);
  }, [queryRevalidationKey]);
  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        globalThis.clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );
  const detail = useMemo<ActivityDetailQueryResult | null>(
    () =>
      selectedRecordKind !== null && selectedRecordId !== null
        ? {
            recordKind: selectedRecordKind as ActivityRecordKind,
            recordId: selectedRecordId as ActivityRecordId,
            pages: detailQuery.pages,
            loading: detailQuery.loading,
            error: detailQuery.error,
            ...(isRemovedActivityFailure(detailQuery.failure) ? { removed: true } : {}),
          }
        : null,
    [
      detailQuery.error,
      detailQuery.failure,
      detailQuery.loading,
      detailQuery.pages,
      selectedRecordId,
      selectedRecordKind,
    ],
  );
  const roster = useMemo(
    () => ({ active: activeRoster, done: doneRoster }),
    [activeRoster, doneRoster],
  );
  const loadMoreActiveRoster = activeRoster.loadMore;
  const loadMoreDoneRoster = doneRoster.loadMore;
  const onLoadMoreRoster = useCallback(
    (bucket: "active" | "done") =>
      bucket === "active" ? loadMoreActiveRoster() : loadMoreDoneRoster(),
    [loadMoreActiveRoster, loadMoreDoneRoster],
  );
  const cancellationTarget = useMemo(
    () =>
      snapshot !== null &&
      snapshot.scope._tag === "thread" &&
      snapshot.capabilities.targetedActorCancellation
        ? {
            environmentId: target.environmentId,
            scope: snapshot.scope,
            scopeId: snapshot.scopeId,
            controlRevision: snapshot.control.revision,
            key: JSON.stringify([
              target.environmentId,
              snapshot.scope._tag,
              snapshot.scope.threadId,
              snapshot.scopeId,
            ]),
          }
        : null,
    [snapshot, target.environmentId],
  );
  // The panel has one scoped mutation banner, so the newest cancel or retry invocation owns it.
  const cancellationOwnershipRef = useRef<{
    targetKey: string | null;
    controlRevision: number;
    invocation: number;
  }>({ targetKey: null, controlRevision: -1, invocation: 0 });
  const currentCancellationTargetKey = cancellationTarget?.key ?? null;
  const currentCancellationControlRevision = snapshot?.control.revision ?? -1;
  useLayoutEffect(() => {
    const ownership = cancellationOwnershipRef.current;
    ownership.targetKey = currentCancellationTargetKey;
    ownership.controlRevision = currentCancellationControlRevision;
    ownership.invocation += 1;
    return () => {
      if (
        ownership.targetKey === currentCancellationTargetKey &&
        ownership.controlRevision === currentCancellationControlRevision
      ) {
        ownership.targetKey = null;
        ownership.invocation += 1;
      }
    };
  }, [currentCancellationControlRevision, currentCancellationTargetKey]);
  const cancellationFailureIsCurrent =
    cancellationFailure !== null &&
    cancellationFailure.targetKey === currentCancellationTargetKey &&
    cancellationFailure.controlRevision === currentCancellationControlRevision;
  // A failure belongs to the target and revision it was raised for; drop it as
  // soon as either changes so returning to that target cannot resurface it.
  if (cancellationFailure !== null && !cancellationFailureIsCurrent) {
    setCancellationFailure(null);
  }
  const cancellationError = cancellationFailureIsCurrent ? cancellationFailure.message : null;
  const onCancelActor = useCallback(
    async (actorId: ActivityRecordId, expectedControlRevision: number) => {
      if (cancellationTarget === null) {
        return;
      }
      const ownership = cancellationOwnershipRef.current;
      const invocation = ownership.invocation + 1;
      ownership.invocation = invocation;
      const targetKey = cancellationTarget.key;
      const controlRevision = cancellationTarget.controlRevision;
      setCancellationFailure(null);
      const result = await cancelSubtree({
        environmentId: cancellationTarget.environmentId,
        input: {
          scope: cancellationTarget.scope,
          scopeId: cancellationTarget.scopeId,
          actorId,
          expectedControlRevision,
        },
      });
      if (
        ownership.targetKey !== targetKey ||
        ownership.controlRevision !== controlRevision ||
        ownership.invocation !== invocation
      ) {
        return;
      }
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setCancellationFailure({
          message: activityCancellationFailureMessage(squashAtomCommandFailure(result)),
          targetKey,
          controlRevision,
        });
      }
    },
    [cancelSubtree, cancellationTarget],
  );
  const onRetryCancellation = useCallback(
    async (rootActorId: ActivityRecordId, expectedOperationRevision: number) => {
      if (cancellationTarget === null) {
        return;
      }
      const ownership = cancellationOwnershipRef.current;
      const invocation = ownership.invocation + 1;
      ownership.invocation = invocation;
      const targetKey = cancellationTarget.key;
      const controlRevision = cancellationTarget.controlRevision;
      setCancellationFailure(null);
      const result = await retrySubtreeCancellation({
        environmentId: cancellationTarget.environmentId,
        input: {
          scope: cancellationTarget.scope,
          scopeId: cancellationTarget.scopeId,
          rootActorId,
          expectedOperationRevision,
        },
      });
      if (
        ownership.targetKey !== targetKey ||
        ownership.controlRevision !== controlRevision ||
        ownership.invocation !== invocation
      ) {
        return;
      }
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setCancellationFailure({
          message: activityCancellationFailureMessage(squashAtomCommandFailure(result)),
          targetKey,
          controlRevision,
        });
      }
    },
    [cancellationTarget, retrySubtreeCancellation],
  );

  if (snapshot === null) {
    return null;
  }
  return (
    <ActivityPanel
      timestampFormat={timestampFormat}
      route={route}
      snapshot={snapshot}
      roster={roster}
      detail={detail}
      onNavigate={onNavigate}
      onLoadMoreRoster={onLoadMoreRoster}
      onLoadMoreDetail={detailQuery.loadMore}
      onRefreshSnapshot={refreshSnapshot}
      focusRequested={focusRequested}
      onFocusRequestHandled={onFocusRequestHandled}
      cancellationError={cancellationError}
      {...(cancellationTarget === null ? {} : { onCancelActor, onRetryCancellation })}
    />
  );
});
