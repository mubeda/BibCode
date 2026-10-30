import {
  DIAGNOSTIC_LOGS_CHUNK_BYTES,
  type DiagnosticLogsManifest,
  type DiagnosticLogsRelayEvent,
  DiagnosticLogsRelayError,
  EnvironmentId,
  type ServerConfig,
  WS_METHODS,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { diagnosticLogsError } from "./logs.ts";
import {
  claimDiagnosticLogsRelay,
  relayFailureItem,
  relayItemsForArchive,
  resolveRelayEnvironment,
  sendDiagnosticLogsRelayItem,
  watchDiagnosticLogsRelay,
} from "./relay.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("primary"),
  label: "This Mac",
  connectionId: "bearer:primary",
  serverEnvironmentId: EnvironmentId.make("local"),
});

const MANIFEST: DiagnosticLogsManifest = {
  schemaVersion: 1,
  environmentId: "local",
  storageInstanceId: "storage-omarchy",
  environmentLabel: "omarchy",
  serverVersion: "0.12.0",
  platform: { os: "linux", arch: "x86_64" },
  generatedAt: "2026-10-27T12:00:00Z",
  crashDumps: { requested: false, included: 0 },
};

const primary = Effect.fn("TestRelay.primary")(function* (client: Partial<WsRpcProtocolClient>) {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some({
      client: client as WsRpcProtocolClient,
      initialConfig: Effect.succeed({} as ServerConfig),
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

const CANDIDATES = [
  { environmentId: "primary", label: "This Mac", connected: true },
  { environmentId: "remote:omarchy", label: "Omarchy", connected: true },
  { environmentId: "remote:luna", label: "Luna", connected: false },
  { environmentId: "remote:twin-a", label: "Twin", connected: true },
  { environmentId: "remote:twin-b", label: "twin ", connected: true },
];

describe("resolveRelayEnvironment", () => {
  it("takes an exact id, then a unique label ignoring case", () => {
    expect(resolveRelayEnvironment("remote:omarchy", CANDIDATES)).toMatchObject({
      kind: "found",
      environment: { label: "Omarchy" },
    });
    expect(resolveRelayEnvironment(" omarchy ", CANDIDATES)).toMatchObject({
      kind: "found",
      environment: { environmentId: "remote:omarchy" },
    });
  });

  it("names only what was asked for when the name matches none or several", () => {
    const unknown = resolveRelayEnvironment("Mars", CANDIDATES);
    expect(unknown).toEqual({
      kind: "unknown-environment",
      message: "BiBCode has no environment named Mars.",
    });
    expect(JSON.stringify(unknown)).not.toContain("Omarchy");
    expect(resolveRelayEnvironment("twin", CANDIDATES).kind).toBe("ambiguous-environment");
  });

  it("never stands in another environment for one that is not connected", () => {
    expect(resolveRelayEnvironment("Luna", CANDIDATES)).toMatchObject({
      kind: "not-connected",
      message: "Luna is not connected in BiBCode. Reconnect it, then try again.",
    });
  });
});

describe("relay items", () => {
  it("sends a verified archive as Started, bounded Data items, and Finished", () => {
    const bytes = new Uint8Array(2 * DIAGNOSTIC_LOGS_CHUNK_BYTES + 5).fill(9);
    const items = [...relayItemsForArchive({ fileName: "logs.zip", bytes, manifest: MANIFEST })];
    expect(items[0]).toEqual({
      _tag: "Started",
      fileName: "logs.zip",
      byteLength: bytes.byteLength,
      manifest: MANIFEST,
    });
    expect(items.map((item) => item._tag)).toEqual(["Started", "Data", "Data", "Data", "Finished"]);
    const decoded = items
      .filter((item) => item._tag === "Data")
      .map((item) => atob(item.data).length);
    expect(decoded).toEqual([DIAGNOSTIC_LOGS_CHUNK_BYTES, DIAGNOSTIC_LOGS_CHUNK_BYTES, 5]);
  });

  it("carries the download's own reason and copy", () => {
    expect(
      relayFailureItem(diagnosticLogsError("wrong-environment", "Omarchy"), "Omarchy"),
    ).toEqual({
      _tag: "Failed",
      reason: "wrong-environment",
      message: "The logs that arrived are not from Omarchy. Nothing was saved. Try again.",
    });
    expect(relayFailureItem(new Error("socket"), "Omarchy")).toMatchObject({
      reason: "connection-lost",
    });
  });
});

describe("relay calls", () => {
  it.effect("delivers every announced event to the app", () =>
    Effect.gen(function* () {
      const announced: DiagnosticLogsRelayEvent[] = [
        {
          _tag: "Pending",
          request: {
            requestId: "relay_1",
            environment: "Omarchy",
            includeCrashDumps: false,
            code: "K7Q-4M",
            outputDirectory: "/Users/me/logs",
          },
        },
        { _tag: "Claimed", requestId: "relay_1" },
        { _tag: "Closed", requestId: "relay_1" },
      ];
      const supervisor = yield* primary({
        [WS_METHODS.serverSubscribeDiagnosticLogsRelay]: () => Stream.fromIterable(announced),
      } as unknown as Partial<WsRpcProtocolClient>);
      const seen: DiagnosticLogsRelayEvent[] = [];
      yield* watchDiagnosticLogsRelay((event) => seen.push(event)).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(seen).toEqual(announced);
    }),
  );

  it.effect("claims, sends, and names a refusal by its reason", () =>
    Effect.gen(function* () {
      const sent: unknown[] = [];
      const supervisor = yield* primary({
        [WS_METHODS.serverClaimDiagnosticLogsRelay]: () => Effect.succeed({ claimed: true }),
        [WS_METHODS.serverSendDiagnosticLogsRelayItem]: (input: unknown) => {
          sent.push(input);
          return sent.length === 1
            ? Effect.succeed({})
            : Effect.fail(
                new DiagnosticLogsRelayError({ reason: "cancelled", message: "The command left." }),
              );
        },
      } as unknown as Partial<WsRpcProtocolClient>);
      const provide = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );
      expect(yield* claimDiagnosticLogsRelay("relay_1").pipe(provide)).toBe(true);
      yield* sendDiagnosticLogsRelayItem("relay_1", { _tag: "Denied" }).pipe(provide);
      const refused = yield* sendDiagnosticLogsRelayItem("relay_1", { _tag: "Finished" }).pipe(
        provide,
        Effect.flip,
      );
      expect(refused.reason).toBe("cancelled");
      expect(sent).toEqual([
        { requestId: "relay_1", item: { _tag: "Denied" } },
        { requestId: "relay_1", item: { _tag: "Finished" } },
      ]);
    }),
  );
});
