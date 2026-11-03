/**
 * Closing a chat panel (#265). A close hides the panel from adoption only while this page's own
 * request about it is in flight: its archive, or the creation it waits on. When that request
 * ends, whatever its outcome, the panel is no longer hidden, and if a live snapshot still lists
 * it (an archive that did not land, or someone's reopen) it comes back as a tab. An archive is
 * sent once and never retried, so this page never closes a panel someone else reopened; a
 * closed tab may come back instead, and the user can close it again.
 */
import type { ScopedThreadRef } from "@bibcode/contracts";

import { useCenterPanelStore } from "./centerPanelStore";

/** Hides `ref` from adoption while this page closes it; its tab is already gone. */
export function hideClosingChatPanel(ref: ScopedThreadRef): void {
  useCenterPanelStore.getState().hideClosingChatPanel(ref);
}

/** Archives `ref` once, then lets adoption show it again if it is still live. */
export async function archiveClosingChatPanel(
  ref: ScopedThreadRef,
  archive: (ref: ScopedThreadRef) => Promise<unknown>,
): Promise<void> {
  try {
    await archive(ref);
  } finally {
    useCenterPanelStore.getState().releaseClosingChatPanel(ref, true);
  }
}

/** Ends the close of a panel the server never created. */
export function releaseUncreatedChatPanel(ref: ScopedThreadRef): void {
  useCenterPanelStore.getState().releaseClosingChatPanel(ref, false);
}
