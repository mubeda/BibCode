import {
  EnvironmentId,
  type DesktopSshEnvironmentTarget,
  type ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type KnownEnvironment,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  DirectHttpsRoute,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  SshTunnelRoute,
  type ConnectionTarget,
  UnavailableConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as Persistence from "../platform/persistence.ts";

const ENVIRONMENT_ID = EnvironmentId.make("00000000-0000-4000-8000-000000000001");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
  providerKind: "cloudflare_tunnel" as const,
};
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Current environment",
  platform: {
    os: "linux",
    arch: "x64",
  },
  serverVersion: "0.0.0-test",
  storageInstanceId: "00000000-0000-4000-8000-000000000002",
  protocol: { minimum: 1, maximum: 1 },
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: false,
    worktreeCatalogRefreshReason: false,
    vcsStatusSummary: false,
    activityProtocolVersion: null,
  },
} satisfies ExecutionEnvironmentDescriptor;
const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "development",
  hostname: "development.example.test",
  username: "developer",
  port: 22,
};

function catalogEntry(
  target: ConnectionTarget,
  profile: Option.Option<ConnectionProfile> = Option.none(),
): ConnectionCatalogEntry {
  return { target, profile };
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeVerifiedBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeVerifiedBearer"];
  readonly primaryBearerToken?: string;
  readonly inspectSsh?: ClientCapabilities.SshEnvironmentGateway["Service"]["inspect"];
  readonly descriptor?: ExecutionEnvironmentDescriptor;
  readonly routeSecret?: string;
  readonly verifyDirectHttps?: ConnectionResolver.RouteTransportSecurityService["verifyDirectHttps"];
  readonly events?: string[];
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer:
      options?.authorizeBearer ??
      ((input) =>
        Effect.succeed({
          descriptor: options?.descriptor ?? DESCRIPTOR,
          environmentId: input.expectedEnvironmentId,
          label: "Authorized bearer environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=bearer",
          httpAuthorization: {
            _tag: "Bearer" as const,
            token: input.bearerToken,
          },
        })),
    authorizeVerifiedBearer:
      options?.authorizeVerifiedBearer ??
      ((input) =>
        Effect.sync(() => options?.events?.push("open-session")).pipe(
          Effect.as({
            descriptor: input.identity.descriptor,
            environmentId: input.identity.environmentId,
            label: input.identity.descriptor.label,
            httpBaseUrl: input.httpBaseUrl,
            socketUrl: "wss://authorized.example.test/ws?wsTicket=verified",
            httpAuthorization: {
              _tag: "Bearer" as const,
              token: input.bearerToken,
            },
          }),
        )),
  });
  const routeSecrets = Persistence.EnvironmentSecretStore.of({
    put: () => Effect.die(new Error("Secret writes are not used by resolver tests.")),
    get: () =>
      Effect.sync(() => options?.events?.push("load-secret")).pipe(
        Effect.as(Option.fromNullishOr(options?.routeSecret)),
      ),
    delete: () => Effect.void,
  });
  const routeTransportSecurity = ConnectionResolver.RouteTransportSecurity.of({
    verifyDirectHttps:
      options?.verifyDirectHttps ??
      (() => Effect.sync(() => options?.events?.push("transport-trust"))),
  });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    inspect:
      options?.inspectSsh ??
      ((input) =>
        Effect.sync(() =>
          options?.events?.push(
            "ssh-trust",
            "probe",
            "ensure-server",
            "open-tunnel",
            "fetch-descriptor",
          ),
        ).pipe(
          Effect.as({
            bootstrap: {
              target: input.target,
              httpBaseUrl: "http://127.0.0.1:4010",
              wsBaseUrl: "ws://127.0.0.1:4010",
              hostKeyFingerprint: input.hostKeyFingerprint ?? "SHA256:known-host-key",
            },
            descriptor: options?.descriptor ?? DESCRIPTOR,
          }),
        )),
    exchange: () => Effect.die("unused"),
    disconnect: () => Effect.void,
  });

  const dependencies = Layer.mergeAll(
    remoteHttpClientLayer(() => {
      options?.events?.push("fetch-descriptor");
      return Promise.resolve(Response.json(options?.descriptor ?? DESCRIPTOR));
    }),
    Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(Persistence.EnvironmentSecretStore, routeSecrets),
    Layer.succeed(ConnectionResolver.RouteTransportSecurity, routeTransportSecurity),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(dependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("rejects an unavailable desired environment before resolving any endpoint", () =>
    Effect.gen(function* () {
      const brokerLayer = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const target = new UnavailableConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "WSL (Ubuntu)",
        connectionId: "local:wsl:Ubuntu",
        configuredDistro: "Ubuntu",
        detail: "the configured WSL distribution could not start",
      });

      const error = yield* broker.prepare(catalogEntry(target)).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "endpoint-unavailable",
        detail: "the configured WSL distribution could not start",
      });
    }),
  );

  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const brokerLayer = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        descriptor: DESCRIPTOR,
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl: "ws://127.0.0.1:3777/ws",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("authorizes a desktop primary environment with its platform bearer token", () =>
    Effect.gen(function* () {
      const bearerInputs = yield* Ref.make<ReadonlyArray<string>>([]);
      const brokerLayer = yield* makeDependencies({
        primaryBearerToken: "desktop-bearer",
        authorizeBearer: (input) =>
          Ref.update(bearerInputs, (values) => [...values, input.bearerToken]).pipe(
            Effect.as({
              descriptor: DESCRIPTOR,
              environmentId: input.expectedEnvironmentId,
              label: "Primary",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "ws://127.0.0.1:3777/ws?wsTicket=desktop",
              httpAuthorization: {
                _tag: "Bearer" as const,
                token: input.bearerToken,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toMatchObject({
        descriptor: DESCRIPTOR,
        socketUrl: "ws://127.0.0.1:3777/ws?wsTicket=desktop",
        httpAuthorization: { _tag: "Bearer", token: "desktop-bearer" },
        target,
      });
      expect(yield* Ref.get(bearerInputs)).toEqual(["desktop-bearer"]);
    }),
  );

  it.effect("uses the registered bearer profile without re-reading the profile store", () =>
    Effect.gen(function* () {
      const bearerInputs = yield* Ref.make<ReadonlyArray<string>>([]);
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Saved",
        connectionId: "saved-1",
      });
      const profile = new BearerConnectionProfile({
        connectionId: "saved-1",
        environmentId: ENVIRONMENT_ID,
        label: "Saved",
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      });
      const brokerLayer = yield* makeDependencies({
        credentials: [["saved-1", new BearerConnectionCredential({ token: "secret-bearer" })]],
        authorizeBearer: (input) =>
          Ref.update(bearerInputs, (values) => [...values, input.bearerToken]).pipe(
            Effect.as({
              descriptor: DESCRIPTOR,
              environmentId: input.expectedEnvironmentId,
              label: "Saved",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
              httpAuthorization: {
                _tag: "Bearer" as const,
                token: input.bearerToken,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      const prepared = yield* broker.prepare(catalogEntry(target, Option.some(profile)));
      expect(prepared.socketUrl).toContain("wsTicket=ticket");
      expect(prepared.descriptor).toEqual(DESCRIPTOR);
      expect(yield* Ref.get(bearerInputs)).toEqual(["secret-bearer"]);
    }),
  );

  it.effect("blocks pre-v3 SSH entries before platform pairing", () =>
    Effect.gen(function* () {
      const preparedTargets = yield* Ref.make<ReadonlyArray<DesktopSshEnvironmentTarget>>([]);
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh-1",
      });
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const brokerLayer = yield* makeDependencies({
        inspectSsh: (input) =>
          Ref.update(preparedTargets, (values) => [...values, input.target]).pipe(
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                hostKeyFingerprint: "SHA256:known-host-key",
              },
              descriptor: DESCRIPTOR,
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      const error = yield* broker
        .prepare(catalogEntry(target, Option.some(profile)))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "configuration" });
      expect(yield* Ref.get(preparedTargets)).toEqual([]);
    }),
  );
});

describe("ConnectionResolver normalized routes", () => {
  const route = new DirectHttpsRoute({
    routeId: "direct-https",
    environmentId: ENVIRONMENT_ID,
    label: "Direct HTTPS",
    priority: 0,
    pinned: false,
    autoconnect: true,
    secretRef: "bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8",
    httpsBaseUrl: ENDPOINT.httpBaseUrl,
    trust: { _tag: "System" },
  });
  const environment = {
    environmentId: ENVIRONMENT_ID,
    acceptedStorageInstanceId: DESCRIPTOR.storageInstanceId,
    descriptor: DESCRIPTOR,
    alias: "Current environment",
    hidden: false,
    bindings: [],
    routes: [route],
  } as KnownEnvironment;

  it.effect("verifies transport and descriptor identity before loading a route secret", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const brokerLayer = yield* makeDependencies({
        events,
        routeSecret: "protected-session-secret",
        authorizeVerifiedBearer: (input) =>
          Effect.sync(() => events.push("open-session")).pipe(
            Effect.as({
              descriptor: input.identity.descriptor,
              environmentId: input.identity.environmentId,
              label: input.identity.descriptor.label,
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://authorized.example.test/ws?wsTicket=verified",
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      const prepared = yield* broker.prepareRoute({
        environment,
        route,
        cancellation: new AbortController().signal,
      });

      expect(events).toEqual([
        "transport-trust",
        "fetch-descriptor",
        "load-secret",
        "open-session",
      ]);
      expect(prepared.verifiedRouteIdentity).toMatchObject({
        routeId: route.routeId,
        environmentId: ENVIRONMENT_ID,
        storageInstanceId: DESCRIPTOR.storageInstanceId,
        transportTrust: "system-tls",
      });
    }),
  );

  it.effect("does not read the secret after a descriptor storage mismatch", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const brokerLayer = yield* makeDependencies({
        events,
        routeSecret: "must-not-be-read",
        descriptor: { ...DESCRIPTOR, storageInstanceId: "00000000-0000-4000-8000-000000000099" },
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      const error = yield* broker
        .prepareRoute({ environment, route, cancellation: new AbortController().signal })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionStorageChangedError",
        reason: "storage-changed",
      });
      expect(events).toEqual(["transport-trust", "fetch-descriptor"]);
    }),
  );

  it.effect("blocks certificate, environment, and protocol mismatches before secret access", () =>
    Effect.gen(function* () {
      for (const testCase of [
        {
          descriptor: {
            ...DESCRIPTOR,
            environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000099"),
          },
          reason: "environment-changed",
        },
        {
          descriptor: { ...DESCRIPTOR, protocol: { minimum: 2, maximum: 3 } },
          reason: "version-incompatible",
        },
      ] as const) {
        const events: string[] = [];
        const brokerLayer = yield* makeDependencies({ events, descriptor: testCase.descriptor });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(brokerLayer),
        );
        const error = yield* broker
          .prepareRoute({ environment, route, cancellation: new AbortController().signal })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ reason: testCase.reason });
        expect(events).toEqual(["transport-trust", "fetch-descriptor"]);
      }

      const certificateEvents: string[] = [];
      const certificateLayer = yield* makeDependencies({
        events: certificateEvents,
        verifyDirectHttps: () =>
          Effect.fail(
            new ConnectionBlockedError({
              reason: "certificate-changed",
              detail: "The pinned certificate changed.",
            }),
          ),
      });
      const certificateBroker = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(certificateLayer),
      );
      const certificateError = yield* certificateBroker
        .prepareRoute({ environment, route, cancellation: new AbortController().signal })
        .pipe(Effect.flip);
      expect(certificateError).toMatchObject({ reason: "certificate-changed" });
      expect(certificateEvents).toEqual([]);
    }),
  );

  it.effect("blocks an unpersisted SSH route before pairing or native work", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const sshRoute = new SshTunnelRoute({
        routeId: "ssh-route",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        priority: 0,
        pinned: false,
        autoconnect: true,
        secretRef: null,
        target: SSH_TARGET,
        hostKeyFingerprint: "SHA256:known-host-key",
      });
      const sshEnvironment: KnownEnvironment = {
        ...environment,
        routes: [sshRoute],
      };
      const brokerLayer = yield* makeDependencies({
        events,
        authorizeVerifiedBearer: (input) =>
          Effect.sync(() => events.push("open-session")).pipe(
            Effect.as({
              descriptor: input.identity.descriptor,
              environmentId: input.identity.environmentId,
              label: input.identity.descriptor.label,
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "ws://127.0.0.1:4010/ws?wsTicket=verified",
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      const error = yield* broker
        .prepareRoute({
          environment: sshEnvironment,
          route: sshRoute,
          cancellation: new AbortController().signal,
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(events).toEqual([]);
    }),
  );

  it.effect("threads the exact environment and route generations into SSH inspection", () =>
    Effect.gen(function* () {
      let observed: {
        readonly environmentGeneration: number | undefined;
        readonly bindingGeneration: number | undefined;
      } | null = null;
      const sshRoute = new SshTunnelRoute({
        routeId: "ssh-route",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        priority: 0,
        pinned: false,
        autoconnect: true,
        secretRef: "ssh-secret",
        target: SSH_TARGET,
        hostKeyFingerprint: "SHA256:known-host-key",
      });
      const brokerLayer = yield* makeDependencies({
        inspectSsh: (input) =>
          Effect.sync(() => {
            observed = {
              environmentGeneration: input.environmentGeneration,
              bindingGeneration: input.bindingGeneration,
            };
            return {
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                hostKeyFingerprint: "SHA256:known-host-key",
              },
              descriptor: {
                ...DESCRIPTOR,
                environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000099"),
              },
            };
          }),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      yield* broker
        .prepareRoute({
          environment: { ...environment, routes: [sshRoute] },
          route: sshRoute,
          environmentGeneration: 8,
          routeGeneration: 21,
          cancellation: new AbortController().signal,
        })
        .pipe(Effect.flip);

      expect(observed).toEqual({
        environmentGeneration: 8,
        bindingGeneration: 21,
      });
    }),
  );

  it.effect("never creates SSH pairing after environment storage or protocol mismatch", () =>
    Effect.gen(function* () {
      for (const descriptor of [
        {
          ...DESCRIPTOR,
          environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000099"),
        },
        { ...DESCRIPTOR, storageInstanceId: "00000000-0000-4000-8000-000000000099" },
        { ...DESCRIPTOR, protocol: { minimum: 2, maximum: 2 } },
      ] satisfies ReadonlyArray<ExecutionEnvironmentDescriptor>) {
        const events: string[] = [];
        const sshRoute = new SshTunnelRoute({
          routeId: "ssh-route",
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          priority: 0,
          pinned: false,
          autoconnect: true,
          secretRef: "ssh-secret",
          target: SSH_TARGET,
          hostKeyFingerprint: "SHA256:known-host-key",
        });
        const brokerLayer = yield* makeDependencies({ events, descriptor });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(brokerLayer),
        );

        yield* broker
          .prepareRoute({
            environment: { ...environment, routes: [sshRoute] },
            route: sshRoute,
            cancellation: new AbortController().signal,
          })
          .pipe(Effect.flip);

        expect(events).toEqual([
          "ssh-trust",
          "probe",
          "ensure-server",
          "open-tunnel",
          "fetch-descriptor",
        ]);
      }
    }),
  );
});
