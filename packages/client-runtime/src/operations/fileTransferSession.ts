import type { ServerConfig } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { ConnectionTarget, PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { currentSession, EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { fileContentRoute } from "./fileContentRoute.ts";

export interface FileContentIdentity {
  readonly registrationLifetime: object;
  readonly routingKey: string;
  readonly storageInstanceId: string | null;
  readonly sessionBoundary: RpcSession | null;
}

export interface FileTransferSession {
  readonly supervisor: EnvironmentSupervisor["Service"];
  readonly session: RpcSession;
  readonly prepared: PreparedConnection;
  readonly config: ServerConfig;
  readonly generation: number;
  readonly identity: FileContentIdentity;
}

function endpointKey(value: string): string | null {
  // Authentication query parameters and userinfo are not content authority.
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function targetKey(target: ConnectionTarget): ReadonlyArray<string | null> | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget": {
      const http = endpointKey(target.httpBaseUrl);
      const socket = endpointKey(target.wsBaseUrl);
      if (http === null || socket === null) return null;
      return [target._tag, target.environmentId, http, socket];
    }
    case "BearerConnectionTarget":
      return [target._tag, target.environmentId, target.connectionId, target.serverEnvironmentId];
    case "SshConnectionTarget":
    case "UnavailableConnectionTarget":
      return [target._tag, target.environmentId, target.connectionId];
    case "RelayConnectionTarget":
      return [target._tag, target.environmentId];
  }
}

const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);

/** Catalog authority is observable even while no session is available. */
export function fileContentCatalogKey(entry: ConnectionCatalogEntry): string | null {
  const target = targetKey(entry.target);
  if (target === null) return null;
  const profile = Option.getOrNull(entry.profile);
  if (
    profile?._tag === "BearerConnectionProfile" &&
    (endpointKey(profile.httpBaseUrl) === null || endpointKey(profile.wsBaseUrl) === null)
  )
    return null;
  return encodeKey([
    encodeKey(target),
    profile === null
      ? null
      : encodeKey(
          profile._tag === "BearerConnectionProfile"
            ? [
                profile._tag,
                profile.connectionId,
                profile.environmentId,
                endpointKey(profile.httpBaseUrl),
                endpointKey(profile.wsBaseUrl),
                profile.hostKey,
              ]
            : [
                profile._tag,
                profile.connectionId,
                profile.environmentId,
                profile.target.hostname,
                profile.target.username ?? null,
                profile.target.port == null ? null : String(profile.target.port),
              ],
        ),
  ]);
}

export function sameFileContentIdentity(a: FileContentIdentity, b: FileContentIdentity): boolean {
  return (
    a.registrationLifetime === b.registrationLifetime &&
    a.routingKey === b.routingKey &&
    a.storageInstanceId === b.storageInstanceId &&
    a.sessionBoundary === b.sessionBoundary
  );
}

function routingKey(entry: ConnectionCatalogEntry, prepared: PreparedConnection): string | null {
  const catalog = fileContentCatalogKey(entry);
  const http = endpointKey(prepared.httpBaseUrl);
  if (catalog === null || http === null) return null;
  return encodeKey([
    catalog,
    prepared.e2ee?.hostKey ?? null,
    // SSH's loopback tunnel port is disposable; its saved host is in the catalog key.
    prepared.target._tag === "SshConnectionTarget" ? null : http,
  ]);
}

/** A terminal publication must not race ahead of the asynchronous identity watcher. */
export const assertFileContentIdentity = Effect.fn("FileTransfers.assertIdentity")(function* (
  registry: EnvironmentRegistry["Service"],
  initial: FileTransferSession,
) {
  const environmentId = initial.supervisor.target.environmentId;
  const changed = () =>
    new EnvironmentRpcUnavailableError({
      environmentId,
      message: "The file's environment changed or disconnected. Start the operation again.",
    });
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
  const lifetime = yield* registry
    .registrationLifetime(environmentId)
    .pipe(Effect.mapError(changed));
  if (
    lifetime !== initial.identity.registrationLifetime ||
    entry === undefined ||
    routingKey(entry, initial.prepared) !== initial.identity.routingKey
  )
    return yield* changed();
  const supervisor = yield* registry
    .run(environmentId, EnvironmentSupervisor)
    .pipe(Effect.mapError(changed));
  const state = yield* SubscriptionRef.get(supervisor.state);
  if (!state.desired || state.phase === "blocked") return yield* changed();
  // A successful old-session Exit can still be saved through an ordinary reconnect.
  // Any newly accepted session must still name the same route and data store.
  if (state.phase === "connected") {
    const session = yield* currentSession().pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
    );
    const current = yield* readFileTransferSession(registry, supervisor, session);
    if (
      !sameFileContentIdentity(initial.identity, current.identity) ||
      fileContentRoute(current.prepared, current.config) !== "in-channel"
    )
      return yield* changed();
  }
});

/** Ends a logical content operation when its authority is removed or replaced. */
export function fileContentInvalidated(
  registry: EnvironmentRegistry["Service"],
  initial: FileTransferSession,
): Effect.Effect<never, EnvironmentRpcUnavailableError> {
  const environmentId = initial.supervisor.target.environmentId;
  const changed = () =>
    new EnvironmentRpcUnavailableError({
      environmentId,
      message: "The file's environment changed or disconnected. Start the operation again.",
    });
  const catalog = SubscriptionRef.changes(registry.entries).pipe(
    Stream.mapEffect((entries) =>
      Effect.gen(function* () {
        const entry = entries.get(environmentId);
        const lifetime = yield* registry
          .registrationLifetime(environmentId)
          .pipe(Effect.mapError(changed));
        if (
          lifetime !== initial.identity.registrationLifetime ||
          entry === undefined ||
          routingKey(entry, initial.prepared) !== initial.identity.routingKey
        )
          return yield* changed();
      }),
    ),
  );
  const connections = registry.followStream(
    environmentId,
    Stream.unwrap(
      EnvironmentSupervisor.pipe(
        Effect.map((supervisor) =>
          SubscriptionRef.changes(supervisor.state).pipe(
            Stream.mapEffect((state) => {
              if (!state.desired || state.phase === "blocked") return Effect.fail(changed());
              if (state.phase !== "connected") return Effect.void;
              return currentSession().pipe(
                Effect.flatMap((session) => readFileTransferSession(registry, supervisor, session)),
                Effect.option,
                Effect.flatMap((carrying) =>
                  Option.isNone(carrying) ||
                  (sameFileContentIdentity(initial.identity, carrying.value.identity) &&
                    fileContentRoute(carrying.value.prepared, carrying.value.config) ===
                      "in-channel")
                    ? Effect.void
                    : Effect.fail(changed()),
                ),
                Effect.provideService(EnvironmentSupervisor, supervisor),
              );
            }),
          ),
        ),
      ),
    ),
  );
  return Stream.merge(catalog, connections).pipe(Stream.runDrain, Effect.andThen(Effect.never));
}

/** Never combine the old session's config with a newly published route or target. */
export const readFileTransferSession = Effect.fn("FileTransfers.readSession")(function* (
  registry: EnvironmentRegistry["Service"],
  supervisor: EnvironmentSupervisor["Service"],
  session: RpcSession,
): Effect.fn.Return<FileTransferSession, EnvironmentRpcUnavailableError> {
  const environmentId = supervisor.target.environmentId;
  const unavailable = () =>
    new EnvironmentRpcUnavailableError({
      environmentId,
      message: `${supervisor.target.label} changed connection. Reconnect before reading files.`,
    });
  const snapshot = () =>
    registry
      .run(
        environmentId,
        Effect.gen(function* () {
          const current = yield* EnvironmentSupervisor;
          const lifetime = yield* registry.registrationLifetime(environmentId);
          return yield* Effect.sync(() => {
            const active = SubscriptionRef.getUnsafe(supervisor.session);
            const prepared = SubscriptionRef.getUnsafe(supervisor.prepared);
            const state = SubscriptionRef.getUnsafe(supervisor.state);
            const entry = SubscriptionRef.getUnsafe(registry.entries).get(environmentId);
            const catalogTarget = entry === undefined ? null : targetKey(entry.target);
            const preparedTarget = Option.isNone(prepared)
              ? null
              : targetKey(prepared.value.target);
            const route =
              entry === undefined || Option.isNone(prepared)
                ? null
                : routingKey(entry, prepared.value);
            if (
              current !== supervisor ||
              Option.isNone(active) ||
              active.value !== session ||
              Option.isNone(prepared) ||
              !state.desired ||
              state.phase !== "connected" ||
              entry === undefined ||
              catalogTarget === null ||
              preparedTarget === null ||
              route === null ||
              prepared.value.environmentId !== environmentId ||
              encodeKey(catalogTarget) !== encodeKey(preparedTarget)
            )
              return null;
            return {
              lifetime,
              routingKey: route,
              prepared: prepared.value,
              generation: state.generation,
              catalogKey: fileContentCatalogKey(entry),
            };
          });
        }),
      )
      .pipe(Effect.mapError(unavailable));
  const before = yield* snapshot();
  if (before === null) return yield* unavailable();
  const config = yield* session.initialConfig.pipe(Effect.mapError(unavailable));
  const after = yield* snapshot();
  if (
    after === null ||
    before.prepared !== after.prepared ||
    before.lifetime !== after.lifetime ||
    before.generation !== after.generation ||
    before.catalogKey !== after.catalogKey
  )
    return yield* unavailable();
  const prepared = before.prepared;
  const storageInstanceId = config.environment.storageInstanceId;
  return {
    supervisor,
    session,
    prepared,
    config,
    generation: before.generation,
    identity: {
      registrationLifetime: before.lifetime,
      routingKey: before.routingKey,
      storageInstanceId,
      sessionBoundary: storageInstanceId === null ? session : null,
    },
  };
});
