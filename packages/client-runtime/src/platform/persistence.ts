import {
  DurableEnvironmentId,
  type EnvironmentId,
  NonNegativeInt,
  type OrchestrationThread,
  type OrchestrationShellSnapshot,
  ProjectId,
  type ThreadId,
  ThreadId as ThreadIdSchema,
  TrimmedNonEmptyString,
} from "@bibcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { CacheManifestEntry, CacheQuarantineEntry } from "../cache/envelope.ts";

import type {
  ConnectionRegistration,
  EnvironmentBinding,
  KnownEnvironment,
} from "../connection/catalog.ts";
import type { ConnectionTarget, EnvironmentRoute } from "../connection/model.ts";

export class ConnectionPersistenceError extends Schema.TaggedErrorClass<ConnectionPersistenceError>()(
  "ConnectionPersistenceError",
  {
    operation: Schema.Literals([
      "list-targets",
      "register-connection",
      "remove-connection",
      "load-shell",
      "save-shell",
      "load-thread",
      "save-thread",
      "remove-thread",
      "clear-environment",
      "load-storage-identity",
      "accept-storage-identity",
      "reset-connection-catalog",
      "list-environments",
      "load-environment",
      "put-environment",
      "update-environment-routes",
      "list-environment-bindings",
      "put-environment-binding",
      "forget-environment",
      "list-environment-cleanup-repairs",
      "save-environment-cleanup-repair",
      "load-environment-ui-state",
      "save-environment-ui-state",
      "clear-environment-ui-state",
      "put-environment-secret",
      "get-environment-secret",
      "delete-environment-secret",
      "load-cache-manifest",
      "save-cache-manifest",
      "delete-cache-manifest",
      "load-migration-receipt",
      "save-migration-receipt",
    ]),
    message: Schema.String,
  },
) {}

export class ConnectionTargetStore extends Context.Service<
  ConnectionTargetStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ConnectionTarget>, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/ConnectionTargetStore") {}

export class ConnectionRegistrationStore extends Context.Service<
  ConnectionRegistrationStore,
  {
    readonly register: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly remove: (target: ConnectionTarget) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/ConnectionRegistrationStore") {}

/**
 * Atomic normalized catalog boundary. Implementations publish a complete
 * KnownEnvironment only after its environment, route, and binding rows commit.
 */
export class EnvironmentCatalogStore extends Context.Service<
  EnvironmentCatalogStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<KnownEnvironment>, ConnectionPersistenceError>;
    readonly load: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<KnownEnvironment>, ConnectionPersistenceError>;
    readonly put: (
      environment: KnownEnvironment,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly updateRoutes: (
      environmentId: EnvironmentId,
      routes: ReadonlyArray<EnvironmentRoute>,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly listBindings: Effect.Effect<
      ReadonlyArray<EnvironmentBinding>,
      ConnectionPersistenceError
    >;
    readonly putBinding: (
      binding: EnvironmentBinding,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/EnvironmentCatalogStore") {}

export const EnvironmentCleanupRepairPhase = Schema.Literals([
  "pending",
  "secret-deletion-failed",
  "metadata-deletion-failed",
]);
export type EnvironmentCleanupRepairPhase = typeof EnvironmentCleanupRepairPhase.Type;

/** Redacted, crash-persistent evidence that local Forget must be retried. */
export const EnvironmentCleanupRepairReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: DurableEnvironmentId,
  generation: NonNegativeInt,
  phase: EnvironmentCleanupRepairPhase,
});
export type EnvironmentCleanupRepairReceipt = typeof EnvironmentCleanupRepairReceipt.Type;

/**
 * Two-phase boundary for cancellation-safe local cleanup. Secret deletion happens
 * between `saveRepair` and `commitForget`; the final commit removes every
 * non-secret environment row and the repair receipt in one durable transaction.
 */
export class EnvironmentCleanupStore extends Context.Service<
  EnvironmentCleanupStore,
  {
    readonly repairs: Effect.Effect<
      ReadonlyArray<EnvironmentCleanupRepairReceipt>,
      ConnectionPersistenceError
    >;
    readonly saveRepair: (
      receipt: EnvironmentCleanupRepairReceipt,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly commitForget: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/EnvironmentCleanupStore") {}

export const EnvironmentUiStateDocument = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  selected: Schema.NullOr(
    Schema.Struct({
      environmentId: DurableEnvironmentId,
      projectId: Schema.NullOr(ProjectId),
      threadId: Schema.NullOr(ThreadIdSchema),
    }),
  ),
  expandedEnvironmentIds: Schema.Array(DurableEnvironmentId),
  expandedProjectKeys: Schema.Array(TrimmedNonEmptyString),
  manuallyToggledKeys: Schema.Array(TrimmedNonEmptyString),
  environmentOrder: Schema.Array(DurableEnvironmentId),
  pinnedEnvironmentIds: Schema.Array(DurableEnvironmentId),
  projectOrderByEnvironment: Schema.Record(DurableEnvironmentId, Schema.Array(ProjectId)),
});
export type EnvironmentUiStateDocument = typeof EnvironmentUiStateDocument.Type;

export class EnvironmentUiStateStore extends Context.Service<
  EnvironmentUiStateStore,
  {
    readonly load: Effect.Effect<
      Option.Option<EnvironmentUiStateDocument>,
      ConnectionPersistenceError
    >;
    readonly save: (
      state: EnvironmentUiStateDocument,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly clearEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/EnvironmentUiStateStore") {}

export const EnvironmentSecretPurpose = Schema.Literals([
  "environment-session",
  "dpop-private-key",
  "cache-key",
]);
export type EnvironmentSecretPurpose = typeof EnvironmentSecretPurpose.Type;

export class EnvironmentSecretStore extends Context.Service<
  EnvironmentSecretStore,
  {
    readonly put: (
      environmentId: EnvironmentId,
      purpose: EnvironmentSecretPurpose,
      value: string,
    ) => Effect.Effect<string, ConnectionPersistenceError>;
    readonly get: (
      secretRef: string,
    ) => Effect.Effect<Option.Option<string>, ConnectionPersistenceError>;
    readonly delete: (secretRef: string) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/EnvironmentSecretStore") {}

const StorageInstanceId = Schema.String.check(Schema.isUUID());

export const EnvironmentCacheManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: DurableEnvironmentId,
  storageInstanceId: StorageInstanceId,
  keyRef: Schema.NullOr(TrimmedNonEmptyString),
  persistence: Schema.Literals(["durable", "session-only"]),
  lastSynchronizedAt: Schema.NullOr(TrimmedNonEmptyString),
  maxBytes: NonNegativeInt,
  maxAgeMs: NonNegativeInt,
  totalBytes: NonNegativeInt,
  entries: Schema.Array(CacheManifestEntry).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  quarantine: Schema.Array(CacheQuarantineEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type EnvironmentCacheManifest = typeof EnvironmentCacheManifest.Type;

export class EnvironmentCacheManifestStore extends Context.Service<
  EnvironmentCacheManifestStore,
  {
    readonly load: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<EnvironmentCacheManifest>, ConnectionPersistenceError>;
    readonly save: (
      manifest: EnvironmentCacheManifest,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/EnvironmentCacheManifestStore") {}

export const EnvironmentMigrationReceipt = Schema.Struct({
  id: TrimmedNonEmptyString,
  completedAt: TrimmedNonEmptyString,
});
export type EnvironmentMigrationReceipt = typeof EnvironmentMigrationReceipt.Type;

export class EnvironmentMigrationStore extends Context.Service<
  EnvironmentMigrationStore,
  {
    readonly load: (
      migrationId: string,
    ) => Effect.Effect<Option.Option<EnvironmentMigrationReceipt>, ConnectionPersistenceError>;
    readonly save: (
      receipt: EnvironmentMigrationReceipt,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/EnvironmentMigrationStore") {}

export interface AcceptedStorageIdentity {
  readonly targetKey: string;
  readonly storageInstanceId: string;
}

export const AcceptedStorageIdentitySchema = Schema.Struct({
  targetKey: Schema.String,
  storageInstanceId: Schema.String,
});

export type AcceptedStorageIdentityMutation =
  | {
      readonly _tag: "Keep";
    }
  | {
      readonly _tag: "Set";
      readonly storageInstanceId: string;
    };

export interface AcceptedStorageIdentityTransition<A> {
  readonly result: A;
  readonly mutation: AcceptedStorageIdentityMutation;
}

export class AcceptedStorageIdentityStore extends Context.Service<
  AcceptedStorageIdentityStore,
  {
    readonly get: (
      targetKey: string,
    ) => Effect.Effect<Option.Option<string>, ConnectionPersistenceError>;
    readonly accept: (
      identity: AcceptedStorageIdentity,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly transition: <A>(
      targetKey: string,
      decide: (acceptedStorageInstanceId: string | null) => AcceptedStorageIdentityTransition<A>,
    ) => Effect.Effect<A, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/AcceptedStorageIdentityStore") {}

export type ConnectionCatalogHealth =
  | { readonly status: "ready" }
  | { readonly status: "recovery-required"; readonly message: string };

export class ConnectionCatalogHealthStore extends Context.Service<
  ConnectionCatalogHealthStore,
  {
    readonly state: SubscriptionRef.SubscriptionRef<ConnectionCatalogHealth>;
    readonly reset: Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/ConnectionCatalogHealthStore") {}

export class EnvironmentCacheStore extends Context.Service<
  EnvironmentCacheStore,
  {
    readonly loadShell: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<OrchestrationShellSnapshot>, ConnectionPersistenceError>;
    readonly saveShell: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationShellSnapshot,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly loadThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<OrchestrationThread>, ConnectionPersistenceError>;
    readonly saveThread: (
      environmentId: EnvironmentId,
      thread: OrchestrationThread,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly removeThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly clear: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/EnvironmentCacheStore") {}

export class EnvironmentOwnedDataCleanup extends Context.Reference<{
  readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void>;
}>("@bibcode/client-runtime/platform/persistence/EnvironmentOwnedDataCleanup", {
  defaultValue: () => ({
    clear: () => Effect.void,
  }),
}) {}
