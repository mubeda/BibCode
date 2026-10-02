import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, vi } from "vite-plus/test";
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
