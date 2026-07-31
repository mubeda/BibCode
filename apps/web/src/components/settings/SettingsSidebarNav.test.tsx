import { describe, expect, it } from "@effect/vitest";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";

describe("SETTINGS_NAV_ITEMS", () => {
  it("lists the settings sections in the approved order", () => {
    expect(SETTINGS_NAV_ITEMS.map(({ label, to }) => [label, to])).toEqual([
      ["General", "/settings/general"],
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
});
