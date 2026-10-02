import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import type { RemoteUpdateSnapshot } from "@bibcode/contracts";
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
  readonly hostError?: string;
}) => {
  authenticationFixture(input.ticket, input.token);
  let opened = 0;
  const requests: string[] = [];
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
        requests.push(request.tag);
        const snapshot: RemoteUpdateSnapshot = {
          state: input.hostError ? "error" : "installing",
          error: input.hostError ?? null,
          serverVersion: input.runningVersion,
          latestVersion: "0.7.3-upgrade.49",
          targetVersion: "0.7.3-upgrade.49",
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
                serverVersion: input.runningVersion,
                capabilities: { remoteUpdateProgress: true },
              },
            };
            break;
          case "updater.activeWork":
            value = { runningTurns: 0, liveTerminals: 0, queuedMessages: 0 };
            break;
          case "updater.install":
          case "updater.status":
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
  return { requests, closed };
};

describe("remote install RPC driver", () => {
  afterEach(() => vi.unstubAllGlobals());

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
