import type {
  DesktopPreviewBounds,
  DesktopPreviewBridge,
  DesktopPreviewScreenshotArtifact,
  DesktopPreviewTabState,
} from "@bibcode/contracts";

import { TauriDesktopCapabilityUnsupportedError } from "./tauriDesktopBridge";
import { registerPreviewRuntimeCapabilities } from "./previewRuntimeCapabilities";

interface PreviewBridgeDeps {
  readonly invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  readonly listen: <T>(event: string, listener: (payload: T) => void) => () => void;
}

interface PreviewStateEventPayload {
  readonly tabId: string;
  readonly state: DesktopPreviewTabState;
}

function unsupported(capability: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new TauriDesktopCapabilityUnsupportedError(
        capability,
        capability,
        `preview capability not supported yet on this host: ${capability}`,
      ),
    );
}

export function createTauriPreviewBridge(deps: PreviewBridgeDeps): DesktopPreviewBridge {
  const { invoke, listen } = deps;
  const zoomByTab = new Map<string, number>();
  const stateByTab = new Map<string, DesktopPreviewTabState>();
  const boundsByTab = new Map<
    string,
    { readonly bounds: DesktopPreviewBounds; readonly visible: boolean }
  >();
  const pendingByTab = new Map<string, Promise<void>>();
  const stateListeners = new Set<(tabId: string, state: DesktopPreviewTabState) => void>();
  let stopStateEvents: (() => void) | null = null;
  // Recreating child webviews while switching logical tabs can disconnect the parent app.
  // Keep one native child for the desktop process lifetime and rebind logical tabs to it.
  let nativeHostTabId: string | null = null;
  let activeTabId: string | null = null;

  const publishState = (tabId: string, state: DesktopPreviewTabState) => {
    stateByTab.set(tabId, state);
    for (const listener of stateListeners) listener(tabId, state);
  };

  // The native host emits no event for its initial about:blank page, so a new
  // blank tab would otherwise never report itself as present.
  const publishIdleIfUnknown = (tabId: string) => {
    if (stateByTab.has(tabId)) return;
    publishState(tabId, {
      tabId,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: zoomByTab.get(tabId) ?? 1,
      controller: "human",
      updatedAt: new Date().toISOString(),
    });
  };

  const startStateEvents = () => {
    if (stopStateEvents) return;
    stopStateEvents = listen<PreviewStateEventPayload>("preview://state", (payload) => {
      if (nativeHostTabId !== null && payload.tabId === nativeHostTabId) {
        if (activeTabId === null) return;
        const state = { ...payload.state, tabId: activeTabId };
        zoomByTab.set(activeTabId, state.zoomFactor);
        publishState(activeTabId, state);
        return;
      }
      zoomByTab.set(payload.tabId, payload.state.zoomFactor);
      publishState(payload.tabId, payload.state);
    });
  };

  const enqueueTabOperation = (tabId: string, operation: () => Promise<void>): Promise<void> => {
    const pending = pendingByTab.get(tabId);
    let result: Promise<void>;
    try {
      result = pending === undefined ? operation() : pending.then(operation);
    } catch (error) {
      result = Promise.reject(error);
    }

    const tail = result.then(
      () => {
        if (pendingByTab.get(tabId) === tail) pendingByTab.delete(tabId);
      },
      () => {
        if (pendingByTab.get(tabId) === tail) pendingByTab.delete(tabId);
      },
    );
    pendingByTab.set(tabId, tail);
    return result;
  };

  const invokeForTab = <T>(
    command: string,
    tabId: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => invoke<T>(command, { ...args, tabId: nativeHostTabId ?? tabId });

  const setZoom = (tabId: string, getFactor: (committed: number) => number): Promise<void> =>
    enqueueTabOperation(tabId, async () => {
      const factor = Math.min(3, Math.max(0.25, getFactor(zoomByTab.get(tabId) ?? 1)));
      await invokeForTab("desktop_preview_set_zoom", tabId, { factor });
      zoomByTab.set(tabId, factor);
      const state = stateByTab.get(tabId);
      if (state) publishState(tabId, { ...state, zoomFactor: factor });
    });

  const bridge: DesktopPreviewBridge = {
    createTab: (tabId) =>
      enqueueTabOperation(tabId, async () => {
        activeTabId = tabId;
        if (nativeHostTabId !== null) {
          const presentation = boundsByTab.get(tabId);
          if (presentation) {
            await invoke("desktop_preview_set_bounds", {
              tabId: nativeHostTabId,
              bounds: presentation.bounds,
              visible: presentation.visible,
            });
          }
          publishIdleIfUnknown(tabId);
          return;
        }
        try {
          await invoke("desktop_preview_create_tab", { tabId });
          nativeHostTabId = tabId;
        } catch (error) {
          if (activeTabId === tabId) activeTabId = null;
          throw error;
        }
        publishIdleIfUnknown(tabId);
      }),
    closeTab: (tabId) =>
      enqueueTabOperation(tabId, async () => {
        if (nativeHostTabId === null) {
          await invoke("desktop_preview_close_tab", { tabId });
        } else if (activeTabId === tabId) {
          const presentation = boundsByTab.get(tabId);
          if (presentation) {
            await invoke("desktop_preview_set_bounds", {
              tabId: nativeHostTabId,
              bounds: presentation.bounds,
              visible: false,
            });
          }
          activeTabId = null;
        }
        zoomByTab.delete(tabId);
        stateByTab.delete(tabId);
        boundsByTab.delete(tabId);
      }),
    setBounds: (tabId, bounds: DesktopPreviewBounds, visible) => {
      boundsByTab.set(tabId, { bounds, visible });
      if (nativeHostTabId !== null && activeTabId !== tabId) return Promise.resolve();
      return invoke("desktop_preview_set_bounds", {
        tabId: nativeHostTabId ?? tabId,
        bounds,
        visible,
      });
    },
    navigate: async (tabId, url) => {
      // Until the native load event arrives, status would report the old page as
      // loaded and readiness waits would return early; report the target as loading.
      // A fragment change on the same document fires no page-load event, so it stays as is.
      const previous = stateByTab.get(tabId);
      const currentUrl = previous?.navStatus.kind === "Idle" ? null : previous?.navStatus.url;
      const sameDocument = url.includes("#") && currentUrl?.split("#")[0] === url.split("#")[0];
      const loading: DesktopPreviewTabState | undefined =
        previous && !sameDocument
          ? { ...previous, navStatus: { kind: "Loading", url, title: "" } }
          : undefined;
      if (loading) publishState(tabId, loading);
      try {
        await invokeForTab("desktop_preview_navigate", tabId, { url });
      } catch (error) {
        if (previous && stateByTab.get(tabId) === loading) publishState(tabId, previous);
        throw error;
      }
    },
    goBack: (tabId) => invokeForTab("desktop_preview_go_back", tabId),
    goForward: (tabId) => invokeForTab("desktop_preview_go_forward", tabId),
    refresh: (tabId) => invokeForTab("desktop_preview_refresh", tabId),
    zoomIn: (tabId) => setZoom(tabId, (factor) => factor + 0.1),
    zoomOut: (tabId) => setZoom(tabId, (factor) => factor - 0.1),
    resetZoom: (tabId) => setZoom(tabId, () => 1),
    hardReload: (tabId) => invokeForTab("desktop_preview_hard_reload", tabId),
    openDevTools: (tabId) => invokeForTab("desktop_preview_open_devtools", tabId),
    clearCookies: () =>
      invoke("desktop_preview_clear_data", { cookies: true, cache: false, storage: true }),
    clearCache: () =>
      invoke("desktop_preview_clear_data", { cookies: false, cache: true, storage: false }),
    setAnnotationTheme: () => Promise.resolve(),
    pickElement: unsupported("preview.pickElement"),
    cancelPickElement: () => Promise.resolve(),
    captureScreenshot: (tabId) =>
      invokeForTab<DesktopPreviewScreenshotArtifact>(
        "desktop_preview_capture_screenshot",
        tabId,
      ).then((artifact) => ({ ...artifact, tabId })),
    revealArtifact: (path) => invoke("desktop_preview_reveal_artifact", { path }),
    copyArtifactToClipboard: unsupported("preview.copyArtifactToClipboard"),
    recording: {
      startScreencast: unsupported("preview.recording"),
      stopScreencast: unsupported("preview.recording"),
      save: unsupported("preview.recording"),
      onFrame: () => () => {},
    },
    automation: {
      status: async (tabId) => {
        const state = stateByTab.get(tabId);
        const nav = state?.navStatus;
        const loaded = nav && nav.kind !== "Idle" ? nav : null;
        return {
          available: state !== undefined,
          visible: true,
          tabId,
          url: loaded?.url ?? null,
          title: loaded?.title ?? null,
          loading: nav?.kind === "Loading",
        };
      },
      snapshot: unsupported("preview.automation"),
      click: unsupported("preview.automation"),
      type: unsupported("preview.automation"),
      press: unsupported("preview.automation"),
      scroll: unsupported("preview.automation"),
      evaluate: unsupported("preview.automation"),
      waitFor: unsupported("preview.automation"),
    },
    onStateChange: (listener) => {
      stateListeners.add(listener);
      startStateEvents();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        stateListeners.delete(listener);
        if (stateListeners.size > 0) return;
        stopStateEvents?.();
        stopStateEvents = null;
      };
    },
    onNewWindowRequest: (listener) =>
      listen<{ tabId: string; url: string }>("preview://new-window", (payload) => {
        // One native child is reused for every logical tab (see nativeHostTabId);
        // remap exactly like the preview://state handler does.
        const tabId =
          nativeHostTabId !== null && payload.tabId === nativeHostTabId
            ? activeTabId
            : payload.tabId;
        if (tabId !== null) listener(tabId, payload.url);
      }),
    onPointerEvent: () => () => {},
  };

  registerPreviewRuntimeCapabilities(bridge, {
    picker: false,
    recording: false,
    automation: false,
    imageClipboard: false,
  });
  return bridge;
}
