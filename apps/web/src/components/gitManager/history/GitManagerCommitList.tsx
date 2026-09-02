import type { GitManagerCommitEntry } from "@bibcode/contracts";
import { LegendList, type LegendListRef, type OnViewableItemsChanged } from "@legendapp/list/react";
import { memo, useCallback, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "../../../lib/utils";
import {
  GitManagerCommitDndContext,
  GitManagerCommitInsertionTarget,
  type GitManagerCommitDropResolution,
  useGitManagerCommitDragSource,
} from "../rewrite/gitManagerCommitDrag";
import { deriveAuthorIdentity } from "./authorIdentity";
import { shouldLoadNextPage } from "./commitPaging";

const COMMIT_ROW_HEIGHT = 50;
const getCommitRowSize = () => COMMIT_ROW_HEIGHT;
const getCommitKey = (commit: GitManagerCommitEntry) => commit.sha;
const MAINTAIN_VISIBLE_COMMIT_POSITION = Object.freeze({ data: true });
const commitDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
});

export interface GitManagerCommitListProps {
  readonly commits: ReadonlyArray<GitManagerCommitEntry>;
  readonly selectedSha: string | null;
  readonly onSelect: (sha: string) => void;
  readonly onReachEnd: () => void;
  readonly isLoadingMore: boolean;
  readonly onContextMenu?: (sha: string, event: MouseEvent<HTMLButtonElement>) => void;
  readonly multiCommitSelection?: ReadonlyArray<string>;
  readonly onMultiSelect?: (sha: string, mode: "range" | "toggle") => void;
  readonly onCommitDrop?: (resolution: GitManagerCommitDropResolution) => void;
  readonly rewriteDisabledReason?: string | null;
}

interface GitManagerCommitRowProps {
  readonly commit: GitManagerCommitEntry;
  readonly selected: boolean;
  readonly tabbable: boolean;
  readonly onSelect: (sha: string) => void;
  readonly onContextMenu?: (sha: string, event: MouseEvent<HTMLButtonElement>) => void;
  readonly onMultiSelect?: (sha: string, mode: "range" | "toggle") => void;
  readonly rewriteDisabledReason: string | null;
}

function commitRowPropsEqual(
  previous: GitManagerCommitRowProps,
  next: GitManagerCommitRowProps,
): boolean {
  return (
    previous.commit.sha === next.commit.sha &&
    previous.commit.shortSha === next.commit.shortSha &&
    previous.commit.subject === next.commit.subject &&
    previous.commit.authorName === next.commit.authorName &&
    previous.commit.authorEmail === next.commit.authorEmail &&
    previous.commit.committedAtMs === next.commit.committedAtMs &&
    previous.commit.decorations[0] === next.commit.decorations[0] &&
    previous.selected === next.selected &&
    previous.tabbable === next.tabbable &&
    previous.onSelect === next.onSelect &&
    previous.onContextMenu === next.onContextMenu &&
    previous.onMultiSelect === next.onMultiSelect &&
    previous.rewriteDisabledReason === next.rewriteDisabledReason
  );
}

const GitManagerCommitRow = memo(function GitManagerCommitRow({
  commit,
  selected,
  tabbable,
  onSelect,
  onContextMenu,
  onMultiSelect,
  rewriteDisabledReason,
}: GitManagerCommitRowProps) {
  const author = deriveAuthorIdentity({ name: commit.authorName, email: commit.authorEmail });
  const drag = useGitManagerCommitDragSource(commit.sha, rewriteDisabledReason !== null);
  const select = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (event.shiftKey && onMultiSelect !== undefined) {
        onMultiSelect(commit.sha, "range");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && onMultiSelect !== undefined) {
        onMultiSelect(commit.sha, "toggle");
        return;
      }
      onSelect(commit.sha);
    },
    [commit.sha, onMultiSelect, onSelect],
  );
  return (
    <button
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      type="button"
      aria-describedby={
        rewriteDisabledReason === null ? undefined : "git-manager-history-rewrite-disabled-reason"
      }
      aria-label={`${commit.shortSha} ${commit.subject}`}
      aria-selected={selected}
      className={cn(
        "flex h-[50px] w-full min-w-0 touch-manipulation items-center gap-2 border-b border-border/60 px-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/45",
        drag.isDragging && "select-none opacity-40",
      )}
      data-commit-drag-source={rewriteDisabledReason === null ? commit.sha : undefined}
      data-commit-sha={commit.sha}
      role="option"
      style={{ transform: drag.transform }}
      tabIndex={tabbable ? 0 : -1}
      title={rewriteDisabledReason ?? undefined}
      onClick={select}
      onContextMenu={(event) => onContextMenu?.(commit.sha, event)}
    >
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: `hsl(${author.hue} 55% 42%)` }}
      >
        {author.initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">
          {commit.subject || "(no subject)"}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground" title={author.title}>
          {commit.authorName.trim() || commit.authorEmail.trim() || "Unknown author"} ·{" "}
          {commitDateFormatter.format(commit.committedAtMs)}
        </span>
      </span>
      {commit.decorations[0] ? (
        <span
          className="max-w-24 shrink-0 truncate rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground"
          translate="no"
        >
          {commit.decorations[0]}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground" translate="no">
        {commit.shortSha}
      </span>
    </button>
  );
}, commitRowPropsEqual);

export const GitManagerCommitList = memo(function GitManagerCommitList({
  commits,
  selectedSha,
  onSelect,
  onReachEnd,
  isLoadingMore,
  onContextMenu,
  multiCommitSelection,
  onMultiSelect,
  onCommitDrop,
  rewriteDisabledReason = null,
}: GitManagerCommitListProps) {
  const listRef = useRef<LegendListRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const commitsRef = useRef(commits);
  const onSelectRef = useRef(onSelect);
  const onReachEndRef = useRef(onReachEnd);
  const isLoadingMoreRef = useRef(isLoadingMore);
  const lastRequestAtMsRef = useRef(Number.NEGATIVE_INFINITY);
  commitsRef.current = commits;
  onSelectRef.current = onSelect;
  onReachEndRef.current = onReachEnd;
  isLoadingMoreRef.current = isLoadingMore;
  const commitShas = useMemo(() => commits.map((commit) => commit.sha), [commits]);

  const renderCommit = useCallback(
    ({ item, index }: { item: GitManagerCommitEntry; index: number }) => (
      <div className="relative h-[50px]" data-commit-list-item={item.sha}>
        <GitManagerCommitInsertionTarget beforeSha={item.sha} />
        <GitManagerCommitRow
          commit={item}
          selected={item.sha === selectedSha || multiCommitSelection?.includes(item.sha) === true}
          tabbable={item.sha === selectedSha || (selectedSha === null && index === 0)}
          onSelect={onSelect}
          rewriteDisabledReason={rewriteDisabledReason}
          {...(onContextMenu === undefined ? {} : { onContextMenu })}
          {...(onMultiSelect === undefined ? {} : { onMultiSelect })}
        />
      </div>
    ),
    [
      multiCommitSelection,
      onContextMenu,
      onMultiSelect,
      onSelect,
      rewriteDisabledReason,
      selectedSha,
    ],
  );
  const initialScrollIndex = Math.max(
    0,
    commits.findIndex((commit) => commit.sha === selectedSha),
  );

  const handleViewableItemsChanged = useCallback<
    NonNullable<OnViewableItemsChanged<GitManagerCommitEntry>>
  >(({ end }) => {
    const nowMs = Date.now();
    if (
      shouldLoadNextPage({
        renderedIndex: end,
        totalRows: commitsRef.current.length,
        isLoading: isLoadingMoreRef.current,
        lastRequestAtMs: lastRequestAtMsRef.current,
        nowMs,
      })
    ) {
      lastRequestAtMsRef.current = nowMs;
      onReachEndRef.current();
    }
  }, []);

  const focusCommit = useCallback((sha: string) => {
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>("[data-commit-sha]");
    for (const button of buttons ?? []) {
      if (button.dataset.commitSha === sha) {
        button.focus();
        break;
      }
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-commit-sha]");
      const currentSha = button?.dataset.commitSha;
      if (!currentSha) return;
      const currentIndex = commitsRef.current.findIndex((commit) => commit.sha === currentSha);
      const nextIndex = currentIndex + (event.key === "ArrowDown" ? 1 : -1);
      const nextCommit = commitsRef.current[nextIndex];
      if (!nextCommit) return;

      event.preventDefault();
      onSelectRef.current(nextCommit.sha);
      const scroll = listRef.current?.scrollToIndex({
        index: nextIndex,
        animated: false,
        viewPosition: 0.5,
      });
      void Promise.resolve(scroll).then(
        () => focusCommit(nextCommit.sha),
        () => undefined,
      );
    },
    [focusCommit],
  );

  return (
    <div
      ref={containerRef}
      aria-label="Commit history"
      aria-multiselectable={onMultiSelect === undefined ? undefined : true}
      role="listbox"
      className="flex min-h-0 flex-1 flex-col overflow-hidden border-r border-panel-separator"
      onKeyDown={handleKeyDown}
    >
      <GitManagerCommitDndContext
        commitShas={commitShas}
        {...(multiCommitSelection === undefined ? {} : { multiCommitSelection })}
        {...(onCommitDrop === undefined || rewriteDisabledReason !== null ? {} : { onCommitDrop })}
      >
        <LegendList<GitManagerCommitEntry>
          ref={listRef}
          className="min-h-0 flex-1 overflow-x-hidden overscroll-y-contain"
          data={commits}
          estimatedItemSize={COMMIT_ROW_HEIGHT}
          getFixedItemSize={getCommitRowSize}
          initialScrollIndex={initialScrollIndex}
          keyExtractor={getCommitKey}
          maintainVisibleContentPosition={MAINTAIN_VISIBLE_COMMIT_POSITION}
          renderItem={renderCommit}
          onViewableItemsChanged={handleViewableItemsChanged}
        />
      </GitManagerCommitDndContext>
      {rewriteDisabledReason === null ? null : (
        <span className="sr-only" id="git-manager-history-rewrite-disabled-reason">
          {rewriteDisabledReason}
        </span>
      )}
      {isLoadingMore ? (
        <p aria-live="polite" className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
          Loading more commits…
        </p>
      ) : null}
    </div>
  );
});
