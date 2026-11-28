import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { createEnvironmentPresentationPolicy } from "~/connection/environmentPresentationPolicy";

const h = vi.hoisted(() => ({
  policy: null as ReturnType<
    typeof import("~/connection/environmentPresentationPolicy").createEnvironmentPresentationPolicy
  > | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useCanGoBack: () => false,
}));

vi.mock("~/connection/currentEnvironmentPresentation", () => ({
  readCurrentEnvironmentPresentationPolicy: () => h.policy,
}));

vi.mock("../ui/sidebar", () => ({
  SidebarHeader: (props: { children?: ReactNode; className?: string }) => (
    <header data-slot="sidebar-header" className={props.className}>
      {props.children}
    </header>
  ),
  SidebarContent: (props: { children?: ReactNode; className?: string }) => (
    <div data-slot="sidebar-content" className={props.className}>
      {props.children}
    </div>
  ),
  SidebarFooter: (props: { children?: ReactNode; className?: string }) => (
    <footer data-slot="sidebar-footer" className={props.className}>
      {props.children}
    </footer>
  ),
  SidebarGroup: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SidebarMenu: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SidebarMenuButton: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  SidebarMenuItem: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SidebarSeparator: () => <hr />,
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));

vi.mock("../clerk/BiBCodeConnectSidebarSignIn", () => ({
  BiBCodeConnectSidebarSignIn: () => <span>BiBCode Connect sign in</span>,
  BiBCodeConnectSidebarAvatar: () => <span>BiBCode Connect avatar</span>,
}));

import {
  BASE_SETTINGS_NAV_ITEMS,
  SettingsSidebarNav,
  settingsNavItemsFor,
} from "./SettingsSidebarNav";

describe("settings navigation", () => {
  it("lists the settings sections in the approved order", () => {
    expect(BASE_SETTINGS_NAV_ITEMS.map(({ label, to }) => [label, to])).toEqual([
      ["General", "/settings/general"],
      ["Appearance", "/settings/appearance"],
      ["Remote Servers", "/settings/remote-servers"],
      ["Agents", "/settings/agents"],
      ["Status Bar", "/settings/status-bar"],
      ["Terminal", "/settings/terminal"],
      ["Keybindings", "/settings/keybindings"],
      ["Providers", "/settings/providers"],
      ["Source Control", "/settings/source-control"],
      ["Mobile emulators", "/settings/mobile"],
      ["Archive", "/settings/archived"],
      ["Diagnostics", "/settings/diagnostics"],
      ["About", "/settings/about"],
    ]);
  });

  it("Appearance is listed after General", () => {
    const labels = BASE_SETTINGS_NAV_ITEMS.map(({ label }) => label);
    expect(labels.indexOf("Appearance")).toBe(labels.indexOf("General") + 1);
  });

  it("adds Local environment only for Windows desktop", () => {
    const windowsPolicy = createEnvironmentPresentationPolicy({
      surface: "desktop",
      platform: "windows",
    });
    const macPolicy = createEnvironmentPresentationPolicy({
      surface: "desktop",
      platform: "macos",
    });
    const browserPolicy = createEnvironmentPresentationPolicy({
      surface: "browser",
      platform: "unknown",
    });

    expect(settingsNavItemsFor(windowsPolicy).map((item) => item.label)).toContain(
      "Local environment",
    );
    expect(
      settingsNavItemsFor(windowsPolicy)
        .map(({ label, to }) => [label, to])
        .slice(0, 4),
    ).toEqual([
      ["General", "/settings/general"],
      ["Appearance", "/settings/appearance"],
      ["Remote Servers", "/settings/remote-servers"],
      ["Local environment", "/settings/local-environment"],
    ]);
    expect(settingsNavItemsFor(macPolicy).map((item) => item.label)).not.toContain(
      "Local environment",
    );
    expect(settingsNavItemsFor(browserPolicy).map((item) => item.label)).not.toContain(
      "Local environment",
    );
  });

  it("pins Back in SidebarHeader above SidebarContent and preserves browser-only Connect footer", () => {
    h.policy = createEnvironmentPresentationPolicy({ surface: "desktop", platform: "windows" });
    const desktopMarkup = renderToStaticMarkup(<SettingsSidebarNav pathname="/settings/general" />);
    const desktopHeaderMatch = desktopMarkup.match(
      /<header data-slot="sidebar-header"[^>]*>([\s\S]*?)<\/header>/,
    );
    expect(desktopHeaderMatch?.[1]).toContain("Back");
    expect(desktopMarkup.indexOf('data-slot="sidebar-header"')).toBeLessThan(
      desktopMarkup.indexOf('data-slot="sidebar-content"'),
    );
    expect(desktopMarkup.indexOf("Back")).toBeLessThan(desktopMarkup.indexOf("General"));
    expect(desktopMarkup).not.toContain('data-slot="sidebar-footer"');
    expect(desktopMarkup).not.toContain("BiBCode Connect sign in");
    expect(desktopMarkup).not.toContain("BiBCode Connect avatar");

    h.policy = createEnvironmentPresentationPolicy({ surface: "browser", platform: "unknown" });
    const browserMarkup = renderToStaticMarkup(<SettingsSidebarNav pathname="/settings/general" />);
    const browserHeaderMatch = browserMarkup.match(
      /<header data-slot="sidebar-header"[^>]*>([\s\S]*?)<\/header>/,
    );
    const browserFooterMatch = browserMarkup.match(
      /<footer data-slot="sidebar-footer"[^>]*>([\s\S]*?)<\/footer>/,
    );
    expect(browserHeaderMatch?.[1]).toContain("Back");
    expect(browserHeaderMatch?.[1]).not.toContain("BiBCode Connect sign in");
    expect(browserFooterMatch?.[1]).toContain("BiBCode Connect sign in");
    expect(browserFooterMatch?.[1]).toContain("BiBCode Connect avatar");
    expect(browserFooterMatch?.[1]).not.toContain("Back");
    expect(browserMarkup.indexOf('data-slot="sidebar-content"')).toBeLessThan(
      browserMarkup.indexOf('data-slot="sidebar-footer"'),
    );
  });
});
