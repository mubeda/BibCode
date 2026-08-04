# BiBCode Code Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename repository-internal TypeScript, Rust, package, lint-plugin, file, and build identities from the retired identity to BiBCode/bibcode while leaving persisted and externally consumed compatibility identifiers for the runtime migration plan.

**Architecture:** Rename dependency-graph roots before consumers: workspace packages and lint plugin, then Cargo packages/crates/binaries, then source symbols/files, then CI/build selectors. Regenerate lockfiles and compile the whole graph before changing runtime storage, environment, or protocol identifiers.

**Tech Stack:** pnpm workspaces, TypeScript 7, Vite+, Oxlint plugins, Cargo/Rust 1.97.1, GitHub Actions.

## Global Constraints

- Run only after the visible rebrand plan passes.
- New package scope: `@bibcode/*`.
- New Rust/package/binary prefix: `bibcode`.
- Keep legacy environment-variable fallbacks, persisted paths/storage, HTTP/auth protocol aliases, and the old Tauri identifier until the runtime compatibility plan.
- Do not touch `.repos`, dependency directories, build output, caches, or CodeGraph data.
- Do not stage, commit, push, release, or publish anything.

---

### Task 1: TypeScript Workspace Scope

**Files:**

- Modify: root `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `apps/marketing/package.json`
- Modify: `apps/server/package.json`
- Modify: `apps/web/package.json`
- Modify: `infra/relay/package.json`
- Modify: `packages/client-runtime/package.json`
- Modify: `packages/contracts/package.json`
- Modify: `packages/shared/package.json`
- Modify: `scripts/package.json`
- Modify: every project-owned TypeScript/JavaScript import containing the retired package scope
- Modify: `vite.config.shared.ts`
- Modify: `tsconfig*.json` files containing the retired package scope
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: existing workspace package exports and paths.
- Produces: identical exports under `@bibcode/client-runtime`, `@bibcode/contracts`, `@bibcode/shared`, and application/script package names.

- [ ] **Step 1: Add a failing workspace-identity assertion**

In `scripts/toolchain-contract.test.ts`, assert the canonical package names:

```ts
expect(rootPackage.name).toBe("@bibcode/monorepo");
expect(webPackage.name).toBe("@bibcode/web");
expect(contractsPackage.name).toBe("@bibcode/contracts");
expect(sharedPackage.name).toBe("@bibcode/shared");
```

- [ ] **Step 2: Run the focused contract and verify RED**

```powershell
vp test scripts/toolchain-contract.test.ts
```

- [ ] **Step 3: Rename package manifests, imports, and filters atomically**

Replace the retired workspace scope with `@bibcode/` while preserving each
package suffix (`monorepo`, `desktop`, `marketing`, `web`, `scripts`,
`contracts`, `shared`, and `client-runtime`).

Change imports, dependencies, Vite aliases, workspace filters, test fixtures,
and CI filters together. Do not alter runtime string values merely because they
contain the retired runtime prefix.

- [ ] **Step 4: Refresh the lockfile and verify package resolution**

```powershell
corepack pnpm install --lockfile-only --ignore-scripts
vp test scripts/toolchain-contract.test.ts
vp run --filter @bibcode/contracts build
vp run --filter @bibcode/web typecheck
```

Expected: all commands exit 0 and `pnpm-lock.yaml` contains the new workspace
package names.

- [ ] **Step 5: Review checkpoint without staging or committing**

Audit project-owned text for the retired workspace scope, excluding vendored
repositories, dependencies, and build output, then run `git diff --check`.

Expected: no old workspace-scope imports outside the ignored design history.

### Task 2: Oxlint Plugin Package and Rule Namespace

**Files:**

- Rename the retired lint-plugin directory to `oxlint-plugin-bibcode`.
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `vite.config.shared.ts`
- Modify: every source suppression/config containing the retired rule namespace
- Modify: plugin production/tests/config files under `oxlint-plugin-bibcode`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: current rule implementations and Vite+/Oxlint registration.
- Produces: package `@bibcode/oxlint-plugin-bibcode` and rule namespace `bibcode/*` with unchanged rule behavior.

- [ ] **Step 1: Change plugin tests to the new package and rule IDs**

```ts
expect(pluginName).toBe("@bibcode/oxlint-plugin-bibcode");
expect(ruleName).toBe("bibcode/no-global-process-runtime");
```

- [ ] **Step 2: Run plugin/config tests and verify RED**

```powershell
vp test oxlint-plugin-bibcode scripts/coverage-config.test.ts
```

- [ ] **Step 3: Rename the directory and namespace**

Move the directory once, update the workspace glob/filter, package name,
registration key, test paths, rule documentation, and all project-owned
`oxlint-disable` comments from the retired namespace to `bibcode/`. Do not
create a second plugin or compatibility wrapper because the plugin is private
to this repo.

- [ ] **Step 4: Refresh resolution and verify GREEN**

```powershell
corepack pnpm install --lockfile-only --ignore-scripts
vp test oxlint-plugin-bibcode scripts/coverage-config.test.ts
vp lint --report-unused-disable-directives
```

- [ ] **Step 5: Review checkpoint without staging or committing**

Audit tracked and untracked project-owned paths for the retired plugin basename,
then audit project-owned text for the retired rule namespace.

Expected: no project-owned old plugin path or rule namespace.

### Task 3: Rust Packages, Crates, and Binaries

**Files:**

- Modify: root `Cargo.toml`
- Modify: `apps/server/Cargo.toml`
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/main.rs`
- Modify: project-owned Rust references to the retired server crate
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: project-owned Rust references to the retired desktop library crate
- Modify: `tools/updater-verifier/Cargo.toml`
- Modify: `tools/updater-verifier/src/main.rs`
- Modify: fixture `Cargo.toml`/`Cargo.lock` files under `apps/server/tests/fixtures`
- Modify: `Cargo.lock`

**Interfaces:**

- Consumes: current Rust APIs and workspace membership.
- Produces: packages `bibcode-server`, `bibcode-desktop`, `bibcode-updater-verifier`; libraries `bibcode_server`, `bibcode_desktop_lib`; binary `bibcode`.

- [ ] **Step 1: Change Rust workspace expectations**

Update `scripts/rust-workspace.test.ts` and relevant CLI smoke assertions to
require:

```text
bibcode-server
bibcode-desktop
bibcode-updater-verifier
bibcode
```

- [ ] **Step 2: Run Rust workspace tests and verify RED**

```powershell
vp test scripts/rust-workspace.test.ts
cargo metadata --locked --no-deps
```

- [ ] **Step 3: Rename Cargo package, crate, and binary identities**

Rename the retired server, desktop, updater-verifier, library-crate, and binary
identities to `bibcode-server`, `bibcode-desktop`,
`bibcode-updater-verifier`, `bibcode_server`, `bibcode_desktop_lib`, and
`bibcode` respectively.

Update package scripts, Cargo workspace dependency keys, CI `cargo -p`
selectors, binary discovery code, diagnostics process labels, and fixtures.
Do not yet rename the retired filesystem path, protocol routes, environment
variables, or persisted keys.

- [ ] **Step 4: Refresh Cargo locks and verify GREEN**

```powershell
cargo check --workspace --all-targets
cargo metadata --locked --no-deps
cargo check --workspace --all-targets --locked
cargo test --workspace --locked -j 2 -- --test-threads=1
vp test scripts/rust-workspace.test.ts
```

- [ ] **Step 5: Review checkpoint without staging or committing**

Audit Cargo manifests, locks, applications, tools, scripts, and workflows for
the retired Rust/build identities.

Expected: no old build identity except runtime compatibility examples explicitly
deferred to the next plan.

### Task 4: TypeScript/Rust Source Symbols and Brand-Named Paths

**Files:**

- Rename the retired connect sidebar component to `apps/web/src/components/clerk/BiBCodeConnectSidebarSignIn.tsx`.
- Rename the retired connect auth hook to `apps/web/src/components/clerk/useBiBCodeConnectAuthPrompt.tsx`.
- Rename the retired Clerk guide to `docs/cloud/bibcode-connect-clerk.md`.
- Rename the retired auth-flow guide to `docs/cloud/bibcode-connect-auth-flow.html`.
- Modify: `packages/shared/src/composerTrigger.ts`
- Modify: `apps/web/src/composer-logic.ts`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/chat/composerCommandItems.ts`
- Modify: all callers/tests of renamed symbols/files

**Interfaces:**

- Consumes: existing connect and composer behavior.
- Produces: `BiBCodeConnectSidebarSignIn`, `useBiBCodeConnectAuthPrompt`, `ComposerBiBCodeAction`, `parseStandaloneComposerBiBCodeAction`, and equivalent `BiBCode`-named helpers.

- [ ] **Step 1: Change symbol-level tests and imports**

Change tests and imports from the retired connect/composer symbols to
`BiBCodeConnect...`, `useBiBCodeConnectAuthPrompt`, `ComposerBiBCodeAction`,
`BiBCodeActionItem`, `buildBiBCodeActionItems`,
`parseStandaloneComposerBiBCodeAction`, and `executeBiBCodeAction`.

- [ ] **Step 2: Run focused tests and verify RED/compile failure**

```powershell
vp test apps/web/src/composer-logic.test.ts apps/web/src/components/chat/composerCommandItems.test.ts apps/web/src/zero-coverage-routes.test.tsx
```

- [ ] **Step 3: Rename files, exports, imports, and callers atomically**

Use one move per file and update every CodeGraph caller. Keep serialized
composer trigger values in the same atomic change, setting the canonical
discriminant to `"bibcode-action"`. This discriminant is transient composer UI
state, so it does not need a persistence compatibility alias.

- [ ] **Step 4: Verify focused behavior and typecheck**

```powershell
vp test apps/web/src/composer-logic.test.ts apps/web/src/components/chat/composerCommandItems.test.ts apps/web/src/zero-coverage-routes.test.tsx
vp run --filter @bibcode/web typecheck
```

- [ ] **Step 5: Review checkpoint without staging or committing**

Audit tracked and untracked paths for retired connect/composer names.

Expected: only runtime/persistence compatibility values scheduled for the next
plan and deliberate historical design records remain.

### Task 5: Build Scripts, CI Selectors, and Ephemeral Internal Names

**Files:**

- Modify: `.github/workflows/*.yml`
- Modify: root `package.json`
- Modify: `scripts/build-desktop-artifact.ts`
- Modify: `scripts/update-release-package-versions.ts`
- Modify: `scripts/release-smoke.ts`
- Modify: `scripts/run-msvc-x64.mjs`
- Modify: `scripts/run-web-build-locked.mjs`
- Modify: `scripts/prepare-tauri-appimage-tools.ts`
- Modify: `scripts/tauri/linuxdeploy-plugin-gtk.sh`
- Modify: affected adjacent tests

**Interfaces:**

- Consumes: new package/crate/binary names from Tasks 1–3.
- Produces: CI and local build commands that select only BiBCode identities; ephemeral markers prefixed `.bibcode-*`.

- [ ] **Step 1: Change script/workflow expectations**

Update tests to expect `@bibcode/*`, `bibcode-*`, `.bibcode-publication-owner`,
and `.bibcode-<transaction>.stage|backup|quarantine`.

- [ ] **Step 2: Run release/toolchain tests and verify RED**

```powershell
vp test scripts/build-desktop-artifact.test.ts scripts/update-release-package-versions.test.ts scripts/release-smoke.test.ts scripts/release-workflow.test.ts scripts/prepare-tauri-appimage-tools.test.ts
```

- [ ] **Step 3: Implement direct internal renames**

Rename CI filters, temporary directories, ownership marker filenames, test
fixture prefixes, tracing target prefixes, and helper script basenames. These
values are ephemeral and receive no compatibility aliases.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command and `vp run typecheck`. Expected: exit 0.

- [ ] **Step 5: Review checkpoint without staging or committing**

```powershell
git diff --check -- .github package.json scripts
```

### Task 6: Code-Identity Gate

**Files:**

- Modify the identity guard script only if its embedded source-name allow rules
  need updating; its retired filename remains until the final runtime plan.

**Interfaces:**

- Consumes: all code/build renames in this plan.
- Produces: a clean dependency graph with old names remaining only in runtime compatibility categories.

- [ ] **Step 1: Run exhaustive source/build scans**

Run a repository-wide, self-hiding audit for every retired package, Rust,
plugin, connect, and composer identity, excluding VCS metadata, vendored
repositories, dependencies, build outputs, and CodeGraph data.

Expected: no match outside ignored design/plan history and runtime compatibility
tests that explicitly model an old client.

- [ ] **Step 2: Run full package/Rust verification**

```powershell
vp check
vp run typecheck
vp test
cargo test --workspace --locked -j 2 -- --test-threads=1
corepack pnpm --filter @bibcode/web build
corepack pnpm --filter @bibcode/marketing build
```

- [ ] **Step 3: Inspect locks and status**

```powershell
git diff --check
git status --short
```

Report remaining old values grouped strictly as environment aliases, persisted
storage/paths, network/auth protocols, hosted domains, and Tauri identity. Do
not stage or commit; proceed to the runtime compatibility plan.
