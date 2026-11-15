/**
 * What a person has half-done in Send to agent, in memory only: the note of each panel's
 * preview (kept when the preview closes), and, per send, the request id and the panel created
 * for a new-panel target, so that a retry after a lost connection sends the same request to the
 * same panel and the agent receives it once.
 */
import type { ThreadId } from "@bibcode/contracts";
import { create } from "zustand";

import type { SendToAgentSource } from "./components/sendToAgent/sendToAgent.logic";

interface SendToAgentState {
  notes: Record<string, string>;
  pending: Record<string, { argsKey: string; requestId: string }>;
  panels: Record<string, ThreadId>;
  setNote: (key: string, note: string) => void;
  /** Clears the note; with `ifEquals`, only while it is still that text. */
  clearNote: (key: string, ifEquals?: string) => void;
  /** The pending id while `argsKey` is unchanged, else a new id from `newId`. */
  requestIdFor: (key: string, argsKey: string, newId: () => string) => string;
  panelFor: (key: string) => ThreadId | null;
  rememberPanel: (key: string, threadId: ThreadId) => void;
  /**
   * The send of `sent.requestId` finished: forget its pending id, its new panel (`panelKey`) and
   * its note, each only while it still belongs to that send, so a late completion cannot erase
   * what a reopened preview has since started.
   */
  settle: (key: string, sent: { requestId: string; note: string; panelKey: string | null }) => void;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useSendToAgentStore = create<SendToAgentState>((set, get) => ({
  notes: {},
  pending: {},
  panels: {},
  setNote: (key, note) => set((state) => ({ notes: { ...state.notes, [key]: note } })),
  clearNote: (key, ifEquals) =>
    set((state) =>
      ifEquals === undefined || state.notes[key] === ifEquals
        ? { notes: without(state.notes, key) }
        : state,
    ),
  requestIdFor: (key, argsKey, newId) => {
    const known = get().pending[key];
    if (known !== undefined && known.argsKey === argsKey) return known.requestId;
    const requestId = newId();
    set((state) => ({ pending: { ...state.pending, [key]: { argsKey, requestId } } }));
    return requestId;
  },
  panelFor: (key) => get().panels[key] ?? null,
  rememberPanel: (key, threadId) =>
    set((state) => ({ panels: { ...state.panels, [key]: threadId } })),
  settle: (key, sent) =>
    set((state) => {
      const ours = state.pending[key]?.requestId === sent.requestId;
      return {
        pending: ours ? without(state.pending, key) : state.pending,
        panels:
          ours && sent.panelKey !== null ? without(state.panels, sent.panelKey) : state.panels,
        notes: state.notes[key] === sent.note ? without(state.notes, key) : state.notes,
      };
    }),
}));

/** One key per panel or terminal, so two panels open side by side keep separate notes. */
export function sendSourceKey(
  source: Pick<SendToAgentSource, "environmentId" | "threadId" | "terminalId">,
): string {
  return `${source.environmentId}:${source.threadId}:${source.terminalId ?? ""}`;
}
