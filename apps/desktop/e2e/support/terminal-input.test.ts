import { afterEach, expect, it, vi } from "vite-plus/test";

import { openCenterTerminal } from "./terminal-input.ts";

afterEach(() => vi.unstubAllGlobals());

it("waits for a ready workspace trigger before opening its terminal menu", async () => {
  const clicks: string[] = [];
  const trigger = {
    isDisplayed: async () => true,
    isEnabled: async () => true,
    click: async () => {
      clicks.push("trigger");
    },
  };
  let queries = 0;
  const menu = {
    waitForDisplayed: async () => {
      expect(clicks).toEqual(["trigger"]);
    },
    waitForEnabled: async () => undefined,
    click: async () => {
      clicks.push("terminal");
    },
  };
  vi.stubGlobal("browser", {
    $$: async () => (++queries === 1 ? [] : [trigger]),
    $: () => menu,
    waitUntil: async (predicate: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 3; attempt++) if (await predicate()) return;
      throw new Error("Workspace never became ready.");
    },
  });
  await openCenterTerminal();
  expect(queries).toBe(2);
  expect(clicks).toEqual(["trigger", "terminal"]);
});
