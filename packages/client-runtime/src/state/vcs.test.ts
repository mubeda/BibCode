import {
  EnvironmentId,
  GitManagerError,
  WS_METHODS,
  type VcsStatusSummary,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createVcsEnvironmentAtoms } from "./vcs.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const TARGET = {
  environmentId: ENVIRONMENT_ID,
  input: { cwd: "/repo" },
} as const;

function summary(refName: string): VcsStatusSummary {
  return {
    isRepo: true,
    refName,
    detachedHead: null,
    hasWorkingTreeChanges: false,
    sourceControlProvider: null,
    pr: null,
    observedAt: "2026-08-20T12:00:00.000Z",
    stale: false,
  };
}

const legacySnapshot = {
  _tag: "snapshot" as const,
  local: {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: "legacy/main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  },
  remote: null,
};

function session(client: WsRpcProtocolClient, summaryCapability: boolean | undefined): RpcSession {
  const capabilities =
    summaryCapability === undefined ? {} : { vcsStatusSummary: summaryCapability };
  return {
    client,
    initialConfig: Effect.succeed({ environment: { capabilities } } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
}

const makeHarness = Effect.fn("TestVcs.makeHarness")(function* (initialSession: RpcSession) {
  const clock = yield* Clock.Clock;
  const sessionRef = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
    Option.some(initialSession),
  );
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID, label: "Environment" },
    session: sessionRef,
  } as never);
  const environmentRegistry = EnvironmentRegistry.of({
    followStream: (_environmentId: EnvironmentId, stream: Stream.Stream<unknown, unknown>) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as never);
  const vcs = createVcsEnvironmentAtoms(
    Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, environmentRegistry),
        Layer.succeed(Clock.Clock, clock),
      ),
    ),
  );
  return { atomRegistry: AtomRegistry.make(), sessionRef, vcs };
});

function readRefName<A extends { readonly refName: string | null }, E>(
  atomRegistry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  refName: string,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = atomRegistry.get(atom);
      if (AsyncResult.isSuccess(result) && result.value.refName === refName) {
        return result.value;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`VCS ref ${refName} was not observed`);
  });
}

function waitFor(predicate: () => boolean, message: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(message);
  });
}

describe("VCS summary atoms", () => {
  it.effect("retries an expected summary failure once at the passive freshness boundary", () =>
    Effect.gen(function* () {
      let calls = 0;
      const recovered = summary("summary/recovered");
      const expectedFailure = new GitManagerError({
        operation: "summary",
        cwd: "/sensitive/repository",
        detail: "sensitive provider output",
      });
      const client = {
        [WS_METHODS.subscribeVcsStatusSummary]: () => {
          calls += 1;
          return calls === 1
            ? Stream.fail(expectedFailure)
            : Stream.make(recovered).pipe(Stream.concat(Stream.fail(expectedFailure)));
        },
      } as unknown as WsRpcProtocolClient;
      const harness = yield* makeHarness(session(client, true));
      const atom = harness.vcs.summary(TARGET);
      const unmount = harness.atomRegistry.mount(atom);

      yield* waitFor(() => calls === 1, "first summary subscription did not start");
      for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust("29 seconds");
      expect(calls).toBe(1);

      yield* TestClock.adjust("1 second");
      expect((yield* readRefName(harness.atomRegistry, atom, recovered.refName!)).refName).toBe(
        recovered.refName,
      );
      expect(calls).toBe(2);

      for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust("29 seconds");
      const retained = harness.atomRegistry.get(atom);
      expect(AsyncResult.isSuccess(retained) ? retained.value : null).toBe(recovered);
      expect(calls).toBe(2);

      unmount();
      harness.atomRegistry.dispose();
    }),
  );

  it.effect("cancels a pending summary retry when the session disconnects", () =>
    Effect.gen(function* () {
      const calls = { initial: 0, reconnected: 0 };
      const active = { count: 0, maximum: 0 };
      let finalized = 0;
      const expectedFailure = new GitManagerError({
        operation: "summary",
        cwd: "/sensitive/repository",
        detail: "sensitive provider output",
      });
      const initialClient = {
        [WS_METHODS.subscribeVcsStatusSummary]: () => {
          calls.initial += 1;
          return Stream.fail(expectedFailure);
        },
      } as unknown as WsRpcProtocolClient;
      const reconnected = summary("summary/reconnected-after-failure");
      const reconnectedClient = {
        [WS_METHODS.subscribeVcsStatusSummary]: () => {
          calls.reconnected += 1;
          return Stream.fromEffect(
            Effect.sync(() => {
              active.count += 1;
              active.maximum = Math.max(active.maximum, active.count);
              return reconnected;
            }),
          ).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(
              Effect.sync(() => {
                active.count -= 1;
                finalized += 1;
              }),
            ),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const harness = yield* makeHarness(session(initialClient, true));
      const atom = harness.vcs.summary(TARGET);
      const unmount = harness.atomRegistry.mount(atom);

      yield* waitFor(() => calls.initial === 1, "initial summary subscription did not start");
      for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust("29 seconds");
      yield* SubscriptionRef.set(harness.sessionRef, Option.none());
      for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust("1 minute");
      expect(calls).toEqual({ initial: 1, reconnected: 0 });

      yield* SubscriptionRef.set(harness.sessionRef, Option.some(session(reconnectedClient, true)));
      expect((yield* readRefName(harness.atomRegistry, atom, reconnected.refName!)).refName).toBe(
        reconnected.refName,
      );
      const observed = { calls: { ...calls }, active: { ...active } };
      unmount();
      yield* waitFor(() => finalized === 1, "reconnected summary stream survived unmount");
      harness.atomRegistry.dispose();

      expect(observed).toEqual({
        calls: { initial: 1, reconnected: 1 },
        active: { count: 1, maximum: 1 },
      });
    }),
  );

  it.effect("releases VCS streams promptly while switching status to summary", () =>
    Effect.gen(function* () {
      const active = { status: 0, summary: 0 };
      const finalized = { status: 0, summary: 0 };
      const client = {
        [WS_METHODS.subscribeVcsStatus]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              active.status += 1;
              return legacySnapshot;
            }),
          ).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(
              Effect.sync(() => {
                active.status -= 1;
                finalized.status += 1;
              }),
            ),
          ),
        [WS_METHODS.subscribeVcsStatusSummary]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              active.summary += 1;
              return summary("summary/main");
            }),
          ).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(
              Effect.sync(() => {
                active.summary -= 1;
                finalized.summary += 1;
              }),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const harness = yield* makeHarness(session(client, true));
      const statusAtom = harness.vcs.status(TARGET);
      const summaryAtom = harness.vcs.summary(TARGET);
      const unmountStatus = harness.atomRegistry.mount(statusAtom);
      yield* readRefName(harness.atomRegistry, statusAtom, "legacy/main");
      const unmountSummary = harness.atomRegistry.mount(summaryAtom);
      yield* readRefName(harness.atomRegistry, summaryAtom, "summary/main");

      unmountStatus();
      yield* waitFor(
        () => finalized.status === 1,
        "full-status stream was not finalized after switching to summary",
      );
      const afterSwitch = { active: { ...active }, finalized: { ...finalized } };
      unmountSummary();
      yield* waitFor(() => finalized.summary === 1, "summary stream was not finalized on unmount");
      const afterUnmount = { active: { ...active }, finalized: { ...finalized } };
      harness.atomRegistry.dispose();

      expect(afterSwitch).toEqual({
        active: { status: 0, summary: 1 },
        finalized: { status: 1, summary: 0 },
      });
      expect(afterUnmount).toEqual({
        active: { status: 0, summary: 0 },
        finalized: { status: 1, summary: 1 },
      });
    }),
  );

  it.effect("uses the passive summary stream when the server advertises it", () =>
    Effect.gen(function* () {
      const calls = { summary: 0, status: 0 };
      const client = {
        [WS_METHODS.subscribeVcsStatusSummary]: () => {
          calls.summary += 1;
          return Stream.make(summary("summary/main")).pipe(Stream.concat(Stream.never));
        },
        [WS_METHODS.subscribeVcsStatus]: () => {
          calls.status += 1;
          return Stream.make(legacySnapshot).pipe(Stream.concat(Stream.never));
        },
      } as unknown as WsRpcProtocolClient;
      const harness = yield* makeHarness(session(client, true));
      const atom = harness.vcs.summary(TARGET);
      const unmount = harness.atomRegistry.mount(atom);

      expect((yield* readRefName(harness.atomRegistry, atom, "summary/main")).refName).toBe(
        "summary/main",
      );
      expect(calls).toEqual({ summary: 1, status: 0 });

      unmount();
      harness.atomRegistry.dispose();
    }),
  );

  it.effect("does not open a payload stream while the session capability is unresolved", () =>
    Effect.gen(function* () {
      const calls = { summary: 0, status: 0 };
      const client = {
        [WS_METHODS.subscribeVcsStatusSummary]: () => {
          calls.summary += 1;
          return Stream.never;
        },
        [WS_METHODS.subscribeVcsStatus]: () => {
          calls.status += 1;
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const unresolvedSession = {
        ...session(client, true),
        initialConfig: Effect.never,
      } satisfies RpcSession;
      const harness = yield* makeHarness(unresolvedSession);
      const unmount = harness.atomRegistry.mount(harness.vcs.summary(TARGET));

      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      const callsWhileUnknown = { ...calls };
      unmount();
      harness.atomRegistry.dispose();

      expect(callsWhileUnknown).toEqual({ summary: 0, status: 0 });
    }),
  );

  it.effect.each([undefined, false])(
    "uses the legacy full-status stream when the capability is %s",
    (summaryCapability) =>
      Effect.gen(function* () {
        const calls = { summary: 0, status: 0 };
        const client = {
          [WS_METHODS.subscribeVcsStatusSummary]: () => {
            calls.summary += 1;
            return Stream.make(summary("wrong/summary"));
          },
          [WS_METHODS.subscribeVcsStatus]: () => {
            calls.status += 1;
            return Stream.make(legacySnapshot).pipe(Stream.concat(Stream.never));
          },
        } as unknown as WsRpcProtocolClient;
        const harness = yield* makeHarness(session(client, summaryCapability));
        const atom = harness.vcs.summary(TARGET);
        const unmount = harness.atomRegistry.mount(atom);

        const value = yield* readRefName(harness.atomRegistry, atom, "legacy/main");
        expect("workingTree" in value ? value.workingTree.files : null).toEqual([]);
        expect(calls).toEqual({ summary: 0, status: 1 });

        unmount();
        harness.atomRegistry.dispose();
      }),
  );

  it.effect.each([undefined, false])(
    "shares one full-status owner between status and summary when the capability is %s",
    (summaryCapability) =>
      Effect.gen(function* () {
        const calls = { summary: 0, status: 0 };
        let finalized = 0;
        const client = {
          [WS_METHODS.subscribeVcsStatusSummary]: () => {
            calls.summary += 1;
            return Stream.make(summary("wrong/summary"));
          },
          [WS_METHODS.subscribeVcsStatus]: () => {
            calls.status += 1;
            return Stream.make(legacySnapshot).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(
                Effect.sync(() => {
                  finalized += 1;
                }),
              ),
            );
          },
        } as unknown as WsRpcProtocolClient;
        const harness = yield* makeHarness(session(client, summaryCapability));
        const statusAtom = harness.vcs.status(TARGET);
        const summaryAtom = harness.vcs.summary(TARGET);
        const unmountStatus = harness.atomRegistry.mount(statusAtom);
        const unmountSummary = harness.atomRegistry.mount(summaryAtom);

        const statusValue = yield* readRefName(harness.atomRegistry, statusAtom, "legacy/main");
        const summaryValue = yield* readRefName(harness.atomRegistry, summaryAtom, "legacy/main");
        const callsWhileMounted = { ...calls };
        unmountStatus();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        const finalizedAfterFirstUnmount = finalized;
        unmountSummary();
        yield* waitFor(() => finalized === 1, "shared status stream survived its last owner");
        const finalizedAfterLastUnmount = finalized;
        harness.atomRegistry.dispose();

        expect(summaryValue).toBe(statusValue);
        expect(callsWhileMounted).toEqual({ summary: 0, status: 1 });
        expect(finalizedAfterFirstUnmount).toBe(0);
        expect(finalizedAfterLastUnmount).toBe(1);
      }),
  );

  it.effect("retains the last summary while reconnecting without overlapping subscriptions", () =>
    Effect.gen(function* () {
      const active = { count: 0, maximum: 0 };
      const finalized = { initial: 0, reconnected: 0 };
      const client = (kind: keyof typeof finalized, value: VcsStatusSummary) =>
        ({
          [WS_METHODS.subscribeVcsStatusSummary]: () =>
            Stream.fromEffect(
              Effect.sync(() => {
                active.count += 1;
                active.maximum = Math.max(active.maximum, active.count);
                return value;
              }),
            ).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(
                Effect.sync(() => {
                  active.count -= 1;
                  finalized[kind] += 1;
                }),
              ),
            ),
        }) as unknown as WsRpcProtocolClient;
      const first = summary("first");
      const second = summary("second");
      const harness = yield* makeHarness(session(client("initial", first), true));
      const atom = harness.vcs.summary(TARGET);
      const unmount = harness.atomRegistry.mount(atom);

      expect((yield* readRefName(harness.atomRegistry, atom, "first")).refName).toBe("first");
      yield* SubscriptionRef.set(harness.sessionRef, Option.none());
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const disconnected = harness.atomRegistry.get(atom);
      expect(AsyncResult.isSuccess(disconnected) ? disconnected.value : null).toBe(first);
      expect({ active, finalized }).toEqual({
        active: { count: 0, maximum: 1 },
        finalized: { initial: 1, reconnected: 0 },
      });

      yield* SubscriptionRef.set(
        harness.sessionRef,
        Option.some(session(client("reconnected", second), true)),
      );
      expect((yield* readRefName(harness.atomRegistry, atom, "second")).refName).toBe("second");
      expect(active).toEqual({ count: 1, maximum: 1 });

      unmount();
      harness.atomRegistry.dispose();
    }),
  );

  it.effect("waits for reconnect capability before switching payload streams", () =>
    Effect.gen(function* () {
      const active = { count: 0, maximum: 0 };
      const finalized = { status: 0, summary: 0 };
      const tracked = <A>(kind: keyof typeof finalized, value: A) =>
        Stream.fromEffect(
          Effect.sync(() => {
            active.count += 1;
            active.maximum = Math.max(active.maximum, active.count);
            return value;
          }),
        ).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              active.count -= 1;
              finalized[kind] += 1;
            }),
          ),
        );
      const legacyClient = {
        [WS_METHODS.subscribeVcsStatus]: () => tracked("status", legacySnapshot),
      } as unknown as WsRpcProtocolClient;
      const summaryClient = {
        [WS_METHODS.subscribeVcsStatusSummary]: () =>
          tracked("summary", summary("summary/reconnected")),
      } as unknown as WsRpcProtocolClient;
      const harness = yield* makeHarness(session(legacyClient, false));
      const atom = harness.vcs.summary(TARGET);
      const unmount = harness.atomRegistry.mount(atom);

      const first = yield* readRefName(harness.atomRegistry, atom, "legacy/main");
      yield* SubscriptionRef.set(harness.sessionRef, Option.none());
      yield* waitFor(() => finalized.status === 1, "legacy stream survived disconnect");
      const disconnected = harness.atomRegistry.get(atom);
      expect(AsyncResult.isSuccess(disconnected) ? disconnected.value : null).toBe(first);

      yield* SubscriptionRef.set(harness.sessionRef, Option.some(session(summaryClient, true)));
      yield* readRefName(harness.atomRegistry, atom, "summary/reconnected");
      const observed = { active: { ...active }, finalized: { ...finalized } };
      unmount();
      harness.atomRegistry.dispose();

      expect(observed).toEqual({
        active: { count: 1, maximum: 1 },
        finalized: { status: 1, summary: 0 },
      });
    }),
  );
});
