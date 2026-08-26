import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../env", () => ({
  isDesktopHost: true,
}));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("current environment presentation", () => {
  it("reads the desktop host surface and Windows navigator platform", async () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Vitest" });

    const { readCurrentEnvironmentPresentationPolicy } =
      await import("./currentEnvironmentPresentation");

    expect(readCurrentEnvironmentPresentationPolicy()).toMatchObject({
      surface: "desktop",
      platform: "windows",
      connectionsPresentation: "full",
      showRemoteDeviceControls: true,
    });
  });
});
