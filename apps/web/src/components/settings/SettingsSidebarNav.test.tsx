import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useCanGoBack: () => false,
}));

vi.mock("../ui/sidebar", () => ({
  SidebarContent: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SidebarFooter: (props: { children?: ReactNode }) => <footer>{props.children}</footer>,
  SidebarGroup: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SidebarMenu: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SidebarMenuButton: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  SidebarMenuItem: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SidebarSeparator: () => <hr />,
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));

import { BASE_SETTINGS_NAV_ITEMS, SettingsSidebarNav } from "./SettingsSidebarNav";

describe("settings navigation", () => {
  it("lists the settings sections in the approved order", () => {
    expect(BASE_SETTINGS_NAV_ITEMS.map(({ label, to }) => [label, to])).toEqual([
      ["General", "/settings/general"],
      ["Environments", "/settings/environments"],
      ["Agents", "/settings/agents"],
      ["Status Bar", "/settings/status-bar"],
      ["Terminal", "/settings/terminal"],
      ["Keybindings", "/settings/keybindings"],
      ["Providers", "/settings/providers"],
      ["Source Control", "/settings/source-control"],
      ["Archive", "/settings/archived"],
      ["About", "/settings/about"],
    ]);
  });

  it("renders one Environments destination and no Connect footer controls", () => {
    const markup = renderToStaticMarkup(<SettingsSidebarNav pathname="/settings/environments" />);
    expect(markup.match(/Environments/gu)).toHaveLength(1);
    expect(markup).not.toContain("BiBCode Connect");
  });
});
