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
 */
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type {
  AgentSessionOpenInPanelResult,
  AgentSessionOpenMode,
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
import { newCommandId, newThreadId } from "~/lib/utils";
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

/** A Claude Code terminal session History continues in a chat panel. */
export interface OpenSessionPanelInput {
  readonly sessionId: string;
  readonly mode: AgentSessionOpenMode;
  /** The session's title, which its tab shows. */
  readonly title: string;
}

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

export function useCenterPanelActions({
  onCloseTerminal,
}: CenterPanelActionsOptions): CenterPanelActions {
  const createPanel = useAtomCommand(worktreeEnvironment.createPanel, { reportFailure: false });
  const archiveThread = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
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
    },
    [archiveThread, interruptTurn],
  );

  const createChatPanel = useCallback(
    async (input: CreateChatPanelInput): Promise<ThreadId | null> => {
      const { hostRef, modelSelection, providerLabel } = input;
      const environmentId = hostRef.environmentId;
      const threadId = newThreadId();
      const panelRef = { environmentId, threadId } satisfies ScopedThreadRef;
      useCenterPanelStore.getState().reserveChatPanel(hostRef, threadId, providerLabel);
      const result = await createPanel({
        environmentId,
        input: {
          commandId: newCommandId(),
          hostThreadId: hostRef.threadId,
          threadId,
          title: `Panel — ${providerLabel}`,
          threadDefaults: {
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          },
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return threadId;
        }
        useCenterPanelStore.getState().removeThread(panelRef);
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
      return threadId;
    },
    [createPanel],
  );

  const openSessionPanel = useCallback(
    async (
      hostRef: ScopedThreadRef,
      input: OpenSessionPanelInput,
    ): Promise<AgentSessionOpenInPanelResult | null> => {
      const result = await openInPanel({
        environmentId: hostRef.environmentId,
        input: {
          commandId: newCommandId(),
          hostThreadId: hostRef.threadId,
          sessionId: input.sessionId,
          mode: input.mode,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
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
          useCenterPanelStore.getState().releaseChatPanelReservation({
            environmentId: hostRef.environmentId,
            threadId: surface.threadId,
          });
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
