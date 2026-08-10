# Cross-Platform Project Data Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent BiBCode projects from silently appearing lost after updates or environment changes, and provide verified local backup and recovery on Windows, macOS, Linux, and Windows WSL.

**Architecture:** The Rust server becomes the source of truth for data-root resolution, persistent-store identity, startup classification, SQLite backup, and recovery. The desktop host coordinates OS/WSL lifecycle and updater safety through authenticated local maintenance endpoints, while contracts and client runtime validate storage identity before accepting project snapshots and the web UI renders authoritative availability and recovery states.

**Tech Stack:** Rust 2024, Tokio, Axum, rusqlite/SQLite online backup, serde/serde_json, UUID, SHA-256, Tauri 2 updater and desktop bridge, Effect Schema/Effect services, React, Vite+, WebdriverIO, GitHub Actions.

## Global Constraints

- Do not scan, migrate, merge, import, or maintain compatibility with legacy application data formats or paths.
- Legacy filesystem leftovers are inert unless the resolved effective root, a symlink/junction, or a configured remote endpoint points to them.
- Keep `environmentId` as the logical routing identity and use a randomly generated UUID `storageInstanceId` as the persistent-store identity.
- New servers must always emit a valid `storageInstanceId`; `null` is accepted only for version skew with an older remote server.
- Reject explicit relative data-root overrides; canonicalize valid symlink and Windows junction/reparse-point roots and report requested and effective paths locally.
- The absence of both `state.sqlite` and `environment-id` is the only automatic first-run database-creation case.
- Never rewrite a malformed marker, recreate a known missing database, adopt a different store, restore a backup, or start empty without an explicit safe state transition.
- Show `No projects yet` only after every desired environment has produced an authoritative live empty snapshot.
- WSL-only launch failure must never fall back to the native Windows backend.
- Keep the latest three verified backups per storage instance and state kind under `<effective-base-root>/backups/<state-kind>/<storage-instance-id>/`.
- Require a verified backup before every pending migration of an existing database and before primary in-app update installation.
- Preserve the current database, WAL, SHM, and marker before restore or explicit start-empty operations.
- Do not expose local filesystem paths in normal remote environment descriptors.
- Privileged restore, start-empty, updater, process, and path-opening operations must cross `DesktopBridge`; normal application traffic remains typed HTTP/WebSocket RPC.
- Supported packaged upgrade targets are Windows x64 NSIS, macOS arm64 and x64, and Linux x64 AppImage.
- External Linux package replacement receives startup and pre-migration protection; no pre-install hook is promised.
- Add no production Node.js runtime, Electron host, native sidecar, or dependency that duplicates an existing workspace capability.
- Every behavior change follows RED-GREEN-REFACTOR and has a focused test observed failing for the intended reason.

## Execution Prerequisite

The current worktree has no installed frontend workspace dependencies. Before the first Vite+ test, run:

```bash
vp install --frozen-lockfile
```

This must not change `pnpm-lock.yaml`. If installation is unavailable, continue with Rust tasks and report the exact blocked TypeScript commands.

---

## File Structure

### Server ownership

- Create `apps/server/src/data_root.rs`: source-aware absolute data-root resolution, canonical requested/effective paths, and alias diagnostics.
- Create `apps/server/src/persistence/store.rs`: storage UUID marker, database/marker classification, and safe startup preparation.
- Create `apps/server/src/persistence/backup.rs`: verified online backups, manifests, retention, restore, and preserve-and-start-empty.
- Create `apps/server/src/maintenance.rs`: single-flight desktop update preparation and RPC admission closure.
- Create `apps/server/tests/project_data_safety.rs`, `persistence_backup.rs`, and `production_maintenance.rs`: black-box startup, descriptor, migration-backup, maintenance, and recovery coverage.
- Modify `apps/server/src/config.rs`: preserve data-root source and let lifecycle resolve it once.
- Modify `apps/server/src/persistence/database.rs`: separate existing/open-new flags, offline verification, WAL checkpoint, and exclusive maintenance work.
- Modify `apps/server/src/persistence/migrations.rs`: non-mutating pending-migration inspection.
- Modify `apps/server/src/persistence/state_files.rs`: storage marker and backup/recovery paths.
- Modify `apps/server/src/persistence/mod.rs` and `apps/server/src/lib.rs`: export the owned data-safety APIs.
- Modify `apps/server/src/lifecycle.rs` and `apps/server/src/http.rs`: prepare the store before runtime startup, publish storage identity, and expose authenticated desktop maintenance.
- Modify `apps/server/src/rpc/session.rs`: reject new RPC work after update maintenance closes admission.
- Modify `apps/server/src/production/runtime.rs`: idempotently drain provider, terminal, delivery, logging, and orchestration writers for update preparation.
- Modify `apps/server/src/main.rs` and CLI tests: support structured offline storage inspection, restore, and start-empty operations used for WSL recovery.

### Contracts and client runtime

- Modify `packages/contracts/src/environment.ts` and `environment.test.ts`: additive nullable `storageInstanceId` decoding.
- Modify `packages/contracts/src/ipc.ts` and `ipc.test.ts`: typed project-data status/recovery and updater-protection payloads.
- Create `packages/client-runtime/src/connection/storageIdentity.ts`: target keys, accepted identity comparison, mismatch error, and explicit adoption.
- Modify `packages/client-runtime/src/platform/persistence.ts`: accepted-storage and catalog-health service contracts.
- Modify `packages/client-runtime/src/platform/storageDocument.ts` and tests: additive accepted identities without losing v1 documents.
- Modify `packages/client-runtime/src/authorization/service.ts`, `connection/model.ts`, `connection/resolver.ts`, and tests: carry the environment descriptor through every prepared connection, including cached DPoP paths.
- Modify `packages/client-runtime/src/connection/driver.ts`, `supervisor.ts`, `registry.ts`, `connections.ts`, and focused tests: validate identity before session synchronization and expose retry/adopt commands.
- Modify `packages/client-runtime/src/state/shell.ts`, `projectEntities.ts`, and tests: explicit availability states with cached snapshot retention.

### Desktop and web

- Create `apps/desktop/src-tauri/src/data_safety.rs`: inspect native/WSL stores, call maintenance endpoints, restore/start empty, and return typed local diagnostics.
- Modify `apps/desktop/src-tauri/src/config.rs`: consume the server resolver rather than returning raw `BIBCODE_HOME`.
- Modify `apps/desktop/src-tauri/src/backend.rs`: typed WSL-primary failure, running-backend snapshots, and safe restart after failed installation.
- Modify `apps/desktop/src-tauri/src/updates.rs`: `protecting` state, primary fail-closed behavior, optional secondary confirmation, backend stop/restart, and platform install.
- Modify `apps/desktop/src-tauri/src/bridge.rs`, `lib.rs`, and `permissions/desktop-bridge.toml`: register data-safety and asynchronous install commands.
- Modify `apps/web/src/connection/storage.ts` and tests: persist accepted identities and quarantine-but-do-not-overwrite corrupt catalogs.
- Create `apps/web/src/state/projectDataSafety.ts`: desktop project-data status stream and recovery actions.
- Create `apps/web/src/components/sidebar/SidebarProjectAvailability.tsx` and tests: honest empty/loading/degraded/blocked presentation.
- Create `apps/web/src/components/desktop/ProjectDataRecoveryDialog.tsx` and tests: local diagnostics, restore, retry, start-empty, and path actions.
- Create `apps/web/src/components/desktop/UpdateProtectionDialog.tsx` and tests: per-environment backup progress, mandatory-primary failure, and explicit secondary exclusion.
- Modify `apps/web/src/components/Sidebar.logic.ts`, `Sidebar.tsx`, and tests: derive empty-state authority and wire retry/adoption.
- Modify `apps/web/src/components/desktopUpdate.logic.ts`, `sidebar/SidebarUpdatePill.tsx`, and tests: show data-protection progress and secondary warnings.
- Modify `apps/web/src/tauriDesktopBridge.ts` and tests: decode and invoke the new bridge contract.
- Modify `apps/web/src/components/settings/ConnectionsSettings.tsx` and tests: show WSL-primary failure without claiming Windows fallback.

### Release and living documentation

- Create `scripts/seeded-desktop-upgrade-smoke.ts` and tests: seed through the public HTTP API, drive the real updater, and verify identity/project/backup after restart.
- Create `.github/workflows/desktop-upgrade-smoke.yml`: previous-stable/candidate package matrix for Windows x64, macOS arm64/x64, and Linux x64.
- Modify `scripts/mock-update-server.ts` and tests only where the harness needs deterministic readiness and request logging.
- Modify `scripts/ci-platform-contract.test.ts` and `scripts/workflow-dependencies.test.ts`: pin and validate the new matrix.
- Modify `docs/architecture/overview.md`, `docs/architecture/connection-runtime.md`, `docs/architecture/remote.md`, and `docs/operations/release.md`.
- Create `docs/guides/project-data-recovery.md` and link it from `docs/README.md`.

---

### Task 1: Resolve One Absolute Effective Data Root

**Files:**
- Create: `apps/server/src/data_root.rs`
- Modify: `apps/server/src/config.rs:30-305`
- Modify: `apps/server/src/lifecycle.rs:90-130`
- Modify: `apps/server/src/lib.rs:1-45`
- Modify: `apps/desktop/src-tauri/src/config.rs:110-145`
- Modify: `apps/desktop/src-tauri/src/backend.rs:1173-1188`

**Interfaces:**
- Consumes: the default home directory, raw `BIBCODE_HOME`, explicit CLI `--base-dir`, or desktop bootstrap path.
- Produces: `DataRootSource`, `DataRootRequest`, `ResolvedDataRoot`, `DataRootError`, and `resolve_data_root(DataRootRequest) -> Result<ResolvedDataRoot, DataRootError>` for every later server/desktop task.

- [ ] **Step 1: Write failing resolver tests**

Add tests in `data_root.rs` covering default roots, `~`, relative rejection, missing final components, and aliases. The platform-specific alias tests must use `std::os::unix::fs::symlink` on Unix and the existing `junction` crate on Windows.

```rust
#[test]
fn rejects_relative_explicit_roots() {
    let error = resolve_data_root(DataRootRequest {
        source: DataRootSource::Environment,
        requested: Some(PathBuf::from("relative/.bibcode")),
        home_dir: PathBuf::from("/home/alice"),
    })
    .expect_err("relative environment root must fail");
    assert!(matches!(error, DataRootError::RelativeExplicit { .. }));
}

#[cfg(unix)]
#[test]
fn reports_symlink_requested_and_effective_roots() {
    let temp = tempfile::tempdir().expect("temp root");
    let target = temp.path().join("target");
    std::fs::create_dir(&target).expect("target");
    let alias = temp.path().join("alias");
    std::os::unix::fs::symlink(&target, &alias).expect("symlink");
    let resolved = resolve_data_root(DataRootRequest {
        source: DataRootSource::Cli,
        requested: Some(alias.clone()),
        home_dir: temp.path().to_path_buf(),
    })
    .expect("resolve alias");
    assert_eq!(resolved.requested, alias);
    assert_eq!(resolved.effective, target.canonicalize().expect("canonical target"));
    assert!(resolved.is_filesystem_alias);
}
```

- [ ] **Step 2: Run the resolver tests and verify RED**

```bash
cargo test -p bibcode-server --lib data_root::tests -- --nocapture
```

Expected: compilation fails because `data_root` and its types do not exist.

- [ ] **Step 3: Implement the resolver and diagnostics model**

Use these exact public types and keep filesystem-path logic out of desktop code:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataRootSource { Default, Environment, Cli }

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataRootRequest {
    pub source: DataRootSource,
    pub requested: Option<PathBuf>,
    pub home_dir: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDataRoot {
    pub source: DataRootSource,
    pub requested: PathBuf,
    pub effective: PathBuf,
    pub is_filesystem_alias: bool,
}

#[derive(Debug, Error)]
pub enum DataRootError {
    #[error("{source:?} data root must be absolute: {path}")]
    RelativeExplicit { source: DataRootSource, path: PathBuf },
    #[error("the current user's home directory is unavailable")]
    HomeDirectoryUnavailable,
    #[error("failed to resolve data root {path}")]
    Canonicalize { path: PathBuf, #[source] source: std::io::Error },
}
```

Expand only a leading `~`, reject explicit relative values, lexically normalize components, canonicalize the nearest existing ancestor, append non-existing leaves, and set `is_filesystem_alias` when normalized requested and effective paths differ.

- [ ] **Step 4: Preserve source selection in CLI configuration**

Remove Clap's direct `env = "BIBCODE_HOME"` binding so `Cli::into_server_config` can distinguish the CLI flag, environment variable, and default. Store the raw request and source on `ServerConfig`; resolve it at the top of `ServerRuntime::start_internal`, replace `config.base_dir` with the effective root, and retain `ResolvedDataRoot` for local diagnostics.

```rust
let request = match (args.base_dir, bibcode_env_var("BIBCODE_HOME")) {
    (Some(path), _) => DataRootRequest::explicit(DataRootSource::Cli, path, home_dir?),
    (None, Some(path)) => DataRootRequest::explicit(
        DataRootSource::Environment,
        PathBuf::from(path),
        home_dir?,
    ),
    (None, None) => DataRootRequest::default(home_dir?),
};
```

Keep `ServerConfig::new` for programmatic construction, but validate its root in lifecycle before filesystem creation. Existing unit tests that never start a server may keep relative fixtures; runtime-start tests must use absolute `TempDir` paths.

- [ ] **Step 5: Make desktop use the server resolver**

Change desktop `base_dir` to call the exported resolver with the Tauri-resolved home. Pass `resolved.effective` into `BackendLaunchTarget::InProcess`; preserve requested/effective values for Task 11 diagnostics. WSL continues resolving inside the Linux server process using its WSL home.

- [ ] **Step 6: Run focused cross-platform checks**

```bash
cargo test -p bibcode-server --lib data_root::tests -- --nocapture
cargo test -p bibcode-server --lib config::tests -- --nocapture
cargo test -p bibcode-desktop-tauri config::tests -- --nocapture
cargo test -p bibcode-desktop-tauri backend::tests::server_config_for_launch_uses_desktop_runtime_settings -- --nocapture
cargo fmt --all --check
```

Expected: all selected tests pass; on Windows the junction test runs, and on Unix the symlink test runs.

- [ ] **Step 7: Commit the root policy**

```bash
git add apps/server/src/data_root.rs apps/server/src/config.rs apps/server/src/lifecycle.rs apps/server/src/lib.rs apps/desktop/src-tauri/src/config.rs apps/desktop/src-tauri/src/backend.rs
git commit -m "fix(storage): resolve one absolute data root"
```

---

### Task 2: Classify the Persistent Store Before Opening SQLite

**Files:**
- Create: `apps/server/src/persistence/store.rs`
- Create: `apps/server/tests/project_data_safety.rs`
- Modify: `apps/server/src/persistence/database.rs:300-510`
- Modify: `apps/server/src/persistence/migrations.rs`
- Modify: `apps/server/src/persistence/state_files.rs:14-85`
- Modify: `apps/server/src/persistence/mod.rs`
- Modify: `apps/server/src/lifecycle.rs:98-125`

**Interfaces:**
- Consumes: `ResolvedDataRoot`, `StatePaths`, and a database/marker filesystem state.
- Produces: `StorageInstanceId`, `StoreClassification`, `PreparedStore`, `StoreStartupError`, `prepare_store`, `Database::open_existing`, and `Database::create_new` for descriptors, backups, and recovery.

- [ ] **Step 1: Write the failing startup matrix**

Add table-driven integration tests for every database/marker combination. The known-missing case must prove no SQLite file is created.

```rust
#[tokio::test]
async fn marker_without_database_never_creates_replacement_sqlite() {
    let fixture = StoreFixture::new();
    fixture.write_marker(Uuid::new_v4());
    let error = fixture.prepare().await.expect_err("missing database must block");
    assert!(matches!(error, StoreStartupError::DatabaseMissing { .. }));
    assert!(!fixture.paths.database.exists());
    assert!(fixture.paths.environment_id.exists());
}

#[tokio::test]
async fn existing_unmarked_database_is_adopted_without_catalog_changes() {
    let fixture = StoreFixture::with_project("Protected project").await;
    std::fs::remove_file(&fixture.paths.environment_id).ok();
    let prepared = fixture.prepare().await.expect("adopt existing database");
    assert_eq!(prepared.classification, StoreClassification::ExistingUnmarked);
    assert_eq!(fixture.project_titles().await, ["Protected project"]);
    assert!(fixture.paths.environment_id.is_file());
}
```

- [ ] **Step 2: Run matrix tests and verify RED**

```bash
cargo test -p bibcode-server --test project_data_safety marker_without_database -- --nocapture
cargo test -p bibcode-server --test project_data_safety existing_unmarked_database -- --nocapture
```

Expected: compilation fails because the store preparation API does not exist.

- [ ] **Step 3: Split database open modes**

Replace generic file-backed `Database::open` with explicit methods:

```rust
pub async fn open_existing(path: impl AsRef<Path>) -> Result<Self>;
pub async fn create_new(path: impl AsRef<Path>) -> Result<Self>;
pub async fn open_in_memory() -> Result<Self>;
```

`open_existing` uses `SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_NO_MUTEX` and never creates a parent or database. `create_new` first uses `OpenOptions::create_new` to reserve the database path, then opens it with `SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_NO_MUTEX`; if SQLite initialization fails, remove only the zero-length file created by that call. Keep current timeout, foreign-key, `synchronous=FULL`, WAL, auto-checkpoint, and journal-size settings.

Add a non-mutating `validate_existing_bibcode_store` check: `PRAGMA quick_check` must return `ok`; `effect_sql_migrations` must already exist; its ordered `(migration_id, name)` rows must be an exact prefix of this binary's `MIGRATIONS`; and the core tables implied by the latest recorded migration must exist. Unknown IDs, renamed rows, an empty/missing ledger, or an unrelated valid SQLite schema returns `StoreStartupError::UnrecognizedStore` without writing a marker. This is the boundary that prevents a current root accidentally aimed at unrelated/T4Code SQLite leftovers from being adopted as BiBCode data.

- [ ] **Step 4: Implement marker and classification types**

Use the existing `StatePaths.environment_id` path as the single marker:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct StorageInstanceId(Uuid);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreClassification { FirstRun, ExistingUnmarked, Existing }

pub struct PreparedStore {
    pub database: Database,
    pub storage_instance_id: StorageInstanceId,
    pub classification: StoreClassification,
    pub paths: StatePaths,
}

pub async fn prepare_store(config: &ServerConfig) -> Result<PreparedStore, StoreStartupError>;
```

Implement the approved state table exactly. Decode marker bytes as one trimmed UUID. Publish a new marker with a flushed same-directory temporary file and a no-replace operation; serialize the process with a state-directory lock where the platform lacks atomic no-replace rename. Never replace malformed bytes. An existing unmarked database reaches `ExistingUnmarked` only after `validate_existing_bibcode_store` succeeds.

- [ ] **Step 5: Reorder lifecycle startup**

Call `StatePaths::ensure_directories_without_database_side_effects`, initialize logging, then `prepare_store`. Do not create `state.sqlite`, WAL, or SHM before classification. Move lifecycle's `run_migrations` into `prepare_store`; first-run runs migrations then publishes its marker, while existing-unmarked validates SQLite, publishes the marker, then migrates.

- [ ] **Step 6: Cover corruption and publish races**

Add focused tests proving an invalid SQLite file, an unrelated but valid SQLite database, an unknown/mismatched migration ledger, and a malformed marker remain byte-for-byte unchanged without publishing an ID; concurrent adoption of a recognized BiBCode database returns one shared ID.

```rust
assert_eq!(std::fs::read(&paths.database).unwrap(), original_database_bytes);
assert_eq!(std::fs::read(&paths.environment_id).unwrap(), malformed_marker_bytes);
assert_eq!(first.storage_instance_id, second.storage_instance_id);
```

- [ ] **Step 7: Run focused persistence checks**

```bash
cargo test -p bibcode-server --lib persistence::database::tests -- --nocapture
cargo test -p bibcode-server --lib persistence::store::tests -- --nocapture
cargo test -p bibcode-server --test project_data_safety -- --nocapture
cargo fmt --all --check
```

Expected: all cases pass, including the existing corrupt-database preservation test.

- [ ] **Step 8: Commit safe store startup**

```bash
git add apps/server/src/persistence apps/server/src/lifecycle.rs apps/server/tests/project_data_safety.rs
git commit -m "fix(storage): refuse silent database replacement"
```

---

### Task 3: Publish Storage Identity with Version-Skew Compatibility

**Files:**
- Modify: `packages/contracts/src/environment.ts:1-40`
- Modify: `packages/contracts/src/environment.test.ts`
- Modify: `apps/server/src/config.rs`
- Modify: `apps/server/src/http.rs:219-252`
- Modify: `apps/server/src/lifecycle.rs:100-250`
- Modify: `apps/server/tests/project_data_safety.rs`
- Modify: `packages/client-runtime/src/environment/knownEnvironment.ts`
- Modify: `packages/client-runtime/src/environment/knownEnvironment.test.ts`

**Interfaces:**
- Consumes: `PreparedStore.storage_instance_id` from Task 2.
- Produces: `ExecutionEnvironmentDescriptor.storageInstanceId: string | null`; new local servers emit UUID strings and old remote descriptors decode to `null`.

- [ ] **Step 1: Write failing contract compatibility tests**

```ts
it("defaults storage identity to null for an older remote descriptor", () => {
  const decoded = decodeExecutionEnvironmentDescriptor(Object.assign({}, descriptor, {
    capabilities: { repositoryIdentity: true },
  }));
  expect(decoded.storageInstanceId).toBeNull();
});

it("decodes a new server storage identity", () => {
  const decoded = decodeExecutionEnvironmentDescriptor(Object.assign({}, descriptor, {
    storageInstanceId: "0d93cbea-f237-4f37-8829-d816667be35f",
    capabilities: { repositoryIdentity: true },
  }));
  expect(decoded.storageInstanceId).toBe("0d93cbea-f237-4f37-8829-d816667be35f");
});
```

- [ ] **Step 2: Run the contract test and verify RED**

```bash
vp test packages/contracts/src/environment.test.ts
```

Expected: both assertions fail because the field is absent.

- [ ] **Step 3: Add the additive schema field**

Use a non-empty string decoder with a null default; UUID validity remains a server invariant so older third-party servers do not break decoding.

```ts
storageInstanceId: Schema.NullOr(TrimmedNonEmptyString).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
),
```

Extend `KnownEnvironment` and `attachEnvironmentDescriptor` to retain `storageInstanceId` and the complete descriptor rather than discarding it.

- [ ] **Step 4: Populate both server descriptors**

After `prepare_store`, set the runtime-only storage ID on `ServerConfig`. Add `storage_instance_id` to the Axum `EnvironmentDescriptor` and the Connect MCP descriptor JSON. Serialize it as `storageInstanceId`; do not serialize `ResolvedDataRoot` or any filesystem path.

- [ ] **Step 5: Prove restart stability and remote privacy**

Extend `project_data_safety.rs` to start the same store twice, fetch `/.well-known/bibcode/environment`, and assert equal UUIDs. Assert the JSON string contains neither the requested nor effective root.

- [ ] **Step 6: Run focused contract/server tests**

```bash
vp test packages/contracts/src/environment.test.ts packages/client-runtime/src/environment/knownEnvironment.test.ts
cargo test -p bibcode-server --test project_data_safety descriptor -- --nocapture
cargo fmt --all --check
```

Expected: old descriptors decode to `null`, new local descriptors remain stable across restart, and no path leaks.

- [ ] **Step 7: Commit descriptor identity**

```bash
git add packages/contracts/src/environment.ts packages/contracts/src/environment.test.ts packages/client-runtime/src/environment/knownEnvironment.ts packages/client-runtime/src/environment/knownEnvironment.test.ts apps/server/src/config.rs apps/server/src/http.rs apps/server/src/lifecycle.rs apps/server/tests/project_data_safety.rs
git commit -m "feat(storage): publish persistent store identity"
```

---

### Task 4: Persist and Compare Accepted Client Storage Identity

**Files:**
- Create: `packages/client-runtime/src/connection/storageIdentity.ts`
- Create: `packages/client-runtime/src/connection/storageIdentity.test.ts`
- Modify: `packages/client-runtime/src/connection/index.ts`
- Modify: `packages/client-runtime/src/platform/persistence.ts`
- Modify: `packages/client-runtime/src/platform/storageDocument.ts`
- Modify: `packages/client-runtime/src/platform/storageDocument.test.ts`
- Modify: `apps/web/src/connection/storage.ts`
- Modify: `apps/web/src/connection/storage.test.ts`
- Modify: `packages/client-runtime/src/authorization/service.ts`
- Modify: `packages/client-runtime/src/connection/model.ts`
- Modify: `packages/client-runtime/src/connection/resolver.ts`
- Modify: `packages/client-runtime/src/connection/resolver.test.ts`

**Interfaces:**
- Consumes: `ExecutionEnvironmentDescriptor.storageInstanceId` from Task 3 and stable connection targets.
- Produces: `storageIdentityTargetKey`, `AcceptedStorageIdentityStore`, `StorageIdentityDecision`, and `PreparedConnection.descriptor` for Task 5 supervision.

- [ ] **Step 1: Write failing target-key and decision tests**

Create `storageIdentity.test.ts` first:

```ts
expect(storageIdentityTargetKey(primary)).toBe("platform:primary");
expect(storageIdentityTargetKey(bearer)).toBe(`bearer:${bearer.connectionId}`);
expect(decideStorageIdentity(null, "store-a")).toEqual({ _tag: "Bootstrap", reported: "store-a" });
expect(decideStorageIdentity("store-a", "store-a")).toEqual({ _tag: "Accepted", value: "store-a" });
expect(decideStorageIdentity("store-a", "store-b")).toEqual({
  _tag: "Changed", accepted: "store-a", reported: "store-b",
});
expect(decideStorageIdentity("store-a", null)).toEqual({ _tag: "Unverifiable", accepted: "store-a" });
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
vp test packages/client-runtime/src/connection/storageIdentity.test.ts packages/client-runtime/src/platform/storageDocument.test.ts
```

Expected: compilation fails because the identity model and document field do not exist.

- [ ] **Step 3: Define accepted identity persistence**

Use these exact interfaces:

```ts
export interface AcceptedStorageIdentity {
  readonly targetKey: string;
  readonly storageInstanceId: string;
}

export class AcceptedStorageIdentityStore extends Context.Service<AcceptedStorageIdentityStore, {
  readonly get: (targetKey: string) => Effect.Effect<Option.Option<string>, ConnectionPersistenceError>;
  readonly accept: (identity: AcceptedStorageIdentity) => Effect.Effect<void, ConnectionPersistenceError>;
}>()("@bibcode/client-runtime/platform/persistence/AcceptedStorageIdentityStore") {}
```

Add `acceptedStorageIdentities` to `ConnectionCatalogDocument` with `Schema.withDecodingDefault(Effect.succeed([]))` while retaining `schemaVersion: 1`. Update `EMPTY_CONNECTION_CATALOG_DOCUMENT`, replacement helpers, web IndexedDB/desktop-backed catalog services, and operation-specific errors `load-storage-identity` and `accept-storage-identity`.

- [ ] **Step 4: Carry descriptors through every prepared connection**

Add `readonly descriptor: ExecutionEnvironmentDescriptor` to `PreparedConnection`. Make primary-without-bearer fetch the public descriptor. Make `authorizeBearer` and both cached/fresh DPoP branches return the descriptor and re-fetch it on every connection attempt; never trust only the cached token's label/environment.

```ts
export interface PreparedConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly target: ConnectionTarget;
}
```

- [ ] **Step 5: Prove additive storage and DPoP refresh behavior**

Add tests that decode a v1 document without accepted identities, persist one identity without changing targets/credentials/tokens, and verify the cached-DPoP path fetches the current descriptor before returning `PreparedConnection`.

- [ ] **Step 6: Run focused client/web tests**

```bash
vp test packages/client-runtime/src/connection/storageIdentity.test.ts packages/client-runtime/src/platform/storageDocument.test.ts packages/client-runtime/src/connection/resolver.test.ts packages/client-runtime/src/authorization/remote.test.ts apps/web/src/connection/storage.test.ts
vp run typecheck --filter=@bibcode/contracts --filter=@bibcode/client-runtime --filter=@bibcode/web
```

Expected: all selected tests pass and old documents retain all existing values.

- [ ] **Step 7: Commit accepted identity persistence**

```bash
git add packages/client-runtime/src/connection packages/client-runtime/src/platform packages/client-runtime/src/authorization/service.ts apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts
git commit -m "feat(client): persist accepted store identities"
```

---

### Task 5: Block a Changed Store Before Synchronization

**Files:**
- Modify: `packages/client-runtime/src/connection/storageIdentity.ts`
- Modify: `packages/client-runtime/src/connection/model.ts`
- Modify: `packages/client-runtime/src/connection/driver.ts`
- Modify: `packages/client-runtime/src/connection/supervisor.ts`
- Modify: `packages/client-runtime/src/connection/supervisor.test.ts`
- Modify: `packages/client-runtime/src/connection/registry.ts`
- Modify: `packages/client-runtime/src/connection/registry.test.ts`
- Modify: `packages/client-runtime/src/state/connections.ts`

**Interfaces:**
- Consumes: `PreparedConnection.descriptor`, `storageIdentityTargetKey`, and `AcceptedStorageIdentityStore` from Task 4.
- Produces: `ConnectionStorageChangedError`, `verifyPreparedStorageIdentity`, and registry/atom command `acceptStorageIdentity(environmentId)` for Task 6 UI.

- [ ] **Step 1: Write failing supervisor tests**

Add tests that count `RpcSessionFactory.connect` calls. A mismatch must fail before the count increments, while first-seen and matching IDs connect.

```ts
it.effect("blocks a changed store before opening or synchronizing the RPC session", () =>
  Effect.gen(function* () {
    const fixture = yield* supervisorFixture({
      acceptedStorageInstanceId: "store-a",
      reportedStorageInstanceId: "store-b",
    });
    yield* fixture.supervisor.connect;
    const state = yield* SubscriptionRef.get(fixture.supervisor.state);
    expect(state.phase).toBe("blocked");
    expect(state.lastFailure).toMatchObject({
      _tag: "ConnectionStorageChangedError",
      acceptedStorageInstanceId: "store-a",
      reportedStorageInstanceId: "store-b",
    });
    expect(fixture.sessionConnectCount()).toBe(0);
  }));
```

Also prove that a `null` older-server identity does not erase `store-a`, and that explicit adoption followed by retry opens exactly one session.

- [ ] **Step 2: Run the supervisor tests and verify RED**

```bash
vp test packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/connection/registry.test.ts
```

Expected: the mismatch currently reaches session synchronization and the new error/command are missing.

- [ ] **Step 3: Add a structured blocked error**

```ts
export class ConnectionStorageChangedError extends Schema.TaggedErrorClass<ConnectionStorageChangedError>()(
  "ConnectionStorageChangedError",
  {
    reason: Schema.Literal("storage-changed"),
    detail: Schema.String,
    targetKey: Schema.String,
    acceptedStorageInstanceId: Schema.String,
    reportedStorageInstanceId: Schema.String,
  },
) {}
```

Add it to `ConnectionAttemptError` and `ConnectionBlockedReason`. Keep the IDs structured rather than parsing them from `detail`.

- [ ] **Step 4: Verify identity inside `ConnectionDriver.connect`**

After resolver preparation and before `sessions.connect`, call:

```ts
yield* verifyPreparedStorageIdentity(prepared).pipe(
  Effect.provideService(AcceptedStorageIdentityStore, identities),
);
```

The verifier applies the Task 4 decision table: persist Bootstrap, allow Accepted, allow Unverifiable without erasing the accepted value, and fail Changed. `reportProgress({ stage: "opening", prepared })` runs only after verification so an unaccepted store cannot be published as an opening/live lease.

- [ ] **Step 5: Add explicit adoption and retry**

Add this registry service method and atom command:

```ts
readonly acceptStorageIdentity: (
  environmentId: EnvironmentId,
) => Effect.Effect<void, EnvironmentNotRegisteredError | ConnectionPersistenceError>;
```

It reads the supervisor's current `ConnectionStorageChangedError`, persists exactly its `targetKey` and reported ID, then signals `retryNow`. It fails if the environment is not currently blocked by a storage change. It never clears caches or mutates either server database.

- [ ] **Step 6: Run focused connection tests**

```bash
vp test packages/client-runtime/src/connection/storageIdentity.test.ts packages/client-runtime/src/connection/supervisor.test.ts packages/client-runtime/src/connection/registry.test.ts packages/client-runtime/src/state/connections.test.ts
vp run typecheck --filter=@bibcode/client-runtime
```

Expected: mismatch never opens a session; adoption persists and retries; older remotes remain usable without clearing the baseline.

- [ ] **Step 7: Commit store-switch blocking**

```bash
git add packages/client-runtime/src/connection packages/client-runtime/src/state/connections.ts packages/client-runtime/src/state/connections.test.ts
git commit -m "fix(client): block silent persistent store changes"
```

---

### Task 6: Render Authoritative Project Availability Instead of False Empty State

**Files:**
- Modify: `packages/client-runtime/src/state/shell.ts`
- Modify: `packages/client-runtime/src/state/shell-sync.test.ts`
- Modify: `packages/client-runtime/src/state/shell.test.ts`
- Modify: `packages/client-runtime/src/state/projectEntities.ts`
- Create: `apps/web/src/components/sidebar/SidebarProjectAvailability.tsx`
- Create: `apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx`
- Modify: `apps/web/src/state/shell.ts`
- Modify: `apps/web/src/components/Sidebar.logic.ts`
- Modify: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx:3401-3668,3920-4330`
- Modify: `apps/web/src/components/Sidebar.test.tsx:1147-1230`

**Interfaces:**
- Consumes: environment catalog readiness, supervisor phase/failure, cached shell snapshots, and Task 5 adoption/retry commands.
- Produces: `EnvironmentAvailabilityStatus`, `EnvironmentShellSummary.canShowEmptyProjects`, `resolveSidebarProjectAvailability`, and `SidebarProjectAvailability`.

- [ ] **Step 1: Write the false-empty regression table**

Add pure cases to `Sidebar.logic.test.ts`:

```ts
it.each([
  ["catalog-loading", false, []],
  ["starting", true, [environment("starting")]],
  ["synchronizing", true, [environment("synchronizing")]],
  ["degraded", true, [environment("degraded")]],
  ["storage-changed", true, [environment("storage-changed")]],
  ["recovery-required", true, [environment("recovery-required")]],
  ["unavailable", true, [environment("unavailable")]],
  ["configuration-error", true, [environment("configuration-error")]],
] as const)("does not claim empty projects for %s", (_name, catalogReady, environments) => {
  expect(resolveSidebarProjectAvailability({ projectCount: 0, catalogReady, environments }).kind)
    .not.toBe("empty-confirmed");
});

it("confirms empty only when every desired environment is live and authoritative", () => {
  expect(resolveSidebarProjectAvailability({
    projectCount: 0,
    catalogReady: true,
    environments: [environment("live", { hasSnapshot: true })],
  })).toEqual({ kind: "empty-confirmed" });
});
```

- [ ] **Step 2: Run shell/sidebar tests and verify RED**

```bash
vp test packages/client-runtime/src/state/shell-sync.test.ts packages/client-runtime/src/state/shell.test.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.test.tsx
```

Expected: current `empty` shell state and `projectsLength === 0` render `No projects yet` for non-authoritative cases.

- [ ] **Step 3: Replace ambiguous shell status**

Use this closed status model:

```ts
export type EnvironmentAvailabilityStatus =
  | "starting"
  | "synchronizing"
  | "live"
  | "degraded"
  | "storage-changed"
  | "recovery-required"
  | "unavailable"
  | "configuration-error";
```

Initialize as `starting`; keep cached snapshots through reconnects. Map transient disconnect with cache to `degraded`, storage mismatch to `storage-changed`, typed store startup failure to `recovery-required`, other blocked configuration to `configuration-error`, and unreachable/no-cache to `unavailable`. A successful shell snapshot, including a zero-project snapshot, is the only transition to `live`.

- [ ] **Step 4: Derive global authority without discarding cached projects**

Extend `EnvironmentShellSummary` with `catalogReady`, `desiredEnvironmentCount`, `statuses`, and `canShowEmptyProjects`. Do not make `projectEntities` synthesize an authoritative empty list from a missing snapshot; it may return no entities for rendering, but the summary retains why.

- [ ] **Step 5: Render the focused availability component**

`SidebarProjectAvailability` receives the pure view plus `onRetry`, `onOpenSettings`, `onViewDiagnostics`, and `onAdoptStorage`. It renders:

- `No projects yet` only for `empty-confirmed`;
- cached/degraded copy without removing cached rows;
- `Project data is still loading`, `Projects are unavailable`, `Project data location changed`, or `Project data needs recovery` for the other states;
- explicit buttons for retry/settings/diagnostics/adoption.

Keep the component outside the existing large `Sidebar.tsx`; pass the derived view through `SidebarProjectsContentProps`.

- [ ] **Step 6: Prove cached-to-live-empty replacement ordering**

In `shell-sync.test.ts`, seed a cached non-empty snapshot, drive a mismatch, and assert the cache remains. After adoption and a live empty snapshot, assert the state becomes `live` and only then removes the cached project rows.

- [ ] **Step 7: Run focused UI/state tests**

```bash
vp test packages/client-runtime/src/state/shell-sync.test.ts packages/client-runtime/src/state/shell.test.ts packages/client-runtime/src/state/entities.test.ts apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.test.tsx
vp run typecheck --filter=@bibcode/client-runtime --filter=@bibcode/web
```

Expected: every non-authoritative zero-project case shows a state/action instead of the empty claim.

- [ ] **Step 8: Commit honest project availability**

```bash
git add packages/client-runtime/src/state apps/web/src/state/shell.ts apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/sidebar/SidebarProjectAvailability.tsx apps/web/src/components/sidebar/SidebarProjectAvailability.test.tsx
git commit -m "fix(web): distinguish unavailable projects from empty"
```

---

### Task 7: Fail Closed for Corrupt Connection Catalog and WSL-Only Startup

**Files:**
- Modify: `packages/client-runtime/src/platform/persistence.ts`
- Modify: `apps/web/src/connection/storage.ts:250-320`
- Modify: `apps/web/src/connection/storage.test.ts`
- Modify: `apps/web/src/state/shell.ts`
- Modify: `apps/desktop/src-tauri/src/backend.rs:1808-1868`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `packages/contracts/src/ipc.ts:482-525`
- Modify: `apps/web/src/state/desktopWslState.ts`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.tsx:2880-3140`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.test.tsx`

**Interfaces:**
- Consumes: Task 6 `configuration-error`/`unavailable` presentation.
- Produces: `ConnectionCatalogHealthStore`, `WslPrimaryUnavailable`, and truthful `DesktopWslState.preflightError` while keeping explicit Switch to Windows.

- [ ] **Step 1: Write failing catalog and WSL tests**

```ts
it.effect("quarantines a corrupt catalog without overwriting it with empty state", () =>
  Effect.gen(function* () {
    const backend = recordingCatalogBackend("{malformed");
    const store = yield* makeCatalogStore(backend);
    expect((yield* store.health).status).toBe("recovery-required");
    expect(backend.writes).toEqual([]);
    expect(backend.quarantined).toEqual(["{malformed"]);
  }));
```

Add a Rust unit test that injects WSL primary planning failure and asserts `default_launch_plans` returns `BackendPlanError::WslPrimaryUnavailable` with no Windows `BackendLaunchPlan`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
vp test apps/web/src/connection/storage.test.ts apps/web/src/components/settings/ConnectionsSettings.test.tsx
cargo test -p bibcode-desktop-tauri backend::tests::wsl_only_planning_failure -- --nocapture
```

Expected: catalog recovery writes an empty document and WSL-only planning returns the Windows plan.

- [ ] **Step 3: Add catalog health as an explicit service**

```ts
export type ConnectionCatalogHealth =
  | { readonly status: "ready" }
  | { readonly status: "recovery-required"; readonly message: string };

export class ConnectionCatalogHealthStore extends Context.Service<ConnectionCatalogHealthStore, {
  readonly state: SubscriptionRef.SubscriptionRef<ConnectionCatalogHealth>;
  readonly reset: Effect.Effect<void, ConnectionPersistenceError>;
}>()("@bibcode/client-runtime/platform/persistence/ConnectionCatalogHealthStore") {}
```

On decode failure, quarantine the original when available, set recovery-required, retain an in-memory empty document only to keep the UI operational, and reject catalog updates until `reset` explicitly persists `EMPTY_CONNECTION_CATALOG_DOCUMENT`. Feed health into Task 6 summary so this state can never produce `empty-confirmed`.

- [ ] **Step 4: Replace WSL fallback with a typed plan error**

Define:

```rust
#[derive(Debug, Error)]
enum BackendPlanError {
    #[error("WSL primary is unavailable: {detail}")]
    WslPrimaryUnavailable { detail: String },
    #[error("desktop backend planning failed: {detail}")]
    Other { detail: String },
}
```

When `wsl_backend_enabled && wsl_only`, return the WSL plan or this error. Record it in the primary slot and `DesktopWslState.preflightError`; do not emit a native primary bootstrap. Secondary WSL behavior remains non-blocking and keeps its cached projects.

- [ ] **Step 5: Correct WSL recovery copy**

Change Connections settings to say WSL is unavailable and no backend was substituted. Keep Retry, distro selection, diagnostics, and explicit Switch to Windows. Switching updates `wslOnly`/enabled settings and restarts normally; Task 5 then detects/adopts any native Windows store change.

- [ ] **Step 6: Run focused recovery tests**

```bash
cargo test -p bibcode-desktop-tauri backend::tests -- --nocapture
cargo test -p bibcode-desktop-tauri bridge::tests -- --nocapture
vp test apps/web/src/connection/storage.test.ts apps/web/src/state/desktopWslState.test.ts apps/web/src/components/settings/ConnectionsSettings.test.tsx apps/web/src/components/Sidebar.test.tsx
vp run typecheck --filter=@bibcode/client-runtime --filter=@bibcode/web
```

Expected: neither corruption nor WSL failure renders an empty catalog, and Windows starts only after explicit switching.

- [ ] **Step 7: Commit fail-closed catalog and WSL behavior**

```bash
git add packages/client-runtime/src/platform/persistence.ts apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts apps/web/src/state apps/web/src/components/settings apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/bridge.rs packages/contracts/src/ipc.ts
git commit -m "fix(desktop): stop silent catalog and WSL fallback"
```

---

### Task 8: Create Verified Backups Before Persistent-Store Mutation

**Files:**
- Create: `apps/server/src/persistence/backup.rs`
- Create: `apps/server/tests/persistence_backup.rs`
- Modify: `apps/server/src/persistence/mod.rs`
- Modify: `apps/server/src/persistence/database.rs`
- Modify: `apps/server/src/persistence/migrations.rs`
- Modify: `apps/server/src/persistence/state_files.rs`
- Modify: `apps/server/src/lifecycle.rs`

**Dependencies:**
- Consumes: Task 1 absolute `ResolvedDataRoot` and Task 2 `PreparedStore`/`StorageInstanceId`.
- Produces: reusable backup inventory and verification primitives for update protection and recovery.

- [ ] **Step 1: Write failing backup and migration-gate tests**

Cover these public behaviors in `persistence_backup.rs`:

```rust
#[tokio::test]
async fn creates_verified_pre_migration_backup_before_first_pending_migration() {
    let fixture = PersistedStoreFixture::older_schema_with_project("project-a").await;
    fixture.start_server().await.expect("migration should succeed");
    let backup = fixture.only_backup(BackupTrigger::PreMigration).await;
    assert_eq!(backup.project_ids().await, ["project-a"]);
    assert!(backup.manifest_matches_file().await);
    assert_eq!(backup.quick_check().await, "ok");
    assert!(fixture.schema_version().await > backup.manifest.schema_version);
}

#[tokio::test]
async fn refuses_migration_when_backup_verification_fails() {
    let fixture = PersistedStoreFixture::older_schema_with_project("project-a").await;
    fixture.block_backup_directory_with_file().await;
    let before = fixture.database_bytes().await;
    let error = fixture.start_server().await.expect_err("backup must fail");
    assert!(matches!(error, RunError::Backup(_)));
    assert_eq!(fixture.database_bytes().await, before);
}

#[tokio::test]
async fn retains_the_three_newest_verified_backups_per_store_and_kind() {
    let fixture = PersistedStoreFixture::current_schema_with_project("project-a").await;
    for sequence in 1..=4 {
        fixture.create_backup_at(sequence).await.expect("backup should verify");
    }
    assert_eq!(fixture.backup_sequences().await, [2, 3, 4]);
}
```

Define `PersistedStoreFixture` inside the integration test with deterministic absolute temporary roots and a monotonic test clock. Also test that a new empty store with no pending migrations creates no backup, and that a source database with active WAL data is captured consistently.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cargo test -p bibcode-server --test persistence_backup -- --nocapture
```

Expected: the backup module and non-mutating migration inspection API do not exist.

- [ ] **Step 3: Define the backup contract and filesystem layout**

Use typed values rather than passing path fragments:

```rust
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupTrigger {
    PreMigration,
    PreUpdate,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub backup_id: Uuid,
    pub storage_instance_id: StorageInstanceId,
    pub created_at: String,
    pub state_kind: StateKind,
    pub trigger: BackupTrigger,
    pub app_version: String,
    pub schema_version: i64,
    pub database_size_bytes: u64,
    pub sha256: String,
}

pub async fn create_verified_backup(
    database: &Database,
    prepared: &PreparedStore,
    trigger: BackupTrigger,
    app_version: &str,
) -> Result<VerifiedBackup, BackupError>;

pub struct StoreOperationGuard {
    lock_file: std::fs::File,
}

impl StoreOperationGuard {
    pub fn acquire(effective_root: &Path) -> Result<Self, BackupError>;
}
```

Define `StateKind::{Userdata, Dev}` from the same state-directory selection already owned by `StatePaths`; serialize `created_at` as UTC RFC 3339 with the workspace `time` crate. `StoreOperationGuard` opens `<effective-base-root>/.bibcode-storage.lock` and uses the Rust 1.97 `std::fs::File::lock` API on a blocking persistence worker; Drop unlocks it. Hold this cross-process lock across startup classification/migration, update backup/checkpoint, restore, and start-empty so native, CLI, and WSL calls share the same serialization rule.

Write each backup under `<effective-base-root>/backups/<state-kind>/<storage-instance-id>/<backup-id>/`. Stage both `state.sqlite` and `manifest.json` in a sibling temporary directory on the same filesystem, use SQLite's online backup API, run `PRAGMA quick_check` on the staged database, calculate SHA-256 and size, sync file contents and the parent directory, then rename the directory atomically. Apply private file/directory permissions on Unix and rely on the private parent's inherited ACL on Windows. Never include the requested/effective data path in the manifest.

- [ ] **Step 4: Make pending-migration inspection non-mutating**

Split the current migration flow:

```rust
pub fn pending_migrations(connection: &Connection) -> Result<Vec<MigrationRef<'static>>, MigrationError>;
pub fn apply_migrations(connection: &mut Connection, pending: &[MigrationRef<'_>]) -> Result<(), MigrationError>;
```

`pending_migrations` must not create the migration ledger or alter any pragma/user data. For an existing store with pending migrations, create and verify `PreMigration` before `apply_migrations`. Abort startup without schema mutation if staging, quick-check, hashing, sync, or final publication fails. A genuinely new store follows its first-run migration path without a redundant empty backup.

- [ ] **Step 5: Apply retention only after verification**

Inventory manifests defensively, ignore incomplete staging directories, and retain the latest three valid backups for each `(state_kind, storage_instance_id)`. Delete an older backup only after the new directory is durable and reloadable. A malformed manifest is reported as a recovery issue and is never selected for deletion based on untrusted fields. Failure to delete an older backup emits a warning but does not invalidate the verified new generation or unblock deletion of any other untrusted entry.

- [ ] **Step 6: Run backup and persistence validation**

```bash
cargo test -p bibcode-server --test persistence_backup -- --nocapture
cargo test -p bibcode-server persistence:: -- --nocapture
cargo test -p bibcode-server --test persistence_compat -- --nocapture
cargo fmt --all --check
```

Expected: WAL-backed data survives a verified backup, migrations cannot begin without one, and retention leaves exactly the newest three valid generations.

- [ ] **Step 7: Commit the backup boundary**

```bash
git add apps/server/src/persistence apps/server/src/lifecycle.rs apps/server/tests/persistence_backup.rs
git commit -m "feat(server): verify backups before store migration"
```

---

### Task 9: Quiesce Every Running Backend Before Desktop Update Installation

**Files:**
- Create: `apps/server/src/maintenance.rs`
- Create: `apps/server/tests/production_maintenance.rs`
- Modify: `apps/server/src/http.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/src/rpc/session.rs`
- Modify: `apps/server/src/lib.rs`
- Modify: `apps/server/src/auth/http.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/updates.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ipc.test.ts`
- Modify: `apps/web/src/state/desktopUpdate.ts`
- Create: `apps/web/src/components/desktop/UpdateProtectionDialog.tsx`
- Create: `apps/web/src/components/desktop/UpdateProtectionDialog.test.tsx`
- Modify: `apps/web/src/components/desktopUpdate.logic.ts`
- Modify: `apps/web/src/components/sidebar/SidebarUpdatePill.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`

**Dependencies:**
- Consumes: Task 8 `create_verified_backup(PreUpdate)` and the existing per-backend bootstrap credentials.
- Produces: a durable update-protection result for recovery diagnostics and Task 12 packaged-upgrade validation.

- [ ] **Step 1: Write failing admission, drain, and updater-state tests**

Add server tests that start a real production runtime, issue an authenticated maintenance request, and prove:

1. new mutating RPCs are rejected after maintenance begins;
2. admitted work drains within the configured deadline;
3. SQLite WAL is checkpointed and a verified `PreUpdate` backup exists;
4. concurrent/repeated prepare requests return the same operation/result;
5. cancel releases the operation and commit exits only after its response is delivered;
6. preparation failure or lease expiry cannot leave a backend indefinitely quiesced.

Add desktop/web tests for primary failure, a secondary failure that requires explicit exclusion, and UI state progression through `protecting` before `installing`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cargo test -p bibcode-server --test production_maintenance -- --nocapture
cargo test -p bibcode-desktop-tauri updates::tests -- --nocapture
cargo test -p bibcode-desktop-tauri backend::tests -- --nocapture
vp test packages/contracts/src/ipc.test.ts apps/web/src/state/desktopUpdate.test.ts apps/web/src/components/desktop/UpdateProtectionDialog.test.tsx
```

Expected: no admission gate, maintenance route, or protecting state exists.

- [ ] **Step 3: Add authenticated maintenance RPC and admission gate**

Define the server-owned state machine:

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareForUpdateResult {
    pub operation_id: Uuid,
    pub storage_instance_id: StorageInstanceId,
    pub backup_id: Uuid,
    pub drained_operations: u64,
    pub expires_at: String,
}

pub struct RpcAdmissionGate {
    state: Mutex<AdmissionState>,
    drained: Notify,
}

struct AdmissionState {
    phase: AdmissionPhase,
    in_flight: u64,
}

impl RpcAdmissionGate {
    pub fn admit(&self, mutability: RpcMutability) -> Result<RpcPermit, MaintenanceError>;
    pub async fn close_and_drain(&self, deadline: Instant) -> Result<u64, MaintenanceError>;
    pub fn release(&self) -> Result<(), MaintenanceError>;
}
```

Expose `POST /api/maintenance/update/prepare`, `POST /api/maintenance/update/commit`, `POST /api/maintenance/update/cancel`, and `GET /api/maintenance/update/status` only when `ServerMode::Desktop`, the bind target is local, and the request passes the existing bootstrap bearer/token boundary. Wire `RpcAdmissionGate` at the typed WebSocket dispatch and every mutating HTTP boundary; a permit lives until the accepted operation reaches committed/failed terminal state, while reads/status do not take mutation permits.

Prepare closes mutation admission, drains permits with a deadline, drains persistence queues and process/stream writers through an idempotent `ProductionRuntime::quiesce_for_update`, checkpoints WAL, calls Task 8 with `PreUpdate`, and returns a single-flight operation without exiting. It holds the gate closed until matching `operation_id` commit/cancel. Commit responds, then signals clean lifecycle shutdown. Cancel releases the gate by ending the quiesced server and having the desktop restart that same plan; this avoids inventing partial in-process writer resumption. Preparation error takes the same cancel/exit path. A bounded lease expiry automatically cancels so an abandoned WSL child cannot remain quiesced forever. Concurrent prepare calls share one future/result; mismatched commit/cancel IDs fail without changing state.

- [ ] **Step 4: Coordinate all desktop-owned backend instances**

Have the desktop updater enumerate every configured desktop-owned local environment, then snapshot which native primary, WSL primary, and WSL secondary backends are running. Call prepare with each running backend's bootstrap credential and retain the operation/result per logical environment. The primary environment is mandatory. A configured secondary that is not running is recorded as unprotected and requires the same explicit named exclusion as a running secondary whose backup failed; neither case is silently ignored.

If any preparation fails, cancel all successful operations, wait for their servers to exit, restart the previously running set, and then present primary retry or named secondary exclusion. When all mandatory/included operations succeed, commit each, confirm each process stopped, and only then invoke the updater plugin. The desktop finishes this coordination within the server lease and treats lease expiry as preparation failure.

If installation fails after committed shutdown, restart exactly the previously running backend set and surface the original update failure. Keep preparation single-flight and reuse a still-valid operation result within one attempt; a later attempt may create a new verified generation, with Task 8 retention bounding it.

- [ ] **Step 5: Extend update IPC and renderer state**

Add version-skew-safe additive fields:

```ts
export const DesktopUpdatePhase = Schema.Literal(
  "idle", "checking", "available", "protecting", "installing", "failed",
);

export const DesktopUpdateProtection = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  status: Schema.Literal("pending", "protected", "failed", "excluded"),
  message: Schema.optionalWith(Schema.String, { nullable: true }),
});
```

Make `installUpdate` asynchronous across the bridge so progress events render before application exit. `UpdateProtectionDialog` lists failed secondary environments and requires explicit exclusion confirmation; a primary failure offers Retry and Diagnostics only. Replace the current browser-confirm install seam in Sidebar and Settings with this typed dialog while preserving the existing download action.

- [ ] **Step 6: Run focused maintenance validation**

```bash
cargo test -p bibcode-server --test production_maintenance -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
cargo test -p bibcode-desktop-tauri updates::tests -- --nocapture
cargo test -p bibcode-desktop-tauri backend::tests -- --nocapture
vp test packages/contracts/src/ipc.test.ts apps/web/src/state/desktopUpdate.test.ts apps/web/src/components/desktop/UpdateProtectionDialog.test.tsx apps/web/src/components/sidebar/SidebarUpdatePill.test.tsx apps/web/src/components/settings/SettingsPanels.test.tsx
vp run typecheck --filter=@bibcode/contracts --filter=@bibcode/web
```

Expected: install cannot start until included backends have stopped with verified backups, and update failure restarts the exact prior set.

- [ ] **Step 7: Commit update quiescence**

```bash
git add apps/server/src/maintenance.rs apps/server/src/http.rs apps/server/src/lifecycle.rs apps/server/src/production/runtime.rs apps/server/src/rpc/session.rs apps/server/src/lib.rs apps/server/src/auth/http.rs apps/server/tests/production_maintenance.rs apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/updates.rs apps/desktop/src-tauri/src/lib.rs packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts apps/web/src/state/desktopUpdate.ts apps/web/src/components/desktopUpdate.logic.ts apps/web/src/components/desktop/UpdateProtectionDialog.tsx apps/web/src/components/desktop/UpdateProtectionDialog.test.tsx apps/web/src/components/sidebar/SidebarUpdatePill.tsx apps/web/src/components/settings/SettingsPanels.tsx
git commit -m "feat(desktop): protect stores before update install"
```

---

### Task 10: Provide Offline, Validated Restore and Start-Empty Operations

**Files:**
- Modify: `apps/server/src/persistence/backup.rs`
- Modify: `apps/server/src/persistence/database.rs`
- Modify: `apps/server/src/persistence/store.rs`
- Modify: `apps/server/src/persistence/state_files.rs`
- Modify: `apps/server/src/persistence/mod.rs`
- Modify: `apps/server/src/config.rs`
- Modify: `apps/server/src/lib.rs`
- Modify: `apps/server/src/main.rs`
- Modify: `apps/server/tests/project_data_safety.rs`
- Modify: `apps/server/tests/cli_smoke.rs`

**Dependencies:**
- Consumes: Task 2 store classification and Task 8 verified manifests/inventory.
- Produces: one server-owned recovery implementation callable directly for native stores and through the bundled CLI for WSL stores.

- [ ] **Step 1: Write failing recovery atomicity and CLI tests**

Add integration cases for valid restore, checksum mismatch, `quick_check` failure, wrong state kind, wrong known storage identity, interrupted staging, and start-empty. The positive tests must prove that the live database, WAL/SHM, and marker are preserved under a timestamped recovery directory before replacement. The negative tests must prove byte-for-byte preservation of the original live files.

Add CLI tests for JSON output and non-zero exit on an unsafe operation:

```bash
bibcode storage inspect --base-dir /absolute/store --json
bibcode storage restore --base-dir /absolute/store --backup-id <uuid> --json
bibcode storage start-empty --base-dir /absolute/store --json
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cargo test -p bibcode-server --test project_data_safety recovery -- --nocapture
cargo test -p bibcode-server --test cli_smoke storage -- --nocapture
```

Expected: recovery functions and storage subcommands are absent.

- [ ] **Step 3: Define inspection and recovery APIs in the owning package**

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInspection {
    pub classification: StoreClassification,
    pub storage_instance_id: Option<StorageInstanceId>,
    pub backups: Vec<VerifiedBackup>,
    pub requested_root: PathBuf,
    pub effective_root: PathBuf,
    pub is_filesystem_alias: bool,
}

pub fn inspect_store(root: &ResolvedDataRoot) -> Result<StoreInspection, RecoveryError>;
pub fn restore_backup(root: &ResolvedDataRoot, backup_id: Uuid) -> Result<RecoveryResult, RecoveryError>;
pub fn preserve_and_start_empty(root: &ResolvedDataRoot) -> Result<RecoveryResult, RecoveryError>;
```

All destructive calls re-resolve and compare the effective root immediately before mutation. Require the server process for that store to be stopped and acquire the same exclusive maintenance lock used by backup/migration. Restore validates manifest parsing, state kind, known storage UUID, SHA-256, size, and SQLite `quick_check` before touching live files.

- [ ] **Step 4: Preserve first, then install atomically**

Before moving live files, write and sync a recovery-operation journal outside the live state directory containing only operation ID, state kind, phase, and selected backup ID. Move existing database, `-wal`, `-shm`, and marker into `<effective-base-root>/recovery/<timestamp>-<operation-id>/`, sync the preserved directory, copy the verified database into a same-filesystem staging path, create a marker matching the selected backup identity, sync both, and atomically rename them into the live state directory. Remove and sync the journal only after database and marker are durable. Task 2 startup classification treats any journal or incomplete staging artifact as `recovery-required`, so a crash after preservation can never be mistaken for first run. On any pre-commit error leave the live store unchanged; on a post-preservation error leave the recovery copy intact and the journal present.

`preserve_and_start_empty` performs the same preservation but does not forge a replacement marker. The next normal startup sees both database and marker absent, creates a fresh UUID/store, and Task 5 requires explicit identity adoption.

- [ ] **Step 5: Add a structured storage CLI without shell-specific behavior**

Refactor parsing into:

```rust
enum CliAction {
    Run(ServerConfig),
    Storage(StorageCommand),
}

enum StorageCommand {
    Inspect(StorageRootArgs),
    Restore { root: StorageRootArgs, backup_id: Uuid },
    StartEmpty(StorageRootArgs),
}
```

Route every `--base-dir` through Task 1 resolution. Print one JSON document on stdout when `--json` is set and diagnostics on stderr. This binary contract is what the desktop uses inside WSL; do not add PowerShell/Bash command-string recovery logic.

- [ ] **Step 6: Run focused recovery validation**

```bash
cargo test -p bibcode-server --test project_data_safety recovery -- --nocapture
cargo test -p bibcode-server --test cli_smoke storage -- --nocapture
cargo test -p bibcode-server persistence::backup::tests -- --nocapture
cargo fmt --all --check
```

Expected: unsafe backups are rejected before preservation, valid restore is atomic, and start-empty always retains recoverable originals.

- [ ] **Step 7: Commit recovery core and CLI**

```bash
git add apps/server/src/persistence apps/server/src/config.rs apps/server/src/lib.rs apps/server/src/main.rs apps/server/tests/project_data_safety.rs apps/server/tests/cli_smoke.rs
git commit -m "feat(server): add explicit project data recovery"
```

---

### Task 11: Expose Native and WSL Recovery Through the Desktop Bridge

**Files:**
- Create: `apps/desktop/src-tauri/src/data_safety.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/permissions/desktop-bridge.toml`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ipc.test.ts`
- Modify: `apps/web/src/tauriDesktopBridge.ts`
- Modify: `apps/web/src/tauriDesktopBridge.test.ts`
- Create: `apps/web/src/state/projectDataSafety.ts`
- Create: `apps/web/src/state/projectDataSafety.test.ts`
- Create: `apps/web/src/components/desktop/ProjectDataRecoveryDialog.tsx`
- Create: `apps/web/src/components/desktop/ProjectDataRecoveryDialog.test.tsx`
- Modify: `apps/web/src/AppRoot.tsx`
- Modify: `apps/web/src/AppRoot.test.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/Sidebar.test.tsx`

**Dependencies:**
- Consumes: Task 6 blocked availability, Task 7 backend-plan diagnostics, and Task 10 recovery library/CLI.
- Produces: user-directed local recovery without exposing privileged filesystem mutation to normal HTTP/WS RPC.

- [ ] **Step 1: Write failing bridge and recovery-screen tests**

Desktop tests cover native inspection, a WSL argument-vector invocation, restore requiring a stopped target, restart after a successful operation, and no restart after validation failure. Contract/web tests cover recovery-required auto-open, storage-changed manual open, no-backup copy, selected-backup confirmation, separate start-empty confirmation, retry, open path, and diagnostic export.

The WSL test must assert arguments as separate values and reject a crafted distro/path from becoming a shell command.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cargo test -p bibcode-desktop-tauri data_safety::tests -- --nocapture
cargo test -p bibcode-desktop-tauri bridge::tests -- --nocapture
vp test packages/contracts/src/ipc.test.ts apps/web/src/tauriDesktopBridge.test.ts apps/web/src/state/projectDataSafety.test.ts apps/web/src/components/desktop/ProjectDataRecoveryDialog.test.tsx apps/web/src/AppRoot.test.tsx
```

Expected: data-safety bridge payloads, commands, state, and dialog do not exist.

- [ ] **Step 3: Add redacted, environment-specific bridge contracts**

```ts
export const DesktopProjectDataBackup = Schema.Struct({
  backupId: Schema.String,
  createdAt: Schema.String,
  trigger: Schema.Literal("pre-migration", "pre-update"),
  appVersion: Schema.String,
  schemaVersion: Schema.Number,
  sizeBytes: Schema.Number,
});

export const DesktopProjectDataEnvironmentStatus = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  runningDistro: Schema.optionalWith(Schema.String, { nullable: true }),
  status: Schema.Literal("healthy", "storage-changed", "recovery-required", "unavailable"),
  requestedRoot: Schema.String,
  effectiveRoot: Schema.String,
  isFilesystemAlias: Schema.Boolean,
  storageInstanceId: Schema.optionalWith(Schema.String, { nullable: true }),
  issue: Schema.optionalWith(Schema.String, { nullable: true }),
  backups: Schema.Array(DesktopProjectDataBackup),
});
```

Add bridge methods `getProjectDataStatuses`, `restoreProjectData(environmentId, backupId)`, `startEmptyProjectData(environmentId)`, `openProjectDataPath(environmentId)`, and `exportProjectDataDiagnostics(environmentId)`. Only the privileged desktop IPC status may contain requested/effective paths; environment descriptors and normal server RPC remain redacted.

- [ ] **Step 4: Route native recovery to the library and WSL recovery to the bundled CLI**

Resolve the target from the current backend plan, not from renderer-supplied paths. Native macOS, Linux, and Windows targets call Task 10 APIs directly on blocking workers. A WSL target invokes the bundled Linux `bibcode` binary as an argument vector equivalent to:

```text
wsl.exe --distribution <selected-distro> -- <bundled-bibcode> storage inspect|restore|start-empty --base-dir <absolute-wsl-root> --json
```

Decode the JSON result, bound stdout/stderr capture, and surface a typed environment-specific error. Never scan other distributions or old application directories. An explicitly configured root that happens to contain unrelated/T4Code leftovers is classified solely by the current BiBCode marker/database rules; no migration or adoption is attempted.

- [ ] **Step 5: Serialize stop, recovery, and restart**

Reuse the exclusive desktop operation lock from update coordination. Re-resolve the target root, stop only the selected backend, execute recovery, and restart the same plan after a committed restore/start-empty. A validation failure leaves the process/store unchanged. A restart failure returns a successful-recovery-with-restart-failure result so the UI never implies the recovery was rolled back.

- [ ] **Step 6: Build the recovery UI and state flow**

Open `ProjectDataRecoveryDialog` automatically for `recovery-required` and from a Storage changed/Diagnostics action for other blocked states. Show logical environment, WSL distro where applicable, requested/effective roots with alias warning, current storage ID, issue, last successful backup, and verified backups. Restore requires selecting a specific backup plus confirmation. Start empty uses a separate destructive confirmation that states the current files will be preserved, not deleted. If no verified backup exists, say so without implying recovery is impossible.

After successful restore, reconnect without adopting a different identity. After start-empty, route through Task 5's explicit adoption UI. Retry re-inspects and restarts; open-path and diagnostic export remain desktop-only actions.

- [ ] **Step 7: Run focused cross-platform recovery validation**

```bash
cargo test -p bibcode-desktop-tauri data_safety::tests -- --nocapture
cargo test -p bibcode-desktop-tauri bridge::tests -- --nocapture
cargo test -p bibcode-desktop-tauri backend::tests -- --nocapture
vp test packages/contracts/src/ipc.test.ts apps/web/src/tauriDesktopBridge.test.ts apps/web/src/state/projectDataSafety.test.ts apps/web/src/components/desktop/ProjectDataRecoveryDialog.test.tsx apps/web/src/AppRoot.test.tsx apps/web/src/components/Sidebar.test.tsx
vp run typecheck --filter=@bibcode/contracts --filter=@bibcode/web
```

Expected: native platforms share the server recovery core, WSL uses the same binary contract, and every destructive action is explicit and preserves prior files.

- [ ] **Step 8: Commit desktop recovery**

```bash
git add apps/desktop/src-tauri/src/data_safety.rs apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/bridge.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/permissions/desktop-bridge.toml packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts apps/web/src/tauriDesktopBridge.ts apps/web/src/tauriDesktopBridge.test.ts apps/web/src/state/projectDataSafety.ts apps/web/src/state/projectDataSafety.test.ts apps/web/src/components/desktop/ProjectDataRecoveryDialog.tsx apps/web/src/components/desktop/ProjectDataRecoveryDialog.test.tsx apps/web/src/AppRoot.tsx apps/web/src/AppRoot.test.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx
git commit -m "feat(desktop): expose explicit project data recovery"
```

---

### Task 12: Prove Seeded Packaged Upgrades on Windows, macOS, and Linux

**Files:**
- Create: `scripts/seeded-desktop-upgrade-smoke.ts`
- Create: `scripts/seeded-desktop-upgrade-smoke.test.ts`
- Create: `.github/workflows/desktop-upgrade-smoke.yml`
- Modify: `scripts/mock-update-server.ts`
- Modify: `scripts/mock-update-server.test.ts`
- Modify: `scripts/ci-platform-contract.test.ts`
- Modify: `scripts/workflow-dependencies.test.ts`
- Modify: `package.json`

**Dependencies:**
- Consumes: Tasks 3, 8, 9, and 11 plus existing release packaging, previous-tag resolution, updater-manifest, and mock update-server scripts.
- Produces: release-blocking evidence that a real platform update retains the exact seeded store, plus bootstrapped proof of the protection protocol that only a protected source package can execute.

- [ ] **Step 1: Write failing harness and workflow-contract tests**

Test deterministic argument parsing, isolated data roots, previous-tag checkout selection, protected-baseline selection, Tauri overlay generation, test-signing-key handling, updater readiness, restart timeout, nullable old descriptor identity, descriptor/project comparison, backup-manifest comparison, process cleanup, and secret redaction. Extend workflow contract tests to require the exact supported matrix and pinned action SHAs.

- [ ] **Step 2: Run script tests and verify RED**

```bash
vp test scripts/seeded-desktop-upgrade-smoke.test.ts scripts/mock-update-server.test.ts scripts/ci-platform-contract.test.ts scripts/workflow-dependencies.test.ts
```

Expected: the harness command and workflow are absent.

- [ ] **Step 3: Build previous stable and candidate packages with a test updater**

Resolve the previous stable tag through `scripts/resolve-previous-release-tag.ts`. Build that exact source in an isolated worktree with only a generated Tauri `--config` overlay that replaces updater endpoints/public key with the local test server and test public key. Build the current candidate normally for the same target, sign its updater artifact with the ephemeral CI test key, and serve the generated update manifest/artifacts through `scripts/mock-update-server.ts` with deterministic readiness and Range-request logging.

For the first release containing this feature, also build a protected baseline from the current data-safety source with only its Tauri package version lowered through the test overlay. This second baseline is necessary because the actual previous stable executable cannot retroactively show `protecting`, create a storage UUID before update, or make a pre-update backup. It tests the exact new updater protocol without pretending the old release contains new code. After the first protected release becomes `previous stable`, the real previous-stable lane must satisfy both retention and protection and the synthetic lane can be removed through an explicit workflow change.

Never commit the private test key or write it to logs. Assert that the previous package version is lower than the candidate before launching.

- [ ] **Step 4: Seed through public application boundaries**

Launch each baseline installed/package artifact with its own temporary absolute `BIBCODE_HOME` and fixed free port. Through WebDriver's renderer execution, call the existing desktop bootstrap bridge to obtain the local endpoint credential, then use the authenticated public orchestration API to create a project with a unique ID. Fetch the environment descriptor and project list back through public HTTP/WS boundaries. Persist the project ID and nullable storage UUID in harness state; an old descriptor without the new field is expected in the real previous-stable lane and must not be fabricated by reading SQLite.

Do not seed SQLite directly; the smoke must fail if the released application cannot create and read its own project.

- [ ] **Step 5: Drive the real updater and verify after restart**

Run two assertions per platform:

1. **Real previous stable to candidate:** invoke that release's real updater path, restart with the same isolated root, and assert the seeded project remains, the candidate classifies/adopts the recognized BiBCode database, emits a valid storage UUID, and never shows false first-run/empty state. If the previous stable already exposes the protection contract, also require its `protecting` phase and pre-update manifest.
2. **Protected lower-version baseline to candidate:** invoke the renderer's `desktopBridge.downloadUpdate()` and `installUpdate()` paths, require `protecting`, require every mandatory environment to report protected, and observe the platform-specific install/exit. Restart/reconnect with the same isolated root, then assert:

```ts
expect(after.storageInstanceId).toBe(before.storageInstanceId);
expect(after.projectIds).toContain(seed.projectId);
expect(after.preUpdateBackups).toContainEqual(
  expect.objectContaining({ storageInstanceId: before.storageInstanceId }),
);
```

The protected lane fails if `before.storageInstanceId` is null. The compatibility lane compares project identity and the recognized root because its old descriptor may legitimately lack storage identity. On both lanes, collect bounded evidence on failure.

On failure, collect bounded desktop/server logs, redacted status output, updater requests, and the isolated root tree without publishing database contents.

- [ ] **Step 6: Add the supported platform matrix**

Create release-blocking jobs that execute both rollout lanes for:

- Windows x64 NSIS/updater;
- macOS arm64 updater archive/DMG flow;
- macOS x64 updater archive/DMG flow;
- Linux x64 AppImage updater.

Add a Windows integration job for WSL-primary unavailability and WSL storage identity; skip only when the runner lacks the declared WSL capability, with the reason recorded. Linux external package-manager/manual updates remain outside interception scope: the matrix proves the AppImage in-app updater, while Task 8 still protects a later pending migration after an external update.

- [ ] **Step 7: Run harness contract validation**

```bash
vp test scripts/seeded-desktop-upgrade-smoke.test.ts scripts/mock-update-server.test.ts scripts/ci-platform-contract.test.ts scripts/workflow-dependencies.test.ts scripts/release-workflow.test.ts
vp run typecheck
```

Then run the host-compatible seeded packaged-upgrade job locally when signing and UI automation prerequisites are available; the other platform jobs are evidenced by the CI matrix rather than emulation.

- [ ] **Step 8: Commit packaged-upgrade coverage**

```bash
git add scripts/seeded-desktop-upgrade-smoke.ts scripts/seeded-desktop-upgrade-smoke.test.ts scripts/mock-update-server.ts scripts/mock-update-server.test.ts scripts/ci-platform-contract.test.ts scripts/workflow-dependencies.test.ts .github/workflows/desktop-upgrade-smoke.yml package.json
git commit -m "test(release): verify seeded desktop upgrades"
```

---

### Task 13: Document the Runtime Invariants and Valid Cross-Platform Scenarios

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/connection-runtime.md`
- Modify: `docs/architecture/remote.md`
- Modify: `docs/operations/release.md`
- Create: `docs/guides/project-data-recovery.md`

**Dependencies:**
- Consumes: the final public behavior and contracts from Tasks 1-12.
- Produces: living documentation that matches the implemented persistence, update, and recovery boundaries.

- [ ] **Step 1: Re-read implemented contracts before writing**

Trace the final data-root resolver, store classification matrix, descriptor schema, accepted-identity state, updater state machine, recovery bridge, and release workflow. Record any divergence from the approved design and resolve it in code or explicitly amend the design before changing living documentation.

- [ ] **Step 2: Update architecture ownership and lifecycle**

In `overview.md`, document the server as source of truth for root/store/backup/recovery and the desktop as coordinator for privileged multi-backend operations. In `connection-runtime.md`, document logical versus storage identity, first-seen acceptance, mismatch-before-sync, version-skew null handling, catalog recovery, authoritative empty state, and cache retention. In `remote.md`, state that remote/SSH descriptors expose storage UUID but never local path diagnostics and that the desktop recovery screen applies only to desktop-owned local/WSL backends.

- [ ] **Step 3: Add the user-facing scenario and recovery guide**

Include a compact matrix with the observable outcome and recovery action for:

- Windows native root changed by `BIBCODE_HOME`, CLI, user/home/profile, drive, junction/reparse target, permissions, security software, corrupt/missing DB or marker;
- Windows WSL distro/user/home/root changed, distro unavailable, Windows-plus-WSL secondary unavailable, and explicit switch to native Windows;
- macOS home/user/root changes, symlink target changes, permission/quarantine/security-tool interference, corrupt/missing DB or marker;
- Linux home/user/root changes, symlink/mount/AppImage location changes, external package-manager/manual updates, permissions, corrupt/missing DB or marker;
- all platforms: a remote endpoint resolves to a different store, catalog corruption, migration/update backup failure, and an explicit start-empty operation.

State that a normal in-place updater replaces application files and should retain the store. Explain requested/effective roots, alias warnings, backup retention, restore, start-empty preservation, explicit storage adoption, diagnostics, and why “No projects yet” appears only after live authoritative empty snapshots. Record the rollout limitation that the first protected release cannot detect a pre-marker switch to a different valid BiBCode database until that database receives a UUID and the client records it.

Add one explicit T4Code note: no compatibility, migration, scanning, or automatic adoption exists. Old files are inert unless the user/configuration points BiBCode's current root or remote endpoint at them, in which case current marker/database classification fails closed rather than interpreting them as a legacy store.

- [ ] **Step 4: Update release operations**

Document pre-update quiescence, primary/secondary protection rules, Windows updater exit timing, macOS/Linux restart behavior, AppImage versus external Linux updates, recovery artifacts on failure, and the seeded previous-stable-to-candidate matrix. Link the exact workflow and local harness command, including signing/WebDriver prerequisites and redaction requirements.

- [ ] **Step 5: Validate links and terminology**

```bash
vp check
rg -n 'storage instance|storageInstanceId|recovery-required|pre-update|WSL-only|AppImage|T4Code' docs/README.md docs/architecture docs/operations docs/guides/project-data-recovery.md
git diff --check
```

Expected: living docs use the implemented names, distinguish requested/effective roots, and do not promise interception of external Linux updates or legacy migration.

- [ ] **Step 6: Commit living documentation**

```bash
git add docs/README.md docs/architecture/overview.md docs/architecture/connection-runtime.md docs/architecture/remote.md docs/operations/release.md docs/guides/project-data-recovery.md
git commit -m "docs: explain project data safety and recovery"
```

---

### Task 14: Run Completion Gates and Review the Cross-Runtime Diff

**Files:**
- Review: every file changed in Tasks 1-13
- Modify: only files needed to fix failures or bring living documentation back into agreement

**Dependencies:**
- Consumes: all prior tasks.
- Produces: completion evidence for Windows, macOS, Linux, native/WSL, browser/desktop, and version-skew boundaries.

- [ ] **Step 1: Run the complete TypeScript and repository gates**

```bash
vp check
vp run typecheck
vp test
vp run test
```

Run the focused project-data safety, connection runtime, web recovery, updater, script, and workflow tests again if the workspace graph does not select them by default.

- [ ] **Step 2: Run the complete affected Rust gates**

```bash
cargo fmt --all --check
cargo test -p bibcode-server --all-targets
cargo test -p bibcode-desktop-tauri --all-targets
cargo clippy -p bibcode-server -p bibcode-desktop-tauri --all-targets -- -D warnings
```

Use `scripts/run-windows-cargo-target.mjs`/`run-msvc-x64` checks where required by repository scripts rather than pretending the macOS host executed Windows binaries.

- [ ] **Step 3: Validate supported packaged upgrade jobs**

Run the host-compatible seeded packaged-upgrade smoke with its documented signing/WebDriver prerequisites. Confirm CI has green jobs for Windows x64, macOS arm64, macOS x64, Linux x64 AppImage, and the declared Windows WSL case before release. If a platform job cannot run locally, report it as CI-only evidence; do not replace it with a source-level test.

- [ ] **Step 4: Exercise the critical failure matrix manually or in integration fixtures**

Verify all of these observable seams:

1. marker present/database missing and corrupt database enter recovery without creating SQLite;
2. storage UUID mismatch blocks before session synchronization and explicit adoption persists;
3. loading/degraded/unavailable/recovery/configuration states never render “No projects yet”;
4. WSL-only failure never launches native Windows;
5. migration/update cannot proceed after backup verification failure;
6. restore preserves live files and start-empty creates a new UUID only after preservation;
7. secondary update exclusion is named and explicit while primary exclusion is impossible;
8. old descriptor without `storageInstanceId` connects without erasing an accepted UUID;
9. alias diagnostics show requested/effective roots without leaking them over normal server descriptors;
10. unrelated filesystem leftovers are ignored unless explicitly selected as the current root.

- [ ] **Step 5: Review repository state and implementation boundaries**

```bash
git diff --check
PROJECT_DATA_SAFETY_FIRST_COMMIT=$(git log --format=%H --grep='^fix(storage): resolve one absolute data root$' -1)
PROJECT_DATA_SAFETY_BASELINE=$(git rev-parse "${PROJECT_DATA_SAFETY_FIRST_COMMIT}^")
git diff --stat "$PROJECT_DATA_SAFETY_BASELINE"..HEAD
git status --short
```

Inspect the full diff for unintended edits, debug output, dependency drift, generated `.codegraph/` content, secrets, raw database/path data in normal descriptors, public-contract omissions, and documentation disagreement. Confirm `.repos/` remains untouched unless a dependency with a configured vendored subtree actually changed; if one did, run its scoped `vp run sync:repos -- --repo <id>` and review the vendored diff.

- [ ] **Step 6: Record exact completion evidence**

Report every command run, pass/fail/skip reason, packaged job URLs or identifiers, and residual risks. The implementation is complete only when the focused tests, repository gates, Rust format/tests/Clippy, and supported packaged-upgrade jobs all pass; unavailable local cross-platform execution remains an explicit CI dependency, not an unqualified success claim.

---
