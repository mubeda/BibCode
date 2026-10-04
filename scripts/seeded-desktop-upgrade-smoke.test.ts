// @effect-diagnostics nodeBuiltinImport:off - The packaged-upgrade harness owns host paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import { AuthPairingLink } from "@bibcode/contracts";
import { parse as parseToml, type TomlTable } from "smol-toml";
import {
  releasePackageFiles,
  releaseRustPackageFiles,
  releaseVersionFiles,
} from "./update-release-package-versions.ts";

import {
  assertBaselineVersionIsOlder,
  assertSeededUpgradeBuildVersion,
  assertWebDriverPhaseExit,
  windowsCandidateIsInstalled,
  buildLocalUpdaterManifest,
  buildSeededUpgradeOverlay,
  canonicalizeSeededUpgradeWorkRoot,
  createSeededUpgradeDriverSpec,
  createSeededUpgradeRunLayout,
  createSeededUpgradeWdioConfig,
  ManagedProcessRegistry,
  parseSeededDesktopUpgradeSmokeArgs,
  prepareSeededUpgradeBuild,
  redactAndBoundUpgradeEvidence,
  writeRemoteUploadCapabilityReceipt,
  readRemoteFixtureSecrets,
  stopRemoteUploadFixture,
  removeSeededUpgradeDependencyTree,
  runBoundedCommand,
  seededUpgradeVitePlusExecutable,
  seededUpgradeBundleRoot,
  seededUpgradeRustTarget,
  seededUpgradePhaseTimeoutMs,
  updaterTargetFor,
  verifySeededUpgradeOutcome,
  waitForUpgradeCondition,
  restartedApplicationCleanupPlan,
  assertRemoteInstallPort,
  countAppImageMounts,
  scopedCleanupPids,
  verifyRemoteInstallOutcome,
  SeededDesktopUpgradeSmokeError,
  type RemoteInstallEvidence,
  runSeededDesktopUpgradeSmoke,
  type SeededDesktopUpgradeSmokeInput,
} from "./seeded-desktop-upgrade-smoke.ts";

const absolute = (...parts: ReadonlyArray<string>): string =>
  NodePath.resolve("/tmp/bibcode-upgrade-smoke", ...parts);

const decodePairingLink = Schema.decodeUnknownSync(Schema.toCodecJson(AuthPairingLink));
const repositoryRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

describe("private held upload receipt and cleanup", () => {
  const directory = "bibcode-update-witness-00000000-0000-4000-8000-000000000001";
  const receipt = {
    version: 1 as const,
    relativeDirectory: directory,
    relativeUrl: "/api/transfers/private-capability",
  };
  async function owned(
    run: (root: string, workspace: string, upload: string, credentials: string) => Promise<void>,
  ) {
    const root = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "held-upload-receipt-"),
    );
    const workspace = NodePath.join(root, "workspace");
    await NodeFS.promises.mkdir(workspace);
    const credentials = NodePath.join(root, "credentials.json");
    await NodeFS.promises.writeFile(
      credentials,
      JSON.stringify({ bootstrapToken: "private-grant" }),
      { mode: 0o600 },
    );
    try {
      await run(root, workspace, NodePath.join(root, "upload.json"), credentials);
    } finally {
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  }
  effectIt.effect(
    "persists an immutable private capability receipt and reads all literal secrets",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        yield* Effect.promise(() =>
          owned(async (_root, _workspace, path, credentials) => {
            await writeRemoteUploadCapabilityReceipt(path, receipt);
            const bytes = await NodeFS.promises.readFile(path, "utf8");
            expect(JSON.parse(bytes)).toEqual(receipt);
            if (platform !== "win32")
              expect((await NodeFS.promises.stat(path)).mode & 0o777).toBe(0o600);
            await expect(
              writeRemoteUploadCapabilityReceipt(path, {
                ...receipt,
                relativeUrl: "/api/transfers/replacement",
              }),
            ).rejects.toThrow("private upload receipt");
            expect(await NodeFS.promises.readFile(path, "utf8")).toBe(bytes);
            expect(
              await readRemoteFixtureSecrets({
                credentialReceiptPath: credentials,
                uploadReceiptPath: path,
                requireUploadReceipt: true,
              }),
            ).toEqual(
              expect.arrayContaining(["private-grant", receipt.relativeUrl, "private-capability"]),
            );
          }),
        );
      }),
  );
  it.each(["malformed", "unexpected-fields", "traversal", "missing", "oversized"])(
    "refuses %s receipts with closed errors",
    async (kind) => {
      await owned(async (_root, _workspace, path, credentials) => {
        const text =
          kind === "malformed"
            ? '{"private-capability":'
            : kind === "unexpected-fields"
              ? JSON.stringify({ ...receipt, privateUnknown: "private-capability" })
              : kind === "traversal"
                ? JSON.stringify({ ...receipt, relativeDirectory: "../outside" })
                : kind === "oversized"
                  ? "private-capability".repeat(1000)
                  : null;
        if (text !== null) await NodeFS.promises.writeFile(path, text);
        const error = await readRemoteFixtureSecrets({
          credentialReceiptPath: credentials,
          uploadReceiptPath: path,
          requireUploadReceipt: true,
        }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
        expect(String(error)).not.toContain("private-capability");
      });
    },
  );
  it.each([
    ["credentials", false],
    ["credentials", true],
    ["upload", false],
    ["upload", true],
  ] as const)(
    "rejects present null %s even when required upload is %s",
    async (kind, requireUploadReceipt) => {
      await owned(async (_root, _workspace, path, credentials) => {
        await NodeFS.promises.writeFile(kind === "credentials" ? credentials : path, "null");
        const error = await readRemoteFixtureSecrets({
          credentialReceiptPath: credentials,
          uploadReceiptPath: path,
          requireUploadReceipt,
        }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
        expect(String(error)).not.toContain("private-grant");
      });
    },
  );
  it("requires bootstrap receipt once the remote phase could have returned credentials", async () => {
    await owned(async (_root, _workspace, path, credentials) => {
      await NodeFS.promises.rm(credentials);
      const input = {
        credentialReceiptPath: credentials,
        uploadReceiptPath: path,
        requireUploadReceipt: false,
        requireCredentialReceipt: true,
      };
      await expect(readRemoteFixtureSecrets(input)).rejects.toThrow(
        "private remote credential receipt",
      );
    });
  });
  it("allows absent receipts before any remote phase could start", async () => {
    await owned(async (_root, _workspace, path, credentials) => {
      await NodeFS.promises.rm(credentials);
      expect(
        await readRemoteFixtureSecrets({
          credentialReceiptPath: credentials,
          uploadReceiptPath: path,
          requireUploadReceipt: false,
        }),
      ).toEqual([]);
    });
  });
  it("waits for actual process-stop settlement before removing only owned upload residue", async () => {
    await owned(async (_root, workspace, path) => {
      await writeRemoteUploadCapabilityReceipt(path, receipt);
      const target = NodePath.join(workspace, directory);
      await NodeFS.promises.mkdir(target);
      await NodeFS.promises.writeFile(NodePath.join(target, "protection-witness.txt"), "o");
      await NodeFS.promises.writeFile(
        NodePath.join(target, ".protection-witness.txt.1-2-3.bibcode-upload.part"),
        "o",
      );
      const gate = Promise.withResolvers<void>();
      const stopping = stopRemoteUploadFixture({
        workspaceRoot: workspace,
        uploadReceiptPath: path,
        stop: () => gate.promise,
      });
      expect(NodeFS.existsSync(target)).toBe(true);
      gate.resolve();
      await stopping;
      expect(NodeFS.existsSync(target)).toBe(false);
      expect(NodeFS.existsSync(workspace)).toBe(true);
    });
  });
  it("refuses malformed bootstrap JSON without exposing the parse input", async () => {
    await owned(async (_root, _workspace, path, credentials) => {
      await writeRemoteUploadCapabilityReceipt(path, receipt);
      await NodeFS.promises.writeFile(credentials, '{"private-grant":');
      const error = await readRemoteFixtureSecrets({
        credentialReceiptPath: credentials,
        uploadReceiptPath: path,
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
      expect(String(error)).not.toContain("private-grant");
    });
  });
  it("preserves residue when process cleanup fails or the directory contains unknown work", async () => {
    await owned(async (_root, workspace, path) => {
      await writeRemoteUploadCapabilityReceipt(path, receipt);
      const target = NodePath.join(workspace, directory);
      await NodeFS.promises.mkdir(target);
      await NodeFS.promises.writeFile(NodePath.join(target, "unexpected.txt"), "preserve");
      await expect(
        stopRemoteUploadFixture({
          workspaceRoot: workspace,
          uploadReceiptPath: path,
          stop: async () => {
            throw new Error("stop refused");
          },
        }),
      ).rejects.toThrow();
      expect(NodeFS.existsSync(target)).toBe(true);
      await expect(
        stopRemoteUploadFixture({
          workspaceRoot: workspace,
          uploadReceiptPath: path,
          stop: async () => {},
        }),
      ).rejects.toThrow();
      expect(await NodeFS.promises.readFile(NodePath.join(target, "unexpected.txt"), "utf8")).toBe(
        "preserve",
      );
    });
  });
});

/** Execute the real retention/dispatch bodies with inert native ports and owned temporary files. */
const remoteRetentionFixture = async () => {
  const root = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "remote-retention-"));
  const runRoot = NodePath.join(root, "remote");
  const evidenceDirectory = NodePath.join(runRoot, "evidence");
  await NodeFS.promises.mkdir(evidenceDirectory, { recursive: true });
  const source = await NodeFS.promises.readFile(
    new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
    "utf8",
  );
  const phaseStart = source.indexOf("const runWebDriverPhase = async");
  const phaseEnd = source.indexOf("\nconst startMockUpdateServer", phaseStart);
  const laneStart = source.indexOf("const runUpgradeLane = async");
  const laneEnd = source.indexOf("\nconst copyBoundedEvidence", laneStart);
  const ownerStart = source.indexOf(
    "      await runUpgradeLane({\n        appBinaryPath: remoteApp,",
  );
  const ownerEnd = source.indexOf("\n      });", ownerStart) + "\n      });".length;
  const finallyStart = source.indexOf("    const secrets = [signingKey, signingPassword];");
  const finallyEnd = source.indexOf("\n  }\n  if (failure !== undefined)", finallyStart);
  if (
    [phaseStart, phaseEnd, laneStart, laneEnd, ownerStart, finallyStart, finallyEnd].some(
      (index) => index < 0,
    )
  )
    throw new Error("Remote evidence owner source is unavailable.");
  const phaseInput = {
    appBinaryPath: NodePath.join(root, "owned-app"),
    backendPort: 14953,
    candidateVersion: "0.7.3",
    dataRoot: NodePath.join(runRoot, "data"),
    evidenceDirectory,
    expectedDataRoot: NodePath.join(runRoot, "data"),
    lane: "remote-install",
    phase: "seed-and-install",
    platform: "linux",
    projectId: "remote-fixture",
    repositoryRoot,
    restartTimeoutMs: 30_000,
    resultPath: NodePath.join(runRoot, "before.json"),
    runRoot,
    workspaceRoot: NodePath.join(runRoot, "workspace"),
    webdriverPort: 15053,
    wsl: false,
  };
  const runCommand = vi.fn(async () => ({
    exitCode: 1,
    stdout: "fixture-private-returned-token",
    stderr: "private receipt write failed",
  }));
  const copyBoundedEvidence = vi.fn(async () => {});
  const cleanup = vi.fn(async () => {});
  const context = NodeVM.createContext({
    NodeFS,
    NodePath,
    NodeURL,
    process: { env: {} },
    REMOTE_UPDATE_DOWNLOAD_BUDGET_MS: 1,
    REMOTE_UPDATE_INSTALL_BUDGET_MS: 1,
    REMOTE_UPDATE_RESTART_BUDGET_MS: 1,
    seededUpgradeVitePlusExecutable,
    seededUpgradePhaseTimeoutMs,
    createSeededUpgradeDriverSpec,
    createSeededUpgradeWdioConfig,
    readRemoteFixtureSecrets,
    redactAndBoundUpgradeEvidence,
    assertWebDriverPhaseExit,
    assertRemoteInstallPort,
    SeededDesktopUpgradeSmokeError,
    runCommand,
    remotePhaseStarted: false,
    signingKey: "private-signing-key",
    signingPassword: "private-signing-password",
    failure: undefined,
    remoteApp: phaseInput.appBinaryPath,
    runId: "fixture",
    input: {
      ...phaseInput,
      updaterPort: 14950,
      artifactDirectory: NodePath.join(root, "retained"),
    },
    layout: { remoteInstall: phaseInput },
    requestLogPath: NodePath.join(root, "requests.jsonl"),
    readObservation: async (path: string) =>
      JSON.parse(await NodeFS.promises.readFile(path, "utf8")),
    copyBoundedEvidence,
    cleanup: { cleanup },
  });
  const evaluate = (body: string): Promise<unknown> =>
    NodeVM.runInContext(NodeModule.stripTypeScriptTypes(`(async () => { ${body} })()`), context, {
      timeout: 1_000,
    }) as Promise<unknown>;
  const runPhase = async (prepareFailure = false) => {
    if (prepareFailure) {
      await NodeFS.promises.writeFile(NodePath.join(runRoot, "seed-and-install-driver"), "owned");
    }
    return evaluate(
      source.slice(phaseStart, phaseEnd) +
        "\n" +
        source.slice(laneStart, laneEnd) +
        "\n" +
        source.slice(ownerStart, ownerEnd),
    );
  };
  return {
    root,
    runRoot,
    evidenceDirectory,
    runCommand,
    copyBoundedEvidence,
    cleanup,
    runPhase,
    finalize: () => evaluate(source.slice(finallyStart, finallyEnd) + "\n return failure;"),
    dispose: () => NodeFS.promises.rm(root, { recursive: true, force: true }),
  };
};

describe("remote phase receipt retention boundaries", () => {
  it("refuses phase logs after credentials return but receipt publication fails", async () => {
    const fixture = await remoteRetentionFixture();
    try {
      const error = await fixture.runPhase().catch((error: unknown) => error);
      expect(
        NodeFS.existsSync(NodePath.join(fixture.evidenceDirectory, "seed-and-install.log")),
      ).toBe(false);
      expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
      expect(String(error)).not.toContain("fixture-private-returned-token");
    } finally {
      await fixture.dispose();
    }
  });
  it.each(["returned", "thrown"])(
    "refuses final copies after a %s remote phase failure without a bootstrap receipt",
    async (kind) => {
      const fixture = await remoteRetentionFixture();
      try {
        if (kind === "thrown")
          fixture.runCommand.mockRejectedValue(new Error("fixture launch failure"));
        await fixture.runPhase().catch(() => undefined);
        const finalError = await fixture.finalize();
        expect(fixture.copyBoundedEvidence).not.toHaveBeenCalled();
        expect(finalError).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
        expect(fixture.cleanup).toHaveBeenCalledOnce();
      } finally {
        await fixture.dispose();
      }
    },
  );
  it("keeps earlier evidence when local phase preparation fails before any launch attempt", async () => {
    const fixture = await remoteRetentionFixture();
    try {
      await expect(fixture.runPhase(true)).rejects.toThrow();
      expect(fixture.runCommand).not.toHaveBeenCalled();
      expect(await fixture.finalize()).toBeUndefined();
      expect(fixture.copyBoundedEvidence).toHaveBeenCalledOnce();
      expect(fixture.cleanup).toHaveBeenCalledOnce();
    } finally {
      await fixture.dispose();
    }
  });
  it("retains redacted failure evidence with a valid bootstrap receipt before install dispatch", async () => {
    const fixture = await remoteRetentionFixture();
    try {
      await NodeFS.promises.writeFile(
        NodePath.join(fixture.runRoot, "remote-bootstrap.secret.json"),
        JSON.stringify({ bootstrapToken: "fixture-private-returned-token" }),
      );
      await expect(fixture.runPhase()).rejects.toThrow();
      const log = await NodeFS.promises.readFile(
        NodePath.join(fixture.evidenceDirectory, "seed-and-install.log"),
        "utf8",
      );
      expect(log).toContain("[REDACTED]");
      expect(log).not.toContain("fixture-private-returned-token");
      expect(await fixture.finalize()).toBeUndefined();
      expect(fixture.copyBoundedEvidence).toHaveBeenCalledOnce();
      expect(fixture.cleanup).toHaveBeenCalledOnce();
    } finally {
      await fixture.dispose();
    }
  });
});

const versionFixture = async () => {
  const root = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "seeded-versions-"));
  const originals = new Map(
    await Promise.all(
      releaseVersionFiles.map(
        async (path) =>
          [
            path,
            await NodeFS.promises.readFile(NodePath.join(repositoryRoot, path), "utf8"),
          ] as const,
      ),
    ),
  );
  const checkout = async (name: string, version: string) => {
    const path = NodePath.join(root, name);
    for (const [relativePath, content] of originals) {
      const destination = NodePath.join(path, relativePath);
      await NodeFS.promises.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFS.promises.writeFile(destination, content);
    }
    // A prior tag's helper must not own current harness preparation.
    await NodeFS.promises.mkdir(NodePath.join(path, "scripts"));
    await NodeFS.promises.writeFile(
      NodePath.join(path, "scripts/update-release-package-versions.ts"),
      'throw new Error("Do not run the old checkout helper");\n',
    );
    const overlayPath = NodePath.join(root, `${name}-overlay.json`);
    await NodeFS.promises.writeFile(overlayPath, JSON.stringify({ version }));
    return { checkout: path, repositoryRoot, overlayPath, version };
  };
  return { root, originals, checkout };
};
const publicPairingGrant = {
  id: "fixture-grant",
  credential: "fixture-distinct-grant",
  scopes: ["orchestration:read", "orchestration:operate"],
  subject: "one-time-token",
  createdAt: "2026-10-02T08:00:00Z",
  expiresAt: "2026-10-02T08:05:00Z",
  reach: "another-device",
};

/** Runs the generated verifier, including its real browser callback and RPC request. */
const shellObservationFixture = (options: { loggerThrows?: boolean } = {}) => {
  const spec = createSeededUpgradeDriverSpec({
    candidateVersion: "0.7.3",
    expectedDataRoot: absolute("fixture", "data"),
    lane: "remote-install",
    phase: "verify",
    projectId: "fixture-project",
    resultPath: absolute("fixture", "after.json"),
    workspaceRoot: absolute("fixture", "workspace"),
  });
  const requests: Array<Record<string, unknown>> = [];
  const logs: Array<string> = [];
  const files = new Map<string, string>();
  let decodedMessage: unknown;
  const sockets: Array<FixtureSocket> = [];
  let run: Promise<void> = Promise.resolve();
  let settled = false;
  class FixtureSocket {
    readonly listeners = new Map<string, Set<(event: unknown) => void>>();
    constructor(_url: URL) {
      sockets.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.get(type)?.delete(listener);
    }
    send(text: string) {
      requests.push(JSON.parse(text) as Record<string, unknown>);
    }
    close() {
      this.emit("close", { code: 1000, wasClean: true });
    }
    emit(type: string, event: unknown) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }
  const context = {
    NodeFS: { writeFileSync: (path: string, contents: string) => files.set(path, contents) },
    browser: {
      waitUntil: async (condition: () => Promise<boolean>) => {
        if (!(await condition())) throw new Error("Fixture bridge unavailable.");
      },
      execute: async (callback: (...args: unknown[]) => unknown, ...args: unknown[]) =>
        callback(...args),
    },
    window: {
      desktopBridge: {
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            httpBaseUrl: "http://127.0.0.1:43123",
            wsBaseUrl: "ws://127.0.0.1:43123/ws",
          },
        ],
        getLocalEnvironmentBearerToken: async () => "fixture-private-bearer",
        getProjectDataStatuses: async () => [
          {
            environmentId: "primary",
            effectiveRoot: absolute("fixture", "data"),
            storageInstanceId: "fixture-private-storage",
            backups: [{ trigger: "pre-update" }],
          },
        ],
        getUpdateState: async () => ({ currentVersion: "0.7.3" }),
      },
    },
    fetch: async (url: URL) => ({
      ok: true,
      json: async () =>
        url.pathname === "/api/auth/websocket-ticket"
          ? { ticket: "fixture-private-ticket" }
          : { storageInstanceId: "fixture-private-storage" },
    }),
    WebSocket: FixtureSocket,
    JSON: {
      stringify: JSON.stringify,
      parse: (text: string) => {
        if (decodedMessage !== undefined) {
          const message = decodedMessage;
          decodedMessage = undefined;
          return message;
        }
        return JSON.parse(text) as unknown;
      },
    },
    console: {
      info: (text: string) => {
        if (options.loggerThrows) throw new Error("fixture-private-logger-fault");
        logs.push(text);
      },
    },
    URL,
    Date,
    setTimeout,
    clearTimeout,
    describe: (_name: string, callback: () => void) => callback(),
    it: (_name: string, callback: () => Promise<void>) => {
      run = callback();
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    },
  };
  NodeVM.runInNewContext(spec.slice(spec.indexOf("const input =")), context, { timeout: 1_000 });
  return {
    run: () => run,
    settled: () => settled,
    requests,
    files,
    logs,
    message: (message: unknown) => {
      decodedMessage = message;
      sockets[0]!.emit("message", { data: "fixture-decoded-message" });
    },
    event: (type: string, event: unknown) => sockets[0]!.emit(type, event),
    requestId: () => requests.find((request) => request._tag === "Request")!.id,
    listenerCount: (type: string) => sockets[0]!.listeners.get(type)?.size ?? 0,
    facts: () =>
      logs[0] === undefined
        ? {}
        : (JSON.parse(logs[0].replace("seeded-upgrade-stream-observation ", "")) as Record<
            string,
            unknown
          >),
  };
};

describe("generated shell stream observations", () => {
  afterEach(() => vi.useRealTimers());

  it("records a first Chunk without changing the verifier receipt or interrupt", async () => {
    vi.useFakeTimers();
    const fixture = shellObservationFixture();
    await vi.advanceTimersByTimeAsync(0);
    fixture.message({
      _tag: "Chunk",
      requestId: fixture.requestId(),
      values: [{ kind: "snapshot", snapshot: { projects: [{ id: "fixture-project" }] } }],
    });
    await fixture.run();
    expect([...fixture.files.values()].map((text) => JSON.parse(text))).toEqual([
      {
        appVersion: "0.7.3",
        effectiveRoot: absolute("fixture", "data"),
        projectId: "fixture-project",
        projectIds: ["fixture-project"],
        storageInstanceId: "fixture-private-storage",
        preUpdateBackups: [{ trigger: "pre-update", storageInstanceId: "fixture-private-storage" }],
      },
    ]);
    expect(fixture.requests.map((request) => request._tag)).toEqual(["Request", "Interrupt"]);
    expect(fixture.facts()).toMatchObject({
      method: "orchestration.subscribeShell",
      requestCount: 1,
      chunkCount: 1,
      exitSuccessCount: 0,
      exitFailureCount: 0,
      timeout: false,
    });
    expect(fixture.listenerCount("close")).toBe(0);
    // Preserve the original socket-open error listener; remove only the QA listener.
    expect(fixture.listenerCount("error")).toBe(1);
    expect(fixture.logs.join("\n")).not.toContain("fixture-private");
  });

  it.each([
    [
      "ExitSuccess",
      { _tag: "Exit", exit: { _tag: "Success", value: null } },
      { exitSuccessCount: 1, exitFailureCount: 0, defectCount: 0, rpcErrorTag: "unobserved" },
    ],
    [
      "ExitFailure",
      {
        _tag: "Exit",
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: { _tag: "OrchestrationGetSnapshotError", message: "fixture-private-cause" },
            },
          ],
        },
      },
      {
        exitSuccessCount: 0,
        exitFailureCount: 1,
        defectCount: 0,
        rpcErrorTag: "OrchestrationGetSnapshotError",
      },
    ],
    [
      "Defect",
      { _tag: "Defect", defect: { message: "fixture-private-defect" } },
      { exitSuccessCount: 0, exitFailureCount: 0, defectCount: 1, rpcErrorTag: "unobserved" },
    ],
    [
      "Die",
      {
        _tag: "Exit",
        exit: {
          _tag: "Failure",
          cause: [{ _tag: "Die", defect: { message: "fixture-private-defect" } }],
        },
      },
      { exitFailureCount: 1, dieCauseCount: 1, rpcErrorTag: "unobserved" },
    ],
    [
      "Interrupt",
      { _tag: "Exit", exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: 1 }] } },
      { exitFailureCount: 1, interruptCauseCount: 1, rpcErrorTag: "unobserved" },
    ],
    [
      "ClientProtocolError",
      { _tag: "ClientProtocolError", error: { message: "fixture-private-protocol-error" } },
      { protocolErrorCount: 1, rpcErrorTag: "unobserved" },
    ],
  ] as const)(
    "observes %s while preserving the original first-Chunk deadline",
    async (_name, message, facts) => {
      vi.useFakeTimers();
      const fixture = shellObservationFixture();
      await vi.advanceTimersByTimeAsync(0);
      fixture.message(
        message._tag === "Exit" ? { ...message, requestId: fixture.requestId() } : message,
      );
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fixture.settled()).toBe(false);
      const result = expect(fixture.run()).rejects.toThrow(
        "Timed out waiting for orchestration.subscribeShell.",
      );
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(fixture.facts()).toMatchObject({
        ...facts,
        method: "orchestration.subscribeShell",
        requestCount: 1,
        chunkCount: 0,
        timeout: true,
      });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.files.size).toBe(0);
      expect(fixture.logs.join("\n")).not.toContain("fixture-private");
      expect(fixture.listenerCount("close")).toBe(0);
      expect(fixture.listenerCount("error")).toBe(1);
    },
  );

  it("records socket close and error facts without inventing an authorization cause", async () => {
    vi.useFakeTimers();
    const fixture = shellObservationFixture();
    await vi.advanceTimersByTimeAsync(0);
    fixture.event("error", { message: "fixture-private-error" });
    fixture.event("close", { code: 1006, wasClean: false, reason: "fixture-private-reason" });
    const result = expect(fixture.run()).rejects.toThrow(
      "Timed out waiting for orchestration.subscribeShell.",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fixture.facts()).toMatchObject({
      closeCount: 1,
      closeCode: 1006,
      closeWasClean: false,
      socketErrorCount: 1,
      rpcErrorTag: "unobserved",
      timeout: true,
    });
    expect(fixture.logs.join("\n")).not.toContain("fixture-private");
  });

  it("bounds counters and ignores mismatched IDs and private unknown error tags", async () => {
    vi.useFakeTimers();
    const fixture = shellObservationFixture();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 300; index += 1) {
      fixture.message({
        _tag: "Chunk",
        requestId: "fixture-private-other-id",
        values: [{ kind: "snapshot", snapshot: { projects: [] } }],
      });
      fixture.event("error", { message: "fixture-private-error" });
    }
    fixture.message({
      _tag: "Exit",
      requestId: fixture.requestId(),
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: {
              _tag: "fixture-private-error-tag",
              message: "fixture-private-message",
              url: "http://fixture-private.invalid",
              headers: { authorization: "fixture-private-grant" },
            },
          },
        ],
      },
    });
    const result = expect(fixture.run()).rejects.toThrow(
      "Timed out waiting for orchestration.subscribeShell.",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fixture.facts()).toMatchObject({
      chunkCount: 0,
      mismatchedCount: 255,
      socketErrorCount: 255,
      rpcErrorTag: "unknown",
      requestCount: 1,
      timeout: true,
    });
    expect(fixture.logs).toHaveLength(1);
    expect(fixture.logs[0]!.length).toBeLessThan(2048);
    expect(fixture.logs[0]).not.toContain("fixture-private");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.files.size).toBe(0);
  });

  it("does not invoke an error-tag accessor while projecting a Failure", async () => {
    vi.useFakeTimers();
    const fixture = shellObservationFixture();
    await vi.advanceTimersByTimeAsync(0);
    const error = Object.defineProperty({ message: "fixture-private-message" }, "_tag", {
      get() {
        throw new Error("fixture-private-accessor");
      },
    });
    fixture.message({
      _tag: "Exit",
      requestId: fixture.requestId(),
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] },
    });
    const result = expect(fixture.run()).rejects.toThrow(
      "Timed out waiting for orchestration.subscribeShell.",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fixture.facts()).toMatchObject({
      rpcErrorTag: "unknown",
      observerErrorCount: 0,
      timeout: true,
    });
  });

  it.each(["getter", "reflection"] as const)(
    "contains observer-only %s errors and retains the original timeout",
    async (kind) => {
      vi.useFakeTimers();
      const fixture = shellObservationFixture();
      await vi.advanceTimersByTimeAsync(0);
      const exit =
        kind === "getter"
          ? Object.defineProperty({ _tag: "Failure" }, "cause", {
              get() {
                throw new Error("fixture-private-getter");
              },
            })
          : {
              _tag: "Failure",
              cause: [
                {
                  _tag: "Fail",
                  error: new Proxy(
                    {},
                    {
                      getOwnPropertyDescriptor() {
                        throw new Error("fixture-private-reflection");
                      },
                    },
                  ),
                },
              ],
            };
      fixture.message({ _tag: "Exit", requestId: fixture.requestId(), exit });
      const result = expect(fixture.run()).rejects.toThrow(
        "Timed out waiting for orchestration.subscribeShell.",
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(fixture.facts()).toMatchObject({ observerErrorCount: 1, timeout: true });
      expect(fixture.logs.join("\n")).not.toContain("fixture-private");
    },
  );

  it.each([false, true])(
    "contains logger faults without changing first-Chunk success=%s",
    async (chunk) => {
      vi.useFakeTimers();
      const fixture = shellObservationFixture({ loggerThrows: true });
      await vi.advanceTimersByTimeAsync(0);
      if (chunk) {
        fixture.message({
          _tag: "Chunk",
          requestId: fixture.requestId(),
          values: [{ kind: "snapshot", snapshot: { projects: [] } }],
        });
        await fixture.run();
        expect(fixture.files.size).toBe(1);
      } else {
        const result = expect(fixture.run()).rejects.toThrow(
          "Timed out waiting for orchestration.subscribeShell.",
        );
        await vi.advanceTimersByTimeAsync(15_000);
        await result;
      }
      expect(fixture.logs).toEqual([]);
    },
  );
});

/** Executes the generated credential callback and its receipt/driver handoff without a desktop. */
const remoteGrantFixture = (responses: ReadonlyArray<unknown>) => {
  const input = {
    candidateVersion: "0.7.3",
    expectedDataRoot: absolute("remote", "data"),
    lane: "remote-install" as const,
    phase: "seed-and-install" as const,
    projectId: "remote-project",
    resultPath: absolute("remote", "before.json"),
    workspaceRoot: absolute("remote", "workspace"),
    platform: "linux" as const,
    appBinaryPath: absolute("RemoteLane.AppImage"),
    remoteInstallDriverPath: "fixture:driver",
    remoteHarnessPath: "fixture:host",
    remoteSecretPath: absolute("remote", "private.json"),
    remoteUploadSecretPath: absolute("remote", "upload-private.json"),
    remoteEvidencePath: absolute("remote", "evidence", "remote-rpc.json"),
  };
  const spec = createSeededUpgradeDriverSpec(input);
  const start = spec.indexOf("    const credentials = await browser.execute(");
  const end = spec.indexOf("\n  });\n});", start);
  if (start < 0 || end < 0) throw new Error("Generated remote credential scenario is missing.");
  // Replace module loading only; run the actual browser callback and handoff statements.
  const source = spec.slice(start, end).replaceAll("await import(", "await loadFixture(");
  const files = new Map<string, { contents: string; mode?: number }>();
  let responseIndex = 0;
  const fetch = vi.fn(async (_url: URL, _options: { signal?: AbortSignal }) => ({
    ok: true,
    json: async () => responses[Math.min(responseIndex++, responses.length - 1)],
  }));
  const driver = vi.fn(async (_credentials: unknown) => ({ phases: ["succeeded"] }));
  const execute = async (callback: (...args: unknown[]) => unknown, ...args: unknown[]) =>
    callback(...args);
  const context = {
    input,
    widened: true,
    observation: { projectId: "remote-project" },
    browser: { execute },
    window: {
      desktopBridge: {
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            httpBaseUrl: "http://127.0.0.1:43123",
            bootstrapToken: "fixture-desktop-bootstrap",
          },
        ],
        getLocalEnvironmentBearerToken: async () => "fixture-desktop-bearer",
      },
    },
    NodeFS: {
      writeFileSync: (path: string, contents: string, options?: { mode: number }) =>
        files.set(path, { contents, ...options }),
    },
    loadFixture: async (path: string) => {
      if (path === input.remoteInstallDriverPath) return { runRemoteInstallDriver: driver };
      if (path === input.remoteHarnessPath)
        return { captureRemoteInstallHostEvidence: async () => ({ requesterLogLines: 1 }) };
      throw new Error("Unexpected fixture module.");
    },
    fetch,
    URL,
    Date,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  return {
    input,
    context,
    files,
    fetch,
    driver,
    run: () =>
      NodeVM.runInNewContext(`(async () => { ${source} })()`, context, {
        timeout: 1_000,
      }) as Promise<void>,
  };
};

describe("generated remote sharing grant handoff", () => {
  afterEach(() => vi.useRealTimers());

  it("redeems the published grant shape and retains credentials only in the private receipt", async () => {
    decodePairingLink(publicPairingGrant);
    const fixture = remoteGrantFixture([[publicPairingGrant]]);
    await fixture.run();
    expect(fixture.driver).toHaveBeenCalledWith({
      endpoint: "http://127.0.0.1:43123",
      bootstrapToken: "fixture-distinct-grant",
      candidateVersion: "0.7.3",
      workspaceRoot: fixture.input.workspaceRoot,
      uploadReceiptPath: fixture.input.remoteUploadSecretPath,
      requireWide: true,
      onInstallDispatched: expect.any(Function),
    });
    const receipt = fixture.files.get(fixture.input.remoteSecretPath);
    expect(receipt?.mode).toBe(0o600);
    expect(JSON.parse(receipt!.contents)).toEqual({
      endpoint: "http://127.0.0.1:43123",
      bootstrapToken: "fixture-distinct-grant",
    });
    expect(NodePath.dirname(fixture.input.remoteSecretPath)).not.toBe(
      NodePath.dirname(fixture.input.remoteEvidencePath),
    );
    for (const [path, file] of fixture.files) {
      if (path !== fixture.input.remoteSecretPath)
        expect(file.contents).not.toContain("fixture-distinct-grant");
    }
  });

  it("waits for minting after native exposure has already widened", async () => {
    vi.useFakeTimers();
    const fixture = remoteGrantFixture([[], [publicPairingGrant]]);
    const outcome = fixture.run().then(
      () => null,
      (error: Error) => error.message,
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toBeNull();
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(fixture.driver).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["this-computer", [{ ...publicPairingGrant, reach: "this-computer" }]],
    ["custom", [{ ...publicPairingGrant, reach: "custom" }]],
    ["blank credential", [{ ...publicPairingGrant, credential: "  " }]],
    ["missing id", [{ ...publicPairingGrant, id: undefined }]],
    ["null entry", [null]],
    ["no grant", []],
  ])(
    "fails closed within a bound for %s without using the desktop bootstrap",
    async (_name, links) => {
      vi.useFakeTimers();
      const fixture = remoteGrantFixture([links]);
      const outcome = fixture.run().then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
      await vi.runAllTimersAsync();
      expect(await outcome).toBe("Remote verification has no live native sharing grant.");
      expect(fixture.driver).not.toHaveBeenCalled();
      expect(fixture.files.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects malformed list responses without exposing their contents", async () => {
    const fixture = remoteGrantFixture([{ privateDetail: "fixture-private-response" }]);
    await expect(fixture.run()).rejects.toThrow(
      "Remote verification pairing grant response invalid.",
    );
    expect(fixture.files.size).toBe(0);
    expect(fixture.driver).not.toHaveBeenCalled();
  });

  it.each(["http", "body", "transport"])(
    "sanitizes %s failures before any private handoff",
    async (failure) => {
      const fixture = remoteGrantFixture([[publicPairingGrant]]);
      fixture.fetch.mockImplementation(async () => {
        if (failure === "transport") throw new Error("fixture-private-network-detail");
        return {
          ok: failure !== "http",
          json: async () => {
            throw new Error("fixture-private-body-detail");
          },
        };
      });
      await expect(fixture.run()).rejects.toThrow("Remote verification pairing grant unavailable.");
      expect(fixture.files.size).toBe(0);
      expect(fixture.driver).not.toHaveBeenCalled();
    },
  );

  it("aborts a stalled grant request before the embedded driver command deadline", async () => {
    vi.useFakeTimers();
    const fixture = remoteGrantFixture([]);
    const aborted = vi.fn();
    fixture.fetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            aborted();
            reject(new Error("fixture-private-abort-detail"));
          });
        }),
    );
    const startedAt = vi.getMockedSystemTime()!.getTime();
    const outcome = fixture.run().then(
      () => ({
        message: "unexpected success",
        elapsed: vi.getMockedSystemTime()!.getTime() - startedAt,
      }),
      (error: Error) => ({
        message: error.message,
        elapsed: vi.getMockedSystemTime()!.getTime() - startedAt,
      }),
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({
      message: "Remote verification pairing grant unavailable.",
    });
    expect((await outcome).elapsed).toBeGreaterThan(0);
    expect((await outcome).elapsed).toBeLessThan(30_000);
    expect(aborted).toHaveBeenCalledOnce();
    expect(fixture.driver).not.toHaveBeenCalled();
    expect(fixture.files.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("seeded packaging build budgets", () => {
  // Exercise the actual command and its three call sites without launching a
  // native build, updater, or application. Keep the existing command checks.
  const source = NodeFS.readFileSync(
    new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
    "utf8",
  );
  const commandStart = source.indexOf("const requireCommandSuccess = async");
  const commandEnd = source.indexOf("\nconst writePrivateJson", commandStart);
  const buildStart = source.indexOf("const buildPackagedApplication = async");
  const buildEnd = source.indexOf("\nexport const seededUpgradeBundleRoot", buildStart);
  const callsStart = source.indexOf("    await buildPackagedApplication({", buildEnd);
  const callsEnd = source.indexOf("    await publishCandidateUpdater({", callsStart);
  if ([commandStart, commandEnd, buildStart, buildEnd, callsStart, callsEnd].some((i) => i < 0))
    throw new Error("Seeded packaging command source is unavailable.");

  const fixture = (platform: SeededDesktopUpgradeSmokeInput["platform"], arch: "arm64" | "x64") => {
    const layout = createSeededUpgradeRunLayout(absolute("work"), "budget-fixture");
    const runCommand = vi.fn(async (_input: Parameters<typeof runBoundedCommand>[0]) => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));
    const prepareSeededUpgradeBuild = vi.fn(async () => {});
    const signingEnvironment = { TAURI_SIGNING_PRIVATE_KEY: "fixture-private-key" };
    const context = {
      NodePath,
      runCommand,
      prepareSeededUpgradeBuild,
      seededUpgradeVitePlusExecutable,
      seededUpgradeRustTarget,
      SeededDesktopUpgradeSmokeError,
      layout,
      candidateOverlay: absolute("candidate-overlay.json"),
      previousOverlay: absolute("previous-overlay.json"),
      protectedOverlay: absolute("protected-overlay.json"),
      signingEnvironment,
      input: {
        arch,
        platform,
        bundle: platform === "mac" ? "dmg" : platform === "win" ? "nsis" : "appimage",
        repositoryRoot,
        candidateVersion: "9.9.9-upgrade.1",
        previousVersion: "1.2.3",
        wsl: false,
      },
    };
    return {
      ...context,
      run: () =>
        NodeVM.runInNewContext(
          NodeModule.stripTypeScriptTypes(
            `(async () => { ${source.slice(commandStart, commandEnd)}\n${source.slice(buildStart, buildEnd)}\n${source.slice(callsStart, callsEnd)} })()`,
          ),
          context,
          { timeout: 1_000 },
        ) as Promise<void>,
    };
  };

  it.each([
    ["mac", "x64", 90],
    ["mac", "arm64", 45],
    ["linux", "x64", 45],
    ["linux", "arm64", 45],
    ["win", "x64", 45],
    ["win", "arm64", 45],
  ] as const)(
    "bounds all three %s/%s packaging commands at %i minutes",
    async (platform, arch, minutes) => {
      const owned = fixture(platform, arch);
      await owned.run();
      expect(owned.prepareSeededUpgradeBuild).toHaveBeenCalledTimes(3);
      expect(owned.runCommand).toHaveBeenCalledTimes(6);
      const builds = [
        [owned.layout.candidateCheckout, owned.layout.candidateBuildRoot, owned.candidateOverlay],
        [
          owned.layout.previousStable.checkout,
          owned.layout.previousStable.buildRoot,
          owned.previousOverlay,
        ],
        [
          owned.layout.protectedBaseline.checkout,
          owned.layout.protectedBaseline.buildRoot,
          owned.protectedOverlay,
        ],
      ];
      expect(new Set(builds.map(([, target]) => target)).size).toBe(3);
      for (const [index, [checkout, target, overlay]] of builds.entries()) {
        expect(owned.runCommand).toHaveBeenNthCalledWith(index * 2 + 1, {
          command: seededUpgradeVitePlusExecutable,
          args: ["install", "--frozen-lockfile"],
          cwd: checkout,
          inherit: true,
          timeoutMs: 10 * 60_000,
        });
        expect(owned.runCommand).toHaveBeenNthCalledWith(index * 2 + 2, {
          command: seededUpgradeVitePlusExecutable,
          args: [
            "run",
            "--filter",
            "@bibcode/desktop",
            "build",
            "--features",
            "desktop-e2e",
            "--config",
            NodePath.join(checkout!, "apps/desktop/src-tauri/tauri.release.conf.json"),
            "--config",
            NodePath.join(checkout!, "apps/desktop/src-tauri/tauri.e2e.conf.json"),
            "--config",
            overlay,
            "--bundles",
            platform === "mac" ? "app,dmg" : owned.input.bundle,
            "--target",
            seededUpgradeRustTarget(platform, arch),
          ],
          cwd: checkout,
          env: { ...owned.signingEnvironment, CARGO_TARGET_DIR: target },
          inherit: true,
          timeoutMs: minutes * 60_000,
        });
      }
    },
  );

  it.each([1, 2])(
    "still stops on failed command %i before later packages",
    async (failedCommand) => {
      const owned = fixture("mac", "x64");
      if (failedCommand === 2)
        owned.runCommand.mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });
      owned.runCommand.mockResolvedValueOnce({ exitCode: 7, stderr: "", stdout: "" });
      await expect(owned.run()).rejects.toThrow("exited with code 7");
      expect(owned.runCommand).toHaveBeenCalledTimes(failedCommand);
      expect(owned.prepareSeededUpgradeBuild).toHaveBeenCalledTimes(1);
    },
  );
});

describe("seeded packaged desktop upgrade harness", () => {
  it("waits for the exact Windows candidate and installer exit before cleanup", () => {
    const candidate = "0.7.3-upgrade.46";
    const installed = {
      exists: true,
      productVersion: candidate,
      sha256: "a".repeat(64),
      installers: [],
      error: null,
    };
    expect(windowsCandidateIsInstalled(installed, candidate)).toBe(true);
    expect(windowsCandidateIsInstalled({ ...installed, productVersion: "0.7.2" }, candidate)).toBe(
      false,
    );
    expect(
      windowsCandidateIsInstalled({ ...installed, productVersion: "0.7.3-upgrade.45" }, candidate),
    ).toBe(false);
    expect(windowsCandidateIsInstalled({ ...installed, exists: false }, candidate)).toBe(false);
    expect(windowsCandidateIsInstalled({ ...installed, sha256: null }, candidate)).toBe(false);
    expect(
      windowsCandidateIsInstalled({ ...installed, installers: [{ pid: 42 }] }, candidate),
    ).toBe(false);
    expect(windowsCandidateIsInstalled({ ...installed, error: "probe failed" }, candidate)).toBe(
      false,
    );
    expect(windowsCandidateIsInstalled({}, candidate)).toBe(false);
    expect(windowsCandidateIsInstalled(null, candidate)).toBe(false);
  });

  it("generates a syntactically valid isolated remote-install phase", async () => {
    const directory = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "bibcode-remote-spec-"),
    );
    try {
      const spec = createSeededUpgradeDriverSpec({
        candidateVersion: "0.7.3",
        expectedDataRoot: NodePath.join(directory, "data"),
        lane: "remote-install",
        phase: "seed-and-install",
        projectId: "remote-project",
        resultPath: NodePath.join(directory, "before.json"),
        workspaceRoot: NodePath.join(directory, "workspace"),
        platform: "linux",
        appBinaryPath: NodePath.join(directory, "RemoteLane.AppImage"),
        remoteInstallDriverPath: "file:///isolated/remote-install-driver.ts",
        remoteHarnessPath: "file:///isolated/seeded-desktop-upgrade-smoke.ts",
        remoteSecretPath: NodePath.join(directory, "private.json"),
        remoteUploadSecretPath: NodePath.join(directory, "upload-private.json"),
        remoteEvidencePath: NodePath.join(directory, "evidence.json"),
      });
      const path = NodePath.join(directory, "remote.e2e.mjs");
      await NodeFS.promises.writeFile(path, spec);
      const result = NodeChildProcess.spawnSync(process.execPath, ["--check", path], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(spec).not.toContain("bridge.installUpdate()");
    } finally {
      await NodeFS.promises.rm(directory, { recursive: true, force: true });
    }
  });
  it("requires remote phase receipts and helper paths before generating its executable scenario", () => {
    expect(() =>
      createSeededUpgradeDriverSpec({
        candidateVersion: "0.7.3",
        expectedDataRoot: absolute("remote", "data"),
        lane: "remote-install",
        phase: "seed-and-install",
        projectId: "remote-project",
        resultPath: absolute("remote", "before.json"),
        workspaceRoot: absolute("remote", "workspace"),
      }),
    ).toThrow(SeededDesktopUpgradeSmokeError);
  });
  it("rejects a local invocation before inspecting files or starting applications", async () => {
    vi.stubEnv("CI", "false");
    try {
      await expect(
        runSeededDesktopUpgradeSmoke({} as SeededDesktopUpgradeSmokeInput),
      ).rejects.toThrow("CI-only");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("keeps remote installation in its own root and avoids user/dev ports", () => {
    const layout = createSeededUpgradeRunLayout(absolute("work"), "remote-test");
    expect(layout.remoteInstall.dataRoot).toBe(absolute("work", "remote-test", "remote", "data"));
    expect(layout.remoteInstall.dataRoot).not.toBe(layout.protectedBaseline.dataRoot);
    for (const port of [3773, 5733, 13773, 18431, 18432, 0, 65536])
      expect(() => assertRemoteInstallPort(port)).toThrow(SeededDesktopUpgradeSmokeError);
    expect(assertRemoteInstallPort(43123)).toBe(43123);
  });
  it("counts only the isolated remote AppImage mount prefix", () => {
    expect(
      countAppImageMounts(
        "image /tmp/.mount_Remote123 fuse ro 0 0\nimage /tmp/.mount_bibcod456 fuse ro 0 0\ntmpfs /tmp tmpfs rw 0 0",
        ".mount_Remote",
      ),
    ).toBe(1);
  });
  it("requires a candidate restart, stable storage, protection progress, backup, and one isolated runtime", () => {
    const good: RemoteInstallEvidence = {
      before: { bootId: "b1", serverVersion: "0.7.2", storageInstanceId: "s1" },
      after: { bootId: "b2", serverVersion: "0.7.3-upgrade.1", storageInstanceId: "s1" },
      phases: ["downloading", "installing", "succeeded"],
      sawPercent: true,
      sawStage: true,
      heldUpload: {
        admitted: true,
        releasedOnWaitingStage: true,
        completed: true,
        bytesMatch: true,
        noPartials: true,
        requestClosed: true,
        holdLimitMs: 20_000,
      },
      preUpdateBackups: 1,
      requesterLogLines: 1,
      appImageMounts: 1,
      runtimeProcesses: 1,
    };
    expect(() => verifyRemoteInstallOutcome(good, "0.7.3-upgrade.1")).not.toThrow();
    const invalid = [
      { ...good, after: { ...good.after, bootId: "b1" } },
      { ...good, after: { ...good.after, serverVersion: "0.7.2" } },
      { ...good, after: { ...good.after, storageInstanceId: "s2" } },
      { ...good, phases: [] },
      { ...good, sawPercent: false },
      { ...good, sawStage: false },
      { ...good, heldUpload: { ...good.heldUpload, releasedOnWaitingStage: false } },
      { ...good, heldUpload: { ...good.heldUpload, requestClosed: false } },
      { ...good, heldUpload: { ...good.heldUpload, bytesMatch: false } },
      { ...good, heldUpload: { ...good.heldUpload, noPartials: false } },
      { ...good, preUpdateBackups: 0 },
      { ...good, requesterLogLines: 2 },
      { ...good, appImageMounts: 2 },
      { ...good, runtimeProcesses: 2 },
    ];
    for (const evidence of invalid)
      expect(() => verifyRemoteInstallOutcome(evidence, "0.7.3-upgrade.1")).toThrow(
        SeededDesktopUpgradeSmokeError,
      );
  });
  it("selects only process ids with this lane's exact data root", () => {
    expect(
      scopedCleanupPids(
        [
          {
            pid: 10,
            comm: "RemoteLane",
            environ: "BIBCODE_HOME=/tmp/remote/data\u0000HOME=/home/test\u0000",
          },
          {
            pid: 11,
            comm: "bibcode-desktop",
            environ: "BIBCODE_HOME=/tmp/remote/data-other\u0000",
          },
          { pid: 12, comm: "bibcode-desktop", environ: "HOME=/home/user\u0000" },
        ],
        "/tmp/remote/data",
      ),
    ).toEqual([10]);
  });
  it("launches the native Vite+ executable on every host", () => {
    expect(seededUpgradeVitePlusExecutable).toBe("vp");
  });

  it("targets only the exact updater-restarted application on every host", () => {
    expect(
      restartedApplicationCleanupPlan(
        String.raw`C:\Program Files\BiBCode\bibcode-desktop.exe`,
        "win",
      ),
    ).toEqual({
      args: ["/F", "/T", "/IM", "bibcode-desktop.exe"],
      command: "taskkill.exe",
    });
    expect(
      restartedApplicationCleanupPlan(
        "/private/tmp/BiBCode (test).app/Contents/MacOS/bibcode-desktop",
        "mac",
      ),
    ).toEqual({
      args: ["-TERM", "-x", "bibcode-desktop"],
      command: "pkill",
    });
    expect(restartedApplicationCleanupPlan("/tmp/installed/BiBCode.AppImage", "linux")).toEqual({
      args: ["-TERM", "-x", "bibcode-desktop"],
      command: "pkill",
    });
  });

  it("canonicalizes symlinked work roots before installing an updater target", async () => {
    const temporaryBase = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "bibcode-upgrade-canonical-owner-"),
    );
    try {
      const root = await NodeFS.promises.mkdtemp(NodePath.join(temporaryBase, "fixture-"));
      try {
        const target = NodePath.join(root, "target");
        const alias = NodePath.join(root, "alias");
        await NodeFS.promises.mkdir(target);
        await NodeFS.promises.symlink(target, alias, "junction");

        await expect(canonicalizeSeededUpgradeWorkRoot(alias)).resolves.toBe(
          await NodeFS.promises.realpath(target),
        );
      } finally {
        await NodeFS.promises.rm(root, { recursive: true, force: true });
      }
      await expect(NodeFS.promises.readdir(temporaryBase)).resolves.toEqual([]);
    } finally {
      await NodeFS.promises.rm(temporaryBase, { recursive: true, force: true });
    }
  });

  it("removes only the generated dependency tree before worktree cleanup", async () => {
    const checkout = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "bibcode-upgrade-cleanup-"),
    );
    try {
      await NodeFS.promises.mkdir(NodePath.join(checkout, "node_modules", ".pnpm", "deep"), {
        recursive: true,
      });
      await NodeFS.promises.writeFile(NodePath.join(checkout, "keep.txt"), "keep");

      await removeSeededUpgradeDependencyTree(checkout);

      await expect(NodeFS.promises.stat(NodePath.join(checkout, "node_modules"))).rejects.toThrow();
      await expect(
        NodeFS.promises.readFile(NodePath.join(checkout, "keep.txt"), "utf8"),
      ).resolves.toBe("keep");
    } finally {
      await NodeFS.promises.rm(checkout, { recursive: true, force: true });
    }
  });

  it("parses deterministic platform arguments and resolves only absolute isolated roots", () => {
    const repositoryRoot = NodePath.resolve("/repo");
    const input = parseSeededDesktopUpgradeSmokeArgs(
      [
        "--platform",
        "mac",
        "--arch",
        "arm64",
        "--bundle",
        "dmg",
        "--candidate-version",
        "0.3.11",
        "--previous-tag",
        "v0.3.10",
        "--previous-version",
        "0.3.10",
        "--public-key-file",
        absolute("keys", "updater.key.pub"),
        "--run-id",
        "run-17-mac-arm64",
        "--work-root",
        absolute("work"),
        "--artifact-dir",
        absolute("evidence"),
        "--updater-port",
        "4312",
        "--restart-timeout-ms",
        "90000",
      ],
      repositoryRoot,
    );

    expect(input).toEqual({
      arch: "arm64",
      artifactDirectory: absolute("evidence"),
      bundle: "dmg",
      candidateVersion: "0.3.11",
      platform: "mac",
      previousTag: "v0.3.10",
      previousVersion: "0.3.10",
      publicKeyFile: absolute("keys", "updater.key.pub"),
      repositoryRoot,
      restartTimeoutMs: 90_000,
      runId: "run-17-mac-arm64",
      updaterPort: 4_312,
      wsl: false,
      workRoot: absolute("work"),
    });
  });

  it("reserves the ordinary remote-install lane's highest port before any launch", () => {
    const base = [
      "--platform",
      "linux",
      "--arch",
      "x64",
      "--bundle",
      "appimage",
      "--candidate-version",
      "0.3.11",
      "--previous-tag",
      "v0.3.10",
      "--previous-version",
      "0.3.10",
      "--public-key-file",
      absolute("keys", "updater.key.pub"),
      "--run-id",
      "port-boundary",
      "--work-root",
      absolute("work"),
      "--artifact-dir",
      absolute("evidence"),
      "--updater-port",
      "65432",
    ];
    expect(parseSeededDesktopUpgradeSmokeArgs(base, "/repo").updaterPort).toBe(65_432);
    expect(() =>
      parseSeededDesktopUpgradeSmokeArgs(base.with(base.length - 1, "65433"), "/repo"),
    ).toThrow(/leave room/);
  });

  it("accepts WSL mode only for the supported Windows x64 target", () => {
    const base = [
      "--wsl",
      "--platform",
      "win",
      "--arch",
      "x64",
      "--bundle",
      "nsis",
      "--candidate-version",
      "0.3.11",
      "--previous-tag",
      "v0.3.10",
      "--previous-version",
      "0.3.10",
      "--public-key-file",
      absolute("keys", "updater.key.pub"),
      "--run-id",
      "run-17-win-wsl",
      "--work-root",
      absolute("work"),
      "--artifact-dir",
      absolute("evidence"),
    ];

    expect(parseSeededDesktopUpgradeSmokeArgs(base, "/repo").wsl).toBe(true);
    expect(() =>
      parseSeededDesktopUpgradeSmokeArgs(base.with(2, "mac").with(6, "dmg"), "/repo"),
    ).toThrow(/WSL.*Windows x64/);
  });

  it("accepts Windows ARM64 while rejecting relative roots and private-key arguments", () => {
    const base = [
      "--platform",
      "win",
      "--arch",
      "arm64",
      "--bundle",
      "nsis",
      "--candidate-version",
      "0.3.11",
      "--previous-tag",
      "v0.3.10",
      "--previous-version",
      "0.3.10",
      "--public-key-file",
      absolute("keys", "updater.key.pub"),
      "--run-id",
      "run-17-win-x64",
      "--work-root",
      absolute("work"),
      "--artifact-dir",
      absolute("evidence"),
    ];
    expect(parseSeededDesktopUpgradeSmokeArgs(base, "/repo").arch).toBe("arm64");
    expect(() =>
      parseSeededDesktopUpgradeSmokeArgs(
        base.with(3, "x64").with(base.indexOf(absolute("work")), "relative"),
        "/repo",
      ),
    ).toThrow(/absolute/);
    expect(() =>
      parseSeededDesktopUpgradeSmokeArgs(
        [...base.with(3, "x64"), "--private-key", "do-not-accept-secrets"],
        "/repo",
      ),
    ).toThrow(/private-key|Unknown option/);
  });

  it("maps Linux and Windows ARM64 to their native updater and Rust targets", () => {
    expect(updaterTargetFor("linux", "arm64")).toBe("linux-aarch64");
    expect(updaterTargetFor("win", "arm64")).toBe("windows-aarch64");
    expect(seededUpgradeRustTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(seededUpgradeRustTarget("win", "arm64")).toBe("aarch64-pc-windows-msvc");
    expect(seededUpgradeBundleRoot("/tmp/build", "win", "arm64")).toBe(
      NodePath.join("/tmp/build", "aarch64-pc-windows-msvc", "release", "bundle"),
    );
  });

  it("creates disjoint owned checkouts for candidate and both baselines", () => {
    const layout = createSeededUpgradeRunLayout(absolute("work"), "run-17");

    expect(layout.previousStable.dataRoot).toBe(absolute("work", "run-17", "previous", "data"));
    expect(layout.previousStable.buildRoot).toBe(absolute("work", "run-17", "previous", "build"));
    expect(layout.protectedBaseline.dataRoot).toBe(absolute("work", "run-17", "protected", "data"));
    expect(layout.previousStable.dataRoot).not.toBe(layout.protectedBaseline.dataRoot);
    expect(layout.previousStable.checkout).not.toBe(layout.protectedBaseline.checkout);
    expect(layout.candidateBuildRoot).toBe(absolute("work", "run-17", "candidate-build"));
    expect(layout.candidateCheckout).toBe(absolute("work", "run-17", "candidate-checkout"));
    expect(layout.candidateCheckout).not.toBe(layout.previousStable.checkout);
    expect(layout.candidateCheckout).not.toBe(layout.protectedBaseline.checkout);
    expect(layout.updaterRoot).toBe(absolute("work", "run-17", "updater"));
  });

  it("pins real checkout manifests and lock entries for every build without changing the caller", async () => {
    const fixture = await versionFixture();
    try {
      for (const [name, version] of [
        ["candidate", "9.9.9-upgrade.1"],
        ["previous", "1.2.3"],
        ["protected", "1.2.3"],
      ] as const) {
        const input = await fixture.checkout(name, version);
        await prepareSeededUpgradeBuild(input);
        await expect(assertSeededUpgradeBuildVersion(input)).resolves.toBeUndefined();
        for (const relativePath of releasePackageFiles) {
          const manifest = JSON.parse(
            await NodeFS.promises.readFile(NodePath.join(input.checkout, relativePath), "utf8"),
          );
          expect(manifest.version).toBe(version);
        }
        for (const relativePath of releaseRustPackageFiles) {
          const manifest = parseToml(
            await NodeFS.promises.readFile(NodePath.join(input.checkout, relativePath), "utf8"),
          );
          expect((manifest.package as TomlTable).version).toBe(version);
        }
        const lock = parseToml(
          await NodeFS.promises.readFile(NodePath.join(input.checkout, "Cargo.lock"), "utf8"),
        );
        expect(
          (lock.package as TomlTable[])
            .filter((pkg) => ["bibcode-desktop", "bibcode-server"].includes(String(pkg.name)))
            .map((pkg) => [pkg.name, pkg.version]),
        ).toEqual([
          ["bibcode-desktop", version],
          ["bibcode-server", version],
        ]);
      }
      for (const [path, content] of fixture.originals) {
        expect(await NodeFS.promises.readFile(NodePath.join(repositoryRoot, path), "utf8")).toBe(
          content,
        );
      }
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses the calling checkout and its physical alias before rewriting versions", async () => {
    const fixture = await versionFixture();
    try {
      const input = await fixture.checkout("caller", "9.9.9-upgrade.1");
      const alias = NodePath.join(fixture.root, "caller-alias");
      await NodeFS.promises.symlink(input.checkout, alias, "junction");
      for (const checkout of [input.checkout, alias]) {
        await expect(
          prepareSeededUpgradeBuild({
            ...input,
            repositoryRoot: input.checkout,
            checkout,
          }),
        ).rejects.toThrow(/disposable checkout/);
      }
      for (const [path, content] of fixture.originals) {
        expect(await NodeFS.promises.readFile(NodePath.join(input.checkout, path), "utf8")).toBe(
          content,
        );
      }
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an overlay mismatch before preparing a build", async () => {
    const fixture = await versionFixture();
    try {
      const input = await fixture.checkout("candidate", "9.9.9-upgrade.1");
      await NodeFS.promises.writeFile(input.overlayPath, '{"version":"0.0.1"}');
      await expect(prepareSeededUpgradeBuild(input)).rejects.toThrow(/overlay version/);
      for (const [path, content] of fixture.originals) {
        expect(await NodeFS.promises.readFile(NodePath.join(input.checkout, path), "utf8")).toBe(
          content,
        );
      }
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when release metadata or overlay drifts after preparation", async () => {
    const fixture = await versionFixture();
    try {
      const input = await fixture.checkout("candidate", "9.9.9-upgrade.1");
      await prepareSeededUpgradeBuild(input);
      for (const path of [
        ...releaseVersionFiles.map((relativePath) => NodePath.join(input.checkout, relativePath)),
        input.overlayPath,
      ]) {
        const content = await NodeFS.promises.readFile(path, "utf8");
        await NodeFS.promises.writeFile(path, content.replaceAll(input.version, "0.0.1"));
        await expect(assertSeededUpgradeBuildVersion(input)).rejects.toThrow(/version/);
        await NodeFS.promises.writeFile(path, content);
      }
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("builds a deterministic public-key updater overlay without private key material", () => {
    const overlay = buildSeededUpgradeOverlay({
      endpoint: "http://127.0.0.1:4312/latest.json",
      identifier: "dev.bibcode.upgradesmoke.run-17",
      publicKey: "public-test-key",
      version: "0.3.11",
    });

    expect(overlay).toEqual({
      identifier: "dev.bibcode.upgradesmoke.run-17",
      version: "0.3.11",
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: {
          dangerousInsecureTransportProtocol: true,
          endpoints: ["http://127.0.0.1:4312/latest.json"],
          pubkey: "public-test-key",
        },
      },
    });
    expect(JSON.stringify(overlay)).not.toMatch(/private|password|signing/i);
  });

  it("requires every baseline package version to be strictly older than the candidate", () => {
    expect(() => assertBaselineVersionIsOlder("0.3.10", "0.3.11")).not.toThrow();
    expect(() => assertBaselineVersionIsOlder("0.3.11-beta.1", "0.3.11")).not.toThrow();
    expect(() => assertBaselineVersionIsOlder("0.3.11", "0.3.11")).toThrow(/strictly older/);
    expect(() => assertBaselineVersionIsOlder("0.4.0", "0.3.11")).toThrow(/strictly older/);
  });

  it("accepts nullable old identity only in the previous-stable compatibility lane", () => {
    const before = {
      appVersion: "0.3.10",
      effectiveRoot: absolute("work", "data"),
      projectId: "project-seeded",
      projectIds: ["project-seeded"],
      storageInstanceId: null,
    } as const;
    const after = {
      appVersion: "0.3.11",
      effectiveRoot: absolute("work", "data"),
      projectIds: ["project-seeded"],
      storageInstanceId: "8a8c318a-e2c3-4f78-a61c-3ba53b0a10af",
      preUpdateBackups: [],
    } as const;

    expect(() =>
      verifySeededUpgradeOutcome("previous-stable", before, after, "0.3.11"),
    ).not.toThrow();
    expect(() => verifySeededUpgradeOutcome("protected-baseline", before, after, "0.3.11")).toThrow(
      /baseline storage identity/,
    );
    expect(() =>
      verifySeededUpgradeOutcome(
        "previous-stable",
        before,
        { ...after, appVersion: "0.3.10" },
        "0.3.11",
      ),
    ).toThrow(/candidate application version/);
  });

  it("requires protected identity, project, effective root, and pre-update backup continuity", () => {
    const storageInstanceId = "8a8c318a-e2c3-4f78-a61c-3ba53b0a10af";
    const before = {
      appVersion: "0.3.10",
      effectiveRoot: absolute("work", "data"),
      projectId: "project-seeded",
      projectIds: ["project-seeded"],
      storageInstanceId,
    } as const;
    const after = {
      appVersion: "0.3.11",
      effectiveRoot: before.effectiveRoot,
      projectIds: ["project-seeded"],
      storageInstanceId,
      preUpdateBackups: [{ storageInstanceId, trigger: "pre-update" }],
    } as const;

    expect(() =>
      verifySeededUpgradeOutcome("protected-baseline", before, after, "0.3.11"),
    ).not.toThrow();
    expect(() =>
      verifySeededUpgradeOutcome(
        "protected-baseline",
        before,
        {
          ...after,
          storageInstanceId: "d0ac2738-e32b-4d7b-87bc-6ada325ee42e",
        },
        "0.3.11",
      ),
    ).toThrow(/storage identity changed/);
    expect(() =>
      verifySeededUpgradeOutcome(
        "protected-baseline",
        before,
        {
          ...after,
          projectIds: [],
        },
        "0.3.11",
      ),
    ).toThrow(/seeded project/);
    expect(() =>
      verifySeededUpgradeOutcome(
        "protected-baseline",
        before,
        {
          ...after,
          preUpdateBackups: [],
        },
        "0.3.11",
      ),
    ).toThrow(/pre-update backup/);
  });

  it("polls readiness and restart conditions under a deterministic timeout", async () => {
    let now = 0;
    let attempts = 0;
    await expect(
      waitForUpgradeCondition({
        description: "updater readiness",
        intervalMs: 10,
        now: () => now,
        probe: async () => ++attempts === 3,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 50,
      }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);

    await expect(
      waitForUpgradeCondition({
        description: "candidate restart",
        intervalMs: 10,
        now: () => now,
        probe: async () => false,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/candidate restart.*20ms/);
  });

  it("accepts a nonzero seed phase only after the updater install was issued", () => {
    expect(() =>
      assertWebDriverPhaseExit({
        exitCode: 1,
        installAttempted: false,
        lane: "previous-stable",
        phase: "seed-and-install",
      }),
    ).toThrow(/WebDriver phase exited/);
    expect(() =>
      assertWebDriverPhaseExit({
        exitCode: 1,
        installAttempted: true,
        lane: "previous-stable",
        phase: "seed-and-install",
      }),
    ).not.toThrow();
    expect(() =>
      assertWebDriverPhaseExit({
        exitCode: 1,
        installAttempted: true,
        lane: "previous-stable",
        phase: "verify",
      }),
    ).toThrow(/WebDriver phase exited/);
  });

  it("cleans every started process in reverse order even when one cleanup fails", async () => {
    const calls: string[] = [];
    const registry = new ManagedProcessRegistry();
    registry.add("updater", async () => {
      calls.push("updater");
    });
    registry.add("baseline", async () => {
      calls.push("baseline");
      throw new Error("already exited");
    });
    registry.add("driver", async () => {
      calls.push("driver");
    });

    await expect(registry.cleanup()).rejects.toThrow(/baseline/);
    expect(calls).toEqual(["driver", "baseline", "updater"]);
    await expect(registry.cleanup()).resolves.toBeUndefined();
  });

  it("reaps a timed-out command before rejecting its caller", async () => {
    const root = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bibcode-command-"));
    const pidPath = NodePath.join(root, "pid.txt");
    try {
      const command = process.execPath;
      await expect(
        runBoundedCommand({
          command,
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
          ],
          cwd: root,
          // Node startup can be delayed while the full release graph is
          // compiling Rust targets. Give the child time to publish its PID;
          // runBoundedCommand still owns the timeout and reap assertion.
          timeoutMs: 2_000,
        }),
      ).rejects.toThrow(/timed out/);

      const pid = Number(await NodeFS.promises.readFile(pidPath, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["raw", "truncated", "json", "slash-escaped", "unicode-slash", "encoded-token"] as const)(
    "redacts %s signed transfer labels before evidence bounds",
    (kind) => {
      const capability = "capability-prefix-" + "private".repeat(60);
      const full = "HTTP POST /api/transfers/" + capability;
      const truncated = full.slice(0, 159) + "…";
      const label =
        kind === "raw"
          ? full
          : kind === "json"
            ? JSON.stringify({ operation: truncated })
            : kind === "slash-escaped"
              ? truncated.replaceAll("/", "\\/")
              : kind === "unicode-slash"
                ? truncated.replaceAll("/", "\\u002f")
                : kind === "encoded-token"
                  ? truncated.replace("capability", "\\u0063apability")
                  : truncated;
      const evidence = redactAndBoundUpgradeEvidence(label, {
        maxBytes: 512,
        roots: [],
        secrets: [capability],
      });
      expect(evidence).not.toContain("capability-prefix");
      expect(evidence).not.toContain("privateprivate");
      expect(evidence).toContain("[REDACTED]");
    },
  );

  it("redacts secrets and roots before bounding retained failure evidence", () => {
    const privateKey = "PRIVATE-TEST-KEY-MATERIAL";
    const root = absolute("work", "run-17", "protected", "data");
    const evidence = redactAndBoundUpgradeEvidence(
      `token=bootstrap-secret\nkey=${privateKey}\nroot=${root}\n${"x".repeat(500)}`,
      {
        maxBytes: 140,
        roots: [root],
        secrets: ["bootstrap-secret", privateKey],
      },
    );

    expect(evidence).not.toContain("bootstrap-secret");
    expect(evidence).not.toContain(privateKey);
    expect(evidence).not.toContain(root);
    expect(evidence).toContain("[REDACTED]");
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(140);
  });

  it("builds a single-platform local manifest from the signed candidate payload", () => {
    expect(
      buildLocalUpdaterManifest({
        artifact: "BiBCode_0.3.11_x64-setup.exe",
        baseUrl: "http://127.0.0.1:4312/",
        candidateVersion: "0.3.11",
        signature: "encoded-minisign-signature",
        target: "windows-x86_64",
      }),
    ).toEqual({
      version: "0.3.11",
      notes: "BiBCode seeded packaged-upgrade smoke",
      pub_date: "2026-01-01T00:00:00Z",
      platforms: {
        "windows-x86_64": {
          signature: "encoded-minisign-signature",
          url: "http://127.0.0.1:4312/BiBCode_0.3.11_x64-setup.exe",
        },
      },
    });
  });

  it("generates public-boundary WebDriver phases without SQLite or direct store reads", () => {
    const seed = createSeededUpgradeDriverSpec({
      candidateVersion: "0.3.11",
      expectedDataRoot: absolute("work", "data"),
      lane: "protected-baseline",
      phase: "seed-and-install",
      projectId: "seeded-project",
      resultPath: absolute("work", "before.json"),
      workspaceRoot: absolute("work", "workspace"),
    });
    const verify = createSeededUpgradeDriverSpec({
      candidateVersion: "0.3.11",
      expectedDataRoot: absolute("work", "data"),
      lane: "protected-baseline",
      phase: "verify",
      projectId: "seeded-project",
      resultPath: absolute("work", "after.json"),
      workspaceRoot: absolute("work", "workspace"),
    });
    const combined = `${seed}\n${verify}`;

    expect(combined).toContain("The packaged desktop bridge did not become ready.");
    expect(combined).toContain("browser.waitUntil");
    expect(combined).toContain("getLocalEnvironmentBootstraps");
    expect(combined).toContain("getLocalEnvironmentBearerToken");
    expect(combined).toContain("/.well-known/bibcode/environment");
    expect(combined).toContain("orchestration.dispatchCommand");
    expect(combined).toContain("project.create");
    expect(combined).toContain("orchestration.subscribeShell");
    expect(combined).toContain("getProjectDataStatuses");
    expect(combined).toContain("getUpdateState");
    expect(seed).toContain("downloadUpdate");
    expect(seed).toContain("installUpdate");
    expect(seed.indexOf("checkForUpdate")).toBeLessThan(seed.indexOf("downloadUpdate"));
    expect(seed).toContain("installAttempted: true");
    expect(verify).not.toContain("downloadUpdate()");
    expect(combined).not.toMatch(/sqlite|state\.sqlite|better-sqlite|rusqlite/i);
  });

  it("switches to WSL-only through the desktop bridge and requires a running WSL primary", () => {
    const spec = createSeededUpgradeDriverSpec({
      candidateVersion: "0.3.11",
      expectedDataRoot: absolute("work", "data"),
      lane: "protected-baseline",
      phase: "seed-and-install",
      projectId: "seeded-wsl-project",
      resultPath: absolute("work", "before.json"),
      workspaceRoot: "/tmp/bibcode-seeded-wsl-project",
      wsl: true,
    });

    expect(spec).toContain("setWslOnly(true)");
    expect(spec).toContain("setWslBackendEnabled(true)");
    expect(spec).toContain("runningDistro");
    expect(spec).toContain("getLocalEnvironmentBootstraps");
  });

  it("normalizes WebDriver requests for the embedded Tauri service", () => {
    const config = createSeededUpgradeWdioConfig({
      appBinaryPath: absolute("installed", "bibcode-desktop"),
      artifactDirectory: absolute("evidence"),
      restartTimeoutMs: 120_000,
      specPath: absolute("driver", "seeded-upgrade.e2e.ts"),
      webdriverPort: 44_450,
    });

    expect(config).toContain("transformRequest");
    expect(config).toContain('headers.delete("content-length")');
    expect(config).toContain("captureBackendLogs: true");
  });
});

it("retains the closed stream console record through the generated native frontend collector", () => {
  const generated = createSeededUpgradeWdioConfig({
    appBinaryPath: absolute("installed", "bibcode-desktop"),
    artifactDirectory: absolute("evidence"),
    restartTimeoutMs: 120_000,
    specPath: absolute("driver", "seeded-upgrade.e2e.ts"),
    webdriverPort: 44_450,
  });
  const config = NodeVM.runInNewContext(
    generated.replace("export const config =", "const config =") + "\nconfig",
    { Headers },
  );
  const resolve = NodeModule.createRequire(
    new URL("../apps/desktop/package.json", import.meta.url),
  );
  const source = NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(resolve.resolve("@wdio/tauri-service")), "../esm/index.js"),
    "utf8",
  );
  const realFunction = (name: string) => {
    const start = source.indexOf("function " + name + "(");
    const end = source.indexOf("\n}", start) + 2;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };
  const parserStart = source.indexOf("const FRONTEND_MARKER =");
  const parserEnd = source.indexOf("\n}", source.indexOf("function parseLogLine(")) + 2;
  const captureStart = source.indexOf("const TAURI_STARTUP_MARKERS$1 =");
  const captureEnd = source.indexOf("\n}", source.indexOf("function createLogCapture(")) + 2;
  const helpers =
    source.slice(parserStart, parserEnd) +
    "\n" +
    ["formatLogMessage", "transformPrefixedMessage", "forwardLog", "mergeOptions"]
      .map(realFunction)
      .join("\n") +
    "\n" +
    source.slice(captureStart, captureEnd) +
    "\n({mergeOptions,createLogCapture})";
  const retained: string[] = [];
  let onLine: ((line: string, instance?: string) => void) | undefined;
  const collector = NodeVM.runInNewContext(helpers, {
    createLogger: () => ({}),
    normaliseDriverProvider: (value: string) => value,
    shouldLog: (level: string, minimum: string) => level === "info" && minimum === "info",
    isLogWriterInitialized: () => true,
    getLogWriter: () => ({ write: (message: string) => retained.push(message) }),
    createLogCapture$1: (options: { onLine: (line: string, instance?: string) => void }) => {
      onLine = options.onLine;
      return { close() {} };
    },
  });
  const options = collector.mergeOptions(config.services[0][1], undefined);
  const facts = {
    method: "orchestration.subscribeShell",
    requestCount: 1,
    chunkCount: 0,
    timeout: true,
  };
  const message = "seeded-upgrade-stream-observation " + JSON.stringify(facts);
  collector.createLogCapture({ stream: {}, identifier: "inert", options });
  onLine!("[WDIO-FRONTEND][INFO] " + message);
  expect(retained).toEqual(["[Tauri:Frontend] " + message]);
  expect(JSON.parse(retained[0]!.slice(retained[0]!.indexOf("{")))).toEqual(facts);
  expect(options.captureBackendLogs).toBe(true);
  expect(options.captureFrontendLogs).toBe(true);
  expect(config.outputDir).toBe(absolute("evidence"));
  expect(options.logDir).toBe(config.outputDir);
  expect(config.connectionRetryCount).toBe(0);
  expect(options.commandTimeout).toBe(30_000);
  retained.length = 0;
  collector.createLogCapture({
    stream: {},
    identifier: "inert",
    options: { ...options, captureFrontendLogs: false },
  });
  onLine!("[WDIO-FRONTEND][INFO] " + message);
  expect(retained).toEqual([]);
});

/** Execute the actual generated install segment through inert bridge/file/timer ports. */
function installResultFixture(
  options: {
    lane?: "previous-stable" | "protected-baseline";
    result?: unknown;
    mode?: "returned" | "never" | "protecting" | "disconnect" | "reject";
    error?: Error;
    preparationStates?: unknown[];
    installStates?: unknown[];
  } = {},
) {
  const input = {
    candidateVersion: "0.7.3",
    expectedDataRoot: absolute("install-result", "data"),
    lane: options.lane ?? "previous-stable",
    phase: "seed-and-install" as const,
    projectId: "install-result-project",
    resultPath: absolute("install-result", "before.json"),
    workspaceRoot: absolute("install-result", "workspace"),
    platform: "win" as const,
  };
  const spec = createSeededUpgradeDriverSpec(input);
  const start = spec.indexOf("    const preparation = await browser.executeAsync");
  const end = spec.indexOf("\n  });\n});", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const files = new Map([[input.resultPath, JSON.stringify({ baseline: true })]]);
  const writes: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const timers: number[] = [];
  const listeners: Array<(state: unknown) => void> = [];
  const emit = (state: unknown) => listeners.forEach((listener) => listener(state));
  let returnInstall!: (value: unknown) => void;
  const deferred = new Promise((resolve) => {
    returnInstall = resolve;
  });
  let executions = 0;
  const failure = options.error ?? new Error("inert existing bridge failure");
  const run = NodeVM.runInNewContext(
    "async function run(){\n" + spec.slice(start, end) + "\n}\nrun",
    {
      input,
      Date,
      setTimeout: (callback: () => void, delay: number) => {
        timers.push(delay);
        // @effect-diagnostics-next-line globalTimers:off - Generated callbacks use the controlled Vitest clock.
        return setTimeout(callback, delay);
      },
      NodeFS: {
        readFileSync: (path: string) => files.get(path),
        writeFileSync: (path: string, contents: string) => {
          expect(path).toBe(input.resultPath);
          files.set(path, contents);
          writes.push(JSON.parse(contents));
        },
      },
      window: {
        desktopBridge: {
          onUpdateState: (listener: (state: unknown) => void) => {
            calls.push("listener");
            listeners.push(listener);
            return () => {};
          },
          checkForUpdate: async () => {
            calls.push("check");
            for (const state of options.preparationStates ?? [
              { phase: "checking" },
              { phase: "available" },
            ])
              emit(state);
            return { state: { status: "available", availableVersion: input.candidateVersion } };
          },
          downloadUpdate: async () => {
            calls.push("download");
            return { completed: true, state: { downloadedVersion: input.candidateVersion } };
          },
          installUpdate: async () => {
            calls.push("install");
            for (const state of options.installStates ?? []) emit(state);
            if (options.mode === "protecting") {
              emit({ phase: "protecting" });
              return deferred;
            }
            if (options.mode === "never" || options.mode === "disconnect") return deferred;
            if (options.mode === "reject") throw failure;
            return (
              options.result ?? {
                accepted: true,
                completed: true,
                state: { status: "downloaded", phase: "installing", errorContext: null },
              }
            );
          },
        },
      },
      browser: {
        executeAsync: (
          callback: (argument: string, done: (value: unknown) => void) => void,
          argument: string,
        ) => {
          const execution = ++executions;
          return new Promise((resolve, reject) => {
            try {
              callback(argument, (value) => resolve(JSON.parse(JSON.stringify(value))));
            } catch (error) {
              reject(error);
            }
            if (execution === 2 && options.mode === "disconnect")
              queueMicrotask(() => reject(failure));
          });
        },
      },
    },
  ) as () => Promise<void>;
  const result = run();
  void result.catch(() => {});
  return {
    run: result,
    calls,
    writes,
    timers,
    returnInstall,
    read: () => JSON.parse(files.get(input.resultPath)!) as Record<string, unknown>,
  };
}

describe("generated public install-result observation", () => {
  afterEach(() => vi.useRealTimers());
  it("retains the already-returned refused public install result without changing its verdict", async () => {
    vi.useFakeTimers();
    const fixture = installResultFixture({
      result: {
        accepted: false,
        completed: false,
        state: {
          status: "error",
          phase: "failed",
          errorContext: "install",
          message: "private-native-message",
          environmentId: "private-id",
        },
      },
      installStates: [{ phase: "protecting" }, { phase: "failed" }],
    });
    await expect(fixture.run).rejects.toThrow("install did not complete");
    expect(fixture.read().installResultObservation).toEqual({
      kind: "returned",
      accepted: false,
      completed: false,
      status: "error",
      phase: "failed",
      errorContext: "install",
    });
    expect(fixture.calls).toEqual(["listener", "check", "download", "listener", "install"]);
    expect(fixture.read().installAttempted).toBe(false);
    expect(fixture.read().phases).toEqual(["checking", "available", "protecting", "failed"]);
    expect(JSON.stringify(fixture.writes)).not.toContain("private-");
  });

  it("records accepted completed=false separately from the unchanged install failure", async () => {
    vi.useFakeTimers();
    const fixture = installResultFixture({
      result: {
        accepted: true,
        completed: false,
        state: { status: "downloaded", phase: "protecting", errorContext: null },
      },
    });
    await expect(fixture.run).rejects.toThrow("install did not complete");
    expect(fixture.read().installResultObservation).toEqual({
      kind: "returned",
      accepted: true,
      completed: false,
      status: "downloaded",
      phase: "protecting",
      errorContext: null,
    });
    expect(fixture.timers).toEqual([30000]);
    expect(fixture.writes).toHaveLength(2);
  });

  it.each([false, true])(
    "does not turn the observed accepted=%s flag into a new completion predicate",
    async (accepted) => {
      vi.useFakeTimers();
      const fixture = installResultFixture({
        result: {
          accepted,
          completed: true,
          state: { status: "downloaded", phase: "installing", errorContext: null },
        },
      });
      await vi.advanceTimersByTimeAsync(30750);
      await fixture.run;
      expect(fixture.read().installAttempted).toBe(true);
      expect(fixture.read().installResultObservation).toEqual({
        kind: "returned",
        accepted,
        completed: true,
        status: "downloaded",
        phase: "installing",
        errorContext: null,
      });
      expect(fixture.timers).toEqual([30000, 750, 30000]);
      expect(fixture.calls).toEqual(["listener", "check", "download", "listener", "install"]);
      expect(fixture.writes).toHaveLength(2);
    },
  );

  it("keeps an early protecting finish unavailable even if the result arrives afterward", async () => {
    vi.useFakeTimers();
    const fixture = installResultFixture({ lane: "protected-baseline", mode: "protecting" });
    await vi.advanceTimersByTimeAsync(0);
    const expected = {
      kind: "unavailable",
      accepted: null,
      completed: null,
      status: null,
      phase: null,
      errorContext: null,
    };
    expect(fixture.read().installResultObservation).toEqual(expected);
    expect(fixture.read().phases).toEqual(["checking", "available", "protecting"]);
    fixture.returnInstall({
      accepted: true,
      completed: true,
      state: { status: "downloaded", phase: "installing", errorContext: null },
    });
    await vi.advanceTimersByTimeAsync(30000);
    await fixture.run;
    expect(fixture.read().installResultObservation).toEqual(expected);
    expect(fixture.read().installAttempted).toBe(true);
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.timers).toEqual([30000, 30000]);
    expect(fixture.calls).toEqual(["listener", "check", "download", "listener", "install"]);
  });

  it("persists unavailable before a never-returning install reaches the original timeout", async () => {
    vi.useFakeTimers();
    const fixture = installResultFixture({
      mode: "never",
      installStates: [{ phase: "installing" }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.read().installResultObservation).toEqual({
      kind: "unavailable",
      accepted: null,
      completed: null,
      status: null,
      phase: null,
      errorContext: null,
    });
    const rejected = expect(fixture.run).rejects.toThrow(
      "timed out observing updater installation",
    );
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(fixture.read().installAttempted).toBe(false);
    expect(fixture.read().installResultObservation).toMatchObject({
      kind: "unavailable",
      accepted: null,
      completed: null,
    });
    expect(fixture.read().phases).toEqual(["checking", "available", "installing"]);
    expect(fixture.calls).toEqual(["listener", "check", "download", "listener", "install"]);
    expect(fixture.timers).toEqual([30000]);
  });

  it("preserves a disconnect object and the pre-execution unavailable receipt", async () => {
    vi.useFakeTimers();
    const original = new Error("inert original driver disconnect");
    const fixture = installResultFixture({ mode: "disconnect", error: original });
    await expect(fixture.run).rejects.toBe(original);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.read().installResultObservation).toEqual({
      kind: "unavailable",
      accepted: null,
      completed: null,
      status: null,
      phase: null,
      errorContext: null,
    });
    expect(fixture.calls).toEqual(["listener", "check", "download", "listener", "install"]);
    expect(JSON.stringify(fixture.writes)).not.toContain("driver disconnect");
  });

  it("keeps the existing rejection-to-error outcome without serializing it into result facts", async () => {
    vi.useFakeTimers();
    const original = new Error("inert original bridge rejection");
    const fixture = installResultFixture({ mode: "reject", error: original });
    await expect(fixture.run).rejects.toThrow(String(original));
    expect(fixture.read().installResultObservation).toEqual({
      kind: "unavailable",
      accepted: null,
      completed: null,
      status: null,
      phase: null,
      errorContext: null,
    });
    expect(JSON.stringify(fixture.writes)).not.toContain("bridge rejection");
    expect(fixture.calls).toEqual(["listener", "check", "download", "listener", "install"]);
  });

  it("does not add completed-getter reads or change the existing completion exception outcome", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const original = new Error("private completion error");
    const result = {
      accepted: true,
      state: { status: "downloaded", phase: "failed", errorContext: "install" },
    };
    Object.defineProperty(result, "completed", {
      get() {
        reads++;
        throw original;
      },
    });
    const fixture = installResultFixture({ result });
    await expect(fixture.run).rejects.toThrow(String(original));
    expect(reads).toBe(1);
    expect(fixture.read().installResultObservation).toEqual({
      kind: "returned",
      accepted: true,
      completed: null,
      status: "downloaded",
      phase: "failed",
      errorContext: "install",
    });
    expect(JSON.stringify(fixture.writes)).not.toContain("private completion");
  });

  it("quarantines unknown enums, non-boolean flags and raw returned metadata", async () => {
    vi.useFakeTimers();
    const fixture = installResultFixture({
      result: {
        accepted: "private-accepted",
        completed: "private-completed",
        state: {
          status: "private-status",
          phase: "private-phase",
          errorContext: "private-context",
          message: "private-message",
          environmentId: "private-id",
          path: "/private/path",
          url: "http://private-host",
          arguments: ["private-argument"],
        },
      },
    });
    await expect(fixture.run).rejects.toThrow("install did not complete");
    expect(fixture.read().installResultObservation).toEqual({
      kind: "returned",
      accepted: null,
      completed: null,
      status: null,
      phase: null,
      errorContext: null,
    });
    expect(JSON.stringify(fixture.writes)).not.toMatch(/private|http:\/\/|arguments|environmentId/);
  });

  it.each([
    "accepted accessor",
    "state accessor",
    "state field accessors",
    "inherited",
    "reflection",
  ])("leaves %s facts unknown and does not execute diagnostic getters", async (mode) => {
    vi.useFakeTimers();
    let reads = 0;
    const getter = () => {
      reads++;
      throw new Error("private diagnostic getter");
    };
    let result: object = {
      accepted: true,
      completed: false,
      state: { status: "downloaded", phase: "failed", errorContext: "install" },
    };
    if (mode === "accepted accessor") Object.defineProperty(result, "accepted", { get: getter });
    else if (mode === "state accessor") Object.defineProperty(result, "state", { get: getter });
    else if (mode === "state field accessors") {
      const state = {};
      for (const key of ["status", "phase", "errorContext"])
        Object.defineProperty(state, key, { get: getter });
      Object.assign(result, { state });
    } else if (mode === "inherited")
      result = Object.assign(
        Object.create({
          accepted: true,
          state: { status: "downloaded", phase: "failed", errorContext: "install" },
        }),
        { completed: false },
      );
    else
      result = new Proxy(result, {
        getOwnPropertyDescriptor() {
          throw new Error("private reflection fault");
        },
      });
    const fixture = installResultFixture({ result });
    await expect(fixture.run).rejects.toThrow("install did not complete");
    const receipt = fixture.read().installResultObservation;
    expect(receipt).toEqual({
      kind: "returned",
      accepted: ["accepted accessor", "inherited", "reflection"].includes(mode) ? null : true,
      completed: mode === "reflection" ? null : false,
      status: mode === "accepted accessor" ? "downloaded" : null,
      phase: mode === "accepted accessor" ? "failed" : null,
      errorContext: mode === "accepted accessor" ? "install" : null,
    });
    expect(reads).toBe(0);
    expect(JSON.stringify(fixture.writes)).not.toContain("private");
  });

  it("collects only first-seen contract phases from the two existing listeners", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const accessor = Object.defineProperty({}, "phase", {
      get() {
        reads++;
        throw new Error("private phase getter");
      },
    });
    const reflection = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("private phase reflection");
        },
      },
    );
    const fixture = installResultFixture({
      result: { accepted: true, completed: false, state: {} },
      preparationStates: [
        { phase: "idle" },
        { phase: "checking" },
        { phase: "private-phase" },
        accessor,
        reflection,
        { phase: "checking" },
        { phase: "available" },
      ],
      installStates: [
        { phase: "protecting" },
        { phase: "installing" },
        { phase: "failed" },
        { phase: "failed" },
        { phase: "private-late" },
        accessor,
        reflection,
      ],
    });
    await expect(fixture.run).rejects.toThrow("install did not complete");
    expect(fixture.read().phases).toEqual([
      "idle",
      "checking",
      "available",
      "protecting",
      "installing",
      "failed",
    ]);
    expect(reads).toBe(0);
    expect(fixture.calls).toEqual(["listener", "check", "download", "listener", "install"]);
    expect(JSON.stringify(fixture.writes)).not.toContain("private");
  });
});

/** Actual phase and copier; only native command and optional receipt fault ports are inert. */
async function installObservationRetentionFixture(
  marker: unknown,
  options: {
    parsedMarker?: unknown;
    markerText?: string;
    markerMissing?: boolean;
    markerReadFault?: boolean;
    observationWriteFault?: boolean;
    commandError?: Error;
    exitCode?: number;
    platform?: "win" | "linux";
    phase?: "seed-and-install" | "verify";
    lane?: "previous-stable" | "protected-baseline";
  } = {},
) {
  const root = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "install-retention-"));
  const layout = createSeededUpgradeRunLayout(root, "owned");
  const lane =
    options.lane === "protected-baseline" ? layout.protectedBaseline : layout.previousStable;
  const runRoot = NodePath.dirname(lane.dataRoot);
  const resultPath = NodePath.join(runRoot, "before.json");
  const observationPath = NodePath.join(lane.evidenceDirectory, "install-result-observation.json");
  await NodeFS.promises.mkdir(lane.evidenceDirectory, { recursive: true, mode: 0o700 });
  if (!options.markerMissing)
    await NodeFS.promises.writeFile(resultPath, options.markerText ?? JSON.stringify(marker), {
      mode: 0o600,
    });
  const source = await NodeFS.promises.readFile(
    new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
    "utf8",
  );
  const slice = (start: string, end: string) => {
    const a = source.indexOf(start);
    const b = source.indexOf(end, a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    return source.slice(a, b);
  };
  const projectionStart = source.indexOf("const projectInstallResultObservation =");
  const projection =
    projectionStart < 0
      ? ""
      : slice("const updatePhases:", "export function createSeededUpgradeDriverSpec");
  const writes: Array<{ path: string; mode: number | undefined }> = [];
  let markerReads = 0;
  const runCommand = vi.fn(async (_command: Record<string, unknown>) => {
    if (options.commandError) throw options.commandError;
    return { exitCode: options.exitCode ?? 1, stdout: "fixed stdout", stderr: "fixed stderr" };
  });
  let verdictError: unknown;
  const verdict = vi.fn((input: Parameters<typeof assertWebDriverPhaseExit>[0]) => {
    try {
      assertWebDriverPhaseExit(input);
    } catch (error) {
      verdictError = error;
      throw error;
    }
  });
  const context = {
    NodeFS: {
      ...NodeFS,
      promises: {
        ...NodeFS.promises,
        readFile: async (path: string, encoding: "utf8") => {
          if (path === resultPath) {
            markerReads++;
            if (options.markerReadFault) throw new Error("private optional marker read fault");
          }
          return NodeFS.promises.readFile(path, encoding);
        },
        writeFile: async (path: string, body: string, configuration?: { mode?: number }) => {
          writes.push({ path, mode: configuration?.mode });
          if (path === observationPath && options.observationWriteFault)
            throw new Error("private optional observation write fault");
          return NodeFS.promises.writeFile(path, body, configuration);
        },
      },
    },
    NodePath,
    NodeURL,
    process: { env: {} },
    JSON: {
      stringify: JSON.stringify,
      parse: (text: string) =>
        Object.hasOwn(options, "parsedMarker") ? options.parsedMarker : JSON.parse(text),
    },
    Buffer,
    seededUpgradeVitePlusExecutable,
    seededUpgradePhaseTimeoutMs,
    createSeededUpgradeDriverSpec,
    createSeededUpgradeWdioConfig,
    readRemoteFixtureSecrets,
    redactAndBoundUpgradeEvidence,
    assertWebDriverPhaseExit: verdict,
    runCommand,
  };
  const code =
    projection +
    slice("const writePrivateJson =", "const findExactlyOne =") +
    slice("const runWebDriverPhase =", "const startMockUpdateServer =") +
    slice("const copyBoundedEvidence =", "export async function runSeededDesktopUpgradeSmoke") +
    "\n({runWebDriverPhase,copyBoundedEvidence})";
  const actual = NodeVM.runInNewContext(NodeModule.stripTypeScriptTypes(code), context, {
    timeout: 1_000,
  }) as {
    runWebDriverPhase: (input: Record<string, unknown>) => Promise<void>;
    copyBoundedEvidence: (input: Record<string, unknown>) => Promise<void>;
  };
  const input = {
    appBinaryPath: NodePath.join(root, "inert-app"),
    backendPort: 14953,
    candidateVersion: "0.7.3",
    dataRoot: lane.dataRoot,
    evidenceDirectory: lane.evidenceDirectory,
    expectedDataRoot: lane.dataRoot,
    lane: options.lane ?? "previous-stable",
    phase: options.phase ?? "seed-and-install",
    platform: options.platform ?? "win",
    projectId: "private-userdata-canary",
    repositoryRoot,
    restartTimeoutMs: 30_000,
    resultPath,
    runRoot,
    workspaceRoot: lane.workspaceRoot,
    webdriverPort: 15053,
    wsl: false,
  } as const;
  return {
    observationPath,
    resultPath,
    input,
    writes,
    markerReads: () => markerReads,
    runCommand,
    verdict,
    verdictError: () => verdictError,
    run: () => actual.runWebDriverPhase(input),
    copy: async () => {
      const artifactDirectory = NodePath.join(root, "retained");
      await actual.copyBoundedEvidence({
        artifactDirectory,
        layout,
        requestLogPath: NodePath.join(root, "absent-requests.jsonl"),
        secrets: [],
      });
      return artifactDirectory;
    },
    dispose: () => NodeFS.promises.rm(root, { recursive: true, force: true }),
  };
}

const unavailableInstallObservation = {
  kind: "unavailable",
  accepted: null,
  completed: null,
  status: null,
  phase: null,
  errorContext: null,
};
const refusedInstallObservation = {
  kind: "returned",
  accepted: false,
  completed: false,
  status: "error",
  phase: "failed",
  errorContext: "install",
};

describe("private install observation artifact retention", () => {
  it.each([
    { category: "returned refusal", observation: refusedInstallObservation, attempted: false },
    {
      category: "unavailable disconnect",
      observation: unavailableInstallObservation,
      attempted: true,
    },
  ])(
    "retains $category through the actual phase and failure copier",
    async ({ observation, attempted }) => {
      const fixture = await installObservationRetentionFixture({
        effectiveRoot: "private-userdata-canary",
        projectId: "private-userdata-canary",
        installAttempted: attempted,
        installResultObservation: observation,
        phases: ["checking", "available"],
      });
      try {
        if (attempted) await expect(fixture.run()).resolves.toBeUndefined();
        else await expect(fixture.run()).rejects.toBeInstanceOf(SeededDesktopUpgradeSmokeError);
        const artifact = await fixture.copy();
        const retainedPath = NodePath.join(
          artifact,
          "previous-stable-install-result-observation.json",
        );
        expect(NodeFS.existsSync(retainedPath)).toBe(true);
        const retained = await NodeFS.promises.readFile(retainedPath, "utf8");
        expect(JSON.parse(retained)).toEqual({
          installResultObservation: observation,
          phases: ["checking", "available"],
        });
        expect(retained).not.toContain("private-userdata-canary");
        expect(await NodeFS.promises.readFile(fixture.resultPath, "utf8")).toContain(
          "private-userdata-canary",
        );
        expect((await NodeFS.promises.stat(fixture.observationPath)).mode & 0o777).toBe(0o600);
        expect(fixture.markerReads()).toBe(1);
        expect(fixture.runCommand).toHaveBeenCalledOnce();
        expect(fixture.runCommand.mock.calls[0]?.[0]).toMatchObject({
          timeoutMs: seededUpgradePhaseTimeoutMs(fixture.input),
        });
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each([
    {
      category: "accepted incomplete",
      observation: { ...refusedInstallObservation, accepted: true },
    },
    {
      category: "returned null facts",
      observation: { ...unavailableInstallObservation, kind: "returned" },
    },
  ])("retains $category without interpreting it as success", async ({ observation }) => {
    const fixture = await installObservationRetentionFixture({
      installAttempted: false,
      installResultObservation: observation,
    });
    try {
      const error = await fixture.run().catch((error: unknown) => error);
      expect(error).toBe(fixture.verdictError());
      expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
      expect(JSON.parse(await NodeFS.promises.readFile(fixture.observationPath, "utf8"))).toEqual({
        installResultObservation: observation,
        phases: [],
      });
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    { category: "missing", observation: undefined },
    { category: "partial", observation: { kind: "returned", accepted: false } },
    {
      category: "unknown enum",
      observation: { ...refusedInstallObservation, status: "private-userdata-canary" },
    },
    {
      category: "nonboolean",
      observation: { ...refusedInstallObservation, accepted: "private-userdata-canary" },
    },
    {
      category: "unknown kind",
      observation: { ...refusedInstallObservation, kind: "private-userdata-canary" },
    },
    {
      category: "private extra field",
      observation: { ...refusedInstallObservation, message: "private-userdata-canary" },
    },
    {
      category: "oversized value",
      observation: { ...refusedInstallObservation, status: "private-userdata-canary".repeat(4096) },
    },
    {
      category: "unavailable with claims",
      observation: { ...refusedInstallObservation, kind: "unavailable" },
    },
  ])("quarantines $category facts", async ({ observation }) => {
    const fixture = await installObservationRetentionFixture({
      installAttempted: false,
      installResultObservation: observation,
      phases: ["checking", "private-userdata-canary", "checking", "available"],
    });
    try {
      const error = await fixture.run().catch((error: unknown) => error);
      expect(error).toBe(fixture.verdictError());
      const text = await NodeFS.promises.readFile(fixture.observationPath, "utf8");
      expect(JSON.parse(text)).toEqual({
        installResultObservation: unavailableInstallObservation,
        phases: ["checking", "available"],
      });
      expect(text).not.toContain("private-userdata-canary");
      expect(fixture.markerReads()).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });

  it.each(["accessor", "inherited", "reflection fault", "marker accessor"])(
    "quarantines %s without reading a property getter",
    async (category) => {
      let reads = 0;
      const getter = () => {
        reads++;
        throw new Error("private-userdata-canary");
      };
      let observation: unknown = { ...refusedInstallObservation };
      if (category === "accessor") Object.defineProperty(observation, "accepted", { get: getter });
      if (category === "inherited") observation = Object.create(refusedInstallObservation);
      if (category === "reflection fault")
        observation = new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("private-userdata-canary");
            },
          },
        );
      const marker = {
        installAttempted: false,
        installResultObservation: observation,
        phases: ["checking"],
      };
      if (category === "marker accessor")
        Object.defineProperty(marker, "installResultObservation", { get: getter });
      const fixture = await installObservationRetentionFixture(
        { installAttempted: false },
        { parsedMarker: marker },
      );
      try {
        const error = await fixture.run().catch((error: unknown) => error);
        expect(error).toBe(fixture.verdictError());
        expect(JSON.parse(await NodeFS.promises.readFile(fixture.observationPath, "utf8"))).toEqual(
          { installResultObservation: unavailableInstallObservation, phases: ["checking"] },
        );
        expect(reads).toBe(0);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("bounds and deduplicates own phase entries without invoking accessors", async () => {
    let reads = 0;
    const phases = ["checking", "available", "checking", "failed"];
    Object.defineProperty(phases, "1", {
      get() {
        reads++;
        throw new Error("private-userdata-canary");
      },
    });
    const fixture = await installObservationRetentionFixture(
      { installAttempted: false },
      {
        parsedMarker: {
          installAttempted: false,
          installResultObservation: refusedInstallObservation,
          phases,
        },
      },
    );
    try {
      await fixture.run().catch(() => undefined);
      expect(JSON.parse(await NodeFS.promises.readFile(fixture.observationPath, "utf8"))).toEqual({
        installResultObservation: refusedInstallObservation,
        phases: ["checking", "failed"],
      });
      expect(reads).toBe(0);
    } finally {
      await fixture.dispose();
    }
    const oversized = await installObservationRetentionFixture({
      installAttempted: false,
      installResultObservation: refusedInstallObservation,
      phases: Array(13).fill("checking"),
    });
    try {
      await oversized.run().catch(() => undefined);
      expect(JSON.parse(await NodeFS.promises.readFile(oversized.observationPath, "utf8"))).toEqual(
        { installResultObservation: refusedInstallObservation, phases: [] },
      );
    } finally {
      await oversized.dispose();
    }
  });

  it.each([
    { category: "missing marker", configuration: { markerMissing: true } },
    { category: "unreadable marker", configuration: { markerReadFault: true } },
    { category: "invalid JSON", configuration: { markerText: "private-userdata-canary" } },
  ])(
    "retains unavailable for $category with the unchanged phase failure",
    async ({ configuration }) => {
      const fixture = await installObservationRetentionFixture(
        { installAttempted: true },
        configuration,
      );
      try {
        const error = await fixture.run().catch((error: unknown) => error);
        expect(error).toBe(fixture.verdictError());
        expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
        expect(JSON.parse(await NodeFS.promises.readFile(fixture.observationPath, "utf8"))).toEqual(
          { installResultObservation: unavailableInstallObservation, phases: [] },
        );
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each([false, true])(
    "observation write failure preserves original attempted=%s phase verdict",
    async (attempted) => {
      const fixture = await installObservationRetentionFixture(
        { installAttempted: attempted, installResultObservation: refusedInstallObservation },
        { observationWriteFault: true },
      );
      try {
        const error = await fixture.run().catch((error: unknown) => error);
        if (attempted) expect(error).toBeUndefined();
        else {
          expect(error).toBe(fixture.verdictError());
          expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
        }
        expect(fixture.verdict).toHaveBeenCalledExactlyOnceWith({
          exitCode: 1,
          installAttempted: attempted,
          lane: "previous-stable",
          phase: "seed-and-install",
        });
        expect(NodeFS.existsSync(fixture.observationPath)).toBe(false);
        expect(fixture.runCommand).toHaveBeenCalledOnce();
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("preserves an original command exception before optional retention", async () => {
    const original = new Error("private-userdata-canary");
    const fixture = await installObservationRetentionFixture(
      { installAttempted: true },
      { commandError: original },
    );
    try {
      await expect(fixture.run()).rejects.toBe(original);
      expect(fixture.markerReads()).toBe(0);
      expect(fixture.verdict).not.toHaveBeenCalled();
      expect(NodeFS.existsSync(fixture.observationPath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it("retains the protected local receipt but does not replace it during verify or other-platform phases", async () => {
    const marker = {
      installAttempted: true,
      installResultObservation: unavailableInstallObservation,
      phases: ["protecting"],
    };
    const protectedLane = await installObservationRetentionFixture(marker, {
      lane: "protected-baseline",
    });
    try {
      await protectedLane.run();
      const artifact = await protectedLane.copy();
      expect(
        NodeFS.existsSync(
          NodePath.join(artifact, "protected-baseline-install-result-observation.json"),
        ),
      ).toBe(true);
    } finally {
      await protectedLane.dispose();
    }
    for (const configuration of [
      { phase: "verify" as const, exitCode: 0 },
      { platform: "linux" as const, exitCode: 0 },
    ]) {
      const fixture = await installObservationRetentionFixture(marker, configuration);
      try {
        const original = JSON.stringify({
          installResultObservation: refusedInstallObservation,
          phases: ["failed"],
        });
        await NodeFS.promises.writeFile(fixture.observationPath, original, { mode: 0o600 });
        await fixture.run();
        expect(await NodeFS.promises.readFile(fixture.observationPath, "utf8")).toBe(original);
        expect(fixture.writes.filter((write) => write.path === fixture.observationPath)).toEqual(
          [],
        );
      } finally {
        await fixture.dispose();
      }
    }
  });
});
