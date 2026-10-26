import type { ScopedThreadRef } from "@bibcode/contracts";
import { useMemo } from "react";

import { commentDraftSectionKey, useDiffPanelStore } from "~/diffPanelStore";

import type { CommentDraftStore } from "./AnnotatableCodeView";

/**
 * The Diff panel's unsent line comment for one review section. Changes and Compare both read it,
 * so switching views keeps the comment and its text.
 */
export function useCommentDraftStore(
  threadRef: ScopedThreadRef | null | undefined,
  sectionId: string,
): CommentDraftStore | undefined {
  const sectionKey = threadRef ? commentDraftSectionKey(threadRef, sectionId) : null;
  const draft = useDiffPanelStore((state) =>
    sectionKey === null ? null : (state.commentDraftBySectionKey[sectionKey] ?? null),
  );
  return useMemo(
    () =>
      threadRef
        ? {
            draft,
            onDraftChange: (next) =>
              useDiffPanelStore.getState().setCommentDraft(threadRef, sectionId, next),
            readDraftText: (id) => useDiffPanelStore.getState().commentDraftTextById[id] ?? "",
            onDraftTextChange: (id, text) =>
              useDiffPanelStore.getState().setCommentDraftText(id, text),
          }
        : undefined,
    [draft, sectionId, threadRef],
  );
}
