// @effect-diagnostics nodeBuiltinImport:off - The actual passive installer runs in an inert VM.
import * as NodeVM from "node:vm";
import {
  expect,
  it,
} from "../../../../packages/client-runtime/node_modules/@effect/vitest/dist/index.js";
import * as Clock from "../../../../packages/client-runtime/node_modules/effect/dist/Clock.js";
import * as Effect from "../../../../packages/client-runtime/node_modules/effect/dist/Effect.js";
import * as Random from "../../../../packages/client-runtime/node_modules/effect/dist/Random.js";
import * as Schema from "../../../../packages/client-runtime/node_modules/effect/dist/Schema.js";
import * as TestClock from "../../../../packages/client-runtime/node_modules/effect/dist/testing/TestClock.js";
import * as Socket from "../../../../packages/client-runtime/node_modules/effect/dist/unstable/socket/Socket.js";
import { EnvironmentId } from "../../../../packages/contracts/src/baseSchemas.ts";
import { makeTestExecutionEnvironmentCapabilities } from "../../../../packages/shared/src/testSupport.ts";
import * as RpcSession from "../../../../packages/client-runtime/src/rpc/session.ts";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../../../../packages/client-runtime/src/connection/model.ts";
import { createProxyMeasurements } from "../../../../scripts/throttle-proxy.ts";
import {
  chatUploadObservationScript,
  projectChatUploadObservation,
  type ChatUploadObservation,
} from "./chat-upload-observer.ts";
import { parseChatMatrixCase, runChatMatrixCase, type MatrixPort } from "./chat-upload-matrix.ts";

const encodeMetadata = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Browser-shaped external seam: a close call returns before its close event is delivered. */
class DeferredCloseSocket extends EventTarget {
  readyState = 0;
  protocol = "";
  bufferedAmount = 0;
  binaryType = "blob";
  readonly nativeCloseCodes: number[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
  }
  send(_data: unknown): void {}
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  close(code = 1000): void {
    this.nativeCloseCodes.push(code);
    if (this.readyState >= 2) return;
    this.readyState = 2;
    queueMicrotask(() => {
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
    });
  }
}

function observerPage(now: () => number) {
  const page = { WebSocket: DeferredCloseSocket } as unknown as {
    WebSocket: typeof DeferredCloseSocket;
    __uploadObservations: { read(): unknown };
  };
  NodeVM.runInNewContext(chatUploadObservationScript, {
    window: page,
    URL,
    TextDecoder,
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    performance: { now },
  });
  return { page, read: () => projectChatUploadObservation(page.__uploadObservations.read())! };
}

function freezePort(before: ChatUploadObservation, after: ChatUploadObservation, startedAt = 0) {
  let frozen = false;
  let resumed = false;
  let delivered = false;
  let units = 0;
  const freezes: boolean[] = [];
  const port: MatrixPort = {
    phase() {},
    stageAndSend: async () => {},
    editNewer: async () => {},
    startStream: async () => {},
    stopGeneration: async () => {},
    activateCancel: async () => {},
    readUi: async () => ({
      progressUnits: frozen || delivered ? null : ++units,
      reconnecting: frozen,
      validPreview: false,
      restoredOutgoing: false,
      newerPreserved: false,
      error: false,
      dripCount: 0,
      stopAvailable: false,
      deliveredImage: delivered,
    }),
    receipt: async () => {
      delivered = true;
      return { count: 1, matched: true };
    },
    capture: async () => {},
    observe: async () => (frozen || resumed ? after : before),
    measurements: () => createProxyMeasurements().snapshot(),
    clock: async () => startedAt,
    freeze(value) {
      frozen = value;
      resumed ||= !value;
      freezes.push(value);
    },
    until: async (check) => {
      if (!(await check())) throw new Error("Controlled observation timeout.");
    },
  };
  return { port, freezes };
}

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("owned-close-witness"),
  label: "Owned close witness",
  httpBaseUrl: "http://localhost:4903",
  wsBaseUrl: "ws://localhost:4903",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  descriptor: {
    environmentId: target.environmentId,
    label: target.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    storageInstanceId: "private-store-canary",
    bootId: null,
    remoteUpdateSupport: null,
    remoteProtocolVersion: 1,
    minCompatibleRemoteProtocol: 1,
    capabilities: makeTestExecutionEnvironmentCapabilities({ repositoryIdentity: true }),
  },
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "ws://localhost:4903/ws",
  httpAuthorization: null,
  e2ee: null,
  target,
};

it.effect.each([
  { random: 0, deathMs: 27_000 },
  { random: 0.5, deathMs: 30_000 },
  { random: 0.999999, deathMs: 33_000 },
])(
  "qualifies the actual protocol's 4408 before deferred-event cleanup 1000 at $deathMs",
  ({ random, deathMs }) =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const { page, read } = observerPage(() => clock.currentTimeMillisUnsafe());
      const sockets: DeferredCloseSocket[] = [];
      const before = yield* Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* RpcSession.make.pipe(
            Effect.provideService(Socket.WebSocketConstructor, (url) => {
              const socket = new page.WebSocket(url);
              sockets.push(socket);
              return socket as unknown as WebSocket;
            }),
          );
          const session = yield* factory.connect(prepared);
          for (let attempt = 0; attempt < 100 && sockets.length === 0; attempt++)
            yield* Effect.yieldNow;
          expect(sockets).toHaveLength(1);
          sockets[0]!.open();
          yield* session.connected;
          const initial = read();
          yield* TestClock.adjust(deathMs - 1);
          expect(sockets[0]!.nativeCloseCodes).toEqual([]);
          yield* TestClock.adjust(1);
          expect(yield* Effect.flip(session.closed)).toMatchObject({ reason: "liveness-timeout" });
          return initial;
        }),
      ).pipe(
        Effect.provideService(Random.Random, {
          nextDoubleUnsafe: () => random,
          nextIntUnsafe: () => 0,
        }),
      );
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
      const after = read();
      expect(sockets[0]!.nativeCloseCodes).toEqual([4408, 1000]);
      expect(after.plain).toMatchObject({
        complete: true,
        lastCloseCode: 1000,
        lastCloseAtMs: deathMs,
        close4408: { count: 1, lastAtMs: deathMs, complete: true },
        control: { ping: 2, pong: 0 },
      });
      const { port, freezes } = freezePort(before, after);
      const result = yield* Effect.promise(() =>
        runChatMatrixCase(parseChatMatrixCase("plain-64-dark-freeze"), port),
      );
      expect(result.clientCloseElapsedMs).toBe(deathMs);
      expect(result.clientCloseCode).toBe(4408);
      expect(freezes).toEqual([true, false]);
      expect(encodeMetadata(result)).not.toContain("private");
    }),
);

it.each(["pre-freeze", "ordinary-only", "unknown-time", "reset-clock", "late"] as const)(
  "refuses a freeze without a fresh complete in-window numeric 4408 witness: %s",
  async (scenario) => {
    let now = 10;
    const { page, read } = observerPage(() => now);
    const socket = new page.WebSocket("ws://localhost:4903/ws");
    socket.open();
    if (scenario === "pre-freeze") socket.close(4408);
    const before = read();
    const startedAt = scenario === "pre-freeze" || scenario === "reset-clock" ? 100 : 0;
    now = scenario === "unknown-time" ? NaN : scenario === "late" ? 34_000 : 90;
    if (scenario !== "pre-freeze" && scenario !== "ordinary-only") socket.close(4408);
    socket.close(1000);
    const { port, freezes } = freezePort(before, read(), startedAt);
    await expect(
      runChatMatrixCase(parseChatMatrixCase("plain-64-dark-freeze"), port),
    ).rejects.toThrow();
    expect(freezes).toEqual([true, false]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  },
);

for (const transport of ["plain", "noise"] as const) {
  it.each([
    { scenario: "reset", baselineAt: 1000, startedAt: 0, elapsed: null },
    { scenario: "no prior call", baselineAt: null, startedAt: 0, elapsed: 1500 },
    { scenario: "equal baseline", baselineAt: 1000, startedAt: 1000, elapsed: 500 },
    { scenario: "earlier baseline", baselineAt: 1000, startedAt: 1200, elapsed: 300 },
  ])(
    `checks the acquired freeze clock against actual ${transport} witness snapshots: $scenario`,
    async ({ baselineAt, startedAt, elapsed }) => {
      let now = baselineAt ?? 0;
      const { page, read } = observerPage(() => now);
      const socket = new page.WebSocket(
        transport === "plain" ? "ws://localhost:4903/ws" : "ws://localhost:4911/ws-e2ee",
      );
      socket.open();
      if (baselineAt !== null) socket.close(4408);
      const before = read();
      expect(before[transport].close4408).toEqual({
        count: baselineAt === null ? 0 : 1,
        lastAtMs: baselineAt,
        complete: true,
      });
      const { port, freezes } = freezePort(before, before);
      const execution = runChatMatrixCase(
        parseChatMatrixCase(
          transport === "plain" ? "plain-64-dark-freeze" : "noise-64-light-freeze",
        ),
        {
          ...port,
          observe: async () => read(),
          clock: async () => {
            now = startedAt;
            return now;
          },
          freeze(value) {
            port.freeze(value);
            if (value) {
              now = 1500;
              socket.close(4408);
              socket.close(1000);
            }
          },
        },
      );
      if (elapsed === null) {
        await expect(execution).rejects.toThrow("Matrix evidence assertion failed.");
        expect(freezes).toEqual([]);
      } else {
        const result = await execution;
        expect(result.clientCloseElapsedMs).toBe(elapsed);
        expect(freezes).toEqual([true, false]);
      }
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    },
  );
}
