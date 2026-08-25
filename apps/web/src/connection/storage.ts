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
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  CATALOG_V1_TO_V3_MIGRATION_ID,
  planCatalogV1ToV3Migration,
  type CatalogMigrationMetadata,
} from "./catalogMigration.ts";

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
    const environmentSecretStore = makeEnvironmentSecretStore(
      typeof window === "undefined" ? undefined : window.desktopBridge,
    );
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

    const environmentCacheManifestStore = EnvironmentCacheManifestStore.of({
      load: (environmentId) =>
        readDatabaseValue(database, ENVIRONMENT_CACHE_MANIFEST_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) =>
            raw === undefined
              ? Effect.succeed(Option.none())
              : decodeEnvironmentCacheManifest(raw).pipe(Effect.map(Option.some)),
          ),
          Effect.mapError((cause) => normalizedPersistenceError("load-cache-manifest", cause)),
        ),
      save: (manifest) =>
        decodeEnvironmentCacheManifest(manifest).pipe(
          Effect.flatMap((decoded) =>
            writeInlineDatabaseValue(database, ENVIRONMENT_CACHE_MANIFEST_STORE_NAME, decoded),
          ),
          Effect.mapError((cause) => normalizedPersistenceError("save-cache-manifest", cause)),
        ),
      remove: (environmentId) =>
        removeDatabaseValue(database, ENVIRONMENT_CACHE_MANIFEST_STORE_NAME, environmentId).pipe(
          Effect.mapError((cause) => normalizedPersistenceError("delete-cache-manifest", cause)),
        ),
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
    const cacheStore = EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        readDatabaseValue(database, SHELL_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }
            return decodeStoredShellSnapshot(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-shell", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId
                  ? Option.some(stored.snapshot)
                  : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-shell", cause),
          ),
        ),
      saveShell: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredShellSnapshot({
            schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));
          yield* writeDatabaseValue(database, SHELL_STORE_NAME, environmentId, encoded);
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-shell", cause),
          ),
        ),
      loadThread: (environmentId, threadId) =>
        readDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }
            return decodeStoredThreadSnapshot(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-thread", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId && stored.threadId === threadId
                  ? Option.some(stored.thread)
                  : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-thread", cause),
          ),
        ),
      saveThread: (environmentId, thread) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: 1,
            environmentId,
            threadId: thread.id,
            thread,
          }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause)));
          yield* writeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, thread.id),
            encoded,
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-thread", cause),
          ),
        ),
      removeThread: (environmentId, threadId) =>
        removeDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(Effect.mapError((cause) => persistenceError("remove-thread", cause))),
      clear: (environmentId) =>
        Effect.all(
          [
            removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause))),
    });

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
