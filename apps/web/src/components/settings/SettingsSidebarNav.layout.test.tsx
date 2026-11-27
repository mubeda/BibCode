// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createEnvironmentPresentationPolicy } from "~/connection/environmentPresentationPolicy";

const h = vi.hoisted(() => ({
  policy: null as ReturnType<
    typeof import("~/connection/environmentPresentationPolicy").createEnvironmentPresentationPolicy
  > | null,
  hasCloudConfig: false,
  clerkAuth: { isLoaded: false, isSignedIn: false },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useCanGoBack: () => false,
}));

vi.mock("~/connection/currentEnvironmentPresentation", () => ({
  readCurrentEnvironmentPresentationPolicy: () => h.policy,
}));

vi.mock("~/cloud/publicConfig", () => ({
  hasCloudPublicConfig: () => h.hasCloudConfig,
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => h.clerkAuth,
  UserButton: () => <button data-clerk-user-button="true">Account</button>,
}));

vi.mock("../clerk/useBiBCodeConnectAuthPrompt", () => ({
  useBiBCodeConnectAuthPrompt: () => ({
    authPrompt: null,
    openAuthPrompt: vi.fn(),
  }),
}));

import { Sidebar, SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

let renderSeq = 0;

async function renderRealSidebar(pathname = "/settings/general") {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  renderSeq += 1;
  await act(async () => {
    root!.render(
      <SidebarProvider key={renderSeq} defaultOpen>
        <Sidebar collapsible="none">
          <SettingsSidebarNav pathname={pathname} />
        </Sidebar>
      </SidebarProvider>,
    );
  });
  return container;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.policy = createEnvironmentPresentationPolicy({ surface: "desktop", platform: "macos" });
  h.hasCloudConfig = false;
  h.clerkAuth = { isLoaded: false, isSignedIn: false };
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

describe("SettingsSidebarNav real sidebar layout and Connect footer states", () => {
  it("mounts Back in a non-scrolling header outside the real ScrollArea viewport with a visible divider and high-contrast nav labels", async () => {
    const dom = await renderRealSidebar("/settings/general");
    const header = dom.querySelector<HTMLElement>('[data-slot="sidebar-header"]');
    const viewport = dom.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const content = dom.querySelector<HTMLElement>('[data-slot="sidebar-content"]');
    const separator = dom.querySelector<HTMLElement>('[data-slot="sidebar-separator"]');

    expect(header).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(content).not.toBeNull();
    expect(separator?.className).toContain("bg-border");

    // Back sits inside the non-scrolling header, outside and before the ScrollArea viewport.
    expect(header!.textContent).toContain("Back");
    expect(viewport!.contains(header!)).toBe(false);
    expect(viewport!.contains(content!)).toBe(true);
    expect(content!.textContent).toContain("General");
    expect(content!.textContent).toContain("About");
    expect(
      Boolean(header!.compareDocumentPosition(viewport!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    // Inactive section labels follow UI.md (13px medium foreground/80, never muted-foreground/70).
    const appearanceButton = Array.from(content!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Appearance"),
    );
    expect(appearanceButton?.className).toContain("font-medium");
    expect(appearanceButton?.className).toContain("text-foreground/80");
    expect(appearanceButton?.className).not.toContain("text-muted-foreground/70");
  });

  it("hides empty Connect footer in unconfigured/loading browser states and renders only the applicable control once loaded", async () => {
    h.policy = createEnvironmentPresentationPolicy({ surface: "browser", platform: "unknown" });

    // 1. Self-hosted browser (no Clerk public config): footer exists with empty:hidden and zero children.
    h.hasCloudConfig = false;
    let dom = await renderRealSidebar();
    let footer = dom.querySelector<HTMLElement>('[data-slot="sidebar-footer"]');
    expect(footer?.className).toContain("empty:hidden");
    expect(footer?.className).toContain("border-border");
    expect(footer?.childNodes.length).toBe(0);

    // 2. Cloud configured, Clerk still loading: zero children (collapsed by empty:hidden).
    h.hasCloudConfig = true;
    h.clerkAuth = { isLoaded: false, isSignedIn: false };
    dom = await renderRealSidebar();
    footer = dom.querySelector<HTMLElement>('[data-slot="sidebar-footer"]');
    expect(footer?.childNodes.length).toBe(0);

    // 3. Signed out: renders Sign in control only.
    h.clerkAuth = { isLoaded: true, isSignedIn: false };
    dom = await renderRealSidebar();
    footer = dom.querySelector<HTMLElement>('[data-slot="sidebar-footer"]');
    expect(footer?.textContent).toContain("Sign in to BiBCode Connect");
    expect(footer?.querySelector('[data-clerk-user-button="true"]')).toBeNull();

    // 4. Signed in: renders Clerk avatar only.
    h.clerkAuth = { isLoaded: true, isSignedIn: true };
    dom = await renderRealSidebar();
    footer = dom.querySelector<HTMLElement>('[data-slot="sidebar-footer"]');
    expect(footer?.textContent).not.toContain("Sign in to BiBCode Connect");
    expect(footer?.querySelector('[data-clerk-user-button="true"]')).not.toBeNull();
  });
});
