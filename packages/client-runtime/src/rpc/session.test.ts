import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  type ServerConfig as ServerConfigType,
  WS_METHODS,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import { splitIntoRecords } from "../e2ee/frame.ts";
import { createNkResponder, derivePublicKey } from "../e2ee/noise.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as RpcSession from "./session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  readonly sent: Array<string | Uint8Array> = [];
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string | Uint8Array) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  descriptor: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    storageInstanceId: "store-test",
    remoteUpdateSupport: null,
    remoteProtocolVersion: 1,
    minCompatibleRemoteProtocol: 1,
    capabilities: {
      repositoryIdentity: true,
      worktreeCatalog: false,
      worktreeCatalogRefreshReason: false,
      vcsStatusSummary: false,
      activityProtocolVersion: null,
      remoteUpdateControl: false,
    },
  },
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws?wsTicket=test",
  httpAuthorization: null,
  e2ee: null,
  target: TARGET,
};

const SERVER_CONFIG: ServerConfigType = {
  environment: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    storageInstanceId: null,
    remoteUpdateSupport: null,
    remoteProtocolVersion: 1,
    minCompatibleRemoteProtocol: 1,
    capabilities: {
      repositoryIdentity: true,
      worktreeCatalog: false,
      worktreeCatalogRefreshReason: false,
      vcsStatusSummary: false,
      activityProtocolVersion: null,
      remoteUpdateControl: false,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "bibcode_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  payload: Schema.Unknown,
  tag: Schema.String,
});
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const decodeRpcRequest = Schema.decodeUnknownSync(RpcRequest);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const encodeServerConfig = Schema.encodeSync(ServerConfig);

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* () {
  const sockets: TestWebSocket[] = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer.pipe(Layer.provide(constructorLayer));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = sockets[0];
    if (socket) {
      return socket;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to create a websocket."));
});

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = socket.sent[0];
    if (request) {
      if (typeof request !== "string") {
        return yield* Effect.die(new Error("Expected a plaintext RPC request."));
      }
      return decodeRpcRequest(decodeJson(request));
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
});

const awaitBinaryFrame = Effect.fn("TestRpcSessionFactory.awaitBinaryFrame")(function* (
  socket: TestWebSocket,
  index: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = socket.sent[index];
    if (frame instanceof Uint8Array) return frame;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error(`Expected binary websocket frame ${String(index)}.`));
});

const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.serverGetConfig,
    payload: {},
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Success",
        value: encodeServerConfig(SERVER_CONFIG),
      },
    }),
  );
});

describe("RpcSessionFactory", () => {
  it.effect("owns one scoped websocket attempt and exposes readiness and closure", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      expect(socket.url).toBe(PREPARED.socketUrl);
      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config).toEqual(SERVER_CONFIG);
      const e2eeAuthenticated = yield* session.e2eeAuthenticated;
      expect(e2eeAuthenticated).toBeNull();
      expect(socket.sent).toHaveLength(1);
      expect(typeof socket.sent[0]).toBe("string");

      socket.close(1012, "service restart");
      const error = yield* Effect.flip(session.closed);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment disconnected.",
      });
      yield* Effect.yieldNow;
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("starts host-key sessions with a binary Noise NK message A", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const hostKey = Buffer.from(
        derivePublicKey(crypto.getRandomValues(new Uint8Array(32))),
      ).toString("base64url");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect({
            ...PREPARED,
            socketUrl: "wss://environment.example.test/ws-e2ee",
            e2ee: {
              hostKey,
              auth: { kind: "bearer", credential: "stored-secret" },
            },
          });
          const readyFiber = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          expect(socket.url).toBe("wss://environment.example.test/ws-e2ee");
          expect(socket.binaryType).toBe("arraybuffer");

          socket.open();
          for (let attempt = 0; attempt < 100 && socket.sent.length === 0; attempt += 1) {
            yield* Effect.yieldNow;
          }
          expect(socket.sent[0]).toBeInstanceOf(Uint8Array);
          expect(socket.sent[0]).toHaveLength(48);
          yield* Fiber.interrupt(readyFiber);
        }),
      );
    }),
  );

  it.effect("blocks a session when the pinned host identity is rejected", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const hostKey = Buffer.from(
        derivePublicKey(crypto.getRandomValues(new Uint8Array(32))),
      ).toString("base64url");

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect({
            ...PREPARED,
            socketUrl: "wss://environment.example.test/ws-e2ee",
            e2ee: { hostKey, auth: { kind: "bearer", credential: "stored-secret" } },
          });
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* awaitBinaryFrame(socket, 0);
          socket.close(4403, "host identity mismatch");
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(error).toMatchObject({ reason: "host-identity" });
    }),
  );

  it.effect("blocks a session when in-channel bearer authentication is rejected", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const staticPrivate = crypto.getRandomValues(new Uint8Array(32));
      const responder = createNkResponder({ staticPrivateKey: staticPrivate });
      const hostKey = Buffer.from(derivePublicKey(staticPrivate)).toString("base64url");

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect({
            ...PREPARED,
            socketUrl: "wss://environment.example.test/ws-e2ee",
            e2ee: { hostKey, auth: { kind: "bearer", credential: "stored-secret" } },
          });
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          const socket = yield* awaitSocket(sockets);
          socket.open();
          responder.readMessageA(yield* awaitBinaryFrame(socket, 0));
          socket.serverMessage(responder.writeMessageB(new Uint8Array(0)));
          const transport = responder.split();
          const authRecord = transport.receive.decryptWithAd(
            new Uint8Array(0),
            yield* awaitBinaryFrame(socket, 1),
          );
          expect(new TextDecoder().decode(authRecord.subarray(1))).toContain("stored-secret");
          for (const record of splitIntoRecords(
            new TextEncoder().encode(encodeJson({ type: "e2ee_error", code: "unauthorized" })),
          )) {
            socket.serverMessage(transport.send.encryptWithAd(new Uint8Array(0), record));
          }
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(error).toMatchObject({ reason: "authentication" });
    }),
  );

  it.effect("classifies a stalled encrypted handshake as a transient timeout", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const hostKey = Buffer.from(
        derivePublicKey(crypto.getRandomValues(new Uint8Array(32))),
      ).toString("base64url");

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect({
            ...PREPARED,
            socketUrl: "wss://environment.example.test/ws-e2ee",
            e2ee: { hostKey, auth: { kind: "bearer", credential: "stored-secret" } },
          });
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* awaitBinaryFrame(socket, 0);
          yield* TestClock.adjust("10 seconds");
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({ reason: "timeout" });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("closes the websocket when the session scope is released", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* completeInitialConfig(socket);
          yield* Fiber.join(readyFiber);
        }),
      );

      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }),
  );

  it.effect("fails readiness when the websocket never opens", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          yield* awaitSocket(sockets);

          yield* TestClock.adjust("15 seconds");
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment could not establish a WebSocket connection.",
      });
      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
