import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readCurrentEnvironmentPresentationPolicy } from "./currentEnvironmentPresentation";

vi.mock("../env", () => ({
  isDesktopHost: true,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("current environment presentation", () => {
  it("reads the desktop host surface and Windows navigator platform", () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Vitest" });

    expect(readCurrentEnvironmentPresentationPolicy()).toMatchObject({
      surface: "desktop",
      platform: "windows",
      showLocalEnvironmentSettings: true,
      showRemoteDeviceControls: false,
    });
  });
});
