import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { ScopedThreadRef } from "@bibcode/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface SourceControlDraft {
  message: string;
  /**
   * Other versions of this folder's message that two windows wrote at once (#219), newest
   * first and at most {@link MOST_ALTERNATES}. They stay until the person uses or dismisses one.
   */
  alternates?: readonly string[];
}

/**
 * Alternates kept per folder. Past it the oldest is dropped, which only happens after more than
 * five unresolved concurrent edits of one folder's message.
 */
const MOST_ALTERNATES = 5;

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
  /**
   * A commit of `submitted` landed: the message goes only while it is still `submitted`, so text
   * typed since stays. Alternates stay too.
   */
  clearCwdDraft: (cwdKey: string, submitted: string) => void;
  /** Puts an alternate in the box; the message it replaces becomes an alternate. */
  useCwdAlternate: (cwdKey: string, alternate: string) => void;
  dismissCwdAlternate: (cwdKey: string, alternate: string) => void;
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
  return { byThreadKey, byCwdKey: putDraft(state, cwdKey, legacyDraft.message) };
}

const STORAGE_NAME = "bibcode:source-control-panel-state:v1";
const STORAGE_VERSION = 3;

/**
 * Each folder's draft is its own storage entry (#219), so two tabs editing different folders
 * cannot overwrite each other. Before version 3 they shared `STORAGE_NAME`'s entry.
 */
const DRAFT_PREFIX = `${STORAGE_NAME}:draft:`;
const DRAFT_VERSION = 1;

const defaultStorage = createJSONStorage<SourceControlPanelStoreState>(() =>
  resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
);

/** The store's storage; tests replace it with `persist.setOptions`. */
function currentStorage() {
  try {
    return useSourceControlPanelStore.persist.getOptions().storage ?? defaultStorage;
  } catch {
    return defaultStorage; // the store is still being created
  }
}

/** The draft saved for the folder; `undefined` when none, or storage answers later. */
function readDraft(cwdKey: string): SourceControlDraft | undefined {
  let saved;
  try {
    saved = currentStorage()?.getItem(`${DRAFT_PREFIX}${cwdKey}`);
  } catch {
    return undefined; // blocked storage reads as no draft
  }
  if (saved === null || saved === undefined || saved instanceof Promise) return undefined;
  const draft = saved.state as unknown as Partial<SourceControlDraft> | undefined;
  if (typeof draft?.message !== "string") return undefined;
  const alternates = Array.isArray(draft.alternates)
    ? draft.alternates.filter((text): text is string => typeof text === "string")
    : [];
  return alternates.length > 0
    ? { message: draft.message, alternates }
    : { message: draft.message };
}

let warnedAboutDraftStorage = false;

/**
 * What this tab last wrote to, or read from, each folder's entry. A draft in memory that differs
 * from it never reached storage: an unsaved edit, which another tab's save must not replace.
 */
const knownStored = new Map<string, SourceControlDraft | undefined>();

function hasUnsavedEdit(
  cwdKey: string,
  local: SourceControlDraft | undefined,
): local is SourceControlDraft {
  return (
    local !== undefined &&
    local.message.trim() !== "" &&
    local.message !== (knownStored.get(cwdKey)?.message ?? "")
  );
}

/**
 * Saves the folder's draft, or removes it; `false` when storage refused. A failing storage
 * (quota, blocked) never fails the edit: the draft stays in memory, and the failure is logged
 * once.
 */
function writeDraft(cwdKey: string, draft: SourceControlDraft | undefined): boolean {
  const name = `${DRAFT_PREFIX}${cwdKey}`;
  try {
    if (draft === undefined) {
      void currentStorage()?.removeItem(name);
    } else {
      void currentStorage()?.setItem(name, {
        state: draft as unknown as SourceControlPanelStoreState,
        version: DRAFT_VERSION,
      });
    }
    knownStored.set(cwdKey, draft);
    return true;
  } catch (error) {
    if (!warnedAboutDraftStorage) {
      warnedAboutDraftStorage = true;
      console.warn("Could not save the commit message draft; it stays in memory only.", error);
    }
    return false;
  }
}

/**
 * Drafts from before version 3 that could not be copied to their own entries. Persist keeps
 * them in the saved entry, and they are copied again the next time the app loads.
 */
let unmigratedDrafts: Record<string, SourceControlDraft> = {};

/** Every folder draft saved now, for a tab that has just opened. */
function readAllDrafts(): Record<string, SourceControlDraft> {
  const drafts: Record<string, SourceControlDraft> = {};
  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (name === null || !name.startsWith(DRAFT_PREFIX)) continue;
      const cwdKey = name.slice(DRAFT_PREFIX.length);
      const draft = readDraft(cwdKey);
      if (draft !== undefined) {
        drafts[cwdKey] = draft;
        knownStored.set(cwdKey, draft);
      }
    }
  } catch {
    // No localStorage: drafts live in memory only.
  }
  return drafts;
}

/** A draft of `message` offering `alternates`, newest first, without blanks or repeats. */
function withAlternates(message: string, alternates: readonly string[]): SourceControlDraft {
  const kept = [...new Set(alternates)].filter((text) => text.trim() !== "" && text !== message);
  return kept.length === 0 ? { message } : { message, alternates: kept.slice(0, MOST_ALTERNATES) };
}

/**
 * `message` as the folder's draft, over whatever storage holds now. This tab last saw `local`;
 * a different message in storage was written by another tab since, and becomes an alternate
 * rather than being overwritten. So no text any tab wrote leaves storage until the person uses,
 * dismisses, or commits it. `extra` are further versions to offer.
 */
function composeMessage(
  cwdKey: string,
  local: SourceControlDraft | undefined,
  message: string,
  extra: readonly string[] = [],
): SourceControlDraft {
  // shortcut: read-then-write is not atomic across windows; a save landing in that gap can still lose one version; upgrade to navigator.locks if users hit it
  const stored = readDraft(cwdKey);
  const theirs = stored?.message ?? "";
  const unseen = theirs.trim() !== "" && theirs !== message && theirs !== (local?.message ?? "");
  return withAlternates(message, [
    ...(unseen ? [theirs] : []),
    ...(stored?.alternates ?? []),
    ...extra,
  ]);
}

/** Saves `message` as the folder's draft (see {@link composeMessage}). */
function saveMessage(
  cwdKey: string,
  local: SourceControlDraft | undefined,
  message: string,
  extra: readonly string[] = [],
): SourceControlDraft {
  const unmigrated = unmigratedDrafts[cwdKey];
  const draft = composeMessage(cwdKey, local, message, [
    ...extra,
    ...(unmigrated === undefined ? [] : [unmigrated.message]),
  ]);
  if (writeDraft(cwdKey, draft)) delete unmigratedDrafts[cwdKey];
  return draft;
}

/**
 * Copies drafts saved before version 3 to their own entries and returns them as shown. Any that
 * storage refuses are kept in {@link unmigratedDrafts}; a draft already in its entry becomes an
 * alternate of the copied one.
 */
function migrateDrafts(
  old: Record<string, SourceControlDraft>,
): Record<string, SourceControlDraft> {
  const shown: Record<string, SourceControlDraft> = {};
  const failed: Record<string, SourceControlDraft> = {};
  for (const [cwdKey, draft] of Object.entries(old)) {
    if (!hasText(draft)) continue;
    shown[cwdKey] = composeMessage(cwdKey, undefined, draft.message);
    if (!writeDraft(cwdKey, shown[cwdKey])) failed[cwdKey] = { message: draft.message };
  }
  unmigratedDrafts = failed;
  return shown;
}

/** `state.byCwdKey` with the folder's message saved as `message` (see {@link saveMessage}). */
function putDraft(
  state: Pick<SourceControlPanelStoreState, "byCwdKey">,
  cwdKey: string,
  message: string,
): Record<string, SourceControlDraft> {
  return { ...state.byCwdKey, [cwdKey]: saveMessage(cwdKey, state.byCwdKey[cwdKey], message) };
}

/** `state.byCwdKey` with the folder's draft written (or removed) and shown as written. */
function showWritten(
  state: Pick<SourceControlPanelStoreState, "byCwdKey">,
  cwdKey: string,
  draft: SourceControlDraft | undefined,
): Record<string, SourceControlDraft> {
  writeDraft(cwdKey, draft);
  const { [cwdKey]: _previous, ...others } = state.byCwdKey;
  return draft === undefined ? others : { ...others, [cwdKey]: draft };
}

/** `state.byCwdKey` with the folder as storage holds it now. */
function takeStored(
  state: Pick<SourceControlPanelStoreState, "byCwdKey">,
  cwdKey: string,
): Record<string, SourceControlDraft> {
  const { [cwdKey]: _previous, ...others } = state.byCwdKey;
  const stored = readDraft(cwdKey);
  knownStored.set(cwdKey, stored);
  return stored === undefined ? others : { ...others, [cwdKey]: stored };
}

/**
 * The commit of `submitted` landed: its message goes from storage, and from memory only while
 * memory still holds it. Alternates and newer text stay, saved or not.
 */
function clearSubmitted(
  state: Pick<SourceControlPanelStoreState, "byCwdKey">,
  cwdKey: string,
  submitted: string,
): Record<string, SourceControlDraft> {
  // shortcut: read-then-write is not atomic across windows; a save landing in that gap can still lose one version; upgrade to navigator.locks if users hit it
  const stored = readDraft(cwdKey);
  const local = state.byCwdKey[cwdKey];
  const sent = submitted.trim();
  const localIsSent = local !== undefined && local.message.trim() === sent;
  const unsaved = hasUnsavedEdit(cwdKey, local);
  const remaining = (alternates: readonly string[] = []) =>
    alternates.length === 0 ? undefined : withAlternates("", alternates);
  if (stored !== undefined && stored.message.trim() === sent) {
    const cleared = remaining(stored.alternates);
    if (!unsaved || localIsSent) return showWritten(state, cwdKey, cleared);
    writeDraft(cwdKey, cleared); // an edit only in memory stays
    return state.byCwdKey;
  }
  if (!unsaved) return takeStored(state, cwdKey);
  if (!localIsSent || local === undefined) return state.byCwdKey;
  const { [cwdKey]: _sent, ...others } = state.byCwdKey;
  const left = remaining(local.alternates);
  return left === undefined ? others : { ...others, [cwdKey]: left };
}

/** What is saved: the persisted fields, any of which an older or other tab may have left out. */
type SavedState = Partial<SourceControlPanelStoreState>;

/**
 * The state saved to storage now, which another tab may have written since this one loaded;
 * `null` when none of this version is saved, or storage answers later.
 */
function readSavedState(): SavedState | null {
  let saved;
  try {
    // `persist` is absent when the browser denies storage, and saved JSON may be malformed.
    saved = useSourceControlPanelStore.persist?.getOptions().storage?.getItem(STORAGE_NAME);
  } catch (error) {
    console.warn("Could not read saved Source Control state.", error);
    return null;
  }
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
      set((state) => ({ byCwdKey: putDraft(state, cwdKey, message) })),
    clearCwdDraft: (cwdKey, submitted) =>
      set((state) => ({ byCwdKey: clearSubmitted(state, cwdKey, submitted) })),
    useCwdAlternate: (cwdKey, alternate) =>
      set((state) => {
        const stored = readDraft(cwdKey);
        if (stored?.alternates?.includes(alternate) !== true) {
          return { byCwdKey: takeStored(state, cwdKey) };
        }
        const others = stored.alternates.filter((text) => text !== alternate);
        return {
          byCwdKey: showWritten(
            state,
            cwdKey,
            withAlternates(alternate, [stored.message, ...others]),
          ),
        };
      }),
    dismissCwdAlternate: (cwdKey, alternate) =>
      set((state) => {
        const stored = readDraft(cwdKey);
        if (stored?.alternates?.includes(alternate) !== true) {
          return { byCwdKey: takeStored(state, cwdKey) };
        }
        const others = stored.alternates.filter((text) => text !== alternate);
        return { byCwdKey: showWritten(state, cwdKey, withAlternates(stored.message, others)) };
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
      // Another tab typed in this folder, or handled this suggestion: offer, write nothing.
      if (hasText(readDraft(cwdKey))) return;
      const saved = readSavedState();
      if (saved?.agentSuggestionByCwdKey?.[cwdKey]?.intentId === intentId) return;
      const byCwdKey = putDraft(state, cwdKey, message);
      const remember = (suggestions: Record<string, AgentCommitSuggestion>) =>
        rememberSuggestion(suggestions, cwdKey, { intentId, outcome: "filled" });
      if (saved === null) {
        set((current) => ({
          byCwdKey,
          agentSuggestionByCwdKey: remember(current.agentSuggestionByCwdKey),
        }));
        return;
      }
      // Only this folder's record changes in what is saved; other folders stay as saved.
      void currentStorage()?.setItem(STORAGE_NAME, {
        state: {
          ...saved,
          agentSuggestionByCwdKey: remember(saved.agentSuggestionByCwdKey ?? {}),
        } as SourceControlPanelStoreState,
        version: STORAGE_VERSION,
      });
      setWithoutSaving({
        byCwdKey,
        agentSuggestionByCwdKey: remember(state.agentSuggestionByCwdKey),
      });
    },
    acceptAgentCommitSuggestion: (cwdKey, intentId, message) =>
      set((state) => {
        if (isHandled(state, cwdKey, intentId)) return state;
        return {
          byCwdKey: putDraft(state, cwdKey, message),
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
          byCwdKey: putDraft(state, cwdKey, suggestion.replacedDraft ?? ""),
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
        return { ...retired, byCwdKey: clearSubmitted(state, cwdKey, message) };
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
    storage: defaultStorage,
    migrate: (persistedState) => {
      const state = persistedState as Partial<SourceControlPanelStoreState> | undefined;
      // Folder drafts left this entry in version 3. Each is written to its own entry before
      // persist saves this one without them; one storage refuses stays here to be tried again.
      const byCwdKey = migrateDrafts(state?.byCwdKey ?? {});
      // `sourceControlGroupByFolder` is intentionally absent: persist's shallow
      // merge keeps a stored value and falls back to the grouped default.
      return {
        byThreadKey: state?.byThreadKey ?? {},
        byCwdKey,
        agentSuggestionByCwdKey: state?.agentSuggestionByCwdKey ?? {},
      } as SourceControlPanelStoreState;
    },
    // Folder drafts are saved apart from this entry, one entry each.
    partialize: (state) =>
      ({
        byThreadKey: state.byThreadKey,
        ...(Object.keys(unmigratedDrafts).length > 0 ? { byCwdKey: unmigratedDrafts } : {}),
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

// Drafts saved before this tab opened, and any an earlier load could not copy to their entries.
{
  const leftover = readSavedState()?.byCwdKey ?? {};
  const retried = Object.keys(leftover).length > 0 ? migrateDrafts(leftover) : {};
  const byCwdKey = {
    ...useSourceControlPanelStore.getState().byCwdKey,
    ...readAllDrafts(),
    ...retried,
  };
  // Through `set` once, so the saved entry drops the drafts that were copied.
  if (Object.keys(leftover).length > 0) useSourceControlPanelStore.setState({ byCwdKey });
  else setWithoutSaving({ byCwdKey });
}

// Another tab saved a folder's draft: show it as saved. Not through `set`, which would save.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || !event.key.startsWith(DRAFT_PREFIX)) return;
    const cwdKey = event.key.slice(DRAFT_PREFIX.length);
    const state = useSourceControlPanelStore.getState();
    const local = state.byCwdKey[cwdKey];
    // An edit that never reached storage stays the message; what arrived is offered beside it.
    const byCwdKey = hasUnsavedEdit(cwdKey, local)
      ? { ...state.byCwdKey, [cwdKey]: saveMessage(cwdKey, local, local.message, local.alternates) }
      : takeStored(state, cwdKey);
    setWithoutSaving({ byCwdKey });
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
