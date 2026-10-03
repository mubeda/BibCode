// @effect-diagnostics nodeBuiltinImport:off - The packaged-upgrade harness owns host paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import { AuthPairingLink } from "@bibcode/contracts";
import { parse as parseToml, type TomlTable } from "smol-toml";
import * as YAML from "yaml";
import * as SeededUpgradeHarness from "./seeded-desktop-upgrade-smoke.ts";
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

/** Execute the generated browser callback with inert transport and native bridge ports. */
const generatedObserverFixture = async (
  options: {
    executeFailure?: boolean;
    seed?: boolean;
    openEvent?: "close" | "error" | "timeout";
    sendFailure?: "Request" | "Interrupt" | "ShellRequest";
    runIt?: boolean;
  } = {},
) => {
  const input = {
    candidateVersion: "0.7.3-upgrade.1",
    expectedDataRoot: "/owned/data",
    lane: "remote-install" as const,
    phase: "verify" as const,
    projectId: "private-project-sentinel",
    resultPath: "/owned/after.json",
    observerDiagnosticPath: "/owned/verify-observer.json",
    workspaceRoot: "/owned/workspace",
  };
  const spec = createSeededUpgradeDriverSpec(input);
  const end = spec.indexOf('describe("seeded packaged upgrade');
  if (end < 0) throw new Error("Generated observer source missing");
  const writes = new Map<string, unknown>();
  const timers = new Map<() => void, number>();
  const timerBudgets: number[] = [];
  let now = 0;
  const status = vi.fn(async () => []);
  type Callback = (event: Record<string, unknown>) => void;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    protocol = "";
    listeners = new Map<string, Map<Callback, boolean>>();
    retired: Callback[] = [];
    sent: Record<string, unknown>[] = [];
    closes = 0;
    handlerErrors = 0;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        if (options.openEvent === "timeout") return;
        if (options.openEvent) {
          this.emit(options.openEvent, {
            code: 1006,
            wasClean: false,
            reason: "private-open-sentinel",
          });
          return;
        }
        this.readyState = 1;
        this.emit("open", {});
      });
    }
    addEventListener(type: string, callback: Callback, options?: { once?: boolean }) {
      const listeners = this.listeners.get(type) ?? new Map<Callback, boolean>();
      listeners.set(callback, options?.once === true);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, callback: Callback) {
      if (this.listeners.get(type)?.delete(callback)) this.retired.push(callback);
    }
    emit(type: string, event: Record<string, unknown>) {
      for (const [callback, once] of Array.from(this.listeners.get(type) ?? [])) {
        if (once) this.removeEventListener(type, callback);
        try {
          callback(event);
        } catch {
          this.handlerErrors += 1;
        }
      }
    }
    send(data: string) {
      const frame = JSON.parse(data) as Record<string, unknown>;
      if (
        frame._tag === options.sendFailure ||
        (options.sendFailure === "ShellRequest" && frame.tag === "orchestration.subscribeShell")
      )
        throw new Error("private-send-sentinel");
      this.sent.push(frame);
    }
    close() {
      this.closes += 1;
      this.readyState = 3;
      this.emit("close", { code: 1000, wasClean: true, reason: "private-close-sentinel" });
    }
  }
  const sockets: Socket[] = [];
  let runRegistered: (() => Promise<unknown>) | undefined;
  const run = NodeVM.runInNewContext(
    spec.replace('import * as NodeFS from "node:fs";', "") + "\nobserve",
    {
      describe: (_name: string, body: () => void) => body(),
      it: (_name: string, body: () => Promise<unknown>) => {
        runRegistered = body;
      },
      NodeFS: {
        writeFileSync: (path: string, value: string) => writes.set(path, JSON.parse(value)),
      },
      window: {
        desktopBridge: {
          getLocalEnvironmentBootstraps: () => [
            {
              id: "primary",
              httpBaseUrl: "http://private.invalid",
              wsBaseUrl: "ws://private.invalid",
            },
          ],
          getLocalEnvironmentBearerToken: async () => "private-bearer-sentinel",
          getProjectDataStatuses: status,
          getUpdateState: async () => ({ currentVersion: input.candidateVersion }),
        },
      },
      browser: {
        waitUntil: async (probe: () => Promise<boolean>) => expect(await probe()).toBe(true),
        execute: async (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          if (options.executeFailure) throw new Error("private-execute-sentinel");
          return callback(...args);
        },
      },
      fetch: async (url: URL) => ({
        ok: true,
        json: async () =>
          url.pathname.endsWith("environment")
            ? { storageInstanceId: "private-store-sentinel", serverVersion: input.candidateVersion }
            : { ticket: "private-ticket-sentinel" },
      }),
      URL,
      WebSocket: Socket,
      performance: { now: () => now },
      Date,
      setTimeout: (callback: () => void, milliseconds: number) => {
        timers.set(callback, now + milliseconds);
        timerBudgets.push(milliseconds);
        return callback;
      },
      clearTimeout: (callback: () => void) => timers.delete(callback),
    },
    { timeout: 1000 },
  ) as (seed: boolean) => Promise<unknown>;
  let settled = false;
  const execution = options.runIt ? runRegistered?.() : run(options.seed === true);
  if (!execution) throw new Error("Generated verification body missing");
  const outcome = execution.then(
    (value) => {
      settled = true;
      return { success: true, value };
    },
    (error: unknown) => {
      settled = true;
      return { success: false, value: String(error) };
    },
  );
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
  return {
    input,
    writes,
    timers,
    timerBudgets,
    sockets,
    status,
    outcome,
    flush,
    isSettled: () => settled,
    expire: async () => {
      now += 15_000;
      for (const [callback, at] of Array.from(timers)) {
        if (at <= now) {
          timers.delete(callback);
          callback();
        }
      }
      await flush();
    },
  };
};

describe("generated observer terminal diagnostics", () => {
  it("keeps the temporary Mac ARM trial on all three ordinary lanes and mandatory gates", async () => {
    const workflow = YAML.parse(
      await NodeFS.promises.readFile(
        new URL("../.github/workflows/qualify-mac-upgrade.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(workflow.on).toEqual({
      push: { branches: ["codex/qualify-mac-upgrade"] },
      workflow_dispatch: null,
    });
    expect(Object.keys(workflow.jobs)).toEqual(["mac_upgrade_observer"]);
    const job = workflow.jobs.mac_upgrade_observer;
    expect(job["runs-on"]).toBe("macos-26");
    expect(job["timeout-minutes"]).toBe(240);
    const steps = job.steps as {
      name: string;
      run?: string;
      if?: string;
      with?: Record<string, unknown>;
    }[];
    const trial = steps.findIndex(
      (step) =>
        step.name === "Run previous-stable, protected-baseline, and remote-install upgrades",
    );
    expect(trial).toBeGreaterThan(0);
    for (const name of [
      "Install frozen dependencies",
      "Check source formatting and lint",
      "Test observer, held-upload and lane ownership",
      "Build web assets",
      "Typecheck full workspace",
      "Check Rust formatting",
      "Test native bridge contract",
      "Test update coordinator",
      "Test real HTTP maintenance admission",
      "Recompute affected Clippy diagnostics",
    ]) {
      const index = steps.findIndex((step) => step.name === name);
      expect(index, name).toBeGreaterThanOrEqual(0);
      expect(index, name).toBeLessThan(trial);
    }
    expect(steps[trial]!.run).toContain("--platform mac");
    expect(steps[trial]!.run).toContain("--arch arm64");
    expect(steps[trial]!.run).toContain("--bundle dmg");
    expect(steps[trial]!.run).toContain("--restart-timeout-ms 180000");
    expect(steps[trial]!.run).not.toMatch(/--previous-stable-trigger|--wsl/);
    expect(steps.at(-1)).toMatchObject({
      if: "always()",
      with: {
        path: "${{ runner.temp }}/bibcode-mac-upgrade-observer/evidence/*",
        "if-no-files-found": "error",
        "retention-days": 7,
      },
    });
  });

  it.each([
    "stream-failure",
    "stream-eof",
    "defect",
    "protocol-error",
    "socket-close",
    "socket-error",
    "malformed-text",
    "binary-frame",
    "unknown-frame",
  ] as const)("settles %s immediately with closed evidence and cleanup", async (scenario) => {
    const fixture = await generatedObserverFixture();
    const socket = fixture.sockets[0]!;
    const id = socket.sent.find((frame) => frame._tag === "Request")?.id;
    const frames = {
      "stream-failure": {
        _tag: "Exit",
        requestId: id,
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: {
                _tag: "OrchestrationGetSnapshotError",
                message: "private-payload-sentinel",
                cause: "private-cause-sentinel",
              },
            },
          ],
        },
      },
      "stream-eof": { _tag: "Exit", requestId: id, exit: { _tag: "Success" } },
      defect: { _tag: "Defect", defect: "private-cause-sentinel" },
      "protocol-error": { _tag: "ClientProtocolError", error: "private-payload-sentinel" },
      "unknown-frame": { _tag: "private-tag-sentinel", requestId: id },
    };
    if (scenario === "socket-close")
      socket.emit("close", { code: 1006, wasClean: false, reason: "private-close-sentinel" });
    else if (scenario === "socket-error")
      socket.emit("error", { message: "private-error-sentinel" });
    else if (scenario === "malformed-text")
      socket.emit("message", { data: "private-invalid-json" });
    else if (scenario === "binary-frame") socket.emit("message", { data: new Uint8Array([1, 2]) });
    else socket.emit("message", { data: JSON.stringify(frames[scenario]) });
    await fixture.flush();
    const immediate = fixture.isSettled();
    if (!immediate) await fixture.expire();
    const result = await fixture.outcome;
    expect(immediate).toBe(true);
    expect(result.success).toBe(false);
    const diagnostic = fixture.writes.get(fixture.input.observerDiagnosticPath);
    expect(diagnostic).toMatchObject({ version: 1, available: true, outcome: scenario });
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
    expect(String(result.value)).not.toContain("private-");
    expect(fixture.writes.has(fixture.input.resultPath)).toBe(false);
    expect(fixture.status).not.toHaveBeenCalled();
    expect(fixture.timers.size).toBe(0);
    expect(socket.closes).toBe(1);
    expect(socket.handlerErrors).toBe(0);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    const saved = JSON.stringify(diagnostic);
    for (const callback of socket.retired) callback({ data: "private-late-sentinel", code: 4001 });
    expect(JSON.stringify(fixture.writes.get(fixture.input.observerDiagnosticPath))).toBe(saved);
    expect(socket.sent.filter((frame) => frame._tag === "Request")).toHaveLength(1);
  });

  it("keeps the real first snapshot, sends one Interrupt and closes", async () => {
    const fixture = await generatedObserverFixture();
    const socket = fixture.sockets[0]!;
    const id = socket.sent[0]!.id;
    socket.emit("message", {
      data: JSON.stringify({
        _tag: "Chunk",
        requestId: id,
        values: [{ kind: "snapshot", snapshot: { projects: [{ id: fixture.input.projectId }] } }],
      }),
    });
    const result = await fixture.outcome;
    expect(result.success).toBe(true);
    expect(result.value).toMatchObject({
      appVersion: fixture.input.candidateVersion,
      projectIds: [fixture.input.projectId],
      storageInstanceId: "private-store-sentinel",
    });
    expect(socket.sent.filter((frame) => frame._tag === "Interrupt")).toHaveLength(1);
    expect(socket.closes).toBe(1);
    expect(fixture.timers.size).toBe(0);
    expect(fixture.writes.get(fixture.input.observerDiagnosticPath)).toMatchObject({
      outcome: "success",
      available: true,
    });
  });

  it("keeps the real 15s timeout and counts unmatched frames without retaining their IDs", async () => {
    const fixture = await generatedObserverFixture();
    const socket = fixture.sockets[0]!;
    socket.emit("message", {
      data: JSON.stringify({
        _tag: "Exit",
        requestId: "private-other-id",
        exit: { _tag: "Success" },
      }),
    });
    await fixture.flush();
    expect(fixture.isSettled()).toBe(false);
    await fixture.expire();
    expect((await fixture.outcome).success).toBe(false);
    expect(fixture.timerBudgets).toEqual([15000, 15000]);
    expect(fixture.writes.get(fixture.input.observerDiagnosticPath)).toMatchObject({
      outcome: "request-timeout",
      frames: { unmatched: 1 },
      elapsedMs: 15000,
    });
    expect(fixture.timers.size).toBe(0);
    expect(socket.closes).toBe(1);
  });

  it("marks missing execute evidence unavailable instead of publishing an observation", async () => {
    const fixture = await generatedObserverFixture({ executeFailure: true });
    expect((await fixture.outcome).success).toBe(false);
    const diagnostic = fixture.writes.get(fixture.input.observerDiagnosticPath);
    expect(diagnostic).toMatchObject({
      available: false,
      outcome: "execute-unavailable",
      elapsedMs: null,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
    expect(fixture.writes.has(fixture.input.resultPath)).toBe(false);
  });

  it("closes the snapshot socket before the unchanged native status observations", async () => {
    const fixture = await generatedObserverFixture();
    const socket = fixture.sockets[0]!;
    const closeCounts: number[] = [];
    fixture.status.mockImplementation(async () => {
      closeCounts.push(socket.closes);
      return [];
    });
    socket.emit("message", {
      data: JSON.stringify({
        _tag: "Chunk",
        requestId: socket.sent[0]!.id,
        values: [{ kind: "snapshot", snapshot: { projects: [] } }],
      }),
    });
    expect((await fixture.outcome).success).toBe(true);
    expect(closeCounts).toEqual([1]);
    expect(socket.closes).toBe(1);
  });

  it.each(["close", "error", "timeout"] as const)(
    "closes opening failure: %s",
    async (openEvent) => {
      const fixture = await generatedObserverFixture({ openEvent });
      if (openEvent === "timeout") await fixture.expire();
      expect((await fixture.outcome).success).toBe(false);
      expect(fixture.writes.get(fixture.input.observerDiagnosticPath)).toMatchObject({
        outcome: openEvent === "timeout" ? "open-timeout" : "socket-" + openEvent,
        socketOpened: false,
      });
      expect(fixture.sockets[0]!.sent).toEqual([]);
      expect(fixture.sockets[0]!.closes).toBe(1);
      expect(fixture.timers.size).toBe(0);
    },
  );

  it.each(["Request", "Interrupt"] as const)(
    "does not replay after a %s send failure",
    async (sendFailure) => {
      const fixture = await generatedObserverFixture({ sendFailure });
      const socket = fixture.sockets[0]!;
      if (sendFailure === "Interrupt")
        socket.emit("message", {
          data: JSON.stringify({
            _tag: "Chunk",
            requestId: socket.sent[0]!.id,
            values: [{ kind: "snapshot", snapshot: { projects: [] } }],
          }),
        });
      expect((await fixture.outcome).success).toBe(false);
      expect(fixture.writes.get(fixture.input.observerDiagnosticPath)).toMatchObject({
        outcome: "send-error",
      });
      expect(socket.sent.filter((frame) => frame._tag === "Request")).toHaveLength(
        sendFailure === "Request" ? 0 : 1,
      );
      expect(fixture.timers.size).toBe(0);
      expect(socket.closes).toBe(1);
    },
  );

  it("retains seed acceptance then reads one real shell snapshot", async () => {
    const fixture = await generatedObserverFixture({ seed: true });
    const socket = fixture.sockets[0]!;
    expect(socket.sent[0]!.tag).toBe("orchestration.dispatchCommand");
    socket.emit("message", {
      data: JSON.stringify({
        _tag: "Exit",
        requestId: socket.sent[0]!.id,
        exit: { _tag: "Success", value: null },
      }),
    });
    await fixture.flush();
    expect(socket.sent[1]!.tag).toBe("orchestration.subscribeShell");
    socket.emit("message", {
      data: JSON.stringify({
        _tag: "Chunk",
        requestId: socket.sent[1]!.id,
        values: [{ kind: "snapshot", snapshot: { projects: [{ id: fixture.input.projectId }] } }],
      }),
    });
    expect((await fixture.outcome).success).toBe(true);
    expect(socket.sent.map((frame) => frame._tag)).toEqual(["Request", "Request", "Interrupt"]);
  });

  it("does not attribute the seed request's sent or terminal facts to a refused shell send", async () => {
    const fixture = await generatedObserverFixture({ seed: true, sendFailure: "ShellRequest" });
    const socket = fixture.sockets[0]!;
    socket.emit("message", {
      data: JSON.stringify({
        _tag: "Exit",
        requestId: socket.sent[0]!.id,
        exit: { _tag: "Success" },
      }),
    });
    expect((await fixture.outcome).success).toBe(false);
    expect(socket.sent).toHaveLength(1);
    expect(fixture.writes.get(fixture.input.observerDiagnosticPath)).toMatchObject({
      request: "shell",
      outcome: "send-error",
      requestSent: false,
      terminal: "none",
      interruptSent: false,
    });
  });

  it.each(["Die", "Interrupt", "private-unknown-cause"])(
    "projects only the closed failure category: %s",
    async (causeKind) => {
      const fixture = await generatedObserverFixture();
      const socket = fixture.sockets[0]!;
      socket.emit("message", {
        data: JSON.stringify({
          _tag: "Exit",
          requestId: socket.sent[0]!.id,
          exit: {
            _tag: "Failure",
            cause: [
              {
                _tag: causeKind,
                defect: "private-defect",
                fiberId: "private-fiber-id",
                error: { _tag: "private-error-tag", message: "private-message" },
              },
            ],
          },
        }),
      });
      expect((await fixture.outcome).success).toBe(false);
      const diagnostic = fixture.writes.get(fixture.input.observerDiagnosticPath);
      expect(diagnostic).toMatchObject({
        outcome: "stream-failure",
        causeKind: causeKind.startsWith("private-") ? "unknown" : causeKind,
        failureTag: "unknown",
      });
      expect(JSON.stringify(diagnostic)).not.toContain("private-");
    },
  );

  it("bounds diagnostic frame counts without changing the request deadline", async () => {
    const fixture = await generatedObserverFixture();
    const socket = fixture.sockets[0]!;
    for (let index = 0; index < 1010; index += 1)
      socket.emit("message", {
        data: JSON.stringify({ _tag: "Pong", private: "private-payload" }),
      });
    await fixture.expire();
    expect((await fixture.outcome).success).toBe(false);
    const diagnostic = fixture.writes.get(fixture.input.observerDiagnosticPath);
    expect(diagnostic).toMatchObject({ frames: { text: 1000, pong: 1000 }, elapsedMs: 15000 });
    expect(JSON.stringify(diagnostic).length).toBeLessThan(2000);
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
  });

  it("closes unknown diagnostic fields and refuses an impossible close code", () => {
    const diagnostic = SeededUpgradeHarness.sanitizeSeededUpgradeObserverDiagnostic({
      available: true,
      outcome: "private-outcome",
      milestone: "private-milestone",
      request: "private-request",
      terminal: "private-terminal",
      causeKind: "private-cause",
      failureTag: "private-tag",
      elapsedMs: Number.POSITIVE_INFINITY,
      closeCode: 999999,
      wasClean: "private-reason",
      frames: { text: 999999, binary: -1, extra: "private-payload" },
      url: "private-url",
      token: "private-token",
      id: "private-id",
      cause: "private-raw-cause",
    });
    expect(diagnostic).toMatchObject({
      outcome: "unknown",
      milestone: "unknown",
      elapsedMs: null,
      closeCode: null,
      wasClean: null,
      frames: { text: 1000, binary: null },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
    expect(JSON.stringify(diagnostic).length).toBeLessThan(2000);
  });

  it.each([
    "null",
    "array",
    "empty-chunk",
    "numeric-id",
    "invalid-exit",
    "invalid-snapshot",
  ] as const)("refuses malformed decoded protocol data: %s", async (scenario) => {
    const fixture = await generatedObserverFixture();
    const socket = fixture.sockets[0]!;
    const id = socket.sent[0]!.id;
    const values = {
      null: null,
      array: [],
      "empty-chunk": { _tag: "Chunk", requestId: id, values: [] },
      "numeric-id": { _tag: "Exit", requestId: 0, exit: { _tag: "Success" } },
      "invalid-exit": { _tag: "Exit", requestId: id, exit: { _tag: "private-terminal" } },
      "invalid-snapshot": { _tag: "Chunk", requestId: id, values: [{ kind: "private-kind" }] },
    };
    socket.emit("message", { data: JSON.stringify(values[scenario]) });
    expect((await fixture.outcome).success).toBe(false);
    expect(fixture.writes.get(fixture.input.observerDiagnosticPath)).toMatchObject({
      outcome: scenario === "invalid-snapshot" ? "invalid-snapshot" : "decode-error",
    });
    expect(socket.handlerErrors).toBe(0);
    expect(fixture.timers.size).toBe(0);
  });

  it.each([true, false])(
    "the actual generated test persists success only after observation: %s",
    async (success) => {
      const fixture = await generatedObserverFixture({ runIt: true });
      const socket = fixture.sockets[0]!;
      const id = socket.sent[0]!.id;
      socket.emit("message", {
        data: JSON.stringify(
          success
            ? {
                _tag: "Chunk",
                requestId: id,
                values: [
                  { kind: "snapshot", snapshot: { projects: [{ id: fixture.input.projectId }] } },
                ],
              }
            : { _tag: "Exit", requestId: id, exit: { _tag: "Success" } },
        ),
      });
      expect((await fixture.outcome).success).toBe(success);
      expect(fixture.writes.has(fixture.input.resultPath)).toBe(success);
      expect(fixture.writes.get(fixture.input.observerDiagnosticPath)).toMatchObject({
        outcome: success ? "success" : "stream-eof",
      });
    },
  );
});

interface ObservedUpgradeLane {
  readonly lane: SeededUpgradeHarness.SeededUpgradeLane;
  readonly trigger?: SeededUpgradeHarness.SeededUpgradeTrigger;
  readonly layout: ReturnType<typeof createSeededUpgradeRunLayout>["previousStable"];
  readonly appBinaryPath: string;
  readonly rpcFixture?: ReturnType<typeof SeededUpgradeHarness.createRpcUpgradeFixture>;
  readonly backendPort: number;
  readonly webdriverPort: number;
}

/** Execute the actual owner with only build/application/command boundaries made inert. */
const legacyOrchestrationFixture = async (
  options: {
    previousTrigger?: SeededUpgradeHarness.SeededUpgradeTrigger;
    wsl?: boolean;
    onLane?: (lane: ObservedUpgradeLane) => Promise<void>;
  } = {},
) => {
  const root = await NodeFS.promises.realpath(
    await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "legacy-rpc-owner-")),
  );
  const publicKeyFile = NodePath.join(root, "public.key");
  await NodeFS.promises.writeFile(publicKeyFile, "public-fixture-key");
  const input: SeededDesktopUpgradeSmokeInput = {
    arch: "x64",
    artifactDirectory: NodePath.join(root, "artifacts"),
    bundle: "nsis",
    candidateVersion: "0.7.3-upgrade.1",
    platform: "win",
    previousTag: "v0.7.2",
    previousVersion: "0.7.2",
    previousStableTrigger: options.previousTrigger ?? "remote-rpc",
    publicKeyFile,
    repositoryRoot: NodePath.join(root, "repository"),
    restartTimeoutMs: 180000,
    runId: "fixture",
    updaterPort: 43120,
    wsl: options.wsl ?? false,
    workRoot: NodePath.join(root, "work"),
  };
  const layout = createSeededUpgradeRunLayout(input.workRoot, input.runId);
  const commands: ReadonlyArray<string>[] = [];
  const builds: { checkout: string; version: string }[] = [];
  const installs: { laneRoot: string; packagePath: string }[] = [];
  const lanes: ObservedUpgradeLane[] = [];
  const stopped: string[] = [];
  const retainedSecrets: string[][] = [];
  const provenanceInputs: { lane: string; trigger: string; checkout: string; sourceRef: string }[] =
    [];
  const source = await NodeFS.promises.readFile(
    new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
    "utf8",
  );
  const selectorStart = source.indexOf("const previousStableTrigger =");
  const selectorEnd = source.indexOf("\nconst UPGRADE_SOURCE_PATHS", selectorStart);
  const start = source.indexOf("export async function runSeededDesktopUpgradeSmoke(");
  const end = source.indexOf("\nasync function main()", start);
  if ([selectorStart, selectorEnd, start, end].some((index) => index < 0))
    throw new Error("Orchestration source missing");
  const body = NodeModule.stripTypeScriptTypes(
    source.slice(selectorStart, selectorEnd) +
      "\n" +
      source.slice(start, end).replace("export ", ""),
  );
  const context = {
    NodePath,
    NodeFS,
    NodeCrypto,
    SeededDesktopUpgradeSmokeError,
    ManagedProcessRegistry,
    assertBaselineVersionIsOlder,
    assertRemoteInstallPort,
    createSeededUpgradeRunLayout,
    canonicalizeSeededUpgradeWorkRoot,
    readRemoteFixtureSecrets,
    stopRemoteUploadFixture,
    createRpcUpgradeFixture: SeededUpgradeHarness.createRpcUpgradeFixture,
    MOCK_UPDATE_LOOPBACK_HOST: "127.0.0.1",
    process: {
      env: {
        CI: "true",
        TAURI_SIGNING_PRIVATE_KEY: "private-key-sentinel",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "private-password-sentinel",
      },
    },
    writeBuildOverlay: async () => {},
    writePrivateJson: async () => {},
    readObservation: async (path: string) =>
      JSON.parse(await NodeFS.promises.readFile(path, "utf8")),
    runCommand: async () => ({ stdout: "a".repeat(40), stderr: "", exitCode: 0 }),
    requireCommandSuccess: async ({ args }: { args: string[] }) => {
      commands.push(args);
    },
    removeSeededUpgradeDependencyTree: async () => {},
    buildPackagedApplication: async (value: { checkout: string; version: string }) => {
      builds.push(value);
    },
    publishCandidateUpdater: async () => {},
    startMockUpdateServer: async () => ({}),
    terminateChild: async () => {
      stopped.push("updater");
    },
    baselinePackage: async (buildRoot: string) => NodePath.join(buildRoot, "installer.exe"),
    installBaselinePackage: async (value: { laneRoot: string; packagePath: string }) => {
      installs.push(value);
      await NodeFS.promises.mkdir(value.laneRoot, { recursive: true });
      return NodePath.join(value.laneRoot, "app.exe");
    },
    runUpgradeLane: async (value: ObservedUpgradeLane) => {
      lanes.push(value);
      await NodeFS.promises.mkdir(value.layout.workspaceRoot, { recursive: true });
      await options.onLane?.(value);
    },
    stopRemoteLaneApplication: async (app: string) => {
      stopped.push(app);
    },
    copyBoundedEvidence: async ({ secrets }: { secrets: string[] }) => {
      retainedSecrets.push(secrets);
    },
    recordUpgradeSourceProvenance: async (value: {
      lane: string;
      trigger: string;
      checkout: string;
      sourceRef: string;
    }) => {
      provenanceInputs.push(value);
    },
  };
  const run = NodeVM.runInNewContext(`${body}\nrunSeededDesktopUpgradeSmoke`, context, {
    timeout: 1000,
  }) as (input: SeededDesktopUpgradeSmokeInput) => Promise<void>;
  return {
    input,
    layout,
    commands,
    builds,
    installs,
    lanes,
    stopped,
    retainedSecrets,
    provenanceInputs,
    run: () => run(input),
    dispose: () => NodeFS.promises.rm(root, { recursive: true, force: true }),
  };
};

describe("previous/current RPC orchestration", () => {
  it("keeps three source/layout identities while selecting only the previous trigger", async () => {
    const fixture = await legacyOrchestrationFixture();
    try {
      await fixture.run();
      expect(fixture.lanes.map(({ lane, trigger }) => ({ lane, trigger }))).toEqual([
        { lane: "previous-stable", trigger: "remote-rpc" },
        { lane: "protected-baseline", trigger: "local-bridge" },
        { lane: "remote-install", trigger: "remote-rpc" },
      ]);
      expect(fixture.lanes.map((value) => value.layout.dataRoot)).toEqual([
        fixture.layout.previousStable.dataRoot,
        fixture.layout.protectedBaseline.dataRoot,
        fixture.layout.remoteInstall.dataRoot,
      ]);
      expect(fixture.installs.map((value) => value.packagePath)).toEqual([
        NodePath.join(fixture.layout.previousStable.buildRoot, "installer.exe"),
        NodePath.join(fixture.layout.protectedBaseline.buildRoot, "installer.exe"),
        NodePath.join(fixture.layout.protectedBaseline.buildRoot, "installer.exe"),
      ]);
      expect(fixture.lanes[0]?.rpcFixture?.credentialReceiptPath).toBe(
        NodePath.join(
          NodePath.dirname(fixture.layout.previousStable.dataRoot),
          "remote-bootstrap.secret.json",
        ),
      );
      expect(fixture.lanes[2]?.rpcFixture?.credentialReceiptPath).toBe(
        NodePath.join(
          NodePath.dirname(fixture.layout.remoteInstall.dataRoot),
          "remote-bootstrap.secret.json",
        ),
      );
      expect(fixture.stopped).toContain(fixture.lanes[0]?.appBinaryPath);
      expect(fixture.stopped).toContain(fixture.lanes[2]?.appBinaryPath);
      expect(fixture.commands.some((args) => args.includes("apply"))).toBe(false);
      expect(
        fixture.provenanceInputs.map(({ lane, trigger, checkout, sourceRef }) => ({
          lane,
          trigger,
          checkout,
          sourceRef,
        })),
      ).toEqual([
        {
          lane: "previous-stable",
          trigger: "remote-rpc",
          checkout: fixture.layout.previousStable.checkout,
          sourceRef: "v0.7.2",
        },
        {
          lane: "protected-baseline",
          trigger: "local-bridge",
          checkout: fixture.layout.protectedBaseline.checkout,
          sourceRef: "a".repeat(40),
        },
        {
          lane: "remote-install",
          trigger: "remote-rpc",
          checkout: fixture.layout.protectedBaseline.checkout,
          sourceRef: "a".repeat(40),
        },
      ]);
    } finally {
      await fixture.dispose();
    }
  });
  it("refuses all evidence when the previous RPC lane has a malformed receipt", async () => {
    const fixture = await legacyOrchestrationFixture({
      onLane: async (lane) => {
        if (lane.lane === "previous-stable")
          await NodeFS.promises.writeFile(
            NodePath.join(NodePath.dirname(lane.layout.dataRoot), "remote-bootstrap.secret.json"),
            "null",
          );
      },
    });
    try {
      await expect(fixture.run()).rejects.toThrow(/receipts were invalid/);
      expect(fixture.retainedSecrets).toEqual([]);
      expect(fixture.stopped).toContain(fixture.lanes[0]?.appBinaryPath);
      expect(fixture.stopped).toContain("updater");
    } finally {
      await fixture.dispose();
    }
  });
  it("collects both lanes' private secrets before either owner's joined cleanup", async () => {
    const fixture = await legacyOrchestrationFixture({
      onLane: async (lane) => {
        if (lane.rpcFixture === undefined) return;
        lane.rpcFixture.markPhaseStarted();
        await NodeFS.promises.writeFile(
          lane.rpcFixture.credentialReceiptPath,
          JSON.stringify({ bootstrapToken: `${lane.lane}-private-grant` }),
        );
      },
    });
    try {
      await fixture.run();
      expect(fixture.retainedSecrets).toHaveLength(1);
      expect(fixture.retainedSecrets[0]).toEqual(
        expect.arrayContaining(["previous-stable-private-grant", "remote-install-private-grant"]),
      );
      for (const lane of fixture.lanes)
        if (lane.rpcFixture !== undefined)
          expect(NodeFS.existsSync(lane.rpcFixture.credentialReceiptPath)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
  it.each([false, true])("preserves default local behavior with WSL=%s", async (wsl) => {
    const fixture = await legacyOrchestrationFixture({ previousTrigger: "local-bridge", wsl });
    try {
      await fixture.run();
      expect(fixture.lanes.map(({ lane, trigger }) => ({ lane, trigger }))).toEqual(
        wsl
          ? [{ lane: "protected-baseline", trigger: "local-bridge" }]
          : [
              { lane: "previous-stable", trigger: "local-bridge" },
              { lane: "protected-baseline", trigger: "local-bridge" },
              { lane: "remote-install", trigger: "remote-rpc" },
            ],
      );
      expect(fixture.lanes.filter((lane) => lane.rpcFixture !== undefined)).toHaveLength(
        wsl ? 0 : 1,
      );
    } finally {
      await fixture.dispose();
    }
  });
});

describe("previous RPC lane result verification", () => {
  it.each([
    "other-store",
    "other-start-version",
    "matching-wrong-baseline",
    "old-boot",
    "no-stage",
    "no-percent",
    "unfinished-held",
    "two-requesters",
    "no-backup",
    "valid",
  ])("verifies the actual lane result for %s", async (kind) => {
    const root = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rpc-lane-result-"));
    try {
      const layout = createSeededUpgradeRunLayout(root, "result").previousStable;
      const candidate = "0.7.3-upgrade.1";
      const before = {
        appVersion: kind === "matching-wrong-baseline" ? "0.7.1" : "0.7.2",
        effectiveRoot: layout.dataRoot,
        projectId: "p1",
        projectIds: ["p1"],
        storageInstanceId: "s1",
      };
      const after = {
        appVersion: candidate,
        effectiveRoot: layout.dataRoot,
        projectIds: ["p1"],
        storageInstanceId: "s1",
        preUpdateBackups:
          kind === "no-backup" ? [] : [{ storageInstanceId: "s1", trigger: "pre-update" }],
      };
      const remote = {
        before: {
          bootId: "b1",
          serverVersion:
            kind === "other-start-version" || kind === "matching-wrong-baseline"
              ? "0.7.1"
              : "0.7.2",
          storageInstanceId: kind === "other-store" ? "s2" : "s1",
        },
        after: {
          bootId: kind === "old-boot" ? "b1" : "b2",
          serverVersion: candidate,
          storageInstanceId: kind === "other-store" ? "s2" : "s1",
        },
        phases: ["downloading", "installing", "succeeded"],
        sawPercent: kind !== "no-percent",
        sawStage: kind !== "no-stage",
        heldUpload: {
          admitted: true,
          releasedOnWaitingStage: true,
          completed: kind !== "unfinished-held",
          bytesMatch: true,
          noPartials: true,
          requestClosed: true,
          holdLimitMs: 20000,
        },
        requesterLogLines: kind === "two-requesters" ? 2 : 1,
        appImageMounts: null,
        runtimeProcesses: null,
      };
      const source = await NodeFS.promises.readFile(
        new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("const runUpgradeLane = async");
      const end = source.indexOf("\nconst copyBoundedEvidence", start);
      if (start < 0 || end < 0) throw new Error("Lane verifier source missing");
      const writePrivateJson = async (path: string, value: unknown) =>
        NodeFS.promises.writeFile(path, JSON.stringify(value));
      const input = {
        lane: "previous-stable",
        trigger: "remote-rpc",
        layout,
        candidateVersion: candidate,
        baselineVersion: "0.7.2",
        appBinaryPath: NodePath.join(root, "owned.exe"),
        backendPort: 43121,
        platform: "win",
        projectId: "p1",
        repositoryRoot,
        restartTimeoutMs: 180000,
        webdriverPort: 43221,
        wsl: false,
        rpcFixture: SeededUpgradeHarness.createRpcUpgradeFixture({
          runRoot: NodePath.dirname(layout.dataRoot),
          workspaceRoot: layout.workspaceRoot,
        }),
      };
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(source.slice(start, end)) + "\nrunUpgradeLane",
        {
          NodeFS,
          NodePath,
          SeededDesktopUpgradeSmokeError,
          verifySeededUpgradeOutcome,
          verifyRemoteInstallOutcome,
          writePrivateJson,
          readObservation: async (path: string) =>
            JSON.parse(await NodeFS.promises.readFile(path, "utf8")),
          runWebDriverPhase: async (phase: { phase: string; resultPath: string }) => {
            await writePrivateJson(
              phase.resultPath,
              phase.phase === "seed-and-install" ? before : after,
            );
            if (phase.phase === "seed-and-install")
              await writePrivateJson(
                NodePath.join(layout.evidenceDirectory, "remote-rpc.json"),
                remote,
              );
          },
          waitForWindowsInstalledCandidate: async () => {},
          stopRemoteLaneApplication: async () => {},
        },
        { timeout: 1000 },
      ) as (input: unknown) => Promise<void>;
      if (kind === "valid") {
        await run(input);
        expect(
          JSON.parse(
            await NodeFS.promises.readFile(
              NodePath.join(layout.evidenceDirectory, "result.json"),
              "utf8",
            ),
          ),
        ).toMatchObject({
          lane: "previous-stable",
          trigger: "remote-rpc",
          storageIdentityRetained: true,
          preUpdateBackupObserved: true,
          coverageStatus: "verified",
        });
      } else {
        await expect(run(input)).rejects.toThrow(SeededDesktopUpgradeSmokeError);
        expect(NodeFS.existsSync(NodePath.join(layout.evidenceDirectory, "result.json"))).toBe(
          false,
        );
      }
    } finally {
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe("explicit previous-stable RPC selection", () => {
  const args = [
    "--platform",
    "win",
    "--arch",
    "x64",
    "--bundle",
    "nsis",
    "--candidate-version",
    "0.7.3-upgrade.1",
    "--previous-tag",
    "v0.7.2",
    "--previous-version",
    "0.7.2",
    "--public-key-file",
    absolute("keys", "updater.pub"),
    "--run-id",
    "legacy-rpc",
    "--work-root",
    absolute("work"),
    "--artifact-dir",
    absolute("evidence"),
  ];
  it("keeps local-bridge as the default and accepts an explicit native Windows RPC trigger", () => {
    expect(parseSeededDesktopUpgradeSmokeArgs(args).previousStableTrigger).toBe("local-bridge");
    expect(
      parseSeededDesktopUpgradeSmokeArgs([...args, "--previous-stable-trigger", "remote-rpc"])
        .previousStableTrigger,
    ).toBe("remote-rpc");
  });
  it.each([
    ["linux", "appimage", false],
    ["mac", "dmg", false],
    ["win", "nsis", true],
  ] as const)("refuses RPC selection for %s with WSL=%s before launch", (platform, bundle, wsl) => {
    expect(() =>
      parseSeededDesktopUpgradeSmokeArgs([
        ...args.with(1, platform).with(5, bundle),
        "--previous-stable-trigger",
        "remote-rpc",
        ...(wsl ? ["--wsl"] : []),
      ]),
    ).toThrow(/native Windows/);
  });
  it("rejects an unknown trigger instead of silently selecting another update path", () => {
    expect(() =>
      parseSeededDesktopUpgradeSmokeArgs([
        ...args,
        "--previous-stable-trigger",
        "automatic-fallback",
      ]),
    ).toThrow(/trigger/);
  });
  it("rejects invalid direct RPC selection before preparing any files", async () => {
    const input = {
      ...parseSeededDesktopUpgradeSmokeArgs(args),
      platform: "linux" as const,
      previousStableTrigger: "remote-rpc" as const,
    };
    vi.stubEnv("CI", "true");
    const mkdir = vi
      .spyOn(NodeFS.promises, "mkdir")
      .mockRejectedValue(new Error("unexpected preparation"));
    try {
      await expect(runSeededDesktopUpgradeSmoke(input)).rejects.toThrow(/native Windows/);
      expect(mkdir).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it.each(["null-before", "changed-store", "missing-backup"])(
    "requires actual protection for previous RPC: %s",
    (failure) => {
      const before = {
        appVersion: "0.7.2",
        effectiveRoot: absolute("data"),
        projectId: "p1",
        projectIds: ["p1"],
        storageInstanceId: failure === "null-before" ? null : "s1",
      };
      const after = {
        appVersion: "0.7.3-upgrade.1",
        effectiveRoot: absolute("data"),
        projectIds: ["p1"],
        storageInstanceId: failure === "changed-store" ? "s2" : "s1",
        preUpdateBackups:
          failure === "missing-backup" ? [] : [{ storageInstanceId: "s1", trigger: "pre-update" }],
      };
      expect(() =>
        verifySeededUpgradeOutcome(
          "previous-stable",
          before,
          after,
          "0.7.3-upgrade.1",
          "remote-rpc",
        ),
      ).toThrow(SeededDesktopUpgradeSmokeError);
      // The previous local route's existing legacy observation policy remains unchanged.
      expect(() =>
        verifySeededUpgradeOutcome("previous-stable", before, after, "0.7.3-upgrade.1"),
      ).not.toThrow();
    },
  );
});

describe("closed Windows compatibility provenance", () => {
  const sourcePaths = [
    "apps/desktop/src-tauri/src/bridge.rs",
    "apps/desktop/src-tauri/src/firewall.rs",
    "apps/desktop/src-tauri/src/updates.rs",
    "apps/desktop/src-tauri/src/remote_update_delegate.rs",
    "apps/server/src/remote_update.rs",
    "apps/server/src/production/remote_update_rpc.rs",
    "apps/server/src/auth/http.rs",
    "apps/server/src/maintenance.rs",
  ];
  const input = {
    lane: "previous-stable" as const,
    trigger: "remote-rpc" as const,
    sourceRef: "v0.7.2",
    sourceCommit: "b".repeat(40),
    baselineVersion: "0.7.2",
    candidateVersion: "0.7.3-upgrade.1",
    sourceHashes: Object.fromEntries(sourcePaths.map((path) => [path, "c".repeat(64)])),
  };
  it("records source rebuild and the unexercised old local failure without claiming a native pass", () => {
    const provenance = SeededUpgradeHarness.createSeededUpgradeProvenance(input);
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      lane: "previous-stable",
      trigger: "remote-rpc",
      sourceKind: "tag-source-rebuild",
      sourceCommit: "b".repeat(40),
      sourceRef: "v0.7.2",
      baselineVersion: "0.7.2",
      candidateVersion: "0.7.3-upgrade.1",
      instrumentationApplied: false,
      coverageStatus: "selected-not-yet-verified",
      excludedEntryPoints: ["previous-stable-local-bridge"],
      knownPriorFailure: "previous-stable-local-bridge-stack-overflow",
    });
    expect(provenance.sourceFiles.map((entry) => entry.path)).toEqual(sourcePaths);
    expect(provenance.sourceFiles.every((entry) => entry.sha256 === "c".repeat(64))).toBe(true);
  });
  it.each(["sourceRef", "sourceCommit", "baselineVersion", "candidateVersion", "sourceHashes"])(
    "rejects private/unbounded %s before creating public provenance",
    (field) => {
      const value = {
        ...input,
        [field]: field === "sourceHashes" ? { private: "do-not-retain" } : "private-do-not-retain",
      };
      let error: unknown;
      try {
        SeededUpgradeHarness.createSeededUpgradeProvenance(value as typeof input);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
      expect(String(error)).not.toContain("private-do-not-retain");
    },
  );
  it.each([
    null,
    "apps/desktop/src-tauri/src/bridge.rs",
    "apps/desktop/src-tauri/build.rs",
    "packages/client-runtime/src/state/remoteUpdates.ts",
    "Cargo.toml",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/package.json",
    "Cargo.lock",
    "apps/desktop/package.json:mode",
    "Cargo.lock:truncated",
  ])("checks all tracked source before retaining provenance; changed=%s", async (changedPath) => {
    const actualChangedPath = changedPath?.split(":")[0] ?? null;
    const root = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "legacy-source-facts-"),
    );
    try {
      for (const path of sourcePaths) {
        const target = NodePath.join(root, "checkout", path);
        await NodeFS.promises.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFS.promises.writeFile(target, "test-owned source bytes\n");
      }
      const originalVersions = new Map<string, string>();
      for (const path of releaseVersionFiles) {
        const original = await NodeFS.promises.readFile(
          NodePath.join(repositoryRoot, path),
          "utf8",
        );
        originalVersions.set(path, original);
        let current = original;
        if (changedPath === path) {
          if (path.endsWith("package.json")) {
            const value = JSON.parse(original);
            value.scripts = { ...value.scripts, build: "private-source-detail" };
            current = JSON.stringify(value);
          } else if (path === "Cargo.lock") {
            current = original.replace(/\nversion = "[^"]+"/, '\nversion = "999.0.0"');
          } else current = original + "\n[profile.release]\nopt-level = 0\n";
        }
        const target = NodePath.join(root, "checkout", path);
        await NodeFS.promises.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFS.promises.writeFile(target, current);
      }
      const source = await NodeFS.promises.readFile(
        new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("const recordUpgradeSourceProvenance = async");
      const end = source.indexOf("\nconst walkFiles", start);
      if (start < 0 || end < 0) throw new Error("Source provenance recorder is missing");
      const commands: ReadonlyArray<string>[] = [];
      const record = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(source.slice(start, end)) +
          "\nrecordUpgradeSourceProvenance",
        {
          NodeFS,
          NodePath,
          NodeCrypto,
          Buffer,
          releaseVersionFiles,
          MAX_VERSION_SOURCE_BYTES: 262144,
          assertSeededVersionOverlay: SeededUpgradeHarness.assertSeededVersionOverlay,
          UPGRADE_SOURCE_PATHS: sourcePaths,
          SeededDesktopUpgradeSmokeError,
          createSeededUpgradeProvenance: SeededUpgradeHarness.createSeededUpgradeProvenance,
          runCommand: async ({ args }: { args: string[] }) => {
            commands.push(args);
            if (args[0] === "rev-parse") return { stdout: "b".repeat(40), exitCode: 0 };
            if (args[0] === "diff" && args[1] === "--quiet") {
              const scope = args.slice(args.indexOf("--") + 1);
              const included =
                actualChangedPath !== null &&
                scope.some(
                  (path) =>
                    path === "." ||
                    actualChangedPath === path ||
                    actualChangedPath.startsWith(path + "/"),
                );
              const excluded = scope.includes(`:(top,exclude,literal)${actualChangedPath}`);
              return { stdout: "", exitCode: included && !excluded ? 1 : 0 };
            }
            if (args[0] === "diff" && args[1] === "--raw")
              return {
                stdout:
                  changedPath?.endsWith(":mode") &&
                  args.at(-1) === `:(top,literal)${actualChangedPath}`
                    ? `:100644 100755 ${"b".repeat(40)} ${"0".repeat(40)} M\0${actualChangedPath}\0`
                    : "",
                exitCode: 0,
              };
            if (args[0] === "cat-file") {
              const path = args[2]!.slice(41);
              return {
                stdout: String(Buffer.byteLength(originalVersions.get(path)!)),
                exitCode: 0,
              };
            }
            if (args[0] === "show") {
              const path = args[1]!.slice(41);
              const value = originalVersions.get(path)!;
              return {
                stdout:
                  changedPath?.endsWith(":truncated") && path === actualChangedPath
                    ? value.slice(1)
                    : value,
                exitCode: 0,
              };
            }
            return {
              stdout: "private-source-detail",
              exitCode: 1,
            };
          },
          writePrivateJson: async (path: string, value: unknown) =>
            NodeFS.promises.writeFile(path, JSON.stringify(value)),
        },
        { timeout: 1000 },
      ) as (input: unknown) => Promise<void>;
      const evidenceDirectory = NodePath.join(root, "evidence");
      const run = record({
        ...input,
        checkout: NodePath.join(root, "checkout"),
        evidenceDirectory,
      });
      if (changedPath !== null) {
        const error = await run.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
        expect(String(error)).not.toContain("private-source-detail");
        expect(NodeFS.existsSync(NodePath.join(evidenceDirectory, "source-provenance.json"))).toBe(
          false,
        );
      } else {
        await run;
        const result = JSON.parse(
          await NodeFS.promises.readFile(
            NodePath.join(evidenceDirectory, "source-provenance.json"),
            "utf8",
          ),
        );
        expect(result).toMatchObject({
          sourceCommit: "b".repeat(40),
          instrumentationApplied: false,
          coverageStatus: "selected-not-yet-verified",
        });
        expect(result.sourceFiles).toEqual(
          sourcePaths.map((path) => ({
            path,
            sha256: NodeCrypto.createHash("sha256")
              .update("test-owned source bytes\n")
              .digest("hex"),
          })),
        );
        expect(commands).toContainEqual([
          "diff",
          "--quiet",
          "b".repeat(40),
          "--",
          ".",
          ...releaseVersionFiles.map((path) => `:(top,exclude,literal)${path}`),
        ]);
      }
    } finally {
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe("declared version overlays", () => {
  const jsonBefore =
    '{"name":"owned","version":"0.7.1","scripts":{"build":"safe"},"dependencies":{"x":"1"}}';
  const jsonAfter =
    '{"name":"owned","version":"0.7.2","scripts":{"build":"safe"},"dependencies":{"x":"1"}}';
  const cargoBefore = '[package]\nname="bibcode-server"\nversion="0.7.1"\n[dependencies]\nx="1"\n';
  const cargoAfter = '[package]\nname="bibcode-server"\nversion="0.7.2"\n[dependencies]\nx="1"\n';
  const lockBefore =
    'version=4\n[[package]]\nname="bibcode-server"\nversion="0.7.1"\n[[package]]\nname="bibcode-desktop"\nversion="0.7.1"\n[[package]]\nname="dependency"\nversion="1.0.0"\n';
  const lockAfter =
    'version=4\n[[package]]\nname="bibcode-server"\nversion="0.7.2"\n[[package]]\nname="bibcode-desktop"\nversion="0.7.2"\n[[package]]\nname="dependency"\nversion="1.0.0"\n';
  it.each([
    ["apps/server/package.json", jsonBefore, jsonAfter],
    ["apps/server/Cargo.toml", cargoBefore, cargoAfter],
    ["Cargo.lock", lockBefore, lockAfter],
  ])("allows only the maintained version fields in %s", (path, before, after) => {
    expect(() =>
      SeededUpgradeHarness.assertSeededVersionOverlay(path!, before!, after!, "0.7.2"),
    ).not.toThrow();
  });
  it.each([
    ["apps/server/package.json", jsonBefore, jsonAfter.replace("safe", "private-source-detail")],
    ["apps/server/package.json", jsonBefore, jsonAfter.replace('"x":"1"', '"x":"2"')],
    ["apps/server/Cargo.toml", cargoBefore, cargoAfter + '[profile.release]\nlto="fat"\n'],
    ["apps/server/Cargo.toml", cargoBefore, cargoAfter.replace('x="1"', 'x="2"')],
    ["Cargo.lock", lockBefore, lockAfter.replace('version="1.0.0"', 'version="9.9.9"')],
    ["apps/desktop/src-tauri/build.rs", "before", "after"],
  ])("refuses non-version changes in %s with closed errors", (path, before, after) => {
    let error: unknown;
    try {
      SeededUpgradeHarness.assertSeededVersionOverlay(path!, before!, after!, "0.7.2");
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
    expect(String(error)).not.toContain("private-source-detail");
  });
});

describe("temporary Windows legacy RPC workflow", () => {
  it("selects both native architectures, preserves three lanes, and gates the explicit trigger", async () => {
    const workflow = YAML.parse(
      await NodeFS.promises.readFile(
        NodePath.join(repositoryRoot, ".github/workflows/qualify-windows-legacy-rpc.yml"),
        "utf8",
      ),
    );
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["codex/qualify-windows-legacy-rpc"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const jobs = Object.values(workflow.jobs) as Array<{
      "runs-on": string;
      "timeout-minutes": number;
      env: Record<string, string>;
      strategy: { matrix: { include: unknown[] } };
      steps: Array<{
        name: string;
        run?: string;
        if?: string;
        with?: Record<string, unknown>;
        "continue-on-error"?: boolean;
      }>;
    }>;
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.strategy.matrix.include).toEqual([
      { label: "Windows x64 old RPC and current bridge/RPC", runner: "windows-2025", arch: "x64" },
      {
        label: "Windows ARM64 old RPC and current bridge/RPC",
        runner: "windows-11-vs2026-arm",
        arch: "arm64",
      },
    ]);
    expect(job["timeout-minutes"]).toBe(240);
    expect(job.env.CARGO_BUILD_JOBS).toBe("2");
    const trial = job.steps.findIndex(
      (step) => step.name === "Run unchanged-old RPC, current local bridge, and current RPC",
    );
    expect(trial).toBeGreaterThan(0);
    const gates = [
      "Install frozen dependencies",
      "Check source formatting and lint",
      "Test held-upload and lane ownership",
      "Build web assets",
      "Typecheck full workspace",
      "Check Rust formatting",
      "Test native bridge contract",
      "Test update coordinator",
      "Test Windows firewall arguments",
      "Test real HTTP maintenance admission",
      "Recompute affected Clippy diagnostics",
    ];
    for (const name of gates) {
      const at = job.steps.findIndex((step) => step.name === name);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(trial);
      expect(job.steps[at]?.if).toBeUndefined();
    }
    expect(job.steps.every((step) => step["continue-on-error"] === undefined)).toBe(true);
    expect(job.steps.findIndex((step) => step.name === "Build web assets")).toBeLessThan(
      job.steps.findIndex((step) => step.name === "Typecheck full workspace"),
    );
    const command = job.steps[trial]!.run!;
    expect(command).toContain("--previous-stable-trigger remote-rpc");
    expect(command).toContain("--restart-timeout-ms 180000");
    expect(command).not.toMatch(/--windows-diagnostics|--windows-protected-current|--wsl/);
    expect(
      job.steps.find(
        (step) => step.name === "Pin unchanged previous release and candidate versions",
      )?.run,
    ).toContain('previous_tag="v0.7.2"');
    expect(
      job.steps.find(
        (step) => step.name === "Pin unchanged previous release and candidate versions",
      )?.run,
    ).toContain("cd66fda5700294a320fe76256c486bd7a7a0b3a5");
    expect(
      job.steps.find((step) => step.name === "Generate ephemeral updater signing key")?.run,
    ).toContain('echo "::add-mask::$key_password"');
    expect(
      job.steps.find((step) => step.name === "Upload bounded compatibility evidence")?.with?.path,
    ).toBe("${{ runner.temp }}/bibcode-windows-legacy-rpc/evidence/*");
    expect(
      job.steps.find((step) => step.name === "Recompute affected Clippy diagnostics")?.run,
    ).toContain("-- -D warnings");
  });
});

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

describe("RPC lane fixture ownership", () => {
  const receipt = {
    version: 1 as const,
    relativeDirectory: "bibcode-update-witness-00000000-0000-4000-8000-000000000002",
    relativeUrl: "/api/transfers/previous-private-capability",
  };
  const owned = async (run: (root: string) => Promise<void>) => {
    const root = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rpc-lane-owners-"));
    try {
      await run(root);
    } finally {
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  };
  const fixtureAt = async (root: string, lane: string) => {
    const runRoot = NodePath.join(root, lane);
    const workspaceRoot = NodePath.join(runRoot, "workspace");
    await NodeFS.promises.mkdir(workspaceRoot, { recursive: true });
    return {
      input: { runRoot, workspaceRoot },
      owner: SeededUpgradeHarness.createRpcUpgradeFixture({ runRoot, workspaceRoot }),
    };
  };
  it("requires receipts independently for started and unstarted RPC lanes", async () => {
    await owned(async (root) => {
      const previous = await fixtureAt(root, "previous");
      const current = await fixtureAt(root, "remote");
      previous.owner.markPhaseStarted();
      await expect(previous.owner.readSecrets()).rejects.toThrow(/credential receipt/);
      expect(await current.owner.readSecrets()).toEqual([]);
      await NodeFS.promises.writeFile(
        previous.owner.credentialReceiptPath,
        JSON.stringify({ bootstrapToken: "previous-private-grant" }),
      );
      await writeRemoteUploadCapabilityReceipt(previous.owner.uploadReceiptPath, receipt);
      await NodeFS.promises.writeFile(
        NodePath.join(previous.input.runRoot, "before.json"),
        JSON.stringify({ installAttempted: true }),
      );
      expect(await previous.owner.readSecrets()).toEqual(
        expect.arrayContaining(["previous-private-grant", receipt.relativeUrl]),
      );
      current.owner.markPhaseStarted();
      await expect(current.owner.readSecrets()).rejects.toThrow(/credential receipt/);
      expect(await previous.owner.readSecrets()).toContain("previous-private-grant");
      await NodeFS.promises.writeFile(current.owner.credentialReceiptPath, "null");
      await expect(current.owner.readSecrets()).rejects.toThrow(SeededDesktopUpgradeSmokeError);
    });
  });
  it("joins each captured application stop before removing only that lane's residue and receipts", async () => {
    await owned(async (root) => {
      const previous = await fixtureAt(root, "previous");
      const current = await fixtureAt(root, "remote");
      for (const { input, owner } of [previous, current]) {
        await NodeFS.promises.writeFile(
          owner.credentialReceiptPath,
          JSON.stringify({ bootstrapToken: "private-grant" }),
        );
        await writeRemoteUploadCapabilityReceipt(owner.uploadReceiptPath, receipt);
        await NodeFS.promises.mkdir(NodePath.join(input.workspaceRoot, receipt.relativeDirectory));
        await NodeFS.promises.writeFile(
          NodePath.join(input.workspaceRoot, receipt.relativeDirectory, "protection-witness.txt"),
          "o",
        );
      }
      const previousPath = NodePath.join(previous.input.workspaceRoot, receipt.relativeDirectory);
      const currentPath = NodePath.join(current.input.workspaceRoot, receipt.relativeDirectory);
      const gate = Promise.withResolvers<void>();
      const stopping = previous.owner.stop(() => gate.promise);
      expect(NodeFS.existsSync(previousPath)).toBe(true);
      expect(NodeFS.existsSync(currentPath)).toBe(true);
      gate.resolve();
      await stopping;
      expect(NodeFS.existsSync(previousPath)).toBe(false);
      expect(NodeFS.existsSync(previous.owner.credentialReceiptPath)).toBe(false);
      expect(NodeFS.existsSync(previous.owner.uploadReceiptPath)).toBe(false);
      expect(NodeFS.existsSync(currentPath)).toBe(true);
      await expect(
        current.owner.stop(async () => {
          throw new Error("owned stop failed");
        }),
      ).rejects.toThrow(/stop failed/);
      expect(NodeFS.existsSync(currentPath)).toBe(true);
      expect(NodeFS.existsSync(current.owner.credentialReceiptPath)).toBe(true);
      expect(NodeFS.existsSync(current.owner.uploadReceiptPath)).toBe(true);
      await current.owner.stop(async () => {});
      expect(NodeFS.existsSync(currentPath)).toBe(false);
    });
  });
});

/** Compile the actual runner with inert child and timer ports; no process is spawned or signalled. */
const inertCommandRunner = async () => {
  const source = await NodeFS.promises.readFile(
    new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const terminateChild = async");
  const end = source.indexOf("const runCommand = runBoundedCommand;", start);
  if (start < 0 || end < 0) throw new Error("Command runner source missing");
  const stdout = Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() });
  const stderr = Object.assign(new NodeEvents.EventEmitter(), { destroy: vi.fn() });
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout,
    stderr,
    kill: vi.fn(),
  });
  const timers = new Set<() => void>();
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start, end).replaceAll(/^export /gm, "")) +
      "\nrunBoundedCommand",
    {
      NodeChildProcess: { spawn: () => child },
      NodePath,
      SeededDesktopUpgradeSmokeError,
      process: { env: {} },
      setTimeout: (callback: () => void) => {
        timers.add(callback);
        return callback;
      },
      clearTimeout: (callback: () => void) => timers.delete(callback),
    },
    { timeout: 1000 },
  ) as (
    input: Parameters<typeof runBoundedCommand>[0] & { waitForStdioClose?: boolean },
  ) => ReturnType<typeof runBoundedCommand>;
  return {
    child,
    timers,
    run,
    exit: (code: number | null, signal: NodeJS.Signals | null = null) => {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
    },
    close: (code: number | null, signal: NodeJS.Signals | null = null) => {
      child.emit("close", code, signal);
    },
    expire: () => {
      const expiring = Array.from(timers);
      timers.clear();
      for (const timer of expiring) timer();
    },
  };
};

describe("bounded process observation completion", () => {
  const observation = {
    command: "inert-observer",
    args: [],
    cwd: "/inert-owned-fixture",
    timeoutMs: 10_000,
    waitForStdioClose: true,
  };

  it("does not convert a signal-only termination into an ordinary no-match exit", async () => {
    const runner = await inertCommandRunner();
    const result = runner.run(observation);
    runner.exit(null, "SIGTERM");
    runner.close(null, "SIGTERM");
    expect((await result).exitCode).toBe(-1);
    expect(runner.timers.size).toBe(0);
  });

  it("includes pending stderr before an observation can settle", async () => {
    const runner = await inertCommandRunner();
    let settled = false;
    const result = runner.run(observation).then((value) => {
      settled = true;
      return value;
    });
    runner.exit(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    runner.child.stderr.emit("data", Buffer.from("private-stop-sentinel"));
    runner.close(1);
    expect(await result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "private-stop-sentinel",
    });
    expect(runner.timers.size).toBe(0);
  });

  it("bounds a missing stdio close and releases the observer's local pipes", async () => {
    const runner = await inertCommandRunner();
    const result = runner.run(observation);
    runner.exit(1);
    runner.expire();
    await expect(result).rejects.toThrow(/timed out/);
    expect(runner.child.stdout.destroy).toHaveBeenCalledOnce();
    expect(runner.child.stderr.destroy).toHaveBeenCalledOnce();
    expect(runner.child.kill).not.toHaveBeenCalled();
    expect(runner.timers.size).toBe(0);
  });

  it("refuses a truncated observation even when its retained tail looks empty", async () => {
    const runner = await inertCommandRunner();
    const result = runner.run(observation);
    runner.child.stderr.emit("data", Buffer.from("private-stop-sentinel" + " ".repeat(262_144)));
    runner.exit(1);
    runner.close(1);
    const failure = await result.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure instanceof SeededDesktopUpgradeSmokeError).toBe(true);
    expect(String(failure)).toContain("output exceeded its bound");
    expect(runner.timers.size).toBe(0);
  });

  it("keeps launcher completion on exit when completed stdio was not requested", async () => {
    const runner = await inertCommandRunner();
    const result = runner.run({ ...observation, waitForStdioClose: false });
    runner.exit(0);
    expect(await result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(runner.timers.size).toBe(0);
  });
});

describe("confirmed restarted application shutdown", () => {
  const scenarios = [
    "kill-errors",
    "kill-success-still-live",
    "kill-then-errors",
    "observation-error",
    "observation-unknown",
    "observation-malformed",
    "observation-stderr",
    "kill-throws",
    "not-ci",
    "already-absent",
    "kill-then-absent",
    "transient-absence",
    "error-then-confirmed-absent",
    "mac-absent",
    "mac-observation-error",
    "mac-observation-stderr",
    "mac-observation-signal",
    "mac-observation-late-stderr",
    "mac-observation-missing-close",
    "mac-malformed",
  ] as const;
  it.each(scenarios)(
    "joins the actual stop chain and preserves uncertain owners: %s",
    async (scenario) => {
      const root = await NodeFS.promises.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "confirmed-app-stop-"),
      );
      try {
        const workspaceRoot = NodePath.join(root, "workspace");
        await NodeFS.promises.mkdir(workspaceRoot);
        const fixture = SeededUpgradeHarness.createRpcUpgradeFixture({
          runRoot: root,
          workspaceRoot,
        });
        const receipt = {
          version: 1 as const,
          relativeDirectory: "bibcode-update-witness-00000000-0000-4000-8000-000000000099",
          relativeUrl: "/api/transfers/private-stop-sentinel",
        };
        const residue = NodePath.join(workspaceRoot, receipt.relativeDirectory);
        await NodeFS.promises.mkdir(residue);
        await NodeFS.promises.writeFile(NodePath.join(residue, "protection-witness.txt"), "o");
        await NodeFS.promises.writeFile(
          fixture.credentialReceiptPath,
          JSON.stringify({ bootstrapToken: "private-stop-sentinel" }),
        );
        await writeRemoteUploadCapabilityReceipt(fixture.uploadReceiptPath, receipt);
        const source = await NodeFS.promises.readFile(
          new URL("./seeded-desktop-upgrade-smoke.ts", import.meta.url),
          "utf8",
        );
        const observeStart = source.indexOf("export const windowsApplicationAbsenceScript =");
        const start =
          observeStart >= 0
            ? observeStart
            : source.indexOf("const stopRestartedApplication = async");
        const end = source.indexOf(
          "export async function removeSeededUpgradeDependencyTree",
          start,
        );
        const remoteStart = source.indexOf("const stopRemoteLaneApplication = async");
        const remoteEnd = source.indexOf("const runUpgradeLane = async", remoteStart);
        if ([start, end, remoteStart, remoteEnd].some((index) => index < 0))
          throw new Error("Stop chain source missing");
        const helperSource = NodeModule.stripTypeScriptTypes(
          (source.slice(start, end) + "\n" + source.slice(remoteStart, remoteEnd)).replaceAll(
            /^export /gm,
            "",
          ),
        );
        const calls: { command: string; args: ReadonlyArray<string> }[] = [];
        let kills = 0;
        let observations = 0;
        const stop = NodeVM.runInNewContext(
          helperSource + "\nstopRemoteLaneApplication",
          {
            NodePath,
            SeededDesktopUpgradeSmokeError,
            restartedApplicationCleanupPlan,
            process: { env: { CI: scenario === "not-ci" ? "false" : "true" } },
            setTimeout: (callback: () => void) => {
              queueMicrotask(callback);
              return 0;
            },
            runCommand: async (input: {
              command: string;
              args: ReadonlyArray<string>;
              env?: Record<string, string>;
              timeoutMs: number;
              waitForStdioClose?: boolean;
            }) => {
              calls.push(input);
              expect(input.timeoutMs).toBeLessThanOrEqual(10000);
              if (input.command === "taskkill.exe" || input.command === "pkill") {
                kills += 1;
                if (scenario === "kill-throws") throw new Error("private-stop-sentinel");
                const exitCode =
                  scenario === "kill-errors" ||
                  scenario === "error-then-confirmed-absent" ||
                  (scenario === "kill-then-errors" && kills > 1)
                    ? 5
                    : 0;
                return { stdout: "", stderr: exitCode ? "private-stop-sentinel" : "", exitCode };
              }
              observations += 1;
              if (input.command === "pgrep") {
                expect(input.args).toEqual(["-x", "bibcode-desktop"]);
                if (
                  scenario === "mac-observation-signal" ||
                  scenario === "mac-observation-late-stderr" ||
                  scenario === "mac-observation-missing-close"
                ) {
                  const runner = await inertCommandRunner();
                  const result = runner.run({ ...input, cwd: root });
                  if (scenario === "mac-observation-signal") {
                    runner.exit(null, "SIGTERM");
                    runner.close(null, "SIGTERM");
                  } else {
                    runner.exit(1);
                    await Promise.resolve();
                    if (scenario === "mac-observation-late-stderr") {
                      runner.child.stderr.emit("data", Buffer.from("private-stop-sentinel"));
                      runner.close(1);
                    } else runner.expire();
                  }
                  return result;
                }
                if (scenario === "mac-observation-error")
                  return { stdout: "", stderr: "private-stop-sentinel", exitCode: 2 };
                if (scenario === "mac-observation-stderr")
                  return { stdout: "", stderr: "private-stop-sentinel", exitCode: 1 };
                if (scenario === "mac-malformed")
                  return { stdout: "private-stop-sentinel", stderr: "", exitCode: 0 };
                return { stdout: "", stderr: "", exitCode: 1 };
              }
              expect(input.command).toBe("powershell.exe");
              expect(input.env?.BIBCODE_SEEDED_APPLICATION_NAME).toBe("bibcode-desktop.exe");
              if (scenario === "observation-error")
                return { stdout: "", stderr: "private-stop-sentinel", exitCode: 5 };
              if (scenario === "observation-unknown")
                return {
                  stdout: '{"observed":false,"matchingProcesses":null}',
                  stderr: "",
                  exitCode: 0,
                };
              if (scenario === "observation-malformed")
                return { stdout: "private-stop-sentinel", stderr: "", exitCode: 0 };
              if (scenario === "observation-stderr")
                return {
                  stdout: '{"observed":true,"matchingProcesses":0}',
                  stderr: "private-stop-sentinel",
                  exitCode: 0,
                };
              const absent =
                scenario === "already-absent" ||
                ((scenario === "kill-then-absent" || scenario === "error-then-confirmed-absent") &&
                  observations > 1) ||
                (scenario === "transient-absence" && observations !== 2);
              return {
                stdout: JSON.stringify({ observed: true, matchingProcesses: absent ? 0 : 1 }),
                stderr: "",
                exitCode: 0,
              };
            },
          },
          { timeout: 1000 },
        ) as (app: string, platform: "win" | "mac", dataRoot: string) => Promise<void>;
        const succeeds = [
          "already-absent",
          "kill-then-absent",
          "transient-absence",
          "error-then-confirmed-absent",
          "mac-absent",
        ].includes(scenario);
        const outcome = fixture.stop(() =>
          stop(
            NodePath.join(root, "bibcode-desktop.exe"),
            scenario.startsWith("mac-") ? "mac" : "win",
            NodePath.join(root, "data"),
          ),
        );
        if (succeeds) {
          await outcome;
          expect(observations).toBeGreaterThanOrEqual(2);
          expect(NodeFS.existsSync(residue)).toBe(false);
          expect(NodeFS.existsSync(fixture.uploadReceiptPath)).toBe(false);
          expect(NodeFS.existsSync(fixture.credentialReceiptPath)).toBe(false);
          if (scenario === "already-absent" || scenario === "mac-absent") expect(kills).toBe(0);
          if (scenario === "transient-absence") {
            expect(observations).toBe(4);
            expect(kills).toBe(1);
          }
        } else {
          const error = await outcome.catch((cause: unknown) => cause);
          expect(error).toBeInstanceOf(SeededDesktopUpgradeSmokeError);
          expect(String(error)).not.toContain("private-stop-sentinel");
          expect(NodeFS.existsSync(residue)).toBe(true);
          expect(NodeFS.existsSync(fixture.uploadReceiptPath)).toBe(true);
          expect(NodeFS.existsSync(fixture.credentialReceiptPath)).toBe(true);
          if (scenario === "not-ci") expect(calls).toEqual([]);
        }
        expect(kills).toBeLessThanOrEqual(20);
        expect(observations).toBeLessThanOrEqual(20);
      } finally {
        await NodeFS.promises.rm(root, { recursive: true, force: true });
      }
    },
  );
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
  const remoteRpc = SeededUpgradeHarness.createRpcUpgradeFixture({
    runRoot,
    workspaceRoot: phaseInput.workspaceRoot,
  });
  const context = NodeVM.createContext({
    NodeFS,
    NodePath,
    NodeURL,
    process: { env: {} },
    REMOTE_UPDATE_DOWNLOAD_BUDGET_MS: 1,
    REMOTE_UPDATE_INSTALL_BUDGET_MS: 1,
    REMOTE_UPDATE_RESTART_BUDGET_MS: 1,
    seededUpgradeVitePlusExecutable,
    createSeededUpgradeDriverSpec,
    createSeededUpgradeWdioConfig,
    readRemoteFixtureSecrets,
    redactAndBoundUpgradeEvidence,
    assertWebDriverPhaseExit,
    assertRemoteInstallPort,
    SeededDesktopUpgradeSmokeError,
    runCommand,
    remoteRpc,
    rpcFixtures: [remoteRpc],
    baselineVersion: undefined,
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

/** Executes the generated credential callback and its receipt/driver handoff without a desktop. */
const remoteGrantFixture = (
  responses: ReadonlyArray<unknown>,
  selection?: { lane: "previous-stable"; trigger: "remote-rpc" },
) => {
  const lane: SeededUpgradeHarness.SeededUpgradeLane = selection?.lane ?? "remote-install";
  const input = {
    candidateVersion: "0.7.3",
    expectedDataRoot: absolute("remote", "data"),
    lane,
    ...(selection ? { trigger: selection.trigger, baselineVersion: "0.7.2" } : {}),
    phase: "seed-and-install" as const,
    projectId: "remote-project",
    resultPath: absolute("remote", "before.json"),
    workspaceRoot: absolute("remote", "workspace"),
    platform: selection ? ("win" as const) : ("linux" as const),
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

  it("refuses an unexpected starting version before update-path credential and installer commands", async () => {
    const input = {
      candidateVersion: "0.7.3-upgrade.1",
      baselineVersion: "0.7.2",
      expectedDataRoot: absolute("previous", "data"),
      lane: "previous-stable" as const,
      trigger: "remote-rpc" as const,
      phase: "seed-and-install" as const,
      projectId: "p1",
      resultPath: absolute("previous", "before.json"),
      workspaceRoot: absolute("previous", "workspace"),
      platform: "win" as const,
      appBinaryPath: absolute("previous", "app.exe"),
      remoteInstallDriverPath: "fixture:driver",
      remoteHarnessPath: "fixture:host",
      remoteSecretPath: absolute("previous", "credentials.json"),
      remoteUploadSecretPath: absolute("previous", "upload.json"),
      remoteEvidencePath: absolute("previous", "remote.json"),
    };
    const spec = createSeededUpgradeDriverSpec(input);
    const start = spec.indexOf("    const observation = await observe(true);");
    const end = spec.indexOf("    const credentials = await browser.execute(", start);
    if (start < 0 || end < 0) throw new Error("Remote seed admission block missing");
    const execute = vi.fn(async () => false);
    const run = NodeVM.runInNewContext(
      `(async () => { ${spec.slice(start, end)} })()`,
      {
        input,
        observe: async () => ({ appVersion: "0.7.1" }),
        NodeFS: { writeFileSync: () => {} },
        browser: { execute, waitUntil: async () => {} },
      },
      { timeout: 1000 },
    ) as Promise<void>;
    await expect(run).rejects.toThrow(/starting app version.*planned baseline/);
    expect(execute).not.toHaveBeenCalled();
  });

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

  it("uses the same authenticated RPC handoff for an explicitly selected previous baseline", async () => {
    const fixture = remoteGrantFixture([[publicPairingGrant]], {
      lane: "previous-stable",
      trigger: "remote-rpc",
    });
    await fixture.run();
    expect(fixture.driver).toHaveBeenCalledOnce();
    expect(fixture.driver).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrapToken: "fixture-distinct-grant",
        uploadReceiptPath: fixture.input.remoteUploadSecretPath,
        workspaceRoot: fixture.input.workspaceRoot,
        onInstallDispatched: expect.any(Function),
      }),
    );
    expect(fixture.files.get(fixture.input.remoteSecretPath)?.mode).toBe(0o600);
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

  it("retains the maintained desktop process names in cleanup plans", () => {
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
      previousStableTrigger: "local-bridge",
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
