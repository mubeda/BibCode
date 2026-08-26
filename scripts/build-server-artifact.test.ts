// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  ServerArtifactBuildError,
  buildServerArtifact,
  collectWebAssetManifest,
  parseCargoServerExecutable,
  parsePinnedRustToolchainChannel,
  parseServerArtifactCliArgs,
  resolveMacDeveloperIdConfiguration,
  resolveServerArtifactBuildPlan,
  resolveWindowsAuthenticodeConfiguration,
  runBoundedCommand,
  signAndVerifyMacExecutable,
  signAndVerifyWindowsArtifact,
  verifyWebAssetManifest,
  type ServerArtifactCommandRunner,
} from "./build-server-artifact.ts";

const repoRoot = NodePath.resolve("/repo");
const sourceRepoRoot = NodePath.resolve(import.meta.dirname, "..");

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

  it("accepts only an exact checked-in Rust toolchain channel", () => {
    expect(parsePinnedRustToolchainChannel('[toolchain]\nchannel = "1.97.1"\n')).toBe("1.97.1");
    expect(() => parsePinnedRustToolchainChannel('[toolchain]\nchannel = "stable"\n')).toThrow(
      /exact stable Rust channel/iu,
    );
  });
});

describe("native server signing policy", () => {
  const certificate = {
    subject: "CN=BiBCode Server Release",
    thumbprint: "a".repeat(40),
    timestampUrl: "https://timestamp.example.test/",
  } as const;
  const windowsEnvironment = {
    WINDOWS_SIGNING_CERTIFICATE_SUBJECT: certificate.subject,
    WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT: certificate.thumbprint.toUpperCase(),
    WINDOWS_SIGNING_TIMESTAMP_URL: certificate.timestampUrl,
  };

  it("requires exact Windows signer identity and an HTTPS RFC 3161 endpoint", () => {
    expect(resolveWindowsAuthenticodeConfiguration(windowsEnvironment)).toEqual({
      signerSubject: certificate.subject,
      signerThumbprint: certificate.thumbprint,
      timestampUrl: certificate.timestampUrl,
    });
    expect(() =>
      resolveWindowsAuthenticodeConfiguration({
        ...windowsEnvironment,
        WINDOWS_SIGNING_TIMESTAMP_URL: "http://timestamp.example.test",
      }),
    ).toThrow(/HTTPS/iu);
    expect(() => resolveWindowsAuthenticodeConfiguration({})).toThrow(/certificate subject/iu);
  });

  it("keeps no-credential macOS ad-hoc mode distinct from complete Developer ID mode", () => {
    expect(resolveMacDeveloperIdConfiguration({})).toBeNull();
    expect(
      resolveMacDeveloperIdConfiguration({
        BIBCODE_SERVER_MACOS_APPLICATION_IDENTITY: "Developer ID Application: BiBCode (ABCDE12345)",
        BIBCODE_SERVER_MACOS_INSTALLER_IDENTITY: "Developer ID Installer: BiBCode (ABCDE12345)",
        APPLE_TEAM_ID: "ABCDE12345",
        BIBCODE_SERVER_MACOS_NOTARY_PROFILE: "bibcode-server-notary",
      }),
    ).toMatchObject({ teamId: "ABCDE12345", notaryProfile: "bibcode-server-notary" });
    expect(() =>
      resolveMacDeveloperIdConfiguration({
        BIBCODE_SERVER_MACOS_APPLICATION_IDENTITY: "Developer ID Application: BiBCode (ABCDE12345)",
      }),
    ).toThrow(/matching Developer ID/iu);
  });

  it("records ad-hoc and Developer ID executable verification separately", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-macos-signing-"));
    const executable = NodePath.join(root, "bibcode");
    NodeFS.writeFileSync(executable, "binary", { mode: 0o755 });
    const commands: string[] = [];
    const commandRunner: ServerArtifactCommandRunner = async ({ command, args }) => {
      commands.push(`${command}:${args[0]}`);
      return { stdout: "", stderr: "" };
    };
    await expect(
      signAndVerifyMacExecutable({
        path: executable,
        cwd: root,
        configuration: null,
        commandRunner,
        limits: { timeoutMs: 5_000 },
      }),
    ).resolves.toMatchObject({ binary: "adhoc", package: "none", verified: false });
    const configuration = resolveMacDeveloperIdConfiguration({
      BIBCODE_SERVER_MACOS_APPLICATION_IDENTITY: "Developer ID Application: BiBCode (ABCDE12345)",
      BIBCODE_SERVER_MACOS_INSTALLER_IDENTITY: "Developer ID Installer: BiBCode (ABCDE12345)",
      APPLE_TEAM_ID: "ABCDE12345",
      BIBCODE_SERVER_MACOS_NOTARY_PROFILE: "bibcode-server-notary",
    });
    if (configuration === null) throw new Error("Developer ID fixture configuration is missing.");
    await expect(
      signAndVerifyMacExecutable({
        path: executable,
        cwd: root,
        configuration,
        commandRunner,
        limits: { timeoutMs: 5_000 },
      }),
    ).resolves.toMatchObject({
      binary: "developer-id",
      package: "none",
      verified: true,
      teamId: "ABCDE12345",
    });
    expect(commands).toEqual([
      "codesign:--force",
      "codesign:--verify",
      "codesign:--force",
      "codesign:--verify",
      "spctl:--assess",
    ]);
  });

  it("signs and independently verifies Windows bytes without leaking child output", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-authenticode-"));
    const executable = NodePath.join(root, "bibcode.exe");
    NodeFS.writeFileSync(executable, "binary");
    const commands: string[] = [];
    const runner: ServerArtifactCommandRunner = async ({ command, args }) => {
      commands.push(`${command}:${args[0]}`);
      if (command === "pwsh") {
        return {
          stdout: JSON.stringify({
            status: "Valid",
            subject: certificate.subject,
            thumbprint: certificate.thumbprint,
            notBefore: "2035-01-01T00:00:00.000Z",
            notAfter: "2037-01-01T00:00:00.000Z",
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };

    await expect(
      signAndVerifyWindowsArtifact({
        path: executable,
        cwd: root,
        env: windowsEnvironment,
        commandRunner: runner,
        limits: { timeoutMs: 5_000 },
        nowEpochMs: Date.parse("2036-01-01T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      binary: "authenticode",
      package: "none",
      verified: true,
      timestamped: true,
      signerSubject: certificate.subject,
      signerThumbprint: certificate.thumbprint,
    });
    expect(commands).toEqual(["signtool:sign", "signtool:verify", "pwsh:-NoLogo"]);

    const canary = "SECRET_SIGNING_OUTPUT_CANARY";
    await expect(
      signAndVerifyWindowsArtifact({
        path: executable,
        cwd: root,
        env: windowsEnvironment,
        commandRunner: async () => Promise.reject(new Error(canary)),
        limits: { timeoutMs: 5_000 },
      }),
    ).rejects.toThrow("Windows Authenticode signing or timestamping failed.");
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
      ["rust-toolchain.toml", '[toolchain]\nchannel = "1.97.1"\n'],
      ["LICENSE", "license"],
      ["apps/web/package.json", '{"name":"@bibcode/web","version":"0.4.1"}'],
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

  it("dry-runs universal macOS assembly through the injected bounded command runner", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-native-build-"));
    const fixtureRepo = NodePath.join(root, "repo");
    const write = (relative: string, contents: string, mode?: number): string => {
      const path = NodePath.join(fixtureRepo, relative);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, contents, mode === undefined ? undefined : { mode });
      return path;
    };
    for (const [relative, contents] of [
      ["Cargo.lock", "lock"],
      ["pnpm-lock.yaml", "lock"],
      ["rust-toolchain.toml", '[toolchain]\nchannel = "1.97.1"\n'],
      ["LICENSE", "license"],
      ["apps/web/package.json", '{"name":"@bibcode/web","version":"0.4.1"}'],
      ["apps/server/package.json", '{"version":"0.4.1"}'],
      ["apps/server/Cargo.toml", '[package]\nname="bibcode-server"\n'],
      ["packaging/server/common/install-layout.json", '{"packageVersion":"0.4.1"}'],
      [
        "packaging/server/macos/Distribution.xml",
        NodeFS.readFileSync(
          NodePath.join(sourceRepoRoot, "packaging/server/macos/Distribution.xml"),
          "utf8",
        ),
      ],
    ] as const) {
      write(relative, contents);
    }
    for (const script of ["preinstall", "postinstall"] as const) {
      write(
        `packaging/server/macos/scripts/${script}`,
        NodeFS.readFileSync(
          NodePath.join(sourceRepoRoot, `packaging/server/macos/scripts/${script}`),
          "utf8",
        ),
        0o755,
      );
    }
    const webRoot = write("frozen-web/index.html", "<main>server</main>");
    const webDirectory = NodePath.dirname(webRoot);
    const webManifest = await collectWebAssetManifest(webDirectory);
    const webManifestPath = write(
      "frozen-web-assets.json",
      `${JSON.stringify(webManifest, null, 2)}\n`,
    );
    const externalSlice = write("native-input/x86_64/bibcode", "binary:x86_64-apple-darwin", 0o755);
    const externalSliceMetadata = write(
      "native-input/x86_64/build.json",
      `${JSON.stringify({
        schemaVersion: 1,
        product: "bibcode-server",
        version: "0.4.1",
        sourceSha: "a".repeat(40),
        targetTriple: "x86_64-apple-darwin",
        binarySha256: NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(externalSlice))
          .digest("hex"),
      })}\n`,
    );
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const argumentValue = (args: ReadonlyArray<string>, name: string): string => {
      const index = args.indexOf(name);
      const value = index >= 0 ? args[index + 1] : undefined;
      if (value === undefined) throw new Error(`dry-run command is missing ${name}`);
      return value;
    };
    const stage = (args: ReadonlyArray<string>): void => {
      const output = argumentValue(args, "--output");
      const binary = argumentValue(args, "--binary");
      NodeFS.mkdirSync(NodePath.join(output, "bin"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(output, "share/bibcode/web"), { recursive: true });
      NodeFS.copyFileSync(binary, NodePath.join(output, "bin/bibcode"));
      NodeFS.chmodSync(NodePath.join(output, "bin/bibcode"), 0o755);
      NodeFS.copyFileSync(
        NodePath.join(argumentValue(args, "--web-root"), "index.html"),
        NodePath.join(output, "share/bibcode/web/index.html"),
      );
      for (const [flag, relative] of [
        ["--web-asset-manifest", "share/bibcode/web-assets.json"],
        ["--install-layout", "share/bibcode/install-layout.json"],
        ["--license", "share/bibcode/LICENSE"],
        ["--notices", "share/bibcode/THIRD-PARTY-NOTICES.md"],
        ["--build-metadata", "share/bibcode/build-metadata.json"],
        ["--portable-readme", "README.md"],
      ] as const) {
        NodeFS.copyFileSync(argumentValue(args, flag), NodePath.join(output, relative));
      }
    };
    const runner: ServerArtifactCommandRunner = async ({ command, args }) => {
      commands.push({ command, args });
      if (command === "rustup" && args[0] === "which") {
        const tool = args.at(-1);
        if (tool !== "cargo" && tool !== "rustc") throw new Error("unexpected Rust tool lookup");
        return { stdout: `${write(`toolchain/bin/${tool}`, tool, 0o755)}\n`, stderr: "" };
      }
      const delegatedTool = NodePath.basename(command);
      const delegatedArgs = args;
      if (delegatedTool === "cargo" && delegatedArgs[0] === "metadata") {
        const id = "path+file:///fixture#bibcode-server@0.4.1";
        return {
          stdout: JSON.stringify({
            packages: [{ id, name: "bibcode-server", version: "0.4.1", license: "Apache-2.0" }],
            resolve: { nodes: [{ id, deps: [] }] },
          }),
          stderr: "",
        };
      }
      if (delegatedTool === "rustc") {
        return { stdout: "rustc 1.90.0 (fixture)\nhost: aarch64-apple-darwin\n", stderr: "" };
      }
      if (delegatedTool === "cargo" && delegatedArgs[0] === "build") {
        const target = argumentValue(delegatedArgs, "--target");
        const executable = write(`target/${target}/release/bibcode`, `binary:${target}`, 0o755);
        return {
          stdout: `${JSON.stringify({
            reason: "compiler-artifact",
            target: { name: "bibcode", kind: ["bin"] },
            executable,
          })}\n`,
          stderr: "",
        };
      }
      if (NodePath.basename(command) === "bibcode" && args[0] === "--version") {
        return { stdout: "bibcode 0.4.1\n", stderr: "" };
      }
      if (delegatedTool === "cargo" && delegatedArgs.includes("stage")) {
        stage(delegatedArgs);
        return { stdout: "", stderr: "" };
      }
      if (command === "lipo" && args[0] === "-create") {
        NodeFS.copyFileSync(args[1] ?? "", argumentValue(args, "-output"));
        return { stdout: "", stderr: "" };
      }
      if (command === "lipo" && args[0] === "-archs") {
        return {
          stdout:
            NodePath.basename(NodePath.dirname(args[1] ?? "")) === "macos"
              ? "x86_64 arm64\n"
              : "x86_64\n",
          stderr: "",
        };
      }
      if (command === "codesign") return { stdout: "", stderr: "" };
      if (command === "xattr") return { stdout: "", stderr: "" };
      if (command === "pkgbuild" || command === "productbuild") {
        write(NodePath.relative(fixtureRepo, args.at(-1) ?? ""), `${command} output`);
        return { stdout: "", stderr: "" };
      }
      if (command === "pkgutil" && args[0] === "--payload-files") {
        return {
          stdout: [
            ".",
            "./usr",
            "./usr/local",
            "./usr/local/bin",
            "./usr/local/bin/bibcode",
            "./usr/local/libexec/bibcode-server/bin/bibcode",
            "./usr/local/libexec/bibcode-server/share/bibcode/build-metadata.json",
          ].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`unexpected dry-run command: ${command} ${args.join(" ")}`);
    };
    const outputDir = NodePath.join(root, "output");

    const result = await buildServerArtifact(
      {
        target: "aarch64-apple-darwin",
        formats: ["native"],
        outputDir,
        unsignedTest: true,
        sourceSha: "a".repeat(40),
        sourceDateEpoch: 1_700_000_000,
        webAssetsDir: webDirectory,
        webAssetsManifest: webManifestPath,
        macosOtherSlice: externalSlice,
        macosOtherSliceMetadata: externalSliceMetadata,
      },
      {
        repoRoot: fixtureRepo,
        host: { platform: "darwin", arch: "arm64" },
        commandRunner: runner,
      },
    );

    expect(result.artifactPaths.map((path) => NodePath.basename(path))).toEqual([
      "bibcode-server-0.4.1-macos-universal.pkg",
    ]);
    expect(result.archivePath).toBeUndefined();
    const metadata = JSON.parse(NodeFS.readFileSync(result.metadataPaths[0] ?? "", "utf8")) as {
      readonly targetTriple: string;
      readonly sliceSha256: Record<string, string>;
      readonly artifact: {
        readonly downloadName: string;
        readonly nativeSigning: {
          readonly binary: string;
          readonly package: string;
          readonly verified: boolean;
          readonly timestamped: boolean;
        };
      };
      readonly fileInventory: ReadonlyArray<{ readonly path: string }>;
    };
    expect(metadata.targetTriple).toBe("universal-apple-darwin");
    expect(Object.keys(metadata.sliceSha256).sort()).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    expect(metadata.artifact).toMatchObject({
      downloadName: "bibcode-server-0.4.1-macos-universal.pkg",
      nativeSigning: {
        binary: "adhoc",
        package: "none",
        verified: false,
        timestamped: false,
      },
    });
    expect(metadata.fileInventory.map((record) => record.path)).toEqual(
      expect.arrayContaining(["bin/bibcode", "share/bibcode/web/index.html"]),
    );
    expect(commands.some(({ command, args }) => command === "lipo" && args[0] === "-create")).toBe(
      true,
    );
    expect(
      commands.filter(
        ({ command, args }) => NodePath.basename(command) === "cargo" && args[0] === "build",
      ),
    ).toHaveLength(1);
    expect(commands.some(({ command }) => command === "pkgbuild")).toBe(true);
    expect(commands.some(({ command }) => command === "productbuild")).toBe(true);
    expect(commands.some(({ command, args }) => command === "xattr" && args[0] === "-cr")).toBe(
      true,
    );
    expect(commands.some(({ command }) => command === "pkgutil")).toBe(true);
    expect(
      commands.some(
        ({ command, args }) => NodePath.basename(command) === "cargo" && args.includes("archive"),
      ),
    ).toBe(false);
  });
});
