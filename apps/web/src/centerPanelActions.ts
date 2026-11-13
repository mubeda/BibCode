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
 * A close hides the panel from adoption while this page archives it, or while
 * the creation it waits on is in flight (`centerPanelClose`); a creation closed
 * meanwhile never sends its first question. A side chat (#265) is a panel the
 * server seeds with the host's messages; `:btw` sends its question once it exists.
 * Closing a side chat nobody sent to deletes it instead of archiving it, where the server
 * can refuse a used one; a refusal archives it.
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
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@bibcode/contracts";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "@bibcode/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  archiveClosingChatPanel,
  closesByUnusedDelete,
  hideClosingChatPanel,
  markChatPanelSent,
  releaseUncreatedChatPanel,
} from "~/centerPanelClose";
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

/** A chat panel that starts with a prompt and its own modes: a code review (#293). */
export interface CreatePromptedChatPanelInput extends CreateChatPanelInput {
  /** The tab label; the thread title is this behind the panel prefix. */
  readonly label: string;
  readonly prompt: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly codeReview: boolean;
}

export const CODE_REVIEW_SEND_FAILED_TITLE = "Couldn't start the review";
export const CODE_REVIEW_SEND_FAILED_DESCRIPTION = "The review prompt is in its composer.";

export const SIDE_CHAT_SEND_FAILED_TITLE = "Couldn't send to the side chat";
export const SIDE_CHAT_SEND_FAILED_DESCRIPTION = "Your question is in its composer.";

/** The tab label of a side chat; its thread title is this behind the panel prefix. */
export const sideChatLabel = (providerLabel: string) => `Side chat · ${providerLabel}`;

/** Hosts with a side chat being created, so a second Enter on the same `:btw` opens nothing. */
const pendingSideChatHosts = new Set<string>();
/** Hosts with a prompted panel (a review) being created, so a double click opens one. */
const pendingPromptedPanelHosts = new Set<string>();

/** What a new panel thread starts with, and the flags the server keeps on it. */
interface PanelThreadKind {
  readonly sideChat: boolean;
  readonly codeReview: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const PLAIN_PANEL: PanelThreadKind = {
  sideChat: false,
  codeReview: false,
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
};
// A side chat asks before it edits the host's checkout; its picker can change it.
const SIDE_CHAT_PANEL: PanelThreadKind = {
  sideChat: true,
  codeReview: false,
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
};

/**
 * Each creation this page waits on, by scoped thread key: `closed` once its tab closed. The
 * creation's own continuation reads it, so a closed one never sends its first question.
 */
const creations = new Map<string, { closed: boolean }>();

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

/** `thread.delete` with `onlyIfUnused` refused: the thread was used. */
const isThreadInUse = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "OrchestrationThreadInUseError";

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
   * Opens a chat panel of `hostRef` with the given modes and sends `prompt` there. Resolves the
   * panel's thread, or `null` when none opened (one is already being created for this host, or
   * the creation failed and was shown).
   */
  createPromptedChatPanel: (input: CreatePromptedChatPanelInput) => Promise<ThreadId | null>;
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
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const openInPanel = useAtomCommand(projectEnvironment.openAgentSessionInPanel, {
    reportFailure: false,
  });
  const { reopenChatPanel, openPanelThread } = usePanelThreadOpener();

  /** Resolves the archive's event sequence once the server archived it, else `null`. */
  const archivePanelThread = useCallback(
    async ({ environmentId, threadId }: ScopedThreadRef): Promise<number | null> => {
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
      if (result._tag === "Success") return result.value.sequence;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to close chat panel",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return null;
    },
    [archiveThread, interruptTurn],
  );

  /**
   * Ends a closed panel: deletes a side chat nobody sent to, else archives it. Resolves the
   * event sequence of whichever the server did, or `null` for any other outcome.
   */
  const closePanelThread = useCallback(
    async (ref: ScopedThreadRef, sideChat: boolean): Promise<number | null> => {
      if (sideChat && closesByUnusedDelete(ref)) {
        const result = await deleteThread({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, onlyIfUnused: true },
        });
        if (result._tag === "Success") return result.value.sequence;
        if (isAtomCommandInterrupted(result)) return null;
        const error = squashAtomCommandFailure(result);
        // Anything else is reported as a failed archive would be; a used one is archived.
        if (!isThreadInUse(error)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to close chat panel",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return null;
        }
      }
      return archivePanelThread(ref);
    },
    [archivePanelThread, deleteThread],
  );

  /** Creates the reserved panel and settles a close made while it waited. */
  const settlePanelCreation = useCallback(
    async (
      input: CreateChatPanelInput,
      panelRef: ScopedThreadRef,
      label: string,
      kind: PanelThreadKind,
    ): Promise<{ readonly threadId: ThreadId; readonly created: boolean } | null> => {
      const { hostRef, modelSelection } = input;
      const { sideChat, codeReview } = kind;
      const { environmentId, threadId } = panelRef;
      const result = await createPanel({
        environmentId,
        input: {
          commandId: newCommandId(),
          hostThreadId: hostRef.threadId,
          threadId,
          title: `Panel: ${label}`,
          threadDefaults: {
            modelSelection,
            runtimeMode: kind.runtimeMode,
            interactionMode: kind.interactionMode,
          },
          ...(sideChat ? { sideChat: true } : {}),
          ...(codeReview ? { codeReview: true } : {}),
        },
      });
      const store = useCenterPanelStore.getState();
      const closed = creations.get(scopedThreadKey(panelRef))?.closed === true;
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        composerFocusRequests.delete(scopedThreadKey(panelRef));
        // Never created: a close made meanwhile ends with it.
        if (closed) releaseUncreatedChatPanel(panelRef);
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
      // Closed meanwhile (success, or an outcome that may have created it): archive it now,
      // just this once. Nobody else can have reopened a panel that was never archived.
      if (closed) {
        void archiveClosingChatPanel(panelRef, (ref) => closePanelThread(ref, sideChat));
      }
      return { threadId, created: result._tag === "Success" && !closed };
    },
    [closePanelThread, createPanel],
  );

  /**
   * Reserves the tab, then creates the panel. `created` false: the outcome is unknown (the
   * tab stays for adoption) or the tab closed meanwhile (the panel is archived once it exists).
   */
  const createPanelThread = useCallback(
    async (
      input: CreateChatPanelInput,
      kind: PanelThreadKind,
      label: string,
      focusComposer = false,
    ): Promise<{ readonly threadId: ThreadId; readonly created: boolean } | null> => {
      const { hostRef } = input;
      const environmentId = hostRef.environmentId;
      const threadId = newThreadId();
      const panelRef = { environmentId, threadId } satisfies ScopedThreadRef;
      useCenterPanelStore.getState().reserveChatPanel(hostRef, threadId, label);
      const key = scopedThreadKey(panelRef);
      creations.set(key, { closed: false });
      if (focusComposer) composerFocusRequests.add(key);
      return settlePanelCreation(input, panelRef, label, kind).finally(() => creations.delete(key));
    },
    [settlePanelCreation],
  );

  const createChatPanel = useCallback(
    async (input: CreateChatPanelInput): Promise<ThreadId | null> =>
      (await createPanelThread(input, PLAIN_PANEL, input.providerLabel))?.threadId ?? null,
    [createPanelThread],
  );

  /**
   * Sends a new panel's first message. A refused send puts the text in the panel's composer
   * and shows `failure`; resolves false only when the outcome is unknown.
   */
  const sendFirstPanelMessage = useCallback(
    async (
      input: CreateChatPanelInput,
      panelThreadId: ThreadId,
      text: string,
      kind: PanelThreadKind,
      failure: { readonly title: string; readonly description: string },
    ): Promise<boolean> => {
      const panelRef = scopeThreadRef(input.hostRef.environmentId, panelThreadId);
      // The panel's own draft is never written on success: what the user types or attaches
      // there meanwhile stays.
      markChatPanelSent(panelRef);
      const result = await startTurn({
        environmentId: input.hostRef.environmentId,
        input: {
          threadId: panelThreadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          modelSelection: input.modelSelection,
          runtimeMode: kind.runtimeMode,
          interactionMode: kind.interactionMode,
        },
      });
      if (result._tag === "Failure" && isAtomCommandInterrupted(result)) return false;
      if (result._tag === "Failure") {
        const drafts = useComposerDraftStore.getState();
        const current = drafts.getComposerDraft(panelRef)?.prompt ?? "";
        drafts.setPrompt(
          panelRef,
          current === text ? current : [current, text].filter(Boolean).join("\n\n"),
        );
        toastManager.add(stackedThreadToast({ type: "error", ...failure }));
      }
      return true;
    },
    [startTurn],
  );

  const openSideChat = useCallback(
    async (input: CreateSideChatInput): Promise<ThreadId | null> => {
      const { hostRef, question, submittedText, providerLabel } = input;
      // An empty side chat is opened to type in.
      const panel = await createPanelThread(
        input,
        SIDE_CHAT_PANEL,
        sideChatLabel(providerLabel),
        question.length === 0,
      );
      // Not created, or closed meanwhile: nothing is sent and the host draft keeps the text.
      if (!panel?.created) return panel?.threadId ?? null;
      if (question.length > 0) {
        const settled = await sendFirstPanelMessage(
          input,
          panel.threadId,
          question,
          SIDE_CHAT_PANEL,
          { title: SIDE_CHAT_SEND_FAILED_TITLE, description: SIDE_CHAT_SEND_FAILED_DESCRIPTION },
        );
        // The send may have landed: the `:btw` text stays in the host draft, nothing is lost.
        if (!settled) return panel.threadId;
      }
      if (submittedText !== undefined) clearSubmittedHostDraft(hostRef, submittedText);
      return panel.threadId;
    },
    [createPanelThread, sendFirstPanelMessage],
  );

  const openPromptedChatPanel = useCallback(
    async (input: CreatePromptedChatPanelInput): Promise<ThreadId | null> => {
      const kind: PanelThreadKind = {
        sideChat: false,
        codeReview: input.codeReview,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
      };
      const panel = await createPanelThread(input, kind, input.label);
      // Not created, or closed meanwhile: the prompt is not sent.
      if (!panel?.created) return panel?.threadId ?? null;
      await sendFirstPanelMessage(input, panel.threadId, input.prompt, kind, {
        title: CODE_REVIEW_SEND_FAILED_TITLE,
        description: CODE_REVIEW_SEND_FAILED_DESCRIPTION,
      });
      return panel.threadId;
    },
    [createPanelThread, sendFirstPanelMessage],
  );

  const createPromptedChatPanel = useCallback(
    async (input: CreatePromptedChatPanelInput): Promise<ThreadId | null> => {
      const hostKey = scopedThreadKey(input.hostRef);
      if (pendingPromptedPanelHosts.has(hostKey)) return null;
      pendingPromptedPanelHosts.add(hostKey);
      return openPromptedChatPanel(input).finally(() => pendingPromptedPanelHosts.delete(hostKey));
    },
    [openPromptedChatPanel],
  );

  const createSideChat = useCallback(
    async (input: CreateSideChatInput): Promise<ThreadId | null> => {
      const hostKey = scopedThreadKey(input.hostRef);
      if (pendingSideChatHosts.has(hostKey)) return null;
      pendingSideChatHosts.add(hostKey);
      return openSideChat(input).finally(() => pendingSideChatHosts.delete(hostKey));
    },
    [openSideChat],
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
          hideClosingChatPanel(panelRef);
          const creation = creations.get(scopedThreadKey(panelRef));
          // A panel still being created is archived when its creation answers.
          if (creation) creation.closed = true;
          else {
            const sideChat = readThreadShell(panelRef)?.sideChat === true;
            void archiveClosingChatPanel(panelRef, (ref) => closePanelThread(ref, sideChat));
          }
        } else if (surface.kind === "terminal") {
          onCloseTerminal(hostRef, surface);
        }
      }
    },
    [closePanelThread, onCloseTerminal],
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
    createPromptedChatPanel,
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
