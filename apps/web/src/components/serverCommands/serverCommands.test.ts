import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentPresentation } from "~/state/environments";

import {
  serverCommandAccessibleName,
  serverCommandMenuItems,
  serverCommandTarget,
} from "./serverCommands";

function environment(tag: string, phase: string): EnvironmentPresentation {
  return {
    label: "Example host",
    entry: { target: { _tag: tag } },
    connection: { phase },
  } as unknown as EnvironmentPresentation;
}

describe("server commands", () => {
  it("names this device Local and a saved server by its label", () => {
    expect(serverCommandTarget(environment("PrimaryConnectionTarget", "connected"))).toEqual({
      label: "Local",
      connected: true,
    });
    expect(serverCommandTarget(environment("BearerConnectionTarget", "reconnecting"))).toEqual({
      label: "Example host",
      connected: false,
    });
  });

  it("names each command with its server", () => {
    expect(serverCommandAccessibleName("terminal", "Server A")).toBe("Open terminal on Server A");
    expect(serverCommandAccessibleName("dashboard", "Server A")).toBe("Dashboard for Server A");
  });

  it("lists Open terminal then Dashboard, both disabled with a reason while offline", () => {
    expect(serverCommandMenuItems({ label: "Server A", connected: true })).toEqual([
      { id: "terminal", label: "Open terminal" },
      { id: "dashboard", label: "Dashboard" },
    ]);
    expect(
      serverCommandMenuItems({ label: "Server A", connected: false }).map((item) => [
        item.disabled,
        item.description,
      ]),
    ).toEqual([
      [true, "Server A is not connected."],
      [true, "Server A is not connected."],
    ]);
  });
});
