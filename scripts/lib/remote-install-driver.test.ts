// @effect-diagnostics nodeBuiltinImport:off - The generated qualification handoff runs in an inert VM.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeVM from "node:vm";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import type { RemoteUpdateSnapshot } from "@bibcode/contracts";
import {
  assertWebDriverPhaseExit,
  createSeededUpgradeDriverSpec,
} from "../seeded-desktop-upgrade-smoke.ts";
import {
  decodeExit,
  encodeRequest,
  identityFromConfig,
  runRemoteInstallDriver,
} from "./remote-install-driver.ts";

const decodeFixtureJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const readAuthFixture = Effect.fn("RemoteInstallTest.readAuthFixture")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filename = yield* path.fromFileUrl(
    new URL(`../../packages/contracts/fixtures/auth-http/responses/${name}.json`, import.meta.url),
  );
  return yield* decodeFixtureJson(yield* fs.readFileString(filename));
}, Effect.provide(NodeServices.layer));

const authenticationFixture = (ticket: unknown, token: unknown) => {
  vi.stubGlobal("fetch", async (input: URL) => {
    if (input.pathname === "/oauth/token") return Response.json(token);
    if (input.pathname === "/api/auth/websocket-ticket") return Response.json(ticket);
    throw new Error("Unexpected fixture endpoint.");
  });
  const connected = vi.fn<(url: URL) => void>();
  vi.stubGlobal(
    "WebSocket",
    class {
      static readonly OPEN = 1;
      constructor(url: URL) {
        connected(url);
        // Stop at the real driver's next boundary: never start a socket or coordinator.
        throw new Error("Reached fixture socket boundary.");
      }
    },
  );
  return connected;
};

const terminalFixture = (input: {
  readonly ticket: unknown;
  readonly token: unknown;
  readonly runningVersion: string;
  readonly beforeVersion?: string;
  readonly candidateVersion?: string;
  readonly hostError?: string;
  readonly checkSnapshots?: ReadonlyArray<Partial<RemoteUpdateSnapshot>>;
  readonly disconnectDuringCheck?: boolean;
  readonly holdStatusAfter?: number;
  readonly rejectInstallDispatch?: boolean;
}) => {
  authenticationFixture(input.ticket, input.token);
  let opened = 0;
  let checked = false;
  let installed = false;
  let checkReads = 0;
  let availableVersion: string | null = null;
  const requests: string[] = [];
  const installSnapshots: RemoteUpdateSnapshot[] = [];
  const closed = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class extends EventTarget {
      static readonly OPEN = 1;
      readyState = 1;
      readonly boot = ++opened;
      constructor(_url: URL) {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        closed(this.boot);
        this.dispatchEvent(new Event("close"));
      }
      send(raw: string) {
        const request = JSON.parse(raw) as { _tag: string; tag: string; id: string };
        if (request._tag !== "Request") return;
        if (request.tag === "updater.install" && input.rejectInstallDispatch)
          throw new Error("Fixture install send was rejected.");
        requests.push(request.tag);
        const serverVersion =
          this.boot === 1 ? (input.beforeVersion ?? input.runningVersion) : input.runningVersion;
        const snapshot: RemoteUpdateSnapshot = {
          state: input.hostError ? "error" : availableVersion === null ? "idle" : "installing",
          error: input.hostError ?? null,
          serverVersion,
          latestVersion: availableVersion,
          targetVersion: availableVersion,
          support: { installMode: "interactive", reason: "available", installKind: "unknown" },
          downloadPercent: null,
          installStage: "sentinel-private-stage",
        };
        let value: unknown;
        switch (request.tag) {
          case "server.getConfig":
            value = {
              environment: {
                bootId: `sentinel-private-boot-${this.boot}`,
                storageInstanceId: "sentinel-private-storage",
                serverVersion,
                capabilities: { remoteUpdateProgress: true },
              },
            };
            break;
          case "updater.activeWork":
            value = { runningTurns: 0, liveTerminals: 0, queuedMessages: 0 };
            break;
          case "updater.check":
          case "updater.status": {
            if (request.tag === "updater.check") {
              checked = true;
              if (input.disconnectDuringCheck) {
                queueMicrotask(() => this.close());
                return;
              }
            }
            if (!checked || installed) {
              value = snapshot;
              break;
            }
            if (input.holdStatusAfter !== undefined && checkReads >= input.holdStatusAfter) return;
            const candidateVersion = input.candidateVersion ?? "0.7.3-upgrade.49";
            const overrides =
              input.checkSnapshots?.[Math.min(checkReads++, input.checkSnapshots.length - 1)];
            const check = {
              ...snapshot,
              state: "update-available" as const,
              error: null,
              latestVersion: candidateVersion,
              targetVersion: candidateVersion,
              installStage: null,
              ...overrides,
            };
            if (check.state === "update-available") {
              availableVersion = check.targetVersion ?? check.latestVersion;
            }
            value = check;
            break;
          }
          case "updater.install":
            installed = true;
            installSnapshots.push(snapshot);
            value = snapshot;
            break;
          default:
            throw new Error("Unexpected fixture RPC.");
        }
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: { _tag: "Success", value },
              }),
            }),
          );
          if (request.tag === "updater.install" && !input.hostError) this.close();
        });
      }
    },
  );
  return { requests, closed, installSnapshots };
};

/** Runs the actual generated marker handoff with the real driver and inert transport. */
const generatedInstallFixture = (failMarkerWrite = false) => {
  const input = {
    candidateVersion: "0.7.3-upgrade.51",
    expectedDataRoot: "/fixture/data",
    lane: "remote-install" as const,
    phase: "seed-and-install" as const,
    projectId: "fixture-project",
    resultPath: "/fixture/before.json",
    workspaceRoot: "/fixture/workspace",
    platform: "linux" as const,
    appBinaryPath: "/fixture/RemoteLane.AppImage",
    remoteInstallDriverPath: "fixture:driver",
    remoteHarnessPath: "fixture:host",
    remoteSecretPath: "/fixture/private.json",
    remoteEvidencePath: "/fixture/evidence.json",
  };
  const spec = createSeededUpgradeDriverSpec(input);
  const start = spec.indexOf(
    "    NodeFS.writeFileSync(input.resultPath, JSON.stringify({ ...observation, installAttempted:",
  );
  const end = spec.indexOf("\n  });\n});", start);
  if (start < 0 || end < 0) throw new Error("The generated install handoff is missing.");
  const source = spec.slice(start, end).replaceAll("await import(", "await loadFixture(");
  const markers: boolean[] = [];
  const attempts: boolean[] = [];
  const context = {
    input,
    credentials: { endpoint: "http://127.0.0.1:43123", bootstrapToken: "fixture-sharing-grant" },
    observation: { projectId: "fixture-project" },
    widened: false,
    NodeFS: {
      writeFileSync: (path: string, contents: string) => {
        if (path !== input.resultPath) return;
        const value = JSON.parse(contents) as { installAttempted: boolean };
        attempts.push(value.installAttempted);
        if (value.installAttempted && failMarkerWrite)
          throw new Error("Fixture marker write failed.");
        markers.push(value.installAttempted);
      },
    },
    loadFixture: async (path: string) => {
      if (path === input.remoteInstallDriverPath) return { runRemoteInstallDriver };
      if (path === input.remoteHarnessPath)
        return { captureRemoteInstallHostEvidence: async () => ({ requesterLogLines: 1 }) };
      throw new Error("Unexpected fixture import.");
    },
  };
  return {
    markers,
    attempts,
    run: () =>
      NodeVM.runInNewContext(`(async () => { ${source} })()`, context, {
        timeout: 1_000,
      }) as Promise<void>,
  };
};

describe("remote install RPC driver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  for (const [name, options] of [
    ["refused precheck", { checkSnapshots: [{ state: "up-to-date" as const }] }],
    ["disconnected precheck", { disconnectDuringCheck: true }],
    ["rejected install dispatch", { rejectInstallDispatch: true }],
  ] as const) {
    it.effect(`leaves the generated install marker false after ${name}`, () =>
      Effect.gen(function* () {
        const transport = terminalFixture({
          ticket: yield* readAuthFixture("websocket-ticket"),
          token: yield* readAuthFixture("token"),
          beforeVersion: "0.7.2",
          runningVersion: "0.7.3-upgrade.51",
          candidateVersion: "0.7.3-upgrade.51",
          ...options,
        });
        const generated = generatedInstallFixture();
        yield* Effect.promise(() => expect(generated.run()).rejects.toThrow());
        expect(generated.markers).toEqual([false]);
        expect(generated.attempts).toEqual([false]);
        expect(() =>
          assertWebDriverPhaseExit({
            exitCode: 1,
            installAttempted: generated.markers.at(-1) === true,
            lane: "remote-install",
            phase: "seed-and-install",
          }),
        ).toThrow("WebDriver phase exited with code 1");
        expect(transport.requests).not.toContain("updater.install");
        expect(transport.closed).toHaveBeenCalledOnce();
      }),
    );
  }

  for (const failMarkerWrite of [false, true]) {
    it.effect(
      `records the actual install dispatch once without changing the updater outcome (${failMarkerWrite ? "failed" : "successful"} marker write)`,
      () =>
        Effect.gen(function* () {
          const transport = terminalFixture({
            ticket: yield* readAuthFixture("websocket-ticket"),
            token: yield* readAuthFixture("token"),
            beforeVersion: "0.7.2",
            runningVersion: "0.7.3-upgrade.51",
            candidateVersion: "0.7.3-upgrade.51",
          });
          const generated = generatedInstallFixture(failMarkerWrite);
          yield* Effect.promise(() => generated.run());
          expect(generated.attempts).toEqual([false, true]);
          expect(generated.markers).toEqual(failMarkerWrite ? [false] : [false, true]);
          expect(transport.requests.filter((tag) => tag === "updater.install")).toHaveLength(1);
          expect(transport.closed.mock.calls).toEqual([[1], [2]]);
        }),
    );
  }

  it.effect("checks the cold host before a fast candidate restart can hide its target", () =>
    Effect.gen(function* () {
      const fixture = terminalFixture({
        ticket: yield* readAuthFixture("websocket-ticket"),
        token: yield* readAuthFixture("token"),
        beforeVersion: "0.7.2",
        runningVersion: "0.7.3-upgrade.51",
        candidateVersion: "0.7.3-upgrade.51",
      });
      const result = yield* Effect.promise(() =>
        runRemoteInstallDriver({
          endpoint: "http://127.0.0.1:43123",
          bootstrapToken: "fixture-sharing-grant",
          candidateVersion: "0.7.3-upgrade.51",
        }),
      );
      expect(result.before.serverVersion).toBe("0.7.2");
      expect(result.after.serverVersion).toBe("0.7.3-upgrade.51");
      expect(result.phases).toEqual(["starting", "restarting", "verifying", "succeeded"]);
      expect(fixture.requests.indexOf("updater.check")).toBeLessThan(
        fixture.requests.indexOf("updater.install"),
      );
      expect(fixture.installSnapshots[0]?.targetVersion).toBe("0.7.3-upgrade.51");
      expect(fixture.closed.mock.calls).toEqual([[1], [2]]);
    }),
  );

  it.effect("waits for an already running check to publish the candidate before installing", () =>
    Effect.gen(function* () {
      const fixture = terminalFixture({
        ticket: yield* readAuthFixture("websocket-ticket"),
        token: yield* readAuthFixture("token"),
        beforeVersion: "0.7.2",
        runningVersion: "0.7.3-upgrade.49",
        checkSnapshots: [
          { state: "checking", latestVersion: null, targetVersion: null },
          { state: "checking", latestVersion: null, targetVersion: null },
          {},
        ],
      });
      const result = yield* Effect.promise(() =>
        runRemoteInstallDriver({
          endpoint: "http://127.0.0.1:43123",
          bootstrapToken: "fixture-sharing-grant",
          candidateVersion: "0.7.3-upgrade.49",
        }),
      );
      expect(result.phases.at(-1)).toBe("succeeded");
      const beforeInstall = fixture.requests.slice(0, fixture.requests.indexOf("updater.install"));
      expect(beforeInstall.filter((tag) => tag === "updater.check")).toHaveLength(1);
      expect(beforeInstall.filter((tag) => tag === "updater.status").length).toBeGreaterThanOrEqual(
        2,
      );
    }),
  );

  for (const [name, snapshot] of [
    ["host error", { state: "error", error: "sentinel-private-host-error" }],
    ["up to date", { state: "up-to-date" }],
    ["unchecked", { state: "idle", latestVersion: null, targetVersion: null }],
    ["missing target", { latestVersion: null, targetVersion: null }],
    ["wrong target", { latestVersion: "0.7.3-upgrade.50", targetVersion: "0.7.3-upgrade.50" }],
    ["conflicting target", { targetVersion: "0.7.3-upgrade.50" }],
    ["invalid snapshot", { serverVersion: "" }],
    [
      "manual host",
      {
        support: {
          installMode: "manual",
          reason: "manual-update-required",
          installKind: "unknown",
        },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, Partial<RemoteUpdateSnapshot>]>) {
    it.effect(`refuses ${name} before requesting installation`, () =>
      Effect.gen(function* () {
        const fixture = terminalFixture({
          ticket: yield* readAuthFixture("websocket-ticket"),
          token: yield* readAuthFixture("token"),
          runningVersion: "0.7.2",
          checkSnapshots: [snapshot],
        });
        yield* Effect.promise(() =>
          expect(
            runRemoteInstallDriver({
              endpoint: "http://127.0.0.1:43123",
              bootstrapToken: "fixture-sharing-grant",
              candidateVersion: "0.7.3-upgrade.49",
            }),
          ).rejects.toThrow("The candidate update was not available before remote installation."),
        );
        expect(fixture.requests).not.toContain("updater.install");
        expect(fixture.closed).toHaveBeenCalledOnce();
      }),
    );
  }

  it.effect("stops after a disconnected availability check without installing", () =>
    Effect.gen(function* () {
      const fixture = terminalFixture({
        ticket: yield* readAuthFixture("websocket-ticket"),
        token: yield* readAuthFixture("token"),
        runningVersion: "0.7.2",
        disconnectDuringCheck: true,
      });
      yield* Effect.promise(() =>
        expect(
          runRemoteInstallDriver({
            endpoint: "http://127.0.0.1:43123",
            bootstrapToken: "fixture-sharing-grant",
            candidateVersion: "0.7.3-upgrade.49",
          }),
        ).rejects.toThrow("The candidate update was not available before remote installation."),
      );
      expect(fixture.requests).not.toContain("updater.install");
      expect(fixture.closed).toHaveBeenCalledOnce();
    }),
  );

  for (const holdStatusAfter of [undefined, 110]) {
    it.effect(
      `bounds the entire availability check and releases pending reads (${holdStatusAfter ?? "checking"})`,
      () =>
        Effect.gen(function* () {
          const fixture = terminalFixture({
            ticket: yield* readAuthFixture("websocket-ticket"),
            token: yield* readAuthFixture("token"),
            runningVersion: "0.7.2",
            checkSnapshots: [{ state: "checking", latestVersion: null, targetVersion: null }],
            ...(holdStatusAfter === undefined ? {} : { holdStatusAfter }),
          });
          yield* Effect.promise(async () => {
            vi.useFakeTimers();
            const result = runRemoteInstallDriver({
              endpoint: "http://127.0.0.1:43123",
              bootstrapToken: "fixture-sharing-grant",
              candidateVersion: "0.7.3-upgrade.49",
            }).catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(30_001);
            expect(await result).toEqual(
              new Error("The candidate update was not available before remote installation."),
            );
            expect(fixture.requests).not.toContain("updater.install");
            expect(fixture.closed).toHaveBeenCalledOnce();
            const requestCount = fixture.requests.length;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(fixture.requests).toHaveLength(requestCount);
          });
        }),
    );
  }

  it.effect(
    "decodes the public HTTP ticket fixture before opening its own authenticated socket",
    () =>
      Effect.gen(function* () {
        const ticketFixture = (yield* readAuthFixture("websocket-ticket")) as { ticket: string };
        const connected = authenticationFixture(ticketFixture, yield* readAuthFixture("token"));
        yield* Effect.promise(() =>
          expect(
            runRemoteInstallDriver({
              endpoint: "http://127.0.0.1:43123",
              bootstrapToken: "fixture-sharing-grant",
              candidateVersion: "0.7.3-upgrade.49",
            }),
          ).rejects.toThrow("Reached fixture socket boundary."),
        );
        expect(connected).toHaveBeenCalledOnce();
        const url = connected.mock.calls[0]![0];
        expect(url.origin).toBe("ws://127.0.0.1:43123");
        expect(url.pathname).toBe("/ws");
        expect(url.searchParams.get("wsTicket")).toBe(ticketFixture.ticket);
      }),
  );

  it.effect("rejects a malformed HTTP ticket date without retaining response details", () =>
    Effect.gen(function* () {
      const ticketFixture = (yield* readAuthFixture("websocket-ticket")) as { ticket: string };
      const connected = authenticationFixture(
        {
          ...ticketFixture,
          expiresAt: "fixture-private-date-detail",
        },
        yield* readAuthFixture("token"),
      );
      yield* Effect.promise(() =>
        expect(
          runRemoteInstallDriver({
            endpoint: "http://127.0.0.1:43123",
            bootstrapToken: "fixture-sharing-grant",
            candidateVersion: "0.7.3-upgrade.49",
          }),
        ).rejects.toThrow("Invalid verification ticket response."),
      );
      expect(connected).not.toHaveBeenCalled();
    }),
  );

  it.effect("retains the real coordinator's wrong-version verdict after a distinct boot", () =>
    Effect.gen(function* () {
      const fixture = terminalFixture({
        ticket: yield* readAuthFixture("websocket-ticket"),
        token: yield* readAuthFixture("token"),
        runningVersion: "0.7.2",
      });
      const failure = yield* Effect.promise(async () => {
        try {
          await runRemoteInstallDriver({
            endpoint: "http://127.0.0.1:43123",
            bootstrapToken: "sentinel-private-grant",
            candidateVersion: "0.7.3-upgrade.49",
          });
        } catch (error) {
          return error;
        }
        throw new Error("Expected remote verification to fail.");
      });
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain('"phase":"failed"');
      expect(message).toContain('"failureKind":"wrong-version"');
      expect(message).toContain('"runningVersion":"0.7.2"');
      expect(message).toContain('"targetVersion":"0.7.3-upgrade.49"');
      expect(message).toContain('"phases":["starting","restarting","verifying","failed"]');
      expect(message).not.toContain("sentinel-private");
      expect(message.length).toBeLessThan(1024);
      expect(fixture.requests).toContain("updater.install");
      expect(fixture.closed.mock.calls).toEqual([[1], [2]]);
    }),
  );

  for (const runningVersion of ["0.7.2", "sentinel-private-version", `0.7.2-${"x".repeat(128)}`]) {
    it.effect(
      `omits host error details and bounds version evidence (${runningVersion.length})`,
      () =>
        Effect.gen(function* () {
          const fixture = terminalFixture({
            ticket: yield* readAuthFixture("websocket-ticket"),
            token: yield* readAuthFixture("token"),
            runningVersion,
            hostError: "sentinel-private-auth grant=secret bearer=secret",
          });
          const failure = yield* Effect.promise(async () => {
            try {
              await runRemoteInstallDriver({
                endpoint: "http://127.0.0.1:43123",
                bootstrapToken: "sentinel-private-grant",
                candidateVersion: "0.7.3-upgrade.49",
              });
            } catch (error) {
              return error;
            }
            throw new Error("Expected remote verification to fail.");
          });
          const message = (failure as Error).message;
          expect(message).toContain('"failureKind":"host-error"');
          expect(message).toContain(
            `"runningVersion":${runningVersion === "0.7.2" ? '"0.7.2"' : "null"}`,
          );
          expect(message).toContain('"phases":["starting","failed"]');
          expect(message).not.toMatch(/sentinel-private|secret|bearer|grant/);
          expect(message).not.toContain("x".repeat(128));
          expect(message.length).toBeLessThan(1024);
          expect(fixture.closed).toHaveBeenCalledOnce();
        }),
    );
  }

  it("encodes the real request envelope and reads only a matching successful exit", () => {
    expect(JSON.parse(encodeRequest("7", "updater.status"))).toEqual({
      _tag: "Request",
      id: "7",
      tag: "updater.status",
      payload: {},
      headers: [],
    });
    expect(
      decodeExit(
        { _tag: "Exit", requestId: "7", exit: { _tag: "Success", value: { state: "idle" } } },
        "7",
      ),
    ).toEqual({ state: "idle" });
    expect(
      decodeExit({ _tag: "Exit", requestId: "8", exit: { _tag: "Success", value: {} } }, "7"),
    ).toBeUndefined();
    expect(() =>
      decodeExit({ _tag: "Exit", requestId: "7", exit: { _tag: "Failure", cause: [] } }, "7"),
    ).toThrow();
  });
  it("retains boot/version/capability and supports older descriptors", () => {
    expect(
      identityFromConfig({
        environment: {
          bootId: "b1",
          serverVersion: "0.7.2",
          capabilities: { remoteUpdateProgress: true },
        },
      }),
    ).toEqual({ bootId: "b1", serverVersion: "0.7.2", progress: true });
    expect(
      identityFromConfig({ environment: { serverVersion: "0.6.0", capabilities: {} } }),
    ).toEqual({ bootId: null, serverVersion: "0.6.0", progress: false });
    expect(() => identityFromConfig({ environment: {} })).toThrow();
  });
});
