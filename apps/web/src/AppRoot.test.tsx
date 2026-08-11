import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import type { DesktopPreviewBridge } from "@bibcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ previewBridge: null as DesktopPreviewBridge | null }));

vi.mock("./components/preview/previewBridge", () => ({
  get previewBridge() {
    return h.previewBridge;
  },
}));

import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { ThreadLifecycleReconciler } from "./ThreadLifecycleReconciler";
import { registerPreviewRuntimeCapabilities } from "./previewRuntimeCapabilities";
import { AppRoot, ProjectDataRecoveryCoordinator } from "./AppRoot";

describe("AppRoot", () => {
  beforeEach(() => {
    h.previewBridge = {} as DesktopPreviewBridge;
  });

  it("shares the application atom registry with routed UI and preview automation", () => {
    const root = AppRoot({ router: {} as AppRouter });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(children).toHaveLength(4);
    expect(isValidElement(children[0]) && children[0].type).toBe(ThreadLifecycleReconciler);
    expect(isValidElement(children[1]) && children[1].type).toBe(ProjectDataRecoveryCoordinator);
    expect(isValidElement(children[2]) && children[2].type).toBe(RouterProvider);
    expect(isValidElement(children[3]) && children[3].type).toBe(PreviewAutomationHosts);
  });

  it("omits preview automation hosts when the runtime does not support automation", () => {
    const bridge = {} as DesktopPreviewBridge;
    registerPreviewRuntimeCapabilities(bridge, {
      picker: false,
      recording: false,
      automation: false,
      imageClipboard: false,
    });
    h.previewBridge = bridge;

    const root = AppRoot({ router: {} as AppRouter });
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );

    expect(children).toHaveLength(3);
    expect(isValidElement(children[0]) && children[0].type).toBe(ThreadLifecycleReconciler);
    expect(isValidElement(children[1]) && children[1].type).toBe(ProjectDataRecoveryCoordinator);
    expect(isValidElement(children[2]) && children[2].type).toBe(RouterProvider);
  });
});
