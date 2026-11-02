import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import { RpcClientError } from "effect/rpc/RpcClientError";
import * as Stream from "effect/Stream";

import { applyServerConfigEvent, makeSharedServerConfig } from "./sharedServerConfig.ts";

const CONFIG = {
  cwd: "/tmp/workspace",
  keybindings: [],
  issues: [],
  providers: [],
  settings: DEFAULT_SERVER_SETTINGS,
} as unknown as ServerConfig;

const snapshot = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

describe("makeSharedServerConfig", () => {
  it.effect("takes the initial config from the first snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = yield* makeSharedServerConfig(
          Stream.make(snapshot(CONFIG)).pipe(Stream.concat(Stream.never)),
        );
        expect(yield* shared.initialConfig).toBe(CONFIG);
      }),
    ),
  );

  it.effect("replays the current config to a late subscriber, then passes live events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* Queue.unbounded<ServerConfigStreamEvent>();
        const shared = yield* makeSharedServerConfig(Stream.fromQueue(source));
        yield* Queue.offer(source, snapshot(CONFIG));
        yield* Queue.offer(source, {
          version: 1,
          type: "keybindingsUpdated",
          payload: { keybindings: [], issues: [] },
        });
        yield* shared.initialConfig;
        for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
        const subscriber = yield* Effect.forkChild(
          shared.events.pipe(Stream.take(2), Stream.runCollect),
        );
        for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
        yield* Queue.offer(source, {
          version: 1,
          type: "settingsUpdated",
          payload: { settings: DEFAULT_SERVER_SETTINGS },
        });
        const events = Array.from(yield* Fiber.join(subscriber));
        expect(events.map((event) => event.type)).toEqual(["snapshot", "settingsUpdated"]);
      }),
    ),
  );

  it.effect("fails the initial config and every subscriber when the source fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = yield* makeSharedServerConfig(Stream.fail("settings unreadable" as const));
        expect(yield* Effect.flip(shared.initialConfig)).toBe("settings unreadable");
        expect(yield* Effect.flip(Stream.runCollect(shared.events))).toBe("settings unreadable");
      }),
    ),
  );
});

describe("shared config termination", () => {
  it.effect("fails readiness and subscribers when the source ends before a snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = yield* makeSharedServerConfig(Stream.empty);
        expect(yield* Effect.flip(shared.initialConfig)).toBeInstanceOf(RpcClientError);
        expect(yield* Effect.flip(Stream.runCollect(shared.events))).toBeInstanceOf(RpcClientError);
      }),
    ),
  );

  for (const ending of ["complete", "fail"] as const) {
    it.effect(`settles existing and late subscribers after source ${ending}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const finish = yield* Deferred.make<void>();
          const tail = Stream.fromEffect(Deferred.await(finish)).pipe(
            Stream.flatMap(() =>
              ending === "fail" ? Stream.fail("config source failed") : Stream.empty,
            ),
          );
          const shared = yield* makeSharedServerConfig(
            Stream.make(snapshot(CONFIG)).pipe(Stream.concat(tail)),
          );
          expect(yield* shared.initialConfig).toBe(CONFIG);
          const reading = yield* Effect.forkChild(Effect.flip(Stream.runCollect(shared.events)));
          yield* Deferred.succeed(finish, undefined);
          const existing = yield* Fiber.join(reading);
          const late = yield* Effect.flip(Stream.runCollect(shared.events));
          if (ending === "fail") {
            expect(existing).toBe("config source failed");
            expect(late).toBe("config source failed");
          } else {
            expect(existing).toBeInstanceOf(RpcClientError);
            expect(late).toBeInstanceOf(RpcClientError);
          }
        }),
      ),
    );
  }
});

describe("applyServerConfigEvent", () => {
  it("ignores updates that arrive before the first snapshot", () => {
    expect(
      applyServerConfigEvent(null, {
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_SERVER_SETTINGS },
      }),
    ).toBeNull();
  });
});

describe("applyServerConfigEvent tools", () => {
  const tool = {
    toolId: "codegraph",
    displayName: "CodeGraph",
    installed: true,
    version: "1.6.2",
    checkedAt: "2026-11-02T00:00:00.000Z",
  };

  it("keeps the tools of a status event that carries none, and replaces them when it does", () => {
    const withTools = { ...CONFIG, tools: [tool] } as unknown as ServerConfig;
    const providersOnly = applyServerConfigEvent(withTools, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [] },
    });
    expect(providersOnly?.tools).toEqual([tool]);
    const updated = applyServerConfigEvent(withTools, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [], tools: [{ ...tool, version: "1.6.3" }] },
    });
    expect(updated?.tools?.[0]?.version).toBe("1.6.3");
  });

  it("does not invent tools for a server that never reports them", () => {
    const next = applyServerConfigEvent(CONFIG, {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [] },
    });
    expect(next).not.toHaveProperty("tools");
  });
});
