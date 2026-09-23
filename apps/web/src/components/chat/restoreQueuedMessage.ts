import type { ComposerAttachment } from "../../composerDraftStore";
import type { ChatMessage } from "../../types";

export function mergeQueuedMessageIntoDraft<
  Draft extends { prompt: string; attachments: ComposerAttachment[] },
>(
  draft: Draft,
  message: Pick<ChatMessage, "text" | "attachments"> & {
    cachedAttachments?: ReadonlyArray<ComposerAttachment> | undefined;
  },
  limits: { maxAttachments: number },
): { draft: Draft; droppedAttachmentCount: number; unrestoredAttachmentCount: number } {
  const cachedById = new Map(
    message.cachedAttachments?.map((attachment) => [attachment.id, attachment]),
  );
  const restored = (message.attachments ?? []).flatMap((attachment) => {
    const cached = cachedById.get(attachment.id);
    return cached ? [cached] : [];
  });
  const capacity = Math.max(0, limits.maxAttachments - draft.attachments.length);
  return {
    draft: {
      ...draft,
      prompt: [draft.prompt, message.text].filter((text) => text.length > 0).join("\n\n"),
      attachments: [...draft.attachments, ...restored.slice(0, capacity)],
    },
    droppedAttachmentCount: Math.max(0, restored.length - capacity),
    unrestoredAttachmentCount: (message.attachments?.length ?? 0) - restored.length,
  };
}
