/**
 * Pure model for the chat-header "+" panel menu.
 *
 * Given the already-derived provider instance entries (settings overlaid onto
 * the streamed snapshots), produce the ordered list of provider menu items.
 * Only supported, settings-enabled instances are visible; each is selectable
 * only when the instance is picker-ready, otherwise it renders disabled with a
 * reason. Grok remains an internal compatibility driver and is intentionally
 * excluded from user-facing agent and terminal actions.
 */
import {
  ProviderDriverKind,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@bibcode/contracts";

import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "~/providerInstances";

/** The most closed chats Reopen closed chat and History list. */
export const MAX_CLOSED_CHATS = 10;

export interface ClosedChatPanel {
  readonly id: ThreadId;
  readonly title: string;
  readonly archivedAt: string;
}

/**
 * The host's closed (archived) chat panels, most recently closed first, at most
 * {@link MAX_CLOSED_CHATS}: what **Reopen closed chat** and History's This thread list.
 */
export function selectClosedChatPanels(
  threads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "title" | "kind" | "hostThreadId" | "archivedAt">
  >,
  hostThreadId: ThreadId,
): ReadonlyArray<ClosedChatPanel> {
  return threads
    .flatMap((thread) =>
      thread.kind === "panel" && thread.hostThreadId === hostThreadId && thread.archivedAt !== null
        ? [{ id: thread.id, title: thread.title, archivedAt: thread.archivedAt }]
        : [],
    )
    .toSorted((left, right) => right.archivedAt.localeCompare(left.archivedAt))
    .slice(0, MAX_CLOSED_CHATS);
}

/** Reason shown on a visible-but-not-ready provider item. */
export const PROVIDER_NOT_READY_REASON =
  "This provider isn't ready yet — check its connection in Settings.";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

export interface PanelMenuProviderItem {
  readonly entry: ProviderInstanceEntry;
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

/**
 * Build the ordered provider items for the "+" panel menu. Ordering follows
 * the incoming entry order (the server's cross-driver order); readiness reuses
 * the shared picker predicate after unsupported UI drivers are removed.
 */
export function buildPanelMenuModel(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<PanelMenuProviderItem> {
  return entries
    .filter(
      (entry) => entry.driverKind !== GROK_DRIVER_KIND && isProviderInstancePickerVisible(entry),
    )
    .map((entry) => {
      const ready = isProviderInstancePickerReady(entry);
      return {
        entry,
        disabled: !ready,
        ...(ready ? {} : { disabledReason: PROVIDER_NOT_READY_REASON }),
      } satisfies PanelMenuProviderItem;
    });
}
