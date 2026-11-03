/**
 * Center-panel lifecycle actions (Wave C).
 *
 * A chat panel is a sibling thread (kind:"panel") that copies the host thread's
 * project/worktree/branch so it shares the same workspace. Opening one creates
 * the thread then registers a center surface. Closing one, through any close
 * variant (single, others, to-right, all), removes the surface, interrupts a
 * running turn (best effort), and archives the thread (fire-and-forget, toast
 * on failure), so its history and resume cursor survive. Reopening reserves
 * the tab and unarchives the thread. Archived panel threads are hidden from
 * Settings → Archived and are deleted with their host thread. Terminal panels
 * just register a surface — the terminal is attach-created lazily by the view.
 * History continues a Claude Code terminal session in a panel the server
 * creates (`agentSessions.openInPanel`), whose tab becomes active once it does.
 * A tab closed while its panel is still being created records the close, and
 * the panel is archived once the server created it (also after a reload, see
 * `centerPanelAdoption`). A side chat (#265) is a panel the server seeds with
 * the host's messages; `:btw` sends its question once it exists.
 */
import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type {
  AgentSessionOpenInPanelResult,
  AgentSessionOpenMode,
  CommandId,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@bibcode/contracts";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "@bibcode/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useCenterPanelStore, type CenterSurface } from "~/centerPanelStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readThreadShell } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { worktreeEnvironment } from "~/state/worktrees";

export interface CreateChatPanelInput {
  /** Host thread ref — keys the center-panel store and provides the environment. */
  readonly hostRef: ScopedThreadRef;
  /** Copied from the host thread so the panel shares its workspace. */
  readonly projectId: ProjectId;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
  /** Fully resolved provider instance, model, and options for the new panel thread. */
  readonly modelSelection: ModelSelection;
  /** Display label used for the thread title and the tab. */
  readonly providerLabel: string;
}

/** A side chat of the host: a chat panel the server seeds with the host's messages. */
export interface CreateSideChatInput extends CreateChatPanelInput {
  /** Sent to the side chat once it exists; empty opens it empty. */
  readonly question: string;
  /**
   * The host draft's text a `:btw` submitted. The host draft is cleared once the question
   * was handed over, and only while it still holds exactly this text. Absent from the menu.
   */
  readonly submittedText?: string;
}

export const SIDE_CHAT_SEND_FAILED_TITLE = "Couldn't send to the side chat";
export const SIDE_CHAT_SEND_FAILED_DESCRIPTION = "Your question is in its composer.";

/** The tab label of a side chat; its thread title is this behind the panel prefix. */
export const sideChatLabel = (providerLabel: string) => `Side chat · ${providerLabel}`;

/** Hosts with a side chat being created, so a second Enter on the same `:btw` opens nothing. */
const pendingSideChatHosts = new Set<string>();

/** Empty side chats whose composer takes focus once their thread shows. */
const composerFocusRequests = new Set<string>();

/** Whether `ref`'s composer was asked to take focus; answers true once. */
export function takeComposerFocusRequest(ref: ScopedThreadRef): boolean {
  return composerFocusRequests.delete(scopedThreadKey(ref));
}

/** A Claude Code terminal session History continues in a chat panel. */
export interface OpenSessionPanelInput {
  readonly sessionId: string;
  readonly mode: AgentSessionOpenMode;
  /** The session's title, which its tab shows. */
  readonly title: string;
}

/**
 * The command of each History open whose outcome is not known, by environment, host, session and
 * mode. A retry after a dropped connection sends the same command, so the server answers with
 * the thread the first attempt made (a copy's session ID derives from the command) instead of
 * making another copy. A success or the server's own refusal settles the open.
 */
const unsettledSessionOpens = new Map<string, CommandId>();

/** A failure the server decided, as opposed to a request that may not have reached it. */
const isServerRefusal = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "AgentSessionsError";

export interface PanelThreadOpener {
  reopenChatPanel: (
    hostRef: ScopedThreadRef,
    threadId: ThreadId,
    providerLabel: string,
  ) => Promise<void>;
  /**
   * Makes a panel thread of `hostRef` the active tab: reopens it when it was closed, else
   * activates its tab. `archived` says which, when known; otherwise the thread's shell does.
   */
  openPanelThread: (
    hostRef: ScopedThreadRef,
    threadId: ThreadId,
    label: string,
    archived?: boolean,
  ) => Promise<void>;
}

export interface CenterPanelActions extends PanelThreadOpener {
  createChatPanel: (input: CreateChatPanelInput) => Promise<ThreadId | null>;
  /**
   * Opens a side chat of `hostRef` and sends `question` there. Resolves the side chat's
   * thread, or `null` when none opened (one is already being created for this host, or the
   * creation failed and was shown).
   */
  createSideChat: (input: CreateSideChatInput) => Promise<ThreadId | null>;
  /**
   * Continues a terminal session in a chat panel of `hostRef`, which becomes the active tab when
   * the panel is `hostRef`'s. Resolves where the session landed, or `null` once a failure was
   * shown. Closing the History menu does not stop it.
   */
  openSessionPanel: (
    hostRef: ScopedThreadRef,
    input: OpenSessionPanelInput,
  ) => Promise<AgentSessionOpenInPanelResult | null>;
  activateSurface: (hostRef: ScopedThreadRef, groupId: string, surfaceId: string) => void;
  closeSurface: (hostRef: ScopedThreadRef, groupId: string, surface: CenterSurface) => void;
  closeOtherSurfaces: (hostRef: ScopedThreadRef, groupId: string, surface: CenterSurface) => void;
  closeSurfacesToRight: (hostRef: ScopedThreadRef, groupId: string, surface: CenterSurface) => void;
  closeAllSurfaces: (hostRef: ScopedThreadRef, groupId: string) => void;
}

export interface CenterPanelActionsOptions {
  readonly onCloseTerminal: (
    hostRef: ScopedThreadRef,
    surface: Extract<CenterSurface, { kind: "terminal" }>,
  ) => void;
}

/** Reopening and activating panel threads, for the chat view and the Import dialog. */
export function usePanelThreadOpener(): PanelThreadOpener {
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });

  const reopenChatPanel = useCallback(
    async (hostRef: ScopedThreadRef, threadId: ThreadId, providerLabel: string): Promise<void> => {
      const environmentId = hostRef.environmentId;
      useCenterPanelStore.getState().reserveChatPanel(hostRef, threadId, providerLabel);
      const result = await unarchiveThread({ environmentId, input: { threadId } });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const panelRef = scopeThreadRef(environmentId, threadId);
      // Another client reopened it first: the tab is valid and adoption already tracks it.
      if (readThreadShell(panelRef)?.archivedAt === null) {
        useCenterPanelStore.getState().releaseChatPanelReservation(panelRef);
        return;
      }
      useCenterPanelStore.getState().removeThread(panelRef);
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to reopen chat panel",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [unarchiveThread],
  );

  const openPanelThread = useCallback(
    async (
      hostRef: ScopedThreadRef,
      threadId: ThreadId,
      label: string,
      archived?: boolean,
    ): Promise<void> => {
      const closed =
        archived ??
        readThreadShell(scopeThreadRef(hostRef.environmentId, threadId))?.archivedAt !== null;
      if (closed) {
        await reopenChatPanel(hostRef, threadId, label);
        return;
      }
      useCenterPanelStore.getState().openChatPanel(hostRef, threadId, label);
    },
    [reopenChatPanel],
  );

  return { reopenChatPanel, openPanelThread };
}

/**
 * Clears the host draft a `:btw` submitted, only while it still holds exactly that text and
 * nothing else: an edit made meanwhile is the user's and stays.
 */
function clearSubmittedHostDraft(hostRef: ScopedThreadRef, submittedText: string): void {
  const drafts = useComposerDraftStore.getState();
  const draft = drafts.getComposerDraft(hostRef);
  if (
    !draft ||
    draft.prompt !== submittedText ||
    draft.attachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.elementContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0
  ) {
    return;
  }
  drafts.setPrompt(hostRef, "");
}

export function useCenterPanelActions({
  onCloseTerminal,
}: CenterPanelActionsOptions): CenterPanelActions {
  const createPanel = useAtomCommand(worktreeEnvironment.createPanel, { reportFailure: false });
  const archiveThread = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const openInPanel = useAtomCommand(projectEnvironment.openAgentSessionInPanel, {
    reportFailure: false,
  });
  const { reopenChatPanel, openPanelThread } = usePanelThreadOpener();

  const archivePanelThread = useCallback(
    async (environmentId: EnvironmentId, threadId: ThreadId) => {
      const session = readThreadShell(scopeThreadRef(environmentId, threadId))?.session;
      if (session?.status === "running") {
        // Best effort: an interrupt that fails must not keep the closed panel live.
        await interruptTurn({
          environmentId,
          input: {
            threadId,
            ...(session.activeTurnId !== null ? { turnId: session.activeTurnId } : {}),
          },
        });
      }
      const result = await archiveThread({ environmentId, input: { threadId } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to close chat panel",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return result._tag === "Success";
    },
    [archiveThread, interruptTurn],
  );

  /**
   * Reserves the tab, then creates the panel. `created` false: the outcome is unknown (the
   * tab stays for adoption) or the tab closed meanwhile (the panel is archived once it exists).
   */
  const createPanelThread = useCallback(
    async (
      input: CreateChatPanelInput,
      sideChat: boolean,
      focusComposer = false,
    ): Promise<{ readonly threadId: ThreadId; readonly created: boolean } | null> => {
      const { hostRef, modelSelection, providerLabel } = input;
      const environmentId = hostRef.environmentId;
      const threadId = newThreadId();
      const panelRef = { environmentId, threadId } satisfies ScopedThreadRef;
      const label = sideChat ? sideChatLabel(providerLabel) : providerLabel;
      useCenterPanelStore.getState().reserveChatPanel(hostRef, threadId, label);
      if (focusComposer) composerFocusRequests.add(scopedThreadKey(panelRef));
      const result = await createPanel({
        environmentId,
        input: {
          commandId: newCommandId(),
          hostThreadId: hostRef.threadId,
          threadId,
          title: `Panel: ${label}`,
          threadDefaults: {
            modelSelection,
            // A side chat asks before it edits the host's checkout; its picker can change it.
            runtimeMode: sideChat ? "approval-required" : DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          },
          ...(sideChat ? { sideChat: true } : {}),
        },
      });
      const store = useCenterPanelStore.getState();
      const closed = store.closedBeforeCreated.includes(scopedThreadKey(panelRef));
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return { threadId, created: false };
        }
        composerFocusRequests.delete(scopedThreadKey(panelRef));
        if (closed) store.clearClosedBeforeCreated(panelRef);
        store.removeThread(panelRef);
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open chat panel",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return null;
      }
      if (closed) {
        store.releaseChatPanelReservation(panelRef);
        const archived = await archivePanelThread(environmentId, threadId);
        if (archived) useCenterPanelStore.getState().clearClosedBeforeCreated(panelRef);
        return { threadId, created: false };
      }
      return { threadId, created: true };
    },
    [archivePanelThread, createPanel],
  );

  const createChatPanel = useCallback(
    async (input: CreateChatPanelInput): Promise<ThreadId | null> =>
      (await createPanelThread(input, false))?.threadId ?? null,
    [createPanelThread],
  );

  const createSideChat = useCallback(
    async (input: CreateSideChatInput): Promise<ThreadId | null> => {
      const { hostRef, question, submittedText } = input;
      const hostKey = scopedThreadKey(hostRef);
      if (pendingSideChatHosts.has(hostKey)) return null;
      pendingSideChatHosts.add(hostKey);
      try {
        // An empty side chat is opened to type in.
        const panel = await createPanelThread(input, true, question.length === 0);
        // Not created, or closed meanwhile: nothing is sent and the host draft keeps the text.
        if (!panel?.created) return panel?.threadId ?? null;
        const sideRef = scopeThreadRef(hostRef.environmentId, panel.threadId);
        if (question.length > 0) {
          // The side chat's own draft is never written on success: what the user types or
          // attaches there meanwhile stays.
          const result = await startTurn({
            environmentId: hostRef.environmentId,
            input: {
              threadId: panel.threadId,
              message: { messageId: newMessageId(), role: "user", text: question, attachments: [] },
              modelSelection: input.modelSelection,
              runtimeMode: "approval-required",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            },
          });
          // The send may have landed: the `:btw` text stays in the host draft, nothing is lost.
          if (result._tag === "Failure" && isAtomCommandInterrupted(result)) {
            return panel.threadId;
          }
          if (result._tag === "Failure") {
            const drafts = useComposerDraftStore.getState();
            const current = drafts.getComposerDraft(sideRef)?.prompt ?? "";
            drafts.setPrompt(
              sideRef,
              current === question ? current : [current, question].filter(Boolean).join("\n\n"),
            );
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: SIDE_CHAT_SEND_FAILED_TITLE,
                description: SIDE_CHAT_SEND_FAILED_DESCRIPTION,
              }),
            );
          }
        }
        if (submittedText !== undefined) clearSubmittedHostDraft(hostRef, submittedText);
        return panel.threadId;
      } finally {
        pendingSideChatHosts.delete(hostKey);
      }
    },
    [createPanelThread, startTurn],
  );

  const openSessionPanel = useCallback(
    async (
      hostRef: ScopedThreadRef,
      input: OpenSessionPanelInput,
    ): Promise<AgentSessionOpenInPanelResult | null> => {
      const openKey = JSON.stringify([
        hostRef.environmentId,
        hostRef.threadId,
        input.sessionId,
        input.mode,
      ]);
      const commandId = unsettledSessionOpens.get(openKey) ?? newCommandId();
      unsettledSessionOpens.set(openKey, commandId);
      const result = await openInPanel({
        environmentId: hostRef.environmentId,
        input: {
          commandId,
          hostThreadId: hostRef.threadId,
          sessionId: input.sessionId,
          mode: input.mode,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          if (isServerRefusal(error)) {
            unsettledSessionOpens.delete(openKey);
          }
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Couldn't open the session",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return null;
      }
      unsettledSessionOpens.delete(openKey);
      const opened = result.value;
      if (opened.hostThreadId === hostRef.threadId) {
        if (opened.outcome === "created") {
          useCenterPanelStore.getState().openChatPanel(hostRef, opened.threadId, input.title);
        } else {
          await openPanelThread(hostRef, opened.threadId, input.title);
        }
      }
      return opened;
    },
    [openInPanel, openPanelThread],
  );

  const cleanupRemoved = useCallback(
    (hostRef: ScopedThreadRef, removed: readonly CenterSurface[]) => {
      for (const surface of removed) {
        if (surface.kind === "chat") {
          const panelRef = scopeThreadRef(hostRef.environmentId, surface.threadId);
          const store = useCenterPanelStore.getState();
          // The server may not have created it yet, so it cannot be archived now: its open
          // archives it once it settles, and adoption does after a reload.
          if (store.pendingChatPanelThreadKeys.has(scopedThreadKey(panelRef))) {
            store.recordClosedBeforeCreated(panelRef);
            continue;
          }
          store.releaseChatPanelReservation(panelRef);
          void archivePanelThread(hostRef.environmentId, surface.threadId);
        } else if (surface.kind === "terminal") {
          onCloseTerminal(hostRef, surface);
        }
      }
    },
    [archivePanelThread, onCloseTerminal],
  );

  const activateSurface = useCallback(
    (hostRef: ScopedThreadRef, groupId: string, surfaceId: string) => {
      useCenterPanelStore.getState().activateSurface(hostRef, groupId, surfaceId);
    },
    [],
  );

  const closeSurface = useCallback(
    (hostRef: ScopedThreadRef, groupId: string, surface: CenterSurface) => {
      cleanupRemoved(
        hostRef,
        useCenterPanelStore.getState().closeSurface(hostRef, groupId, surface.id),
      );
    },
    [cleanupRemoved],
  );

  const closeOtherSurfaces = useCallback(
    (hostRef: ScopedThreadRef, groupId: string, surface: CenterSurface) => {
      cleanupRemoved(
        hostRef,
        useCenterPanelStore.getState().closeOtherSurfaces(hostRef, groupId, surface.id),
      );
    },
    [cleanupRemoved],
  );

  const closeSurfacesToRight = useCallback(
    (hostRef: ScopedThreadRef, groupId: string, surface: CenterSurface) => {
      cleanupRemoved(
        hostRef,
        useCenterPanelStore.getState().closeSurfacesToRight(hostRef, groupId, surface.id),
      );
    },
    [cleanupRemoved],
  );

  const closeAllSurfaces = useCallback(
    (hostRef: ScopedThreadRef, groupId: string) => {
      cleanupRemoved(hostRef, useCenterPanelStore.getState().closeAllSurfaces(hostRef, groupId));
    },
    [cleanupRemoved],
  );

  return {
    createChatPanel,
    createSideChat,
    reopenChatPanel,
    openPanelThread,
    openSessionPanel,
    activateSurface,
    closeSurface,
    closeOtherSurfaces,
    closeSurfacesToRight,
    closeAllSurfaces,
  };
}
