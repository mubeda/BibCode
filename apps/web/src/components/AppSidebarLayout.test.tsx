// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
let menuListener: ((action: string) => void) | undefined;
const layoutCapture = vi.hoisted(() => ({
  sidebarProps: null as Record<string, unknown> | null,
  threadSidebarRenders: 0,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("./Sidebar", () => ({
  default: () => {
    layoutCapture.threadSidebarRenders += 1;
    return <nav data-testid="environment-tree-sidebar" />;
  },
}));

vi.mock("./ui/sidebar", () => ({
  Sidebar: (props: Record<string, unknown>) => {
    layoutCapture.sidebarProps = props;
    return <aside>{props.children as ReactNode}</aside>;
  },
  SidebarProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SidebarRail: () => null,
  SidebarTrigger: () => null,
  useSidebar: () => ({ toggleSidebar: vi.fn() }),
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipPopup: () => null,
  TooltipTrigger: ({ render }: { render?: ReactNode }) => <>{render}</>,
}));

import { AppSidebarLayout } from "./AppSidebarLayout";
import { toastManager } from "./ui/toast";

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

afterEach(async () => {
  await act(async () => {
    for (const entry of mounted.splice(0)) entry.root.unmount();
  });
  navigate.mockReset();
  menuListener = undefined;
  layoutCapture.sidebarProps = null;
  layoutCapture.threadSidebarRenders = 0;
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

describe("AppSidebarLayout", () => {
  it("mounts one navigation-only left sidebar and keeps workspace content central", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(
        <AppSidebarLayout>
          <article data-testid="workspace">Workspace</article>
        </AppSidebarLayout>,
      );
    });

    expect(layoutCapture.threadSidebarRenders).toBe(1);
    expect(layoutCapture.sidebarProps).toMatchObject({
      "aria-label": "Environment navigation",
      side: "left",
      collapsible: "offcanvas",
    });
    expect(container.querySelectorAll('[data-testid="environment-tree-sidebar"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="workspace"]')).toHaveLength(1);
  });

  it("routes supported desktop menu actions independently", async () => {
    const checkForUpdate = vi.fn(() => Promise.resolve({ checked: true }));
    Object.assign(window, {
      desktopBridge: {
        checkForUpdate,
        onMenuAction: (listener: (action: string) => void) => {
          menuListener = listener;
          return vi.fn();
        },
      },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(<AppSidebarLayout>Workspace</AppSidebarLayout>);
    });

    menuListener?.("check-for-updates");
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    menuListener?.("open-settings");
    expect(navigate).toHaveBeenCalledWith({ to: "/settings" });
  });

  it("suppresses rejected desktop update checks", async () => {
    let rejectedUpdate: Promise<never> | undefined;
    const handleRejection = vi.fn();
    const addToast = vi.spyOn(toastManager, "add");
    const checkForUpdate = vi.fn(() => {
      rejectedUpdate = Promise.reject(new Error("IPC unavailable"));
      const originalCatch = rejectedUpdate.catch.bind(rejectedUpdate);
      vi.spyOn(rejectedUpdate, "catch").mockImplementation((onRejected) => {
        handleRejection();
        return originalCatch(onRejected);
      });
      return rejectedUpdate;
    });
    Object.assign(window, {
      desktopBridge: {
        checkForUpdate,
        onMenuAction: (listener: (action: string) => void) => {
          menuListener = listener;
          return vi.fn();
        },
      },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });

    try {
      await act(async () => {
        root.render(<AppSidebarLayout>Workspace</AppSidebarLayout>);
      });

      menuListener?.("check-for-updates");
      await Promise.resolve();

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      expect(handleRejection).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
      expect(addToast).not.toHaveBeenCalled();
    } finally {
      addToast.mockRestore();
    }
  });
});
