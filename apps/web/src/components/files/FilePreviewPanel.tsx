import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@bibcode/contracts";
import { VirtualizedFile, type SelectedLineRange } from "@pierre/diffs";
import {
  EditProvider,
  File,
  type FileOptions,
  Virtualizer,
  useWorkerPool,
} from "@pierre/diffs/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import { ChevronRight, FolderTree, Globe2, LoaderCircle } from "lucide-react";
import * as Schema from "effect/Schema";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import ChatMarkdown from "~/components/ChatMarkdown";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { canPreviewAnyUrlInRuntime } from "~/previewStateStore";
import { resolvePathLinkTarget } from "~/terminal-links";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { assetEnvironment } from "~/state/assets";
import {
  useEnvironmentConnectionState,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import FileBrowserPanel from "./FileBrowserPanel";
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import { FileDiskConflictBar, fileDiskConflictSaveReason } from "./FileDiskConflictBar";
import { FileDiskWatcher } from "./fileDiskWatcher";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { FileEditorToolbar } from "./FileEditorToolbar";
import { FileEditingSession, type FileEditingSessionSnapshot } from "./fileEditingSession";
import { FileEditingSessionRegistry } from "./fileEditingSessionRegistry";
import { LocalCommentAnnotation } from "./LocalCommentAnnotation";
import { projectFileCacheKey } from "./fileContentRevision";
import { fileBreadcrumbs } from "./filePath";
import { isMarkdownPreviewFile, setMarkdownTaskChecked } from "./filePreviewMode";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  rereadProjectFile,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  /** A file's edits conflict with a newer state on disk, or no longer do. */
  onConflictChange?: (relativePath: string, conflicted: boolean) => void;
  editingSessions: FileEditingSessionRegistry<FileEditingSession<FileCommentAnnotationGroup>>;
  workspaceUnavailable?: string | null;
  /** Changes when the thread's turn ends, which often means its agent edited files. */
  diskCheckSignal?: string | null;
}

const FILE_EXPLORER_STORAGE_KEY = "bibcode.fileExplorerOpen";
const FILE_SAVE_DEBOUNCE_MS = 500;
const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";
const UNAVAILABLE_SESSION_SNAPSHOT: FileEditingSessionSnapshot = {
  save: { phase: "clean", canSave: false, confirmedRevision: 0 },
  canUndo: false,
  canRedo: false,
  conflict: null,
  deletedOnDisk: false,
};

const subscribeUnavailable = (): (() => void) => () => {};
const readUnavailable = (): FileEditingSessionSnapshot => UNAVAILABLE_SESSION_SNAPSHOT;
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;
type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const [handledRequestIdsByPath] = useState(() => new Map<string, number>());
  const [latestRequestIdsByPath] = useState(() => new Map<string, number>());
  const [pendingFramesByPath] = useState(() => new Map<string, number>());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const cancelPendingReveal = () => {
        const frameId = pendingFramesByPath.get(relativePath);
        if (frameId !== undefined) {
          cancelAnimationFrame(frameId);
          pendingFramesByPath.delete(relativePath);
        }
      };

      if (phase === "unmount") {
        cancelPendingReveal();
        return;
      }

      const targetLine =
        revealLine === null ? null : clampFileLine(instance.file?.contents ?? "", revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (latestRequestIdsByPath.get(relativePath) !== revealRequestId) {
        cancelPendingReveal();
        latestRequestIdsByPath.set(relativePath, revealRequestId);
      }

      if (targetLine === null) {
        fileContainer.style.minHeight = "";
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight),
      )}px`;

      if (
        handledRequestIdsByPath.get(relativePath) === revealRequestId ||
        pendingFramesByPath.has(relativePath)
      ) {
        return;
      }

      const reveal = () => {
        pendingFramesByPath.delete(relativePath);
        if (
          latestRequestIdsByPath.get(relativePath) !== revealRequestId ||
          !fileContainer.isConnected
        ) {
          return;
        }

        const linePosition = instance.getLinePosition(targetLine);
        if (!linePosition) return;

        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainer.getBoundingClientRect().top;
        const centeredTop = Math.max(
          0,
          fileTop +
            linePosition.top -
            Math.max(0, (scrollContainer.clientHeight - linePosition.height) / 2),
        );
        const maxScrollTop = Math.max(
          0,
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
        );

        scrollContainer.scrollTop = Math.min(centeredTop, maxScrollTop);
        handledRequestIdsByPath.set(relativePath, revealRequestId);
      };

      pendingFramesByPath.set(relativePath, requestAnimationFrame(reveal));
    },
    [
      handledRequestIdsByPath,
      latestRequestIdsByPath,
      pendingFramesByPath,
      relativePath,
      revealLine,
      revealRequestId,
    ],
  );
}

interface EditableFileSurfaceProps {
  session: FileEditingSession<FileCommentAnnotationGroup>;
  composerDraftTarget: ScopedThreadRef | DraftId;
  contents: string;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  wordWrap: boolean;
  onPostRender: FilePostRender;
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

function useFileEditingSession({
  editingSessions,
  environmentId,
  cwd,
  relativePath,
  file,
  onPendingChange,
  onConflictChange,
  enabled,
}: {
  editingSessions: FilePreviewPanelProps["editingSessions"];
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string | null;
  file: ReturnType<typeof useProjectFileQuery>;
  onPendingChange: FilePreviewPanelProps["onPendingChange"];
  onConflictChange: FilePreviewPanelProps["onConflictChange"];
  enabled: boolean;
}): FileEditingSession<FileCommentAnnotationGroup> | null {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const writeFileIfUnchanged = useAtomCommand(projectEnvironment.writeFileIfUnchanged);
  return useMemo(() => {
    if (!enabled || !relativePath || !file.data) return null;
    // Only a server read (or a guarded save's committed version) says what is on disk and whether
    // the server guards saves: an optimistic draft has no version and would turn both off.
    const disk = file.disk;
    if (file.data.truncated || disk === null || disk.truncated) {
      // Nothing new starts here; a session that already holds the file's text keeps it. When
      // the file grew past the read limit, only a guarded session stays, so its edits and its
      // Overwrite disk choice remain on screen and an unguarded save cannot write old text.
      const existing = editingSessions.get(relativePath);
      if (existing === undefined || (file.data.truncated && !existing.watchesDisk)) return null;
      return editingSessions.getOrCreate(relativePath, () => existing);
    }
    const base = { version: disk.version, contents: disk.contents };
    return editingSessions.getOrCreate(
      relativePath,
      () =>
        new FileEditingSession<FileCommentAnnotationGroup>({
          cwd,
          relativePath,
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          base,
          // A server that returned no version has no guarded write either: save as before.
          persist: (savePath, contents, precondition) =>
            precondition === null
              ? writeFile({ environmentId, input: { cwd, relativePath: savePath, contents } })
              : writeFileIfUnchanged({
                  environmentId,
                  input: { cwd, relativePath: savePath, contents, precondition },
                }),
          onPendingChange: (savePath, pending) => onPendingChange(savePath, pending),
          onConfirmed: (savePath, contents, version) => {
            setProjectFileQueryData(environmentId, cwd, savePath, contents, version);
            confirmProjectFileQueryData(environmentId, cwd, savePath, contents);
          },
          onConflictChange: (savePath, conflicted) => onConflictChange?.(savePath, conflicted),
        }),
    );
  }, [
    cwd,
    editingSessions,
    enabled,
    environmentId,
    file.data,
    file.disk,
    onConflictChange,
    onPendingChange,
    relativePath,
    writeFile,
    writeFileIfUnchanged,
  ]);
}

/**
 * Watches the shown file's disk version while it is shown: a clean file reloads, an edited one
 * shows the conflict bar. Only the visible session is watched; a background one meets the disk
 * at its next save, which the server refuses if the file changed.
 */
function useFileDiskWatch({
  session,
  environmentId,
  cwd,
  diskCheckSignal,
}: {
  session: FileEditingSession<FileCommentAnnotationGroup> | null;
  environmentId: EnvironmentId;
  cwd: string;
  diskCheckSignal: string | null;
}): void {
  const getFileVersion = useAtomCommand(projectEnvironment.getFileVersion, {
    reportFailure: false,
  });
  const connection = useEnvironmentConnectionState(environmentId).data;
  // A new connection generation: the file may have changed while the environment was away.
  const reconnectSignal = connection?.phase === "connected" ? connection.generation : null;
  useEffect(() => {
    if (!session?.watchesDisk) return;
    const watcher = new FileDiskWatcher({
      session,
      getVersion: async (relativePath) => {
        const result = await getFileVersion({ environmentId, input: { cwd, relativePath } });
        return result._tag === "Success" ? result.value : null;
      },
      readFile: (relativePath) => rereadProjectFile(environmentId, cwd, relativePath),
    });
    watcher.start();
    return () => watcher.dispose();
  }, [cwd, environmentId, getFileVersion, session]);
  useEffect(() => {
    if (diskCheckSignal !== null || reconnectSignal !== null) session?.requestDiskCheck();
  }, [diskCheckSignal, reconnectSignal, session]);
}

/**
 * Wire an explicit Ctrl+S / Cmd+S save onto the file-surface container. The chord
 * flushes the pending debounced write immediately and always preventDefaults so
 * the browser's own save dialog can never open. The listener is scoped to the
 * container (capture phase, so it wins before the Pierre editor's own handlers)
 * and only fires while focus lives inside the surface.
 */
function useFileSaveShortcut(
  containerRef: RefObject<HTMLElement | null>,
  session: { flush(): Promise<unknown> } | null,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !session) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveChord =
        (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s";
      if (!isSaveChord) return;
      event.preventDefault();
      void session.flush();
    };
    container.addEventListener("keydown", handleKeyDown, true);
    return () => container.removeEventListener("keydown", handleKeyDown, true);
  }, [containerRef, session]);
}

/**
 * Drops the worker pool's highlighted lines for a session's `cacheKey` when its editable surface
 * goes away. Pierre caches those lines by `cacheKey` alone, and a highlight still in the worker
 * when the first edit lands is stored after the edit cleared the entry. The next surface for the
 * session would paint those pre-edit lines over the edited document, whose text and undo history
 * are intact. The cleanup runs before Pierre detaches the File, which cancels its pending
 * highlights, so no older text can be stored under the key afterwards.
 */
function useWorkerHighlightRelease(cacheKey: string): void {
  const workerPool = useWorkerPool();
  useLayoutEffect(() => {
    if (!workerPool) return;
    return () => {
      workerPool.evictFileFromCache(cacheKey);
    };
  }, [cacheKey, workerPool]);
}

function EditableFileSurface({
  session,
  composerDraftTarget,
  contents,
  resolvedTheme,
  revealRequestId,
  wordWrap,
  onPostRender,
}: EditableFileSurfaceProps) {
  const relativePath = session.relativePath;
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
    },
    [revealRequestId],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | null>(null);
  useFileSaveShortcut(surfaceRef, session);
  useWorkerHighlightRelease(session.cacheKey);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    // Composition events cross Pierre's shadow root; a disk reload waits for the IME to finish.
    const start = () => session.setComposing(true);
    const end = () => session.setComposing(false);
    surface.addEventListener("compositionstart", start);
    surface.addEventListener("compositionend", end);
    return () => {
      surface.removeEventListener("compositionstart", start);
      surface.removeEventListener("compositionend", end);
      session.setComposing(false);
    };
  }, [session]);
  useEffect(() => {
    session.setEditorChangeHandler((nextFile, nextLineAnnotations) => {
      if (!nextLineAnnotations) return;
      const remapped = remapFileCommentAnnotations(
        nextLineAnnotations as FileCommentLineAnnotation[],
      );
      setLineAnnotations(remapped);
      for (const annotation of remapped) {
        for (const entry of annotation.metadata.entries) {
          if (entry.kind !== "comment") continue;
          addReviewComment(
            composerDraftTarget,
            buildFileReviewComment({
              id: entry.id,
              filePath: session.relativePath,
              startLine: entry.startLine,
              endLine: entry.endLine,
              text: entry.text,
              contents: nextFile.contents,
            }),
          );
        }
      }
    });
    return () => session.setEditorChangeHandler(null);
  }, [addReviewComment, composerDraftTarget, session]);

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      removeReviewComment(composerDraftTarget, entryId);
      setLineAnnotations((current) => {
        return current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
      });
    },
    [composerDraftTarget, removeReviewComment, setSelectedRange],
  );

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) => {
      setSelectedRange(null);
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId);
      if (entry) {
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text,
            contents,
          }),
        );
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((annotationEntry) =>
              annotationEntry.id === entryId
                ? { ...annotationEntry, kind: "comment", text }
                : annotationEntry,
            ),
          },
        })),
      );
    },
    [
      addReviewComment,
      composerDraftTarget,
      contents,
      lineAnnotations,
      relativePath,
      setSelectedRange,
    ],
  );

  const beginComment = useCallback((range: SelectedLineRange) => {
    const { startLine, endLine } = normalizeFileCommentRange(range);
    const draftEntry: FileCommentAnnotationEntry = {
      id: nextFileCommentId(),
      kind: "draft",
      startLine,
      endLine,
      text: "",
    };
    setLineAnnotations((current) => {
      const withoutDraft = current.flatMap((annotation) => {
        const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
        return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
      });
      const existingIndex = withoutDraft.findIndex(
        (annotation) => annotation.lineNumber === endLine,
      );
      if (existingIndex < 0) {
        return [
          ...withoutDraft,
          {
            lineNumber: endLine,
            metadata: { entries: [draftEntry] },
          },
        ];
      }
      return withoutDraft.map((annotation, index) =>
        index === existingIndex
          ? {
              ...annotation,
              metadata: { entries: [...annotation.metadata.entries, draftEntry] },
            }
          : annotation,
      );
    });
  }, []);
  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor: session.editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [hasOpenCommentForm, session, setSelectedRange]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range) {
        beginComment(range);
      }
    },
    [beginComment, setSelectedRange],
  );

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
      if (phase === "unmount") return;

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null;
        if (!fileContainer.isConnected) return;
        instance.setSelectedLines(selectedRange, { notify: false });
      });
    },
    [onPostRender, selectedRange],
  );

  return (
    <EditProvider createEditor={() => session.editor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <File<FileCommentAnnotationGroup>
            file={{
              name: relativePath,
              contents,
              cacheKey: session.cacheKey,
            }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: !hasOpenCommentForm,
              enableLineSelection: !hasOpenCommentForm,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd: handleLineSelectionEnd,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              onPostRender: handlePostRender,
            }}
            selectedLines={selectedRange}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) => (
                  <LocalCommentAnnotation
                    key={entry.id}
                    kind={entry.kind}
                    rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                    text={entry.text}
                    onCancel={() => removeAnnotationEntry(entry.id)}
                    onComment={(text) => submitAnnotationEntry(entry.id, text)}
                    onDelete={() => removeAnnotationEntry(entry.id)}
                  />
                ))}
              </div>
            )}
            className="min-h-full"
            edit
          />
        </Virtualizer>
      </div>
    </EditProvider>
  );
}

function RenderedMarkdownSurface({
  session,
  environmentId,
  cwd,
  contents,
  threadRef,
}: {
  session: FileEditingSession<FileCommentAnnotationGroup>;
  environmentId: EnvironmentId;
  cwd: string;
  contents: string;
  threadRef: ScopedThreadRef;
}) {
  const relativePath = session.relativePath;
  const surfaceRef = useRef<HTMLDivElement>(null);
  useFileSaveShortcut(surfaceRef, session);

  // Unsaved source edits win over the file; once saved, the file wins, so a
  // change made on disk after the save shows here and a task toggle keeps it.
  return (
    <ScrollArea ref={surfaceRef} className="min-h-0 flex-1">
      <ChatMarkdown
        text={session.unsavedContents ?? contents}
        cwd={cwd}
        threadRef={threadRef}
        className="mx-auto max-w-4xl px-6 py-5"
        onTaskListChange={({ markerOffset, checked }) => {
          const currentContents =
            session.unsavedContents ??
            getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
            contents;
          const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
          if (nextContents === currentContents) return;
          setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
          session.changeOutsideEditor(nextContents);
        }}
      />
    </ScrollArea>
  );
}

function initialExplorerOpen(): boolean {
  try {
    return getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean) ?? true;
  } catch (error) {
    console.error(error);
    return true;
  }
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  revealLine,
  revealRequestId,
  onOpenFile,
  onPendingChange,
  onConflictChange,
  editingSessions,
  workspaceUnavailable = null,
  diskCheckSignal = null,
}: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const file = useProjectFileQuery(environmentId, cwd, relativePath);
  const session = useFileEditingSession({
    editingSessions,
    environmentId,
    cwd,
    relativePath,
    file,
    onPendingChange,
    onConflictChange,
    enabled: workspaceUnavailable === null,
  });
  useFileDiskWatch({ session, environmentId, cwd, diskCheckSignal });
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [markdownSourceView, setMarkdownSourceView] = useState<{
    path: string | null;
    revealRequestId: number | null;
  }>({ path: null, revealRequestId: null });
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const renderMarkdownSource =
    isMarkdown && (markdownSourceView.path === relativePath || revealLine !== null);
  const renderMarkdown = isMarkdown && !renderMarkdownSource && !file.data?.truncated;
  // A truncated read is shown read-only unless a guarded session kept the file's text.
  const truncatedPreview = file.data?.truncated === true && session === null;
  if (session && file.data && !renderMarkdown) {
    void session.editor;
  }
  const sessionSnapshot = useSyncExternalStore(
    session?.subscribe ?? subscribeUnavailable,
    session?.getSnapshot ?? readUnavailable,
    session?.getSnapshot ?? readUnavailable,
  );
  const diskConflict = sessionSnapshot.conflict;
  const deletedOnDisk = sessionSnapshot.deletedOnDisk;
  const canOpenInBrowser =
    relativePath !== null && canPreviewAnyUrlInRuntime() && isBrowserPreviewFile(relativePath);
  const absolutePath = relativePath ? resolvePathLinkTarget(relativePath, cwd) : null;
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);

  useEffect(() => {
    if (!relativePath) return;
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  const handleOpenInBrowser = useCallback(() => {
    if (!absolutePath || !environmentHttpBaseUrl) return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef,
        filePath: absolutePath,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  }, [absolutePath, createAssetUrl, environmentHttpBaseUrl, openPreview, threadRef]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath ? (
        <div className="surface-subheader gap-2 px-3" data-surface-subheader>
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={crumb.path || "project"}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  <span
                    className={cn(
                      "max-w-40 truncate",
                      crumb.kind === "file"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                    title={crumb.path || projectName}
                  >
                    {crumb.label}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
          {absolutePath && environmentId === primaryEnvironmentId ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={absolutePath}
              compact
              enableShortcut={false}
            />
          ) : null}
          {canOpenInBrowser ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={false}
                    onPressedChange={handleOpenInBrowser}
                    aria-label="Open file in preview browser"
                    variant="ghost"
                    size="sm"
                  >
                    <Globe2 className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipPopup>Open file in preview browser</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={explorerOpen}
                  onPressedChange={toggleExplorer}
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="ghost"
                  size="sm"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>
              {explorerOpen ? "Hide file explorer" : "Show file explorer"}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {relativePath !== null ? (
        <FileEditorToolbar
          savePhase={sessionSnapshot.save.phase}
          confirmedRevision={sessionSnapshot.save.confirmedRevision}
          canSave={sessionSnapshot.save.canSave}
          canUndo={!renderMarkdown && !deletedOnDisk && sessionSnapshot.canUndo}
          canRedo={!renderMarkdown && !deletedOnDisk && sessionSnapshot.canRedo}
          cleanStatus={
            truncatedPreview || (file.error && file.data === null)
              ? "Editing unavailable"
              : workspaceUnavailable
          }
          saveBlockedReason={diskConflict ? fileDiskConflictSaveReason(diskConflict) : null}
          markdownView={
            isMarkdown
              ? {
                  rendered: renderMarkdown,
                  onRenderedChange: (rendered) => {
                    setMarkdownSourceView({
                      path: rendered ? null : relativePath,
                      revealRequestId: rendered ? null : revealRequestId,
                    });
                  },
                }
              : undefined
          }
          onSave={() => {
            if (session) void session.flush();
          }}
          onUndo={() => session?.undo()}
          onRedo={() => session?.redo()}
        />
      ) : null}
      {session && diskConflict ? (
        <FileDiskConflictBar
          conflict={diskConflict}
          confirmReload={renderMarkdown || diskConflict.reason === "deleted"}
          onReload={() => {
            // A task ticked during the conflict left an overlay the views would prefer over the
            // disk text the conflict's read put in the query.
            clearProjectFileQueryData(environmentId, cwd, session.relativePath);
            session.reloadFromDisk();
          }}
          onOverwrite={() => session.overwriteDisk()}
        />
      ) : null}
      {relativePath && file.data && truncatedPreview ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && deletedOnDisk ? (
            <div
              className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-muted-foreground"
              data-file-deleted-on-disk
            >
              Deleted on disk. It reopens here if the file comes back.
            </div>
          ) : relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
              {file.error}
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : relativePath && file.data ? (
            isMarkdown && renderMarkdown && session ? (
              <RenderedMarkdownSurface
                session={session}
                environmentId={environmentId}
                cwd={cwd}
                threadRef={threadRef}
                contents={file.data.contents}
              />
            ) : truncatedPreview ? (
              <Virtualizer
                key={`${relativePath}:${resolvedTheme}:${file.data.byteLength}`}
                className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                <File
                  file={{
                    name: relativePath,
                    contents: file.data.contents,
                    cacheKey: projectFileCacheKey(cwd, relativePath, file.data.contents),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
                    onPostRender: onFilePostRender,
                  }}
                  className="min-h-full"
                />
              </Virtualizer>
            ) : session ? (
              <EditableFileSurface
                key={`${relativePath}:${resolvedTheme}`}
                session={session}
                composerDraftTarget={composerDraftTarget}
                contents={
                  session.retainedContents ??
                  (file.data.truncated ? session.documentContents : file.data.contents)
                }
                resolvedTheme={resolvedTheme}
                revealRequestId={revealRequestId}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
              />
            ) : (
              <Virtualizer className="file-preview-virtualizer min-h-0 flex-1 overflow-auto">
                <File
                  file={{
                    name: relativePath,
                    contents: file.data.contents,
                    cacheKey: projectFileCacheKey(cwd, relativePath, file.data.contents),
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                    unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
                    onPostRender: onFilePostRender,
                  }}
                  className="min-h-full"
                />
              </Virtualizer>
            )
          ) : null}
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-panel-separator"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              threadRef={threadRef}
              availableEditors={availableEditors}
              onOpenFile={onOpenFile}
              onBeginPathMutation={(request) => editingSessions.beginPathMutation(request)}
              workspaceUnavailable={workspaceUnavailable}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
