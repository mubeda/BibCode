import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { ScopedThreadRef } from "@bibcode/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface SourceControlDraft {
  message: string;
  /**
   * The draft another tab saved for this folder while this one was typing (#219): the newer
   * edit is `message`, and the other stays here until the person swaps to it or dismisses it.
   */
  otherWindowMessage?: string;
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
  /** Puts the other tab's version in the box, keeping this one as the other version. */
  swapCwdOtherWindowMessage: (cwdKey: string) => void;
  /** Keeps the message in the box and drops the other tab's version. */
  dismissCwdOtherWindowMessage: (cwdKey: string) => void;
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
  /**
   * A commit landed with suggestion `intentId`'s message: it is handled, and the draft goes
   * when it is still that message, untouched. Text the person edited stays.
   */
  retireCommittedAgentSuggestion: (cwdKey: string, intentId: string, message: string) => void;
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
 * Sets this tab's state without saving it, to take in what another tab saved. Captured from
 * `create`, outside `persist`.
 */
let setWithoutSaving: (partial: Partial<SourceControlPanelStoreState>) => void = () => {};

type PersistedState = Pick<
  SourceControlPanelStoreState,
  "byThreadKey" | "byCwdKey" | "agentSuggestionByCwdKey" | "sourceControlGroupByFolder"
>;

const persistedFields = (state: PersistedState): PersistedState => ({
  byThreadKey: state.byThreadKey,
  byCwdKey: state.byCwdKey,
  agentSuggestionByCwdKey: state.agentSuggestionByCwdKey,
  sourceControlGroupByFolder: state.sourceControlGroupByFolder,
});

/**
 * What this tab last saved or loaded (#219). An entry that differs from it is this tab's own
 * change; every other entry is written as storage has it, so another tab's folders survive.
 */
let synced: PersistedState | null = null;

/** `saved` with the entries this tab changed from `base` to `next`, each settled by `resolve`. */
function mergeEntries<T>(
  base: Record<string, T>,
  next: Record<string, T>,
  saved: Record<string, T>,
  resolve: (ours: T | undefined, theirs: T | undefined, base: T | undefined) => T | undefined = (
    ours,
  ) => ours,
): Record<string, T> {
  let result = saved;
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (base[key] === next[key]) continue;
    // Re-adding the key moves it last, the order `rememberSuggestion` keeps newest.
    const { [key]: _replaced, ...others } = result;
    const value = resolve(next[key], saved[key], base[key]);
    result = value === undefined ? others : { ...others, [key]: value };
  }
  return result;
}

/**
 * This tab's change to a folder's draft, against what another tab saved since this one last
 * synced. The newer edit wins; the other tab's text is kept as `otherWindowMessage`, and a
 * clear never deletes text another tab typed meanwhile.
 */
function resolveDraft(
  ours: SourceControlDraft | undefined,
  theirs: SourceControlDraft | undefined,
  base: SourceControlDraft | undefined,
): SourceControlDraft | undefined {
  const theirText = theirs?.message ?? "";
  if (theirText === (base?.message ?? "") || theirText.trim() === "") return ours;
  if (theirText === ours?.message) return ours;
  if (ours === undefined || ours.message.trim() === "") return theirs;
  return { ...ours, otherWindowMessage: theirText };
}

/** What to save: this tab's changes since it last synced, over what storage holds now. */
function mergeWithSaved(state: PersistedState): PersistedState {
  const next = persistedFields(state);
  const saved = readSavedState();
  const base = synced;
  if (saved === null || base === null) {
    synced = next;
    return next;
  }
  const merged: PersistedState = {
    byThreadKey: mergeEntries(base.byThreadKey, next.byThreadKey, saved.byThreadKey ?? {}),
    byCwdKey: mergeEntries(base.byCwdKey, next.byCwdKey, saved.byCwdKey ?? {}, resolveDraft),
    agentSuggestionByCwdKey: mergeEntries(
      base.agentSuggestionByCwdKey,
      next.agentSuggestionByCwdKey,
      saved.agentSuggestionByCwdKey ?? {},
    ),
    sourceControlGroupByFolder:
      next.sourceControlGroupByFolder !== base.sourceControlGroupByFolder
        ? next.sourceControlGroupByFolder
        : (saved.sourceControlGroupByFolder ?? next.sourceControlGroupByFolder),
  };
  // This tab now shows what it saved, other tabs' entries included. A field that came out the
  // same keeps this tab's objects: effects watching them must not run again on every save.
  const taken: Partial<PersistedState> = {};
  const result = { ...merged };
  for (const field of Object.keys(merged) as Array<keyof PersistedState>) {
    if (JSON.stringify(merged[field]) === JSON.stringify(next[field])) {
      Object.assign(result, { [field]: next[field] });
    } else {
      Object.assign(taken, { [field]: merged[field] });
    }
  }
  synced = result;
  if (Object.keys(taken).length > 0) setWithoutSaving(taken);
  return result;
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
          [cwdKey]: { ...state.byCwdKey[cwdKey], message },
        },
      })),
    clearCwdDraft: (cwdKey) =>
      set((state) => {
        if (!(cwdKey in state.byCwdKey)) return state;
        const { [cwdKey]: _removed, ...byCwdKey } = state.byCwdKey;
        return { byCwdKey };
      }),
    swapCwdOtherWindowMessage: (cwdKey) =>
      set((state) => {
        const draft = state.byCwdKey[cwdKey];
        if (draft?.otherWindowMessage === undefined) return state;
        const swapped = { message: draft.otherWindowMessage, otherWindowMessage: draft.message };
        return { byCwdKey: { ...state.byCwdKey, [cwdKey]: swapped } };
      }),
    dismissCwdOtherWindowMessage: (cwdKey) =>
      set((state) => {
        const draft = state.byCwdKey[cwdKey];
        if (draft?.otherWindowMessage === undefined) return state;
        return { byCwdKey: { ...state.byCwdKey, [cwdKey]: { message: draft.message } } };
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
      // Another tab typed in this folder, or handled this suggestion: offer, write nothing.
      if (
        saved !== null &&
        (hasText(saved.byCwdKey?.[cwdKey]) ||
          saved.agentSuggestionByCwdKey?.[cwdKey]?.intentId === intentId)
      ) {
        return;
      }
      // Only this folder's keys change in what is saved (`mergeWithSaved`).
      set((current) => fill(current));
    },
    acceptAgentCommitSuggestion: (cwdKey, intentId, message) =>
      set((state) => {
        if (isHandled(state, cwdKey, intentId)) return state;
        return {
          byCwdKey: { ...state.byCwdKey, [cwdKey]: { ...state.byCwdKey[cwdKey], message } },
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
          byCwdKey: {
            ...state.byCwdKey,
            [cwdKey]: { ...state.byCwdKey[cwdKey], message: suggestion.replacedDraft ?? "" },
          },
          agentSuggestionByCwdKey: rememberSuggestion(state.agentSuggestionByCwdKey, cwdKey, {
            intentId,
            outcome: "dismissed",
          }),
        };
      }),
    retireCommittedAgentSuggestion: (cwdKey, intentId, message) =>
      set((state) => {
        const record = state.agentSuggestionByCwdKey[cwdKey];
        if (record?.intentId === intentId && record.outcome === "dismissed") return state;
        const retired = {
          agentSuggestionByCwdKey: rememberSuggestion(state.agentSuggestionByCwdKey, cwdKey, {
            intentId,
            outcome: "dismissed",
          }),
        };
        // Only a draft the suggestion filled, or that Use it put in, is the agent's text: the
        // person may have typed the same words, and an offered suggestion never touched them.
        const handled = agentSuggestionOutcome(record, intentId);
        const fromSuggestion = handled === "filled" || handled === "used";
        if (!fromSuggestion || state.byCwdKey[cwdKey]?.message !== message) return retired;
        const { [cwdKey]: _committed, ...byCwdKey } = state.byCwdKey;
        return { ...retired, byCwdKey };
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
    // Every save writes only what this tab changed, entry by entry (#219).
    partialize: (state) => mergeWithSaved(state) as SourceControlPanelStoreState,
    onRehydrateStorage: () => (state) => {
      if (state !== undefined) synced = persistedFields(state);
    },
  },
);

export const useSourceControlPanelStore = create<SourceControlPanelStoreState>()(((
  ...args: Parameters<typeof persistedStore>
) => {
  const [rawSet] = args;
  setWithoutSaving = (partial) => rawSet(partial);
  return persistedStore(...args);
}) as typeof persistedStore);

// Another tab saved: show what it wrote, so this tab builds on it (#219). Not `rehydrate()`:
// that saves back, which could ping-pong between tabs, or loop where a save fires `storage`.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_NAME && event.key !== null) return;
    const saved = readSavedState();
    if (saved === null) return;
    const state = useSourceControlPanelStore.getState();
    const next: PersistedState = {
      byThreadKey: saved.byThreadKey ?? {},
      byCwdKey: saved.byCwdKey ?? {},
      agentSuggestionByCwdKey: saved.agentSuggestionByCwdKey ?? {},
      sourceControlGroupByFolder:
        saved.sourceControlGroupByFolder ?? state.sourceControlGroupByFolder,
    };
    synced = next;
    setWithoutSaving(next);
  });
}

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
