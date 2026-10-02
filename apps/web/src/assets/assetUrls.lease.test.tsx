// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  WS_METHODS,
  type ServerConfig,
} from "@bibcode/contracts";
import type { RpcSession } from "@bibcode/client-runtime/rpc";
import { createAssetEnvironmentAtoms } from "@bibcode/client-runtime/state/assets";
import { EnvironmentRegistry } from "@bibcode/client-runtime/connection";
import { EnvironmentSupervisor } from "@bibcode/client-runtime/connection";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@bibcode/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vite-plus/test";
const h = vi.hoisted(() => ({
  assets: null as ReturnType<typeof createAssetEnvironmentAtoms> | null,
}));
vi.mock("~/state/assets", () => ({
  assetEnvironment: {
    url: (input: Parameters<ReturnType<typeof createAssetEnvironmentAtoms>["url"]>[0]) =>
      h.assets!.url(input),
    urls: (input: Parameters<ReturnType<typeof createAssetEnvironmentAtoms>["urls"]>[0]) =>
      h.assets!.urls(input),
  },
}));
import { useAssetUrl } from "./assetUrls";
const environmentId = EnvironmentId.make("lease-view"),
  resource = { _tag: "attachment" as const, attachmentId: "image" };
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
function View({ name }: { name: string }) {
  const url = useAssetUrl(environmentId, resource);
  return <output data-view={name}>{url ?? "waiting"}</output>;
}
describe("compiled asset hook lease integration", () => {
  it.effect(
    "shares a real C read between two views and releases views without revoking borrowed cached URLs",
    () =>
      Effect.gen(function* () {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        let reads = 0;
        const revoked: string[] = [];
        const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-lease");
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
          revoked.push(url);
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            create.mockRestore();
            revoke.mockRestore();
          }),
        );
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: "Fixture",
          httpBaseUrl: "https://fixture.invalid",
          wsBaseUrl: "wss://fixture.invalid",
        });
        const descriptor = decodeDescriptor({
          environmentId,
          label: "Fixture",
          serverVersion: "fixture",
          platform: { os: "linux", arch: "x64" },
          storageInstanceId: "store",
          capabilities: { inChannelTransfers: true },
        });
        const session: RpcSession = {
          client: {
            [WS_METHODS.assetsRead]: () => {
              reads++;
              return Stream.make(
                { _tag: "start", mimeType: "image/png", sizeBytes: 0 },
                { _tag: "end" },
              );
            },
          } as unknown as RpcSession["client"],
          initialConfig: Effect.succeed({ environment: descriptor } as ServerConfig),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
          e2eeAuthenticated: Effect.succeed(null),
        };
        const prepared: PreparedConnection = {
          target,
          environmentId,
          label: "Fixture",
          descriptor,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: `${target.wsBaseUrl}/ws`,
          httpAuthorization: null,
          e2ee: { hostKey: "fixture-pin", auth: { kind: "bearer", credential: "fixture-only" } },
        };
        const supervisor = EnvironmentSupervisor.of({
          target,
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.some(prepared)),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            phase: "connected",
            generation: 1,
          }),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const entries = yield* SubscriptionRef.make(
          new Map([[environmentId, { target, profile: Option.none() }]]),
        );
        const lifetime = {};
        const service = {
          entries,
          registrationLifetime: () => Effect.succeed(lifetime),
          run: <A, E, R>(
            _id: EnvironmentId,
            effect: Effect.Effect<A, E, R | EnvironmentSupervisor>,
          ) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: <A, E, R>(
            _id: EnvironmentId,
            stream: Stream.Stream<A, E, R | EnvironmentSupervisor>,
          ) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as unknown as EnvironmentRegistry["Service"];
        h.assets = createAssetEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry, service)),
        );
        const registry = AtomRegistry.make();
        const element = document.createElement("div");
        document.body.append(element);
        const root = createRoot(element);
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await act(async () => root.unmount());
            registry.dispose();
            element.remove();
            h.assets = null;
          }),
        );
        const render = (both: boolean) =>
          act(async () =>
            root.render(
              <RegistryContext.Provider value={registry}>
                <View name="one" />
                {both ? <View name="two" /> : null}
              </RegistryContext.Provider>,
            ),
          );
        yield* Effect.promise(() => render(true));
        for (
          let n = 0;
          n < 100 && element.textContent !== "blob:shared-leaseblob:shared-lease";
          n++
        )
          yield* Effect.promise(() =>
            act(async () => {
              await Promise.resolve();
            }),
          );
        expect(element.textContent).toBe("blob:shared-leaseblob:shared-lease");
        expect(reads).toBe(1);
        expect(create).toHaveBeenCalledOnce();
        yield* Effect.promise(() => render(false));
        expect(element.textContent).toBe("blob:shared-lease");
        expect(revoked).toEqual([]);
        yield* Effect.promise(() => act(async () => root.render(null)));
        for (let n = 0; n < 10; n++) yield* Effect.yieldNow;
        expect(revoked).toEqual([]);
        yield* Effect.promise(() => render(true));
        for (let n = 0; n < 20; n++) yield* Effect.yieldNow;
        expect(reads).toBe(1);
        yield* SubscriptionRef.set(entries, new Map());
        for (
          let n = 0;
          n < 100 && (revoked.length === 0 || element.textContent?.includes("blob:shared-lease"));
          n++
        )
          yield* Effect.promise(() =>
            act(async () => {
              await Promise.resolve();
            }),
          );
        expect(revoked).toEqual(["blob:shared-lease"]);
        expect(element.textContent).not.toContain("blob:shared-lease");
      }),
  );
});
