/**
 * Adopts center panels other clients opened. Panel layout is per client, so
 * each client adds the AI terminals and chat panels the server reports for a
 * host thread when it first sees them, as inactive tabs. A later local close
 * is not undone by status updates, because adoption happens on first sight.
 * Only an explicit server `remove` drops a terminal tab; a reconnect or server
 * restart snapshot never does, so terminals can relaunch from their tab. A
 * tracked chat panel that leaves the live thread list (closed, so archived, or
 * deleted elsewhere) loses its tab, and is adopted again if it is reopened. A
 * capped list (#223) leaves finished panels out, so leaving it proves nothing:
 * the panel keeps its tab, and the lifecycle reconciler drops it once the server
 * reports it archived or missing. A panel this page is closing is left alone, and one whose
 * close ended is shown again, as on first sight, if it is still live (see `centerPanelClose`).
 */
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import {
  ThreadId,
  type EnvironmentId,
  type OrchestrationThreadShell,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@bibcode/contracts";

import { useCenterPanelStore } from "./centerPanelStore";
import { useRightPanelStore } from "./rightPanelStore";
import { isTerminalIdReserved } from "./terminalIdReservations";

export interface CenterPanelAdoptionTracker {
  readonly terminalKeys: Set<string>;
  readonly panelThreadIds: Set<string>;
}

export function createCenterPanelAdoptionTracker(): CenterPanelAdoptionTracker {
  return { terminalKeys: new Set(), panelThreadIds: new Set() };
}

// Panels titled before the colon form used an em dash; adoption still accepts both.
const PANEL_TITLE_PREFIX = /^Panel(?: \u2014|:) /u;

/** The provider label a chat panel thread was titled with, if it has one. */
export function panelProviderLabel(title: string): string | undefined {
  const prefix = PANEL_TITLE_PREFIX.exec(title);
  return prefix ? title.slice(prefix[0].length) : undefined;
}

const terminalKey = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;

function adoptTerminal(
  environmentId: EnvironmentId,
  tracker: CenterPanelAdoptionTracker,
  terminal: TerminalSummary,
): void {
  if (!terminal.centerPanel) return;
  const key = terminalKey(terminal.threadId, terminal.terminalId);
  const hostRef = scopeThreadRef(environmentId, ThreadId.make(terminal.threadId));
  const store = useCenterPanelStore.getState();
  // A tab this client still shows follows the command its process runs, so a
  // relaunch from it starts the same program; a closed tab is never re-added.
  store.syncTerminalPanelCommand(hostRef, terminal.terminalId, terminal.command);
  if (tracker.terminalKeys.has(key)) return;
  tracker.terminalKeys.add(key);
  // An in-flight local open places its own surface with the requested placement.
  if (isTerminalIdReserved(hostRef, terminal.terminalId)) return;
  const label = terminal.command?.label;
  store.adoptTerminalPanel(hostRef, terminal.terminalId, {
    ...(label !== undefined ? { label } : {}),
    ...(terminal.command !== undefined ? { command: terminal.command } : {}),
  });
}

export function applyTerminalMetadataAdoption(
  environmentId: EnvironmentId,
  tracker: CenterPanelAdoptionTracker,
  event: TerminalMetadataStreamEvent,
): void {
  switch (event.type) {
    case "snapshot":
      for (const terminal of event.terminals) adoptTerminal(environmentId, tracker, terminal);
      return;
    case "upsert":
      adoptTerminal(environmentId, tracker, event.terminal);
      return;
    case "remove":
      // Restart failures and server shutdown keep the tab so it can relaunch.
      if (event.reason !== undefined && event.reason !== "closed") return;
      tracker.terminalKeys.delete(terminalKey(event.threadId, event.terminalId));
      useCenterPanelStore
        .getState()
        .removeTerminalPanel(
          scopeThreadRef(environmentId, ThreadId.make(event.threadId)),
          event.terminalId,
        );
      // Another client closed it: drop this client's retained input binding
      // without a second server close. Loaded on demand, off the root bundle.
      void import("./components/ThreadTerminalPanel").then(({ releaseTerminalUiResources }) =>
        releaseTerminalUiResources(environmentId, event.threadId, event.terminalId),
      );
  }
}

export function applyPanelThreadAdoption(
  environmentId: EnvironmentId,
  tracker: CenterPanelAdoptionTracker,
  threads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "kind" | "hostThreadId" | "title" | "archivedAt">
  >,
  capped = false,
  /** Panels whose close ended, to show again while live (the store's, by default). */
  reshowChatPanels: ReadonlySet<string> = useCenterPanelStore.getState().reshowChatPanels,
  /** The server's engine sequence this shell reflects. */
  sequence?: number,
  /** Panels this page is closing (the store's, by default). */
  closingChatPanels: ReadonlyMap<string, number | null> = useCenterPanelStore.getState()
    .closingChatPanels,
  /**
   * The shell ends a publication: a whole snapshot, or the last item of a delta chunk (the one
   * that carries the shell's revision). Between per-thread deltas it may show a row as it was.
   */
  complete = true,
): void {
  const liveThreadIds = new Set<string>(
    threads.flatMap((thread) => (thread.archivedAt === null ? [thread.id] : [])),
  );
  // An archived panel stays hidden until this shell reaches its archive, decided by the
  // panel's own row (a row carries no sequence of its own): gone, it was archived; still live
  // in a shell that ends a publication, it was reopened, so it is shown again. A capped shell
  // may leave a live one out.
  for (const [key, archivedAt] of closingChatPanels) {
    const ref = parseScopedThreadKey(key);
    if (archivedAt === null || ref?.environmentId !== environmentId) continue;
    if (sequence === undefined || sequence < archivedAt) continue;
    const live = liveThreadIds.has(ref.threadId);
    if (live && !complete) continue;
    useCenterPanelStore.getState().releaseClosingChatPanel(ref, capped || live);
  }
  const store = useCenterPanelStore.getState();
  const reshown = new Set<string>();
  for (const thread of threads) {
    const hostThreadId = thread.hostThreadId;
    if (thread.kind !== "panel" || hostThreadId === undefined || thread.archivedAt !== null) {
      continue;
    }
    const panelKey = scopedThreadKey(scopeThreadRef(environmentId, thread.id));
    if (store.closingChatPanels.has(panelKey)) continue;
    if (reshowChatPanels.has(panelKey)) {
      reshown.add(panelKey);
      tracker.panelThreadIds.delete(thread.id);
    }
    if (tracker.panelThreadIds.has(thread.id) || !liveThreadIds.has(hostThreadId)) continue;
    tracker.panelThreadIds.add(thread.id);
    if (store.pendingChatPanelThreadKeys.has(panelKey)) continue;
    store.adoptChatPanel(
      scopeThreadRef(environmentId, hostThreadId),
      thread.id,
      panelProviderLabel(thread.title),
    );
  }
  // A reshown panel a full list leaves out was archived; either way the request is answered.
  if (!capped) {
    for (const key of reshowChatPanels) {
      if (parseScopedThreadKey(key)?.environmentId === environmentId) reshown.add(key);
    }
  }
  store.clearReshowChatPanels(reshown);
  for (const threadId of tracker.panelThreadIds) {
    if (liveThreadIds.has(threadId)) continue;
    tracker.panelThreadIds.delete(threadId);
    if (capped) continue;
    const panelRef = scopeThreadRef(environmentId, ThreadId.make(threadId));
    if (!store.pendingChatPanelThreadKeys.has(scopedThreadKey(panelRef))) {
      store.removeThread(panelRef);
      // Also drops a host Diff that showed this panel's thread.
      useRightPanelStore.getState().removeThread(panelRef);
    }
  }
}
