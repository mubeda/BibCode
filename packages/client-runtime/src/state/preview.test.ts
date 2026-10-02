import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ThreadId,
  WS_METHODS,
  type PreviewOpenInput,
  type ServerConfig,
} from "@bibcode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";

import {
  createPreviewEnvironmentAtoms,
  previewAutomationHostFocusConcurrencyKey,
} from "./preview.ts";
import { isAtomCommandInterrupted } from "./runtime.ts";

const environmentId = EnvironmentId.make("preview-environment");
const threadId = ThreadId.make("preview-thread");
const decodeDescriptor = Schema.decodeEffect(ExecutionEnvironmentDescriptor);
const harness = Effect.fn(function* (options?: {
  readonly runtimeGate?: Effect.Effect<void>;
  readonly warm?: boolean;
  readonly store?: string | null;
}) {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  let mintGate: Effect.Effect<void> = Effect.void;
  let openGate: Effect.Effect<void> = Effect.void;
  let runGate: Effect.Effect<void> = Effect.void;
  let configGate: Effect.Effect<void> = Effect.void;
  let reads = 0;
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Preview",
    httpBaseUrl: "https://fixture.invalid",
    wsBaseUrl: "wss://fixture.invalid",
  });
  let descriptor = yield* decodeDescriptor({
    environmentId,
    label: "Preview",
    serverVersion: "test",
    platform: { os: "linux", arch: "x64" },
    storageInstanceId: options?.store === undefined ? "store" : options.store,
    capabilities: {},
  });
  const session: RpcSession = {
    client: {
      [WS_METHODS.assetsCreateUrl]: (input: unknown) =>
        Effect.sync(() => {
          calls.push({ method: "mint", input });
        }).pipe(
          Effect.andThen(Effect.suspend(() => mintGate)),
          Effect.as({ relativeUrl: "/api/assets/fixture/file.html", expiresAt: 9_999_999_999_999 }),
        ),
      [WS_METHODS.previewOpen]: (input: PreviewOpenInput) =>
        Effect.sync(() => {
          calls.push({ method: "open", input });
        }).pipe(
          Effect.andThen(Effect.suspend(() => openGate)),
          Effect.as({
            threadId: input.threadId,
            tabId: "tab",
            navStatus: { _tag: "Idle" },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-10-02T00:00:00Z",
          }),
        ),
    } as unknown as RpcSession["client"],
    initialConfig: Effect.suspend(() => {
      reads += 1;
      return configGate.pipe(Effect.as({ environment: descriptor } as ServerConfig));
    }),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
  const prepared: PreparedConnection = {
    target,
    environmentId,
    label: target.label,
    descriptor,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: `${target.wsBaseUrl}/ws`,
    httpAuthorization: null,
    e2ee: null,
  };
  const supervisor = EnvironmentSupervisor.of({
    target,
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
    }),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  let lifetime = {};
  const fixture: Pick<EnvironmentRegistry["Service"], "entries" | "registrationLifetime" | "run"> =
    {
      entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        new Map([[environmentId, { target, profile: Option.none() }]]),
      ),
      registrationLifetime: () => Effect.succeed(lifetime),
      run: (_id, effect) =>
        Effect.suspend(() => runGate).pipe(
          Effect.andThen(Effect.provideService(effect, EnvironmentSupervisor, supervisor)),
        ),
    };
  const failed = Atom.make(false);
  const runtime = Atom.runtime((get) =>
    get(failed)
      ? Layer.effect(EnvironmentRegistry, Effect.fail("fixture runtime unavailable"))
      : Layer.effect(
          EnvironmentRegistry,
          (options?.runtimeGate ?? Effect.void).pipe(
            Effect.as(fixture as EnvironmentRegistry["Service"]),
          ),
        ),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createPreviewEnvironmentAtoms(runtime);
  const unmount = registry.mount(runtime);
  yield* Effect.addFinalizer(() => Effect.sync(unmount));
  if (options?.warm !== false)
    for (let i = 0; i < 100 && registry.get(runtime)._tag !== "Success"; i++)
      yield* Effect.yieldNow;
  return {
    fixture,
    atoms,
    registry,
    calls,
    reads: () => reads,
    setRunGate: (value: Effect.Effect<void>) => {
      runGate = value;
    },
    setConfigGate: (value: Effect.Effect<void>) => {
      configGate = value;
    },
    replaceRegistration: Effect.gen(function* () {
      const entries = yield* SubscriptionRef.get(fixture.entries);
      yield* SubscriptionRef.set(fixture.entries, new Map());
      lifetime = {};
      yield* SubscriptionRef.set(fixture.entries, entries);
    }),
    changeAuthority: (kind: "target" | "pin" | "store" | "label" | "credential" | "session") =>
      Effect.gen(function* () {
        if (kind === "target")
          yield* SubscriptionRef.set(
            fixture.entries,
            new Map([
              [
                environmentId,
                {
                  target: new PrimaryConnectionTarget({
                    environmentId,
                    label: "Replacement",
                    httpBaseUrl: "https://replacement.invalid",
                    wsBaseUrl: "wss://replacement.invalid",
                  }),
                  profile: Option.none(),
                },
              ],
            ]),
          );
        if (kind === "store") descriptor = { ...descriptor, storageInstanceId: "replacement" };
        if (kind === "session")
          yield* SubscriptionRef.set(supervisor.session, Option.some({ ...session }));
        if (kind === "pin" || kind === "label" || kind === "credential")
          yield* SubscriptionRef.set(
            supervisor.prepared,
            Option.some({
              ...prepared,
              ...(kind === "pin"
                ? {
                    e2ee: {
                      hostKey: "fixture-pin",
                      auth: { kind: "bearer" as const, credential: "fixture" },
                    },
                  }
                : {}),
              ...(kind === "label" ? { label: "Renamed" } : {}),
              ...(kind === "credential"
                ? { httpAuthorization: { _tag: "Bearer" as const, token: "rotated-fixture" } }
                : {}),
            }),
          );
      }),
    setMint: (value: Effect.Effect<void>) => {
      mintGate = value;
    },
    setOpen: (value: Effect.Effect<void>) => {
      openGate = value;
    },
    failRuntime: (value: boolean) => registry.set(failed, value),
    runtimeState: () => registry.get(runtime),
  };
});
const ticks = Effect.gen(function* () {
  for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
});

describe("preview state commands", () => {
  it.effect("keeps unknown-store queued and returned authority bound to the original session", () =>
    Effect.gen(function* () {
      const h = yield* harness({ store: null });
      const original = yield* Effect.promise(() =>
        h.atoms.openFile.run(h.registry, {
          environmentId,
          input: { threadId, filePath: "file.html" },
        }),
      );
      if (original._tag !== "Success") return yield* Effect.die("Expected same-session preview");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      h.setOpen(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))));
      const typed = h.atoms.open.run(h.registry, {
        environmentId,
        input: { threadId, url: "https://typed.invalid" },
      });
      yield* Deferred.await(entered);
      const queued = h.atoms.openFile.run(h.registry, {
        environmentId,
        input: { threadId, filePath: "original.html" },
      });
      yield* h.changeAuthority("session");
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => typed);
      expect((yield* Effect.promise(() => queued))._tag).toBe("Failure");
      expect(original.value.isCurrentContext()).toBe(false);
      expect(h.calls.map((call) => call.method)).toEqual(["mint", "open", "open"]);
    }),
  );
  for (const kind of ["target", "pin", "store", "label", "credential", "session"] as const) {
    it.effect(`checks queued ${kind} against its original authority`, () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        h.setOpen(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const typed = h.atoms.open.run(h.registry, {
          environmentId,
          input: { threadId, url: "https://typed.invalid" },
        });
        yield* Deferred.await(entered);
        const queued = h.atoms.openFile.run(h.registry, {
          environmentId,
          input: { threadId, filePath: "original.html" },
        });
        yield* h.changeAuthority(kind);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.promise(() => typed);
        const result = yield* Effect.promise(() => queued);
        const compatible = kind === "label" || kind === "credential" || kind === "session";
        expect(result._tag).toBe(compatible ? "Success" : "Failure");
        expect(h.calls.map((call) => call.method)).toEqual(
          compatible ? ["open", "mint", "open"] : ["open"],
        );
      }),
    );
    it.effect(`checks ${kind} again before manual result publication`, () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const result = yield* Effect.promise(() =>
          h.atoms.openFile.run(h.registry, {
            environmentId,
            input: { threadId, filePath: "file.html" },
          }),
        );
        if (result._tag !== "Success") return yield* Effect.die("Expected a ready fixture preview");
        yield* h.changeAuthority(kind);
        expect(result.value.isCurrentContext()).toBe(
          kind === "label" || kind === "credential" || kind === "session",
        );
        expect(h.calls.map((call) => call.method)).toEqual(["mint", "open"]);
      }),
    );
  }
  for (const retired of ["aborted", "disposed"] as const)
    it.effect(`rejects ${retired} result guards before accessing registry atoms`, () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const controller = new AbortController();
        const result = yield* Effect.promise(() =>
          h.atoms.openFile.run(
            h.registry,
            { environmentId, input: { threadId, filePath: "file.html" } },
            { signal: controller.signal },
          ),
        );
        if (result._tag !== "Success") return yield* Effect.die("Expected a ready fixture preview");
        if (retired === "aborted") controller.abort();
        else h.registry.dispose();
        const get = vi.spyOn(h.registry, "get");
        const mount = vi.spyOn(h.registry, "mount");
        const nodes = vi.spyOn(h.registry, "getNodes");
        try {
          expect(result.value.isCurrentContext()).toBe(false);
          expect(get).not.toHaveBeenCalled();
          expect(mount).not.toHaveBeenCalled();
          expect(nodes).not.toHaveBeenCalled();
        } finally {
          get.mockRestore();
          mount.mockRestore();
          nodes.mockRestore();
        }
      }),
    );
  it.effect("preserves a failed witness's FIFO turn ahead of a later typed open", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      h.setOpen(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))));
      const first = h.atoms.open.run(h.registry, {
        environmentId,
        input: { threadId, url: "https://first.invalid" },
      });
      yield* Deferred.await(entered);
      h.setRunGate(Effect.never);
      const order: string[] = [];
      const file = h.atoms.openFile
        .run(h.registry, { environmentId, input: { threadId, filePath: "file.html" } })
        .then((value) => {
          order.push("file");
          return value;
        });
      const next = h.atoms.open
        .run(h.registry, { environmentId, input: { threadId, url: "https://next.invalid" } })
        .then((value) => {
          order.push("next");
          return value;
        });
      expect(order).toEqual([]);
      h.setRunGate(Effect.void);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => first);
      expect((yield* Effect.promise(() => file))._tag).toBe("Failure");
      expect((yield* Effect.promise(() => next))._tag).toBe("Success");
      expect(order).toEqual(["file", "next"]);
      expect(h.calls.map((call) => call.method)).toEqual(["open", "open"]);
    }),
  );
  it.effect("retires a pending guard read without minting when the runtime becomes busy", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* Effect.promise(() =>
        h.atoms.openFile.run(h.registry, {
          environmentId,
          input: { threadId, filePath: "file.html" },
        }),
      );
      if (result._tag !== "Success") return yield* Effect.die("Expected a ready fixture preview");
      let ended = 0;
      h.setRunGate(
        Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ended += 1;
            }),
          ),
        ),
      );
      expect(result.value.isCurrentContext()).toBe(false);
      yield* ticks;
      expect(ended).toBe(1);
      expect(h.calls.map((call) => call.method)).toEqual(["mint", "open"]);
    }),
  );
  it.effect("refuses an old queued file intent after identical registration replacement", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      h.setOpen(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))));
      const typed = h.atoms.open.run(h.registry, {
        environmentId,
        input: { threadId, url: "https://typed.invalid" },
      });
      yield* Deferred.await(entered);
      const queued = h.atoms.openFile.run(h.registry, {
        environmentId,
        input: { threadId, filePath: "original.html" },
      });
      yield* h.replaceRegistration;
      yield* Deferred.succeed(release, undefined);
      yield* Effect.promise(() => typed);
      expect((yield* Effect.promise(() => queued))._tag).toBe("Failure");
      expect(h.calls.map((call) => call.method)).toEqual(["open"]);
    }),
  );
  for (const gate of ["run", "config"] as const)
    it.effect(
      `refuses delayed ${gate} capture and retires it before a later replacement can resume`,
      () =>
        Effect.gen(function* () {
          const h = yield* harness();
          const release = yield* Deferred.make<void>();
          let ended = 0;
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const pending = Deferred.await(release).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ended += 1;
              }),
            ),
          );
          if (gate === "run") h.setRunGate(pending);
          else h.setConfigGate(pending);
          const result = h.atoms.openFile.run(h.registry, {
            environmentId,
            input: { threadId, filePath: "original.html" },
          });
          yield* ticks;
          expect(ended).toBe(1);
          yield* h.replaceRegistration;
          yield* Deferred.succeed(release, undefined);
          expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
          yield* ticks;
          expect(ended).toBe(1);
          expect(h.calls).toEqual([]);
          expect(h.reads()).toBe(gate === "config" ? 1 : 0);
          expect(
            [...h.registry.getNodes().values()].filter(
              (node) => node.atom.label?.[0] === "environment-data:preview:call-entry-authority",
            ),
          ).toHaveLength(0);
        }),
    );
  it.effect(
    "refuses cold runtime capture before the replacement registration becomes visible",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(ready, undefined));
        const h = yield* harness({ runtimeGate: Deferred.await(ready), warm: false });
        const pending = h.atoms.openFile.run(h.registry, {
          environmentId,
          input: { threadId, filePath: "original.html" },
        });
        yield* h.replaceRegistration;
        yield* Deferred.succeed(ready, undefined);
        expect((yield* Effect.promise(() => pending))._tag).toBe("Failure");
        yield* ticks;
        expect(h.calls).toEqual([]);
        expect(h.reads()).toBe(0);
      }),
  );
  it.effect(
    "fences a successful result before manual publication after registration replacement",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const result = yield* Effect.promise(() =>
          h.atoms.openFile.run(h.registry, {
            environmentId,
            input: { threadId, filePath: "file.html" },
          }),
        );
        if (result._tag !== "Success") return yield* Effect.die("Expected a ready fixture preview");
        expect(result.value.isCurrentContext()).toBe(true);
        yield* h.replaceRegistration;
        expect(result.value.isCurrentContext()).toBe(false);
        expect(h.calls.map((call) => call.method)).toEqual(["mint", "open"]);
      }),
  );
  it.effect("never replays an admitted file open when its runtime is replaced", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const opened = yield* Deferred.make<void>();
      h.setOpen(Deferred.succeed(opened, undefined).pipe(Effect.andThen(Effect.never)));
      const pending = h.atoms.openFile.run(h.registry, {
        environmentId,
        input: { threadId, filePath: "file.html" },
      });
      yield* Deferred.await(opened);
      h.failRuntime(true);
      expect((yield* Effect.promise(() => pending))._tag).toBe("Failure");
      h.failRuntime(false);
      yield* ticks;
      expect(h.calls.map((call) => call.method)).toEqual(["mint", "open"]);
    }),
  );
  it.effect("skips a cancelled file request when its queued lifecycle turn arrives", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      h.setOpen(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))));
      const typed = h.atoms.open.run(h.registry, {
        environmentId,
        input: { threadId, url: "https://typed.invalid" },
      });
      yield* Deferred.await(entered);
      const controller = new AbortController();
      const pending = h.atoms.openFile.run(
        h.registry,
        { environmentId, input: { threadId, filePath: "file.html" } },
        { signal: controller.signal },
      );
      controller.abort();
      yield* Deferred.succeed(release, undefined);
      expect((yield* Effect.promise(() => typed))._tag).toBe("Success");
      expect(isAtomCommandInterrupted(yield* Effect.promise(() => pending))).toBe(true);
      expect(h.calls.map((call) => call.method)).toEqual(["open"]);
    }),
  );
  it.effect(
    "serializes file open with existing lifecycle commands while other threads proceed",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        h.setMint(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const file = h.atoms.openFile.run(h.registry, {
          environmentId,
          input: { threadId, filePath: "file.html" },
        });
        yield* Deferred.await(entered);
        const typed = h.atoms.open.run(h.registry, {
          environmentId,
          input: { threadId, url: "https://typed.invalid" },
        });
        const independent = yield* Effect.promise(() =>
          h.atoms.open.run(h.registry, {
            environmentId,
            input: { threadId: ThreadId.make("other-thread"), url: "https://independent.invalid" },
          }),
        );
        expect(independent._tag).toBe("Success");
        expect(h.calls).toHaveLength(2);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Effect.promise(() => file))._tag).toBe("Success");
        expect((yield* Effect.promise(() => typed))._tag).toBe("Success");
        expect(h.calls.map((call) => call.method)).toEqual(["mint", "open", "open", "open"]);
        expect(h.calls.at(-1)).toEqual({
          method: "open",
          input: { threadId, url: "https://typed.invalid" },
        });
      }),
  );
  it.effect("never starts a failed command after its runtime recovers", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.failRuntime(true);
      for (let i = 0; i < 100 && h.runtimeState()._tag !== "Failure"; i++) yield* Effect.yieldNow;
      expect(h.runtimeState()._tag).toBe("Failure");
      const result = yield* Effect.promise(() =>
        h.atoms.openFile.run(h.registry, {
          environmentId,
          input: { threadId, filePath: "file.html" },
        }),
      );
      expect(result._tag).toBe("Failure");
      h.failRuntime(false);
      yield* ticks;
      expect(h.calls).toEqual([]);
    }),
  );
  it.effect("suppresses an aborted view's result after the preview open was admitted", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const opened = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      h.setOpen(
        Deferred.succeed(opened, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(ended, undefined)),
        ),
      );
      const controller = new AbortController();
      const pending = h.atoms.openFile.run(
        h.registry,
        { environmentId, input: { threadId, filePath: "file.html" } },
        { signal: controller.signal },
      );
      yield* Deferred.await(opened);
      controller.abort();
      expect(isAtomCommandInterrupted(yield* Effect.promise(() => pending))).toBe(true);
      yield* Deferred.await(ended);
      expect(h.calls.map((call) => call.method)).toEqual(["mint", "open"]);
    }),
  );
  it("keeps focus updates from replacement host connections independent", () => {
    const first = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-1" },
    });
    const replacement = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-2" },
    });

    expect(first).not.toBe(replacement);
  });
});
