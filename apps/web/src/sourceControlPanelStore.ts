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
 * it `filled` an empty draft, was `offered` beside a draft with text, or the person `used` or
 * `dismissed` it. Remembered by intent id, so a suggestion the server still holds never fills
 * the draft again after a commit cleared it.
 */
export type AgentCommitSuggestionOutcome = "filled" | "offered" | "used" | "dismissed";

export interface AgentCommitSuggestion {
  readonly intentId: string;
  readonly outcome: AgentCommitSuggestionOutcome;
  /** What **Use it** replaced, so **Undo** can put the person's words back. */
  readonly replacedDraft?: string;
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
   * A suggestion arrived: fill an empty draft, else offer it. Each intent is handled once. The
   * thread's draft from before folder drafts (`legacyThreadKey`) is promoted first, and what
   * another tab saved is read again, so a suggestion never takes the place of typed words.
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

/**
 * Applies an arriving suggestion. A draft with text, the person's or an earlier suggestion's,
 * is never overwritten; the suggestion is offered beside it instead.
 */
function receiveSuggestion(
  state: SourceControlPanelStoreState,
  cwdKey: string,
  intentId: string,
  message: string,
): Partial<SourceControlPanelStoreState> {
  if (state.agentSuggestionByCwdKey[cwdKey]?.intentId === intentId) return {};
  const draft = state.byCwdKey[cwdKey]?.message ?? "";
  if (draft.trim().length > 0) {
    return {
      agentSuggestionByCwdKey: rememberSuggestion(state.agentSuggestionByCwdKey, cwdKey, {
        intentId,
        outcome: "offered",
      }),
    };
  }
  return {
    byCwdKey: { ...state.byCwdKey, [cwdKey]: { message } },
    agentSuggestionByCwdKey: rememberSuggestion(state.agentSuggestionByCwdKey, cwdKey, {
      intentId,
      outcome: "filled",
    }),
  };
}

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

type SavedDrafts = Pick<SourceControlPanelStoreState, "byCwdKey" | "agentSuggestionByCwdKey">;

/**
 * The folder drafts and suggestions saved to storage now, which another tab may have written
 * since this one loaded; `null` when there are none of this version, or storage reads later.
 */
function readSavedDrafts(): SavedDrafts | null {
  const saved = useSourceControlPanelStore.persist.getOptions().storage?.getItem(STORAGE_NAME);
  if (saved === null || saved === undefined || saved instanceof Promise) return null;
  if (saved.version !== STORAGE_VERSION) return null;
  const state = saved.state as Partial<SavedDrafts> | undefined;
  return {
    byCwdKey: state?.byCwdKey ?? {},
    agentSuggestionByCwdKey: state?.agentSuggestionByCwdKey ?? {},
  };
}

/**
 * Applies an arriving suggestion against what is saved, not only this tab's memory: the saved
 * folder drafts and suggestion records are taken as they are (another tab may have typed or
 * handled the suggestion since this one loaded), and only this folder changes. A draft with
 * text in this tab, a promoted legacy draft included, is kept over the saved one.
 */
function receiveAgainstSaved(
  state: SourceControlPanelStoreState,
  cwdKey: string,
  intentId: string,
  message: string,
): Partial<SourceControlPanelStoreState> {
  const saved = readSavedDrafts();
  if (saved === null) return receiveSuggestion(state, cwdKey, intentId, message);
  const own = state.byCwdKey[cwdKey];
  const draft = own !== undefined && own.message.trim().length > 0 ? own : saved.byCwdKey[cwdKey];
  const { [cwdKey]: _stale, ...savedOthers } = saved.byCwdKey;
  const merged: SourceControlPanelStoreState = {
    ...state,
    byCwdKey: draft === undefined ? savedOthers : { ...savedOthers, [cwdKey]: draft },
    agentSuggestionByCwdKey: { ...state.agentSuggestionByCwdKey, ...saved.agentSuggestionByCwdKey },
  };
  return {
    byThreadKey: merged.byThreadKey,
    byCwdKey: merged.byCwdKey,
    agentSuggestionByCwdKey: merged.agentSuggestionByCwdKey,
    ...receiveSuggestion(merged, cwdKey, intentId, message),
  };
}

function updateDraft(
  state: SourceControlPanelStoreState,
  ref: ScopedThreadRef,
  updater: (draft: SourceControlDraft) => SourceControlDraft,
): { byThreadKey: Record<string, SourceControlDraft> } {
  const key = scopedThreadKey(ref);
  const previous = state.byThreadKey[key] ?? DEFAULT_DRAFT;
  return { byThreadKey: { ...state.byThreadKey, [key]: updater(previous) } };
}

export const useSourceControlPanelStore = create<SourceControlPanelStoreState>()(
  persist(
    (set) => ({
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
        set((state) =>
          threadKey in state.byThreadKey ? promote(state, threadKey, cwdKey) : state,
        ),
      receiveAgentCommitSuggestion: (cwdKey, intentId, message, legacyThreadKey) =>
        set((state) => {
          const legacy = legacyThreadKey !== undefined && legacyThreadKey in state.byThreadKey;
          // Handled here already: nothing to read or write.
          if (!legacy && state.agentSuggestionByCwdKey[cwdKey]?.intentId === intentId) {
            return state;
          }
          const promoted = legacy
            ? { ...state, ...promote(state, legacyThreadKey, cwdKey) }
            : state;
          return receiveAgainstSaved(promoted, cwdKey, intentId, message);
        }),
      acceptAgentCommitSuggestion: (cwdKey, intentId, message) =>
        set((state) => {
          if (state.agentSuggestionByCwdKey[cwdKey]?.intentId !== intentId) return state;
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
          if (state.agentSuggestionByCwdKey[cwdKey]?.intentId !== intentId) return state;
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
        };
      },
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        byCwdKey: state.byCwdKey,
        agentSuggestionByCwdKey: state.agentSuggestionByCwdKey,
        sourceControlGroupByFolder: state.sourceControlGroupByFolder,
      }),
    },
  ),
);

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
