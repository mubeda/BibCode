import { scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { ScopedThreadRef, TurnId } from "@bibcode/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Type-only: the store loads with the app shell, and the Compare model pulls in the diff renderer.
import type { DiffFileFilters } from "./lib/diffCompareModel";
import { resolveStorage } from "./lib/storage";

const EMPTY_DIFF_FILE_FILTERS: DiffFileFilters = { status: "all", query: "" };

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "turn"; turnId: TurnId; filePath: string | null; revealRequestId: number };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  gitRefreshRequestByThreadKey: Record<string, number>;
  /** Compare's selected file, by path. Persisted, so a reload reopens the same file. */
  compareFileByThreadKey: Record<string, string>;
  /** Compare's list filters. Memory-only, so a reload never opens Compare with files hidden. */
  compareFiltersByThreadKey: Record<string, DiffFileFilters>;
  selectCompareFile: (ref: ScopedThreadRef, path: string) => void;
  setCompareFilters: (ref: ScopedThreadRef, filters: DiffFileFilters) => void;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: TurnId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      gitRefreshRequestByThreadKey: {},
      compareFileByThreadKey: {},
      compareFiltersByThreadKey: {},
      selectCompareFile: (ref, path) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (state.compareFileByThreadKey[threadKey] === path) return state;
          return {
            compareFileByThreadKey: { ...state.compareFileByThreadKey, [threadKey]: path },
          };
        }),
      setCompareFilters: (ref, filters) =>
        set((state) => ({
          compareFiltersByThreadKey: {
            ...state.compareFiltersByThreadKey,
            [scopedThreadKey(ref)]: filters,
          },
        })),
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const refreshRequests = state.gitRefreshRequestByThreadKey ?? {};
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
            gitRefreshRequestByThreadKey: {
              ...refreshRequests,
              [threadKey]: (refreshRequests[threadKey] ?? 0) + 1,
            },
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const refreshRequests = state.gitRefreshRequestByThreadKey ?? {};
          const compareFiles = state.compareFileByThreadKey ?? {};
          const compareFilters = state.compareFiltersByThreadKey ?? {};
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.branchBaseRefByThreadKey) &&
            !(threadKey in refreshRequests) &&
            !(threadKey in compareFiles) &&
            !(threadKey in compareFilters)
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          const { [threadKey]: _removedRefreshRequest, ...gitRefreshRequestByThreadKey } =
            refreshRequests;
          const { [threadKey]: _removedCompareFile, ...compareFileByThreadKey } = compareFiles;
          const { [threadKey]: _removedCompareFilters, ...compareFiltersByThreadKey } =
            compareFilters;
          return {
            byThreadKey,
            branchBaseRefByThreadKey,
            gitRefreshRequestByThreadKey,
            compareFileByThreadKey,
            compareFiltersByThreadKey,
          };
        }),
    }),
    {
      name: "bibcode:diff-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
        compareFileByThreadKey: state.compareFileByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}

export function selectThreadDiffPanelRefreshRequest(
  refreshRequestByThreadKey: Record<string, number> | undefined,
  ref: ScopedThreadRef | null | undefined,
): number {
  if (!ref) return 0;
  return refreshRequestByThreadKey?.[scopedThreadKey(ref)] ?? 0;
}

export function selectThreadCompareFile(
  compareFileByThreadKey: Record<string, string> | undefined,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  if (!ref) return null;
  return compareFileByThreadKey?.[scopedThreadKey(ref)] ?? null;
}

export function selectThreadCompareFilters(
  compareFiltersByThreadKey: Record<string, DiffFileFilters> | undefined,
  ref: ScopedThreadRef | null | undefined,
): DiffFileFilters {
  if (!ref) return EMPTY_DIFF_FILE_FILTERS;
  return compareFiltersByThreadKey?.[scopedThreadKey(ref)] ?? EMPTY_DIFF_FILE_FILTERS;
}
