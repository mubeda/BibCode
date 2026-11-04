/**
 * Whether this thread can open a side chat (#265): a chat panel of the thread that starts
 * with the thread's messages. The **+** menu's **Side chat** and the composer's `:btw` and
 * `:side` share this answer, so both show the same reason when they can't.
 */
import type { ExecutionEnvironmentCapabilities } from "@bibcode/contracts";

import { PANEL_UNAVAILABLE_REASON } from "./components/chat/ChatHeaderPanelMenu.logic";

export const SIDE_CHAT_IN_PANEL_REASON = "Side chats start from the main chat. Use :btw there.";
export const SIDE_CHAT_UNSUPPORTED_REASON =
  "This server doesn't support side chats. Update it to use them.";

/** The reason side chats are unavailable, or `null` when one can be opened. */
export function resolveSideChatAvailability(input: {
  /** The thread's environment capabilities; `null` before its server reported them. */
  readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "sideChats"> | null;
  /** The thread is a chat panel or side chat itself, which cannot host one. */
  readonly isPanel: boolean;
  /** The thread can spawn sibling panels (it has started on the server). */
  readonly canCreatePanel: boolean;
  /** Why the workspace is unavailable, when it is. */
  readonly workspaceUnavailableReason: string | null;
  /** The host provider's own disabled reason, when it cannot start a chat. */
  readonly hostProviderReason: string | null;
}): string | null {
  if (input.isPanel) return SIDE_CHAT_IN_PANEL_REASON;
  if (input.capabilities?.sideChats !== true) return SIDE_CHAT_UNSUPPORTED_REASON;
  if (input.workspaceUnavailableReason !== null) return input.workspaceUnavailableReason;
  if (!input.canCreatePanel) return PANEL_UNAVAILABLE_REASON;
  return input.hostProviderReason;
}
