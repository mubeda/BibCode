// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
}));
vi.mock("../../../centerPanelActions", () => ({
  usePanelThreadOpener: () => ({ openPanelThread: vi.fn() }),
}));
vi.mock("../../ui/sidebar", () => ({
  SidebarContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SidebarGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("./useInboxAgentRows", () => ({
  useInboxAgentRows: () => ({ rows: [], dataState: "failed", partialReason: null }),
}));

import { SidebarInboxView } from "./SidebarInboxView";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("SidebarInboxView when the connection runtime failed", () => {
  it("shows the failure with a Reload that calls its handler instead of loading agents", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const onReload = vi.fn();
    await act(async () => root!.render(<SidebarInboxView onReload={onReload} />));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Connections could not start",
    );
    expect(container.textContent).not.toContain("Loading agents");
    // Beside the error, no tile may announce itself as loading or claim a count.
    expect(container.querySelector('[data-testid^="inbox-tile-"]')).toBeNull();
    const reload = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reload",
    );
    expect(reload, "the Reload button").toBeDefined();
    await act(async () => reload!.click());
    expect(onReload).toHaveBeenCalledOnce();
  });
});
