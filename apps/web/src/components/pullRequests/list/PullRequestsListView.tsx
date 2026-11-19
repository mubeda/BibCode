import { resolveChangeRequestPresentationForKind } from "@bibcode/shared/sourceControl";
import { projectKey } from "@bibcode/client-runtime/state/entities";
import { environmentRpcKey, squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import {
  PullRequestsOperationError,
  type EnvironmentId,
  type PullRequestsContext,
  type PullRequestsListInput,
  type PullRequestsListPage,
  type PullRequestsListRow,
  type ScopedProjectRef,
} from "@bibcode/contracts";
import * as Schema from "effect/Schema";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { DEFAULT_PULL_REQUESTS_FILTERS, usePullRequestsStore } from "../../../pullRequestsStore";
import { pullRequestsEnvironment } from "../../../state/pullRequests";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../../state/query";
import { Button } from "../../ui/button";
import { LoadingState, RefreshRegion } from "../../ui/loading-state";
import { Skeleton } from "../../ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs";
import { PullRequestsContextRefresh } from "../pullRequestsContextRefresh";
import { usePullRequestsQuery } from "../shared/usePullRequestsQuery";
import { useVisibleModuleRefresh } from "../../repositoryModule/useVisibleModuleRefresh";
import { shownCopy, type ShownCopy } from "../../repositoryModule/snapshotDisplay.logic";
import { type ResourceRefusal, useResourceRefusal } from "../../repositoryModule/resourceRefusal";
import { useDocumentVisible } from "../useDocumentVisible";
import { PullRequestsFilters } from "./PullRequestsFilters";
import { PullRequestsRow } from "./PullRequestsRow";
import {
  buildListInput,
  selectListFilters,
  selectListSort,
  selectListTab,
} from "./pullRequestsList.logic";

export interface PullRequestsListViewHandle {
  refresh: () => void;
}
export interface PullRequestsListViewProps {
  scope: { environmentId: EnvironmentId; cwd: string };
  projectRef: ScopedProjectRef;
  context: Extract<PullRequestsContext, { status: "available" }>;
  ref?: Ref<PullRequestsListViewHandle> | undefined;
  /**
   * The page read alongside this context load. Rendering only reads this value;
   * the committed list acknowledges it so later opens refresh.
   */
  freshPageKey?: string | null | undefined;
  onFreshPageConsumed?: ((key: string) => void) | undefined;
}
const isPullRequestsOperationError = Schema.is(PullRequestsOperationError);
const TABS = { open: "Open", merged: "Merged", closed: "Closed", all: "All" };
const COMBINED_TABS = ["open", "closed"] as const;
const SEPARATE_TABS = ["open", "merged", "closed", "all"] as const;
const EMPTY_ROWS: readonly PullRequestsListRow[] = [];
const getRowSize = () => 56;
const rowKey = (row: PullRequestsListRow) => String(row.number);

function PullRequestsPages({
  scope,
  projectRef,
  context,
  ref,
  input,
  firstQuery,
  hasFilters,
  firstRefused,
  onPageRefused,
  onClear,
}: PullRequestsListViewProps & {
  input: PullRequestsListInput;
  firstQuery: EnvironmentQueryView<PullRequestsListPage>;
  hasFilters: boolean;
  /** The host refused this list: every page loaded here stays hidden too. */
  firstRefused: boolean;
  /** A later page was refused: the whole list is, as for a first-page refusal. */
  onPageRefused: (event: { readonly refused: ResourceRefusal }) => void;
  onClear: () => void;
}) {
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [earlierRows, setEarlierRows] = useState<readonly PullRequestsListRow[]>(EMPTY_ROWS);
  const cursor = cursors.at(-1) ?? null;
  const nextAtom = useMemo(
    () =>
      cursor === null
        ? null
        : pullRequestsEnvironment.list({
            environmentId: scope.environmentId,
            input: { ...input, cursor },
          }),
    [cursor, input, scope.environmentId],
  );
  const nextQuery = usePullRequestsQuery(nextAtom);
  // One report per failed read: a Retry the host refuses again is a new refusal.
  const nextEmission = nextQuery.emission;
  useEffect(() => {
    const failure = nextEmission._tag === "Failure" ? squashAtomCommandFailure(nextEmission) : null;
    if (
      isPullRequestsOperationError(failure) &&
      (failure.code === "forbidden" || failure.code === "not_found")
    )
      onPageRefused({ refused: failure.code });
  }, [nextEmission, onPageRefused]);
  // Any first-page failure owns the alert and its Retry.
  const query = cursor === null || firstQuery.error !== null ? firstQuery : nextQuery;
  const firstData = firstRefused ? null : firstQuery.data;
  const rows = useMemo(() => {
    if (firstRefused) return EMPTY_ROWS;
    const combined =
      cursor === null
        ? (firstData?.rows ?? EMPTY_ROWS)
        : [
            ...(firstData?.rows ?? EMPTY_ROWS),
            ...earlierRows,
            ...(nextQuery.data?.rows ?? EMPTY_ROWS),
          ];
    return [...new Map(combined.map((row) => [row.number, row])).values()];
  }, [cursor, earlierRows, firstData, firstRefused, nextQuery.data]);
  const savedScrollTop = usePullRequestsStore(
    (state) => state.byProjectKey[projectKey(projectRef)]?.scrollTop ?? 0,
  );
  const scrollTopRef = useRef(savedScrollTop);
  const scrollRef = useRef<LegendListRef | null>(null);
  const restorationTarget = useRef(savedScrollTop > 0 ? savedScrollTop : null);
  useEffect(() => {
    const filtersOnOpen = usePullRequestsStore.getState().selectViewState(projectRef).filters;
    const persistScroll = () => {
      const store = usePullRequestsStore.getState();
      const current = store.selectViewState(projectRef);
      // Filter/checkout resets own their new scroll position, even for equal query values.
      if (
        current.filters === filtersOnOpen &&
        (current.checkoutCwd ?? scope.cwd) === scope.cwd &&
        JSON.stringify(buildListInput(current, scope.cwd)) === JSON.stringify(input)
      ) {
        store.setScrollTop(projectRef, scrollTopRef.current);
      }
    };
    window.addEventListener("pagehide", persistScroll);
    return () => {
      window.removeEventListener("pagehide", persistScroll);
      persistScroll();
    };
  }, [input, projectRef, scope.cwd]);
  const refreshFirstPage = firstQuery.refresh;
  const environmentId = scope.environmentId;
  // A manual Refresh keeps the loaded pages, selection and scroll until its read succeeds.
  const resetFromRef = useRef<{ readonly data: unknown } | null>(null);
  const resetPages = useCallback(() => {
    setCursors([null]);
    setEarlierRows(EMPTY_ROWS);
    scrollTopRef.current = 0;
    usePullRequestsStore.getState().setScrollTop(projectRef, 0);
    scrollRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [projectRef]);
  const refresh = useCallback(() => {
    restorationTarget.current = null;
    resetFromRef.current = { data: firstQuery.data };
    // An explicit Refresh also re-reads the repository-wide tab totals.
    pullRequestsEnvironment.requestListTotalsRefresh({ environmentId, input });
    refreshFirstPage();
  }, [environmentId, firstQuery.data, input, refreshFirstPage]);
  useEffect(() => {
    // The same data means the read has not answered yet; a failed read leaves the reset
    // waiting for the next successful one.
    const from = resetFromRef.current;
    if (from === null || firstQuery.isPending || firstQuery.error !== null) return;
    if (firstQuery.data === from.data) return;
    resetFromRef.current = null;
    resetPages();
  }, [firstQuery.data, firstQuery.error, firstQuery.isPending, resetPages]);
  useImperativeHandle(ref, () => ({ refresh }), [refresh]);
  const renderRow = useCallback(
    ({ item }: { item: PullRequestsListRow }) => (
      <PullRequestsRow row={item} projectRef={projectRef} context={context} scope={scope} />
    ),
    [context, projectRef, scope],
  );
  const failure =
    query.emission._tag === "Failure" ? squashAtomCommandFailure(query.emission) : null;
  const typedError = isPullRequestsOperationError(failure) ? failure : null;
  const refreshContext = useContext(PullRequestsContextRefresh);
  useEffect(() => {
    if (typedError?.code === "not_authenticated") refreshContext?.();
  }, [refreshContext, typedError]);
  const message = typedError?.message ?? query.error;
  const nextCursor = query.data?.nextCursor ?? null;
  // A zero-row page is a resolved page: only the absence of one is a first load.
  const rereading = firstQuery.isPending || nextQuery.isPending;
  const pluralLongName = resolveChangeRequestPresentationForKind(context.provider).pluralLongName;
  const loadMore = () => {
    if (query.isPending || nextCursor === null || cursors.includes(nextCursor)) return;
    if (cursor !== null && nextQuery.data) {
      const pageRows = nextQuery.data.rows;
      setEarlierRows((previous) => [...previous, ...pageRows]);
    }
    setCursors((previous) => [...previous, nextCursor]);
  };
  const restorePagePosition = useEffectEvent(
    (
      pageData: PullRequestsListPage | null,
      pending: boolean,
      error: string | null,
      rowCount: number,
      next: string | null,
    ) => {
      const target = restorationTarget.current;
      if (target === null || pending || pageData === null) return;
      if (error !== null) {
        restorationTarget.current = null;
        return;
      }
      const viewportHeight = scrollRef.current?.getScrollableNode().clientHeight ?? 0;
      if (rowCount * 56 <= target + viewportHeight && next !== null && !cursors.includes(next)) {
        loadMore();
        return;
      }
      scrollRef.current?.scrollToOffset({ offset: target, animated: false });
      restorationTarget.current = null;
    },
  );
  useEffect(() => {
    restorePagePosition(query.data, query.isPending, message, rows.length, nextCursor);
  }, [message, nextCursor, query.data, query.isPending, rows.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {message !== null ? (
        <div role="alert" className="space-y-2 border-b border-border p-4 text-sm">
          <p>{message}</p>
          {typedError?.hostDetail ? (
            <p className="text-xs text-muted-foreground">{typedError.hostDetail}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              // A refused later page re-reads the list from its first page, which lifts it.
              onClick={firstRefused && query === nextQuery ? refresh : query.refresh}
              disabled={query.isPending}
              title={query.isPending ? "Loading…" : undefined}
            >
              Retry
            </Button>
            {hasFilters ? (
              <Button size="sm" variant="outline" onClick={onClear}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {rereading && firstData === null ? (
        <LoadingState label={`Loading ${pluralLongName}…`}>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </LoadingState>
      ) : null}
      <RefreshRegion
        className="flex min-h-0 flex-1 flex-col"
        refreshing={rereading && firstData !== null}
        status={`${firstQuery.isPending ? "Refreshing" : "Loading more"} ${pluralLongName}…`}
      >
        {rows.length > 0 ? (
          <LegendList<PullRequestsListRow>
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-x-hidden"
            role="list"
            aria-label={resolveChangeRequestPresentationForKind(context.provider).pluralLongName}
            data={rows}
            estimatedItemSize={56}
            getFixedItemSize={getRowSize}
            keyExtractor={rowKey}
            initialScrollOffset={savedScrollTop}
            renderItem={renderRow}
            onWheel={() => {
              restorationTarget.current = null;
            }}
            onTouchMove={() => {
              restorationTarget.current = null;
            }}
            onScroll={(event) => {
              scrollTopRef.current = event.nativeEvent.contentOffset.y;
            }}
          />
        ) : null}
        {rows.length === 0 && firstData !== null && message === null ? (
          <div className="space-y-3 p-6 text-sm text-muted-foreground">
            <p>
              {hasFilters
                ? "Nothing matches these filters"
                : `No ${input.state === "all" ? "" : `${input.state} `}${resolveChangeRequestPresentationForKind(context.provider).pluralLongName}`}
            </p>
            {hasFilters ? (
              <Button size="sm" variant="outline" onClick={onClear}>
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : null}
        {nextCursor !== null && !cursors.includes(nextCursor) && message === null ? (
          <div className="border-t border-border p-3">
            <Button
              size="sm"
              variant="outline"
              disabled={query.isPending}
              title={query.isPending ? "Loading…" : undefined}
              onClick={loadMore}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </RefreshRegion>
    </div>
  );
}
export function PullRequestsListView({
  scope,
  projectRef,
  context,
  ref,
  freshPageKey,
  onFreshPageConsumed,
}: PullRequestsListViewProps) {
  const key = projectKey(projectRef);
  const filters = usePullRequestsStore((state) => selectListFilters(state.byProjectKey[key]));
  const storedTab = usePullRequestsStore((state) => selectListTab(state.byProjectKey[key]));
  const sort = usePullRequestsStore((state) => selectListSort(state.byProjectKey[key]));
  const listTab =
    context.capabilities.closedTabIncludesMerged && (storedTab === "merged" || storedTab === "all")
      ? "closed"
      : storedTab;
  const input = useMemo(
    () => buildListInput({ filters, listTab, sort }, scope.cwd),
    [filters, listTab, scope.cwd, sort],
  );
  const firstAtom = useMemo(
    () => pullRequestsEnvironment.list({ environmentId: scope.environmentId, input }),
    [input, scope.environmentId],
  );
  const firstQuery = usePullRequestsQuery(firstAtom, {
    freshOnOpen: freshPageKey === environmentRpcKey({ environmentId: scope.environmentId, input }),
  });
  const isGitlab = context.provider === "gitlab";
  const snapshotTarget = useMemo(
    () => ({ environmentId: scope.environmentId, input: { ...input, number: null, tab: null } }),
    [input, scope.environmentId],
  );
  // Both hosts paint the stored first page; only GitLab subscribes to changes.
  const snapshotAtom = useMemo(
    () => pullRequestsEnvironment.readSnapshot(snapshotTarget),
    [snapshotTarget],
  );
  const snapshotQuery = useEnvironmentQuery(snapshotAtom);
  const visible = useDocumentVisible();
  const subscribeAtom = useMemo(
    () => (isGitlab && visible ? pullRequestsEnvironment.subscribe(snapshotTarget) : null),
    [isGitlab, snapshotTarget, visible],
  );
  const subscribeQuery = useEnvironmentQuery(subscribeAtom);
  // A success on the push stream, even the initial all-false connected event,
  // stands the client's own refresh timer down until the stream fails or waits again.
  const paused = isGitlab && subscribeQuery.emission._tag === "Success";
  const [shownList, setShownList] = useState<ShownCopy<PullRequestsListPage> | null>(null);
  const nextShownList = shownCopy(
    shownList,
    environmentRpcKey(snapshotTarget),
    firstQuery.data,
    // GitHub never polls, so once its live page answers a stored copy only covered the
    // wait: a late one must not replace it, whatever the two clocks say.
    isGitlab || firstQuery.data === null
      ? { answered: snapshotQuery.data !== null, row: snapshotQuery.data?.list ?? null }
      : null,
  );
  if (nextShownList !== shownList) setShownList(nextShownList);
  const applySubscribedChange = useEffectEvent(
    (changed: NonNullable<typeof subscribeQuery.data>) => {
      if (changed.list) snapshotQuery.revalidate();
    },
  );
  useEffect(() => {
    if (subscribeQuery.data) applySubscribedChange(subscribeQuery.data);
  }, [subscribeQuery.data]);
  useVisibleModuleRefresh({
    enabled: isGitlab,
    succeeded: firstQuery.data !== null && firstQuery.error === null && !firstQuery.isPending,
    paused,
    revalidate: firstQuery.revalidate,
  });
  // A refusal hides every copy of this list, the stored one and the tab counts included,
  // until the host answers a later read of the same list.
  const [pageRefusal, setPageRefusal] = useState<{ readonly refused: ResourceRefusal } | null>(
    null,
  );
  const liveFailure =
    firstQuery.emission._tag === "Failure" ? squashAtomCommandFailure(firstQuery.emission) : null;
  const refused =
    useResourceRefusal(
      `pullRequests.list:${context.host}/${context.repository}:${environmentRpcKey({ environmentId: scope.environmentId, input })}`,
      firstQuery,
      isPullRequestsOperationError(liveFailure) &&
        (liveFailure.code === "forbidden" || liveFailure.code === "not_found")
        ? liveFailure.code
        : null,
      pageRefusal,
    ) !== null;
  const displayedFirstPage = refused ? null : (nextShownList?.payload ?? null);
  // The stored copy's read is what a change event updates the screen from.
  const displayedFirstQuery: EnvironmentQueryView<PullRequestsListPage> = {
    ...firstQuery,
    data: refused ? null : (displayedFirstPage ?? firstQuery.data),
    isPending: firstQuery.isPending || snapshotQuery.isPending,
  };
  useEffect(() => {
    if (freshPageKey != null) onFreshPageConsumed?.(freshPageKey);
  }, [freshPageKey, onFreshPageConsumed]);
  const tabs = context.capabilities.closedTabIncludesMerged ? COMBINED_TABS : SEPARATE_TABS;
  const hasFilters = Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== null && value !== "",
  );
  const [resetKey, setResetKey] = useState(0);
  const clear = () => {
    usePullRequestsStore.getState().setFilters(projectRef, DEFAULT_PULL_REQUESTS_FILTERS);
    setResetKey((value) => value + 1);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs
        className="min-h-0 flex-1 gap-0"
        value={listTab}
        onValueChange={(value) => {
          if (value === "open" || value === "closed" || value === "merged" || value === "all")
            usePullRequestsStore.getState().setListTab(projectRef, value);
        }}
      >
        <TabsList
          aria-label={`${resolveChangeRequestPresentationForKind(context.provider).longName} state`}
          className="mx-4 mt-3 shrink-0"
        >
          {tabs.map((tab) => {
            const counts = displayedFirstPage?.counts;
            const count =
              tab === "all"
                ? counts?.open !== null &&
                  counts?.open !== undefined &&
                  counts.closed !== null &&
                  counts.merged !== null
                  ? counts.open + counts.closed + counts.merged
                  : null
                : (counts?.[tab] ?? null);
            return (
              <TabsTab key={tab} value={tab}>
                {TABS[tab]}
                {count !== null ? ` ${count}` : ""}
              </TabsTab>
            );
          })}
        </TabsList>
        <TabsPanel value={listTab} className="min-h-0 flex-1 gap-0">
          <PullRequestsFilters
            scope={scope}
            context={context}
            filters={filters}
            sort={sort}
            resetKey={resetKey}
            onFiltersChange={(patch) =>
              usePullRequestsStore.getState().setFilters(projectRef, patch)
            }
            onSortChange={(value) => usePullRequestsStore.getState().setSort(projectRef, value)}
            onClear={clear}
          />
          <PullRequestsPages
            key={JSON.stringify([scope.environmentId, input, resetKey])}
            scope={scope}
            projectRef={projectRef}
            context={context}
            ref={ref}
            input={input}
            firstQuery={displayedFirstQuery}
            hasFilters={hasFilters}
            firstRefused={refused}
            onPageRefused={setPageRefusal}
            onClear={clear}
          />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
