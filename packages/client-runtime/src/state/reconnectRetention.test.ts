// @effect-diagnostics globalTimers:off - Each collection waits one macrotask so WeakRef targets read in a job can die.
// @effect-diagnostics preferSchemaOverJson:off - A JSON round trip makes each resend a fresh graph with fresh strings, as a socket decode does.
// Memory across changed reconnects (#96, #134), through the thread state the app subscribes and
// the detail projection the UI reads. Each reconnect drops the supervisor's session and installs a
// new one, which subscribes again and receives the whole thread, as `subscribe()` does live.
//
// What must stay: the current session, the latest raw resend (the state holds it) and, in the
// projection, the original object of every message whose value did not change. What must go:
// every older session, and every older raw resend with its thread root and message array. A
// garbage collection decides it, so the test holds only weak references between reconnects.
// The socket and RPC decode below a session are not exercised here; the Chromium run in
// docs/testing/macos-desktop.md ("Thread memory across reconnects") covers the whole app.
import {
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  type EnvironmentThreadState,
} from "./threads.ts";

NodeV8.setFlagsFromString("--expose_gc");
const collectGarbage = NodeVM.runInNewContext("gc") as () => void;

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PROMPTS = 20;
const RESENDS = 6;

function message(id: string, role: "user" | "assistant", text: string): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

/**
 * The thread after `added` short turns. Each lands before the prompts, as a turn the server
 * orders first does, so every resend moves every prompt.
 */
function threadAfter(added: number): OrchestrationThread {
  const early = Array.from({ length: added }, (_, index) =>
    message(`added-${index}`, "assistant", `short ${index}`),
  );
  const prompts = Array.from({ length: PROMPTS }, (_, index) =>
    message(`prompt-${index}`, "user", `prompt ${index} `.padEnd(4_000, "x")),
  );
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: `2026-06-01T00:00:${String(added).padStart(2, "0")}.000Z`,
    archivedAt: null,
    deletedAt: null,
    messages: [...early, ...prompts],
    reasoning: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
// A fixed delay is a guess about how fast the state reaches the view; under parallel load it is
// too short and the view still shows the previous thread. Wait for the state itself instead.
const waitUntil = (description: string, condition: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000 && !condition(); attempt += 1) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    if (!condition()) {
      return yield* Effect.die(new Error(`Timed out waiting for ${description}.`));
    }
  });
const collect = Effect.gen(function* () {
  // WeakRef targets read in this job stay alive until it ends, hence a macrotask each time.
  for (let round = 0; round < 3; round += 1) {
    yield* settle;
    collectGarbage();
  }
});

/**
 * One connection: a session whose thread subscription delivers `item`. Like a transport holding
 * its last frame, the session keeps what it delivered, so a session that outlives its reconnect
 * also keeps that resend alive.
 */
const makeSession = Effect.fn("ReconnectRetention.makeSession")(function* (
  item: OrchestrationThreadStreamItem,
) {
  const inputs = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
  yield* Queue.offer(inputs, item);
  const delivered: { last: OrchestrationThreadStreamItem | null } = { last: null };
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
      Stream.fromQueue(inputs).pipe(
        Stream.tap((value) =>
          Effect.sync(() => {
            delivered.last = value;
          }),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
    delivered,
  } satisfies RpcSession.RpcSession & { readonly delivered: unknown };
});

const makeHarness = Effect.fn("ReconnectRetention.makeHarness")(function* () {
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    // The web store saves an encoded string; encoding here keeps nothing either.
    saveThread: (_environmentId, thread) => Effect.sync(() => void JSON.stringify(thread)),
    removeThread: () => Effect.void,
    clear: () => Effect.void,
  });
  const state = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
  );

  // The UI's path: the state feeds an atom, the projection reads it, a view stays subscribed.
  const registry = AtomRegistry.make();
  const stateAtom = Atom.make(
    AsyncResult.success<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE),
  ).pipe(Atom.keepAlive);
  const details = createEnvironmentThreadDetailAtoms(() => stateAtom);
  const messagesAtom = details.messagesAtom({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID });
  const unsubscribe = registry.subscribe(messagesAtom, () => undefined);
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  yield* SubscriptionRef.changes(state).pipe(
    Stream.runForEach((value) =>
      Effect.sync(() => registry.set(stateAtom, AsyncResult.success(value))),
    ),
    Effect.forkScoped,
  );

  const resends: Array<{
    readonly thread: WeakRef<object>;
    readonly messages: WeakRef<object>;
    readonly session: WeakRef<object>;
  }> = [];
  // Each reconnect drops the session, then a new one subscribes again and receives the thread
  // as a real decode: a fresh object graph with fresh strings.
  const reconnect = (thread: OrchestrationThread, sequence: number) =>
    Effect.gen(function* () {
      const decoded = JSON.parse(JSON.stringify(thread)) as OrchestrationThread;
      const next = yield* makeSession({
        kind: "snapshot",
        snapshot: { snapshotSequence: sequence, thread: decoded },
      });
      resends.push({
        thread: new WeakRef(decoded),
        messages: new WeakRef(decoded.messages),
        session: new WeakRef(next),
      });
      yield* SubscriptionRef.set(session, Option.none());
      yield* settle;
      yield* SubscriptionRef.set(session, Option.some(next));
      yield* waitUntil(
        `the view to show all ${decoded.messages.length} messages of resend ${sequence}`,
        () => registry.get(messagesAtom).length === decoded.messages.length,
      );
      yield* settle;
      return next.delivered.last !== null;
    });
  const shownPrompts = () =>
    registry.get(messagesAtom).filter((entry) => entry.id.startsWith("prompt-"));
  return { reconnect, resends, shownPrompts };
});

describe("thread memory across changed reconnects", () => {
  it.live(
    "keeps one shown copy of each unchanged message and lets every older resend go",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect(yield* harness.reconnect(threadAfter(0), 1)).toBe(true);
        const original = harness.shownPrompts().map((entry) => new WeakRef(entry));
        expect(original).toHaveLength(PROMPTS);

        for (let added = 1; added <= RESENDS; added += 1) {
          expect(yield* harness.reconnect(threadAfter(added), added + 1)).toBe(true);
        }
        yield* collect;

        // Every session but the current one is gone, and with it what it delivered.
        const aliveSessions = harness.resends.flatMap((entry, index) =>
          entry.session.deref() === undefined ? [] : [index],
        );
        expect(aliveSessions).toEqual([RESENDS]);

        const shown = harness.shownPrompts();
        expect(shown).toHaveLength(PROMPTS);
        expect(shown.every((entry, index) => entry === original[index]!.deref())).toBe(true);
        const alive = harness.resends.flatMap((entry, index) =>
          entry.messages.deref() === undefined ? [] : [index],
        );
        expect(alive).toEqual([RESENDS]);
        const aliveRoots = harness.resends.flatMap((entry, index) =>
          entry.thread.deref() === undefined ? [] : [index],
        );
        expect(aliveRoots).toEqual([RESENDS]);
      }).pipe(Effect.scoped),
    60_000,
  );
});
