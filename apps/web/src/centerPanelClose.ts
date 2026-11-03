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
 *
 * A side chat nobody sent to is deleted instead, on a server that refuses to delete a used one
 * (`onlyIfUnused`); a refusal archives it. A delete settles as an archive does: the shell that
 * reaches it no longer lists the panel, and **Reopen closed chat** never lists it.
 */
import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { ScopedThreadRef } from "@bibcode/contracts";

import { useCenterPanelStore } from "./centerPanelStore";
import { readThreadShell } from "./state/entities";
import { readPreparedConnection } from "./state/session";

/** Threads this page sent to: a close racing that send must not delete it. */
const sentChatPanels = new Set<string>();

/** Records that this page is sending to `ref`, before the send goes out. */
export function markChatPanelSent(ref: ScopedThreadRef): void {
  sentChatPanels.add(scopedThreadKey(ref));
}

/**
 * Whether closing the side chat `ref` tries a delete first: its server refuses to delete a used
 * thread (an older one would delete it regardless), and nothing here shows it was used.
 */
export function closesByUnusedDelete(ref: ScopedThreadRef): boolean {
  const capabilities = readPreparedConnection(ref.environmentId)?.descriptor?.capabilities;
  if (capabilities?.threadDeleteOnlyIfUnused !== true) return false;
  if (sentChatPanels.has(scopedThreadKey(ref))) return false;
  const shell = readThreadShell(ref);
  return shell?.latestTurn == null && shell?.latestUserMessageAt == null;
}

/** Hides `ref` from adoption while this page closes it; its tab is already gone. */
export function hideClosingChatPanel(ref: ScopedThreadRef): void {
  useCenterPanelStore.getState().hideClosingChatPanel(ref);
}

/**
 * Archives `ref` once (or deletes it, see `closesByUnusedDelete`). `archive` resolves the event
 * sequence when the server archived or deleted it, or `null` for any other outcome.
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
