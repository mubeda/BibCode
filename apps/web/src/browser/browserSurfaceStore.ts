import { create } from "zustand";

export interface BrowserSurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserSurfacePresentation {
  readonly rect: BrowserSurfaceRect | null;
  readonly visible: boolean;
  readonly content: BrowserSurfaceContentPresentation | null;
  readonly updatedAt: number;
  readonly owner: symbol | null;
}

export interface BrowserSurfaceContentPresentation {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

interface BrowserSurfaceStoreState {
  readonly byTabId: Record<string, BrowserSurfacePresentation>;
  /** Occlusion leases by owner; a null rectangle covers every surface. */
  readonly occlusionOwners: ReadonlyMap<symbol, BrowserSurfaceRect | null>;
  readonly claim: (tabId: string, owner: symbol) => void;
  readonly present: (
    tabId: string,
    owner: symbol,
    rect: BrowserSurfaceRect,
    visible: boolean,
  ) => void;
  readonly presentContent: (tabId: string, content: BrowserSurfaceContentPresentation) => void;
  readonly release: (tabId: string, owner: symbol) => void;
}

export interface BrowserSurfaceLease {
  readonly present: (rect: BrowserSurfaceRect, visible: boolean) => void;
  readonly release: () => void;
}

export interface BrowserSurfaceOcclusionLease {
  readonly update: (rect: BrowserSurfaceRect | null) => void;
  readonly release: () => void;
}

const rectsOverlap = (left: BrowserSurfaceRect, right: BrowserSurfaceRect): boolean =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height;

export function isBrowserSurfaceOccluded(
  rect: BrowserSurfaceRect,
  owners: ReadonlyMap<symbol, BrowserSurfaceRect | null>,
): boolean {
  for (const owner of owners.values()) {
    if (owner === null || rectsOverlap(rect, owner)) return true;
  }
  return false;
}

export function resolveBrowserSurfacePanelRect(
  byTabId: Readonly<Record<string, BrowserSurfacePresentation>>,
  tabId: string,
): BrowserSurfaceRect | null {
  const current = byTabId[tabId];
  if (current?.visible && current.rect) return current.rect;

  let latestVisible: BrowserSurfacePresentation | undefined;
  for (const presentation of Object.values(byTabId)) {
    if (
      presentation.visible &&
      presentation.rect &&
      (!latestVisible || presentation.updatedAt > latestVisible.updatedAt)
    ) {
      latestVisible = presentation;
    }
  }
  return latestVisible?.rect ?? current?.rect ?? null;
}

const rectEquals = (left: BrowserSurfaceRect | null, right: BrowserSurfaceRect): boolean =>
  left !== null &&
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

export const useBrowserSurfaceStore = create<BrowserSurfaceStoreState>()((set) => ({
  byTabId: {},
  occlusionOwners: new Map(),
  claim: (tabId, owner) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner === owner) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: {
            rect: current?.rect ?? null,
            visible: false,
            content: current?.content ?? null,
            updatedAt: Date.now(),
            owner,
          },
        },
      };
    }),
  present: (tabId, owner, rect, visible) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      if (current && current.visible === visible && rectEquals(current.rect, rect)) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, rect, visible, updatedAt: Date.now() },
        },
      };
    }),
  presentContent: (tabId, content) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (!current) {
        return {
          byTabId: {
            ...state.byTabId,
            [tabId]: {
              rect: null,
              visible: false,
              content,
              updatedAt: Date.now(),
              owner: null,
            },
          },
        };
      }
      const previous = current.content;
      if (
        previous &&
        previous.x === content.x &&
        previous.y === content.y &&
        previous.width === content.width &&
        previous.height === content.height &&
        previous.scale === content.scale &&
        previous.scrollLeft === content.scrollLeft &&
        previous.scrollTop === content.scrollTop
      ) {
        return state;
      }
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, content, updatedAt: Date.now() },
        },
      };
    }),
  release: (tabId, owner) =>
    set((state) => {
      const current = state.byTabId[tabId];
      if (current?.owner !== owner) return state;
      return {
        byTabId: {
          ...state.byTabId,
          [tabId]: { ...current, visible: false, updatedAt: Date.now(), owner: null },
        },
      };
    }),
}));

export function acquireBrowserSurfaceOcclusion(
  rect: BrowserSurfaceRect | null = null,
): BrowserSurfaceOcclusionLease {
  const owner = Symbol("browser-surface-occlusion");
  let released = false;
  useBrowserSurfaceStore.setState((state) => ({
    occlusionOwners: new Map(state.occlusionOwners).set(owner, rect),
  }));

  return {
    update: (next) => {
      if (released) return;
      useBrowserSurfaceStore.setState((state) => {
        if (!state.occlusionOwners.has(owner)) return state;
        return { occlusionOwners: new Map(state.occlusionOwners).set(owner, next) };
      });
    },
    release: () => {
      if (released) return;
      released = true;
      useBrowserSurfaceStore.setState((state) => {
        if (!state.occlusionOwners.has(owner)) return state;
        const occlusionOwners = new Map(state.occlusionOwners);
        occlusionOwners.delete(owner);
        return { occlusionOwners };
      });
    },
  };
}

export function acquireBrowserSurface(tabId: string): BrowserSurfaceLease {
  const owner = Symbol(`browser-surface:${tabId}`);
  let released = false;
  useBrowserSurfaceStore.getState().claim(tabId, owner);

  return {
    present: (rect, visible) => {
      if (released) return;
      useBrowserSurfaceStore.getState().present(tabId, owner, rect, visible);
    },
    release: () => {
      if (released) return;
      released = true;
      useBrowserSurfaceStore.getState().release(tabId, owner);
    },
  };
}
