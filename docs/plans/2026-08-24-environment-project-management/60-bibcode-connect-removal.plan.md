# BiBCode Connect Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the inherited BiBCode Connect product completely from active runtime code, schemas, UI, infrastructure, workflows, dependencies, persisted state, and living documentation while preserving the direct pairing and DPoP authentication introduced by Plans 20 and 30.

**Architecture:** Direct local, WSL, SSH-tunneled, and explicit HTTPS routes are the only connection mechanisms. Generic DPoP helpers move to their owning shared/client-auth modules before every Connect, Relay, Clerk, managed-endpoint, Cloudflare, and Alchemy surface is deleted. A bounded catalog decoder and one server cleanup migration remove legacy local state without becoming compatibility runtime; real external cloud resources are decommissioned only by an authorized operator following a manual runbook.

**Tech Stack:** Rust/Axum/Tokio/SQLite, TypeScript 7, Effect 4, React 19, IndexedDB, Web Crypto/JOSE, pnpm/Vite+, GitHub Actions, repository privacy/policy tests.

**Spec:** [BiBCode Connect removal specification](./04-bibcode-connect-removal.spec.md)

## Global Constraints

- Start only after Plans 20, 30, 40, and 50 have landed. Plan 20 owns the normalized catalog and bounded legacy decoder; Plan 30 owns generic pairing/DPoP and server transport admission.
- There is no hidden, disabled, deprecated, aliased, or feature-flagged Connect path after this plan. Normal runtime schemas contain no Relay route variant.
- Preserve generic administrator pairing, DPoP signing/verification, replay defense, revocation, and WebSocket tickets only when direct-route tests prove they are independently used.
- Do not preserve Connect-only JWT issuer/audience/configuration behind generic names. Delete `production/jwt.rs` if no direct caller remains after Plan 30.
- Do not delete or mutate deployed Cloudflare, Clerk, DNS, PostgreSQL, or Alchemy resources from application code, a migration, this implementation checkout, or ordinary CI.
- Historical files under `docs/plans/**` and `docs/superpowers/**`, `.repos/**`, and dated dependency ledgers remain immutable evidence. They are explicit negative-scan exclusions, not supported behavior.
- Never log or quarantine raw legacy tokens, pairing credentials, DPoP private keys, account IDs, relay URLs containing credentials, or database rows.
- Legacy cleanup is idempotent and fail-closed. Startup must not serve while Connect secrets remain because a cleanup phase failed.
- Do not delete user-created backups. The decommission runbook warns that backups can retain old credentials and requires credential rotation.
- Preserve current desktop release behavior while removing its Connect inputs. Server-only distribution is added separately in Plan 70.

---

## File Structure

- Create: `packages/shared/src/canonicalJson.ts`, test; update `dpop.ts` and package exports.
- Create or finalize after Plan 20: `packages/client-runtime/src/authorization/dpop.ts`, test — generic browser proof signer backed by the platform secret capability.
- Delete: `apps/web/src/cloud/**`, `apps/web/src/components/clerk/**`, `apps/web/src/components/cloud/**`.
- Delete after Plan 50 replacement: `apps/web/src/state/relay.ts` and the old Connect-specific `ConnectionsSettings*` implementation/tests.
- Delete: `packages/client-runtime/src/relay/**`, `packages/client-runtime/src/state/relayDiscovery.ts`; remove relay package exports.
- Delete: `packages/contracts/src/relay.ts`, `relay.test.ts`, `relayClient.ts`; remove relay fields/RPCs from active schemas.
- Delete: `packages/shared/src/relayAuth.ts`, `relayUrl.ts`, `relayJwt.ts`, `relaySigning.ts` and their tests/exports after generic extraction.
- Delete: `apps/server/src/cloud/**`, `production/connect_mcp*`, `production/jwt.rs`, `production/managed_endpoint.rs`, `production/relay.rs` and Connect-only tests.
- Modify: server lifecycle, runtime, HTTP/RPC/auth/provider/terminal modules and tests to remove Connect wiring.
- Create: server migration and cleanup receipt coverage for Connect-owned tables/files.
- Delete: `infra/relay/**`, `.github/workflows/deploy-relay.yml`, `docs/cloud/**`.
- Modify: `.github/workflows/release.yml`, `.env.example`, workspace/package manifests, lockfile, public-config/reference/coverage/privacy/release scripts and tests.
- Create: `docs/operations/legacy-cloud-decommission.md` — manual external-resource checklist and the sole living Connect reference.
- Create: `scripts/legacy-cloud-removal-contract.test.ts` — exact allowlisted negative policy.

### Task 1: Extract generic DPoP and canonical JSON before deleting Relay modules

**Files:**

- Create: `packages/shared/src/canonicalJson.ts`
- Create: `packages/shared/src/canonicalJson.test.ts`
- Modify: `packages/shared/src/dpop.ts`, `dpop.test.ts`, `package.json`
- Create or modify after Plan 20: `packages/client-runtime/src/authorization/dpop.ts`, `dpop.test.ts`, `index.ts`, `package.json`
- Modify: `packages/client-runtime/src/authorization/service.ts`, `layer.test.ts`, `remote.ts`, `remote.test.ts`
- Delete after callers migrate: `apps/web/src/cloud/dpop.ts`, `dpop.test.ts`, `packages/shared/src/relaySigning.ts`, `relaySigning.test.ts`
- Modify: `apps/web/package.json`, `packages/shared/package.json`, `pnpm-lock.yaml`

- [x] **Step 1: Write failing generic-helper and secret-bound signer tests**

Copy behavior, not Connect naming. Assert deterministic nested object/array encoding, omitted `undefined`, DPoP thumbprints, `htm`/normalized `htu`, fresh `jti`, optional `ath`, non-extractable imported key material, session-only fallback when the secret provider is unavailable, and no IndexedDB/localStorage private key.

```ts
expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
expect(await indexedDbNames()).not.toContain("bibcode:cloud-auth");
```

- [x] **Step 2: Run focused tests and confirm RED**

```sh
vp test packages/shared/src/canonicalJson.test.ts packages/shared/src/dpop.test.ts packages/client-runtime/src/authorization/dpop.test.ts
```

- [x] **Step 3: Move `stableStringify` into the generic owner**

Export `canonicalJson` from `@bibcode/shared/canonicalJson`, import it from `dpop.ts`, and delete the `relaySigning` export. Keep the exact thumbprint bytes covered so existing direct DPoP identities do not change accidentally.

- [x] **Step 4: Move browser DPoP signing behind client authorization**

Define a `DpopProofSigner` service under `packages/client-runtime/src/authorization/dpop.ts`. Resolve its P-256 private JWK through Plan 20's `EnvironmentSecretStore` with purpose `dpop-private-key`; import it as non-extractable for signing. In browser-only mode without a persistent secret provider, hold it in the current Effect scope and clearly report session-only authentication.

```ts
export class DpopProofSigner extends Context.Service<
  DpopProofSigner,
  {
    readonly thumbprint: Effect.Effect<string, DpopSignerError>;
    readonly createProof: (input: {
      readonly method: string;
      readonly url: string;
      readonly accessToken?: string;
    }) => Effect.Effect<string, DpopSignerError>;
  }
>()("@bibcode/client-runtime/authorization/DpopProofSigner") {}
```

- [x] **Step 5: Make direct pairing the only DPoP bootstrap**

Replace `RelayEnvironmentAuthorization`, `RelayManagedEndpoint`, `ManagedRelayDpopSigner`, and `/oauth/token` relay bootstrap assumptions in `authorization/service.ts` with Plan 30's verified route plus pairing exchange. The service receives an already identity-verified HTTPS/SSH/local route, redeems one one-time credential, stores only the returned session secret reference, and opens the WebSocket ticket using the same DPoP key.

- [x] **Step 6: Delete the legacy browser key database after safe cutover**

During Plan 20's `catalog-v1-to-v3` migration, request `indexedDB.deleteDatabase("bibcode:cloud-auth")` only after the generic signer has a durable OS-secret entry or has explicitly chosen session-only mode. Treat `blocked` as an incomplete cleanup receipt and retry on next startup; never copy `relay-dpop-proof-key` into normal IndexedDB.

- [x] **Step 7: Remove obsolete JOSE dependencies and run tests**

Keep `jose` only in the package that implements the generic browser signer. Remove it from `apps/web` and `packages/shared` when dependency tracing proves no other import remains; regenerate the lock through `vp install`.

```sh
vp test packages/shared/src/canonicalJson.test.ts packages/shared/src/dpop.test.ts packages/client-runtime/src/authorization/dpop.test.ts packages/client-runtime/src/authorization/remote.test.ts packages/client-runtime/src/authorization/layer.test.ts
vp run --filter @bibcode/shared typecheck
vp run --filter @bibcode/client-runtime typecheck
git add packages/shared packages/client-runtime/src/authorization packages/client-runtime/package.json apps/web/package.json packages/shared/package.json pnpm-lock.yaml apps/web/src/cloud/dpop.ts apps/web/src/cloud/dpop.test.ts apps/web/src/connection/catalogMigration.ts apps/web/src/connection/catalogMigration.test.ts
git commit -m "refactor(auth): extract direct DPoP primitives from Connect"
```

### Task 2: Remove Connect, Clerk, and managed Relay from the web application

**Files:**

- Delete: `apps/web/src/cloud/**`
- Delete: `apps/web/src/components/clerk/**`
- Delete: `apps/web/src/components/cloud/RelayClientInstallDialog.tsx`, test
- Delete after Plan 50 replacement: `apps/web/src/components/settings/ConnectionsSettings.tsx`, `ConnectionsSettings.logic.ts` and tests
- Delete: `apps/web/src/state/relay.ts`
- Modify: `apps/web/src/bootstrap.tsx`, `bootstrap.test.tsx`
- Modify: `apps/web/src/routes/__root.tsx`, `_chat.index.tsx` and tests
- Modify: `apps/web/src/connection/platform.ts`, `environmentPresentationPolicy.ts`, tests
- Modify: `apps/web/src/state/environments.ts`, runtime/bootstrap tests
- Modify: `apps/web/src/lib/runtime.ts`
- Modify: `apps/web/src/vite-env.d.ts`, `vite.config.ts`, `vite.config.app.mjs`, `package.json`
- Modify: root `vite.config.shared.ts`
- Modify: residual settings/add-project/primary-environment/state/zero-coverage tests that currently construct or mock Relay/Clerk
- Generate: `apps/web/src/routeTree.gen.ts`

- [x] **Step 1: Rewrite navigation/bootstrap tests around direct environments**

Assert that startup never constructs Clerk, reads relay public config, mounts an auth provider, refreshes managed environments, or opens an install dialog. The root contains only the environment center routes from Plan 50, and an unauthenticated direct environment renders Add Environment/pairing guidance rather than cloud sign-in.

- [x] **Step 2: Run the changed web tests and confirm RED**

```sh
vp test apps/web/src/bootstrap.test.tsx apps/web/src/routes/__root.test.tsx apps/web/src/routes/_chat.index.test.tsx apps/web/src/connection/environmentPresentationPolicy.test.ts apps/web/src/connection/platform.test.ts
```

- [x] **Step 3: Remove all Connect composition roots**

Delete `ManagedRelayAuthProvider`, `BiBCodeConnectSidebarSignIn`, link/unlink atoms, cloud public config, relay query state, cloud account session, and relay-client install dialog imports. Remove the root dialog mount and Clerk wrapper rather than replacing them with no-op components.

- [x] **Step 4: Remove Relay presentation and state branches**

Delete relay targets from environment presentation policy, platform capability composition, environment loaders, refresh wakeups, and state selectors. Plan 50's Environment workspace is the only settings entry; remove the old Connections implementation instead of leaving a redirect target with Connect code.

- [x] **Step 5: Delete public configuration and package inputs**

Remove `VITE_CLERK_*`, `BIBCODE_CLERK_*`, `VITE_BIBCODE_RELAY_URL`, and `BIBCODE_RELAY_URL` types/readers. Remove `@clerk/react` and web-owned `jose`. Re-run the route generator through the repository's normal Vite/TanStack command rather than editing generated route code by hand.

- [x] **Step 6: Verify the production web bundle**

```sh
vp test apps/web/src/bootstrap.test.tsx apps/web/src/routes/__root.test.tsx apps/web/src/routes/_chat.index.test.tsx apps/web/src/connection/environmentPresentationPolicy.test.ts apps/web/src/connection/platform.test.ts
vp run --filter @bibcode/web typecheck
vp run --filter @bibcode/web build
if rg -n -i "BiBCode Connect|clerk|cloudflared|managed.?relay|/api/connect" apps/web/dist; then exit 1; fi
git add -A apps/web
git commit -m "refactor(web): remove BiBCode Connect surfaces"
```

### Task 3: Delete Relay contracts, runtime variants, and shared modules

**Files:**

- Delete: `packages/contracts/src/relay.ts`, `relay.test.ts`, `relayClient.ts`
- Modify: `packages/contracts/src/environmentHttp.ts`, `environmentHttp.test.ts`, `rpc.ts`, `rpc.test.ts`, `auth.ts`, `auth.test.ts`, `ipc.ts`, `ipc.test.ts`, `package.json`
- Regenerate: `packages/contracts/fixtures/rpc-wire/manifest.json` and associated Rust wire fixtures
- Delete: `packages/client-runtime/src/relay/**`, `src/state/relayDiscovery.ts`
- Modify: `packages/client-runtime/src/connection/model.ts`, `catalog.ts`, `resolver.ts`, `supervisor.ts`, `registry.ts`, `storageIdentity.ts`, `presentation.ts`, `layer.ts` and tests
- Modify: `packages/client-runtime/src/platform/capabilities.ts`, `storageDocument.ts`, `storageDocument.test.ts`, `package.json`
- Modify: `packages/client-runtime/src/state/connections.ts`, `connections.test.ts`
- Delete: `packages/shared/src/relayAuth.ts`, `relayAuth.test.ts`, `relayUrl.ts`, `relayUrl.test.ts`, `relayJwt.ts`, `relayJwt.test.ts`, `relaySigning.ts`, `relaySigning.test.ts`
- Modify: `packages/shared/package.json`
- Regenerate: Rust contract fixtures/parity outputs through the checked-in generator

- [x] **Step 1: Write migration-boundary and active-schema tests**

Assert Relay-only v1 is discarded, mixed Relay/direct state keeps only identity-proved direct routes, old `relayManaged` IPC fields are read only by the bounded decoder, and v3 rejects every old tag. Assert generated OpenAPI/RPC/auth schemas contain no Connect route, cloud RPC, relay scope, or managed endpoint.

```ts
expect(Schema.decodeUnknownEither(EnvironmentRoute)(legacyRelayRoute)._tag).toBe("Left");
expect(migrateLegacyCatalog(mixedFixture).routes.map((route) => route.kind)).toEqual(["https"]);
```

- [x] **Step 2: Run contract/runtime tests and confirm RED**

```sh
vp test packages/contracts/src/environmentHttp.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/auth.test.ts packages/contracts/src/ipc.test.ts packages/client-runtime/src/platform/storageDocument.test.ts packages/client-runtime/src/connection/catalog.test.ts packages/client-runtime/src/connection/resolver.test.ts packages/client-runtime/src/connection/supervisor.test.ts
```

- [x] **Step 3: Delete active Relay schemas and exports**

Remove `RelayConnectionTarget`, `RelayConnectionRegistration`, `RelayManagedEndpoint`, Relay client schemas, cloud route groups, `relay:read`, `relay:write`, cloud install RPCs, and `relayManaged` from active IPC shapes. Regenerate the Rust parity fixtures and fix exhaustive matches without adding a compatibility alias.

- [x] **Step 4: Remove the Relay runtime package and wakeups**

Delete discovery/query/managed-relay modules and exports `./relay` and `./state/relay`. Remove Relay branches from catalog, resolver, registry, supervisor generation, connection errors, presentation, storage-identity checks, platform capability requirements, and connection state cleanup.

- [x] **Step 5: Keep one private legacy decoder only**

The unexported `LegacyConnectionCatalogV1` in Plan 20 may recognize exact old `_tag` strings long enough to discard them. It must return new records or a bounded redacted repair receipt; no returned union, public index, supervisor, renderer, or RPC type can contain an old Relay tag.

- [x] **Step 6: Delete Connect-only shared modules and run parity checks**

```sh
vp test packages/contracts/src/environmentHttp.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/auth.test.ts packages/contracts/src/ipc.test.ts packages/client-runtime/src/platform/storageDocument.test.ts packages/client-runtime/src/connection packages/client-runtime/src/state/connections.test.ts packages/shared/src/dpop.test.ts
vp run check:contracts
vp run --filter @bibcode/contracts typecheck
vp run --filter @bibcode/client-runtime typecheck
git add -A packages/contracts packages/client-runtime packages/shared
git commit -m "refactor(runtime): delete Relay contracts and connection variants"
```

### Task 4: Remove Connect MCP, managed endpoint, cloudflared, and cloud RPCs from the server

**Files:**

- Delete: `apps/server/src/cloud/mod.rs`
- Delete: `apps/server/src/production/connect_mcp.rs`, `production/connect_mcp/tests.rs`
- Delete: `apps/server/src/production/managed_endpoint.rs`, `production/relay.rs`
- Delete if direct auth has no caller: `apps/server/src/production/jwt.rs`
- Delete: `apps/server/tests/production_connect_mcp.rs`, `production_relay.rs`, `production_jwt.rs`, `cloud_observability_text_generation_domain.rs`
- Modify: `apps/server/src/lib.rs`, `lifecycle.rs`, `http.rs`, `maintenance.rs`
- Modify: `apps/server/src/production/mod.rs`, `runtime.rs`, `provider_runtime.rs`, `server_terminal.rs`, `http_routes.rs`
- Modify: `apps/server/src/auth/model.rs`, `auth/scope.rs`, tests
- Modify: `apps/server/src/rpc/methods.rs`, tests and generated RPC parity fixtures
- Modify: `apps/server/tests/production_http_routes.rs`, `production_server_terminal_rpc.rs`, `server_runtime.rs`, `turn_delivery_recovery.rs`, `project_data_safety.rs`, `auth_http.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs` and its RPC method-inventory tests
- Modify: `Cargo.toml`, `apps/server/Cargo.toml`, `Cargo.lock`

- [x] **Step 1: Rewrite server surface tests with a denied-route matrix**

Remove positive Connect expectations and assert that every former `/api/connect/**` route and `/mcp` Connect handler returns the ordinary not-found response without a compatibility redirect. Assert `cloud.getRelayClientStatus` and `cloud.installRelayClient` are absent from the RPC registry and maintenance allowlist.

- [x] **Step 2: Run focused tests and confirm RED**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_http_routes -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_server_terminal_rpc -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test server_runtime -- --nocapture
```

- [x] **Step 3: Remove lifecycle and runtime composition**

Stop opening `environment-jwt.json`, constructing `ConnectMcpService`, attaching it to `provider_runtime`, resolving/installing cloudflared, or starting `bibcode-connect`. Remove Connect fields from runtime/service constructors and update all fixtures to construct the smaller direct-only service graph.

- [x] **Step 4: Remove HTTP, MCP, provider, terminal, and RPC entry points**

Delete Connect JSON operations/routes, cloud proof/mint/unlink handlers, Connect MCP route mounting, provider-session publication hooks, cloud relay terminal handlers, serializers, method inventory, and relay auth scope mapping. Preserve the ordinary agent MCP/provider behavior only where its independent tests demonstrate use; do not remove generic MCP support merely because the Connect endpoint used MCP internally.

- [x] **Step 5: Remove Connect-only crypto dependencies**

Run `cargo tree -i ed25519-dalek`. If no non-Connect caller remains, remove `ed25519-dalek` from `apps/server/Cargo.toml` and the workspace dependency table and regenerate `Cargo.lock`. Retain generic DPoP P-256 verification used by Plan 30.

- [x] **Step 6: Preserve project/worktree and direct-auth safety coverage**

Replace the Connect setup in `project_data_safety.rs` with a Plan 30 administrator pairing session. Update turn-delivery/runtime fixture constructors without weakening their assertions. Run direct pairing, DPoP, revocation, WebSocket, provider, project, thread, worktree, and process-lifecycle tests.

- [x] **Step 7: Run server gates and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test auth_http -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test project_data_safety -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test turn_delivery_recovery -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_server_terminal_rpc -- --nocapture
node scripts/run-msvc-x64.mjs cargo clippy -p bibcode-server --all-targets -- -D warnings
git add -A Cargo.toml Cargo.lock apps/server
git commit -m "refactor(server): remove BiBCode Connect runtime"
```

### Task 5: Securely clean Connect-owned server and client state

**Files:**

- Modify: `apps/server/src/persistence/migrations.rs`, `mod.rs`
- Create: `apps/server/src/persistence/legacy_connect_cleanup.rs`
- Test: `apps/server/tests/legacy_connect_cleanup.rs`, `persistence_migrations.rs`
- Modify: `apps/server/src/lifecycle.rs`, `apps/server/src/production/host_paths.rs`
- Modify: `apps/web/src/connection/catalogMigration.ts`, `catalogMigration.test.ts`
- Modify: `apps/web/src/connection/storage.ts`, `storage.test.ts`

**Owned legacy state:**

- SQLite tables `connect_native_secrets` and `connect_native_replay`.
- Server state file `environment-jwt.json`.
- Server-managed directory `tools/cloudflared/`.
- Client database `bibcode:cloud-auth` and the exact key `relay-dpop-proof-key`.
- Relay/Connect catalog rows, tokens, account metadata, public config, caches, and OS-secret references identified by the bounded Plan 20 decoder.

- [x] **Step 1: Write failpoint, symlink, and redaction tests**

Cover clean install, both tables present, one table missing, WAL mode, locked DB, failure before/after table drop, interrupted VACUUM, read-only state root, malicious symlink/reparse point at each owned file/directory, retry after receipt, and a backup file left untouched. Seed unique secret canaries and assert they never appear in logs/errors/receipts.

- [x] **Step 2: Add an idempotent schema migration**

While the store lock is exclusive, set `PRAGMA secure_delete = ON` on the migration connection and verify that SQLite reports it enabled. Then, within one exclusive migration transaction, drop the two exact Connect tables if present and write a schema migration record. Do not enumerate or copy secret rows. Close ordinary repository handles before the privacy cleanup phase.

- [x] **Step 3: Complete the one-time SQLite privacy cleanup before serving**

Outside the schema transaction and while the store lock is still exclusive, checkpoint/truncate WAL, run `VACUUM` with `secure_delete` still enabled, and write a non-secret receipt containing only cleanup version and completion time. If any phase fails, return an actionable startup error and retry next launch; do not accept requests with a partial receipt.

```rust
pub struct LegacyConnectCleanupReceipt {
    pub version: u32,
    pub sqlite_compacted: bool,
    pub owned_paths_removed: bool,
}
```

- [x] **Step 4: Delete only verified owned paths**

Resolve the canonical state root without following a leaf symlink/reparse point. Remove the exact regular file `environment-jwt.json` and exact directory tree `tools/cloudflared` only when every ancestor is inside the verified root and no traversed entry escapes it. Refuse and report a safe manual-cleanup path on ownership/type mismatch.

- [x] **Step 5: Complete client catalog and secret cleanup**

Use Plan 20's atomic migration to discard Connect rows and caches, request deletion of exact OS-secret references, and then delete `bibcode:cloud-auth`. A relay-only environment is forgotten locally with an explicit migration note; never report remote uninstall or purge. Preserve a mixed environment only when a direct route proves both environment and accepted storage identity.

- [x] **Step 6: Document backup and rotation consequences in the operator runbook**

Do not delete `.bak`, snapshots, Time Machine, Volume Shadow Copy, or copied data roots. The runbook requires rotation/revocation of old Clerk/Cloudflare/Connect credentials because backups may retain them.

- [x] **Step 7: Run cleanup tests and commit**

```sh
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test legacy_connect_cleanup -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test persistence_migrations -- --nocapture
vp test apps/web/src/connection/catalogMigration.test.ts apps/web/src/connection/storage.test.ts
git add apps/server/src/persistence apps/server/src/lifecycle.rs apps/server/src/production/host_paths.rs apps/server/tests/legacy_connect_cleanup.rs apps/server/tests/persistence_migrations.rs apps/web/src/connection/catalogMigration.ts apps/web/src/connection/catalogMigration.test.ts apps/web/src/connection/storage.ts apps/web/src/connection/storage.test.ts
git commit -m "fix(storage): erase legacy Connect state safely"
```

### Task 6: Delete relay infrastructure, deployment workflow, configuration, and dependencies

**Files:**

- Delete: `infra/relay/**`
- Delete: `.github/workflows/deploy-relay.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.env.example`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- Modify: `scripts/lib/public-config.ts`, `public-config.test.ts`
- Modify: `scripts/release-smoke.ts`, `release-smoke.test.ts`
- Modify: `scripts/privacy-contract.test.ts`, `toolchain-contract.test.ts`, `coverage-config.test.ts`
- Modify: `scripts/lib/reference-repos.ts`, `reference-repos.test.ts`
- Modify: `scripts/sync-reference-repos.ts`, `sync-reference-repos.test.ts`
- Modify: `scripts/bibcode-identity.test.ts`, `release-workflow.test.ts`
- Modify: `vite.config.shared.ts` and `oxlint-plugin-bibcode/rules/no-manual-effect-runtime-in-tests.ts` to remove relay coverage/exception entries
- Modify: root `AGENTS.md` to remove the obsolete Alchemy/relay-specific reference instruction

- [x] **Step 1: Rewrite workflow/tooling policy tests to require absence**

Replace assertions that deploy/configure the relay with assertions that no workflow job, package importer, public-config field, release-smoke package, coverage include, or identity inventory references it. Keep general privacy environment controls such as `DO_NOT_TRACK` only when another dependency actively uses them.

- [x] **Step 2: Run policy tests and confirm RED**

```sh
vp test scripts/lib/public-config.test.ts scripts/privacy-contract.test.ts scripts/toolchain-contract.test.ts scripts/coverage-config.test.ts scripts/lib/reference-repos.test.ts scripts/sync-reference-repos.test.ts scripts/release-smoke.test.ts scripts/release-workflow.test.ts
```

- [x] **Step 3: Delete deployment capability and release coupling**

Delete `infra/relay` and `deploy-relay.yml`. Remove the `relay_public_config` job, Clerk/Cloudflare environment variables, its outputs, and every `needs.relay_public_config` edge from `release.yml`. Preserve the existing desktop build/sign/update job behavior and prove its dependency graph remains acyclic.

- [x] **Step 4: Remove public config and workspace dependencies**

Delete Clerk and relay variables from `.env.example` and `scripts/lib/public-config.ts`. Remove the relay workspace importer; Clerk packages and overrides; and Cloudflare/Alchemy/PostgreSQL catalog entries that have no remaining consumer. Remove only now-unused dependencies, not packages based on name alone.

- [x] **Step 5: Remove the Alchemy reference-repo coupling**

Delete the active `alchemy-effect` entry whose version source is `infra/relay/package.json` and update sync tests/unknown-ID expectations. Do not edit or delete `.repos/alchemy-effect`; it remains read-only, inert historical reference material excluded by policy.

- [x] **Step 6: Regenerate lockfile and inspect dependency closure**

```sh
vp install
vp exec pnpm why @clerk/react @clerk/backend @cloudflare/workers-types alchemy pg
cargo tree -i ed25519-dalek
```

Each `why`/`cargo tree` command must return no Connect-owned production path; investigate any remaining caller instead of forcing lockfile deletion.

- [x] **Step 7: Run workflow/tooling gates and commit**

```sh
vp test scripts/lib/public-config.test.ts scripts/privacy-contract.test.ts scripts/toolchain-contract.test.ts scripts/coverage-config.test.ts scripts/lib/reference-repos.test.ts scripts/sync-reference-repos.test.ts scripts/release-smoke.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts
vp run release:smoke
git add -A infra/relay .github/workflows .env.example pnpm-workspace.yaml pnpm-lock.yaml scripts AGENTS.md
git commit -m "build: delete Connect infrastructure and dependencies"
```

### Task 7: Rewrite living documentation and add a manual external decommission runbook

**Files:**

- Delete: `docs/cloud/bibcode-connect-clerk.md`, `bibcode-connect-auth-flow.md`, `environment-auth.md`
- Modify: `docs/README.md`, root `README.md`
- Modify: `docs/architecture/overview.md`, `connection-runtime.md`, affected security/runtime documents
- Modify: `docs/user/**`, `docs/operations/**`, `docs/reference/**`, `docs/testing/**`
- Create: `docs/operations/legacy-cloud-decommission.md`
- Modify: `docs/operations/release.md`, privacy/security documentation indexes

- [x] **Step 1: Inventory every living Connect claim before deletion**

```sh
rg -n -i "BiBCode Connect|Clerk|cloudflared|managed endpoint|relay environment|infra/relay|BIBCODE_RELAY|BIBCODE_CLERK" README.md docs AGENTS.md .env.example --glob '!docs/plans/**' --glob '!docs/superpowers/**' --glob '!docs/dependency-upgrades/2026-07-17-ledger.json'
```

Classify each hit as obsolete guidance to delete, architecture to rewrite for direct routes, or the one authorized decommission reference.

- [x] **Step 2: Rewrite living product and architecture documentation**

Document only local/WSL, SSH-tunnel, and explicit HTTPS enrollment, Plan 30's local pairing/control channel, full-administrator clients, server-owned environments/projects/worktrees, no plaintext non-loopback HTTP, and no hosted account/control plane.

- [x] **Step 3: Create a manual decommission runbook from the deleted infrastructure inventory**

The runbook must identify resource classes and how to verify ownership without embedding credentials: GitHub environment/repository secrets and variables; Cloudflare Worker, custom domain/DNS, tunnel/service/API tokens; Clerk application, JWT template, OAuth app, passkey domains and keys; Alchemy-managed PostgreSQL/database resources; deployment logs/state; and backups.

Require this order and an explicit operator confirmation at every destructive dashboard/API step:

1. Export an ownership/resource inventory and retain approved audit evidence.
2. Disable new links/deployments and confirm released clients no longer use Connect.
3. Revoke/rotate service, tunnel, Clerk, database, and GitHub credentials.
4. Remove DNS/custom domains only after traffic and client-version checks.
5. Delete worker/tunnel/database/application resources through their owning dashboards.
6. Remove repository secrets/variables after the dependent resources are gone.
7. Verify no unexpected Connect traffic and document retained backups/rotation.

State prominently that neither app migration nor repository checkout performs these external actions.

- [x] **Step 4: Update all affected testing runbooks**

Replace cloud/relay setup with direct environment enrollment and add checks that native Windows, macOS, Linux, WSL, SSH, packaged UI, and diagnostics runs make no Clerk/Cloudflare request. Keep execution-specific results in the report template, not living procedures.

- [x] **Step 5: Run documentation link/search checks and commit**

```sh
vp check
rg -n -i "BiBCode Connect|Clerk|cloudflared|managed endpoint|infra/relay" README.md docs AGENTS.md --glob '!docs/plans/**' --glob '!docs/superpowers/**' --glob '!docs/dependency-upgrades/2026-07-17-ledger.json' --glob '!docs/operations/legacy-cloud-decommission.md'
git add -A README.md docs AGENTS.md
git commit -m "docs: replace Connect guidance with direct environments"
```

The final `rg` must produce no output.

### Task 8: Enforce negative source, bundle, dependency, and network policy

**Files:**

- Create: `scripts/legacy-cloud-removal-contract.test.ts`
- Modify: `scripts/privacy-contract.test.ts`, `release-smoke.ts`, `release-smoke.test.ts`
- Modify: root package/Vite+ test configuration only if needed to include the new policy test
- Test artifacts: compiled web output and server binary/string inventory generated by existing build commands

- [x] **Step 1: Write an exact active-tree negative scanner**

Match product, vendor, endpoint, executable, and configuration patterns
case-insensitively; match Rust/TypeScript symbol names exactly:

```text
BiBCode Connect
bibcode-connect
connect_mcp
ConnectMcp
RelayConnectionTarget
RelayConnectionRegistration
ManagedRelay
managed_endpoint
ManagedEndpoint
cloudflared
BIBCODE_RELAY
VITE_BIBCODE_RELAY
BIBCODE_CLERK
VITE_CLERK
@clerk/
SCOPE_RELAY
AuthRelay
/api/connect
cloud.getRelayClientStatus
cloud.installRelayClient
infra/relay
```

Do not forbid the generic English words `connect`, `cloud`, or `relay` because unrelated documentation, network forwarding, or third-party fixtures may legitimately use them.

- [x] **Step 2: Encode the narrow allowlist**

Allow only:

- `docs/plans/**` and `docs/superpowers/**` historical records;
- `.repos/**` read-only upstream sources;
- the exact dated `docs/dependency-upgrades/2026-07-17-ledger.json` snapshot;
- `scripts/legacy-cloud-removal-contract.test.ts` itself;
- the exact bounded legacy catalog decoder/test lines needed to discard old tags;
- `docs/operations/legacy-cloud-decommission.md`.

Fail if an allowlisted path grows to cover a directory or active module not named above. Print only path, line, and matched pattern—never the entire possibly secret-bearing line.

- [x] **Step 3: Add dependency and built-artifact assertions**

Parse manifests/lockfile to reject Connect-owned importers/packages. Build web and server release artifacts, scan their strings/assets for the forbidden patterns, and inspect route/method inventories. A source-only scan is insufficient.

- [x] **Step 4: Add no-unexpected-outbound network tests**

Run cold startup, ordinary local use, pairing, diagnostics export, and intentional crash handling against a deny-by-default test proxy/socket harness. Allow only the explicitly configured local/SSH/HTTPS environment endpoint and documented updater endpoint when the update check is deliberately invoked. Assert zero Clerk, Cloudflare relay, telemetry, or crash-upload destinations.

- [x] **Step 5: Run all removal and privacy gates**

```sh
vp test scripts/legacy-cloud-removal-contract.test.ts scripts/privacy-contract.test.ts scripts/release-smoke.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts
vp check
vp run typecheck
vp run test
vp run check:contracts
cargo fmt --all --check
node scripts/run-msvc-x64.mjs cargo test --workspace -j 2
node scripts/run-msvc-x64.mjs cargo clippy --workspace --all-targets -- -D warnings
vp run --filter @bibcode/web build
vp run release:smoke
```

- [x] **Step 6: Inspect final active surfaces and commit**

```sh
git diff --check
git diff --stat
git status --short
git add scripts/legacy-cloud-removal-contract.test.ts scripts/privacy-contract.test.ts scripts/release-smoke.ts scripts/release-smoke.test.ts
git commit -m "test(policy): forbid BiBCode Connect remnants"
```

Do not mark Plan 60 complete until the only negative-scan hits are the exact historical, migration, policy-test, and manual-decommission allowlist entries, and no packaged artifact or normal startup makes an unexpected outbound request.

## Execution Record — 2026-08-26

Plan 60 is complete. The active Connect/Relay/Clerk runtime, UI, schemas,
infrastructure, workflow inputs, dependencies, and living-documentation claims
were removed. Generic direct-route DPoP remains independently covered. Legacy
local state is deleted through an idempotent, symlink-safe, fail-closed cleanup
with a durable receipt; external service deletion remains an explicit manual
operator procedure.

Final evidence included:

- `vp test scripts/legacy-cloud-removal-contract.test.ts scripts/privacy-contract.test.ts scripts/release-smoke.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts` — 5 files, 32 tests passed.
- `vp run typecheck`, `vp check`, `vp run check:contracts`, `cargo fmt --all --check`, and `node scripts/run-msvc-x64.mjs cargo clippy --workspace --all-targets -- -D warnings` — passed.
- The JavaScript workspace suites, web suite (5,502 passed, 22 skipped), Rust desktop suite (392 passed), and Rust server library suite (1,639 passed, 2 ignored) passed; focused changed integration suites also passed.
- `vp run release:smoke` built and scanned the optimized server and 564 web artifacts without a forbidden marker.
- `apps/server/tests/no_unexpected_outbound.rs` passed with outbound traffic denied except for deliberately configured endpoints.
- `git diff --check` passed.

The parallel `provider_terminal_supervisor` binary exposed one pre-existing
scheduler-sensitive timeout. The exact test passed in isolation, and all 99
tests in that binary passed with `--test-threads=1`; no unrelated supervisor
production code was changed. The macOS linker also emitted its existing compact
unwind warning during Rust tests, but the relevant commands exited successfully.
