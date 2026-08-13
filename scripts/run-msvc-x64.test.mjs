import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canonicalizeMacosCargoTestTarget,
  defaultWindowsCargoRunner,
  discoverVcVarsAll,
  quoteCmdArg,
  run,
  runMsvcX64,
} from "./run-msvc-x64.mjs";

describe("run-msvc-x64", () => {
  it("quotes only command arguments that require cmd escaping", () => {
    expect(quoteCmdArg("safe/path:value-1")).toBe("safe/path:value-1");
    expect(quoteCmdArg('two words "quoted"')).toBe('"two words \\"quoted\\""');
  });

  it("builds a quoted Cargo target runner command", () => {
    expect(
      defaultWindowsCargoRunner({
        command: "custom-node",
        repoRoot: "C:/repo root",
      }),
    ).toBe('custom-node "C:\\repo root\\scripts\\run-windows-cargo-target.mjs"');
  });

  it("normalizes missing child statuses", () => {
    expect(run("tool", [], {}, () => ({ status: 7 }))).toBe(7);
    expect(run("tool", [], {}, () => ({ status: null }))).toBe(1);
  });

  it("discovers vcvarsall through vswhere or the Build Tools fallback", () => {
    expect(discoverVcVarsAll({ programFilesX86: "" })).toBeNull();

    const root = "C:/Program Files (x86)";
    const vswhere = NodePath.join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const install = "C:/Visual Studio";
    const candidate = NodePath.join(install, "VC", "Auxiliary", "Build", "vcvarsall.bat");
    expect(
      discoverVcVarsAll({
        programFilesX86: root,
        existsSync: (path) => path === vswhere || path === candidate,
        spawnSync: () => ({ stdout: `\r\n${install}\r\n` }),
      }),
    ).toBe(candidate);

    const fallback = NodePath.join(
      root,
      "Microsoft Visual Studio",
      "2022",
      "BuildTools",
      "VC",
      "Auxiliary",
      "Build",
      "vcvarsall.bat",
    );
    expect(
      discoverVcVarsAll({
        programFilesX86: root,
        existsSync: (path) => path === fallback,
      }),
    ).toBe(fallback);
    expect(discoverVcVarsAll({ programFilesX86: root, existsSync: () => false })).toBeNull();
    expect(
      discoverVcVarsAll({
        programFilesX86: root,
        existsSync: (path) => path === vswhere,
        spawnSync: () => ({ stdout: "\n" }),
      }),
    ).toBeNull();
    expect(
      discoverVcVarsAll({
        programFilesX86: root,
        existsSync: (path) => path === vswhere,
        spawnSync: () => ({ stdout: `${install}\n` }),
      }),
    ).toBeNull();
  });

  it("runs directly without Visual Studio and reports missing commands", () => {
    const consoleError = vi.fn();
    expect(runMsvcX64([], { consoleError })).toBe(2);
    expect(consoleError).toHaveBeenCalledOnce();

    const spawnSync = vi.fn(() => ({ status: 4 }));
    expect(
      runMsvcX64(["cargo", "test"], {
        programFilesX86: "C:/missing",
        existsSync: () => false,
        spawnSync,
      }),
    ).toBe(4);
    expect(spawnSync).toHaveBeenCalledWith(
      "cargo",
      ["test"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("canonicalizes an explicit macOS Cargo test target before launch", () => {
    const mkdirSync = vi.fn();
    const realpathSync = vi.fn(() => "/private/tmp/bibcode-task9f-target");
    const spawnSync = vi.fn(() => ({ status: 0 }));

    expect(
      runMsvcX64(["cargo", "test", "-p", "bibcode-desktop"], {
        platform: "darwin",
        env: { CARGO_TARGET_DIR: "/tmp/bibcode-task9f-target" },
        programFilesX86: "",
        mkdirSync,
        realpathSync,
        spawnSync,
      }),
    ).toBe(0);

    expect(mkdirSync).toHaveBeenCalledWith("/tmp/bibcode-task9f-target", {
      recursive: true,
    });
    expect(realpathSync).toHaveBeenCalledWith("/tmp/bibcode-task9f-target");
    expect(spawnSync).toHaveBeenCalledWith(
      "cargo",
      ["test", "-p", "bibcode-desktop"],
      expect.objectContaining({
        env: expect.objectContaining({
          CARGO_TARGET_DIR: "/private/tmp/bibcode-task9f-target",
        }),
      }),
    );
  });

  it("leaves unrelated platforms and commands outside target canonicalization", () => {
    const mkdirSync = vi.fn();
    const realpathSync = vi.fn();
    const configured = { CARGO_TARGET_DIR: "relative-target", SENTINEL: "kept" };
    const options = { cwd: "/repo", mkdirSync, realpathSync };

    expect(
      canonicalizeMacosCargoTestTarget(["cargo", "test"], configured, {
        ...options,
        platform: "linux",
      }),
    ).toBe(configured);
    expect(
      canonicalizeMacosCargoTestTarget(["cargo", "test"], configured, {
        ...options,
        platform: "win32",
      }),
    ).toBe(configured);
    expect(
      canonicalizeMacosCargoTestTarget(["cargo", "check"], configured, {
        ...options,
        platform: "darwin",
      }),
    ).toBe(configured);
    expect(
      canonicalizeMacosCargoTestTarget(["vp", "test"], configured, {
        ...options,
        platform: "darwin",
      }),
    ).toBe(configured);
    expect(
      canonicalizeMacosCargoTestTarget(["cargo", "test"], { SENTINEL: "kept" }, {
        ...options,
        platform: "darwin",
      }),
    ).toEqual({ SENTINEL: "kept" });
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(realpathSync).not.toHaveBeenCalled();
  });

  it("resolves relative macOS Cargo test targets against the launch directory", () => {
    const mkdirSync = vi.fn();
    const realpathSync = vi.fn(() => "/canonical/repo/isolated-target");
    const configured = { CARGO_TARGET_DIR: "isolated-target", SENTINEL: "kept" };

    const canonical = canonicalizeMacosCargoTestTarget(["cargo", "test"], configured, {
      platform: "darwin",
      cwd: "/repo",
      mkdirSync,
      realpathSync,
    });

    expect(mkdirSync).toHaveBeenCalledWith("/repo/isolated-target", { recursive: true });
    expect(realpathSync).toHaveBeenCalledWith("/repo/isolated-target");
    expect(canonical).toEqual({
      CARGO_TARGET_DIR: "/canonical/repo/isolated-target",
      SENTINEL: "kept",
    });
    expect(configured.CARGO_TARGET_DIR).toBe("isolated-target");
  });

  it("writes, runs, and removes an MSVC wrapper even when cleanup fails", () => {
    const writeFileSync = vi.fn();
    const rmSync = vi.fn(() => {
      throw new Error("already removed");
    });
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ stdout: "C:/Visual Studio\n" })
      .mockReturnValueOnce({ status: 0 });

    expect(
      runMsvcX64(["cargo", "test name"], {
        programFilesX86: "C:/Program Files (x86)",
        existsSync: () => true,
        spawnSync,
        comspec: "custom-cmd.exe",
        tmpdir: "C:/tmp",
        pid: 12,
        now: () => 34,
        writeFileSync,
        rmSync,
      }),
    ).toBe(0);
    expect(writeFileSync).toHaveBeenCalledWith(
      NodePath.join("C:/tmp", "bibcode-msvc-x64-12-34.cmd"),
      expect.stringContaining('cargo "test name"'),
    );
    expect(spawnSync).toHaveBeenLastCalledWith(
      "custom-cmd.exe",
      ["/d", "/c", NodePath.join("C:/tmp", "bibcode-msvc-x64-12-34.cmd")],
      expect.objectContaining({
        env: expect.objectContaining({
          CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER: expect.stringContaining(
            "run-windows-cargo-target.mjs",
          ),
        }),
      }),
    );
    expect(rmSync).toHaveBeenCalledOnce();
  });

  it("uses platform defaults for wrapper paths and filesystem cleanup", () => {
    const originalComspec = process.env.ComSpec;
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ stdout: "C:/Visual Studio\n" })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ stdout: "C:/Visual Studio\n" })
      .mockReturnValueOnce({ status: 0 });
    try {
      process.env.ComSpec = "true";
      expect(
        runMsvcX64(["cargo", "test"], {
          programFilesX86: "C:/Program Files (x86)",
          existsSync: () => true,
          spawnSync,
        }),
      ).toBe(0);

      delete process.env.ComSpec;
      expect(
        runMsvcX64(["cargo", "test"], {
          programFilesX86: "C:/Program Files (x86)",
          existsSync: () => true,
          spawnSync,
        }),
      ).toBe(0);
    } finally {
      if (originalComspec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComspec;
      }
    }
  });
});
