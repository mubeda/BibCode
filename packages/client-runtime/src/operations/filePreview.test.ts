import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  AssetPreviewTypeValidationError,
  PreviewInvalidUrlError,
  ThreadId,
  WS_METHODS,
  type PreviewSessionSnapshot,
  type ServerConfig,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";
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
import { EnvironmentRpcRequestObserver } from "../rpc/client.ts";
import { openHttpFilePreview } from "./filePreview.ts";

const environmentId = EnvironmentId.make("preview-host");
const threadId = ThreadId.make("preview-thread");
const input = { threadId, filePath: "report.html" };
const decodeDescriptor = Schema.decodeEffect(ExecutionEnvironmentDescriptor);
const snapshot: PreviewSessionSnapshot = {
  threadId,
  tabId: "tab",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-02T00:00:00Z",
};
const transport = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({ message: "lost response", cause: "fixture" }),
});
const harness = Effect.fn(function* (pinned = false, base = "https://original.invalid") {
  let lifetime: object = {};
  let relativeUrl = "/api/assets/fixture/report.html";
  let mintEffect: Effect.Effect<void, AssetPreviewTypeValidationError> = Effect.void;
  let openEffect: Effect.Effect<void, RpcClientError.RpcClientError | PreviewInvalidUrlError> =
    Effect.void;
  const calls: Array<{ method: string; input: unknown; session: number }> = [];
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Original",
    httpBaseUrl: base,
    wsBaseUrl: base.replace(/^http/, "ws"),
  });
  let descriptor = yield* decodeDescriptor({
    environmentId,
    label: "Original",
    serverVersion: "test",
    platform: { os: "linux", arch: "x64" },
    storageInstanceId: "store",
    capabilities: {},
  });
  const makeSession = (number: number): RpcSession => ({
    client: {
      [WS_METHODS.assetsCreateUrl]: (value: unknown) =>
        Effect.sync(() => {
          calls.push({ method: "mint", input: value, session: number });
        }).pipe(
          Effect.andThen(Effect.suspend(() => mintEffect)),
          Effect.map(() => ({ relativeUrl, expiresAt: 9_999_999_999_999 })),
        ),
      [WS_METHODS.previewOpen]: (value: unknown) =>
        Effect.sync(() => {
          calls.push({ method: "open", input: value, session: number });
        }).pipe(Effect.andThen(Effect.suspend(() => openEffect)), Effect.as(snapshot)),
    } as unknown as RpcSession["client"],
    initialConfig: Effect.sync(() => ({ environment: descriptor }) as ServerConfig),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  });
  const session = makeSession(1);
  const prepared: PreparedConnection = {
    environmentId,
    label: target.label,
    target,
    descriptor,
    httpBaseUrl: base,
    socketUrl: `${target.wsBaseUrl}/ws`,
    httpAuthorization: null,
    e2ee: pinned
      ? { hostKey: "fixture-pin", auth: { kind: "bearer", credential: "fixture" } }
      : null,
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
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[environmentId, { target, profile: Option.none() }]]),
  );
  const fixture: Pick<EnvironmentRegistry["Service"], "entries" | "registrationLifetime" | "run"> =
    {
      entries,
      registrationLifetime: () => Effect.sync(() => lifetime),
      run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    };
  const registry = fixture as EnvironmentRegistry["Service"];
  const provide = <A, E>(
    effect: Effect.Effect<A, E, EnvironmentRegistry | EnvironmentSupervisor>,
  ) =>
    effect.pipe(
      Effect.provideService(EnvironmentRegistry, registry),
      Effect.provideService(EnvironmentSupervisor, supervisor),
    );
  const change = (
    kind:
      | "target"
      | "pin"
      | "store"
      | "registration"
      | "session"
      | "label"
      | "credential"
      | "disconnect",
  ) =>
    Effect.gen(function* () {
      if (kind === "target")
        yield* SubscriptionRef.set(
          entries,
          new Map([
            [
              environmentId,
              {
                target: new PrimaryConnectionTarget({
                  ...target,
                  httpBaseUrl: "https://replacement.invalid",
                  wsBaseUrl: "wss://replacement.invalid",
                }),
                profile: Option.none(),
              },
            ],
          ]),
        );
      if (kind === "registration") {
        yield* SubscriptionRef.set(entries, new Map());
        lifetime = {};
        yield* SubscriptionRef.set(
          entries,
          new Map([[environmentId, { target, profile: Option.none() }]]),
        );
      }
      if (kind === "store") descriptor = { ...descriptor, storageInstanceId: "replacement-store" };
      if (kind === "session")
        yield* SubscriptionRef.set(supervisor.session, Option.some(makeSession(2)));
      if (kind === "disconnect")
        yield* SubscriptionRef.set(supervisor.state, {
          ...AVAILABLE_CONNECTION_STATE,
          desired: false,
        });
      if (kind === "pin" || kind === "label" || kind === "credential")
        yield* SubscriptionRef.set(
          supervisor.prepared,
          Option.some({
            ...prepared,
            ...(kind === "pin"
              ? {
                  e2ee: {
                    hostKey: "replacement-pin",
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
    });
  return {
    provide,
    calls,
    change,
    clearPrepared: SubscriptionRef.set(supervisor.prepared, Option.none()),
    setMint: (value: typeof mintEffect) => {
      mintEffect = value;
    },
    setOpen: (value: typeof openEffect) => {
      openEffect = value;
    },
    setUrl: (value: string) => {
      relativeUrl = value;
    },
  };
});

describe("coherent HTTP file preview", () => {
  it.effect(
    "keeps an attempted open on its captured session across a late dispatch-boundary replacement",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const result = yield* h.provide(openHttpFilePreview(input)).pipe(
          Effect.provideService(EnvironmentRpcRequestObserver, {
            observe: (request) =>
              request.method === WS_METHODS.previewOpen
                ? h.change("session").pipe(Effect.as(Effect.void))
                : Effect.succeed(Effect.void),
          }),
          Effect.exit,
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { _tag: "FilePreviewUncertainError" } }] },
        });
        expect(h.calls.map((call) => [call.method, call.session])).toEqual([
          ["mint", 1],
          ["open", 1],
        ]);
      }),
  );
  it.effect("preserves a declared mint refusal without attempting open", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const failure = new AssetPreviewTypeValidationError({
        resource: { _tag: "workspace-file", threadId, path: "file.bin" },
      });
      h.setMint(Effect.fail(failure));
      expect(yield* Effect.exit(h.provide(openHttpFilePreview(input)))).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: failure }] },
      });
      expect(h.calls.map((call) => call.method)).toEqual(["mint"]);
    }),
  );
  for (const base of ["http://original.invalid", "https://original.invalid"])
    for (const filePath of ["report.html", "report.pdf", "image.png"]) {
      it.effect(`refuses pinned ${filePath} at ${base} before mint or open`, () =>
        Effect.gen(function* () {
          const h = yield* harness(true, base);
          const exit = yield* Effect.exit(h.provide(openHttpFilePreview({ threadId, filePath })));
          expect(exit._tag).toBe("Failure");
          expect(h.calls).toEqual([]);
        }),
      );
    }
  it.effect("refuses missing prepared context before mint", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.clearPrepared;
      expect((yield* Effect.exit(h.provide(openHttpFilePreview(input))))._tag).toBe("Failure");
      expect(h.calls).toEqual([]);
    }),
  );
  it.effect("mints and opens through the same session with its matching base", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(yield* h.provide(openHttpFilePreview(input))).toEqual({
        url: "https://original.invalid/api/assets/fixture/report.html",
        snapshot,
      });
      expect(h.calls).toEqual([
        {
          method: "mint",
          session: 1,
          input: { resource: { _tag: "workspace-file", threadId, path: input.filePath } },
        },
        {
          method: "open",
          session: 1,
          input: { threadId, url: "https://original.invalid/api/assets/fixture/report.html" },
        },
      ]);
    }),
  );
  for (const kind of ["target", "pin", "store", "registration", "session", "disconnect"] as const) {
    it.effect(`stops before open when ${kind} changes during mint`, () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setMint(h.change(kind));
        const exit = yield* Effect.exit(h.provide(openHttpFilePreview(input)));
        expect(exit._tag).toBe("Failure");
        expect(h.calls.map((x) => x.method)).toEqual(["mint"]);
      }),
    );
    it.effect(`reports uncertainty without replay when ${kind} changes after open admission`, () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setOpen(h.change(kind));
        const exit = yield* Effect.exit(h.provide(openHttpFilePreview(input)));
        expect(exit).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { _tag: "FilePreviewUncertainError" } }] },
        });
        expect(h.calls.map((x) => x.method)).toEqual(["mint", "open"]);
      }),
    );
  }
  for (const kind of ["label", "credential"] as const)
    it.effect(`allows ${kind} metadata changes on the same carrying session`, () =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setMint(h.change(kind));
        expect((yield* h.provide(openHttpFilePreview(input))).snapshot).toBe(snapshot);
        expect(h.calls.every((x) => x.session === 1)).toBe(true);
      }),
    );
  it.effect("does not replay or close after a lost open reply", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setOpen(Effect.fail(transport));
      const exit = yield* Effect.exit(h.provide(openHttpFilePreview(input)));
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: {
          reasons: [
            {
              error: {
                _tag: "FilePreviewUncertainError",
                message: "The preview may already have opened. Check Preview before trying again.",
              },
            },
          ],
        },
      });
      expect(h.calls.map((x) => x.method)).toEqual(["mint", "open"]);
    }),
  );
  it.effect("keeps declared server refusals as ordinary failures", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const failure = new PreviewInvalidUrlError({
        inputLength: 1,
        reason: "unexpected",
        cause: "fixture",
      });
      h.setOpen(Effect.fail(failure));
      expect(yield* Effect.exit(h.provide(openHttpFilePreview(input)))).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: failure }] },
      });
      expect(h.calls).toHaveLength(2);
    }),
  );
  it.effect(
    "cancels a waiting caller without publishing a result or closing an admitted preview",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const opened = yield* Deferred.make<void>();
        h.setOpen(Deferred.succeed(opened, undefined).pipe(Effect.andThen(Effect.never)));
        const fiber = yield* Effect.forkChild(h.provide(openHttpFilePreview(input)));
        yield* Deferred.await(opened);
        yield* Fiber.interrupt(fiber);
        expect(h.calls.map((x) => x.method)).toEqual(["mint", "open"]);
      }),
  );
  it.effect("rejects an address outside the carrying server's asset namespace before open", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setUrl("https://replacement.invalid/api/assets/fixture/report.html");
      expect((yield* Effect.exit(h.provide(openHttpFilePreview(input))))._tag).toBe("Failure");
      expect(h.calls.map((x) => x.method)).toEqual(["mint"]);
    }),
  );
});
