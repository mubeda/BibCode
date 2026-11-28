/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Browser surfaces point at preview tab ids,
 * file surfaces point at workspace paths, and terminal, pullRequest, files,
 * diff, sourceControl, device, gitManager, pipelines, and plan are singleton
 * surfaces mounted lazily only once selected.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@bibcode/client-runtime/environment";
import {
  type DevicePlatform,
  type ScopedThreadRef,
  SourceControlProviderKind,
  ThreadId,
} from "@bibcode/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { PullRequestsDetailTab } from "./pullRequestsStore";
import { MAX_TERMINALS_PER_GROUP } from "./types";

export const RIGHT_PANEL_KINDS = [
  "plan",
  "diff",
  "sourceControl",
  "files",
  "file",
  "preview",
  "terminal",
  "device",
  "gitManager",
  "pipelines",
  "pullRequest",
] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

/**
 * Deterministic fallback order when closing the last dynamic tab (`file:` or `browser:`) leaves no
 * other open surfaces, upholding D6 so the right panel never goes blank after selection.
 */
export const FALLBACK_SINGLETON_ORDER = [
  "files",
  "terminal",
  "sourceControl",
  "diff",
  "gitManager",
  "pipelines",
  "pullRequest",
  "device",
] as const;
export type FallbackSingletonKind = (typeof FALLBACK_SINGLETON_ORDER)[number];

/**
 * The image a thread's Device pane last picked or started: an AVD name or a simulator UDID, which
 * outlive server restarts. Never a device id, which is per open.
 */
export interface DeviceSurfaceImage {
  readonly platform: DevicePlatform;
  readonly imageId: string;
}

export type DeviceRightPanelSurface = {
  id: "device";
  kind: "device";
  image?: DeviceSurfaceImage;
};

export interface PullRequestSelection {
  readonly number: number;
  readonly provider: SourceControlProviderKind;
  readonly tab: PullRequestsDetailTab;
}

export type PullRequestRightPanelSurface = {
  id: "pullRequest";
  kind: "pullRequest";
  selection?: PullRequestSelection;
};

export type TerminalRightPanelSurface = {
  id: "terminal";
  kind: "terminal";
  resourceId: string;
  terminalIds: string[];
  activeTerminalId: string;
  splitDirection?: "horizontal" | "vertical";
};

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | TerminalRightPanelSurface
  /** `threadId` names a chat panel's thread when its host's panel shows that thread's diff. */
  | { id: "diff"; kind: "diff"; threadId?: ThreadId }
  | { id: "sourceControl"; kind: "sourceControl" }
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}`;
      kind: "file";
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
    }
  | { id: "plan"; kind: "plan" }
  | { id: "gitManager"; kind: "gitManager" }
  | { id: "pipelines"; kind: "pipelines" }
  | DeviceRightPanelSurface
  | PullRequestRightPanelSurface;

const RIGHT_PANEL_STORAGE_KEY = "bibcode:right-panel-state:v2";
const RIGHT_PANEL_STORAGE_VERSION = 12;

export interface ThreadRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

export interface CloseSurfaceOptions {
  readonly availableSingletons?: ReadonlySet<FallbackSingletonKind>;
}

type GenericRightPanelKind = Exclude<RightPanelKind, "file" | "terminal">;
type NonTerminalFallbackSingletonKind = Exclude<FallbackSingletonKind, "terminal">;

/** A request to show a workspace path in the Files tree. Transient: never persisted. */
export interface FilesRevealRequest {
  /** Workspace-relative path of a file or folder; "" shows the tree with nothing selected. */
  readonly path: string;
  readonly requestId: number;
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  /** The pending reveal per thread; the mounted Files tree applies it, then clears it. */
  filesReveal: Record<string, FilesRevealRequest>;
  /**
   * Transient MRU active surface ids per thread, used to return to the previously active surface
   * when closing a dynamic tab. Never persisted.
   */
  recentActiveSurfaceIdsByThreadKey: Record<string, string[]>;
  /**
   * Legacy v11 terminal session ids dropped during v11 -> v12 singleton merge (>4 panes).
   * Consumed by `ChatView` so orphaned server terminal sessions are retired cleanly. Never persisted.
   */
  migratedOverflowTerminalIdsByThreadKey: Record<string, string[]>;
  /** Returns and clears any v11 -> v12 overflow terminal ids queued for cleanup on `ref`. */
  consumeMigratedOverflowTerminalIds: (ref: ScopedThreadRef) => string[];
  /** Opens (or reopens) the Files tab and asks its tree to select `relativePath`. */
  revealInFiles: (ref: ScopedThreadRef, relativePath: string) => void;
  /** Drops the request once handled; a newer request for the same thread is kept. */
  clearFilesReveal: (ref: ScopedThreadRef, requestId: number) => void;
  open: (ref: ScopedThreadRef, kind: GenericRightPanelKind) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  /** Opens `ref`'s Diff surface on `threadId`'s diff: a chat panel's, in its host's panel. */
  openDiff: (ref: ScopedThreadRef, threadId: ThreadId) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  openPullRequest: (
    ref: ScopedThreadRef,
    request: { number: number; provider: SourceControlProviderKind },
    tab?: PullRequestsDetailTab,
  ) => void;
  clearPullRequestSelection: (ref: ScopedThreadRef) => void;
  setPullRequestTab: (ref: ScopedThreadRef, number: number, tab: PullRequestsDetailTab) => void;
  /** Remembers the image the thread's Device pane shows; a thread without one keeps nothing. */
  setDeviceImage: (ref: ScopedThreadRef, image: DeviceSurfaceImage) => void;
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => boolean;
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string, options?: CloseSurfaceOptions) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  remapFileSurfaces: (
    ref: ScopedThreadRef,
    oldRelativePath: string,
    newRelativePath: string,
  ) => void;
  closeFileSurfacesUnder: (ref: ScopedThreadRef, relativePath: string) => void;
  show: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggle: (ref: ScopedThreadRef, kind: GenericRightPanelKind) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const singletonSurface = (kind: Exclude<GenericRightPanelKind, "preview">): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "sourceControl":
      return { id: "sourceControl", kind };
    case "files":
      return { id: "files", kind };
    case "plan":
      return { id: "plan", kind };
    case "device":
      return { id: "device", kind };
    case "gitManager":
      return { id: "gitManager", kind };
    case "pipelines":
      return { id: "pipelines", kind };
    case "pullRequest":
      return { id: "pullRequest", kind };
  }
};

export function resolveFallbackSingletonKind(
  availableSingletons?: ReadonlySet<FallbackSingletonKind>,
): FallbackSingletonKind | null {
  for (const kind of FALLBACK_SINGLETON_ORDER) {
    if (availableSingletons === undefined) {
      if (kind !== "terminal") return kind;
      continue;
    }
    if (availableSingletons.has(kind)) return kind;
  }
  return null;
}

function resolveNonTerminalFallbackSingleton(
  availableSingletons?: ReadonlySet<FallbackSingletonKind>,
): NonTerminalFallbackSingletonKind | null {
  for (const kind of FALLBACK_SINGLETON_ORDER) {
    if (kind === "terminal") continue;
    if (availableSingletons === undefined || availableSingletons.has(kind)) {
      return kind;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDynamicSurface(surface: RightPanelSurface): boolean {
  return surface.kind === "preview" || surface.kind === "file";
}

function normalizeDeviceImage(value: unknown): DeviceSurfaceImage | null {
  if (!isRecord(value)) return null;
  const { platform, imageId } = value;
  if ((platform !== "android" && platform !== "ios") || !isNonEmptyString(imageId)) return null;
  return { platform, imageId };
}

function normalizeDeviceSurface(value: Record<string, unknown>): DeviceRightPanelSurface | null {
  if (value.id !== "device") return null;
  // A malformed pick is dropped, not the surface: the pane falls back to its own choice.
  const image = normalizeDeviceImage(value.image);
  return image === null
    ? { id: "device", kind: "device" }
    : { id: "device", kind: "device", image };
}

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
});

const terminalSurface = (terminalId: string): TerminalRightPanelSurface => ({
  id: "terminal",
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

const PULL_REQUEST_DETAIL_TABS: ReadonlySet<unknown> = new Set<PullRequestsDetailTab>([
  "conversation",
  "commits",
  "checks",
  "files",
]);
const isPullRequestDetailTab = (value: unknown): value is PullRequestsDetailTab =>
  PULL_REQUEST_DETAIL_TABS.has(value);
const isSourceControlProviderKind = Schema.is(SourceControlProviderKind);

export function pullRequestSurfaceId(_number?: number): "pullRequest" {
  return "pullRequest";
}

function normalizePullRequestSelection(value: unknown): PullRequestSelection | null {
  if (!isRecord(value)) return null;
  const { number, provider, tab } = value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
  if (!isSourceControlProviderKind(provider)) return null;
  return {
    number,
    provider,
    tab: isPullRequestDetailTab(tab) ? tab : "conversation",
  };
}

interface ParsedPersistedPullRequest {
  readonly rawId: string;
  readonly selection: PullRequestSelection | null;
}

function parsePersistedPullRequestSurface(
  value: Record<string, unknown>,
): ParsedPersistedPullRequest | null {
  if (value.id === "pullRequest") {
    if (value.selection === undefined) {
      return { rawId: "pullRequest", selection: null };
    }
    const selection = normalizePullRequestSelection(value.selection);
    return { rawId: "pullRequest", selection };
  }
  // Legacy v11 `pullRequest:<number>` shape.
  const { number, provider, tab } = value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
  if (value.id !== `pullRequest:${number}` || !isSourceControlProviderKind(provider)) {
    return null;
  }
  return {
    rawId: value.id,
    selection: {
      number,
      provider,
      tab: isPullRequestDetailTab(tab) ? tab : "conversation",
    },
  };
}

interface ParsedPersistedTerminal {
  readonly rawId: string;
  readonly terminalIds: string[];
  readonly activeTerminalId: string;
  readonly splitDirection?: "horizontal" | "vertical";
}

function parsePersistedTerminalSurface(
  value: Record<string, unknown>,
): ParsedPersistedTerminal | null {
  const isV12 = value.id === "terminal";
  const isLegacyV11 =
    isNonEmptyString(value.resourceId) && value.id === `terminal:${value.resourceId}`;
  if (!isV12 && !isLegacyV11) {
    return null;
  }
  const rawIds = Array.isArray(value.terminalIds)
    ? [
        ...new Set(
          value.terminalIds.filter((terminalId): terminalId is string =>
            isNonEmptyString(terminalId),
          ),
        ),
      ]
    : [];
  const normalizedTerminalIds =
    rawIds.length > 0 ? rawIds : isNonEmptyString(value.resourceId) ? [value.resourceId] : [];
  // Drop ancient pre-v8 `{ id: "terminal", kind: "terminal" }` without any session id.
  if (normalizedTerminalIds.length === 0) {
    return null;
  }
  const activeTerminalId =
    isNonEmptyString(value.activeTerminalId) &&
    normalizedTerminalIds.includes(value.activeTerminalId)
      ? value.activeTerminalId
      : normalizedTerminalIds[0]!;
  return {
    rawId: value.id as string,
    terminalIds: normalizedTerminalIds,
    activeTerminalId,
    ...(value.splitDirection === "horizontal" || value.splitDirection === "vertical"
      ? { splitDirection: value.splitDirection }
      : {}),
  };
}

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const diffSurface = (ref: ScopedThreadRef, threadId: ThreadId): RightPanelSurface =>
  threadId === ref.threadId ? { id: "diff", kind: "diff" } : { id: "diff", kind: "diff", threadId };

/** Like `upsertSurface`, but replaces a surface with the same id (a Diff on another thread). */
const replaceSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
): ThreadRightPanelState =>
  upsertSurface(
    {
      ...current,
      surfaces: current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry)),
    },
    surface,
  );

const recordActiveTransition = (
  recentByThreadKey: Record<string, string[]>,
  threadKey: string,
  previousActiveId: string | null,
  nextState: ThreadRightPanelState,
): Record<string, string[]> => {
  if (!nextState.isOpen && nextState.activeSurfaceId === null && nextState.surfaces.length === 0) {
    if (!(threadKey in recentByThreadKey)) return recentByThreadKey;
    const { [threadKey]: _removed, ...rest } = recentByThreadKey;
    return rest;
  }
  const existing = recentByThreadKey[threadKey] ?? [];
  const validIds = new Set<string>(nextState.surfaces.map((surface) => surface.id));
  let next = existing.filter((id) => validIds.has(id));
  if (
    previousActiveId !== null &&
    previousActiveId !== nextState.activeSurfaceId &&
    validIds.has(previousActiveId)
  ) {
    next = [...next.filter((id) => id !== previousActiveId), previousActiveId];
  }
  if (nextState.activeSurfaceId !== null && validIds.has(nextState.activeSurfaceId)) {
    next = [...next.filter((id) => id !== nextState.activeSurfaceId), nextState.activeSurfaceId];
  }
  if (next.length === existing.length && next.every((value, index) => value === existing[index])) {
    return recentByThreadKey;
  }
  return { ...recentByThreadKey, [threadKey]: next };
};

const pickRemainingFallbackSurfaceId = (
  surfaces: readonly RightPanelSurface[],
  removedIndex: number,
  recentIds: readonly string[],
): string | null => {
  if (surfaces.length === 0) return null;
  const remainingIds = new Set<string>(surfaces.map((surface) => surface.id));
  for (let idx = recentIds.length - 1; idx >= 0; idx -= 1) {
    const candidate = recentIds[idx]!;
    if (remainingIds.has(candidate)) {
      return candidate;
    }
  }
  return surfaces[Math.min(removedIndex, surfaces.length - 1)]?.id ?? null;
};

const updateThreadWithHistory = (
  state: Pick<RightPanelStoreState, "byThreadKey" | "recentActiveSurfaceIdsByThreadKey">,
  threadKey: string,
  updater: (current: ThreadRightPanelState, recentIds: readonly string[]) => ThreadRightPanelState,
): Pick<RightPanelStoreState, "byThreadKey" | "recentActiveSurfaceIdsByThreadKey"> => {
  const current = state.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const recentIds = state.recentActiveSurfaceIdsByThreadKey[threadKey] ?? [];
  const next = updater(current, recentIds);
  let nextByThreadKey = state.byThreadKey;
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (threadKey in state.byThreadKey) {
      const { [threadKey]: _removed, ...rest } = state.byThreadKey;
      nextByThreadKey = rest;
    }
  } else if (next !== current) {
    nextByThreadKey = { ...state.byThreadKey, [threadKey]: next };
  }
  const nextRecent = recordActiveTransition(
    state.recentActiveSurfaceIdsByThreadKey,
    threadKey,
    current.activeSurfaceId,
    next,
  );
  if (
    nextByThreadKey === state.byThreadKey &&
    nextRecent === state.recentActiveSurfaceIdsByThreadKey
  ) {
    return state;
  }
  return {
    byThreadKey: nextByThreadKey,
    recentActiveSurfaceIdsByThreadKey: nextRecent,
  };
};

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

function normalizeNonMergedPersistedSurface(
  value: Record<string, unknown>,
): RightPanelSurface | null {
  switch (value.kind) {
    case "diff":
      if (value.id !== "diff") return null;
      return typeof value.threadId === "string" && value.threadId.length > 0
        ? { id: "diff", kind: "diff", threadId: ThreadId.make(value.threadId) }
        : { id: "diff", kind: "diff" };
    case "sourceControl":
      return value.id === "sourceControl" ? { id: "sourceControl", kind: "sourceControl" } : null;
    case "files":
      return value.id === "files" ? { id: "files", kind: "files" } : null;
    case "plan":
      return value.id === "plan" ? { id: "plan", kind: "plan" } : null;
    case "gitManager":
      return value.id === "gitManager" ? { id: "gitManager", kind: "gitManager" } : null;
    case "pipelines":
      return value.id === "pipelines" ? { id: "pipelines", kind: "pipelines" } : null;
    case "device":
      return normalizeDeviceSurface(value);
    case "preview": {
      if (value.id === "browser:new" && value.resourceId === null) {
        return { id: "browser:new", kind: "preview", resourceId: null };
      }
      if (isNonEmptyString(value.resourceId) && value.id === `browser:${value.resourceId}`) {
        return {
          id: `browser:${value.resourceId}`,
          kind: "preview",
          resourceId: value.resourceId,
        };
      }
      return null;
    }
    case "file": {
      if (!isNonEmptyString(value.relativePath) || value.id !== `file:${value.relativePath}`) {
        return null;
      }
      const revealLine =
        typeof value.revealLine === "number" && Number.isFinite(value.revealLine)
          ? Math.max(1, Math.trunc(value.revealLine))
          : null;
      const revealRequestId =
        typeof value.revealRequestId === "number" &&
        Number.isSafeInteger(value.revealRequestId) &&
        value.revealRequestId >= 0
          ? value.revealRequestId
          : 0;
      return {
        id: `file:${value.relativePath}`,
        kind: "file",
        relativePath: value.relativePath,
        revealLine,
        revealRequestId,
      };
    }
    default:
      return null;
  }
}

export interface MigratedRightPanelStateWithOverflow {
  readonly byThreadKey: Record<string, ThreadRightPanelState>;
  readonly overflowTerminalIdsByThreadKey: Record<string, string[]>;
}

export function migratePersistedRightPanelStateWithOverflow(
  persistedState: unknown,
): MigratedRightPanelStateWithOverflow {
  if (!persistedState || typeof persistedState !== "object") {
    return { byThreadKey: {}, overflowTerminalIdsByThreadKey: {} };
  }
  const rawByThreadKey =
    "byThreadKey" in persistedState &&
    persistedState.byThreadKey &&
    typeof persistedState.byThreadKey === "object"
      ? (persistedState.byThreadKey as Record<string, unknown>)
      : null;
  if (!rawByThreadKey) {
    return { byThreadKey: {}, overflowTerminalIdsByThreadKey: {} };
  }

  const byThreadKey: Record<string, ThreadRightPanelState> = {};
  const overflowTerminalIdsByThreadKey: Record<string, string[]> = {};

  for (const [threadKey, threadState] of Object.entries(rawByThreadKey)) {
    const validThreadState = isRecord(threadState) ? threadState : null;
    const rawActiveSurfaceId =
      typeof validThreadState?.activeSurfaceId === "string"
        ? validThreadState.activeSurfaceId
        : null;
    const rawSurfaces = Array.isArray(validThreadState?.surfaces) ? validThreadState.surfaces : [];

    const parsedTerminals: ParsedPersistedTerminal[] = [];
    const parsedPullRequests: ParsedPersistedPullRequest[] = [];
    const surfaces: RightPanelSurface[] = [];
    const seenSurfaceIds = new Set<string>();
    let firstTerminalInsertIndex = -1;
    let firstPullRequestInsertIndex = -1;

    for (const candidate of rawSurfaces) {
      if (!isRecord(candidate) || typeof candidate.kind !== "string") continue;
      if (candidate.kind === "terminal") {
        const parsed = parsePersistedTerminalSurface(candidate);
        if (!parsed) continue;
        if (firstTerminalInsertIndex === -1) {
          firstTerminalInsertIndex = surfaces.length;
        }
        parsedTerminals.push(parsed);
        continue;
      }
      if (candidate.kind === "pullRequest") {
        const parsed = parsePersistedPullRequestSurface(candidate);
        if (!parsed) continue;
        if (firstPullRequestInsertIndex === -1) {
          firstPullRequestInsertIndex = surfaces.length;
        }
        parsedPullRequests.push(parsed);
        continue;
      }
      const surface = normalizeNonMergedPersistedSurface(candidate);
      if (!surface || seenSurfaceIds.has(surface.id)) continue;
      seenSurfaceIds.add(surface.id);
      surfaces.push(surface);
    }

    let terminalMatchedActive = false;
    let mergedTerminalSurface: TerminalRightPanelSurface | null = null;
    if (parsedTerminals.length > 0) {
      const activeTerminalEntry =
        parsedTerminals.find((entry) => entry.rawId === rawActiveSurfaceId) ?? null;
      terminalMatchedActive = activeTerminalEntry !== null;
      const winningEntry = activeTerminalEntry ?? parsedTerminals[0]!;
      const mergedIds: string[] = [];
      const seenIds = new Set<string>();
      for (const entry of parsedTerminals) {
        for (const terminalId of entry.terminalIds) {
          if (seenIds.has(terminalId)) continue;
          seenIds.add(terminalId);
          mergedIds.push(terminalId);
        }
      }
      const winningActiveId = mergedIds.includes(winningEntry.activeTerminalId)
        ? winningEntry.activeTerminalId
        : mergedIds[0]!;
      let keptIds: string[];
      if (mergedIds.length <= MAX_TERMINALS_PER_GROUP) {
        keptIds = mergedIds;
      } else {
        const activeIndex = mergedIds.indexOf(winningActiveId);
        if (activeIndex >= 0 && activeIndex < MAX_TERMINALS_PER_GROUP) {
          keptIds = mergedIds.slice(0, MAX_TERMINALS_PER_GROUP);
        } else {
          keptIds = [...mergedIds.slice(0, MAX_TERMINALS_PER_GROUP - 1), winningActiveId];
        }
        const keptSet = new Set(keptIds);
        const overflowIds = mergedIds.filter((id) => !keptSet.has(id));
        if (overflowIds.length > 0) {
          overflowTerminalIdsByThreadKey[threadKey] = overflowIds;
        }
      }
      mergedTerminalSurface = {
        id: "terminal",
        kind: "terminal",
        resourceId: keptIds[0]!,
        terminalIds: keptIds,
        activeTerminalId: winningActiveId,
        ...(winningEntry.splitDirection ? { splitDirection: winningEntry.splitDirection } : {}),
      };
    }

    let pullRequestMatchedActive = false;
    let mergedPullRequestSurface: PullRequestRightPanelSurface | null = null;
    if (parsedPullRequests.length > 0) {
      const activePrEntry =
        parsedPullRequests.find((entry) => entry.rawId === rawActiveSurfaceId) ?? null;
      pullRequestMatchedActive = activePrEntry !== null;
      const winningSelection =
        activePrEntry !== null
          ? activePrEntry.selection
          : (parsedPullRequests.find((entry) => entry.selection !== null)?.selection ?? null);
      mergedPullRequestSurface =
        winningSelection !== null
          ? { id: "pullRequest", kind: "pullRequest", selection: winningSelection }
          : { id: "pullRequest", kind: "pullRequest" };
    }

    // Re-insert merged singleton surfaces at their original first-seen positions.
    const insertions: Array<{ index: number; surface: RightPanelSurface }> = [];
    if (mergedTerminalSurface !== null) {
      insertions.push({ index: firstTerminalInsertIndex, surface: mergedTerminalSurface });
    }
    if (mergedPullRequestSurface !== null) {
      insertions.push({ index: firstPullRequestInsertIndex, surface: mergedPullRequestSurface });
    }
    insertions.sort((a, b) => a.index - b.index);
    let offset = 0;
    for (const insertion of insertions) {
      surfaces.splice(insertion.index + offset, 0, insertion.surface);
      offset += 1;
    }

    // Activity left the right panel for each pane's own inline panel.
    // A panel last showing it stays closed rather than reopening on
    // whatever surface happens to remain.
    const wasShowingActivity = rawActiveSurfaceId === "activity";
    const resolvedActiveSurfaceId = terminalMatchedActive
      ? "terminal"
      : pullRequestMatchedActive
        ? "pullRequest"
        : rawActiveSurfaceId;
    const activeSurfaceId = surfaces.some((surface) => surface.id === resolvedActiveSurfaceId)
      ? resolvedActiveSurfaceId
      : wasShowingActivity
        ? (surfaces[0]?.id ?? null)
        : null;
    const allPersistedSurfacesWereInvalid = rawSurfaces.length > 0 && surfaces.length === 0;
    const isOpen =
      allPersistedSurfacesWereInvalid || wasShowingActivity
        ? false
        : typeof validThreadState?.isOpen === "boolean"
          ? validThreadState.isOpen
          : activeSurfaceId !== null;
    byThreadKey[threadKey] = { isOpen, surfaces, activeSurfaceId };
  }

  return { byThreadKey, overflowTerminalIdsByThreadKey };
}

export function migratePersistedRightPanelState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadRightPanelState>;
} {
  return { byThreadKey: migratePersistedRightPanelStateWithOverflow(persistedState).byThreadKey };
}

// Never reused, even after a request is cleared: a mounted Files tree remembers the last ID it
// refreshed for. Not persisted, like the requests themselves.
let lastFilesRevealId = 0;

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      filesReveal: {},
      recentActiveSurfaceIdsByThreadKey: {},
      migratedOverflowTerminalIdsByThreadKey: {},
      consumeMigratedOverflowTerminalIds: (ref) => {
        const key = scopedThreadKey(ref);
        const ids = get().migratedOverflowTerminalIdsByThreadKey[key];
        if (!ids || ids.length === 0) return [];
        set((state) => {
          if (!(key in state.migratedOverflowTerminalIdsByThreadKey)) return state;
          const { [key]: _consumed, ...rest } = state.migratedOverflowTerminalIdsByThreadKey;
          return { migratedOverflowTerminalIdsByThreadKey: rest };
        });
        return ids;
      },
      revealInFiles: (ref, relativePath) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          return {
            ...updateThreadWithHistory(state, key, (current) =>
              upsertSurface(current, singletonSurface("files")),
            ),
            filesReveal: {
              ...state.filesReveal,
              [key]: {
                path: relativePath.replace(/^\/+|\/+$/g, ""),
                requestId: ++lastFilesRevealId,
              },
            },
          };
        }),
      clearFilesReveal: (ref, requestId) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (state.filesReveal[key]?.requestId !== requestId) return state;
          const { [key]: _handled, ...rest } = state.filesReveal;
          return { filesReveal: rest };
        }),
      open: (ref, kind) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            // Diff replaces one showing a chat panel's thread; other singletons keep their state.
            return kind === "diff"
              ? replaceSurface(current, singletonSurface(kind))
              : upsertSurface(current, singletonSurface(kind));
          }),
        ),
      openDiff: (ref, threadId) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) =>
            replaceSurface(current, diffSurface(ref, threadId)),
          ),
        ),
      openBrowser: (ref, tabId) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
          }),
        ),
      openPullRequest: (ref, request, tab) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const existing = current.surfaces.find(
              (surface): surface is PullRequestRightPanelSurface => surface.kind === "pullRequest",
            );
            const nextTab =
              tab ??
              (existing?.selection?.number === request.number
                ? existing.selection.tab
                : "conversation");
            const nextSurface: PullRequestRightPanelSurface = {
              id: "pullRequest",
              kind: "pullRequest",
              selection: {
                number: request.number,
                provider: request.provider,
                tab: nextTab,
              },
            };
            return replaceSurface(current, nextSurface);
          }),
        ),
      clearPullRequestSelection: (ref) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const existing = current.surfaces.find(
              (surface): surface is PullRequestRightPanelSurface => surface.kind === "pullRequest",
            );
            if (!existing || existing.selection === undefined) {
              return existing
                ? { ...current, isOpen: true, activeSurfaceId: "pullRequest" }
                : current;
            }
            return replaceSurface(current, { id: "pullRequest", kind: "pullRequest" });
          }),
        ),
      setPullRequestTab: (ref, number, tab) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const existing = current.surfaces.find(
              (surface): surface is PullRequestRightPanelSurface =>
                surface.kind === "pullRequest" && surface.selection?.number === number,
            );
            if (!existing?.selection) return current;
            return {
              ...current,
              surfaces: current.surfaces.map((surface) =>
                surface.kind === "pullRequest" && surface.selection?.number === number
                  ? { ...surface, selection: { ...surface.selection, tab } }
                  : surface,
              ),
            };
          }),
        ),
      setDeviceImage: (ref, image) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find(
              (entry): entry is DeviceRightPanelSurface => entry.kind === "device",
            );
            if (
              surface === undefined ||
              (surface.image?.platform === image.platform &&
                surface.image.imageId === image.imageId)
            ) {
              return current;
            }
            const next: DeviceRightPanelSurface = {
              id: "device",
              kind: "device",
              image: { platform: image.platform, imageId: image.imageId },
            };
            return {
              ...current,
              surfaces: current.surfaces.map((entry) => (entry.kind === "device" ? next : entry)),
            };
          }),
        ),
      openFile: (ref, relativePath, line) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            // The Files tab is a peer: a file opens beside it and never replaces it.
            const surfaceId = `file:${relativePath}` as const;
            const existing = current.surfaces.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const surface = fileSurface(
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            );
            return {
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
                : [...current.surfaces, surface],
            };
          }),
        ),
      openTerminal: (ref, terminalId) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const existing = current.surfaces.find(
              (entry): entry is TerminalRightPanelSurface => entry.kind === "terminal",
            );
            if (!existing) {
              return upsertSurface(current, terminalSurface(terminalId));
            }
            if (existing.terminalIds.includes(terminalId)) {
              return {
                ...current,
                isOpen: true,
                activeSurfaceId: "terminal",
                surfaces: current.surfaces.map((entry) =>
                  entry.kind === "terminal" ? { ...entry, activeTerminalId: terminalId } : entry,
                ),
              };
            }
            if (existing.terminalIds.length >= MAX_TERMINALS_PER_GROUP) {
              return {
                ...current,
                isOpen: true,
                activeSurfaceId: "terminal",
              };
            }
            const nextSurface: TerminalRightPanelSurface = {
              ...existing,
              terminalIds: [...existing.terminalIds, terminalId],
              activeTerminalId: terminalId,
            };
            return replaceSurface(current, nextSurface);
          }),
        ),
      splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") => {
        let didSplit = false;
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (
              surface?.kind !== "terminal" ||
              surface.terminalIds.includes(terminalId) ||
              surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
            ) {
              return current;
            }
            didSplit = true;
            const { splitDirection: _splitDirection, ...baseSurface } = surface;
            const nextSurface: TerminalRightPanelSurface = {
              ...baseSurface,
              terminalIds: [...surface.terminalIds, terminalId],
              activeTerminalId: terminalId,
              ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
            };
            return {
              ...current,
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surface.id ? nextSurface : entry,
              ),
            };
          }),
        );
        return didSplit;
      },
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        ),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current, recentIds) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
              const fallbackId = pickRemainingFallbackSurfaceId(surfaces, index, recentIds);
              return {
                ...current,
                isOpen: surfaces.length > 0 && current.isOpen,
                surfaces,
                activeSurfaceId:
                  current.activeSurfaceId === surfaceId ? fallbackId : current.activeSurfaceId,
              };
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      resourceId:
                        entry.resourceId === terminalId ? terminalIds[0]! : entry.resourceId,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        ),
      activateSurface: (ref, surfaceId) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        ),
      closeSurface: (ref, surfaceId, options) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current, recentIds) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const closing = current.surfaces[index]!;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (current.activeSurfaceId !== surfaceId) {
              return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
            }
            const fallbackId = pickRemainingFallbackSurfaceId(surfaces, index, recentIds);
            if (fallbackId !== null) {
              return {
                ...current,
                isOpen: current.isOpen,
                surfaces,
                activeSurfaceId: fallbackId,
              };
            }
            // Closing the last dynamic Browser/file tab while open activates the first available
            // singleton so the panel never goes blank after selection (D6).
            if (current.isOpen && isDynamicSurface(closing)) {
              const fallbackSingleton = resolveNonTerminalFallbackSingleton(
                options?.availableSingletons,
              );
              if (fallbackSingleton !== null) {
                const surface = singletonSurface(fallbackSingleton);
                return {
                  isOpen: true,
                  surfaces: [surface],
                  activeSurfaceId: surface.id,
                };
              }
            }
            return {
              ...current,
              isOpen: false,
              surfaces,
              activeSurfaceId: null,
            };
          }),
        ),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        ),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        ),
      closeAllSurfaces: (ref) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        ),
      reconcileBrowserSurfaces: (ref, tabIds) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current, recentIds) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                surface.kind === "preview" &&
                surface.id !== "browser:new" &&
                validIds.has(surface.id),
            );
            const knownIds = new Set(existingBrowser.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...nonBrowser, ...existingBrowser, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? pickRemainingFallbackSurfaceId(surfaces, 0, recentIds)),
            };
          }),
        ),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current, recentIds) => {
            if (workspaceAvailable) return current;
            const surfaces = current.surfaces.filter(
              (surface) => surface.kind !== "files" && surface.kind !== "file",
            );
            if (surfaces.length === current.surfaces.length) return current;
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              isOpen: surfaces.length > 0 ? current.isOpen : false,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : pickRemainingFallbackSurfaceId(surfaces, surfaces.length - 1, recentIds),
            };
          }),
        ),
      // Retarget open file surfaces after a rename/move. Rewrites the exact `file:${old}` surface and,
      // for a directory rename, every `file:${old}/…` descendant to sit under the new path — keeping
      // each surface's reveal state and the active-surface selection. A `file:${old}` prefix WITHOUT
      // the trailing "/" boundary is deliberately NOT matched (so renaming "src" leaves "srcfoo/x").
      remapFileSurfaces: (ref, oldRelativePath, newRelativePath) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const oldId = `file:${oldRelativePath}`;
            const childPrefix = `${oldId}/`;
            const idRemap = new Map<string, string>();
            for (const surface of current.surfaces) {
              if (surface.kind !== "file") continue;
              if (surface.id === oldId) {
                idRemap.set(surface.id, `file:${newRelativePath}`);
              } else if (surface.id.startsWith(childPrefix)) {
                idRemap.set(
                  surface.id,
                  `file:${newRelativePath}/${surface.id.slice(childPrefix.length)}`,
                );
              }
            }
            if (idRemap.size === 0) return current;
            const seen = new Set<string>();
            const surfaces: RightPanelSurface[] = [];
            for (const surface of current.surfaces) {
              const nextId = surface.kind === "file" ? idRemap.get(surface.id) : undefined;
              const next: RightPanelSurface =
                nextId !== undefined && surface.kind === "file"
                  ? {
                      ...surface,
                      id: nextId as `file:${string}`,
                      relativePath: nextId.slice("file:".length),
                    }
                  : surface;
              if (seen.has(next.id)) continue;
              seen.add(next.id);
              surfaces.push(next);
            }
            const activeSurfaceId =
              current.activeSurfaceId !== null
                ? (idRemap.get(current.activeSurfaceId) ?? current.activeSurfaceId)
                : null;
            return { ...current, surfaces, activeSurfaceId };
          }),
        ),
      // Close the file surface at `relativePath` and, for a deleted directory, every descendant under
      // it (same trailing-slash boundary as remap). Falls the active selection back to a neighbor the
      // way closeSurface does, and closes the panel when nothing is left.
      closeFileSurfacesUnder: (ref, relativePath) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current, recentIds) => {
            const targetId = `file:${relativePath}`;
            const childPrefix = `${targetId}/`;
            const isRemoved = (surface: RightPanelSurface): boolean =>
              surface.kind === "file" &&
              (surface.id === targetId || surface.id.startsWith(childPrefix));
            const activeIndex = current.surfaces.findIndex(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const surfaces = current.surfaces.filter((surface) => !isRemoved(surface));
            if (surfaces.length === current.surfaces.length) return current;
            const activeRemoved =
              current.activeSurfaceId !== null &&
              !surfaces.some((surface) => surface.id === current.activeSurfaceId);
            const fallbackId = activeRemoved
              ? pickRemainingFallbackSurfaceId(surfaces, activeIndex, recentIds)
              : null;
            return {
              ...current,
              isOpen: surfaces.length > 0 && current.isOpen,
              surfaces,
              activeSurfaceId: activeRemoved ? fallbackId : current.activeSurfaceId,
            };
          }),
        ),
      show: (ref) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        ),
      close: (ref) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        ),
      toggleVisibility: (ref) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        ),
      toggle: (ref, kind) =>
        set((state) =>
          updateThreadWithHistory(state, scopedThreadKey(ref), (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            // Diff replaces one showing a chat panel's thread; other surfaces keep their state.
            return kind === "diff"
              ? replaceSurface(current, singletonSurface(kind))
              : upsertSurface(current, singletonSurface(kind));
          }),
        ),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          const { [threadKey]: _removedRecent, ...restRecent } =
            state.recentActiveSurfaceIdsByThreadKey;
          const { [threadKey]: _removedOverflow, ...restOverflow } =
            state.migratedOverflowTerminalIdsByThreadKey;
          // A host's Diff on this (chat panel) thread goes back to the host's own diff.
          let changed =
            threadKey in state.byThreadKey ||
            threadKey in state.recentActiveSurfaceIdsByThreadKey ||
            threadKey in state.migratedOverflowTerminalIdsByThreadKey;
          for (const [key, thread] of Object.entries(rest)) {
            if (parseScopedThreadKey(key)?.environmentId !== ref.environmentId) continue;
            if (!thread.surfaces.some((s) => s.kind === "diff" && s.threadId === ref.threadId)) {
              continue;
            }
            changed = true;
            rest[key] = {
              ...thread,
              surfaces: thread.surfaces.map((s) =>
                s.kind === "diff" && s.threadId === ref.threadId ? { id: "diff", kind: "diff" } : s,
              ),
            };
          }
          return changed
            ? {
                byThreadKey: rest,
                recentActiveSurfaceIdsByThreadKey: restRecent,
                migratedOverflowTerminalIdsByThreadKey: restOverflow,
              }
            : state;
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      migrate: (persistedState) => {
        const migrated = migratePersistedRightPanelStateWithOverflow(persistedState);
        return {
          byThreadKey: migrated.byThreadKey,
          migratedOverflowTerminalIdsByThreadKey: migrated.overflowTerminalIdsByThreadKey,
        };
      },
      merge: (persistedState, currentState) => {
        if (persistedState === undefined) return currentState;
        const sanitized = migratePersistedRightPanelStateWithOverflow(persistedState);
        const migratedOverflow: Record<string, string[]> = {
          ...sanitized.overflowTerminalIdsByThreadKey,
        };
        if (
          isRecord(persistedState) &&
          isRecord(persistedState.migratedOverflowTerminalIdsByThreadKey)
        ) {
          for (const [threadKey, rawIds] of Object.entries(
            persistedState.migratedOverflowTerminalIdsByThreadKey,
          )) {
            if (!Array.isArray(rawIds)) continue;
            const validIds = rawIds.filter((id): id is string => isNonEmptyString(id));
            if (validIds.length === 0) continue;
            migratedOverflow[threadKey] = [
              ...new Set([...(migratedOverflow[threadKey] ?? []), ...validIds]),
            ];
          }
        }
        return {
          ...currentState,
          byThreadKey: sanitized.byThreadKey,
          migratedOverflowTerminalIdsByThreadKey: migratedOverflow,
        };
      },
    },
  ),
);

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

/** The image the thread's Device pane remembers, if it has a device surface with one. */
export function selectDeviceSurfaceImage(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): DeviceSurfaceImage | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return (
    state.surfaces.find((surface): surface is DeviceRightPanelSurface => surface.kind === "device")
      ?.image ?? null
  );
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
