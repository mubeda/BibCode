import type { EnvironmentId } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentBinding,
  KnownEnvironment,
  KnownEnvironmentRecord,
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import {
  type ConnectionTarget,
  EnvironmentRoute,
  PersistedConnectionTarget,
} from "../connection/model.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import { AcceptedStorageIdentitySchema } from "./persistence.ts";

/**
 * Raw schema-v1 input used only by the bounded v3 migration. Unknown legacy
 * rows are decoded without making removed target/credential variants part of
 * the normal runtime contract.
 */
export const LegacyConnectionCatalogV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(Schema.Unknown),
  profiles: Schema.Array(Schema.Unknown),
  credentials: Schema.Array(Schema.Unknown),
  remoteDpopTokens: Schema.Array(Schema.Unknown),
  acceptedStorageIdentities: Schema.Array(Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type LegacyConnectionCatalogV1 = typeof LegacyConnectionCatalogV1.Type;

function hasUniqueIdentifiers<Value, Identifier>(
  values: ReadonlyArray<Value>,
  getIdentifier: (value: Value) => Identifier,
): boolean {
  const identifiers = values.map(getIdentifier);
  return new Set(identifiers).size === identifiers.length;
}

export const NormalizedEnvironmentCatalogRows = Schema.Struct({
  environments: Schema.Array(KnownEnvironmentRecord),
  routes: Schema.Array(EnvironmentRoute),
  bindings: Schema.Array(EnvironmentBinding),
}).check(
  Schema.makeFilter(
    (rows) =>
      hasUniqueIdentifiers(rows.environments, (environment) => environment.environmentId) ||
      "Environment identifiers must be globally unique.",
  ),
  Schema.makeFilter(
    (rows) =>
      hasUniqueIdentifiers(rows.routes, (route) => route.routeId) ||
      "Route identifiers must be globally unique.",
  ),
  Schema.makeFilter(
    (rows) =>
      hasUniqueIdentifiers(rows.bindings, (binding) => binding.bindingId) ||
      "Binding identifiers must be globally unique.",
  ),
  Schema.makeFilter((rows) => {
    const environmentIds = new Set(rows.environments.map((row) => row.environmentId));
    return (
      rows.routes.every((route) => environmentIds.has(route.environmentId)) ||
      "Every route must reference a stored environment."
    );
  }),
  Schema.makeFilter((rows) => {
    const environmentIds = new Set(rows.environments.map((row) => row.environmentId));
    return (
      rows.bindings.every(
        (binding) =>
          binding.acceptedEnvironmentId === null ||
          environmentIds.has(binding.acceptedEnvironmentId),
      ) || "Every proved binding must reference a stored environment."
    );
  }),
  Schema.makeFilter(
    (rows) =>
      rows.environments.every(
        (environment) =>
          rows.routes.filter(
            (route) => route.environmentId === environment.environmentId && route.pinned,
          ).length <= 1,
      ) || "At most one route may be pinned for each environment.",
  ),
);
export type NormalizedEnvironmentCatalogRows = typeof NormalizedEnvironmentCatalogRows.Type;

const decodeKnownEnvironment = Schema.decodeUnknownSync(KnownEnvironment);

/** Reconstitute aggregate snapshots only after all normalized rows validate. */
export function assembleKnownEnvironments(
  rows: NormalizedEnvironmentCatalogRows,
): ReadonlyArray<KnownEnvironment> {
  return rows.environments.map((environment) =>
    decodeKnownEnvironment({
      ...environment,
      routes: rows.routes.filter((route) => route.environmentId === environment.environmentId),
      bindings: rows.bindings.filter(
        (binding) => binding.acceptedEnvironmentId === environment.environmentId,
      ),
    }),
  );
}

/** Pure reference mutation for transaction implementations and migration tests. */
export function removeEnvironmentFromCatalogRows(
  rows: NormalizedEnvironmentCatalogRows,
  environmentId: EnvironmentId,
): NormalizedEnvironmentCatalogRows {
  return {
    environments: rows.environments.filter(
      (environment) => environment.environmentId !== environmentId,
    ),
    routes: rows.routes.filter((route) => route.environmentId !== environmentId),
    bindings: rows.bindings.filter((binding) => binding.acceptedEnvironmentId !== environmentId),
  };
}

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

/** @deprecated Migration adapter. Delete after the IndexedDB v3 migration lands. */
export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
  acceptedStorageIdentities: Schema.Array(AcceptedStorageIdentitySchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  acceptedStorageIdentities: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
    case "UnavailableConnectionTarget":
      return target.connectionId;
  }
}

function removeConnectionMetadata(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
  removeRemoteToken: boolean,
): ConnectionCatalogDocument {
  const connectionId = connectionIdOf(target);
  return {
    ...document,
    targets: removeCatalogValue(
      document.targets,
      (value) => value.environmentId,
      target.environmentId,
    ),
    profiles:
      connectionId === null
        ? document.profiles
        : removeCatalogValue(document.profiles, (value) => value.connectionId, connectionId),
    credentials:
      connectionId === null
        ? document.credentials
        : removeCatalogValue(document.credentials, (value) => value.connectionId, connectionId),
    remoteDpopTokens: removeRemoteToken
      ? removeCatalogValue(
          document.remoteDpopTokens,
          (value) => value.environmentId,
          target.environmentId,
        )
      : document.remoteDpopTokens,
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
): ConnectionCatalogDocument {
  const target = registration.target;
  const previous = document.targets.find(
    (candidate) => candidate.environmentId === target.environmentId,
  );
  const cleaned =
    previous === undefined ? document : removeConnectionMetadata(document, previous, false);
  const next: ConnectionCatalogDocument = {
    ...cleaned,
    targets: replaceCatalogValue(cleaned.targets, (value) => value.environmentId, target),
  };

  switch (registration._tag) {
    case "RelayConnectionRegistration":
      return next;
    case "BearerConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials: replaceCatalogValue(next.credentials, (value) => value.connectionId, {
          connectionId: registration.target.connectionId,
          credential: registration.credential,
        }),
      };
    case "SshConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
      };
  }
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  target: ConnectionTarget,
): ConnectionCatalogDocument {
  return removeConnectionMetadata(document, target, true);
}
