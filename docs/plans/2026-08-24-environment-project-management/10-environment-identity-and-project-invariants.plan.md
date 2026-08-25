# Environment Identity And Project Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every server data root a durable environment UUID distinct from its storage UUID, and enforce one active project per local Git repository family plus exactly one permanent Main thread per project.

**Architecture:** Extend the existing startup lock and atomic marker publication in server persistence. Keep the database environment-local. Move repository uniqueness into a transactional claim owned by orchestration, and add a partial SQLite index as a defensive Main invariant while retaining event-sourced project/Main creation.

**Tech Stack:** Rust 2024, Tokio filesystem APIs, SQLite/rusqlite, Clap, Effect Schema, Vite+ contract tests.

**Spec:** [Architecture and data specification](./02-architecture-and-data.spec.md)

## Global Constraints

- `environment-id` becomes a random server-owned UUID; the legacy marker value is preserved exactly as `storage-instance-id`.
- Marker migration runs under the existing data-root operation lock and is create-once, fsynced, verified, retryable, and crash-safe.
- Host names, `primary`, `wsl:<name>`, CLI flags, and client input never choose the durable environment UUID.
- Do not add environment columns to projects, threads, messages, activities, worktrees, approvals, or provider tables.
- Repository equality uses the verified Git common-directory/object identity, never remote URL equality.
- Project create remains atomic with its Main event and is idempotent under command replay and concurrent duplicate requests.
- Keep `kind` wire values `default`, `workspace`, and `panel`; only the UI label changes to Main.
- Existing worktree locks, repository pins, adoption, detach, removal receipts, and cleanup remain authoritative.

---

## File Structure

- Modify: `apps/server/src/persistence/state_files.rs` — explicit marker paths.
- Modify: `apps/server/src/persistence/store.rs` — locked identity migration/publication.
- Modify: `apps/server/src/persistence/backup.rs` — environment and storage identities in manifests.
- Modify: `apps/server/src/maintenance.rs` — identity-aware maintenance inspection.
- Modify: `apps/server/src/lifecycle.rs` — publish the server-owned identity into runtime config.
- Modify: `apps/server/src/config.rs` — remove configured `environment_id` as an identity source.
- Modify: `apps/server/src/http.rs` — descriptor uses prepared identities.
- Modify: `packages/contracts/src/environment.ts` and test — UUID/capability descriptor contract.
- Modify: `apps/server/src/persistence/migrations.rs` — repository claim and Main indexes.
- Modify: `apps/server/src/persistence/repositories.rs` — claim reads/writes in orchestration transaction.
- Modify: `apps/server/src/orchestration/engine.rs` — claim acquisition, idempotent result, Main guards.
- Modify: `apps/server/src/production/orchestration_effects.rs` — resolve verified repository identity.
- Modify: `packages/contracts/src/orchestration.ts`, `project.ts`, `rpc.ts` and tests — create disposition.
- Test: `apps/server/tests/server_runtime.rs`, `apps/server/tests/project_repository_claims.rs`.

### Task 1: Split environment and storage marker paths

**Files:**

- Modify: `apps/server/src/persistence/state_files.rs`
- Modify: `apps/server/src/persistence/store.rs`
- Test: `apps/server/src/persistence/store.rs`

**Interfaces:**

- Produces: `EnvironmentId(Uuid)`, `PreparedStore.environment_id`, `StatePaths.environment_id`, and `StatePaths.storage_instance_id`.
- Migrates: legacy `environment-id` storage marker to `storage-instance-id` without changing its UUID.

- [x] **Step 1: Write failing first-run and legacy-marker tests**

```rust
#[tokio::test]
async fn first_run_publishes_distinct_environment_and_storage_ids() {
    let prepared = prepare_fixture_store().await;
    assert_ne!(prepared.environment_id.to_string(), prepared.storage_instance_id.to_string());
    assert_eq!(read_uuid(&prepared.paths.environment_id), prepared.environment_id.to_string());
    assert_eq!(read_uuid(&prepared.paths.storage_instance_id), prepared.storage_instance_id.to_string());
}

#[tokio::test]
async fn legacy_marker_becomes_storage_id_and_retry_keeps_both_ids() {
    let fixture = LegacyMarkedStore::new();
    let first = fixture.prepare().await.unwrap();
    let second = fixture.prepare().await.unwrap();
    assert_eq!(first.storage_instance_id, fixture.legacy_id());
    assert_eq!(first.environment_id, second.environment_id);
}
```

- [x] **Step 2: Run the focused persistence tests and confirm RED**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server persistence::store -- --nocapture
```

Expected: FAIL because `PreparedStore` has no environment identity and both meanings share `paths.environment_id`.

- [x] **Step 3: Add explicit paths and the environment ID value type**

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct EnvironmentId(Uuid);

pub struct StatePaths {
    pub environment_id: PathBuf,
    pub storage_instance_id: PathBuf,
    // existing fields remain
}
```

Construct `environment-id` and `storage-instance-id` in `StatePaths::from_config`; rename marker helpers to accept the exact destination path rather than reading a semantic path internally.

- [x] **Step 4: Implement the locked, ordered migration**

When `storage-instance-id` is absent and the legacy `environment-id` exists, atomically move that exact file to `storage-instance-id` without replacement, using the platform's write-through primitive and syncing the containing directory where supported. This frees the semantic destination before publishing a new random `environment-id`. When both markers are absent, publish storage first and environment second. When only `storage-instance-id` exists, treat it as an interrupted migration and publish the missing environment marker. When both exist, verify and reuse both.

```rust
let storage_instance_id = migrate_or_publish_storage_marker(&paths).await?;
verify_marker(&paths.storage_instance_id, storage_instance_id)?;
let environment_id = publish_marker_no_replace(
    &paths.state_dir,
    &paths.environment_id,
    EnvironmentId::random(),
).await?;
verify_marker(&paths.environment_id, environment_id)?;
```

Keep legacy interpretation only when `storage-instance-id` is absent. Never overwrite either marker after the semantic move; fsync each new file and use a durable same-directory publication/move primitive.

- [x] **Step 5: Add crash/race/corruption cases**

Cover: only legacy marker, only new storage marker, both markers, two racing prepares, malformed marker, database without markers, marker without database, and interruption after publishing storage but before environment.

- [x] **Step 6: Run focused tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server persistence::store -- --nocapture
git add apps/server/src/persistence/state_files.rs apps/server/src/persistence/store.rs
git commit -m "feat(server): split environment and storage identities"
```

### Task 2: Propagate identities through backup, maintenance, and descriptor startup

**Files:**

- Modify: `apps/server/src/persistence/backup.rs`
- Modify: `apps/server/src/maintenance.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/src/config.rs`
- Modify: `apps/server/src/http.rs`
- Test: `apps/server/tests/server_runtime.rs`

**Interfaces:**

- Consumes: `PreparedStore.environment_id` and `storage_instance_id`.
- Produces: descriptor and backup/inspection documents with distinct `environmentId` and `storageInstanceId`.

- [x] **Step 1: Write a failing restart/restore identity integration test**

```rust
#[tokio::test]
async fn descriptor_identity_survives_restart_and_storage_identity_is_separate() {
    let first = start_server(&root).await;
    let first_descriptor = first.descriptor().await;
    first.shutdown().await;
    let second_descriptor = start_server(&root).await.descriptor().await;
    assert_eq!(first_descriptor.environment_id, second_descriptor.environment_id);
    assert_eq!(first_descriptor.storage_instance_id, second_descriptor.storage_instance_id);
    assert_ne!(first_descriptor.environment_id, first_descriptor.storage_instance_id.unwrap());
}
```

- [x] **Step 2: Run the integration test and confirm RED**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test server_runtime descriptor_identity -- --nocapture
```

- [x] **Step 3: Make prepared persistence the only runtime identity source**

Remove `ServerConfig.environment_id` assignment as authority and set the runtime descriptor from prepared storage:

```rust
config.environment_id = prepared.environment_id;
config.storage_instance_id = Some(prepared.storage_instance_id);
```

Use a typed `EnvironmentId` field in the internal config; no CLI/env argument can set it.

- [x] **Step 4: Version backup and maintenance documents**

```rust
pub struct BackupManifest {
    pub schema_version: u32,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    // existing integrity fields
}
```

Decode old manifests through a migration-only schema, infer only the storage ID from legacy data, and require the active prepared environment identity for in-place restore.

- [ ] **Step 5: Add copied-root conflict and restore tests**

Verify that in-place restore preserves both IDs, `storage start-empty` produces new identities, and an explicit future clone operation rotates both. Do not add automatic last-writer-wins handling.

- [ ] **Step 6: Run focused tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server persistence::backup maintenance lifecycle -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test server_runtime -- --nocapture
git add apps/server/src/config.rs apps/server/src/http.rs apps/server/src/lifecycle.rs apps/server/src/maintenance.rs apps/server/src/persistence/backup.rs
git commit -m "feat(server): expose durable environment identity"
```

### Task 3: Tighten the environment descriptor contract

**Files:**

- Modify: `packages/contracts/src/environment.ts`
- Modify: `packages/contracts/src/environment.test.ts`
- Modify: `packages/contracts/src/baseSchemas.ts`
- Modify: `apps/server/src/http.rs`

**Interfaces:**

- Produces: strict UUID identities, protocol range, platform, and minimal capability metadata.

- [x] **Step 1: Write failing contract assertions**

```ts
expect(() => decodeDescriptor({ ...descriptor, environmentId: "local" })).toThrow();
expect(decodeDescriptor(descriptor)).toMatchObject({
  environmentId: "018f0f74-9d2f-7b57-9f17-7ea4f26c7e42",
  protocol: { minimum: 1, maximum: 1 },
});
```

- [x] **Step 2: Run contract tests and confirm RED**

```sh
vp test run packages/contracts/src/environment.test.ts
```

- [x] **Step 3: Add schema-owned UUID and protocol fields**

```ts
export const EnvironmentId = Schema.UUID.pipe(Schema.brand("EnvironmentId"));
export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  storageInstanceId: Schema.UUID,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  protocol: Schema.Struct({ minimum: Schema.Int, maximum: Schema.Int }),
  capabilities: ExecutionEnvironmentCapabilities,
});
```

Keep the descriptor inventory-minimal: no project names, paths, client list, tokens, or diagnostics.

- [x] **Step 4: Update server serialization and legacy fixtures**

Generate UUID-backed test configs instead of literal `local`; update only active fixtures and preserve bounded legacy decoders where migration needs them.

- [x] **Step 5: Run contract parity and commit**

```sh
vp test run packages/contracts/src/environment.test.ts
vp run check:contracts
git add packages/contracts/src/baseSchemas.ts packages/contracts/src/environment.ts packages/contracts/src/environment.test.ts apps/server/src/http.rs
git commit -m "feat(contracts): define durable environment descriptors"
```

### Task 4: Add transactional project repository claims

**Files:**

- Modify: `apps/server/src/persistence/migrations.rs`
- Modify: `apps/server/src/persistence/repositories.rs`
- Modify: `apps/server/src/orchestration/engine.rs`
- Modify: `apps/server/src/production/orchestration_effects.rs`
- Test: `apps/server/tests/project_repository_claims.rs`

**Interfaces:**

- Consumes: server-derived canonical Git common-directory key.
- Produces: `project_repository_claims(project_id, repository_key, claimed_at)` and a transactional acquire/release API.

- [x] **Step 1: Write failing migration and concurrent-create tests**

```rust
#[tokio::test]
async fn racing_creates_for_one_common_dir_return_one_project_and_main() {
    let (left, right) = tokio::join!(harness.create("a", &repo), harness.create("b", &repo));
    let results = [left.unwrap(), right.unwrap()];
    assert_eq!(results[0].project_id, results[1].project_id);
    assert_eq!(results[0].main_thread_id, results[1].main_thread_id);
    assert_eq!(harness.active_project_count().await, 1);
}
```

- [x] **Step 2: Run the focused tests and confirm RED**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test project_repository_claims -- --nocapture
```

- [x] **Step 3: Add the claim table migration**

```sql
CREATE TABLE project_repository_claims (
  project_id TEXT PRIMARY KEY NOT NULL,
  repository_key TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL
);
INSERT INTO project_repository_claims(project_id, repository_key, claimed_at)
SELECT p.project_id, w.repository_key, p.created_at
FROM projection_projects p
JOIN project_worktree_repository_pins w USING(project_id)
WHERE p.deleted_at IS NULL;
```

Fail migration with a diagnostic query if legacy rows contain conflicting active claims; do not choose a winner silently.

- [x] **Step 4: Resolve identity before mutation and acquire inside commit**

Extend `ProjectCommandEffects` with a structured result:

```rust
pub struct PreparedProjectRepository {
    pub canonical_workspace_root: String,
    pub repository_key: String,
}
```

Insert the claim in the same transaction as `project.created`/Main events. On unique conflict, reload the winning active project and return its canonical Main.

- [x] **Step 5: Release claims only through guarded project deletion**

Delete the claim in the authoritative project-removal transaction only after current worktree-owner guards pass. Rebuild claims deterministically from project repository facts; do not repurpose client-provided remote identity.

- [x] **Step 6: Cover independent clones and worktrees**

Create two clones of one remote and assert distinct `repository_key` values/projects. Add a linked worktree and assert it resolves to the owning project's claim, preserving existing adoption/removal behavior.

- [x] **Step 7: Run project and worktree suites, then commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test project_repository_claims -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server worktree_catalog -- --nocapture
git add apps/server/src/persistence/migrations.rs apps/server/src/persistence/repositories.rs apps/server/src/orchestration/engine.rs apps/server/src/production/orchestration_effects.rs apps/server/tests/project_repository_claims.rs
git commit -m "feat(projects): claim local repositories transactionally"
```

### Task 5: Encode idempotent create disposition in contracts and RPC

**Files:**

- Modify: `packages/contracts/src/project.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/project.test.ts`
- Modify: `apps/server/src/production/orchestration_rpc.rs`
- Test: `apps/server/tests/production_orchestration_rpc.rs`

**Interfaces:**

- Produces: `ProjectCreateEntryResult = created | existing` with `projectId` and `mainThreadId`.

- [ ] **Step 1: Write failing created/existing contract tests**

```ts
const existing = decodeProjectCreateResult({
  disposition: "existing",
  projectId: "project-1",
  mainThreadId: "thread-main",
  reason: "same-local-repository",
});
expect(existing.disposition).toBe("existing");
```

- [ ] **Step 2: Run the focused tests and confirm RED**

```sh
vp test run packages/contracts/src/project.test.ts
```

- [ ] **Step 3: Define the discriminated result**

```ts
export const ProjectCreateEntryResult = Schema.Union([
  Schema.Struct({
    disposition: Schema.Literal("created"),
    projectId: ProjectId,
    mainThreadId: ThreadId,
  }),
  Schema.Struct({
    disposition: Schema.Literal("existing"),
    projectId: ProjectId,
    mainThreadId: ThreadId,
    reason: Schema.Literal("same-local-repository"),
  }),
]);
```

- [ ] **Step 4: Map engine results without manufacturing a client fallback**

The RPC returns the committed canonical Main ID in both branches. If a winning project lacks a provable Main, fail with invariant diagnostics rather than creating a second default thread.

- [ ] **Step 5: Verify replay and duplicate RPC behavior**

Assert same command replay returns `created` for its original receipt, while a different command targeting the same repository returns `existing` and the same IDs.

- [ ] **Step 6: Run contract/RPC tests and commit**

```sh
vp test run packages/contracts/src/project.test.ts packages/contracts/src/orchestration.test.ts
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server production::orchestration_rpc -- --nocapture
git add packages/contracts/src/project.ts packages/contracts/src/project.test.ts packages/contracts/src/orchestration.ts packages/contracts/src/rpc.ts apps/server/src/production/orchestration_rpc.rs
git commit -m "feat(projects): report idempotent repository adds"
```

### Task 6: Add the database Main defense and complete mutation guards

**Files:**

- Modify: `apps/server/src/persistence/migrations.rs`
- Modify: `apps/server/src/orchestration/engine.rs`
- Modify: `apps/server/src/production/orchestration_rpc.rs`
- Modify: `packages/contracts/src/orchestration.ts`
- Test: `apps/server/src/orchestration/engine.rs`

**Interfaces:**

- Produces: one active `kind = 'default'` row per project and rejects Main rename/archive/delete.

- [ ] **Step 1: Write failing migration and mutation tests**

```rust
assert_rejected(main_command("thread.archive"), "Main cannot be archived").await;
assert_rejected(main_rename("Anything else"), "Main cannot be renamed").await;
assert_rejected(second_default_create(), "already has a canonical Main").await;
```

- [ ] **Step 2: Run engine tests and confirm the rename case is RED**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server orchestration::engine::tests::main -- --nocapture
```

- [ ] **Step 3: Validate legacy state before adding the index**

Query active default counts grouped by project. Rebuild from canonical events when the answer is unique; abort with project/thread IDs when ambiguous.

- [ ] **Step 4: Add the partial unique index**

```sql
CREATE UNIQUE INDEX idx_projection_threads_one_active_default
ON projection_threads(project_id)
WHERE kind = 'default' AND deleted_at IS NULL;
```

- [ ] **Step 5: Reject all independent Main mutations**

Keep existing delete/archive guards and add title protection in `ThreadMetaUpdate`; only project-level operations may remove Main with the project.

- [ ] **Step 6: Run migration, orchestration, and snapshot tests**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server persistence::migrations orchestration::engine -- --nocapture
```

- [ ] **Step 7: Run plan-level verification and commit**

```sh
vp run check:contracts
vp check
vp run typecheck
cargo fmt --all --check
node scripts/run-msvc-x64.mjs cargo clippy -p bibcode-server --all-targets -- -D warnings
git add apps/server/src/persistence/migrations.rs apps/server/src/orchestration/engine.rs apps/server/src/production/orchestration_rpc.rs packages/contracts/src/orchestration.ts
git commit -m "feat(projects): enforce one permanent Main thread"
```

### Task 7: Update identity/project living documentation and runbooks

**Files:**

- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/rpc-and-orchestration.md`
- Modify: `docs/architecture/worktree-catalog.md`
- Modify: `docs/reference/encyclopedia.md`
- Modify: `docs/user/workspace-ui.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/execution-report-template.md`

- [ ] **Step 1: Replace global-project terminology with the approved ownership contract**

Document the exact hierarchy and include this invariant block:

```text
Environment identity scopes every project/thread reference.
Repository claims are environment-local and use Git common-directory identity.
Main is permanent; worktree-backed workspace threads still use the worktree catalog.
```

- [ ] **Step 2: Add migration/restart/duplicate evidence fields to the runbook**

Record both UUIDs, duplicate-add disposition, independent-clone result, Main count, and unchanged worktree suite outcome without embedding machine-specific values in the living procedure.

- [ ] **Step 3: Check links and commit**

```sh
git diff --check
rg -n "global project|default thread|environment-id|storage-instance-id" docs/architecture docs/reference docs/user docs/testing
git add docs/architecture/overview.md docs/architecture/rpc-and-orchestration.md docs/architecture/worktree-catalog.md docs/reference/encyclopedia.md docs/user/workspace-ui.md docs/testing/cross-platform-validation.md docs/testing/execution-report-template.md
git commit -m "docs: define environment-owned project identity"
```
