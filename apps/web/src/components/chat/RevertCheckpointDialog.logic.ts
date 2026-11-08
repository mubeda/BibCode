/**
 * The "Revert to this message" dialog (#279). A file restore in a checkout other chats share is
 * refused while one of them is writing, and warns about what they changed; the conversation
 * alone can always be rewound when the provider can do it without touching files.
 */
import type {
  CheckpointRevertMode,
  CheckpointRevertWritingReason,
  OrchestrationPreviewCheckpointRevertResult,
  ServerProvider,
} from "@bibcode/contracts";

import { providerDriverLabel } from "../../providerInstances";

export type RevertDialogAction = {
  readonly mode: CheckpointRevertMode;
  readonly label: string;
  /** The dialog's main button. A file restore's is styled as destructive. */
  readonly primary: boolean;
  readonly destructive: boolean;
};

export type RevertDialogModel = {
  readonly title: string;
  readonly description: string;
  /** Every file a file restore rewrites or deletes, on a shared checkout. */
  readonly restoredPaths: readonly string[];
  /** One line per chat (or source) whose changes a file restore would undo. */
  readonly outsideChanges: readonly string[];
  readonly actions: readonly RevertDialogAction[];
  /** "Cancel" next to an action, "Close" when nothing can be done. */
  readonly dismissLabel: "Cancel" | "Close";
  readonly siblingChangesToken: string | null;
};

const MAX_FILES_PER_LINE = 3;
/** How many restored files show before "and N more". */
export const RESTORED_PATHS_SHOWN = 5;

const REWIND_ONLY_LABEL = "Rewind conversation only";
const REWIND_ONLY_OFFER = "You can rewind only this conversation now; files stay as they are.";

function writingReasonLine(title: string, reason: CheckpointRevertWritingReason): string {
  switch (reason) {
    case "turn":
      return `${title} is running a turn in this checkout. Stop it or wait for it to finish, then revert.`;
    case "startingTurn":
      return `${title} is starting a turn in this checkout. Try the revert again in a moment.`;
    case "backgroundWork":
      return `${title} is running background work in this checkout. Stop it or wait for it to finish, then revert.`;
    case "checkpointPending":
      return `${title} is still saving its checkpoint. Try the revert again in a moment.`;
    case "unobservable":
      return `BiBCode can't tell whether ${title} is still working. Stop its session, then revert.`;
    case "unmanagedServer":
      return `${title} runs on an OpenCode server BiBCode doesn't manage, so BiBCode can't make sure it has stopped working in this checkout.`;
    case "startingSession":
      return `${title} is starting its session. Try the revert again in a moment.`;
    case "unresolvableCheckout":
      return `BiBCode can't tell whether ${title} works in this checkout. Check that chat's folder, then revert.`;
  }
}

function fileList(paths: readonly string[], max: number): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}

function outsideChangeLines(
  changes: OrchestrationPreviewCheckpointRevertResult["siblingChanges"],
): string[] {
  const lines = changes.turns.map((sibling) => {
    const turns = `${sibling.turns} ${sibling.turns === 1 ? "turn" : "turns"}`;
    const files =
      sibling.files === null
        ? "files not known"
        : sibling.files.length === 0
          ? "no files"
          : fileList(sibling.files, MAX_FILES_PER_LINE);
    return `${sibling.title}: ${turns}, ${files}`;
  });
  if (changes.paths.length > 0) {
    lines.push(
      `Changed since this chat's last turn: ${fileList(changes.paths, MAX_FILES_PER_LINE)}`,
    );
  }
  return lines;
}

/**
 * The dialog for reverting to checkpoint `turnCount`. `preview` is `null` for a server without
 * the shared-checkout guard, which gets today's two choices.
 */
export function buildRevertCheckpointDialog(input: {
  readonly turnCount: number;
  readonly provider: Pick<
    ServerProvider,
    "displayName" | "driver" | "supportsConversationRewind"
  > | null;
  readonly preview: OrchestrationPreviewCheckpointRevertResult | null;
}): RevertDialogModel {
  const { turnCount, provider, preview } = input;
  const providerName =
    provider === null
      ? "This provider"
      : provider.displayName?.trim() || providerDriverLabel(provider.driver);
  const filesOnly =
    preview?.conversationRewind === "filesOnlyProvider" ||
    (preview === null && provider?.supportsConversationRewind === false);
  const canRewindOnly = preview !== null && preview.conversationRewind === "available";
  const rewindOnly: RevertDialogAction = {
    mode: "conversationOnly",
    label: REWIND_ONLY_LABEL,
    primary: true,
    destructive: false,
  };
  const token = preview?.siblingChangesToken ?? null;
  const blocked = preview?.writingSiblings[0];
  if (blocked !== undefined || preview?.headFallbackRefused === true) {
    const reason =
      blocked !== undefined
        ? writingReasonLine(blocked.title, blocked.reason)
        : "This thread has no starting checkpoint, and other chats share this checkout, so restoring files would discard their work.";
    return {
      title: "Can't restore files right now",
      description: canRewindOnly ? `${reason} ${REWIND_ONLY_OFFER}` : reason,
      restoredPaths: [],
      outsideChanges: [],
      actions: canRewindOnly ? [rewindOnly] : [],
      dismissLabel: canRewindOnly ? "Cancel" : "Close",
      siblingChangesToken: token,
    };
  }
  const restoredPaths = preview?.restoredPaths ?? [];
  const outsideChanges = preview === null ? [] : outsideChangeLines(preview.siblingChanges);
  if (filesOnly) {
    return {
      title: `Restore files to checkpoint ${turnCount}?`,
      description: `${providerName} can't rewind its conversation, so the newer messages stay. This can't be undone.`,
      restoredPaths,
      outsideChanges,
      actions: [{ mode: "full", label: "Restore files", primary: true, destructive: true }],
      dismissLabel: "Cancel",
      siblingChangesToken: token,
    };
  }
  const when = turnCount === 0 ? "before this thread's first turn" : `after turn ${turnCount}`;
  return {
    title: `Revert to checkpoint ${turnCount}?`,
    description: `Files go back to how they were ${when}, and newer messages in this thread are removed. This can't be undone.`,
    restoredPaths,
    outsideChanges,
    actions: [
      { mode: "full", label: "Revert files and conversation", primary: true, destructive: true },
      ...(canRewindOnly ? [{ ...rewindOnly, primary: false }] : []),
    ],
    dismissLabel: "Cancel",
    siblingChangesToken: token,
  };
}
