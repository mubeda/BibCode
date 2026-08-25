# Environment Catalog, Routes, Secrets, And Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-target-per-environment catalog with durable known environments containing several verified routes, protected secret references, exact client UI state, and bounded encrypted offline cache.

**Architecture:** `packages/client-runtime` owns environment/route policy and persistence interfaces; `apps/web` implements transactional IndexedDB storage; `apps/desktop` implements typed OS secret operations. One generation-fenced supervisor selects routes for an environment, and ordinary RPC uses only one verified active session at a time.

**Tech Stack:** TypeScript 7, Effect 4, Effect Schema, IndexedDB, Web Crypto AES-GCM, React client state, Tauri 2/Rust, Windows DPAPI, keyring-rs 4.1.6 Apple Keychain and Linux Secret Service backends, Vite+.

**Spec:** [Architecture and data specification](./02-architecture-and-data.spec.md) and [connection/security specification](./03-connection-security-and-lifecycle.spec.md)

## Global Constraints

- A route locator is not identity. It joins an environment only after descriptor, storage, protocol, and transport trust verification.
- Several routes may reference one environment, but only one verified session is active for ordinary RPC.
- Route attempts are sequential by default, bounded, cancellable, sticky while healthy, and generation-fenced.
- Environment, project, thread, worktree, terminal, draft, tab, and cache keys remain explicitly scoped; string concatenation is not a public contract.
- IndexedDB contains no bearer/access/refresh token, DPoP private key, pairing code, cookie, SSH password, or cache key in plaintext.
- Loss or lock of the secure provider yields Authentication required or session-only cache; it never silently downgrades to plaintext.
- Same-origin browser auth remains Secure/HttpOnly/SameSite cookie based.
- Offline server-derived state is read-only, marked stale, bounded by bytes/age, and never queued for replay.
- Forget/Force remove closes admission, cancels owned work, clears secrets/cache/UI state, then deletes metadata in that order.
- Keep old schema support only in a bounded migration decoder; normal runtime has no Relay/Connect route variant after migration.

---

## File Structure

- Modify: `packages/client-runtime/src/connection/model.ts` — route/status types.
- Modify: `packages/client-runtime/src/connection/catalog.ts` — `KnownEnvironment` aggregate.
- Modify: `packages/client-runtime/src/connection/registry.ts` — catalog and lifecycle owner.
- Modify: `packages/client-runtime/src/connection/supervisor.ts` — route selection/failover.
- Modify: `packages/client-runtime/src/connection/resolver.ts` and `driver.ts` — route preparation/identity verification.
- Modify: `packages/client-runtime/src/platform/persistence.ts` — normalized persistence services.
- Replace: `packages/client-runtime/src/platform/storageDocument.ts` — v1 migration-only decoder plus v2 records.
- Create: `packages/client-runtime/src/connection/routeSelection.ts` and test.
- Create: `packages/client-runtime/src/cache/envelope.ts` and test.
- Modify: `apps/web/src/connection/storage.ts` and test — IndexedDB v3 stores/migration/encryption.
- Create: `apps/web/src/connection/cacheCrypto.ts` and test.
- Modify: `packages/contracts/src/ipc.ts` and test — opaque secret bridge.
- Create: `apps/desktop/src-tauri/src/secret_store.rs`.
- Modify: `apps/desktop/src-tauri/src/security.rs`, `bridge.rs`, `lib.rs`, and tests.
- Modify: `Cargo.toml`, `apps/desktop/src-tauri/Cargo.toml`, `Cargo.lock` for audited platform secret dependencies.

### Task 1: Define known-environment and route contracts

**Files:**

- Modify: `packages/client-runtime/src/connection/model.ts`
- Modify: `packages/client-runtime/src/connection/catalog.ts`
- Modify: `packages/client-runtime/src/connection/index.ts`
- Test: `packages/client-runtime/src/connection/catalog.test.ts`

**Interfaces:**

- Produces: `KnownEnvironment`, `EnvironmentRoute`, `EnvironmentBinding`, `EnvironmentUiPreferences`, and actionable status types.

- [x] **Step 1: Write failing schema and collision tests**

```ts
it("keeps two routes under one proved environment", () => {
  const environment = decodeKnownEnvironment({
    environmentId: ENVIRONMENT_ID,
    acceptedStorageInstanceId: STORAGE_ID,
    routes: [sshRoute, httpsRoute],
  });
  expect(environment.routes.map((route) => route.routeId)).toEqual(["route:ssh", "route:https"]);
});
```

- [x] **Step 2: Run the focused test and confirm RED**

```sh
vp test run packages/client-runtime/src/connection/catalog.test.ts
```

- [x] **Step 3: Replace target classes with route classes**

```ts
const EnvironmentRouteBase = {
  routeId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
  priority: Schema.Int,
  pinned: Schema.Boolean,
  autoconnect: Schema.Boolean,
  secretRef: Schema.NullOr(Schema.String),
};

export class SshTunnelRoute extends Schema.TaggedClass<SshTunnelRoute>()("SshTunnelRoute", {
  ...EnvironmentRouteBase,
  target: DesktopSshEnvironmentTargetSchema,
  hostKeyFingerprint: Schema.NullOr(Schema.String),
}) {}

export class DirectHttpsRoute extends Schema.TaggedClass<DirectHttpsRoute>()("DirectHttpsRoute", {
  ...EnvironmentRouteBase,
  httpsBaseUrl: Schema.String,
  trust: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("System") }),
    Schema.Struct({ _tag: Schema.Literal("PinnedSpki"), sha256: Schema.String }),
  ]),
}) {}
```

Add `DesktopLoopbackRoute` and `DesktopWslRoute`; model an unavailable WSL discovery result as a binding/condition rather than a connectable route.

Implementation sequencing: the canonical route contracts are now the v2 model. The legacy target classes remain temporarily as an input adapter for existing registry/storage consumers; Tasks 3-6 migrate those consumers, and Plan 60 deletes the final Relay/Connect-only variants instead of creating a compatibility alias.

- [x] **Step 4: Define the environment aggregate**

```ts
export interface KnownEnvironment {
  readonly environmentId: EnvironmentId;
  readonly acceptedStorageInstanceId: string;
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly alias: string | null;
  readonly hidden: boolean;
  readonly bindings: ReadonlyArray<EnvironmentBinding>;
  readonly routes: ReadonlyArray<EnvironmentRoute>;
}
```

- [x] **Step 5: Add explicit status/reason types**

```ts
export type EnvironmentPresentationStatus =
  | "online"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "authentication-required"
  | "version-incompatible"
  | "updating"
  | "stopped";
```

Extend blocked reasons with `environment-changed`, `certificate-changed`, `version-incompatible`, and `identity-conflict`; delete `relay-unavailable` from the new runtime type.

- [x] **Step 6: Run tests/typecheck and commit**

```sh
vp test run packages/client-runtime/src/connection/catalog.test.ts packages/client-runtime/src/connection/presentation.test.ts
vp run --filter @bibcode/client-runtime typecheck
git add packages/client-runtime/src/connection/model.ts packages/client-runtime/src/connection/catalog.ts packages/client-runtime/src/connection/catalog.test.ts packages/client-runtime/src/connection/index.ts
git commit -m "refactor(connections): model environments with routes"
```

### Task 2: Replace persistence interfaces with normalized environment stores

**Files:**

- Modify: `packages/client-runtime/src/platform/persistence.ts`
- Modify: `packages/client-runtime/src/platform/index.ts`
- Modify: `packages/client-runtime/src/platform/storageDocument.ts`
- Modify: `packages/client-runtime/src/platform/storageDocument.test.ts`

**Interfaces:**

- Produces: atomic environment catalog mutations, UI-state store, secret reference store, cache manifest store, and migration receipts.

- [x] **Step 1: Write failing referential-integrity tests**

```ts
it.effect("rejects an orphan route and clears dependents atomically", () =>
  Effect.gen(function* () {
    const stores = yield* EnvironmentCatalogStore;
    yield* expectFailure(stores.replaceEnvironment(orphanedFixture));
    yield* stores.forget(ENVIRONMENT_ID);
    expect(yield* stores.load(ENVIRONMENT_ID)).toEqual(Option.none());
  }),
);
```

- [x] **Step 2: Run the platform tests and confirm RED**

```sh
vp test run packages/client-runtime/src/platform/storageDocument.test.ts
```

- [x] **Step 3: Define transaction-shaped services**

```ts
export class EnvironmentCatalogStore extends Context.Service<
  EnvironmentCatalogStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<KnownEnvironment>, ConnectionPersistenceError>;
    readonly put: (
      environment: KnownEnvironment,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly updateRoutes: (
      environmentId: EnvironmentId,
      routes: ReadonlyArray<EnvironmentRoute>,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly forget: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/platform/persistence/EnvironmentCatalogStore") {}
```

Add `EnvironmentUiStateStore`, `EnvironmentSecretStore` (opaque values only through platform capability), `EnvironmentCacheManifestStore`, and `EnvironmentMigrationStore`.

- [x] **Step 4: Make legacy schema explicitly migration-only**

```ts
export const LegacyConnectionCatalogV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(Schema.Unknown),
  profiles: Schema.Array(Schema.Unknown),
  credentials: Schema.Array(Schema.Unknown),
  remoteDpopTokens: Schema.Array(Schema.Unknown),
  acceptedStorageIdentities: Schema.Array(Schema.Unknown),
});
```

Do not export this decoder from the public platform index. Normal records are independent rows, not one replacement JSON document.

Implementation sequencing: `LegacyConnectionCatalogV1` is hidden from the public platform index and treats every legacy row as unknown migration input. The existing strict schema-v1 symbols remain as a deprecated named adapter only until Task 3 migrates the current web driver; normal v2 rows and services do not depend on legacy target variants.

- [x] **Step 5: Run tests and commit**

```sh
vp test run packages/client-runtime/src/platform/storageDocument.test.ts
vp run --filter @bibcode/client-runtime typecheck
git add packages/client-runtime/src/platform/persistence.ts packages/client-runtime/src/platform/index.ts packages/client-runtime/src/platform/storageDocument.ts packages/client-runtime/src/platform/storageDocument.test.ts
git commit -m "refactor(storage): normalize environment persistence"
```

### Task 3: Implement IndexedDB v3 stores and atomic migration

**Files:**

- Modify: `apps/web/src/connection/storage.ts`
- Modify: `apps/web/src/connection/storage.test.ts`
- Create: `apps/web/src/connection/catalogMigration.ts`
- Test: `apps/web/src/connection/catalogMigration.test.ts`

**Interfaces:**

- Migrates: IndexedDB v2 `catalog/shell/thread` into v3 normalized stores.
- Produces: one transaction for environment/route/binding/migration receipt publication.

- [x] **Step 1: Write failing clean, Relay-only, mixed-route, corrupt, and retry migration tests**

```ts
expect(await migrate(legacyRelayOnly)).toEqual({ environments: [], receipt: "catalog-v1-to-v3" });
expect((await migrate(legacyDirect)).environments[0]?.routes).toHaveLength(1);
await expect(runTwiceAfterInjectedAbort(legacyDirect)).resolves.toMatchObject({ receiptCount: 1 });
```

- [x] **Step 2: Run focused storage tests and confirm RED**

```sh
vp test run apps/web/src/connection/catalogMigration.test.ts apps/web/src/connection/storage.test.ts
```

- [x] **Step 3: Create the exact v3 object stores**

```ts
const DATABASE_VERSION = 3;
const STORE_NAMES = [
  "environments",
  "environmentRoutes",
  "environmentBindings",
  "environmentUiState",
  "environmentCacheManifest",
  "shellCache",
  "threadCache",
  "migrationState",
] as const;
```

Use compound keys for bindings and thread cache. Create indexes on `environmentId` for every dependent store so Forget can clear a bounded key range.

- [x] **Step 4: Implement one upgrade transaction per phase**

Decode raw v1 values with `LegacyConnectionCatalogV1`; discard Relay/Connect targets/tokens; preserve direct metadata and accepted storage IDs; stage secret imports; create a receipt; only then delete the legacy document.

```ts
transaction
  .objectStore("migrationState")
  .add({ id: "catalog-v1-to-v3", completedAt: nowIso }, "catalog-v1-to-v3");
transaction.objectStore("catalog").delete("document");
```

Dependency gate resolved: startup stages legacy credentials into protected OS storage, publishes normalized rows and the receipt atomically, and deletes the legacy document in the same transaction. A failed or racing activation deletes staged secret references and leaves the legacy document available for retry. Once the receipt exists, the registry never reads legacy targets.

- [x] **Step 5: Quarantine corrupt non-secret metadata**

Write only entry kind, hash, and bounded decoder error to local diagnostics. Never copy raw legacy credentials/tokens into quarantine output. Always synthesize/reconcile the primary platform binding so one corrupt remote cannot block launch.

- [x] **Step 6: Prove transactional cleanup and retry**

Inject aborts before receipt, after secret import, and before legacy deletion. Verify retry has no duplicate environment/route and does not restore Relay-only records.

- [x] **Step 7: Run tests and commit**

```sh
vp test run apps/web/src/connection/catalogMigration.test.ts apps/web/src/connection/storage.test.ts
git add apps/web/src/connection/catalogMigration.ts apps/web/src/connection/catalogMigration.test.ts apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts
git commit -m "feat(web): migrate normalized environment catalog"
```

### Task 4: Add typed desktop secret storage

**Files:**

- Modify: `Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ipc.test.ts`
- Create: `apps/desktop/src-tauri/src/secret_store.rs`
- Modify: `apps/desktop/src-tauri/src/security.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/tests/bridge_public_contract.rs`

**Interfaces:**

- Produces: `putSecret`, `getSecret`, and `deleteSecret` with opaque references; no inventory/list operation.

- [x] **Step 1: Write failing IPC redaction and round-trip tests**

```ts
const ref = await bridge.putSecret({ purpose: "environment-session", value: "secret-value" });
expect(ref).toMatch(/^bibcode-secret:/u);
expect(await bridge.getSecret(ref)).toBe("secret-value");
await bridge.deleteSecret(ref);
expect(await bridge.getSecret(ref)).toBeNull();
```

- [x] **Step 2: Add the schema-only bridge contract**

```ts
export interface DesktopSecretInput {
  readonly purpose: "environment-session" | "dpop-private-key" | "cache-key";
  readonly value: string;
}

export interface DesktopBridge {
  putSecret?: (input: DesktopSecretInput) => Promise<string>;
  getSecret?: (secretRef: string) => Promise<string | null>;
  deleteSecret?: (secretRef: string) => Promise<void>;
}
```

- [x] **Step 3: Pin platform dependencies**

Use existing user-scoped DPAPI code on Windows. Add `keyring = "4.1.6"` with only Apple native Keychain on macOS and zbus Secret Service on Linux; do not enable a file/database keystore backend.

- [x] **Step 4: Implement the Rust capability boundary**

```rust
pub enum SecretPurpose { EnvironmentSession, DpopPrivateKey, CacheKey }

pub trait DesktopSecretProvider: Send + Sync {
    fn put(&self, purpose: SecretPurpose, value: &[u8]) -> Result<String, SecretStoreError>;
    fn get(&self, reference: &str) -> Result<Option<Vec<u8>>, SecretStoreError>;
    fn delete(&self, reference: &str) -> Result<(), SecretStoreError>;
}
```

Validate the `bibcode-secret:<uuid>` reference format, scope entries to `com.bibcode.desktop`, protect Windows values with `CryptProtectData` user scope, and never include the value in `Display`, `Debug`, tracing, or IPC errors.

- [x] **Step 5: Fail closed on unavailable/locked providers**

Return a typed `unavailable`/`locked` error so the renderer chooses session-only operation. Do not write a fallback file, Tauri store value, localStorage value, or IndexedDB credential.

- [x] **Step 6: Run platform-appropriate tests and commit**

```sh
vp test run packages/contracts/src/ipc.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop secret_store -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop --test bridge_public_contract -- --nocapture
git add Cargo.toml Cargo.lock apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/security.rs apps/desktop/src-tauri/src/secret_store.rs apps/desktop/src-tauri/src/bridge.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tests/bridge_public_contract.rs packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts
git commit -m "feat(desktop): protect environment secrets with OS stores"
```

### Task 5: Refactor the registry and supervisor for multi-route failover

**Files:**

- Create: `packages/client-runtime/src/connection/routeSelection.ts`
- Create: `packages/client-runtime/src/connection/routeSelection.test.ts`
- Modify: `packages/client-runtime/src/connection/registry.ts`
- Modify: `packages/client-runtime/src/connection/registry.test.ts`
- Modify: `packages/client-runtime/src/connection/supervisor.ts`
- Modify: `packages/client-runtime/src/connection/supervisor.test.ts`
- Modify: `packages/client-runtime/src/connection/driver.ts`

**Interfaces:**

- Produces: one environment supervisor, ordered route attempts, active route ID, and route-result history.

- [x] **Step 1: Write failing priority/stickiness/failover/generation tests**

```ts
expect(selectRoute({ pinned: "ssh", healthy: "https", routes })).toBe("ssh");
expect(selectRoute({ pinned: null, healthy: "https", routes })).toBe("https");
await harness.completeAttempt(oldGeneration, oldRoute);
expect(harness.activeRoute()).toBe(newRoute.routeId);
```

- [x] **Step 2: Run supervisor tests and confirm RED**

```sh
vp test run packages/client-runtime/src/connection/routeSelection.test.ts packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/connection/registry.test.ts
```

- [x] **Step 3: Implement deterministic route ordering**

```ts
export function eligibleRoutes(environment: KnownEnvironment, activeRouteId: string | null) {
  return [...environment.routes]
    .filter((route) => route.autoconnect || route.routeId === environment.pinnedRouteId)
    .toSorted(
      (left, right) =>
        Number(right.routeId === environment.pinnedRouteId) -
          Number(left.routeId === environment.pinnedRouteId) ||
        Number(right.routeId === activeRouteId) - Number(left.routeId === activeRouteId) ||
        left.priority - right.priority ||
        left.routeId.localeCompare(right.routeId),
    );
}
```

- [x] **Step 4: Move scope ownership to the environment aggregate**

`EnvironmentServiceScope.entry` stores the `KnownEnvironment`; the supervisor exposes `activeRouteId`, `prepared`, `session`, `connect`, `disconnect`, and `retryNow`. One lease lock remains keyed by durable environment UUID.

- [x] **Step 5: Attempt routes sequentially with cancellation**

Each attempt receives `{ environmentGeneration, routeGeneration, cancellation }`. A transient failure advances to the next eligible route; auth/version/identity/certificate failures mark only the affected route blocked and do not burn credentials or change identity.

- [x] **Step 6: Bound global connection pressure**

Add a registry semaphore for simultaneous environment attempts (start with the measured current safe default, configurable in tests). Preserve per-environment backoff with jitter and cancel all pending route work on Forget.

- [x] **Step 7: Run runtime tests and commit**

```sh
vp test run packages/client-runtime/src/connection/routeSelection.test.ts packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/connection/driver.test.ts
git add packages/client-runtime/src/connection/routeSelection.ts packages/client-runtime/src/connection/routeSelection.test.ts packages/client-runtime/src/connection/registry.ts packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/connection/supervisor.ts packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/connection/driver.ts
git commit -m "feat(connections): supervise multiple routes per environment"
```

### Task 6: Verify descriptor/storage/TLS identity before credentials

**Files:**

- Modify: `packages/client-runtime/src/connection/resolver.ts`
- Modify: `packages/client-runtime/src/connection/resolver.test.ts`
- Modify: `packages/client-runtime/src/connection/storageIdentity.ts`
- Modify: `packages/client-runtime/src/connection/storageIdentity.test.ts`
- Modify: `packages/client-runtime/src/environment/descriptor.ts`
- Modify: `packages/client-runtime/src/authorization/remote.ts`

**Interfaces:**

- Consumes: transport-verified minimal descriptor.
- Produces: `VerifiedRouteIdentity`; pairing/session secret loads happen only afterward.

- [x] **Step 1: Write failing ordering and mismatch tests**

```ts
expect(harness.events).toEqual([
  "transport-trust",
  "fetch-descriptor",
  "compare-environment",
  "compare-storage",
  "check-protocol",
  "load-secret",
  "open-session",
]);
expect(harness.secretReadsAfterMismatch).toBe(0);
```

- [x] **Step 2: Run resolver tests and confirm RED**

```sh
vp test run packages/client-runtime/src/connection/resolver.test.ts packages/client-runtime/src/connection/storageIdentity.test.ts
```

- [x] **Step 3: Add the verified identity value**

```ts
export interface VerifiedRouteIdentity {
  readonly routeId: string;
  readonly environmentId: EnvironmentId;
  readonly storageInstanceId: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly transportTrust: "loopback" | "ssh-host-key" | "system-tls" | "pinned-spki";
}
```

- [x] **Step 4: Split resolver prepare into trust/identity/session phases**

No session broker receives a pairing credential or secret reference until `verifyRouteIdentity` succeeds. A storage mismatch offers an explicit later Adopt/New Environment decision but cannot mutate the accepted ID in this path.

- [x] **Step 5: Add downgrade/version/certificate cases**

Reject HTTP for non-loopback URLs, changed SPKI pins, invalid system TLS, descriptor environment mismatch, storage mismatch, and non-overlapping protocol ranges with typed blocked reasons.

- [x] **Step 6: Run tests and commit**

```sh
vp test run packages/client-runtime/src/connection/resolver.test.ts packages/client-runtime/src/connection/storageIdentity.test.ts packages/client-runtime/src/environment/descriptor.test.ts
git add packages/client-runtime/src/connection/resolver.ts packages/client-runtime/src/connection/resolver.test.ts packages/client-runtime/src/connection/storageIdentity.ts packages/client-runtime/src/connection/storageIdentity.test.ts packages/client-runtime/src/environment/descriptor.ts packages/client-runtime/src/authorization/remote.ts
git commit -m "feat(connections): verify route identity before credentials"
```

### Task 7: Encrypt and bound the offline cache

**Files:**

- Create: `packages/client-runtime/src/cache/envelope.ts`
- Create: `packages/client-runtime/src/cache/envelope.test.ts`
- Create: `apps/web/src/connection/cacheCrypto.ts`
- Create: `apps/web/src/connection/cacheCrypto.test.ts`
- Modify: `apps/web/src/connection/storage.ts`
- Modify: `apps/web/src/connection/storage.test.ts`

**Interfaces:**

- Produces: versioned AES-GCM envelope, associated-data scope, byte/age/LRU manifest, and session-only fallback.

- [x] **Step 1: Write failing round-trip/tamper/scope/eviction tests**

```ts
await expect(decrypt(envelope, { ...scope, environmentId: OTHER_ENV })).rejects.toThrow();
await expect(decrypt({ ...envelope, ciphertext: tampered }, scope)).rejects.toThrow();
expect(evict(manifest, { maxBytes: 1024, protect: selectedKey })).not.toContain(selectedKey);
```

- [x] **Step 2: Run cache tests and confirm RED**

```sh
vp test run packages/client-runtime/src/cache/envelope.test.ts apps/web/src/connection/cacheCrypto.test.ts apps/web/src/connection/storage.test.ts
```

- [x] **Step 3: Define the envelope and associated data**

```ts
export interface EncryptedCacheEnvelope {
  readonly schemaVersion: 1;
  readonly environmentId: EnvironmentId;
  readonly storageInstanceId: string;
  readonly entityKind: "shell" | "thread";
  readonly entityId: string;
  readonly serverRevision: number;
  readonly synchronizedAt: string;
  readonly nonce: string;
  readonly ciphertext: string;
}
```

Serialize `{schemaVersion, environmentId, storageInstanceId, entityKind, entityId}` as AES-GCM additional authenticated data.

- [x] **Step 4: Resolve cache keys through the secret capability**

Desktop uses an opaque `cache-key` reference. Secure browser contexts use a non-exportable Web Crypto key when durable structured-clone persistence succeeds; otherwise keep the key and cache in memory for the session and expose `persistence: "session-only"`.

- [x] **Step 5: Enforce age/byte/LRU bounds**

Update the manifest in the same transaction as cache writes. Protect current selection, evict oldest unprotected entries, reject stale-revision overwrites, and quarantine a storage-identity mismatch without rendering it.

- [x] **Step 6: Migrate or delete legacy plaintext cache**

When a secure key is available, decode once and write an envelope before deleting plaintext. Otherwise delete persistent plaintext and report that offline history must resynchronize.

- [x] **Step 7: Run tests and commit**

```sh
vp test run packages/client-runtime/src/cache/envelope.test.ts apps/web/src/connection/cacheCrypto.test.ts apps/web/src/connection/storage.test.ts
git add packages/client-runtime/src/cache/envelope.ts packages/client-runtime/src/cache/envelope.test.ts apps/web/src/connection/cacheCrypto.ts apps/web/src/connection/cacheCrypto.test.ts apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts
git commit -m "feat(cache): encrypt bounded environment snapshots"
```

### Task 8: Implement Hide, Forget, and cancellation-safe cleanup primitives

**Files:**

- Modify: `packages/client-runtime/src/connection/registry.ts`
- Modify: `packages/client-runtime/src/connection/registry.test.ts`
- Modify: `packages/client-runtime/src/platform/persistence.ts`
- Modify: `apps/web/src/connection/storage.ts`
- Modify: `apps/web/src/connection/storage.test.ts`

**Interfaces:**

- Produces: `hide`, `restore`, `removeRoute`, and `forget`; host uninstall/purge remains outside this plan.

- [ ] **Step 1: Write failing cleanup-order and late-reconnect tests**

```ts
expect(harness.events).toEqual([
  "close-admission",
  "cancel-supervisor",
  "await-scope",
  "delete-secrets",
  "clear-cache",
  "clear-ui",
  "delete-routes",
  "delete-environment",
]);
expect(harness.replayedLateSuccess).toBe("ignored");
```

- [ ] **Step 2: Run registry/storage tests and confirm RED**

```sh
vp test run packages/client-runtime/src/connection/registry.test.ts apps/web/src/connection/storage.test.ts
```

- [ ] **Step 3: Add narrow lifecycle methods**

```ts
readonly hide: (environmentId: EnvironmentId) => Effect.Effect<void, PersistenceError>;
readonly restore: (environmentId: EnvironmentId) => Effect.Effect<void, PersistenceError>;
readonly removeRoute: (environmentId: EnvironmentId, routeId: string) => Effect.Effect<void, PersistenceError>;
readonly forget: (environmentId: EnvironmentId) => Effect.Effect<void, PersistenceError>;
```

Hide changes only client UI metadata. Remove-route retains the environment if another route/binding/cache record remains. Forget performs the full ordered cleanup.

- [ ] **Step 4: Fence concurrent register/reconcile operations**

Increment environment generation and set an admission tombstone before cancellation. Platform reconciliation may recreate a visible binding only after a new authoritative generation; stale work cannot resurrect forgotten metadata.

- [ ] **Step 5: Clear all dependent stores in one IndexedDB transaction**

Delete route, binding, UI, manifest, shell, and thread rows through `environmentId` indexes. Delete OS secrets before final metadata removal; a failed secret deletion keeps a redacted repair receipt rather than pretending cleanup succeeded.

- [ ] **Step 6: Run plan-level verification and commit**

```sh
vp test run packages/client-runtime/src/connection packages/client-runtime/src/platform apps/web/src/connection
vp check
vp run typecheck
node scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop secret_store -- --nocapture
cargo fmt --all --check
git add packages/client-runtime/src/connection/registry.ts packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/platform/persistence.ts apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts
git commit -m "feat(environments): add safe hide and forget lifecycle"
```

### Task 9: Update connection-runtime and cache living documentation

**Files:**

- Modify: `packages/client-runtime/README.md`
- Modify: `docs/architecture/connection-runtime.md`
- Modify: `docs/architecture/remote.md`
- Modify: `docs/reference/encyclopedia.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/execution-report-template.md`

- [ ] **Step 1: Document state ownership and the route state machine**

Include `KnownEnvironment -> routes -> one active session`, exact status vocabulary, identity verification order, secret-reference rule, cache envelope, and Forget ordering.

- [ ] **Step 2: Add repeatable migration/offline evidence**

The runbook must exercise v1 direct, v1 Relay-only, corrupt, secret-provider unavailable, tampered cache, duplicate IDs across environments, failover, stale generation, and Forget cleanup.

- [ ] **Step 3: Verify docs and commit**

```sh
git diff --check
rg -n "one target per environment|plaintext|RelayConnectionTarget|KnownEnvironment|session-only" packages/client-runtime/README.md docs/architecture docs/reference docs/testing
git add packages/client-runtime/README.md docs/architecture/connection-runtime.md docs/architecture/remote.md docs/reference/encyclopedia.md docs/testing/cross-platform-validation.md docs/testing/execution-report-template.md
git commit -m "docs: describe multi-route private environment storage"
```
