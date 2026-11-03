/**
 * The one rule for closing a chat panel (#265). A user's close is a durable close intent
 * (`closingChatPanels`, persisted): the open, adoption and the lifecycle reconciler check it
 * first, so a panel with one is never shown again and never sent its first question. It is
 * cleared only once the archive is settled: the server archived the panel, or it was never
 * created. Until a live snapshot stops listing an archived panel, an in-memory `archived`
 * mark keeps an older snapshot from showing it again. Whatever ends a creation
 * (success, failure, interruption) settles a pending close itself, without waiting for a
 * snapshot; adoption settles one the page learns about only from a snapshot (after a reload,
 * or an open whose outcome was lost).
 */
import { parseScopedThreadKey, scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@bibcode/contracts";

import { useCenterPanelStore } from "./centerPanelStore";

/** `refused`: the server answered no (the thread is missing, or already archived). */
export type PanelArchiveOutcome = "archived" | "refused" | "interrupted";

export type ArchivePanelThread = (ref: ScopedThreadRef) => Promise<PanelArchiveOutcome>;

/** Whether the user closed `ref`'s tab: it must not be shown, adopted or sent anything. */
export function isChatPanelClosed(ref: ScopedThreadRef): boolean {
  const key = scopedThreadKey(ref);
  const store = useCenterPanelStore.getState();
  return store.closingChatPanels.includes(key) || store.chatPanelCloseProgress.has(key);
}

/** Records the user's close of `ref` and archives it now, unless its creation is in flight. */
export function closeChatPanel(ref: ScopedThreadRef, archive: ArchivePanelThread): void {
  const store = useCenterPanelStore.getState();
  // A new close is a new intent, also for a panel archived here before and reopened elsewhere.
  if (store.chatPanelCloseProgress.get(scopedThreadKey(ref)) === "archived") {
    store.setChatPanelCloseProgress(ref, null);
  }
  store.recordChatPanelClose(ref);
  // The tab is gone; the close intent, not the reservation, now keeps the panel from showing.
  store.releaseChatPanelReservation(ref);
  settleChatPanelClose(ref, archive);
}

/**
 * Archives a closing panel once at a time. Skipped while this page still waits on its
 * `createPanel`, whose end settles it, and once the server archived it.
 */
export function settleChatPanelClose(ref: ScopedThreadRef, archive: ArchivePanelThread): void {
  const key = scopedThreadKey(ref);
  const store = useCenterPanelStore.getState();
  if (
    !store.closingChatPanels.includes(key) ||
    store.creatingChatPanelThreadKeys.has(key) ||
    store.chatPanelCloseProgress.has(key)
  ) {
    return;
  }
  store.setChatPanelCloseProgress(ref, "archiving");
  void archive(ref).then((outcome) => {
    const current = useCenterPanelStore.getState();
    // Reopened meanwhile: the user wants it back.
    if (!current.closingChatPanels.includes(key)) {
      current.setChatPanelCloseProgress(ref, null);
      return;
    }
    if (outcome === "archived") {
      // Settled: the intent goes, and the mark holds until a snapshot stops listing it.
      current.clearChatPanelClose(ref);
      useCenterPanelStore.getState().setChatPanelCloseProgress(ref, "archived");
      return;
    }
    // A refusal or a lost answer is tried again when a snapshot shows the panel live.
    current.setChatPanelCloseProgress(ref, null);
  });
}

/** The user wants `ref` back (Reopen closed chat, or opening it from History or the Inbox). */
export function forgetChatPanelClose(ref: ScopedThreadRef): void {
  useCenterPanelStore.getState().clearChatPanelClose(ref);
}

/**
 * Applies a live snapshot of `environmentId`: archives a closing panel the snapshot shows
 * live, and drops the `archived` mark of one it no longer lists. A live sighting of an
 * archived panel is an older snapshot, so it is left alone.
 */
export function reconcileChatPanelCloses(
  environmentId: EnvironmentId,
  liveThreadIds: ReadonlySet<string>,
  archive: ArchivePanelThread | undefined,
): void {
  const store = useCenterPanelStore.getState();
  for (const key of store.closingChatPanels) {
    const ref = parseScopedThreadKey(key);
    if (!ref || ref.environmentId !== environmentId) continue;
    if (archive && liveThreadIds.has(ref.threadId)) settleChatPanelClose(ref, archive);
  }
  for (const [key, progress] of store.chatPanelCloseProgress) {
    const ref = parseScopedThreadKey(key);
    if (progress !== "archived" || !ref || ref.environmentId !== environmentId) continue;
    if (!liveThreadIds.has(ref.threadId)) store.setChatPanelCloseProgress(ref, null);
  }
}
