import type { FileDiffMetadata } from "@pierre/diffs";
import {
  DIFF_CONTEXT_LINES_MAX,
  type DiffCompareLines,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@bibcode/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import { type DraftId } from "~/composerDraftStore";
import {
  selectThreadCompareFile,
  selectThreadCompareFilters,
  useDiffPanelStore,
} from "~/diffPanelStore";
import {
  buildDiffFileRows,
  describeCompareNotice,
  describePatchOnlyReason,
  describeUnavailableVersion,
  filterDiffFileRows,
  hydrateCompareFile,
  listChangeTargets,
  planCompareFile,
  resolveCompareVersions,
  type DiffCompareScope,
  type DiffFileFilters,
  type DiffFileRow,
} from "~/lib/diffCompareModel";
import { resolveFileDiffPath } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AnnotatableCodeView,
  type AnnotatableCodeViewHandle,
  type AnnotatableCodeViewProps,
} from "./AnnotatableCodeView";
import { DiffFileFilterControls, DiffFileList, DiffFilePicker } from "./DiffFileList";
import { useCommentDraftStore } from "./useCommentDraftStore";

export interface DiffCompareViewProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly scope: DiffCompareScope;
  /** The default patch's files, sorted as Changes shows them. */
  readonly files: ReadonlyArray<FileDiffMetadata>;
  /**
   * The server computes turn patches live from checkpoints, so a turn patch with short IDs is
   * one it stored before checkpoints kept full files.
   */
  readonly liveTurnPatches: boolean;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** Theme, wrap and styling shared with Changes; Compare always shows the split style. */
  readonly options: AnnotatableCodeViewProps["options"];
  /** Asks for the patch again, as the panel's refresh does. */
  readonly onRevalidatePatch: () => void;
  readonly lineFilter: CompareLineFilter;
  /** Actions on the selected file, at the end of its pane header, such as **Open with**. */
  readonly renderFileActions?: (row: DiffFileRow) => ReactNode;
}

/** **All lines** or **Changes only**, with the context count the second one asks Git for. */
export interface CompareLineFilter {
  readonly lines: DiffCompareLines;
  readonly contextLines: number;
  /** The patch with `contextLines`, parsed; null for All lines and until it loads. */
  readonly contextFiles: ReadonlyArray<FileDiffMetadata> | null;
  readonly contextPending: boolean;
  /** Why the count cannot change for this patch, shown beside the disabled field; else null. */
  readonly contextUnavailableReason: string | null;
  readonly onLinesChange: (lines: DiffCompareLines) => void;
  readonly onContextLinesChange: (contextLines: number) => void;
}

/**
 * The Diff panel's Compare view: a file list on the left, and the selected file's previous and
 * current versions side by side on the right, filled from both full files when they load.
 */
export function DiffCompareView(props: DiffCompareViewProps) {
  const { threadRef } = props;
  const storedPath = useDiffPanelStore((state) =>
    selectThreadCompareFile(state.compareFileByThreadKey, threadRef),
  );
  const filters = useDiffPanelStore((state) =>
    selectThreadCompareFilters(state.compareFiltersByThreadKey, threadRef),
  );
  const rows = useMemo(() => buildDiffFileRows(props.files), [props.files]);
  // Typing in the name filter stays responsive while a long list re-filters behind it.
  const deferredQuery = useDeferredValue(filters.query);
  const visibleRows = useMemo(
    () => filterDiffFileRows(rows, { status: filters.status, query: deferredQuery }),
    [deferredQuery, filters.status, rows],
  );
  const selectedRow = visibleRows.find((row) => row.path === storedPath) ?? visibleRows[0] ?? null;

  const selectRow = useCallback(
    (row: DiffFileRow) => useDiffPanelStore.getState().selectCompareFile(threadRef, row.path),
    [threadRef],
  );
  const setFilters = useCallback(
    (next: DiffFileFilters) => useDiffPanelStore.getState().setCompareFilters(threadRef, next),
    [threadRef],
  );

  // Below 640 px the list column would squeeze the two versions, so it becomes a picker.
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setNarrow(width > 0 && width < NARROW_COMPARE_WIDTH);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // F7 and Shift+F7 by default, while focus is anywhere in Compare: the list or the diff.
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const paneRef = useRef<ComparePaneHandle>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const command = resolveShortcutCommand(event, keybindings, { context: DIFF_FOCUS_CONTEXT });
    if (command !== "diff.nextChange" && command !== "diff.previousChange") return;
    event.preventDefault();
    paneRef.current?.goToChange(command === "diff.nextChange" ? 1 : -1);
  };

  return (
    <div
      ref={rootRef}
      className={cn("flex min-h-0 min-w-0 flex-1", narrow && "flex-col")}
      onKeyDown={onKeyDown}
    >
      {narrow ? (
        <>
          <DiffFileFilterControls
            filters={filters}
            totalCount={rows.length}
            visibleCount={visibleRows.length}
            onFiltersChange={setFilters}
          />
          <DiffFilePicker
            rows={visibleRows}
            selectedKey={selectedRow?.key ?? null}
            onSelect={selectRow}
          />
        </>
      ) : (
        <DiffFileList
          className="w-60 shrink-0 border-r border-border"
          filters={filters}
          rows={visibleRows}
          selectedKey={selectedRow?.key ?? null}
          totalCount={rows.length}
          visibleCount={visibleRows.length}
          onFiltersChange={setFilters}
          onSelect={selectRow}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedRow ? (
          // Keyed by path: a refreshed patch keeps the pane, and what it learned about the file.
          <DiffComparePane
            key={selectedRow.path}
            {...props}
            keybindings={keybindings}
            paneRef={paneRef}
            row={selectedRow}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-3 text-xs text-muted-foreground">
            No file selected.
          </div>
        )}
      </div>
    </div>
  );
}

const NARROW_COMPARE_WIDTH = 640;

const DIFF_FOCUS_CONTEXT = {
  diffFocus: true,
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
} as const;

/** Moves the diff to the next (+1) or previous (-1) block of changes. */
interface ComparePaneHandle {
  goToChange: (direction: 1 | -1) => void;
}

interface DiffComparePaneProps extends DiffCompareViewProps {
  readonly row: DiffFileRow;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly paneRef: Ref<ComparePaneHandle>;
}

/** The patch was asked for again because the working file had moved past `forOid`. */
interface Revalidation {
  readonly forOid: string | null;
  /** Counts requests, so each one asks for the patch exactly once. */
  readonly request: number;
}

const NO_REVALIDATION: Revalidation = { forOid: null, request: 0 };

function DiffComparePane({
  environmentId,
  cwd,
  scope,
  liveTurnPatches,
  row,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  onRevalidatePatch,
  lineFilter,
  keybindings,
  paneRef,
  threadRef,
  renderFileActions,
}: DiffComparePaneProps) {
  const plan = planCompareFile(row, scope, { liveTurnPatches });
  const commentDraftStore = useCommentDraftStore(threadRef, sectionId);
  const versionTarget = (version: "old" | "new") =>
    plan.kind === "versions"
      ? reviewEnvironment.fileVersion({
          environmentId,
          input: { cwd, version: plan[version] },
        })
      : null;
  const oldVersion = useEnvironmentQuery(versionTarget("old"));
  const newVersion = useEnvironmentQuery(versionTarget("new"));
  const versions = useMemo(
    () => resolveCompareVersions(oldVersion.data, newVersion.data),
    [newVersion.data, oldVersion.data],
  );
  const versionError = oldVersion.error ?? newVersion.error;
  const changedOid =
    versions.kind === "unavailable" &&
    versions.reason === "changed" &&
    plan.kind === "versions" &&
    plan.new._tag === "worktree"
      ? plan.new.expectedOid
      : null;
  const changed = changedOid !== null;

  // A working file that moved past the patch asks for the patch once: the new patch names a new
  // object ID, which is a new read. Only when that read is `changed` too does the pane say the
  // file is changing, so an agent that keeps writing never causes a loop.
  const [revalidation, setRevalidation] = useState<Revalidation>(NO_REVALIDATION);
  if (changedOid !== null && revalidation.forOid === null) {
    setRevalidation({ forOid: changedOid, request: revalidation.request + 1 });
  }
  const stillChanging =
    changedOid !== null && revalidation.forOid !== null && changedOid !== revalidation.forOid;
  const revalidatePatch = useEffectEvent(onRevalidatePatch);
  useEffect(() => {
    if (revalidation.request > 0) revalidatePatch();
  }, [revalidation.request]);

  // A refreshed patch parses into new objects even when this file did not change. Keep the
  // metadata while its versions and hunks stay the same, so the file hydrates once per version
  // pair and the view does not redraw.
  const identity = compareFileIdentity(row);
  const [pinned, setPinned] = useState({ identity, fileDiff: row.fileDiff });
  if (pinned.identity !== identity) setPinned({ identity, fileDiff: row.fileDiff });
  const baseFile = pinned.identity === identity ? pinned.fileDiff : row.fileDiff;
  // Changes only shows the patch Git printed with the chosen context count; All lines, and a
  // context patch still on its way, show the default patch. Both name the same versions.
  const contextFile =
    lineFilter.lines === "changes"
      ? (lineFilter.contextFiles?.find((file) => resolveFileDiffPath(file) === row.path) ?? null)
      : null;
  const patchFile = contextFile ?? baseFile;
  const hydration = useMemo(
    () =>
      versions.kind === "ready" ? hydrateCompareFile(patchFile, versions.old, versions.new) : null,
    [patchFile, versions],
  );
  const shownFile = hydration?.kind === "hydrated" ? hydration.fileDiff : patchFile;

  let note: string | null = null;
  if (plan.kind === "patch") {
    note = describePatchOnlyReason(plan.reason);
  } else if (plan.kind === "versions") {
    if (versionError) note = `Couldn't load the full file. Showing changed lines. ${versionError}`;
    else if (versions.kind === "unavailable" && !changed)
      note = describeUnavailableVersion(versions);
    else if (hydration?.kind === "mismatch") {
      note = "Showing changed lines. Git transforms this file's diff.";
    }
  }
  const loading =
    plan.kind === "versions" &&
    versionError === null &&
    (versions.kind === "loading" || (changed && !stillChanging));
  // Where Next and Previous change go: the first line of each block of changes. The pane
  // remounts per file, so the position starts before the first change of each.
  const changeTargets = useMemo(() => listChangeTargets(shownFile), [shownFile]);
  const [changeIndex, setChangeIndex] = useState(-1);
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);
  const goToChange = (direction: 1 | -1) => {
    const next = changeIndex + direction;
    const target = changeTargets[next];
    if (!target) return;
    setChangeIndex(next);
    codeViewRef.current?.scrollTo({
      type: "line",
      id: row.path,
      lineNumber: target.lineNumber,
      side: target.side,
      align: "center",
    });
  };
  useImperativeHandle(paneRef, () => ({ goToChange }));
  const nextLabel = shortcutLabelForCommand(keybindings, "diff.nextChange", {
    context: DIFF_FOCUS_CONTEXT,
  });
  const previousLabel = shortcutLabelForCommand(keybindings, "diff.previousChange", {
    context: DIFF_FOCUS_CONTEXT,
  });

  // Keyed by path, which a refreshed patch keeps; the patch's own key changes with any file.
  const files = useMemo(
    () => [
      {
        fileDiff: shownFile,
        filePath: row.path,
        fileKey: row.path,
        collapsed: false,
        // Comments index the default patch's hunks, whatever the context count.
        commentFileDiff: baseFile,
      },
    ],
    [baseFile, row.path, shownFile],
  );

  return (
    <>
      <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={row.path}>
          {row.previousPath ? `${row.previousPath} → ${row.path}` : row.path}
        </span>
        {loading ? (
          <span className="shrink-0 text-xs text-muted-foreground" role="status">
            Loading full file…
          </span>
        ) : lineFilter.lines === "changes" && lineFilter.contextPending ? (
          <span className="shrink-0 text-xs text-muted-foreground" role="status">
            Loading changes…
          </span>
        ) : null}
        {plan.kind === "notice" ? null : (
          <>
            <ChangeNavigationButton
              disabled={changeIndex <= 0}
              label="Previous change"
              shortcut={previousLabel}
              onClick={() => goToChange(-1)}
            >
              <ChevronUpIcon aria-hidden="true" className="size-3.5" />
            </ChangeNavigationButton>
            <ChangeNavigationButton
              disabled={changeIndex >= changeTargets.length - 1}
              label="Next change"
              shortcut={nextLabel}
              onClick={() => goToChange(1)}
            >
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            </ChangeNavigationButton>
          </>
        )}
        {renderFileActions?.(row)}
      </div>
      {plan.kind === "notice" ? null : <CompareLineControls lineFilter={lineFilter} />}
      {plan.kind === "notice" ? (
        <CompareMessage>{describeCompareNotice(plan.notice)}</CompareMessage>
      ) : stillChanging ? (
        <CompareMessage>
          <span>This file is changing.</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              setRevalidation({ forOid: changedOid, request: revalidation.request + 1 })
            }
          >
            Refresh
          </Button>
        </CompareMessage>
      ) : (
        <>
          {note ? (
            <p className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
              {note}
            </p>
          ) : null}
          <div className="min-h-0 flex-1" data-text-surface="card">
            <AnnotatableCodeView
              {...(commentDraftStore ? { draftStore: commentDraftStore } : {})}
              className="diff-render-surface h-full min-h-0 overflow-auto"
              composerDraftTarget={composerDraftTarget}
              files={files}
              renderHeaderPrefix={() => null}
              sectionId={sectionId}
              sectionTitle={sectionTitle}
              viewerRef={codeViewRef}
              options={{
                ...options,
                diffStyle: "split",
                disableFileHeader: true,
                expandUnchanged: lineFilter.lines === "all" && hydration?.kind === "hydrated",
              }}
            />
          </div>
        </>
      )}
    </>
  );
}

/**
 * Previous or Next change. At either end it stays focusable, so its tooltip can say why it does
 * nothing, instead of turning into a control that cannot explain itself.
 */
function ChangeNavigationButton({
  disabled,
  label,
  shortcut,
  onClick,
  children,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly shortcut: string | null;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-disabled={disabled}
            aria-label={label}
            className={cn("shrink-0", disabled && "opacity-64")}
            size="icon-xs"
            variant="ghost"
            onClick={() => {
              if (!disabled) onClick();
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {disabled ? "No more changes." : shortcut ? `${label} (${shortcut})` : label}
      </TooltipPopup>
    </Tooltip>
  );
}

function CompareLineControls({ lineFilter }: { readonly lineFilter: CompareLineFilter }) {
  const reasonId = useId();
  const unavailableReason =
    lineFilter.lines === "changes" ? lineFilter.contextUnavailableReason : null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1">
      <ToggleGroup
        aria-label="Lines"
        size="xs"
        value={[lineFilter.lines]}
        variant="outline"
        onValueChange={(value) => {
          const next = value[0];
          if ((next === "all" || next === "changes") && next !== lineFilter.lines) {
            lineFilter.onLinesChange(next);
          }
        }}
      >
        <Toggle className="px-2 text-xs" value="all">
          All lines
        </Toggle>
        <Toggle className="px-2 text-xs" value="changes">
          Changes only
        </Toggle>
      </ToggleGroup>
      {lineFilter.lines === "changes" ? (
        <ContextLinesField
          disabledReasonId={unavailableReason === null ? null : reasonId}
          value={lineFilter.contextLines}
          onCommit={lineFilter.onContextLinesChange}
        />
      ) : null}
      {unavailableReason !== null ? (
        <span className="text-xs text-muted-foreground" id={reasonId}>
          {unavailableReason}
        </span>
      ) : null}
    </div>
  );
}

const CONTEXT_COMMIT_DELAY_MS = 300;

/** A whole number from 0 to 99, or null for anything else (empty, negative, too large). */
export function parseContextLines(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value <= DIFF_CONTEXT_LINES_MAX ? value : null;
}

/**
 * The context count. Typing changes only the field; the count commits 300 ms after the last
 * keystroke, on Enter and on blur, so each committed value asks for one patch.
 */
function ContextLinesField({
  value,
  disabledReasonId,
  onCommit,
}: {
  readonly value: number;
  /** The visible reason the field is disabled, by element ID; null when it is enabled. */
  readonly disabledReasonId: string | null;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }
  const commit = useEffectEvent((text: string) => {
    const next = parseContextLines(text);
    if (next !== null && next !== value) onCommit(next);
  });
  useEffect(() => {
    if (draft === String(value)) return;
    const timer = window.setTimeout(() => commit(draft), CONTEXT_COMMIT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, value]);

  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      Context lines
      <input
        aria-describedby={disabledReasonId ?? undefined}
        className="h-6 w-12 rounded-md border border-input bg-background px-1.5 text-xs text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64"
        disabled={disabledReasonId !== null}
        inputMode="numeric"
        max={DIFF_CONTEXT_LINES_MAX}
        min={0}
        type="number"
        value={draft}
        onBlur={() => {
          if (parseContextLines(draft) === null) setDraft(String(value));
          else commit(draft);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(draft);
        }}
      />
    </label>
  );
}

/** The file's content identity: its path, object IDs and hunk ranges. */
function compareFileIdentity(row: DiffFileRow): string {
  const { fileDiff } = row;
  const hunks = fileDiff.hunks
    .map(
      (hunk) =>
        `${hunk.deletionStart},${hunk.deletionCount},${hunk.additionStart},${hunk.additionCount}`,
    )
    .join(";");
  return [row.path, fileDiff.prevObjectId ?? "", fileDiff.newObjectId ?? "", hunks].join("\0");
}

function CompareMessage({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
