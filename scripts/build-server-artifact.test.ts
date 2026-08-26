// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  ServerArtifactBuildError,
  buildServerArtifact,
  collectWebAssetManifest,
  parseCargoServerExecutable,
  parseServerArtifactCliArgs,
  resolveServerArtifactBuildPlan,
  runBoundedCommand,
  verifyWebAssetManifest,
  type ServerArtifactCommandRunner,
} from "./build-server-artifact.ts";

const repoRoot = NodePath.resolve("/repo");

describe("server artifact build planning", () => {
  it.each([
    ["x86_64-pc-windows-msvc", "win32", "x64", "zip"],
    ["aarch64-pc-windows-msvc", "win32", "arm64", "zip"],
    ["x86_64-apple-darwin", "darwin", "x64", "tar.gz"],
    ["aarch64-apple-darwin", "darwin", "arm64", "tar.gz"],
    ["x86_64-unknown-linux-gnu", "linux", "x64", "tar.gz"],
    ["aarch64-unknown-linux-gnu", "linux", "arm64", "tar.gz"],
  ] as const)("maps %s only to its native host", (target, platform, arch, format) => {
    const plan = resolveServerArtifactBuildPlan(
      { target, formats: ["portable"], outputDir: "release/server" },
      { platform, arch },
      repoRoot,
    );

    expect(plan.target).toBe(target);
    expect(plan.portableFormat).toBe(format);
    expect(plan.outputDir).toBe(NodePath.join(repoRoot, "release/server"));
    expect(plan.cargoArgs).toContain("--locked");
    expect(plan.cargoArgs).toContain("--message-format=json-render-diagnostics");
  });

  it("rejects unknown targets, formats, and host-target mismatches", () => {
    expect(() =>
      resolveServerArtifactBuildPlan(
        { target: "wasm32-unknown-unknown", formats: ["portable"] },
        { platform: "linux", arch: "x64" },
        repoRoot,
      ),
    ).toThrow(ServerArtifactBuildError);
    expect(() =>
      resolveServerArtifactBuildPlan(
        { target: "x86_64-unknown-linux-gnu", formats: ["portable", "magic"] },
        { platform: "linux", arch: "x64" },
        repoRoot,
      ),
    ).toThrow(/format/iu);
    expect(() =>
      resolveServerArtifactBuildPlan(
        { target: "aarch64-unknown-linux-gnu", formats: ["portable"] },
        { platform: "linux", arch: "x64" },
        repoRoot,
      ),
    ).toThrow(/native/iu);
  });

  it("parses only the bounded CLI surface", () => {
    expect(
      parseServerArtifactCliArgs([
        "--target",
        "aarch64-apple-darwin",
        "--formats",
        "portable",
        "--output-dir",
        "release/server-local",
        "--unsigned-test",
        "--timeout-ms",
        "60000",
      ]),
    ).toEqual({
      target: "aarch64-apple-darwin",
      formats: ["portable"],
      outputDir: "release/server-local",
      unsignedTest: true,
      timeoutMs: 60_000,
    });
    expect(() => parseServerArtifactCliArgs(["--formats", "portable"])).toThrow(/target/iu);
    expect(() =>
      parseServerArtifactCliArgs(["--target", "x86_64-unknown-linux-gnu", "--timeout-ms", "0"]),
    ).toThrow(/positive/iu);
  });
});

describe("Cargo executable discovery", () => {
  const plan = resolveServerArtifactBuildPlan(
    { target: "x86_64-unknown-linux-gnu", formats: ["portable"] },
    { platform: "linux", arch: "x64" },
    repoRoot,
  );
  const executable = NodePath.join(repoRoot, "target/x86_64-unknown-linux-gnu/release/bibcode");
  const artifact = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      reason: "compiler-artifact",
      target: { name: "bibcode", kind: ["bin"], crate_types: ["bin"] },
      profile: { test: false },
      executable,
      ...overrides,
    });

  it("uses Cargo's exact compiler-artifact executable", () => {
    expect(parseCargoServerExecutable(`noise\n${artifact()}\n`, plan)).toBe(executable);
  });

  it("rejects the wrong executable kind, missing path, duplicate, and target escape", () => {
    expect(() =>
      parseCargoServerExecutable(
        artifact({ target: { name: "bibcode", kind: ["example"], crate_types: ["bin"] } }),
        plan,
      ),
    ).toThrow(/exactly one/iu);
    expect(() => parseCargoServerExecutable(artifact({ executable: null }), plan)).toThrow(
      /executable/iu,
    );
    expect(() => parseCargoServerExecutable(`${artifact()}\n${artifact()}\n`, plan)).toThrow(
      /duplicate/iu,
    );
    expect(() =>
      parseCargoServerExecutable(artifact({ executable: "/tmp/escaped-bibcode" }), plan),
    ).toThrow(/target directory/iu);
  });
});

describe("immutable web asset input", () => {
  it("sorts and hashes an exact portable inventory", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-web-assets-"));
    NodeFS.mkdirSync(NodePath.join(root, "assets"));
    NodeFS.writeFileSync(NodePath.join(root, "index.html"), "index");
    NodeFS.writeFileSync(NodePath.join(root, "assets/app.js"), "app");

    const manifest = await collectWebAssetManifest(root);

    expect(manifest.files.map((file) => file.path)).toEqual(["assets/app.js", "index.html"]);
    await expect(verifyWebAssetManifest(root, manifest)).resolves.toBeUndefined();
    NodeFS.writeFileSync(NodePath.join(root, "assets/app.js"), "stale");
    await expect(verifyWebAssetManifest(root, manifest)).rejects.toThrow(/integrity/iu);
  });

  it("rejects links, source maps, secrets, logs, databases, and Node payloads", async () => {
    for (const relative of [
      "assets/app.js.map",
      "assets/tauriDesktopBridge-deadbeef.js",
      ".env",
      "debug.log",
      "state.sqlite",
      "node_modules/node",
    ]) {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-web-policy-"));
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, relative)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, relative), "forbidden");
      await expect(collectWebAssetManifest(root)).rejects.toThrow(/forbidden/iu);
    }

    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-web-link-"));
    NodeFS.writeFileSync(NodePath.join(root, "index.html"), "index");
    try {
      NodeFS.symlinkSync(NodePath.join(root, "index.html"), NodePath.join(root, "linked.html"));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      throw error;
    }
    await expect(collectWebAssetManifest(root)).rejects.toThrow(/symbolic link/iu);

    const tauriRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-web-tauri-"));
    NodeFS.mkdirSync(NodePath.join(tauriRoot, "assets"));
    NodeFS.writeFileSync(
      NodePath.join(tauriRoot, "assets/core.js"),
      "globalThis.__TAURI_INTERNALS__",
    );
    await expect(collectWebAssetManifest(tauriRoot)).rejects.toThrow(/Tauri/iu);
  });
});

describe("bounded build lifecycle", () => {
  it("passes an abort signal and timeout to the command runner", async () => {
    const controller = new AbortController();
    const execFile = vi.fn(
      async (_command: string, _args: ReadonlyArray<string>, options: object) => ({
        stdout: JSON.stringify(options),
        stderr: "",
      }),
    );

    await runBoundedCommand(
      { command: "cargo", args: ["build"], cwd: repoRoot },
      { signal: controller.signal, timeoutMs: 1234 },
      execFile,
    );

    expect(execFile).toHaveBeenCalledWith(
      "cargo",
      ["build"],
      expect.objectContaining({ signal: controller.signal, timeout: 1234, shell: false }),
    );
  });

  it("classifies child timeout and cancellation", async () => {
    const timeoutError = Object.assign(new Error("child terminated"), {
      killed: true,
      signal: "SIGTERM",
    });
    await expect(
      runBoundedCommand(
        {
          command: "test-command",
          args: [],
          cwd: repoRoot,
        },
        { timeoutMs: 25 },
        async () => Promise.reject(timeoutError),
      ),
    ).rejects.toThrow(/timed out/iu);

    const controller = new AbortController();
    const cancelled = new ServerArtifactBuildError("cancelled by test");
    const abortingExecFile = vi.fn(
      async (
        _command: string,
        _args: ReadonlyArray<string>,
        options: { readonly signal?: AbortSignal },
      ): Promise<{ stdout: string; stderr: string }> =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })),
            { once: true },
          );
        }),
    );
    const cancellation = runBoundedCommand(
      {
        command: "test-command",
        args: [],
        cwd: repoRoot,
      },
      { signal: controller.signal, timeoutMs: 5_000 },
      abortingExecFile,
    );
    controller.abort(cancelled);
    await expect(cancellation).rejects.toBe(cancelled);
  });

  it("reports a missing frozen input as an artifact build error before spawning", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-input-build-"));
    const runner = vi.fn<ServerArtifactCommandRunner>();

    await expect(
      buildServerArtifact(
        {
          target: "x86_64-unknown-linux-gnu",
          formats: ["portable"],
          outputDir: NodePath.join(root, "output"),
          unsignedTest: true,
        },
        {
          repoRoot: root,
          host: { platform: "linux", arch: "x64" },
          commandRunner: runner,
        },
      ),
    ).rejects.toThrow(/required frozen build input/iu);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects dirty output before spawning and cleans staging after a failed command", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-server-build-"));
    const fixtureRepo = NodePath.join(root, "repo");
    for (const [relative, contents] of [
      ["Cargo.lock", "lock"],
      ["pnpm-lock.yaml", "lock"],
      ["LICENSE", "license"],
      ["apps/server/package.json", '{"version":"0.4.1"}'],
      ["apps/server/Cargo.toml", '[package]\nname="bibcode-server"\n'],
      ["packaging/server/common/install-layout.json", '{"packageVersion":"0.4.1"}'],
    ] as const) {
      const path = NodePath.join(fixtureRepo, relative);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, contents);
    }
    const outputDir = NodePath.join(root, "output");
    NodeFS.mkdirSync(outputDir);
    NodeFS.writeFileSync(NodePath.join(outputDir, "keep"), "user");
    const runner = vi.fn<ServerArtifactCommandRunner>();
    await expect(
      buildServerArtifact(
        {
          target: "x86_64-unknown-linux-gnu",
          formats: ["portable"],
          outputDir,
          unsignedTest: true,
        },
        {
          repoRoot: fixtureRepo,
          host: { platform: "linux", arch: "x64" },
          commandRunner: runner,
        },
      ),
    ).rejects.toThrow(/already exists/iu);
    expect(runner).not.toHaveBeenCalled();
    expect(NodeFS.readFileSync(NodePath.join(outputDir, "keep"), "utf8")).toBe("user");

    NodeFS.rmSync(outputDir, { recursive: true });
    const failingRunner = vi.fn<ServerArtifactCommandRunner>(async () => {
      throw new Error("injected child failure");
    });
    await expect(
      buildServerArtifact(
        {
          target: "x86_64-unknown-linux-gnu",
          formats: ["portable"],
          outputDir,
          unsignedTest: true,
        },
        {
          repoRoot: fixtureRepo,
          host: { platform: "linux", arch: "x64" },
          commandRunner: failingRunner,
        },
      ),
    ).rejects.toThrow("injected child failure");
    expect(NodeFS.existsSync(outputDir)).toBe(false);
    expect(NodeFS.readdirSync(root)).toEqual(["repo"]);
  });
});
