/**
 * Closing a chat panel (#265). A close hides the panel from adoption while this page's own
 * request about it is in flight: its archive, or the creation it waits on. An archive is sent
 * once and never retried, so this page never closes a panel someone else reopened.
 *
 * - A successful archive keeps the panel hidden until a shell at or after the archive's own
 *   sequence (the shell is published late). If that shell still lists the panel live,
 *   someone reopened it, and it comes back as a tab.
 * - Any other outcome (refused, interrupted, a lost reply) is uncertain: the panel stops being
 *   hidden at once, and if the shell lists it live it comes back as a tab, which the user can
 *   close again.
 */
import type { ScopedThreadRef } from "@bibcode/contracts";

import { useCenterPanelStore } from "./centerPanelStore";

/** Hides `ref` from adoption while this page closes it; its tab is already gone. */
export function hideClosingChatPanel(ref: ScopedThreadRef): void {
  useCenterPanelStore.getState().hideClosingChatPanel(ref);
}

/**
 * Archives `ref` once. `archive` resolves the archive's event sequence when the server
 * archived it, or `null` for any other outcome.
 */
export async function archiveClosingChatPanel(
  ref: ScopedThreadRef,
  archive: (ref: ScopedThreadRef) => Promise<number | null>,
): Promise<void> {
  const sequence = await archive(ref).catch(() => null);
  const store = useCenterPanelStore.getState();
  if (sequence === null) store.releaseClosingChatPanel(ref, true);
  else store.awaitClosingChatPanelShell(ref, sequence);
}

/** Ends the close of a panel the server never created. */
export function releaseUncreatedChatPanel(ref: ScopedThreadRef): void {
  useCenterPanelStore.getState().releaseClosingChatPanel(ref, false);
}
