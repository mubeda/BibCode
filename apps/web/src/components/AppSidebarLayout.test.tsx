// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
let menuListener: ((action: string) => void) | undefined;

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("./Sidebar", () => ({
  default: () => <div data-testid="thread-sidebar-mock" />,
}));

vi.mock("./sidebar/EnvironmentRail", () => ({
  EnvironmentRail: () => <div data-testid="environment-rail-mock" />,
}));

const sidebarProviderProps: Array<Record<string, unknown>> = [];

const sidebarProps: Array<Record<string, unknown>> = [];

vi.mock("./ui/sidebar", () => ({
  Sidebar: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    sidebarProps.push(props);
    return <>{children}</>;
  },
  SidebarProvider: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    sidebarProviderProps.push(props);
    return <>{children}</>;
  },
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
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

describe("AppSidebarLayout", () => {
  it("opens the left sidebar at 320px by default so 13px titles and 12px badges fit", async () => {
    sidebarProviderProps.length = 0;
    sidebarProps.length = 0;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<AppSidebarLayout>Workspace</AppSidebarLayout>);
    });
    const style = sidebarProviderProps[0]?.["style"] as Record<string, string> | undefined;
    expect(style?.["--sidebar-width"]).toBe("320px");
    const resizable = sidebarProps[0]?.["resizable"] as Record<string, unknown> | undefined;
    expect(resizable?.["defaultWidth"]).toBe(320);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("mounts the environment rail before the panel content inside the left sidebar", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(<AppSidebarLayout>Workspace</AppSidebarLayout>);
    });

    const rail = container.querySelector('[data-testid="environment-rail-mock"]');
    const panel = container.querySelector('[data-testid="thread-sidebar-mock"]');
    expect(rail).not.toBeNull();
    expect(panel).not.toBeNull();
    if (rail === null || panel === null) throw new Error("sidebar layout markers missing");
    expect(rail.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
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
