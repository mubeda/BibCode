import { projectKey } from "@bibcode/client-runtime/state/entities";
import type {
  GitManagerCommitEntry,
  GitManagerCommitPage,
  ScopedProjectRef,
} from "@bibcode/contracts";
import { GitManagerOperationError } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_GIT_MANAGER_VIEW_STATE, useGitManagerStore } from "../../../gitManagerStore";
import { gitManagerEnvironment } from "../../../state/gitManager";
import { useEnvironmentQuery } from "../../../state/query";
import { createCommitLookup, spliceCommitGeneration } from "./commitPaging";
import { GitManagerCommitDetail } from "./GitManagerCommitDetail";
import { GitManagerCommitList } from "./GitManagerCommitList";

const HISTORY_PAGE_SIZE = 100;
const COMMIT_LOOKUP_MAX_ENTRIES = 1_000;
const COMMIT_LOOKUP_MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const EMPTY_COMMITS: ReadonlyArray<GitManagerCommitEntry> = Object.freeze([]);
const EMPTY_TIPS: ReadonlyArray<string> = Object.freeze([]);
const isGitManagerOperationError = Schema.is(GitManagerOperationError);

interface GitManagerHistoryViewProps {
  readonly scope: {
    readonly environmentId: ScopedProjectRef["environmentId"];
    readonly cwd: string;
  };
  readonly projectRef: ScopedProjectRef;
}

interface HistoryPagesState {
  readonly generation: number | null;
  readonly pinnedTips: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<GitManagerCommitEntry>;
  readonly nextOffset: number | null;
  readonly exhausted: boolean;
  readonly degradedToAllPaging: boolean;
  readonly processedFirstPageSignature: string | null;
}

function emptyHistoryPages(): HistoryPagesState {
  return {
    generation: null,
    pinnedTips: EMPTY_TIPS,
    commits: EMPTY_COMMITS,
    nextOffset: null,
    exhausted: false,
    degradedToAllPaging: false,
    processedFirstPageSignature: null,
  };
}

function pageSignature(page: GitManagerCommitPage | null, requestOffset = 0): string | null {
  if (page === null) return null;
  return [
    requestOffset,
    page.generation,
    page.nextOffset ?? "end",
    page.exhausted ? 1 : 0,
    page.degradedToAllPaging ? 1 : 0,
    page.pinnedTips.join(","),
    page.commits.length,
    page.commits[0]?.sha ?? "empty",
    page.commits.at(-1)?.sha ?? "empty",
  ].join(":");
}

function historyFromFirstPage(page: GitManagerCommitPage, signature: string): HistoryPagesState {
  return {
    generation: page.generation,
    pinnedTips: page.pinnedTips,
    commits: page.commits,
    nextOffset: page.nextOffset,
    exhausted: page.exhausted,
    degradedToAllPaging: page.degradedToAllPaging,
    processedFirstPageSignature: signature,
  };
}

function appendUniqueCommits(
  loaded: ReadonlyArray<GitManagerCommitEntry>,
  incoming: ReadonlyArray<GitManagerCommitEntry>,
): ReadonlyArray<GitManagerCommitEntry> {
  const loadedShas = new Set(loaded.map((commit) => commit.sha));
  const additions = incoming.filter((commit) => {
    if (loadedShas.has(commit.sha)) return false;
    loadedShas.add(commit.sha);
    return true;
  });
  return additions.length === 0 ? loaded : [...loaded, ...additions];
}

function isTipsUnresolvableFailure(result: AsyncResult.AsyncResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  const failure = Cause.squash(result.cause);
  return isGitManagerOperationError(failure) && failure.code === "history-tips-unresolvable";
}

export const GitManagerHistoryView = memo(function GitManagerHistoryView({
  scope,
  projectRef,
}: GitManagerHistoryViewProps) {
  const { environmentId, cwd } = scope;
  const projectEnvironmentId = projectRef.environmentId;
  const projectId = projectRef.projectId;
  const storeKey = projectKey(projectRef);
  const [pages, setPages] = useState<HistoryPagesState>(emptyHistoryPages);
  const [loadingOffset, setLoadingOffset] = useState<number | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const pagesRef = useRef(pages);
  const loadingOffsetRef = useRef(loadingOffset);
  const firstPageRef = useRef<GitManagerCommitPage | null>(null);
  const nextPageRef = useRef<GitManagerCommitPage | null>(null);
  const processedNextPageSignatureRef = useRef<string | null>(null);
  const explicitRefreshRef = useRef(false);
  const lastSignalGenerationRef = useRef<number | null>(null);
  const [commitLookup] = useState(() =>
    createCommitLookup<GitManagerCommitEntry>(
      COMMIT_LOOKUP_MAX_ENTRIES,
      COMMIT_LOOKUP_MAX_MEMORY_BYTES,
    ),
  );
  pagesRef.current = pages;
  loadingOffsetRef.current = loadingOffset;

  const selectSelectedCommitSha = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.selectedCommitSha ??
      DEFAULT_GIT_MANAGER_VIEW_STATE.selectedCommitSha,
    [storeKey],
  );
  const selectSelectedFilePath = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.selectedFilePath ??
      DEFAULT_GIT_MANAGER_VIEW_STATE.selectedFilePath,
    [storeKey],
  );
  const selectLoadedPageCursors = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.loadedPageCursors ??
      DEFAULT_GIT_MANAGER_VIEW_STATE.loadedPageCursors,
    [storeKey],
  );
  const selectScrollAnchor = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.scrollAnchor ?? DEFAULT_GIT_MANAGER_VIEW_STATE.scrollAnchor,
    [storeKey],
  );
  const selectedCommitSha = useGitManagerStore(selectSelectedCommitSha);
  const selectedFilePath = useGitManagerStore(selectSelectedFilePath);
  const loadedPageCursors = useGitManagerStore(selectLoadedPageCursors);
  const scrollAnchor = useGitManagerStore(selectScrollAnchor);
  const setSelectedCommit = useGitManagerStore((state) => state.setSelectedCommit);
  const setSelectedFile = useGitManagerStore((state) => state.setSelectedFile);
  const setLoadedPageCount = useGitManagerStore((state) => state.setLoadedPageCount);
  const setLoadedPageCursors = useGitManagerStore((state) => state.setLoadedPageCursors);
  const setScrollAnchor = useGitManagerStore((state) => state.setScrollAnchor);
  const loadedPageCursorsRef = useRef(loadedPageCursors);
  loadedPageCursorsRef.current = loadedPageCursors;
  const loadedPageCursorSignature = loadedPageCursors.join(",");

  const firstPageAtom = useMemo(
    () =>
      gitManagerEnvironment.getCommits({
        environmentId,
        input: { cwd, limit: HISTORY_PAGE_SIZE },
      }),
    [cwd, environmentId],
  );
  const firstPageQuery = useEnvironmentQuery(firstPageAtom);
  firstPageRef.current = firstPageQuery.data;
  const firstPageSignature = pageSignature(firstPageQuery.data);

  const signalAtom = useMemo(
    () =>
      gitManagerEnvironment.signal({
        environmentId,
        input: { cwd },
      }),
    [cwd, environmentId],
  );
  const signalQuery = useEnvironmentQuery(signalAtom);
  const signalGeneration = signalQuery.data?.generation ?? null;

  const nextPageAtom = useMemo(() => {
    if (loadingOffset === null) return null;
    const pinnedTips = pages.pinnedTips;
    return gitManagerEnvironment.getCommits({
      environmentId,
      input: {
        cwd,
        offset: loadingOffset,
        limit: HISTORY_PAGE_SIZE,
        ...(pinnedTips.length > 0 ? { pinnedTips } : {}),
      },
    });
  }, [cwd, environmentId, loadingOffset, pages.pinnedTips]);
  const nextPageQuery = useEnvironmentQuery(nextPageAtom);
  nextPageRef.current = nextPageQuery.data;
  const nextPageSignature = pageSignature(nextPageQuery.data, loadingOffset ?? 0);
  const nextPageTipsUnresolvable = isTipsUnresolvableFailure(nextPageQuery.emission);

  useEffect(() => {
    if (signalGeneration === null) return;
    if (lastSignalGenerationRef.current === null) {
      lastSignalGenerationRef.current = signalGeneration;
      return;
    }
    if (lastSignalGenerationRef.current !== signalGeneration) {
      lastSignalGenerationRef.current = signalGeneration;
      firstPageQuery.refresh();
    }
  }, [firstPageQuery.refresh, signalGeneration]);

  useEffect(() => {
    const page = firstPageRef.current;
    if (page === null || firstPageSignature === null) return;
    const current = pagesRef.current;
    if (current.processedFirstPageSignature === firstPageSignature && !explicitRefreshRef.current) {
      return;
    }
    for (const commit of page.commits) commitLookup.set(commit);

    let next: HistoryPagesState;
    let resetCursors = false;
    let preserveStoredCursors = false;
    if (explicitRefreshRef.current || current.generation === null || current.commits.length === 0) {
      next = historyFromFirstPage(page, firstPageSignature);
      resetCursors = true;
      preserveStoredCursors = current.generation === null && !explicitRefreshRef.current;
    } else if (page.generation !== current.generation) {
      const spliced = spliceCommitGeneration({
        loaded: current.commits,
        incoming: page.commits,
        pinnedTips: current.pinnedTips,
      });
      if (current.degradedToAllPaging || page.degradedToAllPaging) {
        next = historyFromFirstPage(page, firstPageSignature);
        resetCursors = true;
      } else {
        next = {
          ...current,
          generation: page.generation,
          commits: spliced.commits,
          processedFirstPageSignature: firstPageSignature,
        };
      }
    } else {
      next = { ...current, processedFirstPageSignature: firstPageSignature };
    }

    explicitRefreshRef.current = false;
    pagesRef.current = next;
    setPages(next);
    if (resetCursors) {
      const currentProjectRef = {
        environmentId: projectEnvironmentId,
        projectId,
      } as ScopedProjectRef;
      const cursors =
        preserveStoredCursors && loadedPageCursorsRef.current.length > 0
          ? loadedPageCursorsRef.current
          : [0];
      setLoadedPageCursors(currentProjectRef, cursors);
      setLoadedPageCount(currentProjectRef, cursors.length);
    }
  }, [
    commitLookup,
    firstPageSignature,
    projectEnvironmentId,
    projectId,
    refreshEpoch,
    setLoadedPageCount,
    setLoadedPageCursors,
  ]);

  useEffect(() => {
    if (loadingOffset === null || nextPageSignature === null) return;
    if (processedNextPageSignatureRef.current === nextPageSignature) return;
    const page = nextPageRef.current;
    if (page === null) return;
    processedNextPageSignatureRef.current = nextPageSignature;
    for (const commit of page.commits) commitLookup.set(commit);

    const current = pagesRef.current;
    const next: HistoryPagesState = {
      ...current,
      commits: appendUniqueCommits(current.commits, page.commits),
      nextOffset: page.nextOffset,
      exhausted: page.exhausted,
      degradedToAllPaging: current.degradedToAllPaging || page.degradedToAllPaging,
    };
    pagesRef.current = next;
    loadingOffsetRef.current = null;
    setPages(next);
    setLoadingOffset(null);
    setLoadMoreError(null);
    const currentCursors = loadedPageCursorsRef.current;
    const nextCursors = currentCursors.includes(loadingOffset)
      ? currentCursors
      : [...currentCursors, loadingOffset];
    const currentProjectRef = {
      environmentId: projectEnvironmentId,
      projectId,
    } as ScopedProjectRef;
    setLoadedPageCursors(currentProjectRef, nextCursors);
    setLoadedPageCount(currentProjectRef, nextCursors.length);
  }, [
    commitLookup,
    loadedPageCursorSignature,
    loadingOffset,
    nextPageSignature,
    projectEnvironmentId,
    projectId,
    setLoadedPageCount,
    setLoadedPageCursors,
  ]);

  useEffect(() => {
    if (loadingOffset === null || nextPageQuery.error === null) return;
    loadingOffsetRef.current = null;
    setLoadingOffset(null);
    if (nextPageTipsUnresolvable) {
      explicitRefreshRef.current = true;
      const reset = emptyHistoryPages();
      pagesRef.current = reset;
      setPages(reset);
      const currentProjectRef = {
        environmentId: projectEnvironmentId,
        projectId,
      } as ScopedProjectRef;
      setLoadedPageCursors(currentProjectRef, []);
      setLoadedPageCount(currentProjectRef, 0);
      setRefreshEpoch((epoch) => epoch + 1);
      firstPageQuery.refresh();
      return;
    }
    setLoadMoreError(nextPageQuery.error);
  }, [
    firstPageQuery.refresh,
    loadingOffset,
    nextPageQuery.error,
    nextPageTipsUnresolvable,
    projectEnvironmentId,
    projectId,
    setLoadedPageCount,
    setLoadedPageCursors,
  ]);

  useEffect(() => {
    const nextOffset = pages.nextOffset;
    if (
      nextOffset === null ||
      pages.exhausted ||
      loadingOffset !== null ||
      !loadedPageCursorsRef.current.includes(nextOffset)
    ) {
      return;
    }
    loadingOffsetRef.current = nextOffset;
    setLoadingOffset(nextOffset);
  }, [loadedPageCursorSignature, loadingOffset, pages.exhausted, pages.nextOffset]);

  const selectedSha = selectedCommitSha ?? scrollAnchor;
  const selectedCommit =
    (selectedSha === null ? null : commitLookup.get(selectedSha)) ??
    pages.commits.find((commit) => commit.sha === selectedSha) ??
    pages.commits[0] ??
    null;
  const effectiveSelectedSha = selectedCommit?.sha ?? null;
  const effectiveSelectedFilePath =
    selectedCommit === null
      ? null
      : selectedFilePath !== null && selectedCommit.changedFiles.includes(selectedFilePath)
        ? selectedFilePath
        : (selectedCommit.changedFiles[0] ?? null);

  const handleSelectCommit = useCallback(
    (sha: string) => {
      const commit = commitLookup.get(sha);
      const currentProjectRef = {
        environmentId: projectEnvironmentId,
        projectId,
      } as ScopedProjectRef;
      setSelectedCommit(currentProjectRef, sha);
      setSelectedFile(currentProjectRef, commit?.changedFiles[0] ?? null);
      setScrollAnchor(currentProjectRef, sha);
    },
    [
      commitLookup,
      projectEnvironmentId,
      projectId,
      setScrollAnchor,
      setSelectedCommit,
      setSelectedFile,
    ],
  );
  const handleSelectFile = useCallback(
    (path: string) =>
      setSelectedFile({ environmentId: projectEnvironmentId, projectId } as ScopedProjectRef, path),
    [projectEnvironmentId, projectId, setSelectedFile],
  );
  const handleReachEnd = useCallback(() => {
    const current = pagesRef.current;
    if (loadingOffsetRef.current !== null || current.exhausted || current.nextOffset === null) {
      return;
    }
    setLoadMoreError(null);
    loadingOffsetRef.current = current.nextOffset;
    setLoadingOffset(current.nextOffset);
  }, []);
  const handleRefresh = useCallback(() => {
    explicitRefreshRef.current = true;
    commitLookup.clear();
    const reset = emptyHistoryPages();
    pagesRef.current = reset;
    loadingOffsetRef.current = null;
    processedNextPageSignatureRef.current = null;
    setPages(reset);
    setLoadingOffset(null);
    setLoadMoreError(null);
    const currentProjectRef = {
      environmentId: projectEnvironmentId,
      projectId,
    } as ScopedProjectRef;
    setSelectedCommit(currentProjectRef, null);
    setSelectedFile(currentProjectRef, null);
    setScrollAnchor(currentProjectRef, null);
    setLoadedPageCursors(currentProjectRef, []);
    setLoadedPageCount(currentProjectRef, 0);
    setRefreshEpoch((epoch) => epoch + 1);
    firstPageQuery.refresh();
  }, [
    commitLookup,
    firstPageQuery.refresh,
    projectEnvironmentId,
    projectId,
    setLoadedPageCount,
    setLoadedPageCursors,
    setScrollAnchor,
    setSelectedCommit,
    setSelectedFile,
  ]);

  if (firstPageQuery.isPending && pages.commits.length === 0) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading commit history…
      </p>
    );
  }
  if (firstPageQuery.error !== null && pages.commits.length === 0) {
    return (
      <div className="space-y-2 p-4">
        <p className="text-sm text-destructive">{firstPageQuery.error}</p>
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          onClick={handleRefresh}
        >
          Retry history
        </button>
      </div>
    );
  }

  return (
    <section aria-label="Repository history" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <h1 className="text-balance text-xs font-semibold">History</h1>
          <p className="text-[10px] text-muted-foreground tabular-nums">
            {pages.commits.length} commit{pages.commits.length === 1 ? "" : "s"} loaded
          </p>
        </div>
        <button
          type="button"
          aria-label="Refresh history"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={handleRefresh}
        >
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {pages.degradedToAllPaging ? (
        <p
          role="status"
          className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs"
        >
          History may shift while new commits arrive because this repository exceeds the pinned-tip
          limit.
        </p>
      ) : null}
      {loadMoreError !== null ? (
        <p
          role="status"
          className="shrink-0 border-b border-destructive/30 px-3 py-2 text-xs text-destructive"
        >
          {loadMoreError}
        </p>
      ) : null}
      {pages.commits.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">This repository has no commits yet.</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,34%)_minmax(0,1fr)] overflow-hidden rounded-lg border border-border/70">
          <GitManagerCommitList
            commits={pages.commits}
            selectedSha={effectiveSelectedSha}
            onSelect={handleSelectCommit}
            onReachEnd={handleReachEnd}
            isLoadingMore={loadingOffset !== null}
          />
          {selectedCommit === null ? (
            <p className="p-4 text-sm text-muted-foreground">Select a commit to inspect it.</p>
          ) : (
            <GitManagerCommitDetail
              environmentId={environmentId}
              cwd={cwd}
              commit={selectedCommit}
              selectedFilePath={effectiveSelectedFilePath}
              onSelectFile={handleSelectFile}
            />
          )}
        </div>
      )}
    </section>
  );
});
