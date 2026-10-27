import {
  DIAGNOSTIC_LOGS_CHUNK_BYTES,
  type DiagnosticLogsDownloadEvent,
  type DiagnosticLogsManifest,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ServerConfig,
  WS_METHODS,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { DiagnosticLogsAssembler, downloadDiagnosticLogs } from "./logs.ts";

const decodeNumber = Schema.decodeUnknownEffect(Schema.Number);
const STORAGE_ID = "8d5c2f63-9a0e-4d7c-b1a4-3f6e2a9d0c11";
const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make(`remote:${STORAGE_ID}`),
  label: "Omarchy",
  connectionId: `bearer:remote:${STORAGE_ID}`,
  serverEnvironmentId: EnvironmentId.make("local"),
});

const MANIFEST: DiagnosticLogsManifest = {
  schemaVersion: 1,
  environmentId: "local",
  storageInstanceId: STORAGE_ID,
  environmentLabel: "omarchy",
  serverVersion: "0.12.0",
  platform: { os: "linux", arch: "x86_64" },
  generatedAt: "2026-10-27T12:00:00Z",
  crashDumps: { requested: false, included: 0 },
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function archive(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) % 256;
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return bytes;
}

function events(bytes: Uint8Array, manifest = MANIFEST): DiagnosticLogsDownloadEvent[] {
  const items: DiagnosticLogsDownloadEvent[] = [
    {
      _tag: "Started",
      fileName: "bibcode-diagnostics-omarchy-20261027T120000Z.zip",
      byteLength: bytes.byteLength,
      manifest,
    },
  ];
  for (let offset = 0; offset < bytes.byteLength; offset += DIAGNOSTIC_LOGS_CHUNK_BYTES) {
    items.push({
      _tag: "Data",
      data: base64(bytes.subarray(offset, offset + DIAGNOSTIC_LOGS_CHUNK_BYTES)),
    });
  }
  return items;
}

function config(
  capabilities: { readonly diagnosticLogs: boolean },
  storageInstanceId: string | null,
): ServerConfig {
  return { environment: { capabilities, storageInstanceId } } as unknown as ServerConfig;
}

const makeHarness = Effect.fn("TestDiagnosticLogs.makeHarness")(function* (
  client: Partial<WsRpcProtocolClient> | null,
  serverConfig: ServerConfig = config({ diagnosticLogs: true }, STORAGE_ID),
) {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    client === null
      ? Option.none()
      : Option.some({
          client: client as WsRpcProtocolClient,
          initialConfig: Effect.succeed(serverConfig),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
          e2eeAuthenticated: Effect.succeed(null),
        }),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

/** A protocol client that serves `server.downloadDiagnosticLogs` and counts its calls. */
function downloadClient(stream: () => Stream.Stream<DiagnosticLogsDownloadEvent, unknown>) {
  const calls: unknown[] = [];
  const client = {
    [WS_METHODS.serverDownloadDiagnosticLogs]: (input: unknown) => {
      calls.push(input);
      return stream();
    },
  } as unknown as Partial<WsRpcProtocolClient>;
  return { calls, client };
}

const run = (
  supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
  includeCrashDumps = false,
) =>
  downloadDiagnosticLogs({ frontendLog: "client warning\n", includeCrashDumps }).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.flip,
  );

describe("downloadDiagnosticLogs", () => {
  it.effect("assembles the connected environment's archive from its stream", () =>
    Effect.gen(function* () {
      const bytes = archive(2 * DIAGNOSTIC_LOGS_CHUNK_BYTES + 123);
      const { calls, client } = downloadClient(() => Stream.fromIterable(events(bytes)));
      const supervisor = yield* makeHarness(client);

      const result = yield* downloadDiagnosticLogs({ frontendLog: "client warning\n" }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(result.fileName).toBe("bibcode-diagnostics-omarchy-20261027T120000Z.zip");
      expect(result.manifest.storageInstanceId).toBe(STORAGE_ID);
      expect(result.bytes).toEqual(bytes);
      expect(calls).toEqual([{ frontendLog: "client warning\n" }]);
    }),
  );

  it.effect("never asks a server without the capability", () =>
    Effect.gen(function* () {
      const { calls, client } = downloadClient(() => Stream.empty);
      const supervisor = yield* makeHarness(client, config({ diagnosticLogs: false }, STORAGE_ID));
      const error = yield* run(supervisor);
      expect(error.reason).toBe("unsupported");
      expect(error.message).toBe(
        "Omarchy runs an older BiBCode server that cannot send its logs. Update it to download them here.",
      );
      expect(calls).toEqual([]);
    }),
  );

  it.effect("fails closed when the connection reports no storage id", () =>
    Effect.gen(function* () {
      const { calls, client } = downloadClient(() => Stream.empty);
      const supervisor = yield* makeHarness(client, config({ diagnosticLogs: true }, null));
      expect((yield* run(supervisor)).reason).toBe("unverified");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("refuses an archive whose manifest names another store", () =>
    Effect.gen(function* () {
      const { client } = downloadClient(() =>
        Stream.fromIterable(events(archive(64), { ...MANIFEST, storageInstanceId: "other" })),
      );
      expect((yield* run(yield* makeHarness(client))).reason).toBe("wrong-environment");
    }),
  );

  it.effect("refuses an archive whose manifest has no store id", () =>
    Effect.gen(function* () {
      const { client } = downloadClient(() =>
        Stream.fromIterable(events(archive(64), { ...MANIFEST, storageInstanceId: null })),
      );
      expect((yield* run(yield* makeHarness(client))).reason).toBe("wrong-environment");
    }),
  );

  it.effect("names the environment when it is not connected", () =>
    Effect.gen(function* () {
      const error = yield* run(yield* makeHarness(null));
      expect(error.reason).toBe("not-connected");
      expect(error.message).toBe("Omarchy is not connected. Reconnect it to download its logs.");
    }),
  );

  it.effect("reports a connection lost after Started, with nothing assembled", () =>
    Effect.gen(function* () {
      const [started, first] = events(archive(DIAGNOSTIC_LOGS_CHUNK_BYTES + 10));
      const { client } = downloadClient(() =>
        Stream.fromIterable([started!, first!]).pipe(
          Stream.concat(
            Stream.fail(
              new RpcClientError.RpcClientError({
                reason: new RpcClientError.RpcClientDefect({
                  message: "socket closed",
                  cause: new Error("socket closed"),
                }),
              }),
            ),
          ),
        ),
      );
      const error = yield* run(yield* makeHarness(client));
      expect(error.reason).toBe("connection-lost");
      expect(error.message).toBe("The connection to Omarchy was lost. Reconnect and try again.");
    }),
  );

  it.effect("reports a stream that ends short of its byte length as incomplete", () =>
    Effect.gen(function* () {
      const [started, first] = events(archive(DIAGNOSTIC_LOGS_CHUNK_BYTES + 10));
      const { client } = downloadClient(() => Stream.fromIterable([started!, first!]));
      expect((yield* run(yield* makeHarness(client))).reason).toBe("incomplete");
    }),
  );

  it.effect("tells a read-only connection that crash dumps need more access", () =>
    Effect.gen(function* () {
      const { client } = downloadClient(() =>
        Stream.fail(
          new EnvironmentAuthorizationError({
            message: "The authenticated token is missing required scope: orchestration:operate.",
            requiredScope: "orchestration:operate",
          }),
        ),
      );
      const error = yield* run(yield* makeHarness(client), true);
      expect(error.reason).toBe("crash-dumps-refused");
    }),
  );

  it.effect("tells a too-large download to drop crash dumps only when it asked for them", () =>
    Effect.gen(function* () {
      const tooLarge = () =>
        Stream.fail({ _tag: "DiagnosticLogsError", reason: "too-large", message: "big" });
      const withDumps = yield* run(yield* makeHarness(downloadClient(tooLarge).client), true);
      expect(withDumps.message).toBe(
        "Omarchy's logs are over the 20 MiB download limit. Turn off Include crash dumps and try again.",
      );
      const without = yield* run(yield* makeHarness(downloadClient(tooLarge).client), false);
      expect(without.reason).toBe("too-large");
      expect(without.message).not.toContain("crash dumps");
    }),
  );

  it.effect("reports an item that does not decode as an incomplete archive", () =>
    Effect.gen(function* () {
      // What the RPC client does with a chunk that fails its schema: a defect.
      const schemaError = yield* Effect.flip(decodeNumber("x"));
      const { client } = downloadClient(() => Stream.die(schemaError));
      expect((yield* run(yield* makeHarness(client))).reason).toBe("incomplete");
    }),
  );

  it.effect("reports any other defect as the server's failure, not a lost connection", () =>
    Effect.gen(function* () {
      const { client } = downloadClient(() => Stream.die(new Error("boom")));
      expect((yield* run(yield* makeHarness(client))).reason).toBe("server-failed");
    }),
  );

  it.effect("reports an interrupted stream as a lost connection", () =>
    Effect.gen(function* () {
      const { client } = downloadClient(() => Stream.fromEffect(Effect.interrupt));
      expect((yield* run(yield* makeHarness(client))).reason).toBe("connection-lost");
    }),
  );
});

describe("DiagnosticLogsAssembler", () => {
  const start = (assembler: DiagnosticLogsAssembler, byteLength: number) =>
    assembler.accept({
      _tag: "Started",
      fileName: "bibcode-diagnostics-omarchy-20261027T120000Z.zip",
      byteLength,
      manifest: MANIFEST,
    });

  it("refuses an item longer than the item bound before decoding it", () => {
    const assembler = new DiagnosticLogsAssembler("Omarchy", STORAGE_ID);
    expect(start(assembler, 2 * DIAGNOSTIC_LOGS_CHUNK_BYTES)).toBeNull();
    // One byte over the bound: 524,289 bytes, whose base64 is no longer than a full item's.
    const oversized = base64(new Uint8Array(DIAGNOSTIC_LOGS_CHUNK_BYTES + 1));
    const originalAtob = globalThis.atob;
    let decoded = 0;
    globalThis.atob = (data: string) => {
      decoded += 1;
      return originalAtob(data);
    };
    try {
      expect(assembler.accept({ _tag: "Data", data: oversized })?.reason).toBe("incomplete");
    } finally {
      globalThis.atob = originalAtob;
    }
    expect(decoded).toBe(0);
  });

  it("refuses an item that would overrun the announced length", () => {
    const assembler = new DiagnosticLogsAssembler("Omarchy", STORAGE_ID);
    expect(start(assembler, 4)).toBeNull();
    expect(assembler.accept({ _tag: "Data", data: base64(new Uint8Array(5)) })?.reason).toBe(
      "incomplete",
    );
  });

  it("refuses an archive over the download limit before allocating it", () => {
    const assembler = new DiagnosticLogsAssembler("Omarchy", STORAGE_ID);
    expect(start(assembler, 20 * 1024 * 1024 + 1)?.reason).toBe("too-large");
  });

  it("refuses data before Started, a second Started, and invalid base64", () => {
    const early = new DiagnosticLogsAssembler("Omarchy", STORAGE_ID);
    expect(early.accept({ _tag: "Data", data: "AAAA" })?.reason).toBe("incomplete");

    const twice = new DiagnosticLogsAssembler("Omarchy", STORAGE_ID);
    expect(start(twice, 3)).toBeNull();
    expect(start(twice, 3)?.reason).toBe("incomplete");

    const invalid = new DiagnosticLogsAssembler("Omarchy", STORAGE_ID);
    expect(start(invalid, 3)).toBeNull();
    expect(invalid.accept({ _tag: "Data", data: "A$A=" })?.reason).toBe("incomplete");
  });
});
