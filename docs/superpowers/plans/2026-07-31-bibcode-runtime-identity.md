# BiBCode Runtime Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BiBCode the canonical runtime identity for environment variables, persisted state, filesystem paths, network/auth protocols, hosted configuration, Tauri identity, and diagnostics while preserving deliberate read compatibility for installations and automation that use the retired identity.

**Architecture:** Introduce minimal new-name-first fallback helpers at each persistence boundary. New clients write BiBCode identifiers; readers accept and migrate legacy values without deleting them. Protocol servers temporarily accept both routes/types while every repository-owned client emits only BiBCode values.

**Tech Stack:** TypeScript 7, browser Storage/IndexedDB, Rust 1.97.1 stdlib/Tokio, Tauri 2.11.4, Effect configuration, Axum/Effect HTTP APIs, pnpm/Cargo tests.

## Global Constraints

- Run only after the visible and code-identity plans pass.
- Canonical environment prefix: `BIBCODE_`.
- Canonical filesystem directory: `.bibcode`.
- Canonical browser persistence prefix: `bibcode`.
- Canonical HTTP/auth/protocol prefix: `bibcode`.
- Canonical Tauri identifier: `com.bibcode.desktop`.
- New names always take precedence; legacy names are read-only fallbacks.
- Never delete legacy user settings or data during migration.
- Keep every legacy exception in one audited allowlist with a reason.
- Do not modify `.repos`, dependency directories, build output, caches, or CodeGraph data.
- Do not stage, commit, push, release, or publish anything.

---

### Task 1: Environment Variable Migration

**Files:**

- Create: `packages/shared/src/environmentIdentity.ts`
- Create: `packages/shared/src/environmentIdentity.test.ts`
- Modify: documented/public environment readers in `scripts/*.ts`
- Modify: `scripts/lib/public-config.ts`
- Modify: `apps/web/vite.config.app.mjs`
- Modify: `apps/web/src/cloud/publicConfig.ts`
- Modify: `apps/server/src/config.rs`
- Modify: `apps/server/src/logging.rs`
- Modify: `apps/server/src/source_control/pull_request.rs`
- Modify: `apps/server/src/production/relay.rs`
- Modify: `apps/server/src/provider_usage/mod.rs`
- Modify: `apps/desktop/src-tauri/src/config.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `.env.example`
- Modify: `infra/relay/.env.example`
- Modify: `.github/workflows/*.yml`
- Modify: affected tests and documentation

**Interfaces:**

- Produces: `readBiBCodeEnvironmentVariable(env, suffix): string | undefined`, which checks `BIBCODE_<suffix>` before `BIBCODE_<suffix>`.
- Consumes: Node-style `Readonly<Record<string, string | undefined>>`; Rust receives an equivalent new-first helper.

- [ ] **Step 1: Write the failing TypeScript fallback tests**

```ts
expect(readBiBCodeEnvironmentVariable({ BIBCODE_PORT: "1", BIBCODE_PORT: "2" }, "PORT")).toBe("1");
expect(readBiBCodeEnvironmentVariable({ BIBCODE_PORT: "2" }, "PORT")).toBe("2");
expect(readBiBCodeEnvironmentVariable({}, "PORT")).toBeUndefined();
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
vp test packages/shared/src/environmentIdentity.test.ts
```

Expected: module/function is missing.

- [ ] **Step 3: Implement the minimal TypeScript helper**

```ts
export function readBiBCodeEnvironmentVariable(
  env: Readonly<Record<string, string | undefined>>,
  suffix: string,
): string | undefined {
  return env[`BIBCODE_${suffix}`] ?? env[`BIBCODE_${suffix}`];
}
```

- [ ] **Step 4: Add equivalent Rust new-first tests and helper**

At the configuration boundary, use an injected map in tests and this ownership
rule in production:

```rust
fn bibcode_env_var(new_name: &str, legacy_name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(new_name).or_else(|| std::env::var_os(legacy_name))
}
```

Do not mutate the process environment globally. Use the helper only for public
inputs; parent/child markers wholly owned by this repository are renamed at
both ends without a fallback.

- [ ] **Step 5: Migrate public keys and internal markers**

Apply `BIBCODE_*` as canonical for documented configuration including HOME,
HOST, PORT, PORT_OFFSET, MODE, NO_BROWSER, LOG, Bitbucket, Clerk, relay,
cloudflared, signing, WSL binary, web sourcemap, and desktop build inputs.
Update CI and docs. Rename private test/process markers directly because their
producer and consumer ship together.

- [ ] **Step 6: Verify environment behavior**

```powershell
vp test packages/shared/src/environmentIdentity.test.ts scripts/lib/public-config.test.ts scripts/dev-runner.test.ts scripts/build-desktop-artifact.test.ts
cargo test --locked -p bibcode-server config -- --test-threads=1
cargo test --locked -p bibcode-desktop config -- --test-threads=1
```

Expected: new-name precedence, old-name fallback, and missing-value behavior all
pass.

- [ ] **Step 7: Review without staging or committing**

```powershell
rg -n --hidden --glob '!.repos/**' --glob '!node_modules/**' --glob '!target/**' 'BIBCODE_[A-Z0-9_]+' .
```

Every remaining match must be a fallback constant, fallback test, migration
documentation line, or allowlist entry—not a canonical write or CI setting.

### Task 2: Filesystem Home, Config, Cache, Log, and Worktree Paths

**Files:**

- Create: `apps/server/src/identity_paths.rs`
- Create: `apps/server/tests/identity_paths.rs`
- Modify: `apps/server/src/lib.rs`
- Modify: `apps/server/src/config.rs`
- Modify: `apps/server/src/git/repository.rs`
- Modify: `apps/server/src/diagnostic_bundle.rs`
- Modify: `apps/desktop/src-tauri/src/config.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/ssh.rs`
- Modify: `scripts/dev-runner.ts`
- Modify: affected adjacent tests and docs

**Interfaces:**

- Produces: `resolve_bibcode_directory(new_path: &Path, legacy_path: &Path) -> Result<PathBuf, IdentityPathMigrationError>`.
- Behavior: use existing new path; otherwise copy an existing legacy directory through a sibling staging directory and atomically rename; never delete legacy data.

- [ ] **Step 1: Write migration tests**

Cover these exact cases:

```rust
// new exists -> return new and do not inspect/copy legacy
// only legacy exists -> copy bytes to new, return new, keep legacy
// neither exists -> return new without creating it
// copy failure -> return error, keep legacy, remove only owned staging path
// destination collision -> fail without overwriting either tree
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

```powershell
cargo test --locked -p bibcode-server --test identity_paths -- --test-threads=1
```

- [ ] **Step 3: Implement staged stdlib directory copying**

Use `std::fs`/`tokio::fs` already present. Create a uniquely owned sibling such
as `.bibcode-migration-<uuid>.stage`, recursively copy files/directories without
following symlinks outside the legacy root, then rename it to `.bibcode` only
when the destination is still absent. On error, remove only the verified owned
staging path; never move or delete the legacy data tree.

- [ ] **Step 4: Route all default path owners through the helper**

Canonicalize:

```text
retired home directory        -> ~/.bibcode
retired worktree directory    -> .bibcode-worktrees
retired provider directories  -> .bibcode-provider-*
retired diagnostics prefix    -> bibcode-diagnostics-*
retired SSH/runner prefixes   -> bibcode-ssh-* / run-bibcode
```

Desktop, server, dev runner, and SSH launch scripts must resolve the same
migrated base directory. Explicit `--base-dir`/home overrides are not rewritten.

- [ ] **Step 5: Verify path migration and callers**

```powershell
cargo test --locked -p bibcode-server --test identity_paths -- --test-threads=1
cargo test --locked -p bibcode-server config -- --test-threads=1
cargo test --locked -p bibcode-server git -- --test-threads=1
cargo test --locked -p bibcode-desktop backend -- --test-threads=1
cargo test --locked -p bibcode-desktop ssh -- --test-threads=1
cargo test --locked -p bibcode-desktop config -- --test-threads=1
vp test scripts/dev-runner.test.ts
```

- [ ] **Step 6: Review without staging or committing**

Audit the retired filesystem-path variants. Only the migration source
constant/tests/docs and the final allowlist may remain.

### Task 3: Browser LocalStorage and IndexedDB Migration

**Files:**

- Create: `apps/web/src/storageIdentity.ts`
- Create: `apps/web/src/storageIdentity.test.ts`
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/hooks/useTheme.ts`
- Modify: `apps/web/src/activityDockStore.ts`
- Modify: `apps/web/src/clientPersistenceStorage.ts`
- Modify: `apps/web/src/centerPanelStore.ts`
- Modify: `apps/web/src/composerDraftStore.ts`
- Modify: `apps/web/src/components/ChatView.logic.ts`
- Modify: `apps/web/src/versionSkew.ts`
- Modify: `apps/web/src/uiStateStore.ts`
- Modify: `apps/web/src/terminalUiStateStore.ts`
- Modify: `apps/web/src/sidebarWorkspaceMetaStore.ts`
- Modify: `apps/web/src/sourceControlPanelStore.ts`
- Modify: `apps/web/src/diffPanelStore.ts`
- Modify: `apps/web/src/rightPanelStore.ts`
- Modify: `apps/web/src/providerUpdateDismissal.ts`
- Modify: `apps/web/src/editorPreferences.ts`
- Modify: `apps/web/src/components/files/FilePreviewPanel.tsx`
- Modify: `apps/web/src/components/preview/PreviewPanelShell.tsx`
- Modify: `apps/web/src/tauriDesktopBridge.ts`
- Modify: `apps/web/src/connection/storage.ts`
- Modify: `apps/web/src/cloud/dpop.ts`
- Modify: affected tests

**Interfaces:**

- Produces: `migrateStorageValue(storage, canonicalKey, legacyKeys): string | null`.
- Behavior: read canonical first; otherwise copy the first legacy value to canonical and return it; never remove the legacy key.

- [ ] **Step 1: Write local-storage migration tests**

Using a fixture-defined retired theme key, assert that migration returns its
value, writes the canonical `bibcode:theme` key, and leaves the retired key
untouched.

Also assert that an existing canonical value wins and is not overwritten.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
vp test apps/web/src/storageIdentity.test.ts
```

- [ ] **Step 3: Implement the minimal storage helper**

```ts
export function migrateStorageValue(
  storage: Pick<Storage, "getItem" | "setItem">,
  canonicalKey: string,
  legacyKeys: readonly string[],
): string | null {
  const current = storage.getItem(canonicalKey);
  if (current !== null) return current;
  for (const legacyKey of legacyKeys) {
    const legacy = storage.getItem(legacyKey);
    if (legacy !== null) {
      storage.setItem(canonicalKey, legacy);
      return legacy;
    }
  }
  return null;
}
```

- [ ] **Step 4: Canonicalize every browser storage key**

Change new writes to `bibcode:*`/`bibcode.*`. Before each store initializes,
migrate its exact old key through `migrateStorageValue`. Keep legacy renderer
version arrays readable but write only the canonical BiBCode state key.

- [ ] **Step 5: Migrate the two IndexedDB databases**

For the retired connection-runtime and cloud-auth database names, open the
canonical `bibcode:connection-runtime` and `bibcode:cloud-auth` databases first.
If a canonical database does not exist but the corresponding legacy database
does, copy
each known object store and record in a single upgrade/migration flow, close
both databases, and then reopen the canonical database. Do not delete the old
database. Add fake-IndexedDB tests for precedence, copy success, empty legacy,
and aborted transaction behavior.

- [ ] **Step 6: Run storage tests**

```powershell
vp test apps/web/src/storageIdentity.test.ts apps/web/src/clientPersistenceStorage.test.ts apps/web/src/uiStateStore.test.ts apps/web/src/connection/storage.test.ts apps/web/src/cloud/dpop.test.ts
```

Expected: new writes use BiBCode keys and legacy data remains readable and
untouched.

- [ ] **Step 7: Review without staging or committing**

Audit the retired browser-persistence prefix; only fallback constants/tests and
the final allowlist may remain.

### Task 4: HTTP, IPC, Auth, Relay, and Serialized Protocol Compatibility

**Files:**

- Modify: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/environmentHttp.ts`
- Modify: `packages/contracts/src/relay.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/shared/src/relayJwt.ts`
- Modify: `packages/client-runtime/src/environment/descriptor.ts`
- Modify: `apps/server/src/http.rs`
- Modify: `apps/server/src/auth/model.rs`
- Modify: `apps/server/src/auth/service.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/src/production/http_routes.rs`
- Modify: `apps/server/src/production/connect_mcp.rs`
- Modify: `apps/server/src/production/managed_endpoint.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/bridge.rs`
- Modify: `apps/desktop/src-tauri/src/ssh.rs`
- Modify: `apps/desktop/src-tauri/src/tailscale.rs`
- Modify: `infra/relay/src/auth/RelayTokens.ts`
- Modify: `infra/relay/src/environments/EnvironmentConnector.ts`
- Modify: `infra/relay/src/environments/EnvironmentLinker.ts`
- Modify: affected contract, fixture, client, server, desktop, and relay tests

**Interfaces:**

- Produces: canonical `bibcode` routes, headers, URNs, JWT `typ`/issuer/audience values, cookie/client IDs, and serialized action discriminants.
- Compatibility: servers/decoders accept the exact retired value while
  repository clients/encoders emit only the canonical `bibcode` value.

- [ ] **Step 1: Change contract tests to canonical emissions plus legacy acceptance**

Representative expectations:

```ts
expect(environmentDescriptorPath).toBe("/.well-known/bibcode/environment");
expect(AuthEnvironmentBootstrapTokenType).toBe(
  "urn:bibcode:params:oauth:token-type:environment-bootstrap",
);
```

Rust route tests must assert both new and old request paths reach the same
handler, while generated client URLs use only the new path.

- [ ] **Step 2: Run focused protocol tests and verify RED**

```powershell
vp test packages/contracts/src/authRustParity.test.ts packages/contracts/src/environmentHttp.test.ts packages/contracts/src/relay.test.ts packages/shared/src/relayJwt.test.ts
cargo test --locked -p bibcode-server http -- --test-threads=1
cargo test --locked -p bibcode-server auth -- --test-threads=1
cargo test --locked -p bibcode-server production_connect_mcp -- --test-threads=1
```

- [ ] **Step 3: Implement canonical constants and legacy aliases**

For each route/header/URN/JWT type/client ID/cookie/discriminant, define one
canonical constant and one explicitly named legacy constant. Encoders and new
requests use canonical constants. Router registration and decoders accept both
and normalize to the canonical in-memory value. Do not duplicate handlers or
business logic.

Canonicalize at least:

```text
retired well-known routes    -> /.well-known/bibcode/*
/api/bibcode-connect/*       -> /api/bibcode-connect/*
retired header prefix        -> x-bibcode-*
retired URN namespace        -> urn:bibcode:*
retired env/JWT types        -> bibcode-env:* / bibcode-*-jwt
retired session cookie       -> bibcode_session
retired web client ID        -> bibcode-web
retired application URI      -> bibcode://app
```

- [ ] **Step 4: Regenerate fixtures and verify cross-language compatibility**

Regenerate repository-owned contract fixtures with canonical values. Keep
separate explicit legacy fixtures proving old clients are accepted. Run:

```powershell
vp run --filter @bibcode/contracts build
vp test packages/contracts packages/shared packages/client-runtime infra/relay
cargo test -p bibcode-server --locked -j 2 -- --test-threads=1
cargo test -p bibcode-desktop --locked -j 2 -- --test-threads=1
```

- [ ] **Step 5: Review without staging or committing**

Inspect every lower-case protocol match. Only explicitly named `LEGACY_*`
constants, legacy fixtures/tests, migration docs, and the final allowlist may
remain.

### Task 5: Hosted Configuration, Domains, Tauri Identifier, and Installer Upgrade Surface

**Files:**

- Modify: `apps/web/vercel.ts`
- Modify: `apps/marketing/vercel.ts`
- Modify: `apps/web/src/hostedPairing.ts`
- Modify: `apps/web/src/cloud/publicConfig.ts`
- Modify: `scripts/lib/public-config.ts`
- Modify: `infra/relay/package.json`
- Modify: `infra/relay/alchemy.run.ts`
- Modify: `infra/relay/src/deploymentConfig.ts`
- Modify: `infra/relay/src/db.ts`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/src-tauri/src/window.rs`
- Modify: desktop/release/installer tests and docs

**Interfaces:**

- Produces: deployment-provided BiBCode host configuration and Tauri identifier `com.bibcode.desktop`.
- Consumes: no invented public domain; hosted deployments must provide their canonical host/origin explicitly.

- [ ] **Step 1: Change configuration and installer expectations**

Require:

```text
com.bibcode.desktop
BIBCODE_ROUTER_HOST
BIBCODE_LATEST_ORIGIN
BIBCODE_NIGHTLY_ORIGIN
bibcode-relay
bibcoderelay
```

Add a test that missing hosted-domain configuration fails at deploy/config
resolution rather than silently routing to a retired branded domain.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
vp test scripts/lib/public-config.test.ts infra/relay/src/deploymentConfig.test.ts scripts/tauri-hardening.test.ts scripts/release-workflow.test.ts
cargo test --locked -p bibcode-desktop window -- --test-threads=1
```

- [ ] **Step 3: Remove upstream domains and canonicalize hosted identity**

Read router host/latest/nightly origins from required `BIBCODE_*` deployment
configuration. In browser runtime, derive same-origin links from
`window.location.origin` unless an injected BiBCode hosted-app URL is present.
Remove references to the retired hosted-app domain; do not substitute an
unowned domain.

- [ ] **Step 4: Change the Tauri identifier and verify built metadata**

Set `identifier` to `com.bibcode.desktop`, update test identifiers, window/menu
IDs, and webview-persistence migration documentation. Build representative
Windows packaging with updater disabled and inspect the app executable,
installer filename, bundle metadata, uninstall identity, and WebView data path.

Because changing a Tauri identifier changes system bundle/WebView identity,
record the resulting one-time upgrade behavior in release docs. Do not publish
or run an installer against the user's live installation during verification.

- [ ] **Step 5: Verify hosted/desktop configuration**

```powershell
vp test scripts/lib/public-config.test.ts infra/relay/src/deploymentConfig.test.ts scripts/tauri-hardening.test.ts scripts/release-workflow.test.ts
cargo test --locked -p bibcode-desktop window -- --test-threads=1
corepack pnpm --filter @bibcode/web build
corepack pnpm --filter @bibcode/marketing build
```

- [ ] **Step 6: Review without staging or committing**

Audit project-owned text for retired hosted-domain, Tauri-identifier, and relay
resource names while confirming the canonical `bibcode-relay` and `bibcoderelay`
names remain where required.

Expected: only explicit migration/legacy test documentation and the final
allowlist.

### Task 6: Final Legacy Allowlist and Repository-Wide Identity Guard

**Files:**

- Rename the identity guard from its retired filename to
  `scripts/bibcode-identity.test.ts`.
- Modify: root test discovery/config only if the renamed test is explicitly referenced
- Modify: migration documentation containing permitted legacy values

**Interfaces:**

- Consumes: all three completed rebrand plans.
- Produces: one repository-wide guard in which every old identity match is either rejected or tied to a specific compatibility reason.

- [ ] **Step 1: Define typed allowlist entries**

Use a centralized structure in the guard:

```ts
interface AllowedLegacyReference {
  readonly path: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

const allowedLegacyReferences: readonly AllowedLegacyReference[] = [
  ...[
    "packages/shared/src/environmentIdentity.ts",
    "packages/shared/src/environmentIdentity.test.ts",
    "scripts/lib/public-config.ts",
    "scripts/lib/public-config.test.ts",
    "scripts/dev-runner.ts",
    "scripts/dev-runner.test.ts",
    "apps/server/src/config.rs",
    "apps/desktop/src-tauri/src/config.rs",
    "apps/desktop/src-tauri/src/backend.rs",
  ].map((path) => ({
    path,
    pattern: new RegExp(["T", "4", "CODE_"].join("")),
    reason: "Accept pre-rebrand environment configuration as a read-only fallback.",
  })),
  ...["apps/server/src/identity_paths.rs", "apps/server/tests/identity_paths.rs"].map((path) => ({
    path,
    pattern: new RegExp(["\\.t", "4", "code"].join(""), "i"),
    reason: "Copy existing application data into the canonical .bibcode directory.",
  })),
  ...[
    "apps/web/src/storageIdentity.ts",
    "apps/web/src/storageIdentity.test.ts",
    "apps/web/src/connection/storage.ts",
    "apps/web/src/connection/storage.test.ts",
    "apps/web/src/cloud/dpop.ts",
    "apps/web/src/cloud/dpop.test.ts",
  ].map((path) => ({
    path,
    pattern: new RegExp(["t", "4", "code[:.]"].join(""), "i"),
    reason: "Copy legacy browser persistence into canonical BiBCode storage.",
  })),
  ...[
    "packages/contracts/src/auth.ts",
    "packages/contracts/src/authRustParity.test.ts",
    "packages/contracts/src/environmentHttp.ts",
    "packages/contracts/src/environmentHttp.test.ts",
    "packages/contracts/src/relay.ts",
    "packages/contracts/src/relay.test.ts",
    "packages/shared/src/relayJwt.ts",
    "packages/shared/src/relayJwt.test.ts",
    "apps/server/src/http.rs",
    "apps/server/src/auth/model.rs",
    "apps/server/src/production/connect_mcp.rs",
    "apps/server/src/production/connect_mcp/tests.rs",
    "infra/relay/src/auth/RelayTokens.ts",
    "infra/relay/src/auth/RelayTokens.test.ts",
    "infra/relay/src/environments/EnvironmentConnector.ts",
    "infra/relay/src/environments/EnvironmentConnector.test.ts",
  ].map((path) => ({
    path,
    pattern: new RegExp(["t", "4", "code"].join(""), "i"),
    reason: "Accept a protocol value emitted by an installed pre-rebrand client.",
  })),
];
```

Build old-name regexes from fragments so the guard does not match its own
source. Match path plus content; a pattern allowed in one file must still fail
everywhere else. Reasons must name the external data/client being protected.

- [ ] **Step 2: Run the guard and verify it exposes all unclassified leftovers**

```powershell
vp test scripts/bibcode-identity.test.ts
```

Expected initially: failures for every old reference not yet classified.

- [ ] **Step 3: Remove accidental matches; allow only required fallbacks**

Do not add an allowlist entry for convenience. Rename accidental source,
fixture, comment, docs, temp, and UI values. Keep only executable compatibility
paths covered by tests and the migration docs that explain them.

- [ ] **Step 4: Verify the guard is GREEN**

```powershell
vp test scripts/bibcode-identity.test.ts
```

Expected: PASS and zero unclassified old identity.

### Task 7: Final Full Rebrand Verification

**Files:**

- No planned source changes; fix only failures traced to the rebrand.

**Interfaces:**

- Consumes: complete BiBCode visible, code, and runtime identity.
- Produces: verified unstaged working tree ready for user review.

- [ ] **Step 1: Run all static and automated checks**

```powershell
vp check
vp run typecheck
vp test
cargo test --workspace --locked -j 2 -- --test-threads=1
corepack pnpm --filter @bibcode/web build
corepack pnpm --filter @bibcode/marketing build
corepack pnpm --filter @bibcode/desktop test:ui:build
```

Expected: every command exits 0.

- [ ] **Step 2: Run exhaustive path and text scans**

Run self-hiding repository-wide content and path audits for every retired
product-name, standalone-mark, lowercase identity, and environment-prefix
variant. Exclude VCS metadata, vendored repositories, dependencies, build
outputs, and CodeGraph data.

Every result must correspond exactly to the tested allowlist. There must be no
old-brand filename outside ignored design history and no old name in an image.

- [ ] **Step 3: Decode and visually review every project-owned image**

Enumerate PNG, WebP, ICO, ICNS, SVG, JPG, and JPEG outside `.repos`, dependency
directories, and build caches; include the retained `.artifacts` screenshots.
Use metadata/decoding checks for all assets and `view_image` at original detail
for every brand-bearing icon or screenshot. Confirm BiBCode/BiB and inspect UI
text, filenames, terminal text, title bars, and alt-text references.

- [ ] **Step 4: Review the complete unstaged diff**

```powershell
git diff --check
git status --short
git diff --stat
git diff --name-status
```

Confirm `.repos`, dependencies, generated caches, CodeGraph data, and unrelated
user changes were not touched. Do not stage or commit.

- [ ] **Step 5: Hand off for user approval**

Report the three phase gates, exact commands/results, intentional compatibility
aliases, image review results, and any platform build not runnable on the
current Windows host. Wait for explicit user approval before any staging or
commit.
