import { environmentRpcKey, squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import {
  PullRequestsOperationError,
  type EnvironmentId,
  type PipelinesListInput,
  type PipelinesListPage,
  type PipelinesListScope,
  type PipelinesRow,
  type ScopedProjectRef,
} from "@bibcode/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import * as Schema from "effect/Schema";
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
import { usePipelinesStore, type PipelinesFilters } from "../../../pipelinesStore";
import { pipelinesEnvironment } from "../../../state/pipelines";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../../state/query";
import { PullRequestsContextRefresh } from "../../pullRequests/pullRequestsContextRefresh";
import { usePullRequestsQuery } from "../../pullRequests/shared/usePullRequestsQuery";
import { useDocumentVisible } from "../../pullRequests/useDocumentVisible";
import { useRepositoryModule } from "../../repositoryModule/RepositoryModule";
import { shownCopy, type ShownCopy } from "../../repositoryModule/snapshotDisplay.logic";
import { useVisibleModuleRefresh } from "../../repositoryModule/useVisibleModuleRefresh";
import { Button } from "../../ui/button";
import { PermissionButton } from "../../ui/permission-button";
import { Skeleton } from "../../ui/skeleton";
import { Tabs, TabsList, TabsTab } from "../../ui/tabs";
import { useRateLimitCountdown } from "../shared/useRateLimitCountdown";
import { PipelinesBranchFilter } from "./PipelinesBranchFilter";
import { PIPELINES_ROW_HEIGHT, PipelinesListRow } from "./PipelinesListRow";
import {
  EMPTY_LIST_COPY,
  buildPipelinesListInput,
  listSnapshotInput,
  listTimerEnabled,
  mergePipelineRows,
} from "./pipelinesList.logic";

export interface PipelinesListViewHandle {
  refresh: () => void;
}

const isOperationError = Schema.is(PullRequestsOperationError);
const SCOPES: readonly { readonly value: PipelinesListScope; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "finished", label: "Finished" },
];
const EMPTY_ROWS: readonly PipelinesRow[] = [];
const getRowSize = () => PIPELINES_ROW_HEIGHT;
const rowKey = (row: PipelinesRow) => String(row.id);

function operationError(query: EnvironmentQueryView<unknown>) {
  const failure =
    query.emission._tag === "Failure" ? squashAtomCommandFailure(query.emission) : null;
  return isOperationError(failure) ? failure : null;
}

/** The first page and every page loaded after it, for one list key. */
function PipelinesPages({
  scope,
  projectRef,
  input,
  firstQuery,
  hasRef,
  onClearRef,
  onTimerRetry,
  onBackoffChange,
  ref,
}: {
  scope: { environmentId: EnvironmentId; cwd: string };
  projectRef: ScopedProjectRef;
  input: PipelinesListInput;
  firstQuery: EnvironmentQueryView<PipelinesListPage>;
  hasRef: boolean;
  onClearRef: () => void;
  onTimerRetry: () => void;
  onBackoffChange: (backedOff: boolean) => void;
  ref: Ref<PipelinesListViewHandle> | undefined;
}) {
  const {
    context,
    meta: { mutationsDisabledReason },
  } = useRepositoryModule();
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [laterRows, setLaterRows] = useState<readonly PipelinesRow[]>(EMPTY_ROWS);
  const cursor = cursors.at(-1) ?? null;
  const nextAtom = useMemo(
    () =>
      cursor === null
        ? null
        : pipelinesEnvironment.list({
            environmentId: scope.environmentId,
            input: { ...input, cursor },
          }),
    [cursor, input, scope.environmentId],
  );
  const nextQuery = usePullRequestsQuery(nextAtom);
  const query = cursor === null ? firstQuery : nextQuery;
  const rows = useMemo(
    () =>
      mergePipelineRows(
        firstQuery.data?.rows ?? EMPTY_ROWS,
        cursor === null ? EMPTY_ROWS : [...laterRows, ...(nextQuery.data?.rows ?? EMPTY_ROWS)],
      ),
    [cursor, firstQuery.data, laterRows, nextQuery.data],
  );
  const savedScrollTop = usePipelinesStore((state) => state.selectViewState(projectRef).scrollTop);
  const scrollTopRef = useRef(savedScrollTop);
  const scrollRef = useRef<LegendListRef | null>(null);
  useEffect(
    () => () => usePipelinesStore.getState().setScrollTop(projectRef, scrollTopRef.current),
    [projectRef],
  );
  const refreshFirstPage = firstQuery.refresh;
  const refresh = useCallback(() => {
    setCursors([null]);
    setLaterRows(EMPTY_ROWS);
    scrollTopRef.current = 0;
    scrollRef.current?.scrollToOffset({ offset: 0, animated: false });
    refreshFirstPage();
  }, [refreshFirstPage]);
  useImperativeHandle(ref, () => ({ refresh }), [refresh]);
  const error = operationError(query);
  const refreshContext = useContext(PullRequestsContextRefresh);
  useEffect(() => {
    if (error?.code === "not_authenticated") refreshContext?.();
  }, [error, refreshContext]);
  const waitSeconds = useRateLimitCountdown(
    error,
    cursor === null ? onTimerRetry : query.revalidate,
  );
  const backedOff = waitSeconds !== null;
  useEffect(() => {
    onBackoffChange(backedOff);
  }, [backedOff, onBackoffChange]);
  const message = error?.message ?? query.error;
  const nextCursor = query.data?.nextCursor ?? null;
  const loadMore = () => {
    if (query.isPending || nextCursor === null || cursors.includes(nextCursor)) return;
    if (cursor !== null && nextQuery.data) {
      const pageRows = nextQuery.data.rows;
      setLaterRows((previous) => [...previous, ...pageRows]);
    }
    setCursors((previous) => [...previous, nextCursor]);
  };
  const renderRow = useCallback(
    ({ item }: { item: PipelinesRow }) => (
      <PipelinesListRow
        row={item}
        provider={context.provider}
        scope={scope}
        projectRef={projectRef}
        mutationsDisabledReason={mutationsDisabledReason}
      />
    ),
    [context.provider, mutationsDisabledReason, projectRef, scope],
  );
  const total = firstQuery.data?.total ?? null;
  const loaded = query.data !== null && !query.isPending;
  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      {message !== null ? (
        <div role="alert" className="space-y-2 border-b border-border p-4 text-sm">
          <p>{message}</p>
          {waitSeconds !== null ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              Trying again in {waitSeconds} s.
            </p>
          ) : error?.hostDetail ? (
            <p className="text-xs text-muted-foreground">{error.hostDetail}</p>
          ) : null}
          <div className="flex gap-2">
            <PermissionButton
              size="sm"
              variant="outline"
              onClick={query.refresh}
              permission={
                waitSeconds !== null
                  ? {
                      allowed: false,
                      reason: "The host asked BiBCode to wait before reading again.",
                    }
                  : { allowed: !query.isPending, reason: query.isPending ? "Loading…" : null }
              }
            >
              Retry
            </PermissionButton>
            {hasRef ? (
              <Button size="sm" variant="outline" onClick={onClearRef}>
                Clear filter
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <LegendList<PipelinesRow>
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-x-hidden"
          role="list"
          aria-label="Pipelines"
          data={rows}
          estimatedItemSize={PIPELINES_ROW_HEIGHT}
          getFixedItemSize={getRowSize}
          keyExtractor={rowKey}
          initialScrollOffset={savedScrollTop}
          renderItem={renderRow}
          onScroll={(event) => {
            scrollTopRef.current = event.nativeEvent.contentOffset.y;
          }}
        />
      ) : null}
      {query.isPending && rows.length === 0 ? (
        <div role="status" className="space-y-2 p-4">
          <span className="sr-only">Loading pipelines…</span>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : null}
      {rows.length === 0 && loaded && message === null ? (
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>
            {hasRef && input.ref ? `No pipelines on ${input.ref}` : EMPTY_LIST_COPY[input.scope]}
          </p>
          {hasRef ? (
            <Button size="sm" variant="outline" onClick={onClearRef}>
              Clear filter
            </Button>
          ) : null}
        </div>
      ) : null}
      {nextCursor !== null && !cursors.includes(nextCursor) && message === null ? (
        <div className="border-t border-border p-3">
          <PermissionButton
            size="sm"
            variant="outline"
            permission={{ allowed: !query.isPending, reason: query.isPending ? "Loading…" : null }}
            onClick={loadMore}
          >
            Load more
          </PermissionButton>
        </div>
      ) : null}
      {/* GitHub stops a filtered list at 1,000 runs; GitLab pages to the end. */}
      {context.provider === "github" && nextCursor === null && rows.length > 0 && total?.capped ? (
        <p className="border-t border-border p-3 text-xs text-muted-foreground">
          GitHub returns at most 1,000 filtered runs.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A project's pipelines: the stored first page paints at once, then the live one.
 * GitLab follows the server's shared poller while its stream is live, and the
 * visible timer otherwise; GitHub follows the timer while a shown pipeline can
 * still change.
 */
export function PipelinesListView({
  filters,
  onFiltersChange,
  onBackoffChange,
  ref,
}: {
  filters: PipelinesFilters;
  onFiltersChange: (filters: PipelinesFilters) => void;
  /** The host asked for a pause: a Refresh before it ends would only be refused. */
  onBackoffChange: (backedOff: boolean) => void;
  ref?: Ref<PipelinesListViewHandle> | undefined;
}) {
  const {
    context,
    state: { scope, freshPageKey },
    actions: { consumeFreshPage },
    meta: { projectRef },
  } = useRepositoryModule();
  const environmentId = scope.environmentId;
  const input = useMemo(() => buildPipelinesListInput(filters, scope.cwd), [filters, scope.cwd]);
  const firstTarget = useMemo(() => ({ environmentId, input }), [environmentId, input]);
  const firstAtom = useMemo(() => pipelinesEnvironment.list(firstTarget), [firstTarget]);
  const firstQuery = usePullRequestsQuery(firstAtom, {
    freshOnOpen: freshPageKey === environmentRpcKey(firstTarget),
  });
  const isGitlab = context.provider === "gitlab";
  const snapshotTarget = useMemo(
    () => ({ environmentId, input: listSnapshotInput(input) }),
    [environmentId, input],
  );
  // Both hosts paint the stored first page; only GitLab subscribes to changes.
  const snapshotAtom = useMemo(
    () => pipelinesEnvironment.readSnapshot(snapshotTarget),
    [snapshotTarget],
  );
  const snapshotQuery = useEnvironmentQuery(snapshotAtom);
  const visible = useDocumentVisible();
  const subscribeAtom = useMemo(
    () => (isGitlab && visible ? pipelinesEnvironment.subscribe(snapshotTarget) : null),
    [isGitlab, snapshotTarget, visible],
  );
  const subscribeQuery = useEnvironmentQuery(subscribeAtom);
  // Any success on the stream, even its first all-false event, stands the timer down
  // until the stream fails or waits again.
  const paused = isGitlab && subscribeQuery.emission._tag === "Success";
  const [shownList, setShownList] = useState<ShownCopy<PipelinesListPage> | null>(null);
  const nextShownList = shownCopy(
    shownList,
    environmentRpcKey(snapshotTarget),
    firstQuery.data,
    // GitHub has no poller: once its live page answered, a late stored copy only
    // covered the wait and must not replace it.
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
  const revalidateFirstPage = firstQuery.revalidate;
  const timerRead = useCallback(() => {
    pipelinesEnvironment.requestTimerRead(firstTarget);
    revalidateFirstPage();
  }, [firstTarget, revalidateFirstPage]);
  const displayedFirstPage = nextShownList?.payload ?? null;
  useVisibleModuleRefresh({
    enabled: listTimerEnabled(context.provider, displayedFirstPage?.rows ?? EMPTY_ROWS),
    succeeded: firstQuery.data !== null && firstQuery.error === null && !firstQuery.isPending,
    paused,
    revalidate: timerRead,
  });
  const displayedFirstQuery: EnvironmentQueryView<PipelinesListPage> =
    displayedFirstPage === null
      ? firstQuery
      : {
          ...firstQuery,
          data: displayedFirstPage,
          isPending: firstQuery.data === null ? false : firstQuery.isPending,
        };
  useEffect(() => {
    if (freshPageKey !== null) consumeFreshPage(freshPageKey);
  }, [consumeFreshPage, freshPageKey]);
  const total = displayedFirstPage?.total ?? null;
  const clearRef = () => onFiltersChange({ ...filters, ref: null });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-4 pt-3 pb-2">
        <Tabs
          value={filters.scope}
          onValueChange={(value) => {
            const next = SCOPES.find((scopeOption) => scopeOption.value === value);
            if (next) onFiltersChange({ ...filters, scope: next.value });
          }}
        >
          <TabsList aria-label="Pipeline status">
            {SCOPES.map((option) => (
              <TabsTab key={option.value} value={option.value}>
                {option.label}
                {option.value === filters.scope && total !== null
                  ? ` ${total.count.toLocaleString()}${total.capped ? "+" : ""}`
                  : ""}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        <PipelinesBranchFilter
          key={filters.ref ?? ""}
          scope={scope}
          value={filters.ref}
          onChange={(ref) => onFiltersChange({ ...filters, ref })}
        />
      </div>
      <PipelinesPages
        key={JSON.stringify([environmentId, input])}
        scope={scope}
        projectRef={projectRef}
        input={input}
        firstQuery={displayedFirstQuery}
        hasRef={filters.ref !== null}
        onClearRef={clearRef}
        onTimerRetry={timerRead}
        onBackoffChange={onBackoffChange}
        ref={ref}
      />
    </div>
  );
}
