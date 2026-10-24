import {
  EnvironmentId,
  WS_METHODS,
  type ReviewDiffPreviewInput,
  type ReviewReadFileVersionInput,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createReviewEnvironmentAtoms } from "./review.ts";

const ENVIRONMENT_ID = EnvironmentId.make("review-test");
const OLD_A = "a".repeat(40);
const OLD_B = "b".repeat(40);

interface Harness {
  readonly atoms: ReturnType<typeof createReviewEnvironmentAtoms>;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly started: string[];
  readonly interrupted: string[];
  readonly gates: Map<string, Deferred.Deferred<void>>;
}

/** A session whose reads wait on a gate per key, and record when they are interrupted. */
const makeHarness = Effect.fn("TestReview.makeHarness")(function* (keys: ReadonlyArray<string>) {
  const started: string[] = [];
  const interrupted: string[] = [];
  const gates = new Map<string, Deferred.Deferred<void>>();
  for (const key of keys) gates.set(key, yield* Deferred.make<void>());
  const gated = <A>(key: string, result: A) =>
    Effect.gen(function* () {
      started.push(key);
      yield* Deferred.await(gates.get(key)!);
      return result;
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted.push(key);
        }),
      ),
    );
  const session: RpcSession = {
    client: {
      [WS_METHODS.reviewReadFileVersion]: (input: ReviewReadFileVersionInput) =>
        gated(input.version._tag === "blob" ? input.version.oid : input.version.path, {
          _tag: "text",
          contents: "contents\n",
          byteLength: 9,
        }),
      [WS_METHODS.reviewGetDiffPreview]: (input: ReviewDiffPreviewInput) =>
        gated(`context:${input.contextLines ?? "default"}`, {
          cwd: input.cwd,
          generatedAt: "1970-01-01T00:00:00.000Z",
          sources: [],
        }),
    } as never,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID, label: "Review test" },
    session: yield* SubscriptionRef.make(Option.some(session)),
    state: yield* SubscriptionRef.make({ phase: "connected", generation: 1 }),
  } as never);
  const environment = EnvironmentRegistry.of({
    run: <A, E>(_: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (
      _: EnvironmentId,
      stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
    ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as never);
  const atoms = createReviewEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environment)),
  );
  return {
    atoms,
    registry: AtomRegistry.make(),
    started,
    interrupted,
    gates,
  } satisfies Harness;
});

const blob = (oid: string) => ({
  environmentId: ENVIRONMENT_ID,
  input: { cwd: "/repo", version: { _tag: "blob" as const, oid } },
});

describe("review query lifetimes", () => {
  it.effect("moving to another file interrupts the previous read and keeps none of it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness([OLD_A, OLD_B]);
      try {
        const fileA = h.atoms.fileVersion(blob(OLD_A));
        const releaseA = h.registry.mount(fileA);
        yield* Effect.promise(() => vi.waitFor(() => expect(h.started).toEqual([OLD_A])));

        // The selection moves to file B while A's read is still in flight.
        const fileB = h.atoms.fileVersion(blob(OLD_B));
        h.registry.mount(fileB);
        releaseA();
        yield* Effect.promise(() => vi.waitFor(() => expect(h.interrupted).toEqual([OLD_A])));
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(h.registry.getNodes().get(fileA)).toBeUndefined()),
        );

        yield* Deferred.succeed(h.gates.get(OLD_B)!, undefined);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(AsyncResult.isSuccess(h.registry.get(fileB))).toBe(true)),
        );
        expect(h.started).toEqual([OLD_A, OLD_B]);
      } finally {
        h.registry.dispose();
      }
    }),
  );

  it.effect("a new context count interrupts and drops the previous context patch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(["context:3", "context:7"]);
      const context = (contextLines: number) => ({
        environmentId: ENVIRONMENT_ID,
        input: { cwd: "/repo", contextLines },
      });
      try {
        const three = h.atoms.contextDiffPreview(context(3));
        const releaseThree = h.registry.mount(three);
        yield* Effect.promise(() => vi.waitFor(() => expect(h.started).toEqual(["context:3"])));
        h.registry.mount(h.atoms.contextDiffPreview(context(7)));
        releaseThree();
        yield* Effect.promise(() => vi.waitFor(() => expect(h.interrupted).toEqual(["context:3"])));
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(h.registry.getNodes().get(three)).toBeUndefined()),
        );
        expect(h.started).toEqual(["context:3", "context:7"]);
      } finally {
        h.registry.dispose();
      }
    }),
  );

  it.live("the default patch family keeps a released preview for reuse", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(["context:default"]);
      try {
        const preview = h.atoms.diffPreview({
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo" },
        });
        const release = h.registry.mount(preview);
        yield* Deferred.succeed(h.gates.get("context:default")!, undefined);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(AsyncResult.isSuccess(h.registry.get(preview))).toBe(true)),
        );
        release();
        // Real time (a live test), past the idle check that drops a family set to keep nothing.
        yield* Effect.sleep("20 millis");
        expect(h.registry.getNodes().get(preview)).toBeDefined();
      } finally {
        h.registry.dispose();
      }
    }),
  );
});
