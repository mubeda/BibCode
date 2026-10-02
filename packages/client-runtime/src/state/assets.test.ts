import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  WS_METHODS,
  type ServerConfig,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createAssetEnvironmentAtoms,
  InvalidAssetCollectionKeyError,
  parseAssetCollectionKey,
} from "./assets.ts";

const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const host = EnvironmentId.make("asset-host");
const imageResource = { _tag: "attachment" as const, attachmentId: "image" };
const assetHarness = Effect.fn(function* (
  pinned: boolean,
  capable: boolean,
  initialConfigGate?: Deferred.Deferred<void>,
) {
  const target = new PrimaryConnectionTarget({
    environmentId: host,
    label: "Host",
    httpBaseUrl: "https://host.invalid",
    wsBaseUrl: "wss://host.invalid",
  });
  let mints = 0;
  let reads = 0;
  let blobs = 0;
  const revoked: string[] = [];
  let mintGate: Deferred.Deferred<void> | null = null;
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:asset-${++blobs}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation((value) => {
    revoked.push(value);
  });
  const descriptor = (capability: boolean) =>
    decodeEnvironmentDescriptor({
      environmentId: host,
      label: "Host",
      serverVersion: "test",
      platform: { os: "linux", arch: "x64" },
      storageInstanceId: "store",
      capabilities: { inChannelTransfers: capability },
    });
  const session = (capability: boolean, gate?: Deferred.Deferred<void>): RpcSession => ({
    client: {
      [WS_METHODS.assetsCreateUrl]: () =>
        Effect.gen(function* () {
          mints += 1;
          if (mintGate !== null) yield* Deferred.await(mintGate);
          return { relativeUrl: `/assets/token-${mints}/image`, expiresAt: 9999999999999 };
        }),
      [WS_METHODS.assetsRead]: () => {
        reads += 1;
        return Stream.make({ _tag: "start", mimeType: "image/png", sizeBytes: 0 }, { _tag: "end" });
      },
    } as unknown as RpcSession["client"],
    initialConfig: (gate === undefined ? Effect.void : Deferred.await(gate)).pipe(
      Effect.as({ environment: descriptor(capability) } as ServerConfig),
    ),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  });
  const prepared = (pin: boolean): PreparedConnection => ({
    target,
    environmentId: host,
    label: "Host",
    descriptor: descriptor(capable),
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: `${target.wsBaseUrl}/ws`,
    httpAuthorization: null,
    e2ee: pin ? { hostKey: "pin", auth: { kind: "bearer", credential: "fixture" } } : null,
  });
  const supervisor = EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(session(capable, initialConfigGate))),
    prepared: yield* SubscriptionRef.make(Option.some(prepared(pinned))),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[host, { target, profile: Option.none() }]]),
  );
  const lifetime = {};
  const fixture: Pick<
    EnvironmentRegistry["Service"],
    "entries" | "registrationLifetime" | "run" | "followStream"
  > = {
    entries,
    registrationLifetime: () => Effect.succeed(lifetime),
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  };
  const registry = fixture as EnvironmentRegistry["Service"];
  const assets = createAssetEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, registry)),
  );
  const atomRegistry = AtomRegistry.make();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      atomRegistry.dispose();
      create.mockRestore();
      revoke.mockRestore();
    }),
  );
  return {
    assets,
    atomRegistry,
    supervisor,
    registry,
    counts: () => ({ mints, reads, blobs }),
    revoked,
    retargetHttp: (gate: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        mintGate = gate;
        const replacement = new PrimaryConnectionTarget({
          ...target,
          httpBaseUrl: "https://replacement.invalid",
          wsBaseUrl: "wss://replacement.invalid",
        });
        yield* SubscriptionRef.set(
          entries,
          new Map([[host, { target: replacement, profile: Option.none() }]]),
        );
        yield* SubscriptionRef.set(
          supervisor.prepared,
          Option.some({
            ...prepared(false),
            target: replacement,
            httpBaseUrl: replacement.httpBaseUrl,
          }),
        );
        yield* SubscriptionRef.set(supervisor.session, Option.some(session(false)));
        yield* SubscriptionRef.update(supervisor.state, (value) => ({
          ...value,
          generation: value.generation + 1,
        }));
      }),
    change: (pin: boolean, capability = true) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.set(supervisor.prepared, Option.some(prepared(pin)));
        yield* SubscriptionRef.set(supervisor.session, Option.some(session(capability)));
        yield* SubscriptionRef.update(supervisor.state, (value) => ({
          ...value,
          generation: value.generation + 1,
        }));
      }),
  };
});
const settle = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("Expected asset atom state was not observed");
  });

describe("route-aware asset URLs", () => {
  it.effect("does not attach an old host's cached token to a retargeted HTTP base", () =>
    Effect.gen(function* () {
      const h = yield* assetHarness(false, false);
      const atom = h.assets.url({ environmentId: host, resource: imageResource });
      const unmount = h.atomRegistry.mount(atom);
      yield* settle(() => h.atomRegistry.get(atom) !== null);
      const gate = yield* Deferred.make<void>();
      yield* h.retargetHttp(gate);
      yield* settle(() => h.counts().mints === 2);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect(h.atomRegistry.get(atom)).toBeNull();
      yield* Deferred.succeed(gate, undefined);
      yield* settle(() => h.atomRegistry.get(atom) !== null);
      expect(h.atomRegistry.get(atom)).toBe("https://replacement.invalid/assets/token-2/image");
      unmount();
    }),
  );

  it.effect("resolved collections preserve order and share the same resource atoms", () =>
    Effect.gen(function* () {
      const h = yield* assetHarness(true, true);
      const resources = [imageResource, { _tag: "attachment" as const, attachmentId: "other" }];
      const atom = h.assets.urls({ environmentId: host, resources });
      const unmount = h.atomRegistry.mount(atom);
      yield* settle(() => h.atomRegistry.get(atom).every((value) => value !== null));
      expect(h.atomRegistry.get(atom)[0]).toBe(
        h.atomRegistry.get(h.assets.url({ environmentId: host, resource: imageResource })),
      );
      expect(new Set(h.atomRegistry.get(atom)).size).toBe(2);
      expect(h.counts().reads).toBe(2);
      unmount();
    }),
  );
  for (const pinned of [false, true])
    it.effect(`selects only ${pinned ? "byte" : "HTTP"} dependencies`, () =>
      Effect.gen(function* () {
        const h = yield* assetHarness(pinned, true);
        const atom = h.assets.url({ environmentId: host, resource: imageResource });
        const unmount = h.atomRegistry.mount(atom);
        yield* settle(() => h.atomRegistry.get(atom) !== null);
        expect(h.atomRegistry.get(atom)).toBe(
          pinned ? "blob:asset-1" : "https://host.invalid/assets/token-1/image",
        );
        expect(h.counts()).toEqual(
          pinned ? { reads: 1, mints: 0, blobs: 1 } : { reads: 0, mints: 1, blobs: 0 },
        );
        unmount();
      }),
    );

  it.effect("an unavailable pinned route starts neither mint nor byte read", () =>
    Effect.gen(function* () {
      const h = yield* assetHarness(true, false);
      const atom = h.assets.url({ environmentId: host, resource: imageResource });
      const unmount = h.atomRegistry.mount(atom);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect(h.atomRegistry.get(atom)).toBeNull();
      expect(h.counts()).toEqual({ mints: 0, reads: 0, blobs: 0 });
      unmount();
    }),
  );

  it.effect(
    "guards an already-cached raw mint query when a later refresh runs on a pinned session",
    () =>
      Effect.gen(function* () {
        const h = yield* assetHarness(false, false);
        const raw = h.assets.createUrl({ environmentId: host, input: { resource: imageResource } });
        const unmount = h.atomRegistry.mount(raw);
        yield* settle(() => AsyncResult.isSuccess(h.atomRegistry.get(raw)));
        expect(h.counts().mints).toBe(1);
        yield* h.change(true, false);
        h.atomRegistry.refresh(raw);
        yield* settle(() => AsyncResult.isFailure(h.atomRegistry.get(raw)));
        expect(h.counts()).toEqual({ mints: 1, reads: 0, blobs: 0 });
        unmount();
      }),
  );

  it.effect("does not mint using a prepared route replaced while its config is pending", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const h = yield* assetHarness(false, false, gate);
      const raw = h.assets.createUrl({ environmentId: host, input: { resource: imageResource } });
      const unmount = h.atomRegistry.mount(raw);
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      yield* h.change(true, false);
      yield* Deferred.succeed(gate, undefined);
      yield* settle(() => AsyncResult.isFailure(h.atomRegistry.get(raw)));
      expect(h.counts()).toEqual({ mints: 0, reads: 0, blobs: 0 });
      unmount();
    }),
  );

  it.effect("shares an image between mounted consumers and keeps it after only one unmounts", () =>
    Effect.gen(function* () {
      const h = yield* assetHarness(true, true);
      const atom = h.assets.url({ environmentId: host, resource: imageResource });
      const first = h.atomRegistry.mount(atom);
      const second = h.atomRegistry.mount(atom);
      yield* settle(() => h.atomRegistry.get(atom) !== null);
      first();
      yield* Effect.yieldNow;
      expect(h.atomRegistry.get(atom)).toBe("blob:asset-1");
      expect(h.revoked).toEqual([]);
      expect(h.counts()).toEqual({ mints: 0, reads: 1, blobs: 1 });
      second();
    }),
  );

  it.effect("does not restart an asset or recreate its URL for an ordinary reconnect", () =>
    Effect.gen(function* () {
      const h = yield* assetHarness(true, true);
      const atom = h.assets.url({ environmentId: host, resource: imageResource });
      const unmount = h.atomRegistry.mount(atom);
      yield* settle(() => h.atomRegistry.get(atom) !== null);
      for (let i = 0; i < 3; i++) yield* h.change(true);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect(h.atomRegistry.get(atom)).toBe("blob:asset-1");
      expect(h.counts()).toEqual({ mints: 0, reads: 1, blobs: 1 });
      unmount();
    }),
  );
});

describe("asset collection keys", () => {
  it("preserves malformed JSON and its native cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseAssetCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidAssetCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.any(SyntaxError) });
  });

  it("rejects invalid asset collection shapes", () => {
    const key = JSON.stringify(["environment-1", [{ _tag: "unknown" }]]);

    expect(() => parseAssetCollectionKey(key)).toThrowError(InvalidAssetCollectionKeyError);
  });
});

describe("createAssetEnvironmentAtoms", () => {
  it("keys asset URL queries by environment and resource", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: {
        resource: {
          _tag: "project-favicon" as const,
          cwd: "/repo/original",
        },
      },
    };

    expect(assets.createUrl(originalTarget)).toBe(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
          },
        },
      }),
    );
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/next",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(assets.createUrl(originalTarget));
  });

  it("keys collections while preserving independent resource queries", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const resources = [
      { _tag: "attachment" as const, attachmentId: "attachment-1" },
      { _tag: "attachment" as const, attachmentId: "attachment-2" },
    ];

    expect(assets.createUrls({ environmentId, resources })).toBe(
      assets.createUrls({
        environmentId,
        resources: resources.map((resource) => ({ ...resource })),
      }),
    );
    expect(
      assets.createUrls({
        environmentId,
        resources: [...resources].toReversed(),
      }),
    ).not.toBe(assets.createUrls({ environmentId, resources }));
  });
});
