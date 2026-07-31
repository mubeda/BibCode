import { describe, expect, it } from "vite-plus/test";

import { DesktopAppPathConfigurationError, resolveDesktopAppPath } from "./app-path.ts";

describe("resolveDesktopAppPath", () => {
  it("resolves the executable inside a macOS app mounted from a DMG", () => {
    expect(
      resolveDesktopAppPath({
        platform: "mac",
        environment: {
          BIBCODE_E2E_APP_PATH: "/Volumes/BiBCode/BiBCode.app",
        },
      }),
    ).toBe("/Volumes/BiBCode/BiBCode.app/Contents/MacOS/bibcode-desktop");
  });

  it("accepts a direct macOS application executable", () => {
    const executable = "/private/tmp/BiBCode.app/Contents/MacOS/BiBCode";

    expect(
      resolveDesktopAppPath({
        platform: "mac",
        environment: { BIBCODE_E2E_APP_PATH: executable },
      }),
    ).toBe(executable);
  });

  it("resolves a Linux AppImage without changing paths that contain spaces", () => {
    const appImage = "/tmp/BiBCode UI Smoke/BiBCode_0.2.2_amd64.AppImage";

    expect(
      resolveDesktopAppPath({
        platform: "linux",
        environment: { BIBCODE_E2E_APP_PATH: appImage },
      }),
    ).toBe(appImage);
  });

  it("resolves an NSIS-installed Windows executable with win32 path rules", () => {
    const executable = String.raw`C:\Program Files\BiBCode\BiBCode.exe`;

    expect(
      resolveDesktopAppPath({
        platform: "win",
        environment: { BIBCODE_E2E_APP_PATH: executable },
      }),
    ).toBe(executable);
  });

  it("rejects a missing BIBCODE_E2E_APP_PATH", () => {
    expect(() =>
      resolveDesktopAppPath({
        platform: "linux",
        environment: {},
      }),
    ).toThrowError(DesktopAppPathConfigurationError);
  });

  it("rejects installer paths that are not directly launchable", () => {
    expect(() =>
      resolveDesktopAppPath({
        platform: "mac",
        environment: { BIBCODE_E2E_APP_PATH: "/tmp/BiBCode.dmg" },
      }),
    ).toThrowError(/mount the DMG/i);

    expect(() =>
      resolveDesktopAppPath({
        platform: "win",
        environment: { BIBCODE_E2E_APP_PATH: String.raw`C:\tmp\BiBCode-setup.msi` },
      }),
    ).toThrowError(/installed executable/i);
  });
});
