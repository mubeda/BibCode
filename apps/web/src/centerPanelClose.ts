/**
 * The one rule for closing a chat panel (#265). A user's close is a durable close intent
 * (`closingChatPanels`, persisted) that the open, adoption and the lifecycle reconciler check
 * first, so a closing panel is never adopted, shown or sent its first question.
 *
 * Replies are not authoritative; the server's ordered state is. Each close has its own id, and
 * an archive reply applies only to the close that sent it (it records the archive's event
 * sequence). A close is settled by a live snapshot, through the snapshot's engine sequence:
 *
 * - The snapshot leaves the panel out at or after this close's own archive, or after the newest
 *   snapshot that listed it live during this close: the server archived or deleted it. The
 *   intent is dropped.
 * - The snapshot lists it live after this close's own archive: someone reopened it. The intent
 *   is dropped and the panel is never archived again.
 * - It lists it live otherwise: this close is not done yet, so it is archived (one request at a
 *   time; a refused or lost one is tried again at the next live sighting).
 *
 * A snapshot without a sequence, or a capped one that may leave the panel out, settles nothing.
 * Whatever ends a creation (success, failure, interruption) settles a pending close itself: a
 * failure drops it (never created), anything else archives the panel without waiting for a
 * snapshot. Adoption handles the rest, also after a reload.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@bibcode/contracts";

import { type ChatPanelCloseIntent, useCenterPanelStore } from "./centerPanelStore";

/** `refused`: the server answered no (the thread is missing, or already archived). */
export type PanelArchiveResult =
  | { readonly kind: "archived"; readonly sequence: number }
  | { readonly kind: "refused" }
  | { readonly kind: "interrupted" };

export type ArchivePanelThread = (ref: ScopedThreadRef) => Promise<PanelArchiveResult>;

/** This page's memory: the close each panel's archive request is in flight for. */
const archiving = new Map<string, string>();
/** This page's memory: the newest snapshot sequence that listed each panel live. */
const liveSequences = new Map<string, number>();

/** For a page that starts over (a reload): only the persisted intents remain. */
export function resetChatPanelCloseMemory(): void {
  archiving.clear();
  liveSequences.clear();
}

/** The panels whose archive request is in flight. */
export function archivingChatPanels(): ReadonlySet<string> {
  return new Set(archiving.keys());
}

function closeIntent(key: string): ChatPanelCloseIntent | undefined {
  return useCenterPanelStore.getState().closingChatPanels.find((intent) => intent.key === key);
}

/** Whether the user closed `ref`'s tab and the close is not settled. */
export function isChatPanelClosed(ref: ScopedThreadRef): boolean {
  return closeIntent(scopedThreadKey(ref)) !== undefined;
}

/** Records a new close of `ref` and archives it now, unless its creation is in flight. */
export function closeChatPanel(ref: ScopedThreadRef, archive: ArchivePanelThread): void {
  const store = useCenterPanelStore.getState();
  store.recordChatPanelClose(ref, liveSequences.get(scopedThreadKey(ref)));
  // The tab is gone; the close intent, not the reservation, keeps the panel from showing.
  store.releaseChatPanelReservation(ref);
  settleChatPanelClose(ref, archive);
}

/**
 * Archives a closing panel, one request at a time. Skipped while this page still waits on its
 * `createPanel`, whose end settles it, and once its close has its own archive.
 */
export function settleChatPanelClose(ref: ScopedThreadRef, archive: ArchivePanelThread): void {
  const key = scopedThreadKey(ref);
  const intent = closeIntent(key);
  if (
    !intent ||
    intent.archivedAt !== undefined ||
    archiving.has(key) ||
    useCenterPanelStore.getState().creatingChatPanelThreadKeys.has(key)
  ) {
    return;
  }
  const { closeId } = intent;
  archiving.set(key, closeId);
  void archive(ref).then((result) => {
    if (archiving.get(key) === closeId) archiving.delete(key);
    // Applies to this close only; a newer close or a reopen is left alone.
    if (result.kind === "archived") {
      useCenterPanelStore
        .getState()
        .updateChatPanelClose(ref, closeId, { archivedAt: result.sequence });
    }
    // A newer close of the same panel waited on this request; it gets its own archive now.
    if (closeIntent(key)?.closeId !== closeId) settleChatPanelClose(ref, archive);
  });
}

/** The user wants `ref` back (Reopen closed chat, or opening it from History or the Inbox). */
export function forgetChatPanelClose(ref: ScopedThreadRef): void {
  useCenterPanelStore.getState().clearChatPanelClose(ref);
}

/** Drops the close of a panel whose creation the server refused: it never existed. */
export function dropChatPanelCloseOfUncreated(ref: ScopedThreadRef): void {
  useCenterPanelStore.getState().clearChatPanelClose(ref);
}

/**
 * Applies a live snapshot of `environmentId` taken at the server's `sequence` (see the module
 * comment). `capped`: the snapshot may leave live panels out. Returns the panels someone
 * reopened after this page closed them, which adoption shows again.
 */
export function reconcileChatPanelCloses(
  environmentId: EnvironmentId,
  liveThreadIds: ReadonlySet<string>,
  sequence: number | undefined,
  capped: boolean,
  archive: ArchivePanelThread | undefined,
): ReadonlySet<string> {
  const reopened = new Set<string>();
  if (sequence !== undefined) {
    for (const threadId of liveThreadIds) {
      const key = scopedThreadKey({ environmentId, threadId } as ScopedThreadRef);
      if ((liveSequences.get(key) ?? -1) < sequence) liveSequences.set(key, sequence);
    }
  }
  const store = useCenterPanelStore.getState();
  for (const intent of store.closingChatPanels) {
    const ref = parseScopedThreadKey(intent.key);
    if (!ref || ref.environmentId !== environmentId) continue;
    const live = liveThreadIds.has(ref.threadId);
    if (sequence === undefined) {
      // No ordering: nothing settles, but a live closing panel is still archived once.
      if (live && archive && intent.archivedAt === undefined) settleChatPanelClose(ref, archive);
      continue;
    }
    if (live) {
      if (intent.archivedAt !== undefined) {
        // After this close's archive, it is live again: someone reopened it.
        if (sequence > intent.archivedAt) {
          store.clearChatPanelClose(ref, intent.closeId);
          reopened.add(ref.threadId);
        }
        continue;
      }
      if ((intent.liveAt ?? -1) < sequence) {
        store.updateChatPanelClose(ref, intent.closeId, { liveAt: sequence });
      }
      if (archive) settleChatPanelClose(ref, archive);
      continue;
    }
    if (capped) continue;
    const goneAfterOwnArchive = intent.archivedAt !== undefined && sequence >= intent.archivedAt;
    const goneAfterLastSighting = intent.liveAt !== undefined && sequence > intent.liveAt;
    if (goneAfterOwnArchive || goneAfterLastSighting) {
      store.clearChatPanelClose(ref, intent.closeId);
    }
  }
  return reopened;
}
