import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { ScopedThreadRef } from "@bibcode/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface SourceControlDraft {
  message: string;
}

const DEFAULT_DRAFT: SourceControlDraft = { message: "" };

/**
 * What became of an outside agent's commit message suggestion for one folder (#139, slice X7):
 * it `filled` an empty draft, or the person `used` or `dismissed` it. Remembered by intent id,
 * so a suggestion the server still holds never fills the draft again after a commit cleared
 * it. A suggestion nobody handled is `offered`, and offering it records nothing.
 */
export type AgentCommitSuggestionOutcome = "filled" | "offered" | "used" | "dismissed";

export interface AgentCommitSuggestion {
  readonly intentId: string;
  readonly outcome: AgentCommitSuggestionOutcome;
  /** What **Use it** replaced, so **Undo** can put the person's words back. */
  readonly replacedDraft?: string;
}

/** What became of suggestion `intentId`, given its folder's record. */
export function agentSuggestionOutcome(
  record: AgentCommitSuggestion | undefined,
  intentId: string,
): AgentCommitSuggestionOutcome {
  return record?.intentId === intentId ? record.outcome : "offered";
}

/** Folders whose last suggestion is remembered; the server keeps one per folder for a day. */
const MOST_REMEMBERED_SUGGESTIONS = 128;

interface SourceControlPanelStoreState {
  byThreadKey: Record<string, SourceControlDraft>;
  byCwdKey: Record<string, SourceControlDraft>;
  agentSuggestionByCwdKey: Record<string, AgentCommitSuggestion>;
  /**
   * Changes view preference: pending files grouped under folder headers
   * (default) or one flat list. Panel-wide, not per section or per thread.
   */
  sourceControlGroupByFolder: boolean;
  setSourceControlGroupByFolder: (groupByFolder: boolean) => void;
  setMessage: (ref: ScopedThreadRef, message: string) => void;
  clearDraft: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
  setCwdMessage: (cwdKey: string, message: string) => void;
  clearCwdDraft: (cwdKey: string) => void;
  promoteThreadDraft: (threadKey: string, cwdKey: string) => void;
  /**
   * A suggestion arrived. The thread's draft from before folder drafts (`legacyThreadKey`) is
   * promoted first. The suggestion fills the folder's draft only when both this tab's draft
   * and the saved one are empty, and that fill writes only this folder's keys. Otherwise it is
   * offered, and nothing is written.
   */
  receiveAgentCommitSuggestion: (
    cwdKey: string,
    intentId: string,
    message: string,
    legacyThreadKey?: string,
  ) => void;
  /** The person chose **Use it**: the suggestion replaces the draft. */
  acceptAgentCommitSuggestion: (cwdKey: string, intentId: string, message: string) => void;
  /** The person chose **Undo** after **Use it**: the draft it replaced comes back. */
  undoAgentCommitSuggestion: (cwdKey: string, intentId: string) => void;
  dismissAgentCommitSuggestion: (cwdKey: string, intentId: string) => void;
}

/** `suggestions` with `cwdKey` set last, keeping the newest {@link MOST_REMEMBERED_SUGGESTIONS}. */
function rememberSuggestion(
  suggestions: Record<string, AgentCommitSuggestion>,
  cwdKey: string,
  suggestion: AgentCommitSuggestion,
): Record<string, AgentCommitSuggestion> {
  const { [cwdKey]: _previous, ...others } = suggestions;
  const entries = Object.entries(others);
  const kept = entries.slice(Math.max(0, entries.length - MOST_REMEMBERED_SUGGESTIONS + 1));
  return { ...Object.fromEntries(kept), [cwdKey]: suggestion };
}

/** Whether the person or an earlier fill already handled suggestion `intentId`. */
function isHandled(state: SourceControlPanelStoreState, cwdKey: string, intentId: string): boolean {
  return agentSuggestionOutcome(state.agentSuggestionByCwdKey[cwdKey], intentId) !== "offered";
}

const hasText = (draft: SourceControlDraft | undefined) =>
  draft !== undefined && draft.message.trim().length > 0;

/** Moves the thread's draft from before folder drafts to the folder, unless the folder has one. */
function promote(
  state: SourceControlPanelStoreState,
  threadKey: string,
  cwdKey: string,
): Partial<SourceControlPanelStoreState> {
  const legacyDraft = state.byThreadKey[threadKey];
  if (legacyDraft === undefined) return {};
  const { [threadKey]: _promoted, ...byThreadKey } = state.byThreadKey;
  if (cwdKey in state.byCwdKey || legacyDraft.message.length === 0) {
    return { byThreadKey };
  }
  return { byThreadKey, byCwdKey: { ...state.byCwdKey, [cwdKey]: { ...legacyDraft } } };
}

const STORAGE_NAME = "bibcode:source-control-panel-state:v1";
const STORAGE_VERSION = 2;

/** What is saved: the persisted fields, any of which an older or other tab may have left out. */
type SavedState = Partial<SourceControlPanelStoreState>;

/**
 * The state saved to storage now, which another tab may have written since this one loaded;
 * `null` when none of this version is saved, or storage answers later.
 */
function readSavedState(): SavedState | null {
  const saved = useSourceControlPanelStore.persist.getOptions().storage?.getItem(STORAGE_NAME);
  if (saved === null || saved === undefined || saved instanceof Promise) return null;
  if (saved.version !== STORAGE_VERSION) return null;
  const state: SavedState | undefined = saved.state;
  return state ?? {};
}

/**
 * Sets this tab's state without saving the whole of it, for a change already written to storage
 * key by key. Captured from `create`, outside `persist`.
 */
let setWithoutSaving: (partial: Partial<SourceControlPanelStoreState>) => void = () => {};

function updateDraft(
  state: SourceControlPanelStoreState,
  ref: ScopedThreadRef,
  updater: (draft: SourceControlDraft) => SourceControlDraft,
): { byThreadKey: Record<string, SourceControlDraft> } {
  const key = scopedThreadKey(ref);
  const previous = state.byThreadKey[key] ?? DEFAULT_DRAFT;
  return { byThreadKey: { ...state.byThreadKey, [key]: updater(previous) } };
}

const persistedStore = persist<SourceControlPanelStoreState>(
  (set, get) => ({
    byThreadKey: {},
    byCwdKey: {},
    agentSuggestionByCwdKey: {},
    sourceControlGroupByFolder: true,
    setSourceControlGroupByFolder: (groupByFolder) =>
      set(() => ({ sourceControlGroupByFolder: groupByFolder })),
    setMessage: (ref, message) =>
      set((state) => updateDraft(state, ref, (draft) => ({ ...draft, message }))),
    clearDraft: (ref) => set((state) => updateDraft(state, ref, () => ({ ...DEFAULT_DRAFT }))),
    removeThread: (ref) =>
      set((state) => {
        const key = scopedThreadKey(ref);
        if (!(key in state.byThreadKey)) return state;
        const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
        return { byThreadKey };
      }),
    setCwdMessage: (cwdKey, message) =>
      set((state) => ({
        byCwdKey: {
          ...state.byCwdKey,
          [cwdKey]: { message },
        },
      })),
    clearCwdDraft: (cwdKey) =>
      set((state) => {
        if (!(cwdKey in state.byCwdKey)) return state;
        const { [cwdKey]: _removed, ...byCwdKey } = state.byCwdKey;
        return { byCwdKey };
      }),
    promoteThreadDraft: (threadKey, cwdKey) =>
      set((state) => (threadKey in state.byThreadKey ? promote(state, threadKey, cwdKey) : state)),
    receiveAgentCommitSuggestion: (cwdKey, intentId, message, legacyThreadKey) => {
      if (legacyThreadKey !== undefined && legacyThreadKey in get().byThreadKey) {
        set((state) => promote(state, legacyThreadKey, cwdKey));
      }
      const state = get();
      // Handled already, or offered over this tab's text: nothing is written.
      if (isHandled(state, cwdKey, intentId) || hasText(state.byCwdKey[cwdKey])) return;
      const filled: AgentCommitSuggestion = { intentId, outcome: "filled" };
      const fill = (saved: Pick<SavedState, "byCwdKey" | "agentSuggestionByCwdKey">) => ({
        byCwdKey: { ...saved.byCwdKey, [cwdKey]: { message } },
        agentSuggestionByCwdKey: rememberSuggestion(
          saved.agentSuggestionByCwdKey ?? {},
          cwdKey,
          filled,
        ),
      });
      const saved = readSavedState();
      if (saved === null) {
        set((current) => fill(current));
        return;
      }
      // Another tab typed in this folder, or handled this suggestion: offer, write nothing.
      if (
        hasText(saved.byCwdKey?.[cwdKey]) ||
        saved.agentSuggestionByCwdKey?.[cwdKey]?.intentId === intentId
      ) {
        return;
      }
      // Only this folder's keys change in what is saved; other folders stay as saved.
      void useSourceControlPanelStore.persist.getOptions().storage?.setItem(STORAGE_NAME, {
        state: { ...saved, ...fill(saved) } as SourceControlPanelStoreState,
        version: STORAGE_VERSION,
      });
      setWithoutSaving(fill(state));
    },
    acceptAgentCommitSuggestion: (cwdKey, intentId, message) =>
      set((state) => {
        if (isHandled(state, cwdKey, intentId)) return state;
        return {
          byCwdKey: { ...state.byCwdKey, [cwdKey]: { message } },
          agentSuggestionByCwdKey: rememberSuggestion(state.agentSuggestionByCwdKey, cwdKey, {
            intentId,
            outcome: "used",
            replacedDraft: state.byCwdKey[cwdKey]?.message ?? "",
          }),
        };
      }),
    undoAgentCommitSuggestion: (cwdKey, intentId) =>
      set((state) => {
        const suggestion = state.agentSuggestionByCwdKey[cwdKey];
        if (suggestion?.intentId !== intentId || suggestion.outcome !== "used") return state;
        return {
          byCwdKey: { ...state.byCwdKey, [cwdKey]: { message: suggestion.replacedDraft ?? "" } },
          agentSuggestionByCwdKey: rememberSuggestion(state.agentSuggestionByCwdKey, cwdKey, {
            intentId,
            outcome: "dismissed",
          }),
        };
      }),
    dismissAgentCommitSuggestion: (cwdKey, intentId) =>
      set((state) => {
        if (isHandled(state, cwdKey, intentId)) return state;
        return {
          agentSuggestionByCwdKey: rememberSuggestion(state.agentSuggestionByCwdKey, cwdKey, {
            intentId,
            outcome: "dismissed",
          }),
        };
      }),
  }),
  {
    name: STORAGE_NAME,
    version: STORAGE_VERSION,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    migrate: (persistedState) => {
      const state = persistedState as Partial<SourceControlPanelStoreState> | undefined;
      // `sourceControlGroupByFolder` is intentionally absent: persist's shallow
      // merge keeps a stored value and falls back to the grouped default.
      return {
        byThreadKey: state?.byThreadKey ?? {},
        byCwdKey: state?.byCwdKey ?? {},
        agentSuggestionByCwdKey: state?.agentSuggestionByCwdKey ?? {},
      } as SourceControlPanelStoreState;
    },
    partialize: (state) =>
      ({
        byThreadKey: state.byThreadKey,
        byCwdKey: state.byCwdKey,
        agentSuggestionByCwdKey: state.agentSuggestionByCwdKey,
        sourceControlGroupByFolder: state.sourceControlGroupByFolder,
      }) as SourceControlPanelStoreState,
  },
);

export const useSourceControlPanelStore = create<SourceControlPanelStoreState>()(((
  ...args: Parameters<typeof persistedStore>
) => {
  const [rawSet] = args;
  setWithoutSaving = (partial) => rawSet(partial);
  return persistedStore(...args);
}) as typeof persistedStore);

export function selectThreadSourceControlDraft(
  byThreadKey: Record<string, SourceControlDraft>,
  ref: ScopedThreadRef | null | undefined,
): SourceControlDraft {
  if (!ref) return DEFAULT_DRAFT;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_DRAFT;
}

export function selectCwdSourceControlDraft(
  byCwdKey: Record<string, SourceControlDraft>,
  cwdKey: string,
): SourceControlDraft {
  return byCwdKey[cwdKey] ?? DEFAULT_DRAFT;
}
