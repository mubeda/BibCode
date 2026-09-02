import { projectKey } from "@bibcode/client-runtime/state/entities";
import type {
  ContextMenuItem,
  GitManagerBlockedReason,
  GitManagerCommitEntry,
  GitManagerCommitPage,
  ScopedProjectRef,
} from "@bibcode/contracts";
import { GitManagerOperationError } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { DEFAULT_GIT_MANAGER_VIEW_STATE, useGitManagerStore } from "../../../gitManagerStore";
import { readLocalApi } from "../../../localApi";
import { gitManagerEnvironment } from "../../../state/gitManager";
import { useEnvironmentQuery } from "../../../state/query";
import {
  buildCommitMenuItems,
  type GitManagerCommitMenuItemId,
} from "../rewrite/GitManagerCommitContextMenu.logic";
import type { GitManagerCommitDropResolution } from "../rewrite/gitManagerCommitDrag";
import { createCommitLookup, spliceCommitGeneration } from "./commitPaging";
import { GitManagerCommitDetail } from "./GitManagerCommitDetail";
import { GitManagerCommitList } from "./GitManagerCommitList";

const HISTORY_PAGE_SIZE = 100;
const COMMIT_LOOKUP_MAX_ENTRIES = 1_000;
const COMMIT_LOOKUP_MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const EMPTY_COMMITS: ReadonlyArray<GitManagerCommitEntry> = Object.freeze([]);
const EMPTY_TIPS: ReadonlyArray<string> = Object.freeze([]);
const isGitManagerOperationError = Schema.is(GitManagerOperationError);

export type GitManagerHistoryAction =
  | { readonly _tag: "reset"; readonly sha: string }
  | { readonly _tag: "revert"; readonly sha: string }
  | { readonly _tag: "cherry-pick"; readonly shas: ReadonlyArray<string> }
  | {
      readonly _tag: "squash";
      readonly shas: ReadonlyArray<string>;
      readonly message: string;
    }
  | {
      readonly _tag: "reorder";
      readonly shas: ReadonlyArray<string>;
      readonly insertBeforeSha: string | null;
    }
  | { readonly _tag: "prepare-reorder"; readonly shas: ReadonlyArray<string> }
  | { readonly _tag: "create-branch"; readonly sha: string }
  | { readonly _tag: "create-tag"; readonly sha: string };

interface GitManagerHistoryViewProps {
  readonly scope: {
    readonly environmentId: ScopedProjectRef["environmentId"];
    readonly cwd: string;
  };
  readonly projectRef: ScopedProjectRef;
  readonly blockedReasons: ReadonlyArray<GitManagerBlockedReason>;
  readonly branchSyncDisabledReason: string | null;
  readonly rewriteDisabledReason: string | null;
  readonly tagDisabledReason: string | null;
  /**
   * The repository generation the panel's refs snapshot last observed. The
   * history page shares that counter, so a generation ahead of the loaded page
   * means a commit landed (app-authored or external) and the first page must be
   * refreshed and spliced.
   */
  readonly repositoryGeneration: number | null;
  readonly onAction: (action: GitManagerHistoryAction) => void;
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
  blockedReasons,
  branchSyncDisabledReason,
  rewriteDisabledReason,
  tagDisabledReason,
  repositoryGeneration,
  onAction,
}: GitManagerHistoryViewProps) {
  const { environmentId, cwd } = scope;
  const projectEnvironmentId = projectRef.environmentId;
  const projectId = projectRef.projectId;
  const storeKey = projectKey(projectRef);
  const [pages, setPages] = useState<HistoryPagesState>(emptyHistoryPages);
  const [loadingOffset, setLoadingOffset] = useState<number | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const pagesRef = useRef(pages);
  const loadingOffsetRef = useRef(loadingOffset);
  const firstPageRef = useRef<GitManagerCommitPage | null>(null);
  const nextPageRef = useRef<GitManagerCommitPage | null>(null);
  const processedNextPageSignatureRef = useRef<string | null>(null);
  const explicitRefreshRef = useRef(false);
  const requestedGenerationRef = useRef<number | null>(null);
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
  const selectMultiCommitSelection = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.multiCommitSelection ??
      DEFAULT_GIT_MANAGER_VIEW_STATE.multiCommitSelection,
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
  const multiCommitSelection = useGitManagerStore(selectMultiCommitSelection);
  const loadedPageCursors = useGitManagerStore(selectLoadedPageCursors);
  const scrollAnchor = useGitManagerStore(selectScrollAnchor);
  const setSelectedCommit = useGitManagerStore((state) => state.setSelectedCommit);
  const setSelectedFile = useGitManagerStore((state) => state.setSelectedFile);
  const setMultiCommitSelection = useGitManagerStore((state) => state.setMultiCommitSelection);
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

  const loadedGeneration = pages.generation;
  useEffect(() => {
    if (
      repositoryGeneration === null ||
      loadedGeneration === null ||
      repositoryGeneration <= loadedGeneration ||
      requestedGenerationRef.current === repositoryGeneration
    ) {
      return;
    }
    requestedGenerationRef.current = repositoryGeneration;
    firstPageQuery.refresh();
  }, [firstPageQuery.refresh, loadedGeneration, repositoryGeneration]);

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
    } else if (page.generation < current.generation) {
      // A first page that resolved behind the loaded generation is a stale
      // in-flight response (an older read completing after a newer one).
      // Record it as seen without letting it regress the tip or the counter;
      // the newer page already holds the post-mutation history.
      next = { ...current, processedFirstPageSignature: firstPageSignature };
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
      setMultiCommitSelection(currentProjectRef, []);
      setSelectedFile(currentProjectRef, commit?.changedFiles[0] ?? null);
      setScrollAnchor(currentProjectRef, sha);
    },
    [
      commitLookup,
      projectEnvironmentId,
      projectId,
      setScrollAnchor,
      setMultiCommitSelection,
      setSelectedCommit,
      setSelectedFile,
    ],
  );
  const handleMultiSelect = useCallback(
    (sha: string, mode: "range" | "toggle") => {
      const currentProjectRef = {
        environmentId: projectEnvironmentId,
        projectId,
      } as ScopedProjectRef;
      let nextSelection: ReadonlyArray<string>;
      if (mode === "toggle") {
        nextSelection = multiCommitSelection.includes(sha)
          ? multiCommitSelection.filter((selectedSha) => selectedSha !== sha)
          : [...multiCommitSelection, sha];
      } else {
        const anchorSha = selectedCommitSha ?? pagesRef.current.commits[0]?.sha ?? sha;
        const anchorIndex = pagesRef.current.commits.findIndex(
          (commit) => commit.sha === anchorSha,
        );
        const selectedIndex = pagesRef.current.commits.findIndex((commit) => commit.sha === sha);
        if (anchorIndex < 0 || selectedIndex < 0) {
          nextSelection = [sha];
        } else {
          const start = Math.min(anchorIndex, selectedIndex);
          const end = Math.max(anchorIndex, selectedIndex);
          nextSelection = pagesRef.current.commits
            .slice(start, end + 1)
            .map((commit) => commit.sha);
        }
      }
      setMultiCommitSelection(currentProjectRef, nextSelection);
      setSelectedCommit(currentProjectRef, sha);
      setScrollAnchor(currentProjectRef, sha);
    },
    [
      multiCommitSelection,
      projectEnvironmentId,
      projectId,
      selectedCommitSha,
      setMultiCommitSelection,
      setScrollAnchor,
      setSelectedCommit,
    ],
  );
  const orderedSelection = useCallback((shas: ReadonlyArray<string>): ReadonlyArray<string> => {
    const selected = new Set(shas);
    return pagesRef.current.commits.flatMap((commit) =>
      selected.has(commit.sha) ? [commit.sha] : [],
    );
  }, []);
  const squashMessage = useCallback((shas: ReadonlyArray<string>): string => {
    const selected = new Set(shas);
    const subjects = pagesRef.current.commits.flatMap((commit) => {
      const subject = commit.subject.trim();
      return selected.has(commit.sha) && subject.length > 0 ? [subject] : [];
    });
    return subjects.join("\n\n") || `Squash ${shas.length} commits`;
  }, []);
  const emitMenuAction = useCallback(
    (id: GitManagerCommitMenuItemId, selection: ReadonlyArray<string>) => {
      const sha = selection[0];
      if (sha === undefined) return;
      switch (id) {
        case "reset":
          onAction({ _tag: "reset", sha });
          return;
        case "revert":
          onAction({ _tag: "revert", sha });
          return;
        case "cherry-pick":
          onAction({ _tag: "cherry-pick", shas: selection });
          return;
        case "squash":
          onAction({ _tag: "squash", shas: selection, message: squashMessage(selection) });
          return;
        case "reorder":
          onAction({ _tag: "prepare-reorder", shas: selection });
          return;
        case "create-branch":
          onAction({ _tag: "create-branch", sha });
          return;
        case "create-tag":
          onAction({ _tag: "create-tag", sha });
          return;
        case "copy-sha": {
          const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
          if (clipboard?.writeText === undefined) {
            setActionError("Could not copy the commit SHA. Copy it from the commit details.");
            return;
          }
          void clipboard.writeText(selection.join("\n")).catch(() => {
            setActionError("Could not copy the commit SHA. Copy it from the commit details.");
          });
        }
      }
    },
    [onAction, squashMessage],
  );
  const handleContextMenu = useCallback(
    (sha: string, event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const selection = multiCommitSelection.includes(sha) ? multiCommitSelection : [sha];
      if (!multiCommitSelection.includes(sha)) {
        setMultiCommitSelection(projectRef, selection);
      }
      const api = readLocalApi();
      if (api === undefined) {
        setActionError("The commit action menu is unavailable. Try reopening Git Manager.");
        return;
      }
      setActionError(null);
      const items: ReadonlyArray<ContextMenuItem<GitManagerCommitMenuItemId>> =
        buildCommitMenuItems(selection, {
          loadedCommits: pagesRef.current.commits,
          blockedReasons,
          branchSyncDisabledReason,
          rewriteDisabledReason,
          tagDisabledReason,
        }).map((menuItem) => ({
          id: menuItem.id,
          label:
            menuItem.disabledReason === null
              ? menuItem.label
              : `${menuItem.label} — ${menuItem.disabledReason}`,
          disabled: !menuItem.enabled,
          destructive: menuItem.id === "reset",
        }));
      void api.contextMenu
        .show(items, { x: event.clientX, y: event.clientY })
        .then((action) => {
          if (action !== null) emitMenuAction(action, selection);
        })
        .catch(() => {
          setActionError("The commit action menu could not open. Try the action again.");
        });
    },
    [
      blockedReasons,
      branchSyncDisabledReason,
      emitMenuAction,
      multiCommitSelection,
      projectRef,
      rewriteDisabledReason,
      setMultiCommitSelection,
      tagDisabledReason,
    ],
  );
  const handleCommitDrop = useCallback(
    (resolution: GitManagerCommitDropResolution) => {
      setActionError(null);
      if (rewriteDisabledReason !== null) {
        setActionError(rewriteDisabledReason);
        return;
      }
      switch (resolution._tag) {
        case "blocked":
          setActionError(resolution.reason.message);
          return;
        case "cherry-pick":
          onAction({ _tag: "cherry-pick", shas: resolution.shas });
          return;
        case "reorder":
          onAction({
            _tag: "reorder",
            shas: resolution.shas,
            insertBeforeSha: resolution.insertBeforeSha,
          });
          return;
        case "squash": {
          const shas = orderedSelection([resolution.targetSha, ...resolution.shas]);
          onAction({ _tag: "squash", shas, message: squashMessage(shas) });
        }
      }
    },
    [onAction, orderedSelection, rewriteDisabledReason, squashMessage],
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
          <p className="text-xs text-muted-foreground tabular-nums">
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
      {actionError === null ? null : (
        <p
          aria-live="polite"
          className="shrink-0 border-b border-destructive/30 px-3 py-2 text-xs text-destructive"
        >
          {actionError}
        </p>
      )}
      {pages.commits.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">This repository has no commits yet.</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,34%)_minmax(0,1fr)] overflow-hidden rounded-lg border border-border/70">
          <GitManagerCommitList
            commits={pages.commits}
            rewriteDisabledReason={rewriteDisabledReason}
            selectedSha={effectiveSelectedSha}
            onSelect={handleSelectCommit}
            onReachEnd={handleReachEnd}
            isLoadingMore={loadingOffset !== null}
            multiCommitSelection={multiCommitSelection}
            onCommitDrop={handleCommitDrop}
            onContextMenu={handleContextMenu}
            onMultiSelect={handleMultiSelect}
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
