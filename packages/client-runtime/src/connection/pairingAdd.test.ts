import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  MIN_COMPATIBLE_REMOTE_PROTOCOL,
  REMOTE_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
  type RemotePairingCodePayload,
  type ServerConfig,
  WS_METHODS,
} from "@bibcode/contracts";
import {
  PairingCodeParseError,
  PairingCodeUnsupportedVersionError,
  encodePairingCode,
} from "@bibcode/shared/pairingCode";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as RpcSession from "../rpc/session.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  BearerConnectionProfile,
  type BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type PreparedConnection,
} from "./model.ts";
import {
  PairingAddError,
  PairingLoopbackAcknowledgementRequiredError,
  verifyAndAddPairingCode,
} from "./pairingAdd.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { storageIdentityTargetKey } from "./storageIdentity.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-paired");
const STORAGE_IDENTITY = "3f2f6a52-6f5f-4f4e-9d38-0a1e2ac21d11";
const HOST_KEY = "HcMLXPPBHFNvcbHrCVMH-DMh49rd5AGCzSCqAVJ49hM";

const validPayload = (overrides?: Partial<RemotePairingCodePayload>): RemotePairingCodePayload => ({
  v: 1,
  endpoint: "http://192.168.1.20:3773",
  name: "AI-SERVER",
  token: "BCDFGHJKMNPQ",
  hostKey: HOST_KEY,
  reach: "another-device",
  storageInstanceId: STORAGE_IDENTITY,
  ...overrides,
});

const descriptor = (
  overrides?: Partial<ExecutionEnvironmentDescriptor>,
): ExecutionEnvironmentDescriptor => ({
  environmentId: ENVIRONMENT_ID,
  label: "Paired environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  storageInstanceId: STORAGE_IDENTITY,
  remoteUpdateSupport: null,
  remoteProtocolVersion: REMOTE_PROTOCOL_VERSION,
  minCompatibleRemoteProtocol: MIN_COMPATIBLE_REMOTE_PROTOCOL,
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: false,
    worktreeCatalogRefreshReason: false,
    vcsStatusSummary: false,
    activityProtocolVersion: null,
    remoteUpdateControl: false,
  },
  ...overrides,
});

interface HarnessOptions {
  readonly descriptor?: ExecutionEnvironmentDescriptor;
  readonly descriptorFailure?: boolean;
  readonly connectionFailures?: Array<ConnectionAttemptError>;
  readonly entries?: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly accepted?: ReadonlyMap<string, string>;
  readonly authenticatedStorageInstanceId?: string;
  readonly authenticatedEnvironmentId?: EnvironmentId;
  readonly pairingConfirmationRequired?: boolean;
  readonly configEnvironmentId?: EnvironmentId;
  readonly configStorageInstanceId?: string;
  readonly registrationPersistenceFailure?: boolean;
  readonly identityPersistenceFailure?: boolean;
  readonly registrationRemovalFailure?: boolean;
  readonly identityRollbackFailure?: boolean;
  readonly identityRollbackInterruptOnce?: boolean;
  readonly confirmationFailure?: boolean;
  readonly confirmationInterrupted?: boolean;
  readonly concurrentIdentityBeforeConfirmationFailure?: string;
  readonly pauseAfterRegistrationCommit?: boolean;
  readonly pauseAfterIdentityCommit?: boolean;
}

const makeHarness = Effect.fn("TestPairingAdd.makeHarness")(function* (
  options: HarnessOptions = {},
) {
  const currentDescriptor = options.descriptor ?? descriptor();
  const httpCalls: string[] = [];
  const registrations: ConnectionRegistration[] = [];
  const acceptedIdentities: Persistence.AcceptedStorageIdentity[] = [];
  const preparedConnections: PreparedConnection[] = [];
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    options.entries ?? new Map(),
  );
  const accepted = new Map(options.accepted ?? []);
  const failures = options.connectionFailures ?? [];
  const events: string[] = [];
  let closedSessions = 0;
  let identityRollbackAttempts = 0;
  const registrationCommitted = yield* Deferred.make<void>();
  const releaseRegistration = yield* Deferred.make<void>();
  const identityCommitted = yield* Deferred.make<void>();
  const releaseIdentity = yield* Deferred.make<void>();

  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries,
    register: (registration: ConnectionRegistration) =>
      options.registrationPersistenceFailure === true
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "register-connection",
              message: "registration storage unavailable",
            }),
          )
        : Effect.uninterruptible(
            Effect.gen(function* () {
              events.push("register");
              registrations.push(registration);
              if (options.pauseAfterRegistrationCommit === true) {
                yield* Deferred.succeed(registrationCommitted, undefined);
                yield* Deferred.await(releaseRegistration);
              }
            }),
          ),
    rollbackRegistration: (registration: ConnectionRegistration) =>
      options.registrationRemovalFailure === true
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "remove-connection",
              message: "registration cleanup unavailable",
            }),
          )
        : Effect.sync(() => {
            const index = registrations.indexOf(registration);
            if (index === -1) return false;
            registrations.splice(index, 1);
            return true;
          }),
    remove: () =>
      options.registrationRemovalFailure === true
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "remove-connection",
              message: "registration cleanup unavailable",
            }),
          )
        : Effect.sync(() => {
            registrations.splice(0, registrations.length);
          }),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const identities = Persistence.AcceptedStorageIdentityStore.of({
    get: (targetKey) => Effect.succeed(Option.fromUndefinedOr(accepted.get(targetKey))),
    accept: (identity) =>
      options.identityPersistenceFailure === true
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "accept-storage-identity",
              message: "identity storage unavailable",
            }),
          )
        : Effect.sync(() => {
            events.push("accept-identity");
            accepted.set(identity.targetKey, identity.storageInstanceId);
            acceptedIdentities.push(identity);
          }),
    rollbackAcceptance: (identity, previousStorageInstanceId) => {
      identityRollbackAttempts += 1;
      if (options.identityRollbackInterruptOnce === true && identityRollbackAttempts === 1) {
        return Effect.interrupt;
      }
      if (options.identityRollbackFailure === true) {
        return Effect.fail(
          new Persistence.ConnectionPersistenceError({
            operation: "accept-storage-identity",
            message: "identity cleanup unavailable",
          }),
        );
      }
      return Effect.sync(() => {
        if (accepted.get(identity.targetKey) !== identity.storageInstanceId) return false;
        if (previousStorageInstanceId === null) accepted.delete(identity.targetKey);
        else accepted.set(identity.targetKey, previousStorageInstanceId);
        const index = acceptedIdentities.findIndex(
          (candidate) =>
            candidate.targetKey === identity.targetKey &&
            candidate.storageInstanceId === identity.storageInstanceId,
        );
        if (index !== -1) acceptedIdentities.splice(index, 1);
        return true;
      });
    },
    transition: (targetKey, decide) =>
      options.identityPersistenceFailure === true
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "accept-storage-identity",
              message: "identity storage unavailable",
            }),
          )
        : Effect.uninterruptible(
            Effect.gen(function* () {
              const transition = decide(accepted.get(targetKey) ?? null);
              if (transition.mutation._tag === "Set") {
                events.push("accept-identity");
                accepted.set(targetKey, transition.mutation.storageInstanceId);
                acceptedIdentities.push({
                  targetKey,
                  storageInstanceId: transition.mutation.storageInstanceId,
                });
              }
              if (options.pauseAfterIdentityCommit === true) {
                yield* Deferred.succeed(identityCommitted, undefined);
                yield* Deferred.await(releaseIdentity);
              }
              return transition.result;
            }),
          ),
  });
  const sessions = RpcSession.RpcSessionFactory.of({
    connect: (prepared) => {
      preparedConnections.push(prepared);
      const failure = failures.shift();
      if (failure !== undefined) return Effect.fail(failure);
      const configDescriptor = descriptor({
        ...currentDescriptor,
        environmentId: options.configEnvironmentId ?? currentDescriptor.environmentId,
        storageInstanceId: options.configStorageInstanceId ?? currentDescriptor.storageInstanceId,
      });
      return Effect.acquireRelease(
        Effect.succeed({
          client: {
            [WS_METHODS.authConfirmPairing]: () =>
              Effect.sync(() => {
                events.push("confirm");
                const latestIdentity = acceptedIdentities.at(-1);
                if (
                  latestIdentity !== undefined &&
                  options.concurrentIdentityBeforeConfirmationFailure !== undefined
                ) {
                  accepted.set(
                    latestIdentity.targetKey,
                    options.concurrentIdentityBeforeConfirmationFailure,
                  );
                }
              }).pipe(
                Effect.flatMap(() =>
                  options.confirmationInterrupted === true
                    ? Effect.interrupt
                    : options.confirmationFailure === true
                      ? Effect.fail(
                          new EnvironmentAuthorizationError({
                            message: "confirmation rejected",
                            requiredScope: "access:write",
                          }),
                        )
                      : Effect.succeed({}),
                ),
              ),
          } as unknown as RpcSession.RpcSession["client"],
          initialConfig: Effect.sync(() => {
            events.push("verify");
            return { environment: configDescriptor } as ServerConfig;
          }),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
          e2eeAuthenticated: Effect.succeed({
            type: "e2ee_authenticated" as const,
            credential: "minted-device-credential",
            environmentId: options.authenticatedEnvironmentId ?? currentDescriptor.environmentId,
            storageInstanceId: options.authenticatedStorageInstanceId ?? STORAGE_IDENTITY,
            ...((options.pairingConfirmationRequired ?? true)
              ? { pairingConfirmationRequired: true as const }
              : {}),
          }),
        }),
        () => Effect.sync(() => void (closedSessions += 1)),
      );
    },
  });
  const fetchFn = ((input) => {
    const url = String(input);
    httpCalls.push(url);
    if (options.descriptorFailure === true) {
      return Promise.reject(new TypeError("network unavailable"));
    }
    if (!url.endsWith("/.well-known/bibcode/environment")) {
      return Promise.reject(new Error(`Unexpected plaintext request: ${url}`));
    }
    return Promise.resolve(Response.json(currentDescriptor));
  }) satisfies typeof fetch;
  const layer = Layer.mergeAll(
    remoteHttpClientLayer(fetchFn),
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
    Layer.succeed(Persistence.AcceptedStorageIdentityStore, identities),
    Layer.succeed(RpcSession.RpcSessionFactory, sessions),
  );

  return {
    acceptedIdentities,
    acceptedIdentity: (targetKey: string) => accepted.get(targetKey),
    events,
    httpCalls,
    preparedConnections,
    registrations,
    closedSessions: () => closedSessions,
    registrationCommitted: Deferred.await(registrationCommitted),
    releaseRegistration: Deferred.succeed(releaseRegistration, undefined),
    identityCommitted: Deferred.await(identityCommitted),
    releaseIdentity: Deferred.succeed(releaseIdentity, undefined),
    run: (payload: RemotePairingCodePayload, allowLoopbackTunnel?: boolean) =>
      verifyAndAddPairingCode({
        code: encodePairingCode(payload),
        ...(allowLoopbackTunnel === undefined ? {} : { allowLoopbackTunnel }),
      }).pipe(Effect.provide(layer)),
  };
});

type PairingFailure =
  | PairingAddError
  | PairingLoopbackAcknowledgementRequiredError
  | PairingCodeParseError
  | PairingCodeUnsupportedVersionError
  | Persistence.ConnectionPersistenceError;

const failureReason = <R>(effect: Effect.Effect<unknown, PairingFailure, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) =>
      Result.isFailure(result) && result.failure._tag === "PairingAddError"
        ? result.failure.reason
        : undefined,
    ),
  );
const isPairingAddError = Schema.is(PairingAddError);

describe("verifyAndAddPairingCode", () => {
  it.effect("requires explicit acknowledgement before dialing loopback codes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .run(validPayload({ endpoint: "http://127.0.0.1:3773", reach: "custom" }))
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PairingLoopbackAcknowledgementRequiredError);
      expect(harness.httpCalls).toEqual([]);
    }),
  );

  it.effect("proceeds through an acknowledged loopback tunnel", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.run(validPayload({ endpoint: "http://127.0.0.1:3773" }), true)).toBe(
        ENVIRONMENT_ID,
      );
      expect(harness.registrations[0]).toMatchObject({
        profile: { hostKey: HOST_KEY, label: "AI-SERVER" },
      });
    }),
  );

  it.effect("rejects wildcard endpoints before making a network call", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        yield* failureReason(harness.run(validPayload({ endpoint: "http://0.0.0.0:3773" }))),
      ).toBe("unreachable");
      expect(harness.httpCalls).toEqual([]);
    }),
  );

  it.effect("classifies descriptor network failures as unreachable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ descriptorFailure: true });
      expect(yield* failureReason(harness.run(validPayload()))).toBe("unreachable");
    }),
  );

  it.effect("blocks incompatible servers but allows legacy capability downgrade", () =>
    Effect.gen(function* () {
      const incompatible = yield* makeHarness({
        descriptor: descriptor({
          remoteProtocolVersion: MIN_COMPATIBLE_REMOTE_PROTOCOL - 1,
          minCompatibleRemoteProtocol: MIN_COMPATIBLE_REMOTE_PROTOCOL,
        }),
      });
      expect(yield* failureReason(incompatible.run(validPayload()))).toBe("incompatible");

      const legacy = yield* makeHarness({
        descriptor: descriptor({ remoteProtocolVersion: 0, minCompatibleRemoteProtocol: 0 }),
      });
      expect(yield* legacy.run(validPayload())).toBe(ENVIRONMENT_ID);
    }),
  );

  it.effect("uses HTTP only for the unauthenticated descriptor hint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(validPayload());
      expect(harness.httpCalls).toEqual([
        "http://192.168.1.20:3773/.well-known/bibcode/environment",
      ]);
    }),
  );

  it.effect("classifies in-channel authentication rejection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        connectionFailures: [
          new ConnectionBlockedError({ reason: "authentication", detail: "expired pairing" }),
        ],
      });
      expect(yield* failureReason(harness.run(validPayload()))).toBe("pairing-rejected");
    }),
  );

  it.effect("classifies pinned host identity mismatch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        connectionFailures: [
          new ConnectionBlockedError({ reason: "host-identity", detail: "wrong host" }),
        ],
      });
      expect(yield* failureReason(harness.run(validPayload()))).toBe("host-identity-mismatch");
    }),
  );

  it.effect("keeps a failed one-time token retryable without persisting partial state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        connectionFailures: [
          new ConnectionTransientError({ reason: "transport", detail: "offline" }),
        ],
      });
      expect(yield* failureReason(harness.run(validPayload()))).toBe("unreachable");
      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
      expect(yield* harness.run(validPayload())).toBe(ENVIRONMENT_ID);
    }),
  );

  it.effect("rejects an environment already present in the registry", () =>
    Effect.gen(function* () {
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Existing",
        connectionId: "bearer:existing",
      });
      const harness = yield* makeHarness({
        entries: new Map([[ENVIRONMENT_ID, { target, profile: Option.none() }]]),
      });
      expect(yield* failureReason(harness.run(validPayload()))).toBe("duplicate-storage-identity");
    }),
  );

  it.effect("rejects a storage identity already accepted by another target", () =>
    Effect.gen(function* () {
      const existingEnvironmentId = EnvironmentId.make("environment-existing");
      const target = new BearerConnectionTarget({
        environmentId: existingEnvironmentId,
        label: "Existing",
        connectionId: "existing",
      });
      const harness = yield* makeHarness({
        entries: new Map([[existingEnvironmentId, { target, profile: Option.none() }]]),
        accepted: new Map([["bearer:existing", STORAGE_IDENTITY]]),
      });
      expect(yield* failureReason(harness.run(validPayload()))).toBe("duplicate-storage-identity");
    }),
  );

  it.effect("requires authenticated storage identity to match the pairing payload", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ authenticatedStorageInstanceId: "different-store" });
      const error = yield* harness.run(validPayload()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(PairingAddError);
      if (!isPairingAddError(error)) throw new Error("expected PairingAddError");
      expect(error).toMatchObject({ reason: "host-identity-mismatch" });
      expect(error.detail).toBe("The server behind this endpoint does not match the pairing code.");
      expect(harness.registrations).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("requires authenticated server config to match the descriptor hint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        configEnvironmentId: EnvironmentId.make("environment-impostor"),
      });
      const error = yield* harness.run(validPayload()).pipe(Effect.flip);
      if (!isPairingAddError(error)) throw new Error("expected PairingAddError");
      expect(error.reason).toBe("host-identity-mismatch");
      expect(error.detail).toBe("The server behind this endpoint does not match the pairing code.");
      expect(harness.registrations).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("closes the bootstrap session when registration persistence fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ registrationPersistenceFailure: true });
      const error = yield* harness.run(validPayload()).pipe(Effect.flip);
      if (!isPairingAddError(error)) throw new Error("expected PairingAddError");
      expect(error.reason).toBe("local-persistence-failed");
      expect(error.detail).toContain("the server connection could not be saved locally");
      expect(error.detail).not.toContain("revoke it there");
      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("compensates registration when identity persistence fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ identityPersistenceFailure: true });
      const error = yield* harness.run(validPayload()).pipe(Effect.flip);
      if (!isPairingAddError(error)) throw new Error("expected PairingAddError");
      expect(error.reason).toBe("local-persistence-failed");
      expect(error.detail).toContain("No partial local writes from this attempt remain");
      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("reports local cleanup failure when identity persistence and compensation fail", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        identityPersistenceFailure: true,
        registrationRemovalFailure: true,
      });
      const error = yield* harness.run(validPayload()).pipe(Effect.flip);
      if (!isPairingAddError(error)) throw new Error("expected PairingAddError");
      expect(error.reason).toBe("local-persistence-failed");
      expect(error.detail).toContain("registration cleanup failed");
      expect(harness.registrations).toHaveLength(1);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("persists only the identity and credential authenticated in channel", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.run(validPayload())).toBe(ENVIRONMENT_ID);

      expect(harness.preparedConnections[0]).toMatchObject({
        socketUrl: "ws://192.168.1.20:3773/ws-e2ee",
        httpAuthorization: null,
        e2ee: { hostKey: HOST_KEY, auth: { kind: "pairing", token: "BCDFGHJKMNPQ" } },
      });
      expect(harness.registrations[0]).toMatchObject({
        target: {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          connectionId: `bearer:${ENVIRONMENT_ID}`,
          label: "AI-SERVER",
        },
        profile: {
          httpBaseUrl: "http://192.168.1.20:3773/",
          wsBaseUrl: "ws://192.168.1.20:3773/",
          hostKey: HOST_KEY,
        },
        credential: { token: "minted-device-credential" },
      });
      expect(
        (harness.registrations[0] as BearerConnectionRegistration | undefined)?.profile,
      ).toBeInstanceOf(BearerConnectionProfile);
      expect(harness.acceptedIdentities).toEqual([
        {
          targetKey: `bearer:bearer:${ENVIRONMENT_ID}`,
          storageInstanceId: STORAGE_IDENTITY,
        },
      ]);
      expect(harness.events).toEqual(["verify", "register", "accept-identity", "confirm"]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("saves an active credential from a legacy server without calling confirmation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ pairingConfirmationRequired: false });

      expect(yield* harness.run(validPayload())).toBe(ENVIRONMENT_ID);
      expect(harness.events).toEqual(["verify", "register", "accept-identity"]);
      expect(harness.registrations).toHaveLength(1);
      expect(harness.acceptedIdentities).toHaveLength(1);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("rolls back local state when pairing confirmation fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ confirmationFailure: true });
      const error = yield* harness.run(validPayload()).pipe(Effect.flip);

      if (!isPairingAddError(error)) throw new Error("expected PairingAddError");
      expect(error.reason).toBe("local-persistence-failed");
      expect(error.detail).toContain("confirmation rejected");
      expect(error.detail).not.toContain("revoke it there");
      expect(harness.events).toEqual(["verify", "register", "accept-identity", "confirm"]);
      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("restores a pre-existing identity when pairing confirmation fails", () =>
    Effect.gen(function* () {
      const targetKey = storageIdentityTargetKey(
        new BearerConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "AI-SERVER",
          connectionId: `bearer:${ENVIRONMENT_ID}`,
        }),
      );
      const harness = yield* makeHarness({
        accepted: new Map([[targetKey, "pre-existing-store"]]),
        confirmationFailure: true,
      });
      yield* harness.run(validPayload()).pipe(Effect.exit);

      expect(harness.acceptedIdentity(targetKey)).toBe("pre-existing-store");
      expect(harness.registrations).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("preserves a concurrent identity replacement during confirmation rollback", () =>
    Effect.gen(function* () {
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "AI-SERVER",
        connectionId: `bearer:${ENVIRONMENT_ID}`,
      });
      const targetKey = storageIdentityTargetKey(target);
      const harness = yield* makeHarness({
        accepted: new Map([[targetKey, "pre-existing-store"]]),
        confirmationFailure: true,
        concurrentIdentityBeforeConfirmationFailure: "concurrent-store",
      });
      yield* harness.run(validPayload()).pipe(Effect.exit);

      expect(harness.acceptedIdentity(targetKey)).toBe("concurrent-store");
      expect(harness.registrations).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("reports each local cleanup failure after confirmation rejection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        confirmationFailure: true,
        registrationRemovalFailure: true,
        identityRollbackFailure: true,
      });
      const error = yield* harness.run(validPayload()).pipe(Effect.flip);

      if (!isPairingAddError(error)) throw new Error("expected PairingAddError");
      expect(error.detail).toContain("identity cleanup failed");
      expect(error.detail).toContain("registration cleanup failed");
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("rolls back local state when pairing confirmation is interrupted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ confirmationInterrupted: true });
      const exit = yield* harness.run(validPayload()).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(harness.events).toEqual(["verify", "register", "accept-identity", "confirm"]);
      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("records registration ownership before observing an interrupt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ pauseAfterRegistrationCommit: true });
      const pairing = yield* Effect.forkChild(harness.run(validPayload()));
      yield* harness.registrationCommitted;
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(pairing));
      yield* Effect.yieldNow;
      yield* harness.releaseRegistration;
      yield* Fiber.await(pairing);
      yield* Fiber.await(interrupting);

      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("records identity ownership before observing an interrupt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ pauseAfterIdentityCommit: true });
      const pairing = yield* Effect.forkChild(harness.run(validPayload()));
      yield* harness.identityCommitted;
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(pairing));
      yield* Effect.yieldNow;
      yield* harness.releaseIdentity;
      yield* Fiber.await(pairing);
      yield* Fiber.await(interrupting);

      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );

  it.effect("rolls back a legacy registration when interrupted after its commit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        pairingConfirmationRequired: false,
        pauseAfterRegistrationCommit: true,
      });
      const pairing = yield* Effect.forkChild(harness.run(validPayload()));
      yield* harness.registrationCommitted;
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(pairing));
      yield* Effect.yieldNow;
      yield* harness.releaseRegistration;
      yield* Fiber.await(pairing);
      yield* Fiber.await(interrupting);

      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
    }),
  );

  it.effect("rolls back legacy local writes when interrupted after identity commit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        pairingConfirmationRequired: false,
        pauseAfterIdentityCommit: true,
      });
      const pairing = yield* Effect.forkChild(harness.run(validPayload()));
      yield* harness.identityCommitted;
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(pairing));
      yield* Effect.yieldNow;
      yield* harness.releaseIdentity;
      yield* Fiber.await(pairing);
      yield* Fiber.await(interrupting);

      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
    }),
  );

  it.effect("retries rollback in the scope finalizer when cleanup is interrupted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        confirmationFailure: true,
        identityRollbackInterruptOnce: true,
      });
      const exit = yield* harness.run(validPayload()).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(harness.registrations).toEqual([]);
      expect(harness.acceptedIdentities).toEqual([]);
      expect(harness.closedSessions()).toBe(1);
    }),
  );
});
