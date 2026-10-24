import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewProps } from "@pierre/diffs/react";
import type { ScopedThreadRef } from "@bibcode/contracts";
import { useCallback, useMemo, useState, type ReactNode, type Ref } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { fnv1a32 } from "~/lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { LocalCommentAnnotation } from "../files/LocalCommentAnnotation";
import { nextFileCommentId } from "../files/fileCommentAnnotations";

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup>;
const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

function annotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = annotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

/** An unsent comment, held outside the view so it survives the view unmounting. */
export interface LiftedCommentDraft {
  readonly id: string;
  readonly filePath: string;
  readonly range: SelectedLineRange;
  readonly rangeLabel: string;
}

/**
 * Where an unsent comment lives when the view is not its owner: its location, and its text,
 * which the comment field reads once when it mounts and writes on every change.
 */
export interface CommentDraftStore {
  readonly draft: LiftedCommentDraft | null;
  readonly onDraftChange: (draft: LiftedCommentDraft | null) => void;
  readonly readDraftText: (id: string) => string;
  readonly onDraftTextChange: (id: string, text: string) => void;
}

interface AnnotatableSelectedLines {
  readonly id: string;
  readonly range: SelectedLineRange;
}

export interface AnnotatableCodeViewProps {
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    collapsed: boolean;
    /**
     * The file comments are placed against, when the rendered one has other hunks: Compare
     * renders a patch with its own context count, while comments index the default hunks.
     */
    commentFileDiff?: FileDiffMetadata;
  }>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: NonNullable<CodeViewProps<DiffCommentAnnotationGroup>["options"]>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
  enableGutterUtility?: boolean;
  enableLineSelection?: boolean;
  selectedLines?: AnnotatableSelectedLines | null;
  onSelectedLinesChange?: (selection: AnnotatableSelectedLines | null) => void;
  onLineSelectionEnd?: (range: SelectedLineRange | null, context: DiffSelectionContext) => void;
  /** Keeps an unsent comment outside the view; without it the view owns the draft. */
  draftStore?: CommentDraftStore;
}

export interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  files,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  viewerRef,
  className,
  renderHeaderPrefix,
  enableGutterUtility,
  enableLineSelection,
  selectedLines: controlledSelectedLines,
  onSelectedLinesChange,
  onLineSelectionEnd,
  draftStore,
}: AnnotatableCodeViewProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [localSelectedLines, setLocalSelectedLines] = useState<AnnotatableSelectedLines | null>(
    null,
  );
  const [localDraft, setLocalDraft] = useState<{
    fileKey: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);

  const filesByKey = useMemo(() => new Map(files.map((file) => [file.fileKey, file])), [files]);
  // A lifted draft is placed by path: Changes and Compare key the same file differently.
  const liftedDraft = draftStore?.draft ?? null;
  const draft = useMemo(() => {
    if (!draftStore) return localDraft;
    if (!liftedDraft) return null;
    const file = files.find((candidate) => candidate.filePath === liftedDraft.filePath);
    if (!file) return null;
    return {
      fileKey: file.fileKey,
      annotation: {
        side: annotationSide(liftedDraft.range),
        lineNumber: liftedDraft.range.end,
        metadata: {
          entries: [
            {
              id: liftedDraft.id,
              kind: "draft" as const,
              range: liftedDraft.range,
              rangeLabel: liftedDraft.rangeLabel,
              text: "",
            },
          ],
        },
      },
    };
  }, [draftStore, files, liftedDraft, localDraft]);
  const setDraft = useCallback(
    (next: { fileKey: string; annotation: DiffCommentLineAnnotation } | null) => {
      if (!draftStore) {
        setLocalDraft(next);
        return;
      }
      const entry = next?.annotation.metadata.entries[0];
      const file = next ? filesByKey.get(next.fileKey) : undefined;
      draftStore.onDraftChange(
        entry && file
          ? {
              id: entry.id,
              filePath: file.filePath,
              range: entry.range,
              rangeLabel: entry.rangeLabel,
            }
          : null,
      );
    },
    [draftStore, filesByKey],
  );
  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(
    () =>
      files.map(({ fileDiff, filePath, fileKey, collapsed, commentFileDiff }) => {
        const persisted = reviewComments
          .filter(
            (comment) =>
              comment.sectionId === sectionId &&
              comment.filePath === filePath &&
              (comment.fenceLanguage ?? "diff") === "diff",
          )
          .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
            const range = restoreDiffReviewCommentRange(commentFileDiff ?? fileDiff, comment);
            if (!range) return annotations;
            return appendAnnotationEntry(annotations, range, {
              id: comment.id,
              kind: "comment",
              range,
              rangeLabel: comment.rangeLabel,
              text: comment.text,
            });
          }, []);
        const annotations =
          draft?.fileKey === fileKey ? [...persisted, draft.annotation] : persisted;
        return {
          id: fileKey,
          type: "diff",
          fileDiff,
          annotations,
          collapsed,
          version: fnv1a32(
            `${collapsed ? "1" : "0"}:${annotations
              .flatMap((annotation) =>
                annotation.metadata.entries.map(
                  (entry) => `${entry.id}:${entry.rangeLabel}:${entry.text}`,
                ),
              )
              .join(":")}`,
          ),
        };
      }),
    [draft, files, reviewComments, sectionId],
  );

  const removeEntry = useCallback(
    (entryId: string) => {
      setLocalSelectedLines(null);
      if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
        setDraft(null);
      } else {
        removeReviewComment(composerDraftTarget, entryId);
      }
    },
    [composerDraftTarget, draft, removeReviewComment, setDraft],
  );

  const submitEntry = useCallback(
    (entryId: string, text: string) => {
      const entry = draft?.annotation.metadata.entries.find(
        (candidate) => candidate.id === entryId,
      );
      const file = draft ? filesByKey.get(draft.fileKey) : undefined;
      if (!entry || !file) return;
      const comment = buildDiffReviewComment({
        id: entry.id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.commentFileDiff ?? file.fileDiff,
        range: entry.range,
        text,
      });
      if (comment) addReviewComment(composerDraftTarget, comment);
      setLocalSelectedLines(null);
      setDraft(null);
    },
    [addReviewComment, composerDraftTarget, draft, filesByKey, sectionId, sectionTitle, setDraft],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: DiffSelectionContext) => {
      if (!range) return;
      const item = context.item;
      if (item.type !== "diff") return;
      const file = filesByKey.get(item.id);
      if (!file) return;
      const id = nextFileCommentId();
      const comment = buildDiffReviewComment({
        id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.commentFileDiff ?? file.fileDiff,
        range,
        text: "",
      });
      if (!comment) return;
      setDraft({
        fileKey: item.id,
        annotation: {
          side: annotationSide(range),
          lineNumber: range.end,
          metadata: {
            entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
          },
        },
      });
    },
    [filesByKey, sectionId, sectionTitle, setDraft],
  );

  const commentSelectionEnabled = onLineSelectionEnd === undefined;
  const hasOpenComment = commentSelectionEnabled && draft !== null;
  const selectedLines =
    controlledSelectedLines === undefined ? localSelectedLines : controlledSelectedLines;
  const handleSelectedLinesChange = onSelectedLinesChange ?? setLocalSelectedLines;
  return (
    <CodeView<DiffCommentAnnotationGroup>
      {...(viewerRef ? { ref: viewerRef } : {})}
      {...(className ? { className } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={handleSelectedLinesChange}
      options={{
        ...options,
        enableGutterUtility: enableGutterUtility ?? !hasOpenComment,
        enableLineSelection: enableLineSelection ?? !hasOpenComment,
        onLineSelectionEnd: onLineSelectionEnd ?? beginComment,
      }}
      renderHeaderPrefix={(item) =>
        item.type === "diff"
          ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
          : null
      }
      renderAnnotation={(annotation) => (
        <div className="py-1">
          {annotation.metadata.entries.map((entry) => (
            <LocalCommentAnnotation
              key={entry.id}
              kind={entry.kind}
              rangeLabel={entry.rangeLabel}
              text={entry.text}
              {...(draftStore && entry.kind === "draft"
                ? {
                    initialText: draftStore.readDraftText(entry.id),
                    onTextChange: (text: string) => draftStore.onDraftTextChange(entry.id, text),
                  }
                : {})}
              onCancel={() => removeEntry(entry.id)}
              onComment={(text) => submitEntry(entry.id, text)}
              onDelete={() => removeEntry(entry.id)}
            />
          ))}
        </div>
      )}
    />
  );
}
