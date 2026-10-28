// How many `subscribeThread` requests the client sends per socket (#197), through the whole
// caller the app runs: the real RPC session over a fake WebSocket, the connection driver and its
// verification gate, the supervisor, and the thread state that calls `subscribe()`. A request
// leaves while the connection is still configuring (`PRE_VERIFICATION_SUBSCRIPTIONS`); the
// verified session that follows must not send another, and a reconnect must send one that resumes
// from the revision the previous socket delivered.
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ServerConfig,
  ThreadId,
  WS_METHODS,
  type OrchestrationThread,
  type ServerConfig as ServerConfigType,
} from "@bibcode/contracts";
import { makeTestExecutionEnvironmentCapabilities } from "@bibcode/shared/testSupport";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/socket/Socket";

import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionDriver from "../connection/driver.ts";
import {
  PrimaryConnectionTarget,
  type ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionResolver from "../connection/resolver.ts";
import { EnvironmentSelection } from "../connection/selection.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { splitIntoRecords } from "../e2ee/frame.ts";
import { createNkResponder, derivePublicKey } from "../e2ee/noise.ts";
import * as Persistence from "../platform/persistence.ts";
import { makeEnvironmentThreadState, type EnvironmentThreadState } from "../state/threads.ts";
import { CHUNKED_RPC_SUBPROTOCOL, DEFLATE_RPC_SUBPROTOCOL } from "./chunkedSocket.ts";
import * as RpcSession from "./session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
interface SocketEvent {
  readonly type: SocketEventType;
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  protocol = "";
  readonly sent: Array<string | Uint8Array> = [];
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  readonly url: string;
  readonly protocols: ReadonlyArray<string>;

  constructor(url: string, protocols: ReadonlyArray<string>) {
    this.url = url;
    this.protocols = protocols;
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
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  /** Opens the socket, selecting the first subprotocol offered, as the server does. */
  open() {
    this.protocol = this.protocols[0] ?? "";
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string | Uint8Array) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type Transport = "loopback" | "remote" | "e2ee";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const SOCKET_URLS: Record<Transport, string> = {
  loopback: "ws://127.0.0.1:3773/ws",
  remote: "wss://environment.example.test/ws",
  e2ee: "wss://environment.example.test/ws-e2ee",
};
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  platform: { os: "linux" as const, arch: "x64" as const },
  serverVersion: "0.0.0-test",
  storageInstanceId: "store-test",
  bootId: null,
  remoteUpdateSupport: null,
  remoteProtocolVersion: 1,
  minCompatibleRemoteProtocol: 1,
  capabilities: makeTestExecutionEnvironmentCapabilities({ repositoryIdentity: true }),
};
const SERVER_CONFIG: ServerConfigType = {
  environment: DESCRIPTOR,
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
const encodeServerConfig = Schema.encodeSync(ServerConfig);

const THREAD_ID = ThreadId.make("thread-1");
const SECOND_THREAD_ID = ThreadId.make("thread-2");

function thread(id: ThreadId, title: string): OrchestrationThread {
  return {
    id,
    projectId: ProjectId.make("project-1"),
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    reasoning: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

interface WireRequest {
  readonly id: string;
  readonly tag: string;
  readonly payload: unknown;
}

interface ThreadRequestPayload {
  readonly threadId: string;
  readonly patches?: boolean;
  readonly resume?: { readonly revision: string; readonly snapshotSequence: number };
}

/** The server end of one socket: reads the client's requests and sends it messages. */
interface ServerEnd {
  readonly socket: TestWebSocket;
  readonly requests: () => ReadonlyArray<WireRequest>;
  readonly send: (message: unknown) => void;
}

const settle = Effect.gen(function* () {
  for (let index = 0; index < 200; index += 1) yield* Effect.yieldNow;
});

const asRequest = (message: unknown): WireRequest | null =>
  typeof message === "object" &&
  message !== null &&
  (message as { _tag?: unknown })._tag === "Request"
    ? (message as WireRequest)
    : null;

function plainEnd(socket: TestWebSocket): ServerEnd {
  return {
    socket,
    requests: () =>
      socket.sent.flatMap((frame) => {
        if (typeof frame !== "string") return [];
        const request = asRequest(JSON.parse(frame));
        return request === null ? [] : [request];
      }),
    send: (message) => socket.serverMessage(JSON.stringify(message)),
  };
}

/** Answers the Noise NK handshake and the in-channel authentication, then speaks records. */
const acceptEncrypted = Effect.fn("SubscribeOnce.acceptEncrypted")(function* (
  socket: TestWebSocket,
  staticPrivateKey: Uint8Array,
) {
  const binaryFrame = Effect.fn("SubscribeOnce.binaryFrame")(function* (index: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const frame = socket.sent[index];
      if (frame instanceof Uint8Array) return frame;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Expected binary frame ${String(index)}.`));
  });
  const responder = createNkResponder({ staticPrivateKey });
  responder.readMessageA(yield* binaryFrame(0));
  socket.serverMessage(responder.writeMessageB(new Uint8Array(0)));
  const transport = responder.split();
  transport.receive.decryptWithAd(new Uint8Array(0), yield* binaryFrame(1));
  const send = (message: unknown) => {
    for (const record of splitIntoRecords(new TextEncoder().encode(JSON.stringify(message)))) {
      socket.serverMessage(transport.send.encryptWithAd(new Uint8Array(0), record));
    }
  };
  send({ type: "e2ee_authenticated" });
  // Each frame decrypts once, in order: the receive nonce advances with it.
  const received: Array<WireRequest> = [];
  let next = 2;
  let pending = "";
  return {
    socket,
    requests: () => {
      for (; next < socket.sent.length; next += 1) {
        const frame = socket.sent[next];
        if (!(frame instanceof Uint8Array)) continue;
        const record = transport.receive.decryptWithAd(new Uint8Array(0), frame);
        pending += new TextDecoder().decode(record.subarray(1));
        if (record[0] === 0x01) continue;
        const request = asRequest(JSON.parse(pending));
        pending = "";
        if (request !== null) received.push(request);
      }
      return received;
    },
    send,
  } satisfies ServerEnd;
});

const makeStack = Effect.fn("SubscribeOnce.makeStack")(function* (transport: Transport) {
  const sockets: Array<TestWebSocket> = [];
  const factory = yield* RpcSession.RpcSessionFactory.pipe(
    Effect.provide(
      RpcSession.layer.pipe(
        Layer.provide(
          Layer.succeed(Socket.WebSocketConstructor, (url, options) => {
            const protocols =
              options === undefined ? [] : typeof options === "string" ? [options] : options;
            if (!Array.isArray(protocols)) {
              throw new TypeError("The test WebSocket accepts only subprotocols.");
            }
            const socket = new TestWebSocket(url, protocols);
            sockets.push(socket);
            return socket as unknown as globalThis.WebSocket;
          }),
        ),
      ),
    ),
  );
  const staticPrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const target = new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Test environment",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });
  const prepared: PreparedConnection = {
    environmentId: ENVIRONMENT_ID,
    label: target.label,
    descriptor: DESCRIPTOR,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: SOCKET_URLS[transport],
    httpAuthorization: null,
    e2ee:
      transport === "e2ee"
        ? {
            hostKey: Buffer.from(derivePublicKey(staticPrivateKey)).toString("base64url"),
            auth: { kind: "bearer", credential: "stored-secret" },
          }
        : null,
    target,
  };
  const identities = Persistence.AcceptedStorageIdentityStore.of({
    get: () => Effect.succeedSome("store-test"),
    accept: () => Effect.void,
    rollbackAcceptance: () => Effect.succeed(true),
    transition: (_targetKey, decide) => Effect.succeed(decide("store-test").result),
  });
  const driver = yield* ConnectionDriver.make.pipe(
    Effect.provideService(
      ConnectionResolver.ConnectionResolver,
      ConnectionResolver.ConnectionResolver.of({ prepare: () => Effect.succeed(prepared) }),
    ),
    Effect.provideService(RpcSession.RpcSessionFactory, factory),
    Effect.provideService(Persistence.AcceptedStorageIdentityStore, identities),
  );
  const network = yield* SubscriptionRef.make<"online" | "offline">("online");
  const selection = yield* SubscriptionRef.make<EnvironmentId | null>(ENVIRONMENT_ID);
  const supervisor = yield* EnvironmentSupervisor.make(
    { target, profile: Option.none() },
    { initiallyDesired: true, targetRef: yield* Ref.make<ConnectionTarget>(target) },
  ).pipe(
    Effect.provideService(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({
        status: SubscriptionRef.get(network),
        changes: SubscriptionRef.changes(network),
      }),
    ),
    Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        focusVisibility: Stream.never,
        changes: Stream.never,
      }),
    ),
    Effect.provideService(Random.Random, { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 0 }),
    Effect.provideService(
      EnvironmentSelection,
      EnvironmentSelection.of({
        current: SubscriptionRef.get(selection),
        changes: SubscriptionRef.changes(selection),
      }),
    ),
  );
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    clear: () => Effect.void,
  });
  /** The thread state the app makes for an open (or prewarmed) thread. */
  const followThread = (threadId: ThreadId) =>
    makeEnvironmentThreadState(threadId).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    );

  /** Waits for socket `count` to exist, letting the reconnect backoff elapse. */
  const awaitSocket = Effect.fn("SubscribeOnce.awaitSocket")(function* (count: number) {
    for (let step = 0; step < 400 && sockets.length < count; step += 1) {
      yield* TestClock.adjust("100 millis");
      yield* settle;
    }
    expect(sockets).toHaveLength(count);
    return sockets[count - 1]!;
  });

  /** Opens the newest socket and, for E2EE, completes the handshake. */
  const accept = Effect.fn("SubscribeOnce.accept")(function* (count: number) {
    const socket = yield* awaitSocket(count);
    socket.open();
    yield* settle;
    const end =
      transport === "e2ee" ? yield* acceptEncrypted(socket, staticPrivateKey) : plainEnd(socket);
    yield* settle;
    return end;
  });

  const awaitPhase = Effect.fn("SubscribeOnce.awaitPhase")(function* (
    phase: SupervisorConnectionState["phase"],
  ) {
    for (let step = 0; step < 50; step += 1) {
      if ((yield* SubscriptionRef.get(supervisor.state)).phase === phase) return;
      yield* settle;
    }
    return yield* Effect.die(new Error(`The supervisor never reached ${phase}.`));
  });

  return { accept, awaitPhase, followThread, sockets, supervisor };
});

/** What the server holds: each thread's current value and revision. */
type ServerThreads = Map<string, { readonly thread: OrchestrationThread; revision: string }>;

const threadRequests = (end: ServerEnd) =>
  end
    .requests()
    .filter((request) => request.tag === ORCHESTRATION_WS_METHODS.subscribeThread)
    .map((request) => request.payload as ThreadRequestPayload);

/**
 * Answers every request not answered yet: the config with its snapshot, and each thread with
 * `unchanged` when the client names the current revision, as the server does, else a snapshot.
 */
function makeResponder(end: ServerEnd, threads: ServerThreads) {
  const answered = new Set<string>();
  return (options?: { readonly config?: boolean }) => {
    for (const request of end.requests()) {
      if (answered.has(request.id)) continue;
      if (request.tag === WS_METHODS.subscribeServerConfig) {
        if (options?.config === false) continue;
        answered.add(request.id);
        end.send({
          _tag: "Chunk",
          requestId: request.id,
          values: [{ version: 1, type: "snapshot", config: encodeServerConfig(SERVER_CONFIG) }],
        });
      } else if (request.tag === ORCHESTRATION_WS_METHODS.subscribeThread) {
        answered.add(request.id);
        const payload = request.payload as ThreadRequestPayload;
        const held = threads.get(payload.threadId)!;
        end.send({
          _tag: "Chunk",
          requestId: request.id,
          values: [
            payload.resume?.revision === held.revision
              ? { kind: "unchanged", snapshotSequence: 1, revision: held.revision }
              : {
                  kind: "snapshot",
                  snapshot: { snapshotSequence: 1, thread: held.thread },
                  revision: held.revision,
                },
          ],
        });
      }
    }
  };
}

const answerAll = Effect.fn("SubscribeOnce.answerAll")(function* (
  respond: ReturnType<typeof makeResponder>,
) {
  for (let round = 0; round < 5; round += 1) {
    respond();
    yield* settle;
  }
});

const liveData = (state: EnvironmentThreadState) =>
  state.status === "live" ? Option.getOrNull(state.data) : null;

const TRANSPORTS: ReadonlyArray<{
  readonly transport: Transport;
  readonly protocols: ReadonlyArray<string>;
}> = [
  { transport: "loopback", protocols: [CHUNKED_RPC_SUBPROTOCOL] },
  { transport: "remote", protocols: [DEFLATE_RPC_SUBPROTOCOL, CHUNKED_RPC_SUBPROTOCOL] },
  { transport: "e2ee", protocols: [] },
];

describe("thread subscription requests per reconnect (#197)", () => {
  for (const { transport, protocols } of TRANSPORTS) {
    it.effect(
      `${transport}: sends one request through verification and one resumed request per reconnect`,
      () =>
        Effect.gen(function* () {
          const stack = yield* makeStack(transport);
          const threads: ServerThreads = new Map([
            [THREAD_ID, { thread: thread(THREAD_ID, "First"), revision: "r1" }],
          ]);
          const state = yield* stack.followThread(THREAD_ID);

          const first = yield* stack.accept(1);
          expect(first.socket.protocols).toEqual(protocols);
          const respond = makeResponder(first, threads);
          // The request leaves while configuring, before the config arrives.
          respond({ config: false });
          yield* settle;
          expect(threadRequests(first)).toEqual([{ threadId: THREAD_ID, patches: true }]);
          yield* answerAll(respond);
          yield* stack.awaitPhase("connected");
          // The verified session does not subscribe again, and neither does the retry window.
          yield* TestClock.adjust("5 seconds");
          yield* settle;
          expect(threadRequests(first)).toHaveLength(1);
          const delivered = liveData(yield* SubscriptionRef.get(state));
          expect(delivered?.title).toBe("First");

          // The thread did not change while the socket was down.
          first.socket.close(1006);
          const second = yield* stack.accept(2);
          yield* answerAll(makeResponder(second, threads));
          yield* stack.awaitPhase("connected");
          yield* TestClock.adjust("5 seconds");
          yield* settle;
          expect(threadRequests(second)).toEqual([
            {
              threadId: THREAD_ID,
              patches: true,
              resume: { revision: "r1", snapshotSequence: 1 },
            },
          ]);
          // `unchanged` keeps the thread the state holds, live again.
          expect(liveData(yield* SubscriptionRef.get(state))).toBe(delivered);
        }).pipe(Effect.scoped),
    );
  }

  it.effect("resumes a changed thread from the revision the last snapshot carried", () =>
    Effect.gen(function* () {
      const stack = yield* makeStack("loopback");
      const threads: ServerThreads = new Map([
        [THREAD_ID, { thread: thread(THREAD_ID, "First"), revision: "r1" }],
      ]);
      const state = yield* stack.followThread(THREAD_ID);
      yield* answerAll(makeResponder(yield* stack.accept(1), threads));
      yield* stack.awaitPhase("connected");

      stack.sockets[0]!.close(1006);
      threads.set(THREAD_ID, { thread: thread(THREAD_ID, "Changed"), revision: "r2" });
      const second = yield* stack.accept(2);
      yield* answerAll(makeResponder(second, threads));
      yield* stack.awaitPhase("connected");
      expect(threadRequests(second)).toHaveLength(1);
      expect(liveData(yield* SubscriptionRef.get(state))?.title).toBe("Changed");

      stack.sockets[1]!.close(1006);
      const third = yield* stack.accept(3);
      yield* answerAll(makeResponder(third, threads));
      yield* stack.awaitPhase("connected");
      expect(threadRequests(third)).toEqual([
        { threadId: THREAD_ID, patches: true, resume: { revision: "r2", snapshotSequence: 1 } },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends one request per followed thread, so two threads send two", () =>
    Effect.gen(function* () {
      const stack = yield* makeStack("loopback");
      const threads: ServerThreads = new Map([
        [THREAD_ID, { thread: thread(THREAD_ID, "Open"), revision: "a1" }],
        [SECOND_THREAD_ID, { thread: thread(SECOND_THREAD_ID, "Prewarmed"), revision: "b1" }],
      ]);
      yield* stack.followThread(THREAD_ID);
      yield* stack.followThread(SECOND_THREAD_ID);
      const first = yield* stack.accept(1);
      yield* answerAll(makeResponder(first, threads));
      yield* stack.awaitPhase("connected");

      first.socket.close(1006);
      const second = yield* stack.accept(2);
      yield* answerAll(makeResponder(second, threads));
      yield* stack.awaitPhase("connected");
      for (const end of [first, second]) {
        expect(
          threadRequests(end)
            .map((payload) => payload.threadId)
            .toSorted(),
        ).toEqual([THREAD_ID, SECOND_THREAD_ID]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("drops what an unverified attempt delivered and resumes from the last verified", () =>
    Effect.gen(function* () {
      const stack = yield* makeStack("loopback");
      const threads: ServerThreads = new Map([
        [THREAD_ID, { thread: thread(THREAD_ID, "First"), revision: "r1" }],
      ]);
      const state = yield* stack.followThread(THREAD_ID);
      yield* answerAll(makeResponder(yield* stack.accept(1), threads));
      yield* stack.awaitPhase("connected");

      stack.sockets[0]!.close(1006);
      threads.set(THREAD_ID, { thread: thread(THREAD_ID, "Unverified"), revision: "r2" });
      // The attempt sends its request and receives the thread, but ends before its config.
      const unverified = yield* stack.accept(2);
      const respond = makeResponder(unverified, threads);
      respond({ config: false });
      yield* settle;
      expect(threadRequests(unverified)).toHaveLength(1);
      unverified.socket.close(1006);
      yield* settle;
      expect(Option.getOrNull((yield* SubscriptionRef.get(state)).data)?.title).toBe("First");

      const third = yield* stack.accept(3);
      yield* answerAll(makeResponder(third, threads));
      yield* stack.awaitPhase("connected");
      expect(threadRequests(third)).toEqual([
        { threadId: THREAD_ID, patches: true, resume: { revision: "r1", snapshotSequence: 1 } },
      ]);
      expect(liveData(yield* SubscriptionRef.get(state))?.title).toBe("Unverified");
    }).pipe(Effect.scoped),
  );
});
