import {
  CacheManifestEntry,
  EncryptedCacheEnvelope,
  selectCacheEvictions,
  shouldReplaceCacheEntry,
  type CacheAssociatedDataScope,
  type CacheEntityKind,
  type CacheQuarantineReason,
  type EncryptedCacheEnvelope as EncryptedCacheEnvelopeType,
} from "@bibcode/client-runtime/cache";
import {
  AcceptedStorageIdentityStore,
  type ConnectionCatalogHealth,
  ConnectionCatalogHealthStore,
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  EnvironmentCacheManifest,
  EnvironmentCacheManifestStore,
  EnvironmentCacheStore,
  EnvironmentCatalogStore,
  EnvironmentMigrationReceipt,
  EnvironmentMigrationStore,
  EnvironmentSecretStore,
  EnvironmentUiStateDocument,
  EnvironmentUiStateStore,
  NormalizedEnvironmentCatalogRows,
  assembleKnownEnvironments,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
} from "@bibcode/client-runtime/platform";
import { TokenStore } from "@bibcode/client-runtime/authorization";
import {
  EnvironmentBinding,
  EnvironmentRoute,
  ConnectionTransientError,
  CredentialStore,
  KnownEnvironment,
  ProfileStore,
} from "@bibcode/client-runtime/connection";
import {
  type DesktopBridge,
  type DesktopSecretReference,
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ThreadId,
} from "@bibcode/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  CATALOG_V1_TO_V3_MIGRATION_ID,
  planCatalogV1ToV3Migration,
  type CatalogMigrationMetadata,
} from "./catalogMigration.ts";
import {
  cacheEnvelopeByteLength,
  decodeCacheKeyMaterial,
  decryptCachePayload,
  encodeCacheKeyMaterial,
  encryptCachePayload,
  generateCacheKey,
  generateCacheKeyMaterial,
  importCacheKeyMaterial,
} from "./cacheCrypto.ts";

const DATABASE_NAME = "bibcode:connection-runtime";
const DATABASE_VERSION = 3;
const CATALOG_STORE_NAME = "catalog";
const SHELL_STORE_NAME = "shell";
const THREAD_STORE_NAME = "thread";
const ENVIRONMENTS_STORE_NAME = "environments";
const ENVIRONMENT_ROUTES_STORE_NAME = "environmentRoutes";
const ENVIRONMENT_BINDINGS_STORE_NAME = "environmentBindings";
const ENVIRONMENT_UI_STATE_STORE_NAME = "environmentUiState";
const ENVIRONMENT_CACHE_MANIFEST_STORE_NAME = "environmentCacheManifest";
const ENCRYPTED_SHELL_CACHE_STORE_NAME = "shellCache";
const ENCRYPTED_THREAD_CACHE_STORE_NAME = "threadCache";
const MIGRATION_STATE_STORE_NAME = "migrationState";
export const NORMALIZED_STORE_NAMES = [
  ENVIRONMENTS_STORE_NAME,
  ENVIRONMENT_ROUTES_STORE_NAME,
  ENVIRONMENT_BINDINGS_STORE_NAME,
  ENVIRONMENT_UI_STATE_STORE_NAME,
  ENVIRONMENT_CACHE_MANIFEST_STORE_NAME,
  ENCRYPTED_SHELL_CACHE_STORE_NAME,
  ENCRYPTED_THREAD_CACHE_STORE_NAME,
  MIGRATION_STATE_STORE_NAME,
] as const;
const ENVIRONMENT_UI_STATE_KEY = "client";
const CATALOG_KEY = "document";
const MAX_CATALOG_COMPARE_AND_SET_ATTEMPTS = 8;
const CORRUPT_CATALOG_MESSAGE =
  "The connection catalog is corrupt and must be reset before it can be changed.";
const SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const CACHE_SHELL_ENTITY_ID = "shell";

const StoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
});
const StoredShellSnapshotJson = Schema.fromJsonString(StoredShellSnapshot);
const StoredThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  thread: OrchestrationThread,
});
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredThreadSnapshot);
const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);
const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshotJson);
const encodeStoredShellSnapshot = Schema.encodeEffect(StoredShellSnapshotJson);
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshotJson);
const encodeStoredThreadSnapshot = Schema.encodeEffect(StoredThreadSnapshotJson);
const decodeNormalizedEnvironmentCatalogRows = Schema.decodeUnknownEffect(
  NormalizedEnvironmentCatalogRows,
);
const decodeKnownEnvironment = Schema.decodeUnknownEffect(KnownEnvironment);
const decodeEnvironmentRoutes = Schema.decodeUnknownEffect(Schema.Array(EnvironmentRoute));
const decodeEnvironmentBindings = Schema.decodeUnknownEffect(Schema.Array(EnvironmentBinding));
const decodeEnvironmentBinding = Schema.decodeUnknownEffect(EnvironmentBinding);
const decodeEnvironmentUiStateDocument = Schema.decodeUnknownEffect(EnvironmentUiStateDocument);
const decodeEnvironmentCacheManifest = Schema.decodeUnknownEffect(EnvironmentCacheManifest);
const decodeEnvironmentCacheManifestSync = Schema.decodeUnknownSync(EnvironmentCacheManifest);
const decodeEncryptedCacheEnvelope = Schema.decodeUnknownEffect(EncryptedCacheEnvelope);
const decodeEnvironmentMigrationReceipt = Schema.decodeUnknownEffect(EnvironmentMigrationReceipt);

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

function persistenceError(
  operation:
    | "list-targets"
    | "register-connection"
    | "remove-connection"
    | "load-shell"
    | "save-shell"
    | "load-thread"
    | "save-thread"
    | "remove-thread"
    | "clear-environment",
  cause: unknown,
) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

function storageIdentityPersistenceError(
  operation: "load-storage-identity" | "accept-storage-identity",
) {
  return new ConnectionPersistenceError({
    operation,
    message:
      operation === "load-storage-identity"
        ? "Could not load the accepted storage identity."
        : "Could not accept the reported storage identity.",
  });
}

type EnvironmentSecretPersistenceOperation =
  | "put-environment-secret"
  | "get-environment-secret"
  | "delete-environment-secret";

function environmentSecretPersistenceError(operation: EnvironmentSecretPersistenceOperation) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")} using protected desktop storage.`,
  });
}

/**
 * Provides opaque secret references backed exclusively by the desktop OS store.
 * Browser storage is deliberately not a fallback for credentials or key material.
 */
export function makeEnvironmentSecretStore(
  bridge: DesktopBridge | undefined,
): EnvironmentSecretStore["Service"] {
  return EnvironmentSecretStore.of({
    put: (_environmentId, purpose, value) =>
      Effect.tryPromise({
        try: async () => {
          if (bridge?.putSecret === undefined) {
            throw new Error("Protected desktop secret storage is unavailable.");
          }
          return bridge.putSecret({ purpose, value });
        },
        catch: () => environmentSecretPersistenceError("put-environment-secret"),
      }),
    get: (secretRef) =>
      Effect.tryPromise({
        try: async () => {
          if (bridge?.getSecret === undefined) {
            throw new Error("Protected desktop secret storage is unavailable.");
          }
          return bridge.getSecret(secretRef as DesktopSecretReference);
        },
        catch: () => environmentSecretPersistenceError("get-environment-secret"),
      }).pipe(Effect.map(Option.fromNullishOr)),
    delete: (secretRef) =>
      Effect.tryPromise({
        try: async () => {
          if (bridge?.deleteSecret === undefined) {
            throw new Error("Protected desktop secret storage is unavailable.");
          }
          await bridge.deleteSecret(secretRef as DesktopSecretReference);
        },
        catch: () => environmentSecretPersistenceError("delete-environment-secret"),
      }),
  });
}

function catalogResetPersistenceError() {
  return new ConnectionPersistenceError({
    operation: "reset-connection-catalog",
    message: "Could not reset the connection catalog.",
  });
}

type NormalizedPersistenceOperation =
  | "list-environments"
  | "load-environment"
  | "put-environment"
  | "update-environment-routes"
  | "list-environment-bindings"
  | "put-environment-binding"
  | "forget-environment"
  | "load-environment-ui-state"
  | "save-environment-ui-state"
  | "clear-environment-ui-state"
  | "load-cache-manifest"
  | "save-cache-manifest"
  | "delete-cache-manifest"
  | "load-migration-receipt"
  | "save-migration-receipt";

function normalizedPersistenceError(operation: NormalizedPersistenceOperation, cause: unknown) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

function createNormalizedStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(ENVIRONMENTS_STORE_NAME)) {
    database.createObjectStore(ENVIRONMENTS_STORE_NAME, { keyPath: "environmentId" });
  }
  if (!database.objectStoreNames.contains(ENVIRONMENT_ROUTES_STORE_NAME)) {
    const store = database.createObjectStore(ENVIRONMENT_ROUTES_STORE_NAME, {
      keyPath: "routeId",
    });
    store.createIndex("environmentId", "environmentId", { unique: false });
  }
  if (!database.objectStoreNames.contains(ENVIRONMENT_BINDINGS_STORE_NAME)) {
    const store = database.createObjectStore(ENVIRONMENT_BINDINGS_STORE_NAME, {
      keyPath: ["_tag", "bindingId"],
    });
    store.createIndex("environmentId", "acceptedEnvironmentId", { unique: false });
  }
  if (!database.objectStoreNames.contains(ENVIRONMENT_UI_STATE_STORE_NAME)) {
    const store = database.createObjectStore(ENVIRONMENT_UI_STATE_STORE_NAME);
    store.createIndex("environmentId", "environmentOrder", {
      unique: false,
      multiEntry: true,
    });
  }
  if (!database.objectStoreNames.contains(ENVIRONMENT_CACHE_MANIFEST_STORE_NAME)) {
    const store = database.createObjectStore(ENVIRONMENT_CACHE_MANIFEST_STORE_NAME, {
      keyPath: "environmentId",
    });
    store.createIndex("environmentId", "environmentId", { unique: true });
  }
  if (!database.objectStoreNames.contains(ENCRYPTED_SHELL_CACHE_STORE_NAME)) {
    const store = database.createObjectStore(ENCRYPTED_SHELL_CACHE_STORE_NAME, {
      keyPath: "environmentId",
    });
    store.createIndex("environmentId", "environmentId", { unique: true });
  }
  if (!database.objectStoreNames.contains(ENCRYPTED_THREAD_CACHE_STORE_NAME)) {
    const store = database.createObjectStore(ENCRYPTED_THREAD_CACHE_STORE_NAME, {
      keyPath: ["environmentId", "threadId"],
    });
    store.createIndex("environmentId", "environmentId", { unique: false });
  }
  if (!database.objectStoreNames.contains(MIGRATION_STATE_STORE_NAME)) {
    database.createObjectStore(MIGRATION_STATE_STORE_NAME, { keyPath: "id" });
  }
}

export const openConnectionDatabase = Effect.fn("web.connectionStorage.openDatabase")(function* (
  databaseName = DATABASE_NAME,
) {
  return yield* Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
    if (typeof indexedDB === "undefined") {
      resume(
        Effect.fail(catalogError("open", "IndexedDB is unavailable in this browser context.")),
      );
      return;
    }
    const request = indexedDB.open(databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(CATALOG_STORE_NAME)) {
        request.result.createObjectStore(CATALOG_STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(SHELL_STORE_NAME)) {
        request.result.createObjectStore(SHELL_STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(THREAD_STORE_NAME)) {
        request.result.createObjectStore(THREAD_STORE_NAME);
      }
      createNormalizedStores(request.result);
    });
    request.addEventListener("error", () => {
      resume(Effect.fail(catalogError("open", request.error ?? "Unknown IndexedDB error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  });
});

function readDatabaseValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionTransientError>((resume) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.addEventListener("error", () => {
      resume(Effect.fail(catalogError("read", request.error ?? "Unknown IndexedDB read error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  }).pipe(Effect.withSpan("web.connectionStorage.readDatabaseValue"));
}

function writeDatabaseValue(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).put(value, key);
  }).pipe(Effect.withSpan("web.connectionStorage.writeDatabaseValue"));
}

function writeInlineDatabaseValue(database: IDBDatabase, storeName: string, value: unknown) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).put(value);
  }).pipe(Effect.withSpan("web.connectionStorage.writeInlineDatabaseValue"));
}

function upsertEnvironmentBinding(database: IDBDatabase, binding: EnvironmentBinding) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(
      [ENVIRONMENT_BINDINGS_STORE_NAME, ENVIRONMENTS_STORE_NAME],
      "readwrite",
    );
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("put environment binding", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown IndexedDB binding error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "IndexedDB binding transaction aborted"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    });

    const store = transaction.objectStore(ENVIRONMENT_BINDINGS_STORE_NAME);
    const request = store.get([binding._tag, binding.bindingId]);
    let currentLoaded = false;
    let current: { readonly acceptedEnvironmentId?: unknown } | undefined;
    let environmentLoaded = binding.acceptedEnvironmentId === null;
    let environmentExists = binding.acceptedEnvironmentId === null;
    const publish = () => {
      if (!currentLoaded || !environmentLoaded) return;
      if (!environmentExists) {
        fail("A proved binding must reference a stored environment.");
        transaction.abort();
        return;
      }
      const currentEnvironmentId = current?.acceptedEnvironmentId;
      if (
        typeof currentEnvironmentId === "string" &&
        currentEnvironmentId !== binding.acceptedEnvironmentId
      ) {
        fail("A proved binding cannot be reassigned to another environment.");
        transaction.abort();
        return;
      }
      store.put(binding);
    };
    request.addEventListener("success", () => {
      current = request.result as { readonly acceptedEnvironmentId?: unknown } | undefined;
      currentLoaded = true;
      publish();
    });
    if (binding.acceptedEnvironmentId !== null) {
      const environmentRequest = transaction
        .objectStore(ENVIRONMENTS_STORE_NAME)
        .get(binding.acceptedEnvironmentId);
      environmentRequest.addEventListener("success", () => {
        environmentLoaded = true;
        environmentExists = environmentRequest.result !== undefined;
        publish();
      });
    }
  }).pipe(Effect.withSpan("web.connectionStorage.upsertEnvironmentBinding"));
}

function compareAndSetDatabaseValue(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  expected: string | null,
  next: string,
) {
  return Effect.callback<boolean, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    let matched = false;
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(
          catalogError(
            "compare and set",
            transaction.error ?? "Unknown IndexedDB transaction error",
          ),
        ),
      );
    });
    transaction.addEventListener("abort", () => {
      resume(
        Effect.fail(
          catalogError(
            "compare and set",
            transaction.error ?? "Unknown IndexedDB transaction abort",
          ),
        ),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.succeed(matched));
    });

    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    request.addEventListener("success", () => {
      const current = typeof request.result === "string" ? request.result : null;
      if (current !== expected) return;
      matched = true;
      store.put(next, key);
    });
  }).pipe(Effect.withSpan("web.connectionStorage.compareAndSetDatabaseValue"));
}

function compareDatabaseValue(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  expected: string | null,
) {
  return Effect.callback<boolean, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    let matched = false;
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(
          catalogError("compare", transaction.error ?? "Unknown IndexedDB transaction error"),
        ),
      );
    });
    transaction.addEventListener("abort", () => {
      resume(
        Effect.fail(
          catalogError("compare", transaction.error ?? "Unknown IndexedDB transaction abort"),
        ),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.succeed(matched));
    });

    const request = transaction.objectStore(storeName).get(key);
    request.addEventListener("success", () => {
      const current = typeof request.result === "string" ? request.result : null;
      matched = current === expected;
    });
  }).pipe(Effect.withSpan("web.connectionStorage.compareDatabaseValue"));
}

function removeDatabaseValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", transaction.error ?? "Unknown IndexedDB remove error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).delete(key);
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValue"));
}

function removeDatabaseValuesInRange(database: IDBDatabase, storeName: string, range: IDBKeyRange) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", transaction.error ?? "Unknown IndexedDB cursor error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    const request = transaction.objectStore(storeName).openCursor(range);
    request.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", request.error ?? "Unknown IndexedDB cursor error")),
      );
    });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        return;
      }
      cursor.delete();
      cursor.continue();
    });
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValuesInRange"));
}

function readAllDatabaseValues(database: IDBDatabase, storeName: string) {
  return Effect.callback<ReadonlyArray<unknown>, ConnectionTransientError>((resume) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.addEventListener("error", () => {
      resume(Effect.fail(catalogError("read", request.error ?? "Unknown IndexedDB read error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  }).pipe(Effect.withSpan("web.connectionStorage.readAllDatabaseValues"));
}

function readAllDatabaseKeys(database: IDBDatabase, storeName: string) {
  return Effect.callback<ReadonlyArray<IDBValidKey>, ConnectionTransientError>((resume) => {
    const store = database.transaction(storeName, "readonly").objectStore(storeName);
    if (typeof store.getAllKeys !== "function") {
      resume(Effect.fail(catalogError("read cache keys", "Bulk key reads are unavailable.")));
      return;
    }
    const keys = store.getAllKeys();
    keys.addEventListener("error", () =>
      resume(
        Effect.fail(
          catalogError("read cache keys", keys.error ?? "Unknown IndexedDB key read error"),
        ),
      ),
    );
    keys.addEventListener("success", () => {
      resume(Effect.succeed(keys.result));
    });
  }).pipe(Effect.withSpan("web.connectionStorage.readAllDatabaseKeys"));
}

function readNormalizedEnvironmentRows(database: IDBDatabase) {
  return Effect.callback<
    {
      readonly environments: ReadonlyArray<unknown>;
      readonly routes: ReadonlyArray<unknown>;
      readonly bindings: ReadonlyArray<unknown>;
    },
    ConnectionTransientError
  >((resume) => {
    const transaction = database.transaction(
      [ENVIRONMENTS_STORE_NAME, ENVIRONMENT_ROUTES_STORE_NAME, ENVIRONMENT_BINDINGS_STORE_NAME],
      "readonly",
    );
    let settled = false;
    let environments: ReadonlyArray<unknown> = [];
    let routes: ReadonlyArray<unknown> = [];
    let bindings: ReadonlyArray<unknown> = [];
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("read normalized catalog", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown IndexedDB transaction error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Unknown IndexedDB transaction abort"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed({ environments, routes, bindings }));
    });

    const environmentRequest = transaction.objectStore(ENVIRONMENTS_STORE_NAME).getAll();
    const routeRequest = transaction.objectStore(ENVIRONMENT_ROUTES_STORE_NAME).getAll();
    const bindingRequest = transaction.objectStore(ENVIRONMENT_BINDINGS_STORE_NAME).getAll();
    environmentRequest.addEventListener("success", () => {
      environments = environmentRequest.result;
    });
    routeRequest.addEventListener("success", () => {
      routes = routeRequest.result;
    });
    bindingRequest.addEventListener("success", () => {
      bindings = bindingRequest.result;
    });
  }).pipe(Effect.withSpan("web.connectionStorage.readNormalizedEnvironmentRows"));
}

function environmentRecord(environment: KnownEnvironment) {
  const { bindings: _bindings, routes: _routes, ...record } = environment;
  return record;
}

export interface CatalogMigrationCommitOptions {
  readonly deleteLegacyDocument: boolean;
  /** Deterministic transaction-abort seam used by migration recovery tests. */
  readonly injectAbortBeforeReceipt?: boolean;
}

export function commitCatalogMigrationMetadata(
  database: IDBDatabase,
  metadata: CatalogMigrationMetadata,
  options: CatalogMigrationCommitOptions,
) {
  return Effect.callback<"applied" | "already-applied", ConnectionTransientError>((resume) => {
    const storeNames: string[] = [
      ENVIRONMENTS_STORE_NAME,
      ENVIRONMENT_ROUTES_STORE_NAME,
      ENVIRONMENT_BINDINGS_STORE_NAME,
      MIGRATION_STATE_STORE_NAME,
    ];
    if (options.deleteLegacyDocument) storeNames.push(CATALOG_STORE_NAME);
    const transaction = database.transaction(storeNames, "readwrite");
    let settled = false;
    let outcome: "applied" | "already-applied" = "applied";
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("commit catalog migration", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown IndexedDB migration error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "IndexedDB migration transaction aborted"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(outcome));
    });

    const migrationStore = transaction.objectStore(MIGRATION_STATE_STORE_NAME);
    const receiptRequest = migrationStore.get(metadata.receipt.id);
    receiptRequest.addEventListener("success", () => {
      if (receiptRequest.result !== undefined) {
        outcome = "already-applied";
        return;
      }
      try {
        const environmentStore = transaction.objectStore(ENVIRONMENTS_STORE_NAME);
        const routeStore = transaction.objectStore(ENVIRONMENT_ROUTES_STORE_NAME);
        const bindingStore = transaction.objectStore(ENVIRONMENT_BINDINGS_STORE_NAME);
        for (const environment of metadata.environments) {
          environmentStore.put(environmentRecord(environment));
          for (const route of environment.routes) routeStore.add(route);
          for (const binding of environment.bindings) bindingStore.add(binding);
        }
        if (options.deleteLegacyDocument) {
          transaction.objectStore(CATALOG_STORE_NAME).delete(CATALOG_KEY);
        }
        if (options.injectAbortBeforeReceipt === true) {
          transaction.abort();
          return;
        }
        migrationStore.add(metadata.receipt);
      } catch (cause) {
        if (typeof transaction.abort === "function") transaction.abort();
        fail(cause);
      }
    });
  }).pipe(Effect.withSpan("web.connectionStorage.commitCatalogMigrationMetadata"));
}

export interface CatalogMigrationActivationOptions {
  readonly completedAt?: string;
  readonly injectAbortBeforeReceipt?: boolean;
}

/** Imports legacy plaintext credentials before atomically publishing v3 metadata. */
export const activateCatalogV1ToV3Migration = Effect.fn(
  "web.connectionStorage.activateCatalogV1ToV3Migration",
)(function* (
  database: IDBDatabase,
  backend: CatalogBackend,
  secrets: EnvironmentSecretStore["Service"],
  options?: CatalogMigrationActivationOptions,
) {
  const existingReceipt = yield* readDatabaseValue(
    database,
    MIGRATION_STATE_STORE_NAME,
    CATALOG_V1_TO_V3_MIGRATION_ID,
  );
  if (existingReceipt !== undefined) {
    return "already-applied" as const;
  }

  const legacyRaw = yield* backend.read;

  const completedAt =
    options?.completedAt ?? (yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)));
  const plan = yield* Effect.tryPromise({
    try: () =>
      planCatalogV1ToV3Migration(
        legacyRaw === null || legacyRaw.trim() === ""
          ? EMPTY_CONNECTION_CATALOG_DOCUMENT
          : legacyRaw,
        { completedAt },
      ),
    catch: () => normalizedPersistenceError("save-migration-receipt", "Migration planning failed."),
  });
  const importedReferences: string[] = [];

  return yield* Effect.gen(function* () {
    const secretReferences = new Map<string, string>();
    for (const pending of plan.sessionSecretImports) {
      const secretRef = yield* secrets.put(pending.environmentId, pending.purpose, pending.value);
      importedReferences.push(secretRef);
      secretReferences.set(`${pending.environmentId}:${pending.routeId}`, secretRef);
    }

    let attachedSecretCount = 0;
    const environments = plan.metadata.environments.map((environment) => ({
      ...environment,
      routes: environment.routes.map((route) => {
        const secretRef = secretReferences.get(`${environment.environmentId}:${route.routeId}`);
        if (secretRef === undefined) return route;
        attachedSecretCount += 1;
        return { ...route, secretRef };
      }),
    }));
    if (attachedSecretCount !== plan.sessionSecretImports.length) {
      return yield* normalizedPersistenceError(
        "save-migration-receipt",
        "A staged secret did not match a normalized route.",
      );
    }

    const metadata: CatalogMigrationMetadata = {
      ...plan.metadata,
      environments,
    };
    const outcome = yield* commitCatalogMigrationMetadata(database, metadata, {
      deleteLegacyDocument: legacyRaw !== null,
      ...(options?.injectAbortBeforeReceipt === undefined
        ? {}
        : { injectAbortBeforeReceipt: options.injectAbortBeforeReceipt }),
    });
    if (outcome === "already-applied") {
      yield* Effect.forEach(importedReferences, (secretRef) => secrets.delete(secretRef), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.ignore);
    }
    return outcome;
  }).pipe(
    Effect.onError(() =>
      Effect.forEach(importedReferences, (secretRef) => secrets.delete(secretRef), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.ignore),
    ),
  );
});

function replaceEnvironmentRows(database: IDBDatabase, environment: KnownEnvironment) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(
      [ENVIRONMENTS_STORE_NAME, ENVIRONMENT_ROUTES_STORE_NAME, ENVIRONMENT_BINDINGS_STORE_NAME],
      "readwrite",
    );
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("replace normalized environment", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown IndexedDB transaction error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Unknown IndexedDB transaction abort"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    });

    const routeStore = transaction.objectStore(ENVIRONMENT_ROUTES_STORE_NAME);
    const bindingStore = transaction.objectStore(ENVIRONMENT_BINDINGS_STORE_NAME);
    const routeKeysRequest = routeStore
      .index("environmentId")
      .getAllKeys(IDBKeyRange.only(environment.environmentId));
    const bindingKeysRequest = bindingStore
      .index("environmentId")
      .getAllKeys(IDBKeyRange.only(environment.environmentId));
    let routeKeys: ReadonlyArray<IDBValidKey> | null = null;
    let bindingKeys: ReadonlyArray<IDBValidKey> | null = null;
    const publish = () => {
      if (routeKeys === null || bindingKeys === null) return;
      transaction.objectStore(ENVIRONMENTS_STORE_NAME).put(environmentRecord(environment));
      for (const key of routeKeys) routeStore.delete(key);
      for (const key of bindingKeys) bindingStore.delete(key);
      for (const route of environment.routes) routeStore.add(route);
      for (const binding of environment.bindings) bindingStore.add(binding);
    };
    routeKeysRequest.addEventListener("success", () => {
      routeKeys = routeKeysRequest.result;
      publish();
    });
    bindingKeysRequest.addEventListener("success", () => {
      bindingKeys = bindingKeysRequest.result;
      publish();
    });
  }).pipe(Effect.withSpan("web.connectionStorage.replaceEnvironmentRows"));
}

function replaceEnvironmentRouteRows(
  database: IDBDatabase,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<EnvironmentRoute>,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(
      [ENVIRONMENTS_STORE_NAME, ENVIRONMENT_ROUTES_STORE_NAME],
      "readwrite",
    );
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("replace normalized routes", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown IndexedDB transaction error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Unknown IndexedDB transaction abort"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    });
    const environmentRequest = transaction.objectStore(ENVIRONMENTS_STORE_NAME).get(environmentId);
    environmentRequest.addEventListener("success", () => {
      if (environmentRequest.result === undefined) {
        fail("Routes must reference a stored environment.");
        transaction.abort();
        return;
      }
      const store = transaction.objectStore(ENVIRONMENT_ROUTES_STORE_NAME);
      const keysRequest = store.index("environmentId").getAllKeys(IDBKeyRange.only(environmentId));
      keysRequest.addEventListener("success", () => {
        for (const key of keysRequest.result) store.delete(key);
        for (const route of routes) store.add(route);
      });
    });
  }).pipe(Effect.withSpan("web.connectionStorage.replaceEnvironmentRouteRows"));
}

function removeNormalizedEnvironment(database: IDBDatabase, environmentId: EnvironmentId) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(
      [ENVIRONMENTS_STORE_NAME, ENVIRONMENT_ROUTES_STORE_NAME, ENVIRONMENT_BINDINGS_STORE_NAME],
      "readwrite",
    );
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("remove normalized environment", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown IndexedDB transaction error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Unknown IndexedDB transaction abort"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    });
    transaction.objectStore(ENVIRONMENTS_STORE_NAME).delete(environmentId);
    const deleteDependentKeys = (storeName: string) => {
      const store = transaction.objectStore(storeName);
      const request = store.index("environmentId").getAllKeys(IDBKeyRange.only(environmentId));
      request.addEventListener("success", () => {
        for (const key of request.result) store.delete(key);
      });
    };
    deleteDependentKeys(ENVIRONMENT_ROUTES_STORE_NAME);
    deleteDependentKeys(ENVIRONMENT_BINDINGS_STORE_NAME);
  }).pipe(Effect.withSpan("web.connectionStorage.removeNormalizedEnvironment"));
}

function threadCacheKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

type StoredCacheManifest = EnvironmentCacheManifest & { readonly browserKey?: CryptoKey };

function cacheRecordKey(
  entityKind: CacheEntityKind,
  environmentId: EnvironmentId,
  entityId: string,
): IDBValidKey {
  return entityKind === "shell" ? environmentId : [environmentId, entityId];
}

function cacheStoreName(entityKind: CacheEntityKind): string {
  return entityKind === "shell"
    ? ENCRYPTED_SHELL_CACHE_STORE_NAME
    : ENCRYPTED_THREAD_CACHE_STORE_NAME;
}

function sessionCacheRecordKey(
  environmentId: EnvironmentId,
  entityKind: CacheEntityKind,
  entityId: string,
): string {
  return JSON.stringify([environmentId, entityKind, entityId]);
}

function encryptedCacheRecord(envelope: EncryptedCacheEnvelopeType): unknown {
  return envelope.entityKind === "thread" ? { ...envelope, threadId: envelope.entityId } : envelope;
}

function commitEncryptedCacheWrite(input: {
  readonly database: IDBDatabase;
  readonly baseManifest: EnvironmentCacheManifest;
  readonly browserKey?: CryptoKey;
  readonly envelope: EncryptedCacheEnvelopeType;
  readonly protectedEntity: {
    readonly entityKind: CacheEntityKind;
    readonly entityId: string;
  } | null;
  readonly accessedAt: string;
}) {
  return Effect.callback<
    { readonly applied: boolean; readonly manifest: EnvironmentCacheManifest },
    ConnectionTransientError
  >((resume) => {
    const transaction = input.database.transaction(
      [
        ENVIRONMENT_CACHE_MANIFEST_STORE_NAME,
        ENCRYPTED_SHELL_CACHE_STORE_NAME,
        ENCRYPTED_THREAD_CACHE_STORE_NAME,
      ],
      "readwrite",
    );
    let settled = false;
    let result: { readonly applied: boolean; readonly manifest: EnvironmentCacheManifest } = {
      applied: false,
      manifest: input.baseManifest,
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("write encrypted cache", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown encrypted-cache transaction error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Encrypted-cache transaction aborted"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(result));
    });

    const manifestStore = transaction.objectStore(ENVIRONMENT_CACHE_MANIFEST_STORE_NAME);
    const request = manifestStore.get(input.envelope.environmentId);
    request.addEventListener("success", () => {
      try {
        const raw = request.result as StoredCacheManifest | undefined;
        const current =
          raw === undefined ? input.baseManifest : decodeEnvironmentCacheManifestSync(raw);
        if (current.storageInstanceId !== input.envelope.storageInstanceId) {
          throw new Error("Cache manifest storage identity mismatch.");
        }
        const existing = current.entries.find(
          (entry) =>
            entry.entityKind === input.envelope.entityKind &&
            entry.entityId === input.envelope.entityId,
        );
        if (!shouldReplaceCacheEntry(existing, input.envelope)) {
          result = { applied: false, manifest: current };
          return;
        }

        const nextEntry: CacheManifestEntry = {
          entityKind: input.envelope.entityKind,
          entityId: input.envelope.entityId,
          byteLength: cacheEnvelopeByteLength(input.envelope),
          serverRevision: input.envelope.serverRevision,
          synchronizedAt: input.envelope.synchronizedAt,
          lastAccessedAt: input.accessedAt,
        };
        const candidateEntries = [
          ...current.entries.filter(
            (entry) =>
              entry.entityKind !== nextEntry.entityKind || entry.entityId !== nextEntry.entityId,
          ),
          nextEntry,
        ];
        const evictions = selectCacheEvictions(candidateEntries, {
          maxBytes: current.maxBytes,
          maxAgeMs: current.maxAgeMs,
          nowEpochMs: Date.parse(input.accessedAt),
          protectedEntity: input.protectedEntity,
        });
        const evictionKeys = new Set(
          evictions.map((entry) => `${entry.entityKind}\u0000${entry.entityId}`),
        );
        const retainedEntries = candidateEntries.filter(
          (entry) => !evictionKeys.has(`${entry.entityKind}\u0000${entry.entityId}`),
        );
        const nextManifest: EnvironmentCacheManifest = {
          ...current,
          keyRef: input.baseManifest.keyRef,
          persistence: input.baseManifest.persistence,
          lastSynchronizedAt: input.envelope.synchronizedAt,
          totalBytes: retainedEntries.reduce((total, entry) => total + entry.byteLength, 0),
          entries: retainedEntries,
        };
        transaction
          .objectStore(cacheStoreName(input.envelope.entityKind))
          .put(encryptedCacheRecord(input.envelope));
        for (const eviction of evictions) {
          transaction
            .objectStore(cacheStoreName(eviction.entityKind))
            .delete(
              cacheRecordKey(eviction.entityKind, input.envelope.environmentId, eviction.entityId),
            );
        }
        const browserKey = raw?.browserKey ?? input.browserKey;
        manifestStore.put({
          ...nextManifest,
          ...(browserKey === undefined ? {} : { browserKey }),
        });
        result = { applied: true, manifest: nextManifest };
      } catch (cause) {
        fail(cause);
        transaction.abort();
      }
    });
  }).pipe(Effect.withSpan("web.connectionStorage.commitEncryptedCacheWrite"));
}

function removeEncryptedCacheRecord(input: {
  readonly database: IDBDatabase;
  readonly environmentId: EnvironmentId;
  readonly entityKind: CacheEntityKind;
  readonly entityId: string;
  readonly reason: CacheQuarantineReason | null;
  readonly quarantinedAt: string;
}) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const storeName = cacheStoreName(input.entityKind);
    const transaction = input.database.transaction(
      [ENVIRONMENT_CACHE_MANIFEST_STORE_NAME, storeName],
      "readwrite",
    );
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("quarantine encrypted cache", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown cache-quarantine transaction error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Cache-quarantine transaction aborted"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    });

    transaction
      .objectStore(storeName)
      .delete(cacheRecordKey(input.entityKind, input.environmentId, input.entityId));
    const manifestStore = transaction.objectStore(ENVIRONMENT_CACHE_MANIFEST_STORE_NAME);
    const request = manifestStore.get(input.environmentId);
    request.addEventListener("success", () => {
      try {
        const raw = request.result as StoredCacheManifest | undefined;
        if (raw === undefined) return;
        const current = decodeEnvironmentCacheManifestSync(raw);
        const entries = current.entries.filter(
          (entry) => entry.entityKind !== input.entityKind || entry.entityId !== input.entityId,
        );
        const next: EnvironmentCacheManifest = {
          ...current,
          entries,
          totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
          quarantine:
            input.reason === null
              ? current.quarantine
              : [
                  ...current.quarantine,
                  {
                    entityKind: input.entityKind,
                    entityId: input.entityId,
                    reason: input.reason,
                    quarantinedAt: input.quarantinedAt,
                  },
                ].slice(-64),
        };
        manifestStore.put({
          ...next,
          ...(raw.browserKey === undefined ? {} : { browserKey: raw.browserKey }),
        });
      } catch (cause) {
        fail(cause);
        transaction.abort();
      }
    });
  }).pipe(Effect.withSpan("web.connectionStorage.quarantineEncryptedCacheRecord"));
}

function touchEncryptedCacheEntry(input: {
  readonly database: IDBDatabase;
  readonly environmentId: EnvironmentId;
  readonly entityKind: CacheEntityKind;
  readonly entityId: string;
  readonly accessedAt: string;
}) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = input.database.transaction(
      ENVIRONMENT_CACHE_MANIFEST_STORE_NAME,
      "readwrite",
    );
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("touch encrypted cache", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown cache-touch transaction error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Cache-touch transaction aborted"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    });
    const store = transaction.objectStore(ENVIRONMENT_CACHE_MANIFEST_STORE_NAME);
    const request = store.get(input.environmentId);
    request.addEventListener("success", () => {
      try {
        const raw = request.result as StoredCacheManifest | undefined;
        if (raw === undefined) return;
        const current = decodeEnvironmentCacheManifestSync(raw);
        store.put({
          ...current,
          entries: current.entries.map((entry) =>
            entry.entityKind === input.entityKind && entry.entityId === input.entityId
              ? { ...entry, lastAccessedAt: input.accessedAt }
              : entry,
          ),
          ...(raw.browserKey === undefined ? {} : { browserKey: raw.browserKey }),
        });
      } catch (cause) {
        fail(cause);
        transaction.abort();
      }
    });
  }).pipe(Effect.withSpan("web.connectionStorage.touchEncryptedCacheEntry"));
}

function replaceCacheManifest(
  database: IDBDatabase,
  manifest: EnvironmentCacheManifest,
  browserKey?: CryptoKey,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(ENVIRONMENT_CACHE_MANIFEST_STORE_NAME, "readwrite");
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("replace cache manifest", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown cache-manifest transaction error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Cache-manifest transaction aborted"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    });
    const store = transaction.objectStore(ENVIRONMENT_CACHE_MANIFEST_STORE_NAME);
    const request = store.get(manifest.environmentId);
    request.addEventListener("success", () => {
      try {
        const current = request.result as StoredCacheManifest | undefined;
        const retainedBrowserKey = current?.browserKey ?? browserKey;
        store.put({
          ...manifest,
          ...(retainedBrowserKey === undefined ? {} : { browserKey: retainedBrowserKey }),
        });
      } catch (cause) {
        fail(cause);
        transaction.abort();
      }
    });
  }).pipe(Effect.withSpan("web.connectionStorage.replaceCacheManifest"));
}

function clearEncryptedCacheDatabase(database: IDBDatabase, environmentId: EnvironmentId) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(
      [
        ENVIRONMENT_CACHE_MANIFEST_STORE_NAME,
        ENCRYPTED_SHELL_CACHE_STORE_NAME,
        ENCRYPTED_THREAD_CACHE_STORE_NAME,
      ],
      "readwrite",
    );
    let settled = false;
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      resume(Effect.fail(catalogError("clear encrypted cache", cause)));
    };
    transaction.addEventListener("error", () =>
      fail(transaction.error ?? "Unknown encrypted-cache clear error"),
    );
    transaction.addEventListener("abort", () =>
      fail(transaction.error ?? "Encrypted-cache clear transaction aborted"),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      resume(Effect.void);
    });
    transaction.objectStore(ENVIRONMENT_CACHE_MANIFEST_STORE_NAME).delete(environmentId);
    transaction.objectStore(ENCRYPTED_SHELL_CACHE_STORE_NAME).delete(environmentId);
    const threadStore = transaction.objectStore(ENCRYPTED_THREAD_CACHE_STORE_NAME);
    const keys = threadStore.index("environmentId").getAllKeys(IDBKeyRange.only(environmentId));
    keys.addEventListener("error", () =>
      fail(keys.error ?? "Unknown encrypted thread-cache cursor error"),
    );
    keys.addEventListener("success", () => {
      for (const key of keys.result) threadStore.delete(key);
    });
  }).pipe(Effect.withSpan("web.connectionStorage.clearEncryptedCacheDatabase"));
}

const decodeCatalog = Effect.fn("web.connectionStorage.decodeCatalog")(function* (raw: string) {
  return yield* decodeConnectionCatalogDocument(raw).pipe(
    Effect.mapError((cause) => catalogError("decode", cause)),
  );
});

const encodeCatalog = Effect.fn("web.connectionStorage.encodeCatalog")(function* (
  catalog: ConnectionCatalogDocumentType,
) {
  return yield* encodeConnectionCatalogDocument(catalog).pipe(
    Effect.mapError((cause) => catalogError("encode", cause)),
  );
});

export interface CatalogBackend {
  readonly read: Effect.Effect<string | null, ConnectionTransientError>;
  readonly compare: (expected: string | null) => Effect.Effect<boolean, ConnectionTransientError>;
  readonly compareAndSet: (
    expected: string | null,
    next: string,
  ) => Effect.Effect<boolean, ConnectionTransientError>;
  readonly quarantine?: (raw: string) => Effect.Effect<void, ConnectionTransientError>;
}

export function makeCatalogBackend(database: IDBDatabase): CatalogBackend {
  const bridge = window.desktopBridge;
  if (
    bridge?.getConnectionCatalog !== undefined &&
    bridge.compareAndSetConnectionCatalog !== undefined
  ) {
    return {
      read: Effect.tryPromise({
        try: () => bridge.getConnectionCatalog!(),
        catch: (cause) => catalogError("load", cause),
      }),
      compare: (expected) => {
        if (bridge.compareConnectionCatalog === undefined) {
          return Effect.fail(
            catalogError("compare", "Desktop connection catalog comparison is unavailable."),
          );
        }
        return Effect.tryPromise({
          try: () => bridge.compareConnectionCatalog!(expected),
          catch: (cause) => catalogError("compare", cause),
        });
      },
      compareAndSet: (expected, next) => {
        if (bridge.compareAndSetConnectionCatalog === undefined) {
          return Effect.fail(
            catalogError(
              "compare and set",
              "Desktop connection catalog compare-and-set is unavailable.",
            ),
          );
        }
        return Effect.tryPromise({
          try: () => bridge.compareAndSetConnectionCatalog!(expected, next),
          catch: (cause) => catalogError("compare and set", cause),
        });
      },
    };
  }

  return {
    read: readDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY).pipe(
      Effect.map((value) => (typeof value === "string" ? value : null)),
    ),
    compare: (expected) =>
      compareDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY, expected),
    compareAndSet: (expected, next) =>
      compareAndSetDatabaseValue(database, CATALOG_STORE_NAME, CATALOG_KEY, expected, next),
    quarantine: (raw) =>
      writeDatabaseValue(database, CATALOG_STORE_NAME, `${CATALOG_KEY}:corrupt:${Date.now()}`, raw),
  };
}

const migrateLegacyRendererCatalog = Effect.fn(
  "web.connectionStorage.migrateLegacyRendererCatalog",
)(function* (backend: CatalogBackend) {
  const bridge = window.desktopBridge;
  if (
    bridge?.getConnectionCatalog === undefined ||
    bridge.compareAndSetConnectionCatalog !== undefined
  ) {
    return;
  }

  const raw = yield* Effect.tryPromise({
    try: () => bridge.getConnectionCatalog!(),
    catch: () => catalogError("migrate", "Could not read the legacy desktop catalog."),
  });
  if (raw === null) return;
  if (bridge.clearConnectionCatalog === undefined) {
    return yield* catalogError(
      "migrate",
      "Could not clear the legacy desktop catalog after migration.",
    );
  }

  const legacyDocument =
    raw.trim() === ""
      ? Option.none<ConnectionCatalogDocumentType>()
      : yield* decodeCatalog(raw).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<ConnectionCatalogDocumentType>()),
        );
  const clearLegacyCatalog = Effect.tryPromise({
    try: () => bridge.clearConnectionCatalog!(),
    catch: () => catalogError("migrate", "Could not clear the legacy desktop catalog."),
  });

  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < MAX_CATALOG_COMPARE_AND_SET_ATTEMPTS; attempt += 1) {
        const current = yield* backend.read;
        if (current !== null && current.trim() !== "") {
          const currentDocument = yield* decodeCatalog(current).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none<ConnectionCatalogDocumentType>()),
          );
          if (Option.isSome(currentDocument) || Option.isNone(legacyDocument)) {
            return yield* clearLegacyCatalog;
          }
        } else if (Option.isNone(legacyDocument)) {
          return yield* clearLegacyCatalog;
        }

        const migrated = yield* backend.compareAndSet(current, raw);
        if (migrated) {
          if (current !== null && current.trim() !== "" && backend.quarantine !== undefined) {
            yield* backend.quarantine(current).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not quarantine the replaced web connection catalog.", {
                  error: cause.message,
                }),
              ),
            );
          }
          return yield* clearLegacyCatalog;
        }
        yield* Effect.yieldNow;
      }

      return yield* catalogError(
        "migrate",
        "The browser catalog changed too many times during legacy desktop migration.",
      );
    }),
  );
});

interface CatalogStore {
  readonly health: SubscriptionRef.SubscriptionRef<ConnectionCatalogHealth>;
  readonly read: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly reset: Effect.Effect<void, ConnectionTransientError>;
  readonly update: (
    transform: (catalog: ConnectionCatalogDocumentType) => ConnectionCatalogDocumentType,
  ) => Effect.Effect<void, ConnectionTransientError>;
  readonly modify: <A>(
    transform: (catalog: ConnectionCatalogDocumentType) => {
      readonly mutation:
        | { readonly _tag: "Keep" }
        | { readonly _tag: "Set"; readonly document: ConnectionCatalogDocumentType };
      readonly result: A;
    },
  ) => Effect.Effect<A, ConnectionTransientError>;
}

export const makeCatalogStore = Effect.fn("web.connectionStorage.makeCatalogStore")(function* (
  backend: CatalogBackend,
) {
  const health = yield* SubscriptionRef.make<ConnectionCatalogHealth>({ status: "ready" });
  const quarantinedRevision = yield* Ref.make<string | null>(null);

  const enterRecovery = Effect.fn("web.connectionStorage.enterCatalogRecovery")(function* (
    raw: string,
  ) {
    const priorRevision = yield* Ref.get(quarantinedRevision);
    if (priorRevision !== raw && backend.quarantine !== undefined) {
      yield* backend
        .quarantine(raw)
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not quarantine the corrupt web connection catalog."),
          ),
        );
    }
    yield* Ref.set(quarantinedRevision, raw);
    yield* SubscriptionRef.set(health, {
      status: "recovery-required",
      message: CORRUPT_CATALOG_MESSAGE,
    });
  });

  const leaveRecovery = Effect.gen(function* () {
    yield* Ref.set(quarantinedRevision, null);
    yield* SubscriptionRef.set(health, { status: "ready" });
  });

  const loadVersion = Effect.fn("web.connectionStorage.loadCatalog")(function* () {
    const raw = yield* backend.read;
    const currentHealth = yield* SubscriptionRef.get(health);
    if (raw === null || raw.trim() === "") {
      return {
        raw,
        document: EMPTY_CONNECTION_CATALOG_DOCUMENT,
        recoveryRequired: currentHealth.status === "recovery-required",
      } as const;
    }

    const decoded = yield* decodeCatalog(raw).pipe(
      Effect.map(Option.some),
      Effect.catch(() =>
        Effect.logWarning("The web connection catalog requires recovery.").pipe(
          Effect.as(Option.none<ConnectionCatalogDocumentType>()),
        ),
      ),
    );
    if (Option.isSome(decoded)) {
      if (currentHealth.status === "recovery-required") {
        yield* leaveRecovery;
      }
      return { raw, document: decoded.value, recoveryRequired: false } as const;
    }

    yield* enterRecovery(raw);
    return {
      raw,
      document: EMPTY_CONNECTION_CATALOG_DOCUMENT,
      recoveryRequired: true,
    } as const;
  });

  const read = loadVersion().pipe(Effect.map(({ document }) => document));
  const modify: CatalogStore["modify"] = Effect.fn("web.connectionStorage.modifyCatalog")(
    function* (transform) {
      for (let attempt = 0; attempt < MAX_CATALOG_COMPARE_AND_SET_ATTEMPTS; attempt += 1) {
        const { raw, document, recoveryRequired } = yield* loadVersion();
        if (recoveryRequired) {
          return yield* catalogError("update", CORRUPT_CATALOG_MESSAGE);
        }
        const transition = transform(document);
        const updated =
          transition.mutation._tag === "Keep"
            ? yield* Effect.uninterruptible(backend.compare(raw))
            : yield* Effect.uninterruptible(
                encodeCatalog(transition.mutation.document).pipe(
                  Effect.flatMap((next) => backend.compareAndSet(raw, next)),
                ),
              );
        if (updated) return transition.result;
        yield* Effect.yieldNow;
      }
      return yield* catalogError("update", "The connection catalog changed too many times.");
    },
  );
  const update: CatalogStore["update"] = (transform) =>
    modify((document) => ({
      mutation: { _tag: "Set", document: transform(document) },
      result: undefined,
    }));

  const reset = Effect.uninterruptible(
    Effect.gen(function* () {
      const emptyRaw = yield* encodeCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT);
      for (let attempt = 0; attempt < MAX_CATALOG_COMPARE_AND_SET_ATTEMPTS; attempt += 1) {
        const raw = yield* backend.read;
        if (raw !== null && raw.trim() !== "") {
          const decoded = yield* decodeCatalog(raw).pipe(Effect.option);
          if (Option.isSome(decoded)) {
            yield* leaveRecovery;
            return;
          }
          yield* enterRecovery(raw);
        }

        if (yield* backend.compareAndSet(raw, emptyRaw)) {
          yield* leaveRecovery;
          return;
        }
        yield* Effect.yieldNow;
      }
      return yield* catalogError("reset", "The connection catalog changed too many times.");
    }),
  ).pipe(Effect.withSpan("web.connectionStorage.resetCatalog"));

  return { health, modify, read, reset, update } satisfies CatalogStore;
});

export const connectionStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(openConnectionDatabase(), (database) =>
      Effect.sync(() => database.close()),
    );
    const backend = makeCatalogBackend(database);
    yield* migrateLegacyRendererCatalog(backend);
    const desktopBridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    const environmentSecretStore = makeEnvironmentSecretStore(desktopBridge);
    yield* activateCatalogV1ToV3Migration(database, backend, environmentSecretStore).pipe(
      Effect.catch(() =>
        Effect.logWarning(
          "Normalized environment catalog migration was deferred without exposing its cause.",
        ),
      ),
    );
    const catalog = yield* makeCatalogStore(backend);

    const readNormalizedCatalog = readNormalizedEnvironmentRows(database).pipe(
      Effect.flatMap(decodeNormalizedEnvironmentCatalogRows),
      Effect.mapError((cause) => normalizedPersistenceError("list-environments", cause)),
    );
    const environmentCatalogStore = EnvironmentCatalogStore.of({
      list: readNormalizedCatalog.pipe(Effect.map(assembleKnownEnvironments)),
      load: (environmentId) =>
        readNormalizedCatalog.pipe(
          Effect.map(assembleKnownEnvironments),
          Effect.map((environments) =>
            Option.fromUndefinedOr(
              environments.find((environment) => environment.environmentId === environmentId),
            ),
          ),
          Effect.mapError((cause) => normalizedPersistenceError("load-environment", cause)),
        ),
      put: (environment) =>
        decodeKnownEnvironment(environment).pipe(
          Effect.flatMap((decoded) => replaceEnvironmentRows(database, decoded)),
          Effect.mapError((cause) => normalizedPersistenceError("put-environment", cause)),
        ),
      updateRoutes: (environmentId, routes) =>
        Effect.gen(function* () {
          const decoded = yield* decodeEnvironmentRoutes(routes).pipe(
            Effect.mapError((cause) =>
              normalizedPersistenceError("update-environment-routes", cause),
            ),
          );
          if (
            decoded.some((route) => route.environmentId !== environmentId) ||
            decoded.filter((route) => route.pinned).length > 1
          ) {
            return yield* normalizedPersistenceError(
              "update-environment-routes",
              "Routes must share one environment and at most one may be pinned.",
            );
          }
          yield* replaceEnvironmentRouteRows(database, environmentId, decoded).pipe(
            Effect.mapError((cause) =>
              normalizedPersistenceError("update-environment-routes", cause),
            ),
          );
        }),
      listBindings: readAllDatabaseValues(database, ENVIRONMENT_BINDINGS_STORE_NAME).pipe(
        Effect.flatMap(decodeEnvironmentBindings),
        Effect.mapError((cause) => normalizedPersistenceError("list-environment-bindings", cause)),
      ),
      putBinding: (binding) =>
        decodeEnvironmentBinding(binding).pipe(
          Effect.flatMap((decoded) => upsertEnvironmentBinding(database, decoded)),
          Effect.mapError((cause) => normalizedPersistenceError("put-environment-binding", cause)),
        ),
      forget: (environmentId) =>
        removeNormalizedEnvironment(database, environmentId).pipe(
          Effect.mapError((cause) => normalizedPersistenceError("forget-environment", cause)),
        ),
    });

    const loadEnvironmentUiState = readDatabaseValue(
      database,
      ENVIRONMENT_UI_STATE_STORE_NAME,
      ENVIRONMENT_UI_STATE_KEY,
    ).pipe(
      Effect.flatMap((raw) =>
        raw === undefined
          ? Effect.succeed(Option.none())
          : decodeEnvironmentUiStateDocument(raw).pipe(Effect.map(Option.some)),
      ),
      Effect.mapError((cause) => normalizedPersistenceError("load-environment-ui-state", cause)),
    );
    const saveEnvironmentUiState = (state: EnvironmentUiStateDocument) =>
      decodeEnvironmentUiStateDocument(state).pipe(
        Effect.flatMap((decoded) =>
          writeDatabaseValue(
            database,
            ENVIRONMENT_UI_STATE_STORE_NAME,
            ENVIRONMENT_UI_STATE_KEY,
            decoded,
          ),
        ),
        Effect.mapError((cause) => normalizedPersistenceError("save-environment-ui-state", cause)),
      );
    const environmentUiStateStore = EnvironmentUiStateStore.of({
      load: loadEnvironmentUiState,
      save: saveEnvironmentUiState,
      clearEnvironment: (environmentId) =>
        loadEnvironmentUiState.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (state) => {
                const projectOrderByEnvironment = Object.fromEntries(
                  Object.entries(state.projectOrderByEnvironment).filter(
                    ([key]) => key !== environmentId,
                  ),
                );
                return saveEnvironmentUiState({
                  ...state,
                  selected: state.selected?.environmentId === environmentId ? null : state.selected,
                  expandedEnvironmentIds: state.expandedEnvironmentIds.filter(
                    (candidate) => candidate !== environmentId,
                  ),
                  environmentOrder: state.environmentOrder.filter(
                    (candidate) => candidate !== environmentId,
                  ),
                  pinnedEnvironmentIds: state.pinnedEnvironmentIds.filter(
                    (candidate) => candidate !== environmentId,
                  ),
                  projectOrderByEnvironment,
                });
              },
            }),
          ),
          Effect.mapError((cause) =>
            normalizedPersistenceError("clear-environment-ui-state", cause),
          ),
        ),
    });

    const sessionCacheManifests = new Map<EnvironmentId, EnvironmentCacheManifest>();
    const sessionCacheKeys = new Map<EnvironmentId, CryptoKey>();
    const sessionCacheEnvelopes = new Map<string, EncryptedCacheEnvelopeType>();
    const resolvedCacheKeys = new Map<
      EnvironmentId,
      {
        readonly key: CryptoKey;
        readonly manifest: EnvironmentCacheManifest;
        readonly browserKey: CryptoKey | undefined;
      }
    >();
    const cacheMutationSemaphore = yield* Semaphore.make(1);

    const environmentCacheManifestStore = EnvironmentCacheManifestStore.of({
      load: (environmentId) =>
        Effect.suspend(() => {
          const sessionManifest = sessionCacheManifests.get(environmentId);
          if (sessionManifest !== undefined) return Effect.succeed(Option.some(sessionManifest));
          return readDatabaseValue(
            database,
            ENVIRONMENT_CACHE_MANIFEST_STORE_NAME,
            environmentId,
          ).pipe(
            Effect.flatMap((raw) =>
              raw === undefined
                ? Effect.succeed(Option.none())
                : decodeEnvironmentCacheManifest(raw).pipe(Effect.map(Option.some)),
            ),
            Effect.mapError((cause) => normalizedPersistenceError("load-cache-manifest", cause)),
          );
        }),
      save: (manifest) =>
        decodeEnvironmentCacheManifest(manifest).pipe(
          Effect.flatMap((decoded) => {
            if (decoded.persistence === "session-only") {
              return Effect.sync(() => {
                sessionCacheManifests.set(decoded.environmentId, decoded);
              });
            }
            return replaceCacheManifest(database, decoded);
          }),
          Effect.mapError((cause) => normalizedPersistenceError("save-cache-manifest", cause)),
        ),
      remove: (environmentId) =>
        Effect.sync(() => {
          sessionCacheManifests.delete(environmentId);
          sessionCacheKeys.delete(environmentId);
          resolvedCacheKeys.delete(environmentId);
        }).pipe(
          Effect.andThen(
            removeDatabaseValue(database, ENVIRONMENT_CACHE_MANIFEST_STORE_NAME, environmentId),
          ),
          Effect.mapError((cause) => normalizedPersistenceError("delete-cache-manifest", cause)),
        ),
    });

    const loadDurableCacheManifest = (environmentId: EnvironmentId) =>
      readDatabaseValue(database, ENVIRONMENT_CACHE_MANIFEST_STORE_NAME, environmentId).pipe(
        Effect.flatMap((raw) =>
          raw === undefined
            ? Effect.succeed(Option.none<EnvironmentCacheManifest>())
            : decodeEnvironmentCacheManifest(raw).pipe(Effect.map(Option.some)),
        ),
      );

    const cacheEnvironmentStorageId = Effect.fn("web.connectionStorage.cacheEnvironmentStorageId")(
      function* (environmentId: EnvironmentId) {
        const raw = yield* readDatabaseValue(database, ENVIRONMENTS_STORE_NAME, environmentId);
        if (
          typeof raw !== "object" ||
          raw === null ||
          !("acceptedStorageInstanceId" in raw) ||
          typeof raw.acceptedStorageInstanceId !== "string"
        ) {
          return yield* catalogError(
            "resolve cache identity",
            "The environment is not in the normalized catalog.",
          );
        }
        return raw.acceptedStorageInstanceId;
      },
    );

    const defaultCacheManifest = (
      environmentId: EnvironmentId,
      storageInstanceId: string,
    ): EnvironmentCacheManifest => ({
      schemaVersion: 1,
      environmentId,
      storageInstanceId,
      keyRef: null,
      persistence: "session-only",
      lastSynchronizedAt: null,
      maxBytes: DEFAULT_CACHE_MAX_BYTES,
      maxAgeMs: DEFAULT_CACHE_MAX_AGE_MS,
      totalBytes: 0,
      entries: [],
      quarantine: [],
    });

    const cryptoKeyFromUnknown = (value: unknown): CryptoKey | null => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("type" in value) ||
        value.type !== "secret" ||
        !("algorithm" in value) ||
        typeof value.algorithm !== "object" ||
        value.algorithm === null ||
        !("name" in value.algorithm) ||
        value.algorithm.name !== "AES-GCM"
      ) {
        return null;
      }
      return value as CryptoKey;
    };

    const makeSessionCacheKey = Effect.fn("web.connectionStorage.makeSessionCacheKey")(function* (
      manifest: EnvironmentCacheManifest,
    ) {
      const key = yield* Effect.tryPromise({
        try: generateCacheKey,
        catch: (cause) => catalogError("generate session cache key", cause),
      });
      const sessionManifest: EnvironmentCacheManifest = {
        ...manifest,
        keyRef: null,
        persistence: "session-only",
        totalBytes: 0,
        entries: [],
      };
      sessionCacheKeys.set(manifest.environmentId, key);
      sessionCacheManifests.set(manifest.environmentId, sessionManifest);
      const resolved = { key, manifest: sessionManifest, browserKey: undefined } as const;
      resolvedCacheKeys.set(manifest.environmentId, resolved);
      return resolved;
    });

    const resetUnreadableDurableCache = Effect.fn(
      "web.connectionStorage.resetUnreadableDurableCache",
    )(function* (manifest: EnvironmentCacheManifest) {
      if (manifest.keyRef !== null) {
        yield* environmentSecretStore.delete(manifest.keyRef).pipe(Effect.ignore);
      }
      yield* clearEncryptedCacheDatabase(database, manifest.environmentId);
      return {
        ...manifest,
        keyRef: null,
        persistence: "session-only" as const,
        lastSynchronizedAt: null,
        totalBytes: 0,
        entries: [],
      } satisfies EnvironmentCacheManifest;
    });

    const resolveCacheKeyUnlocked = Effect.fn("web.connectionStorage.resolveCacheKey")(function* (
      environmentId: EnvironmentId,
    ) {
      const alreadyResolved = resolvedCacheKeys.get(environmentId);
      if (alreadyResolved !== undefined) return alreadyResolved;

      const storageInstanceId = yield* cacheEnvironmentStorageId(environmentId);
      const raw = yield* readDatabaseValue(
        database,
        ENVIRONMENT_CACHE_MANIFEST_STORE_NAME,
        environmentId,
      );
      let manifest =
        raw === undefined
          ? defaultCacheManifest(environmentId, storageInstanceId)
          : yield* decodeEnvironmentCacheManifest(raw);
      let durableStatePresent = raw !== undefined;
      if (manifest.storageInstanceId !== storageInstanceId) {
        yield* resetUnreadableDurableCache(manifest);
        manifest = defaultCacheManifest(environmentId, storageInstanceId);
        durableStatePresent = false;
      }

      if (desktopBridge?.putSecret !== undefined && desktopBridge.getSecret !== undefined) {
        if (manifest.keyRef !== null) {
          const loaded = yield* environmentSecretStore.get(manifest.keyRef).pipe(Effect.option);
          if (Option.isSome(loaded) && Option.isSome(loaded.value)) {
            const encodedKey = loaded.value.value;
            const imported = yield* Effect.tryPromise({
              try: () => importCacheKeyMaterial(decodeCacheKeyMaterial(encodedKey)),
              catch: (cause) => catalogError("import protected cache key", cause),
            }).pipe(Effect.option);
            if (Option.isSome(imported)) {
              const durableManifest = { ...manifest, persistence: "durable" as const };
              const resolved = {
                key: imported.value,
                manifest: durableManifest,
                browserKey: undefined,
              } as const;
              resolvedCacheKeys.set(environmentId, resolved);
              return resolved;
            }
          }
        }

        if (durableStatePresent) {
          manifest = yield* resetUnreadableDurableCache(manifest);
          durableStatePresent = false;
        }

        const material = generateCacheKeyMaterial();
        const key = yield* Effect.tryPromise({
          try: () => importCacheKeyMaterial(material),
          catch: (cause) => catalogError("generate protected cache key", cause),
        });
        const stored = yield* environmentSecretStore
          .put(environmentId, "cache-key", encodeCacheKeyMaterial(material))
          .pipe(Effect.option);
        if (Option.isSome(stored)) {
          const durableManifest: EnvironmentCacheManifest = {
            ...manifest,
            keyRef: stored.value,
            persistence: "durable",
            entries: manifest.keyRef === stored.value ? manifest.entries : [],
            totalBytes: manifest.keyRef === stored.value ? manifest.totalBytes : 0,
          };
          const resolved = { key, manifest: durableManifest, browserKey: undefined } as const;
          resolvedCacheKeys.set(environmentId, resolved);
          return resolved;
        }
        return yield* makeSessionCacheKey(manifest);
      }

      const secureContextAvailable =
        (typeof isSecureContext === "undefined" || isSecureContext) &&
        globalThis.crypto?.subtle !== undefined;
      if (secureContextAvailable) {
        const storedBrowserKey =
          durableStatePresent && typeof raw === "object" && raw !== null && "browserKey" in raw
            ? cryptoKeyFromUnknown(raw.browserKey)
            : null;
        if (storedBrowserKey !== null) {
          const durableManifest: EnvironmentCacheManifest = {
            ...manifest,
            keyRef: null,
            persistence: "durable",
          };
          const resolved = {
            key: storedBrowserKey,
            manifest: durableManifest,
            browserKey: storedBrowserKey,
          } as const;
          resolvedCacheKeys.set(environmentId, resolved);
          return resolved;
        }

        if (durableStatePresent) {
          manifest = yield* resetUnreadableDurableCache(manifest);
          durableStatePresent = false;
        }

        const browserKey = yield* Effect.tryPromise({
          try: generateCacheKey,
          catch: (cause) => catalogError("generate browser cache key", cause),
        });
        const durableManifest: EnvironmentCacheManifest = {
          ...manifest,
          keyRef: null,
          persistence: "durable",
          entries: [],
          totalBytes: 0,
        };
        const persisted = yield* replaceCacheManifest(database, durableManifest, browserKey).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (persisted) {
          const resolved = {
            key: browserKey,
            manifest: durableManifest,
            browserKey,
          } as const;
          resolvedCacheKeys.set(environmentId, resolved);
          return resolved;
        }
      }

      if (durableStatePresent) {
        manifest = yield* resetUnreadableDurableCache(manifest);
      }

      return yield* makeSessionCacheKey(manifest);
    });

    const environmentMigrationStore = EnvironmentMigrationStore.of({
      load: (migrationId) =>
        readDatabaseValue(database, MIGRATION_STATE_STORE_NAME, migrationId).pipe(
          Effect.flatMap((raw) =>
            raw === undefined
              ? Effect.succeed(Option.none())
              : decodeEnvironmentMigrationReceipt(raw).pipe(Effect.map(Option.some)),
          ),
          Effect.mapError((cause) => normalizedPersistenceError("load-migration-receipt", cause)),
        ),
      save: (receipt) =>
        decodeEnvironmentMigrationReceipt(receipt).pipe(
          Effect.flatMap((decoded) =>
            writeInlineDatabaseValue(database, MIGRATION_STATE_STORE_NAME, decoded),
          ),
          Effect.mapError((cause) => normalizedPersistenceError("save-migration-receipt", cause)),
        ),
    });

    const catalogHealthStore = ConnectionCatalogHealthStore.of({
      state: catalog.health,
      reset: catalog.reset.pipe(Effect.mapError(catalogResetPersistenceError)),
    });

    const targetStore = ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((cause) => persistenceError("list-targets", cause)),
      ),
    });
    const registrationStore = ConnectionRegistrationStore.of({
      register: (registration) =>
        catalog
          .update((document) => registerConnectionInCatalog(document, registration))
          .pipe(Effect.mapError((cause) => persistenceError("register-connection", cause))),
      remove: (target) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, target))
          .pipe(Effect.mapError((cause) => persistenceError("remove-connection", cause))),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.profiles.find((profile) => profile.connectionId === connectionId),
            ),
          ),
        ),
      put: (profile) =>
        catalog.update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        catalog.update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
            ),
          ),
        ),
      put: (token) =>
        catalog.update((document) => ({
          ...document,
          remoteDpopTokens: replaceCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            token,
          ),
        })),
      remove: (environmentId) =>
        catalog.update((document) => ({
          ...document,
          remoteDpopTokens: removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            environmentId,
          ),
        })),
    });
    const acceptedStorageIdentityStore = AcceptedStorageIdentityStore.of({
      get: (targetKey) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.acceptedStorageIdentities.find(
                (identity) => identity.targetKey === targetKey,
              )?.storageInstanceId,
            ),
          ),
          Effect.mapError(() => storageIdentityPersistenceError("load-storage-identity")),
        ),
      accept: (identity) =>
        catalog
          .update((document) => ({
            ...document,
            acceptedStorageIdentities: replaceCatalogValue(
              document.acceptedStorageIdentities,
              (value) => value.targetKey,
              identity,
            ),
          }))
          .pipe(Effect.mapError(() => storageIdentityPersistenceError("accept-storage-identity"))),
      transition: (targetKey, decide) =>
        catalog
          .modify((document) => {
            const acceptedStorageInstanceId =
              document.acceptedStorageIdentities.find(
                (identity) => identity.targetKey === targetKey,
              )?.storageInstanceId ?? null;
            const transition = decide(acceptedStorageInstanceId);
            if (transition.mutation._tag === "Keep") {
              return { mutation: { _tag: "Keep" }, result: transition.result };
            }
            return {
              mutation: {
                _tag: "Set",
                document: {
                  ...document,
                  acceptedStorageIdentities: replaceCatalogValue(
                    document.acceptedStorageIdentities,
                    (value) => value.targetKey,
                    {
                      targetKey,
                      storageInstanceId: transition.mutation.storageInstanceId,
                    },
                  ),
                },
              },
              result: transition.result,
            };
          })
          .pipe(Effect.mapError(() => storageIdentityPersistenceError("accept-storage-identity"))),
    });

    const selectedCacheEntity = Effect.fn("web.connectionStorage.selectedCacheEntity")(function* (
      environmentId: EnvironmentId,
    ) {
      const uiState = yield* loadEnvironmentUiState;
      if (Option.isNone(uiState) || uiState.value.selected?.environmentId !== environmentId) {
        return null;
      }
      return uiState.value.selected.threadId === null
        ? ({ entityKind: "shell", entityId: CACHE_SHELL_ENTITY_ID } as const)
        : ({ entityKind: "thread", entityId: uiState.value.selected.threadId } as const);
    });

    const effectiveCacheManifest = Effect.fn("web.connectionStorage.effectiveCacheManifest")(
      function* (
        environmentId: EnvironmentId,
        resolved: {
          readonly manifest: EnvironmentCacheManifest;
        },
      ) {
        if (resolved.manifest.persistence === "session-only") {
          return sessionCacheManifests.get(environmentId) ?? resolved.manifest;
        }
        return Option.getOrElse(
          yield* loadDurableCacheManifest(environmentId),
          () => resolved.manifest,
        );
      },
    );

    const cacheScope = (
      manifest: EnvironmentCacheManifest,
      entityKind: CacheEntityKind,
      entityId: string,
    ): CacheAssociatedDataScope => ({
      schemaVersion: 1,
      environmentId: manifest.environmentId,
      storageInstanceId: manifest.storageInstanceId,
      entityKind,
      entityId,
    });

    const applySessionCacheWrite = (input: {
      readonly manifest: EnvironmentCacheManifest;
      readonly envelope: EncryptedCacheEnvelopeType;
      readonly protectedEntity: {
        readonly entityKind: CacheEntityKind;
        readonly entityId: string;
      } | null;
      readonly accessedAt: string;
    }): boolean => {
      const current = sessionCacheManifests.get(input.manifest.environmentId) ?? input.manifest;
      const existing = current.entries.find(
        (entry) =>
          entry.entityKind === input.envelope.entityKind &&
          entry.entityId === input.envelope.entityId,
      );
      if (!shouldReplaceCacheEntry(existing, input.envelope)) return false;
      const nextEntry: CacheManifestEntry = {
        entityKind: input.envelope.entityKind,
        entityId: input.envelope.entityId,
        byteLength: cacheEnvelopeByteLength(input.envelope),
        serverRevision: input.envelope.serverRevision,
        synchronizedAt: input.envelope.synchronizedAt,
        lastAccessedAt: input.accessedAt,
      };
      const candidateEntries = [
        ...current.entries.filter(
          (entry) =>
            entry.entityKind !== nextEntry.entityKind || entry.entityId !== nextEntry.entityId,
        ),
        nextEntry,
      ];
      const evictions = selectCacheEvictions(candidateEntries, {
        maxBytes: current.maxBytes,
        maxAgeMs: current.maxAgeMs,
        nowEpochMs: Date.parse(input.accessedAt),
        protectedEntity: input.protectedEntity,
      });
      const evictedKeys = new Set(
        evictions.map((entry) => `${entry.entityKind}\u0000${entry.entityId}`),
      );
      const retainedEntries = candidateEntries.filter(
        (entry) => !evictedKeys.has(`${entry.entityKind}\u0000${entry.entityId}`),
      );
      sessionCacheEnvelopes.set(
        sessionCacheRecordKey(
          input.manifest.environmentId,
          input.envelope.entityKind,
          input.envelope.entityId,
        ),
        input.envelope,
      );
      for (const eviction of evictions) {
        sessionCacheEnvelopes.delete(
          sessionCacheRecordKey(
            input.manifest.environmentId,
            eviction.entityKind,
            eviction.entityId,
          ),
        );
      }
      sessionCacheManifests.set(input.manifest.environmentId, {
        ...current,
        keyRef: null,
        persistence: "session-only",
        lastSynchronizedAt: input.envelope.synchronizedAt,
        totalBytes: retainedEntries.reduce((total, entry) => total + entry.byteLength, 0),
        entries: retainedEntries,
      });
      return true;
    };

    const saveEncryptedCachePayload = Effect.fn("web.connectionStorage.saveEncryptedCachePayload")(
      function* (input: {
        readonly environmentId: EnvironmentId;
        readonly entityKind: CacheEntityKind;
        readonly entityId: string;
        readonly serverRevision: number;
        readonly synchronizedAt: string;
        readonly plaintext: string;
      }) {
        return yield* cacheMutationSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const resolved = yield* resolveCacheKeyUnlocked(input.environmentId);
            const manifest = yield* effectiveCacheManifest(input.environmentId, resolved);
            const envelope = yield* Effect.tryPromise({
              try: () =>
                encryptCachePayload(resolved.key, {
                  scope: cacheScope(manifest, input.entityKind, input.entityId),
                  serverRevision: input.serverRevision,
                  synchronizedAt: input.synchronizedAt,
                  plaintext: input.plaintext,
                }),
              catch: (cause) => catalogError("encrypt cache payload", cause),
            });
            const accessedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            const protectedEntity = yield* selectedCacheEntity(input.environmentId);
            if (manifest.persistence === "session-only") {
              return applySessionCacheWrite({
                manifest,
                envelope,
                protectedEntity,
                accessedAt,
              });
            }
            return (yield* commitEncryptedCacheWrite({
              database,
              baseManifest: manifest,
              ...(resolved.browserKey === undefined ? {} : { browserKey: resolved.browserKey }),
              envelope,
              protectedEntity,
              accessedAt,
            })).applied;
          }),
        );
      },
    );

    const quarantineSessionCacheRecord = (input: {
      readonly manifest: EnvironmentCacheManifest;
      readonly entityKind: CacheEntityKind;
      readonly entityId: string;
      readonly reason: CacheQuarantineReason | null;
      readonly quarantinedAt: string;
    }) => {
      sessionCacheEnvelopes.delete(
        sessionCacheRecordKey(input.manifest.environmentId, input.entityKind, input.entityId),
      );
      const entries = input.manifest.entries.filter(
        (entry) => entry.entityKind !== input.entityKind || entry.entityId !== input.entityId,
      );
      sessionCacheManifests.set(input.manifest.environmentId, {
        ...input.manifest,
        entries,
        totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
        quarantine:
          input.reason === null
            ? input.manifest.quarantine
            : [
                ...input.manifest.quarantine,
                {
                  entityKind: input.entityKind,
                  entityId: input.entityId,
                  reason: input.reason,
                  quarantinedAt: input.quarantinedAt,
                },
              ].slice(-64),
      });
    };

    const loadEncryptedCachePayload = Effect.fn("web.connectionStorage.loadEncryptedCachePayload")(
      function* (input: {
        readonly environmentId: EnvironmentId;
        readonly entityKind: CacheEntityKind;
        readonly entityId: string;
      }) {
        return yield* cacheMutationSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const resolved = yield* resolveCacheKeyUnlocked(input.environmentId);
            const manifest = yield* effectiveCacheManifest(input.environmentId, resolved);
            const raw =
              manifest.persistence === "session-only"
                ? sessionCacheEnvelopes.get(
                    sessionCacheRecordKey(input.environmentId, input.entityKind, input.entityId),
                  )
                : yield* readDatabaseValue(
                    database,
                    cacheStoreName(input.entityKind),
                    cacheRecordKey(input.entityKind, input.environmentId, input.entityId),
                  );
            if (raw === undefined) return Option.none<string>();

            const accessedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            const decoded = yield* decodeEncryptedCacheEnvelope(raw).pipe(Effect.option);
            let quarantineReason: CacheQuarantineReason | null = null;
            if (Option.isNone(decoded)) {
              quarantineReason = "payload-invalid";
            } else if (decoded.value.storageInstanceId !== manifest.storageInstanceId) {
              quarantineReason = "storage-identity-mismatch";
            } else if (
              decoded.value.environmentId !== manifest.environmentId ||
              decoded.value.entityKind !== input.entityKind ||
              decoded.value.entityId !== input.entityId
            ) {
              quarantineReason = "scope-mismatch";
            } else if (
              Date.parse(accessedAt) - Date.parse(decoded.value.synchronizedAt) >
              manifest.maxAgeMs
            ) {
              quarantineReason = null;
            } else {
              const plaintext = yield* Effect.tryPromise({
                try: () =>
                  decryptCachePayload(
                    resolved.key,
                    decoded.value,
                    cacheScope(manifest, input.entityKind, input.entityId),
                  ),
                catch: () => catalogError("authenticate cache payload", "Authentication failed."),
              }).pipe(Effect.option);
              if (Option.isSome(plaintext)) {
                if (manifest.persistence === "session-only") {
                  sessionCacheManifests.set(input.environmentId, {
                    ...manifest,
                    entries: manifest.entries.map((entry) =>
                      entry.entityKind === input.entityKind && entry.entityId === input.entityId
                        ? { ...entry, lastAccessedAt: accessedAt }
                        : entry,
                    ),
                  });
                } else {
                  yield* touchEncryptedCacheEntry({
                    database,
                    environmentId: input.environmentId,
                    entityKind: input.entityKind,
                    entityId: input.entityId,
                    accessedAt,
                  });
                }
                return plaintext;
              }
              quarantineReason = "authentication-failed";
            }

            if (manifest.persistence === "session-only") {
              quarantineSessionCacheRecord({
                manifest,
                entityKind: input.entityKind,
                entityId: input.entityId,
                reason: quarantineReason,
                quarantinedAt: accessedAt,
              });
            } else {
              yield* removeEncryptedCacheRecord({
                database,
                environmentId: input.environmentId,
                entityKind: input.entityKind,
                entityId: input.entityId,
                reason: quarantineReason,
                quarantinedAt: accessedAt,
              });
            }
            return Option.none<string>();
          }),
        );
      },
    );

    const discardEncryptedCacheRecord = Effect.fn(
      "web.connectionStorage.discardEncryptedCacheRecord",
    )(function* (
      environmentId: EnvironmentId,
      entityKind: CacheEntityKind,
      entityId: string,
      reason: CacheQuarantineReason | null,
    ) {
      yield* cacheMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const resolved = yield* resolveCacheKeyUnlocked(environmentId);
          const manifest = yield* effectiveCacheManifest(environmentId, resolved);
          const removedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          if (manifest.persistence === "session-only") {
            quarantineSessionCacheRecord({
              manifest,
              entityKind,
              entityId,
              reason,
              quarantinedAt: removedAt,
            });
            return;
          }
          yield* removeEncryptedCacheRecord({
            database,
            environmentId,
            entityKind,
            entityId,
            reason,
            quarantinedAt: removedAt,
          });
        }),
      );
    });

    const cachePersistenceMode = (environmentId: EnvironmentId) =>
      cacheMutationSemaphore.withPermits(1)(
        resolveCacheKeyUnlocked(environmentId).pipe(
          Effect.map((resolved) => resolved.manifest.persistence),
        ),
      );
    const cacheStore = EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        Effect.gen(function* () {
          const encrypted = yield* loadEncryptedCachePayload({
            environmentId,
            entityKind: "shell",
            entityId: CACHE_SHELL_ENTITY_ID,
          });
          if (Option.isSome(encrypted)) {
            const decoded = yield* decodeStoredShellSnapshot(encrypted.value).pipe(Effect.option);
            if (Option.isSome(decoded) && decoded.value.environmentId === environmentId) {
              return Option.some(decoded.value.snapshot);
            }
            yield* discardEncryptedCacheRecord(
              environmentId,
              "shell",
              CACHE_SHELL_ENTITY_ID,
              "payload-invalid",
            );
            return Option.none();
          }

          const legacy = yield* readDatabaseValue(database, SHELL_STORE_NAME, environmentId);
          if (typeof legacy !== "string") return Option.none();
          const decoded = yield* decodeStoredShellSnapshot(legacy).pipe(Effect.option);
          if (Option.isNone(decoded) || decoded.value.environmentId !== environmentId) {
            yield* removeDatabaseValue(database, SHELL_STORE_NAME, environmentId);
            return Option.none();
          }
          if ((yield* cachePersistenceMode(environmentId)) !== "durable") {
            yield* removeDatabaseValue(database, SHELL_STORE_NAME, environmentId);
            return Option.none();
          }
          const encoded = yield* encodeStoredShellSnapshot(decoded.value);
          yield* saveEncryptedCachePayload({
            environmentId,
            entityKind: "shell",
            entityId: CACHE_SHELL_ENTITY_ID,
            serverRevision: decoded.value.snapshot.snapshotSequence,
            synchronizedAt: decoded.value.snapshot.updatedAt,
            plaintext: encoded,
          });
          yield* removeDatabaseValue(database, SHELL_STORE_NAME, environmentId);
          return Option.some(decoded.value.snapshot);
        }).pipe(Effect.mapError((cause) => persistenceError("load-shell", cause))),
      saveShell: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredShellSnapshot({
            schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          });
          yield* saveEncryptedCachePayload({
            environmentId,
            entityKind: "shell",
            entityId: CACHE_SHELL_ENTITY_ID,
            serverRevision: snapshot.snapshotSequence,
            synchronizedAt: snapshot.updatedAt,
            plaintext: encoded,
          });
          yield* removeDatabaseValue(database, SHELL_STORE_NAME, environmentId);
        }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause))),
      loadThread: (environmentId, threadId) =>
        Effect.gen(function* () {
          const encrypted = yield* loadEncryptedCachePayload({
            environmentId,
            entityKind: "thread",
            entityId: threadId,
          });
          if (Option.isSome(encrypted)) {
            const decoded = yield* decodeStoredThreadSnapshot(encrypted.value).pipe(Effect.option);
            if (
              Option.isSome(decoded) &&
              decoded.value.environmentId === environmentId &&
              decoded.value.threadId === threadId
            ) {
              return Option.some(decoded.value.thread);
            }
            yield* discardEncryptedCacheRecord(
              environmentId,
              "thread",
              threadId,
              "payload-invalid",
            );
            return Option.none();
          }

          const legacy = yield* readDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, threadId),
          );
          if (typeof legacy !== "string") return Option.none();
          const decoded = yield* decodeStoredThreadSnapshot(legacy).pipe(Effect.option);
          if (
            Option.isNone(decoded) ||
            decoded.value.environmentId !== environmentId ||
            decoded.value.threadId !== threadId
          ) {
            yield* removeDatabaseValue(
              database,
              THREAD_STORE_NAME,
              threadCacheKey(environmentId, threadId),
            );
            return Option.none();
          }
          if ((yield* cachePersistenceMode(environmentId)) !== "durable") {
            yield* removeDatabaseValue(
              database,
              THREAD_STORE_NAME,
              threadCacheKey(environmentId, threadId),
            );
            return Option.none();
          }
          const encoded = yield* encodeStoredThreadSnapshot(decoded.value);
          yield* saveEncryptedCachePayload({
            environmentId,
            entityKind: "thread",
            entityId: threadId,
            serverRevision: Math.max(0, Date.parse(decoded.value.thread.updatedAt)),
            synchronizedAt: decoded.value.thread.updatedAt,
            plaintext: encoded,
          });
          yield* removeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, threadId),
          );
          return Option.some(decoded.value.thread);
        }).pipe(Effect.mapError((cause) => persistenceError("load-thread", cause))),
      saveThread: (environmentId, thread) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: 1,
            environmentId,
            threadId: thread.id,
            thread,
          });
          yield* saveEncryptedCachePayload({
            environmentId,
            entityKind: "thread",
            entityId: thread.id,
            serverRevision: Math.max(0, Date.parse(thread.updatedAt)),
            synchronizedAt: thread.updatedAt,
            plaintext: encoded,
          });
          yield* removeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, thread.id),
          );
        }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause))),
      removeThread: (environmentId, threadId) =>
        discardEncryptedCacheRecord(environmentId, "thread", threadId, null).pipe(
          Effect.andThen(
            removeDatabaseValue(
              database,
              THREAD_STORE_NAME,
              threadCacheKey(environmentId, threadId),
            ),
          ),
          Effect.mapError((cause) => persistenceError("remove-thread", cause)),
        ),
      clear: (environmentId) =>
        cacheMutationSemaphore
          .withPermits(1)(
            Effect.gen(function* () {
              const sessionManifest = sessionCacheManifests.get(environmentId);
              const durableManifest = yield* loadDurableCacheManifest(environmentId);
              const keyRef =
                sessionManifest?.keyRef ?? Option.getOrNull(durableManifest)?.keyRef ?? null;
              if (keyRef !== null) {
                yield* environmentSecretStore.delete(keyRef);
              }
              const entries = [
                ...(sessionManifest?.entries ?? []),
                ...(Option.getOrNull(durableManifest)?.entries ?? []),
              ];
              for (const entry of entries) {
                sessionCacheEnvelopes.delete(
                  sessionCacheRecordKey(environmentId, entry.entityKind, entry.entityId),
                );
              }
              sessionCacheManifests.delete(environmentId);
              sessionCacheKeys.delete(environmentId);
              resolvedCacheKeys.delete(environmentId);
              yield* clearEncryptedCacheDatabase(database, environmentId);
              yield* Effect.all(
                [
                  removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
                  removeDatabaseValuesInRange(
                    database,
                    THREAD_STORE_NAME,
                    IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
                  ),
                ],
                { concurrency: "unbounded", discard: true },
              );
            }),
          )
          .pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause))),
    });

    const migrateLegacyPlaintextCache = Effect.gen(function* () {
      const shellKeys = yield* readAllDatabaseKeys(database, SHELL_STORE_NAME).pipe(
        Effect.mapError((cause) => persistenceError("load-shell", cause)),
      );
      const threadKeys = yield* readAllDatabaseKeys(database, THREAD_STORE_NAME).pipe(
        Effect.mapError((cause) => persistenceError("load-thread", cause)),
      );
      const known = yield* environmentCatalogStore.list;
      const knownIds = new Set(known.map((environment) => environment.environmentId));
      yield* Effect.forEach(
        shellKeys,
        (key) => {
          if (typeof key !== "string" || !knownIds.has(EnvironmentId.make(key))) {
            return removeDatabaseValue(database, SHELL_STORE_NAME, key).pipe(
              Effect.mapError((cause) => persistenceError("load-shell", cause)),
            );
          }
          return cacheStore.loadShell(EnvironmentId.make(key)).pipe(Effect.asVoid);
        },
        { concurrency: 1, discard: true },
      );

      yield* Effect.forEach(
        threadKeys,
        (key) => {
          if (typeof key !== "string") {
            return removeDatabaseValue(database, THREAD_STORE_NAME, key).pipe(
              Effect.mapError((cause) => persistenceError("load-thread", cause)),
            );
          }
          const cacheKey = key;
          const environment = known.find((candidate) =>
            cacheKey.startsWith(`${candidate.environmentId}:`),
          );
          if (environment === undefined) {
            return removeDatabaseValue(database, THREAD_STORE_NAME, cacheKey).pipe(
              Effect.mapError((cause) => persistenceError("load-thread", cause)),
            );
          }
          const threadId = ThreadId.make(cacheKey.slice(environment.environmentId.length + 1));
          return cacheStore.loadThread(environment.environmentId, threadId).pipe(Effect.asVoid);
        },
        { concurrency: 1, discard: true },
      );
    });
    yield* migrateLegacyPlaintextCache.pipe(
      Effect.catch(() =>
        Effect.logWarning(
          "Legacy plaintext cache cleanup was deferred without exposing its cause.",
        ),
      ),
    );

    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(EnvironmentCatalogStore, environmentCatalogStore),
      Context.add(EnvironmentUiStateStore, environmentUiStateStore),
      Context.add(EnvironmentCacheManifestStore, environmentCacheManifestStore),
      Context.add(EnvironmentMigrationStore, environmentMigrationStore),
      Context.add(EnvironmentSecretStore, environmentSecretStore),
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(AcceptedStorageIdentityStore, acceptedStorageIdentityStore),
      Context.add(ConnectionCatalogHealthStore, catalogHealthStore),
      Context.add(EnvironmentCacheStore, cacheStore),
    );
  }),
);
