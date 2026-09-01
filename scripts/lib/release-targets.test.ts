import { describe, expect, it } from "vite-plus/test";

import { RELEASE_TARGETS, TAURI_UPDATE_TARGETS, requireReleaseTarget } from "./release-targets.ts";

describe("native release targets", () => {
  it("defines the exact six-target public contract", () => {
    expect(
      RELEASE_TARGETS.map(({ platform, arch, runner, rustTarget, updaterTarget }) => ({
        platform,
        arch,
        runner,
        rustTarget,
        updaterTarget,
      })),
    ).toEqual([
      {
        platform: "mac",
        arch: "arm64",
        runner: "macos-26",
        rustTarget: "aarch64-apple-darwin",
        updaterTarget: "darwin-aarch64",
      },
      {
        platform: "mac",
        arch: "x64",
        runner: "macos-26-intel",
        rustTarget: "x86_64-apple-darwin",
        updaterTarget: "darwin-x86_64",
      },
      {
        platform: "linux",
        arch: "arm64",
        runner: "ubuntu-22.04-arm",
        rustTarget: "aarch64-unknown-linux-gnu",
        updaterTarget: "linux-aarch64",
      },
      {
        platform: "linux",
        arch: "x64",
        runner: "ubuntu-22.04",
        rustTarget: "x86_64-unknown-linux-gnu",
        updaterTarget: "linux-x86_64",
      },
      {
        platform: "win",
        arch: "arm64",
        runner: "windows-11-vs2026-arm",
        rustTarget: "aarch64-pc-windows-msvc",
        updaterTarget: "windows-aarch64",
      },
      {
        platform: "win",
        arch: "x64",
        runner: "windows-2025",
        rustTarget: "x86_64-pc-windows-msvc",
        updaterTarget: "windows-x86_64",
      },
    ]);
    expect(TAURI_UPDATE_TARGETS).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]);
    expect(requireReleaseTarget("linux", "arm64").debArch).toBe("arm64");
    expect(requireReleaseTarget("win", "arm64").serverArchive).toBe("zip");
  });

  it("rejects an unknown platform and architecture pair", () => {
    expect(() => requireReleaseTarget("linux", "universal" as "x64")).toThrow(
      "Unsupported release target linux/universal",
    );
  });
});
