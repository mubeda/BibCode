# Dependency and Toolchain Supported Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge BiBCode on every approved dependency and toolchain target, preserve the documented compatibility exceptions, prove native and packaged behavior, and deliver the complete migration as exactly one commit.

**Architecture:** Execute ordered dependency cohorts in one uncommitted worktree, with a focused validation gate after every cohort. Version contracts and patch invariants make the intended state executable; manifests, lockfiles, CI pins, the active ledger, living runbooks, and the final report move together. Create the sole commit only after all local gates pass, then repair any CI failure by amending that same commit.

**Tech Stack:** Node.js 26.8.1, pnpm 11.25.0, Vite+ 0.3.0, Vite 8.2.2, Vitest 4.1.11, TypeScript 7.0.2 with a marketing-only TypeScript 6.0.3 compatibility island, React 19.2.8, Effect 4.0.0-beta.107, Rust/Cargo 1.98.0, Tauri 2, retained WebdriverIO 9.29.1 / Tauri Wdio 1.2.0, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-03-dependency-toolchain-supported-convergence-design.md`

**Amendments:** Task 8 selected the approved Alchemy beta.72 / exact Drizzle
RC5 tuple; Task 9 retained the Wdio 1.2/9.29 cohort; Task 11 accepted the live,
verified Rust 1.98.0 action SHA; and Task 13 added the fail-closed `xn--` Clerk
host policy with its documented valid-IDN compatibility cost. The task sections
below are binding where they record those executed rulings.

## Global Constraints

- The branch contains exactly one migration commit above the recorded base.
- Do not commit at the end of Tasks 0–12; Task 13 creates the sole commit.
- If post-commit CI needs a repair, use `git commit --amend --no-edit`; never add a second commit.
- Preserve the pre-existing untracked `outputs/` research workbook and exclude it from staging.
- Preserve package ownership and dependency direction from `AGENTS.md`.
- Keep `packages/contracts` schema-only.
- Keep privileged desktop operations behind `DesktopBridge` and normal application traffic on typed HTTP/WebSocket RPC.
- Do not add a production Node runtime, TypeScript server, Electron host, or native helper sidecar.
- Keep `vite` aliased to exact `@voidzero-dev/vite-plus-core@0.3.0`; do not install standalone Vite.
- Keep React and React DOM exact and identical at 19.2.8.
- Keep Lexical core and React bindings at 0.50.0.
- Keep every Effect v4 package at 4.0.0-beta.107; do not move to RC.112.
- Keep the four Clerk packages on the approved coordinated train.
- Keep Alchemy at 2.0.0-beta.72 and Drizzle ORM and Kit at its exact compatible peer build, 1.0.0-rc.5-ab785fc.
- Keep the JavaScript and Rust Tauri Wdio packages exact at 1.2.0, direct
  WebdriverIO packages at 9.29.1, and native-utils at 2.5.0 until an upstream
  Service release fixes `afterSession` teardown ordering and aligns its
  globals/expect cohort.
- Preserve the local `portable-pty` source and Tao revision `c704261c519c58cfdd0bc2d58ba24e06a0b71c92`.
- Retain marketing TypeScript 6.0.3, Process Wrap 9.1.0, Rust Base64 0.22.1, GTK/cairo 0.18, production Windows crates 0.61, WebView2 COM 0.38, and Minisign Verify 0.2.5.
- Do not edit historical `docs/dependency-upgrades/2026-07-17-final-report.md` or historical execution reports.
- Use the checked-out `scripts/run-local-vp.mjs` path for Vitest-backed package tests.
- A version-only cohort uses green-before/green-after validation. If a source migration becomes necessary and this plan does not specify it, stop and update the approved plan before changing application behavior.

## File Responsibility Map

- `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`: JavaScript toolchain, catalog, overrides, patches, maturity policy, and resolved graph.
- `apps/web/package.json`: React, editor, router, rendering, browser test, and Wdio frontend dependencies.
- `apps/desktop/package.json`: Tauri CLI and packaged desktop WebdriverIO cohort.
- `apps/marketing/package.json`: Astro checker and marketing TypeScript compatibility island.
- `infra/relay/package.json`: Clerk backend, Effect SQL, Alchemy, Drizzle, and Cloudflare types.
- `scripts/package.json`, `oxlint-plugin-bibcode/package.json`, and package manifests under `packages/`: catalog consumers and direct utility floors.
- `Cargo.toml`, `Cargo.lock`, and `rust-toolchain.toml`: Rust MSRV, direct dependency floors, Tauri plugins, patches, and resolved graph.
- `apps/server/tests/fixtures/task8-harness/Cargo.lock` and `apps/server/tests/fixtures/task9-harness/Cargo.lock`: isolated compatible fixture resolutions; their manifests keep existing compatibility ranges.
- `patches/`: only package deviations still absent upstream.
- `scripts/toolchain-contract.test.ts`, `scripts/rust-workspace.test.ts`, `scripts/run-local-vp.test.mjs`, `scripts/workflow-dependencies.test.ts`, and `scripts/ci-platform-contract.test.ts`: executable version and CI contracts.
- `.devcontainer/devcontainer.json`: exact Node/Corepack/pnpm development bootstrap.
- `.github/workflows/*.yml`: immutable action revisions and exact Rust/Vite+ setup.
- `docs/dependency-upgrades/2026-07-17-ledger.json`: active machine-consumed dependency policy.
- `docs/dependency-upgrades/2026-09-03-supported-convergence-report.md`: final execution evidence and retained risk.
- `docs/reference/scripts.md`, `docs/operations/ci.md`, `docs/operations/release.md`, and `docs/testing/*.md`: living procedures affected by toolchain, action, packaged UI, and native validation changes.

---

### Task 0: Establish the clean one-commit execution baseline

**Files:**

- Do not modify repository files.
- Preserve: `outputs/`

**Interfaces:**

- Consumes: the approved spec and current `develop` checkout.
- Produces: shell variable `BIBCODE_MIGRATION_BASE`, a green baseline, and a recorded list of pre-existing untracked files.

- [ ] **Step 1: Enter an isolated execution worktree**

Use `superpowers:using-git-worktrees`. Start from the approved current base rather than copying the dirty planning checkout. The execution worktree must contain the approved spec and this plan as uncommitted files if they are not yet in the selected base.

- [ ] **Step 2: Record the base and verify the history boundary**

Run:

```sh
export BIBCODE_MIGRATION_BASE="$(git rev-parse HEAD)"
git branch --show-current
git status --short
git merge-base --is-ancestor "$BIBCODE_MIGRATION_BASE" HEAD
```

Expected: the ancestor check exits 0; tracked files are clean; only the approved spec, plan, and pre-existing `outputs/` may be untracked.

- [ ] **Step 3: Record installed and declared toolchains**

Run:

```sh
node --version
pnpm --version
vp --version
rustc --version
cargo --version
node -p "require('./package.json').packageManager"
```

Expected declared values before migration: Node 26.5.0, pnpm 11.15.0, Vite+ 0.2.5, Rust/Cargo 1.97.1. Ambient binaries may be newer and are recorded separately.

- [ ] **Step 4: Restore the old locked graph without changing it**

Run:

```sh
corepack prepare pnpm@11.15.0 --activate
pnpm install --frozen-lockfile
cargo fetch --locked
git diff --exit-code -- package.json pnpm-workspace.yaml pnpm-lock.yaml Cargo.toml Cargo.lock
```

Expected: installation succeeds and the tracked dependency inputs do not change.

- [ ] **Step 5: Run the complete baseline gate**

Run:

```sh
vp run check:dependency-ledger
vp check
vp run typecheck
vp test
vp run test
cargo test --workspace --all-targets -j 2
cargo test --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml
cargo test --manifest-path apps/server/tests/fixtures/task9-harness/Cargo.toml
```

Expected: every command exits 0. A baseline failure is repaired outside this migration or explicitly accepted by the user before Task 1.

- [ ] **Step 6: Confirm no baseline mutation and do not commit**

Run:

```sh
git diff --check
git status --short
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: no dependency diff exists yet and the commit count is `0`.

---

### Task 1: Make the approved target and exception set executable

**Files:**

- Modify: `scripts/toolchain-contract.test.ts:50-170`
- Modify: `scripts/rust-workspace.test.ts:90-125`
- Modify: `scripts/run-local-vp.test.mjs:20-120`
- Modify: `scripts/check-dependency-upgrade-ledger.test.ts`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Interfaces:**

- Consumes: exact targets and retained boundaries from the spec.
- Produces: failing contracts that name every toolchain/cohort target and reject stale patch keys or accidental removal of retained exceptions.

- [ ] **Step 1: Update the exact toolchain expectations**

Change `scripts/toolchain-contract.test.ts` to assert:

```ts
expect(rootPackage.engines).toEqual({ node: "26.8.1" });
expect(rootPackage.packageManager).toBe("pnpm@11.25.0");
expect(workspace).toMatch(/^  "@types\/node": 26\.4\.1$/m);
expect(workspace).toMatch(/^  vite: npm:@voidzero-dev\/vite-plus-core@0\.3\.0$/m);
expect(workspace).toMatch(/^  vite-plus: 0\.3\.0$/m);
expect(catalog["@effect/tsgo"]).toBe("0.40.0");
expect(catalog.typescript).toBe("7.0.2");
expect(marketingDevDependencies.typescript).toBe("6.0.3");
expect(toolchain.channel).toBe("1.98.0");
expect(workspacePackage["rust-version"]).toBe("1.98.0");
```

Change the devcontainer expectations to Node `26.8.1` and `corepack prepare pnpm@11.25.0 --activate`.

- [ ] **Step 2: Update Rust workflow contract wording and counts**

Change `scripts/rust-workspace.test.ts` so the exact assertion reads:

```ts
assert.equal(
  ciWorkflow.match(/uses: dtolnay\/rust-toolchain@[0-9a-f]{40} # 1\.98\.0/g)?.length ?? 0,
  3,
  "Every Rust CI job must exercise the declared Rust 1.98.0 toolchain",
);
assert.equal(workspacePackage["rust-version"], "1.98.0");
```

- [ ] **Step 3: Update local Vite+ launcher fixtures**

Replace only fixture package versions `0.2.5` with `0.3.0` in `scripts/run-local-vp.test.mjs`. Keep missing-bin, malformed-bin, spawn-error, and exit-code behavior unchanged.

- [ ] **Step 4: Add exact cohort and patch assertions to the ledger test**

Add this import to `scripts/check-dependency-upgrade-ledger.test.ts`:

```ts
import { parse as parseYaml } from "yaml";
```

Add a repository-level test with these definitions and assertions:

```ts
it("records the approved convergence targets and patch set", () => {
  const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
  const ledger = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(repositoryRoot, "docs/dependency-upgrades/2026-07-17-ledger.json"),
      "utf8",
    ),
  ) as DependencyLedger;
  const entries = new Map(ledger.dependencies.map((dependency) => [dependency.key, dependency]));
  const entry = (key: string) => {
    const dependency = entries.get(key);
    expect(dependency, key).toBeDefined();
    return dependency!;
  };
  const workspace = parseYaml(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"),
  ) as { patchedDependencies: Record<string, string> };

  expect(entry("toolchain:node").target).toBe("26.8.1");
  expect(entry("toolchain:pnpm").target).toBe("11.25.0");
  expect(entry("toolchain:rust").target).toBe("1.98.0");
  expect(entry("toolchain:vite-plus").target).toBe("0.3.0");
  expect(entry("js:catalog:effect").target).toBe("4.0.0-beta.107");
  expect(entry("js:apps/web:react").target).toBe("19.2.8");
  expect(entry("rust:workspace:process-wrap").target).toBe("9.1.0");
  expect(entry("rust:workspace:base64").target).toBe("0.22.1");
  expect(Object.keys(workspace.patchedDependencies).sort()).toEqual([
    "@effect/vitest@4.0.0-beta.107",
    "@wdio/tauri-plugin@1.2.0",
  ]);
});
```

- [ ] **Step 5: Update ledger target rows without marking them green**

Set the new target versions from the spec, change retained entries to `blocked` with their exact release condition, and keep every migrating row `pending`. Update action tags and SHAs to the values in Task 11. Do not claim validation results yet.

- [ ] **Step 6: Run contracts and verify they fail for the old repository state**

Run:

```sh
node scripts/run-local-vp.mjs test run scripts/toolchain-contract.test.ts scripts/rust-workspace.test.ts scripts/run-local-vp.test.mjs scripts/check-dependency-upgrade-ledger.test.ts
```

Expected: FAIL on old Node, pnpm, Rust, Vite+, dependency, and patch values—not on syntax or fixture setup.

- [ ] **Step 7: Checkpoint without committing**

Run:

```sh
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: diff check passes and commit count remains `0`.

---

### Task 2: Migrate Node, pnpm, Rust, Vite+, and the sole test runtime

**Files:**

- Modify: `package.json:54-65`
- Modify: `pnpm-workspace.yaml:11-101`
- Modify: `pnpm-lock.yaml`
- Modify: `rust-toolchain.toml`
- Modify: `Cargo.toml:5-7`
- Modify: `.devcontainer/devcontainer.json:4-21`

**Interfaces:**

- Consumes: failing Task 1 contracts.
- Produces: Node 26.8.1, pnpm 11.25.0, Rust/Cargo 1.98.0, Vite+ 0.3.0, Vitest 4.1.11, and continued single-runner behavior for the still-installed Effect beta.99 package.

- [ ] **Step 1: Change exact toolchain declarations**

Apply these values:

```json
{
  "engines": { "node": "26.8.1" },
  "packageManager": "pnpm@11.25.0"
}
```

```toml
[toolchain]
channel = "1.98.0"
profile = "minimal"
components = ["rustfmt", "clippy"]
```

```toml
[workspace.package]
edition = "2024"
rust-version = "1.98.0"
```

- [ ] **Step 2: Change the Vite+/test catalog as one unit**

Set:

```yaml
catalog:
  "@effect/tsgo": 0.40.0
  "@types/node": 26.4.1
  vite: npm:@voidzero-dev/vite-plus-core@0.3.0
  vite-plus: 0.3.0
```

Set root `@vitest/coverage-v8` to `4.1.11` and pin both root and `oxlint-plugin-bibcode` `@oxlint/plugins` declarations to exact `1.79.0` so they match Vite+ 0.3's bundled Oxlint.

- [ ] **Step 3: Update the devcontainer bootstrap**

Set the Node feature to `26.8.1` and the post-create command to:

```text
npm install --global corepack@0.35.0 && corepack enable && corepack prepare pnpm@11.25.0 --activate && pnpm install --frozen-lockfile
```

Keep the image digest, Git feature, Python feature, feature order, and VS Code extension unchanged.

- [ ] **Step 4: Prove the existing Effect beta.99 patch works on Vite+ 0.3**

Run:

```sh
node scripts/run-local-vp.mjs test run packages/shared/src/dpop.test.ts packages/client-runtime/src/authorization/layer.test.ts scripts/dev-runner.test.ts
```

Expected: the existing beta.99 patch continues to route tests through `vite-plus/test` on Vite+ 0.3.0. Do not rebase the package patch until Task 8 changes Effect itself.

- [ ] **Step 5: Activate pnpm 11.25 and regenerate the JavaScript graph**

Run:

```sh
corepack prepare pnpm@11.25.0 --activate
pnpm install
node --version
pnpm --version
node scripts/run-local-vp.mjs --version
```

Expected: Node `v26.8.1`, pnpm `11.25.0`, and local Vite+ `0.3.0`. If the host Node is not 26.8.1, use the repository-supported Vite+ environment command to install/select exactly 26.8.1 before continuing.

- [ ] **Step 6: Verify the bundled toolchain and one Vitest runtime**

Run:

```sh
node scripts/run-local-vp.mjs --version
pnpm list -r vite-plus @voidzero-dev/vite-plus-core vitest @vitest/coverage-v8 @oxlint/plugins
node scripts/run-local-vp.mjs test run scripts/run-local-vp.test.mjs scripts/toolchain-contract.test.ts
```

Expected: Vite+ 0.3.0 reports Vite 8.2.2, Rolldown 1.2.5, Vitest 4.1.11, Oxlint 1.79.0, and Oxfmt 0.64.0; no separately selected Vitest runtime is introduced by `@effect/vitest`.

- [ ] **Step 7: Verify Rust 1.98 contracts**

Run:

```sh
rustup toolchain install 1.98.0 --profile minimal --component rustfmt --component clippy
rustup run 1.98.0 rustc --version
rustup run 1.98.0 cargo --version
node scripts/run-local-vp.mjs test run scripts/rust-workspace.test.ts
```

Expected: Rust and Cargo report 1.98.0 and the exact contract test passes.

- [ ] **Step 8: Review formatter/linter drift before accepting it**

Run:

```sh
vp check
vp fmt
git diff --check
git diff --stat
```

Inspect every formatter edit. Retain formatting-only changes required by Oxfmt 0.64.0; restore any semantic or unrelated rewrite before continuing.

- [ ] **Step 9: Checkpoint without committing**

Run:

```sh
vp run typecheck
node scripts/run-local-vp.mjs test run scripts/toolchain-contract.test.ts scripts/run-local-vp.test.mjs scripts/rust-workspace.test.ts
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: `vp run typecheck` passes and commit count remains `0`. Until Task 11 updates the immutable Rust workflow-action pins, the combined contract command may have exactly the two known Rust-workflow-pin failures (`scripts/toolchain-contract.test.ts` and `scripts/rust-workspace.test.ts`); every Node, pnpm, Vite+, and devcontainer assertion must pass.

---

### Task 3: Upgrade stable JavaScript tooling, marketing, and relay utilities

**Files:**

- Modify: `apps/marketing/package.json:12-19`
- Modify: `apps/web/package.json:50-70`
- Modify: `infra/relay/package.json:11-28`
- Modify: `scripts/package.json:12-20`
- Modify: `pnpm-workspace.yaml:11-39`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/toolchain-contract.test.ts`

**Interfaces:**

- Consumes: pnpm 11.25 and Vite+ 0.3 from Task 2.
- Produces: current stable build/test utilities while preserving marketing TypeScript 6 and Drizzle RC.4.

- [ ] **Step 1: Raise direct stable utility floors**

Apply these targets while preserving the existing exact/range operator:

```text
@base-ui/react ^1.7.0
@fontsource-variable/dm-sans ^5.3.0
@fontsource/jetbrains-mono ^5.3.0
@legendapp/list 3.3.10
@pierre/trees 1.0.0-beta.6
@tanstack/react-pacer ^0.23.0
@vercel/config ^0.7.0
@vitejs/plugin-react ^6.1.1
astro ^7.3.0
@astrojs/check ^0.9.10
happy-dom ^20.13.2
lucide-react ^1.40.0
smol-toml 1.8.0
zustand ^5.0.15
@cloudflare/workers-types ^5.20260903.1
```

Keep `apps/marketing` TypeScript exactly `6.0.3`, and leave both Drizzle declarations at `1.0.0-rc.4` for Task 8 to move with Alchemy.

- [ ] **Step 2: Update maturity exceptions deliberately**

Set the final audited list in `pnpm-workspace.yaml` to:

```yaml
minimumReleaseAgeExclude:
  - geckodriver@6.1.1
  - "@cloudflare/workers-types@5.20260903.1"
  - "@noble/ciphers@2.4.0"
```

Update `scripts/toolchain-contract.test.ts` to expect that exact list. Do not add a wildcard or a package name without an exact version.

- [ ] **Step 3: Regenerate and inspect the resolved graph**

Run:

```sh
pnpm install
pnpm list -r --depth 0
pnpm ignored-builds
```

Expected: the intended targets resolve, all install scripts remain explicitly allowed or denied by `allowBuilds`, and no unreviewed build script is approved.

- [ ] **Step 4: Validate marketing TypeScript 6 and Vercel config**

Run:

```sh
vp run --filter @bibcode/marketing typecheck
vp run --filter @bibcode/marketing build
vp run --filter @bibcode/web typecheck
vp run --filter @bibcode/web build
```

Expected: Astro check uses TypeScript 6.0.3; both `apps/marketing/vercel.ts` and `apps/web/vercel.ts` compile against `@vercel/config` 0.7.0.

- [ ] **Step 5: Validate relay preview tooling without deployment**

Run:

```sh
vp run --filter bibcode-relay typecheck
node scripts/run-local-vp.mjs test run infra/relay/src/Config.test.ts infra/relay/src/dbConfig.test.ts infra/relay/src/deploymentConfig.test.ts
```

Expected: typecheck and tests pass. Do not run Alchemy deploy or destroy.

- [ ] **Step 6: Checkpoint without committing**

Run:

```sh
node scripts/run-local-vp.mjs test run scripts/toolchain-contract.test.ts scripts/privacy-contract.test.ts
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: commands pass and commit count remains `0`.

---

### Task 4: Upgrade React, router, and debounce/state packages

**Files:**

- Modify: `apps/web/package.json:15-70`
- Modify: `pnpm-lock.yaml`
- Test: `apps/web/src/uiStateStore.test.ts`
- Test: `apps/web/src/lib/storage.test.ts`
- Test: `apps/web/src/components/PullRequestThreadDialog.test.tsx`
- Test: `apps/web/src/components/ChatView.test.tsx`
- Test: `apps/web/src/routes/__root.test.tsx`
- Test: `apps/web/src/routes/_chat.$environmentId.$threadId.test.tsx`

**Interfaces:**

- Consumes: Vite+ 0.3, plugin-react 6.1.1, and stable utilities from Task 3.
- Produces: React/DOM 19.2.8, matching types, router runtime/plugin alignment, and unchanged debounce/state behavior.

- [ ] **Step 1: Run the focused green-before baseline**

Run:

```sh
node scripts/run-local-vp.mjs test run apps/web/src/uiStateStore.test.ts apps/web/src/lib/storage.test.ts apps/web/src/components/PullRequestThreadDialog.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/routes/__root.test.tsx 'apps/web/src/routes/_chat.$environmentId.$threadId.test.tsx'
```

Expected: PASS before changing this cohort.

- [ ] **Step 2: Change the exact React and router targets**

Set:

```json
{
  "react": "19.2.8",
  "react-dom": "19.2.8",
  "@tanstack/react-router": "^1.170.32",
  "@tanstack/router-plugin": "^1.168.35",
  "@types/react": "~19.2.18",
  "@types/react-dom": "~19.2.6"
}
```

Keep `babel-plugin-react-compiler` exactly `1.0.0`.

- [ ] **Step 3: Install and verify peer alignment**

Run:

```sh
pnpm install
pnpm --filter @bibcode/web list react react-dom @tanstack/react-router @tanstack/router-plugin @types/react @types/react-dom
vp run --filter @bibcode/web typecheck
```

Expected: React and React DOM resolve 19.2.8; the router plugin accepts React Router 1.170.32; typecheck passes without suppressions.

- [ ] **Step 4: Run focused post-upgrade behavior**

Run the exact Step 1 command again, then:

```sh
vp run --filter @bibcode/web test
vp run --filter @bibcode/web build
```

Expected: all web tests and production build pass; debounce cancellation/disposal, persisted UI state, navigation, and hydration behavior remain unchanged.

- [ ] **Step 5: Review React construction and user-visible behavior**

Review affected components/hooks against `vercel-react-best-practices` and `UI.md`. Record `pass`, `changes required`, or `not run—skill unavailable` in the final report. Dependency migration must not introduce a UI redesign.

- [ ] **Step 6: Checkpoint without committing**

Run:

```sh
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: diff check passes and commit count remains `0`.

---

### Task 5: Upgrade Lexical core and React bindings to 0.50.0

**Files:**

- Modify: `apps/web/package.json:28-40`
- Modify: `pnpm-lock.yaml`
- Verify: `apps/web/src/components/ComposerPromptEditor.tsx`
- Test: `apps/web/src/components/ComposerPromptEditor.test.tsx`

**Interfaces:**

- Consumes: React 19.2.8 from Task 4.
- Produces: Lexical 0.50.0 with preserved composer text, cursor, token, history, paste, selection, and IME behavior.

- [ ] **Step 1: Run the composer baseline**

Run:

```sh
node scripts/run-local-vp.mjs test run apps/web/src/components/ComposerPromptEditor.test.tsx
```

Expected: PASS on Lexical 0.48.0.

- [ ] **Step 2: Set the matched Lexical pair**

Change:

```json
{
  "lexical": "^0.50.0",
  "@lexical/react": "^0.50.0"
}
```

- [ ] **Step 3: Install and compile the existing custom-node implementation**

Run:

```sh
pnpm install
pnpm --filter @bibcode/web list lexical @lexical/react
vp run --filter @bibcode/web typecheck
```

Expected: both resolve 0.50.0. The current code already calls `registerCommand` without the removed redundant generic arguments. No source edit is expected; if the `config()` protocol becomes mandatory rather than compatible, stop and revise the approved plan before rewriting custom nodes.

- [ ] **Step 4: Prove composer behavior on Lexical 0.50**

Run:

```sh
node scripts/run-local-vp.mjs test run apps/web/src/components/ComposerPromptEditor.test.tsx apps/web/src/components/ChatView.test.tsx
vp run --filter @bibcode/web build
```

Expected: cursor adjacency, inline tokens, backspace, arrows, surround insertion, dead keys, paste, history, focus, and serialization tests pass.

- [ ] **Step 5: Perform focused packaged interaction checks**

Launch the desktop development build and manually verify typing, IME composition, multiline paste, mention/skill tokens, undo/redo, and prompt submission. Record the host OS and results in the final report.

- [ ] **Step 6: Checkpoint without committing**

Run:

```sh
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: commit count remains `0`.

---

### Task 6: Upgrade Clerk, Jose, and Noble cryptography as one trust-boundary cohort

**Files:**

- Modify: `pnpm-workspace.yaml:18-85`
- Modify: `pnpm-lock.yaml`
- Verify: `apps/web/src/cloud/managedAuth.tsx`
- Verify: `apps/web/src/cloud/dpop.ts`
- Verify: `infra/relay/src/auth/DpopProofs.ts`
- Verify: `packages/shared/src/dpop.ts`
- Verify: `packages/shared/src/relaySigning.ts`
- Test: adjacent auth, DPoP, signing, pairing, and relay tests.

**Interfaces:**

- Consumes: React 19.2.8 and stable Vite+ test runtime.
- Produces: one Clerk train, Jose 6.2.10, Noble Curves/Hashes 2.4.0, and
  preserved canonical ASCII authentication/wire behavior. Task 13's approved
  fail-closed `xn--` ruling supersedes any promise of completely unchanged IDN
  custom-domain behavior.

- [ ] **Step 1: Run trust-boundary baselines**

Run:

```sh
node scripts/run-local-vp.mjs test run apps/web/src/cloud/managedAuth.test.ts apps/web/src/cloud/managedAuth.behavior.test.tsx apps/web/src/cloud/dpop.test.ts packages/shared/src/dpop.test.ts packages/shared/src/dpopCommon.test.ts packages/shared/src/relaySigning.test.ts infra/relay/src/auth/DpopProofs.test.ts infra/relay/src/auth/DpopProofs.verifyAndConsume.test.ts infra/relay/src/auth/RelayTokens.test.ts infra/relay/src/http/Api.test.ts
```

Expected: PASS before changing the cohort.

- [ ] **Step 2: Update the catalog atomically**

Set:

```yaml
catalog:
  "@clerk/backend": 3.17.1
  "@clerk/clerk-js": 6.31.0
  "@clerk/react": 6.15.0
  "@clerk/shared": 4.31.0
  "@noble/ciphers": 2.4.0
  "@noble/curves": 2.4.0
  "@noble/hashes": 2.4.0
  jose: 6.2.10
```

Keep all six wallet-dependency removal overrides and the four Clerk catalog overrides.

- [ ] **Step 3: Install and verify one train**

Run:

```sh
pnpm install
pnpm list -r @clerk/backend @clerk/clerk-js @clerk/react @clerk/shared @noble/ciphers @noble/curves @noble/hashes jose
vp run --filter @bibcode/shared typecheck
vp run --filter @bibcode/client-runtime typecheck
vp run --filter bibcode-relay typecheck
vp run --filter @bibcode/web typecheck
```

Expected: direct/catalog versions match the target table; wallet packages remain absent; no crypto or auth type is weakened.

- [ ] **Step 4: Run post-upgrade trust-boundary tests**

Run the Step 1 command again, then:

```sh
cargo test -p bibcode-server --test crypto_compat
cargo test -p bibcode-server --test auth_http
cargo test -p bibcode-server --test remote_pairing
```

Expected: TypeScript/Rust crypto formats, token validation, DPoP replay
protection, pairing, expiry, and canonical ASCII sign-in/out behavior remain
compatible. Task 13 separately rejects every `xn--` DNS label at the shared
Clerk publishable-key boundary.

- [ ] **Step 5: Checkpoint without committing**

Run:

```sh
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: commit count remains `0`.

---

### Task 7: Move Pierre Diffs to stable 1.3.6 and remove the obsolete patch

**Files:**

- Modify: `pnpm-workspace.yaml:32,78,98-101`
- Modify: `pnpm-lock.yaml`
- Delete: `patches/@pierre__diffs@1.3.0-beta.10.patch`
- Verify: `apps/web/src/components/files/FilePreviewPanel.tsx`
- Verify: `apps/web/src/components/diffs/AnnotatableCodeView.tsx`
- Verify: `apps/web/src/components/gitManager/staging/GitManagerStagingGutter.tsx`
- Test: Pierre diff/editor/worker consumers.

**Interfaces:**

- Consumes: React 19.2.8.
- Produces: stable Pierre Diffs 1.3.6 with upstream-owned gutter utilities, line selection, hover behavior, editor selection preservation, and unchanged worker imports.

- [ ] **Step 1: Run the complete focused Pierre baseline**

Run:

```sh
node scripts/run-local-vp.mjs test run apps/web/src/components/diffs/AnnotatableCodeView.test.tsx apps/web/src/components/files/FilePreviewPanel.test.ts apps/web/src/components/files/FilePreviewPanel.test.tsx apps/web/src/components/gitManager/staging/GitManagerStagingGutter.test.tsx apps/web/src/components/gitManager/history/GitManagerCommitDetail.test.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/reviewCommentContext.test.ts apps/web/src/lib/diffRendering.test.ts
```

Expected: PASS on patched beta.10.

- [ ] **Step 2: Replace the preview catalog entry and remove patch registration**

Set:

```yaml
catalog:
  "@pierre/diffs": 1.3.6
```

Delete the `@pierre/diffs@1.3.0-beta.10` entry from `patchedDependencies` and delete the patch file. Keep the Shiki transformer override because 1.3.6 still accepts Shiki 4.

- [ ] **Step 3: Install and verify upstream behavior is present**

Run:

```sh
pnpm install
pnpm --filter @bibcode/web list @pierre/diffs
rg -n "isLineSelectionEnabled|preserveEditorSelectionsForGutterGesture|isGutterUtilityPath" node_modules/.pnpm/@pierre+diffs@1.3.6*/node_modules/@pierre/diffs/dist/editor/editor.js
```

Expected: version 1.3.6 resolves and all three upstream behavior symbols are present. Do not create a replacement patch.

- [ ] **Step 4: Prove imports, worker bundling, and interactions**

Run the Step 1 command again, then:

```sh
vp run --filter @bibcode/web typecheck
vp run --filter @bibcode/web build
```

Expected: root, React, editor, and `worker/worker.js` exports resolve; line comments, partial staging, controlled selection, editable file state, diff rendering, and worker bundling pass.

- [ ] **Step 5: Perform focused visual checks**

Verify unified and split diffs, line hover, selection, gutter controls, partial stage/unstage, file editing, and conversation diff rendering in the desktop app. Record screenshots in execution evidence only; do not commit them.

- [ ] **Step 6: Checkpoint without committing**

Run:

```sh
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: the patch deletion is the only Pierre patch change and commit count remains `0`.

---

### Task 8: Move the Effect v4 and Alchemy preview cohorts

**Ruling:** Executed on 2026-09-04. Keep Effect beta.107 and use Alchemy
`2.0.0-beta.72` with exact Drizzle ORM/Kit `1.0.0-rc.5-ab785fc`. Beta.76 was
rejected because it requires Effect RC.112, and Drizzle RC.4 crashed while
evaluating `drizzle-orm/effect-postgres` under beta.107. The selected tuple is
declared in `infra/relay/package.json` and guarded by
`infra/relay/src/dbRuntime.test.ts`.

**Files:**

- Modify: `pnpm-workspace.yaml:24-34,71-77,87-100`
- Modify: `infra/relay/package.json:11-28`
- Modify: `infra/relay/alchemy.run.ts`
- Modify: `infra/relay/src/db.ts`
- Modify: `infra/relay/src/worker.ts`
- Modify: `.macroscope/check-run-agents/effect-service-conventions.md`
- Modify: `docs/superpowers/specs/2026-09-03-dependency-toolchain-supported-convergence-design.md`
- Modify: `docs/superpowers/plans/2026-09-03-dependency-toolchain-supported-convergence.md`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`
- Modify: `scripts/check-dependency-upgrade-ledger.test.ts`
- Modify: `scripts/lib/reference-repos.ts`
- Modify: `scripts/lib/reference-repos.test.ts`
- Modify: `scripts/sync-reference-repos.ts`
- Modify: `scripts/sync-reference-repos.test.ts`
- Modify: `AGENTS.md`
- Modify: `docs/reference/scripts.md`
- Modify: Effect-importing source and tests under `apps/web`, `infra/relay`, `packages`, `scripts`, and `oxlint-plugin-bibcode`
- Modify: generated auth/RPC fixtures under `packages/contracts/fixtures`
- Modify: `.repos/effect-smol`
- Modify: `.repos/alchemy-effect`
- Modify: `pnpm-lock.yaml`
- Create: `patches/@effect__vitest@4.0.0-beta.107.patch`
- Create: `infra/relay/src/dbRuntime.test.ts`
- Delete: `patches/@effect__vitest@4.0.0-beta.99.patch`
- Verify: all packages importing `@effect/vitest` or Effect runtime modules.

**Interfaces:**

- Consumes: Vite+ 0.3.0 and the Task 2 patch definition.
- Produces: synchronized Effect beta.107 packages, Alchemy beta.72 with Drizzle `1.0.0-rc.5-ab785fc`, one Fast Check instance, and one Vite+/Vitest runtime.

- [ ] **Step 1: Run representative Effect baselines**

Run:

```sh
node scripts/run-local-vp.mjs test run packages/contracts/src/authRustParity.test.ts packages/contracts/src/rpcRustParity.test.ts packages/shared/src/DrainableWorker.test.ts packages/shared/src/KeyedCoalescingWorker.test.ts packages/client-runtime/src/authorization/layer.test.ts packages/client-runtime/src/connection/supervisor.test.ts infra/relay/src/persistence/schema.test.ts infra/relay/src/http/Api.test.ts oxlint-plugin-bibcode/index.test.ts scripts/dev-runner.test.ts
```

Expected: PASS on beta.99.

- [ ] **Step 2: Set every Effect package to beta.107**

Set exactly:

```yaml
catalog:
  "@effect/atom-react": 4.0.0-beta.107
  "@effect/platform-node": 4.0.0-beta.107
  "@effect/platform-node-shared": 4.0.0-beta.107
  "@effect/sql-d1": 4.0.0-beta.107
  "@effect/sql-pg": 4.0.0-beta.107
  "@effect/sql-sqlite-do": 4.0.0-beta.107
  "@effect/vitest": 4.0.0-beta.107
  effect: 4.0.0-beta.107
```

Retain `fast-check: 4.9.0`, every Effect catalog override, the Vitest-removal override, and the `@effect/vitest` package extension.

- [ ] **Step 3: Generate the exact beta.107 patch**

Run:

```sh
pnpm patch @effect/vitest@4.0.0-beta.107
```

In the returned patch directory, replace every runtime and type import/export below in both `src/` and `dist/`:

```diff
-import * as V from "vitest"
+import * as V from "vite-plus/test"
-export * from "vitest"
+export * from "vite-plus/test"
-import { assert as vassert } from "vitest"
+import { assert as vassert } from "vite-plus/test"
```

In `src/internal/internal.ts` and `dist/internal/internal.js`, redirect only the `V` import and preserve beta.107's implementation:

```ts
const getCurrentSuite = V.TestRunner.getCurrentSuite;
```

Do not reintroduce the beta.99 `@vitest/runner` import replacement. Execute the exact `pnpm patch-commit` command printed by pnpm, rename nothing manually, and confirm `patchedDependencies` contains the beta.107 key and not beta.99.

- [ ] **Step 4: Update the compatible Alchemy and Drizzle cohort and regenerate the graph**

Set `infra/relay/package.json` Alchemy to exactly `2.0.0-beta.72` and both
`drizzle-orm` and `drizzle-kit` to exactly `1.0.0-rc.5-ab785fc`. Beta.72 is
the newest published Alchemy preview whose peer range supports Effect
beta.107; beta.76 requires the excluded Effect RC.112 cohort. The exact RC5
peer build uses `Schema.TaggedError` and is required because RC.4 crashes while
evaluating `drizzle-orm/effect-postgres` under beta.107. Then run:

```sh
pnpm install
pnpm list -r effect @effect/atom-react @effect/platform-node @effect/platform-node-shared @effect/sql-d1 @effect/sql-pg @effect/sql-sqlite-do @effect/vitest fast-check vite-plus vitest alchemy drizzle-orm drizzle-kit
```

Expected: every Effect direct consumer uses beta.107, Alchemy and both Drizzle
packages resolve to the exact compatible tuple above, the Effect Postgres
adapter loads, Fast Check resolves one 4.9.0 instance across Effect tests, and
Vitest resolves through Vite+ 4.1.11. Preserve Rolldown 1.2.5 as the explicit
Task 2/specification target during this late lockfile convergence; it is not an
incidental Task 8 update, and Rolldown 1.2.3 must not return.

- [ ] **Step 5: Apply the beta.107 API migrations and regenerate parity fixtures**

Make only these source migrations required by the beta.107 public API:

- replace 252 `Schema.TaggedErrorClass` call sites with `Schema.TaggedError`;
- replace 13 `Schema.UnknownFromJsonString` uses in ten files with
  `Schema.fromJsonString(Schema.Unknown)`;
- invoke the three lazy arbitrary factories as
  `Schema.toArbitrary(schema)(FastCheck)`;
- update three `SchemaIssue.InvalidValue` constructions to the
  `(annotations, input?, options?)` signature;
- update the Alchemy beta.72 Drizzle subpath/Postgres API and beta.107
  `HttpPlatform` service shape without adding a compatibility alias or patch.

Add and run the real Drizzle/Alchemy runtime-import regression, then regenerate
and verify the TypeScript/Rust parity fixtures:

```sh
node scripts/run-local-vp.mjs test run infra/relay/src/dbRuntime.test.ts infra/relay/src/persistence/schema.test.ts infra/relay/src/http/Api.test.ts
vp run --filter @bibcode/contracts generate:rust-auth-fixtures
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
node scripts/run-local-vp.mjs test run packages/contracts/src/authRustParity.test.ts packages/contracts/src/rpcRustParity.test.ts
node scripts/run-msvc.mjs cargo test -p bibcode-server --test auth_http --test rpc_wire
```

Expected: the runtime boundary loads without deploy/network activity, generated
fixtures match beta.107's schema AST/arbitrary behavior, and both TypeScript and
Rust parity checks pass.

- [ ] **Step 6: Synchronize configured vendored references**

The normal public command is clean-only and stages its exact snapshot without
committing. Tasks 0–12 intentionally accumulate reviewed staged changes, so do
not invoke that command directly in the migration worktree. Assemble a
disposable clean repository from the current reviewed staged tree plus the
current Task 8 patch, then run both configured syncs atomically:

```sh
vp run sync:repos
```

Expected in the disposable repository: zero commits are created, only the two
`.repos` prefixes are staged, `.repos/effect-smol` matches Effect beta.107, and
`.repos/alchemy-effect` matches Alchemy beta.72 after pruning `.gitmodules`, the
entire unresolved-gitlink `.vendor` directory, `cloudflare-tools`, and
`distilled`. Sync must start clean, create zero commits, preserve exact path
casing/modes and upstream-tracked ignored files, treat every configured prefix
and prune path as a literal Git path, and stage only the selected snapshot. One
atomic `bibcode-reference-repos-sync.lock` file under the absolute Git common
directory must serialize the initial clean check through apply or verified
rollback across linked worktrees; a contender fails before fetch and never
steals the lock. Success, pre-apply failure, verified rollback, and recovered
interruption remove it. A timed-out, failed, or unverified rollback retains the
lock because the index/worktree may require manual recovery. If a crash or
failed recovery leaves a stale lock, verify through process inspection that no
`sync-reference-repos` process owns the repository and recover or verify the
index/worktree before removing only that exact file; sync never removes it
automatically. Verify the configured content trees are
`5e77033d116402945c4115c8c3c6b8fce8ec81e8` and
`61ba96e20b8d9c45f967e3ebdc8f406696aae4eb`. Do not hand-edit either snapshot.

After verification, expose the disposable staged tree through a temporary
disposable commit/ref, fetch its objects without updating a migration branch,
and construct a task-specific temporary index from the current migration index
tree. Remove and overlay only `.repos/effect-smol` and
`.repos/alchemy-effect`, verify the same subtree hashes, then apply that exact
two-prefix tree transition to the migration index with Git tree plumbing. The
migration branch receives no commit or ref update; all non-vendored staged and
working changes remain untouched. Remove the exact disposable repository and
temporary ref after the transition.

- [ ] **Step 7: Compile every Effect-owning package**

Run:

```sh
vp run --filter @bibcode/contracts typecheck
vp run --filter @bibcode/shared typecheck
vp run --filter @bibcode/client-runtime typecheck
vp run --filter @bibcode/web typecheck
vp run --filter bibcode-relay typecheck
vp run --filter @bibcode/oxlint-plugin-bibcode typecheck
vp run --filter @bibcode/scripts typecheck
```

Expected: all packages typecheck without adding `any`, suppressions, compatibility aliases, or a second Effect runtime.

- [ ] **Step 8: Run the representative and complete JS suites**

Run the Step 1 command again, then:

```sh
vp test
vp run test
```

Expected: every Effect-backed test file loads through the patched Vite+ adapter and passes.

- [ ] **Step 9: Checkpoint without committing**

Run:

```sh
git diff --check -- . ':(exclude).repos/**'
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: the repository-owned diff check passes, the old Effect patch is gone,
the beta.107 patch is registered, and commit count remains `0`. Count and report
vendored `git diff --check` diagnostics as exact upstream fidelity evidence;
do not hand-edit them. The configured subtree hashes above are the acceptance
boundary for vendored content.

---

### Task 9: Gate and retain the WebdriverIO/Tauri test cohort

**Ruling:** Executed on 2026-09-04. Retain the complete 1.2/9.29 cohort. The
researched 1.3/9.31 targets remain active-ledger blocked targets rather than
installed current values.

**Files:**

- Preserve: `apps/desktop/package.json`
- Preserve: `apps/web/package.json`
- Preserve: `pnpm-workspace.yaml`
- Preserve: `pnpm-lock.yaml`
- Preserve: `patches/@wdio__tauri-plugin@1.2.0.patch`
- Modify: `docs/superpowers/specs/2026-09-03-dependency-toolchain-supported-convergence-design.md`
- Modify: `docs/superpowers/plans/2026-09-03-dependency-toolchain-supported-convergence.md`
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`
- Modify: `scripts/check-dependency-upgrade-ledger.test.ts`
- Report: `.superpowers/sdd/2026-09-03-dependency-toolchain-supported-convergence/task-9-report.md`

**Interfaces:**

- Consumes: React/Vite+ toolchain, Tauri API 2.11.1, and the packaged desktop
  lifecycle contract that treats hook cleanup warnings as failures.
- Produces: direct WebdriverIO 9.29.1, Service/Plugin 1.2.0, native-utils 2.5.0,
  the service native-utils override, and the existing generic frontend typing
  patch. It also produces an explicit blocked release condition for 1.3/9.31.

- [x] **Step 1: Run the retained-cohort compatibility baseline**

```sh
node scripts/run-local-vp.mjs test run apps/desktop/e2e/support/tauri-service-compat.test.ts apps/desktop/e2e/support/app-lifecycle.test.ts apps/desktop/e2e/support/webdriver-request.test.ts apps/desktop/e2e/support/ui-state.test.ts
```

Observed before research: 4 files and 17 tests passed on 1.2/9.29.

- [x] **Step 2: Inspect the researched 1.3/9.31 graph without accepting it**

The exact researched direct targets remain:

```json
{
  "@wdio/cli": "9.31.5",
  "@wdio/globals": "9.31.3",
  "@wdio/local-runner": "9.31.5",
  "@wdio/mocha-framework": "9.31.5",
  "@wdio/native-utils": "2.6.0",
  "@wdio/spec-reporter": "9.31.2",
  "@wdio/tauri-service": "1.3.0",
  "webdriverio": "9.31.5",
  "@wdio/tauri-plugin": "1.3.0"
}
```

Tarball and installed-source inspection proved Plugin 1.3.0 still needs the
same generic `invoke<T>` / `listen<T>` change. Service 1.3.0 directly selects
native-utils 2.6.0, but pins globals/spec/types 9.29.1 and calls page-side mock
restoration from `afterSession` after WDIO has removed the session ID.

- [x] **Step 3: Test coherent and requested Service 1.3 runner tuples**

Disposable runners tested Service 1.3 with its coherent 9.30.0 cohort, the
newest coherent 9.30.1 cohort, and the requested 9.31 cohort. A title-only spec
with no registered mock still logged:

```text
Failed to clear mock store: Error: A sessionId is required for this command
```

The 9.30.1 tuple has no Wdio peer error but still warns. The 9.31 tuple resolves
Service's globals 9.29.1 peer against expect 6.0.10 instead of declared expect
5.x and creates separate direct/service globals and expect instances. Both
instances executed the smoke successfully, but the split is unsupported.

- [x] **Step 4: Attribute the packaged activity failure with one variable at a time**

A disposable detached commit over exact Task-8 tree
`b6b59c410bd58065d11800afa8b5c1a6b4463713` built with old Service/Plugin 1.2
and Wdio 9.29.1. Its long-root activity run failed, but its short-root rerun
passed that one focused activity spec in 10.3 seconds. The rejected Task-9
Service/Plugin 1.3 and Wdio 9.31 package passed the activity spec in 10.3
seconds and all seven default scenarios in 43.8 seconds from a short root, but
its log retained the disqualifying `afterSession` / missing-session-ID warning.
That experimental full run is not retained-cohort evidence.

The failed roots generated 113- and 118-byte Codex Unix socket paths, exceeding
the server's 100-byte soft limit; the successful roots generated 76-byte paths
and terminal activity scopes at revision 6. This is a harness-root constraint,
not a Task 8 or Task 9 product regression. Use a short task-owned root such as:

```sh
run_root="$(mktemp -d /tmp/t9.XXXXXX)"
BIBCODE_E2E_RUN_ROOT="$run_root" vp run test:ui:desktop
```

- [x] **Step 5: Apply the hold**

Retain exactly:

```json
{
  "@wdio/cli": "9.29.1",
  "@wdio/globals": "9.29.1",
  "@wdio/local-runner": "9.29.1",
  "@wdio/mocha-framework": "9.29.1",
  "@wdio/native-utils": "2.5.0",
  "@wdio/spec-reporter": "9.29.1",
  "@wdio/tauri-service": "1.2.0",
  "webdriverio": "9.29.1",
  "@wdio/tauri-plugin": "1.2.0"
}
```

Keep `"@wdio/tauri-service>@wdio/native-utils": 2.5.0` and
`patches/@wdio__tauri-plugin@1.2.0.patch`. Do not keep a 1.3 patch. The release
condition is one upstream Service release that fixes teardown ordering and
aligns its globals/expect dependency with the chosen direct Wdio cohort.

- [x] **Step 6: Verify the executable hold and policy contracts**

```sh
node scripts/run-local-vp.mjs test run scripts/check-dependency-upgrade-ledger.test.ts -t 'records the approved convergence targets and patch set'
node scripts/run-local-vp.mjs test run apps/desktop/e2e/support/tauri-service-compat.test.ts apps/desktop/e2e/support/app-lifecycle.test.ts apps/desktop/e2e/support/webdriver-request.test.ts apps/desktop/e2e/support/ui-state.test.ts
vp run --filter @bibcode/desktop typecheck
vp check
git diff --check -- . ':(exclude).repos/**'
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Observed: the focused current/blocked target and two-patch contract passed; the
compatibility suite passed 17 tests; desktop typecheck and `vp check` passed;
the non-vendor diff gate passed; and commit count remained `0`. The full ledger
validator still reports the 49 Task-12-owned current-value reconciliations from
Tasks 1–8 and is intentionally not closed here.

- [x] **Step 7: Produce genuine retained-cohort full-suite evidence**

Build the current staged-plus-working source after the hold has restored
Service/Plugin 1.2, Wdio 9.29.1, and native-utils 2.5.0. Use only the known
command-local pnpm age bypass for the build, then mount the exact DMG read-only
and run all default specs from a short launcher root without setting `HOME` or
`CODEX_HOME`:

```sh
PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 BIBCODE_E2E_PLATFORM=mac vp run test:ui:desktop:build

BIBCODE_E2E_PLATFORM=mac \
BIBCODE_E2E_APP_PATH=/tmp/t9m.MoDSrI/BiBCode.app \
BIBCODE_E2E_RUN_ROOT=/tmp/t9r.VyYMt2 \
BIBCODE_E2E_ARTIFACT_DIR=/private/tmp/bibcode-task9-round1-artifacts.fWhYi3 \
vp run test:ui:desktop
```

Observed on macOS arm64: the retained-cohort package build passed; the DMG was
17,112,590 bytes with SHA-256
`6fc9843b9661c98b0af8408d1295e9506af7950f915b1585a536fe72559a9d88`;
all seven default scenarios passed in one worker in 44.4 seconds. Logs contain
no `afterSession`, missing-session-ID, Service warning, error, or panic. The
terminal activity scope reached revision 6, and ten `pierre-*.png` screenshots
were retained. The launcher removed its run root. The exact task-owned Cursor
opener tree ignored TERM for 12 seconds and was killed by its four validated
PIDs; the read-only DMG was detached, TCP 4445 was free, and no task process or
mount remained.

---

### Task 10: Upgrade compatible Rust and Tauri dependencies and refresh fixture locks

**Files:**

- Modify: `Cargo.toml:9-99`
- Modify: `Cargo.lock`
- Modify: `apps/server/tests/fixtures/task8-harness/Cargo.lock`
- Modify: `apps/server/tests/fixtures/task9-harness/Cargo.lock`
- Do not modify: fixture `Cargo.toml` files
- Do not modify: `third_party/portable-pty/**`

**Interfaces:**

- Consumes: Rust/Cargo 1.98.0 and the retained Wdio JS 1.2.0 boundary.
- Produces: approved Rust patches, matched Tauri plugins, and latest compatible isolated fixture resolutions while preserving all breaking-family holds.

- [ ] **Step 1: Run focused Rust baselines**

Run:

```sh
cargo test -p bibcode-server --test persistence_backup --test persistence_compat --test rpc_wire --test process_runner --test remote_update_rpc --test server_runtime
cargo test -p bibcode-desktop -j 2
cargo test -p bibcode-updater-verifier
cargo test --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml
cargo test --manifest-path apps/server/tests/fixtures/task9-harness/Cargo.toml
```

Expected: PASS before Rust dependency changes.

- [ ] **Step 2: Raise explicit production floors**

Set:

```toml
clap = { version = "4.6.6", features = ["derive", "env"] }
futures-util = { version = "0.3.34", features = ["sink"] }
open = "5.4.3"
rusqlite = { version = "0.40.2", features = ["backup", "bundled", "hooks"] }
tokio = { version = "1.53.1", features = ["fs", "io-util", "macros", "net", "process", "rt-multi-thread", "signal", "sync", "time"] }
tokio-util = { version = "0.7.19", features = ["io", "rt"] }
toml = "1.1.5"
tower-http = { version = "0.7.1", features = ["cors"] }
uuid = { version = "1.26.0", features = ["v4"] }
```

Keep broad `libc = "0.2"`, `serde_json = "1"`, `thiserror = "2"`, and `time = "0.3"` declarations; their approved patches are selected by `Cargo.lock`.

- [ ] **Step 3: Set the matched Tauri plugin targets**

Set:

```toml
tauri-plugin-deep-link = "2.4.10"
tauri-plugin-dialog = "2.7.3"
tauri-plugin-opener = "2.5.5"
tauri-plugin-shell = "2.3.6"
tauri-plugin-single-instance = { version = "2.4.4", features = ["deep-link"] }
tauri-plugin-updater = "2.11.0"
tauri-plugin-wdio = "=1.2.0"
tauri-plugin-wdio-webdriver = "=1.2.0"
```

Keep Tauri 2.11.5, Tauri Build 2.6.3, and Tauri Store 2.4.4 unchanged. The Wdio
Rust crates remain exact at 1.2.0 with the JavaScript Service/Plugin hold; keep
their researched 1.3.0 targets blocked in the active ledger until the upstream
Service release condition is satisfied.

- [ ] **Step 4: Regenerate the root Rust graph under Rust 1.98**

Run:

```sh
rustup run 1.98.0 cargo update
rustup run 1.98.0 cargo tree --workspace --duplicates
rustup run 1.98.0 cargo tree -i tao
```

Expected direct resolutions include Time 0.3.55, Serde JSON 1.0.151, Thiserror 2.0.20, libc 0.2.189, the explicit targets above, local portable-pty 0.9.0, and Tao at the retained Git revision. Base64 remains 0.22.x, Process Wrap remains 9.1.0, and production Windows remains 0.61.x.

- [ ] **Step 5: Refresh each isolated fixture lockfile without widening its manifest**

Run:

```sh
rustup run 1.98.0 cargo update --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml
rustup run 1.98.0 cargo update --manifest-path apps/server/tests/fixtures/task9-harness/Cargo.toml
git diff --exit-code -- apps/server/tests/fixtures/task8-harness/Cargo.toml apps/server/tests/fixtures/task9-harness/Cargo.toml
```

Expected: only fixture lockfiles change; Task 8 keeps SHA2 0.10, Sysinfo 0.37, Process Wrap 9, Base64 0.22, and the local PTY.

- [ ] **Step 6: Run focused Rust post-upgrade tests**

Run the Step 1 command again, then:

```sh
cargo check --workspace --all-targets
cargo fmt --all --check
```

Expected: all commands pass on Rust 1.98.0.

- [ ] **Step 7: Run clean warnings-denied Clippy**

Run:

```sh
cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: exit 0 with fresh lint evidence.

- [ ] **Step 8: Checkpoint without committing**

Run:

```sh
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: no retained Rust boundary changed and commit count remains `0`.

---

### Task 11: Refresh immutable GitHub Action pins and workflow contracts

**Ruling:** Executed on 2026-09-04 with the user-approved live, verified
`dtolnay/rust-toolchain` 1.98.0 commit
`62ae3a85dbdd2bedbb5819da8ce45635129289a1`. This supersedes the stale planned
SHA and must remain the immutable Rust-action pin.

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/desktop-ui-smoke.yml`
- Modify: `.github/workflows/deploy-relay.yml`
- Modify: `.github/workflows/desktop-upgrade-smoke.yml`
- Modify: `.github/workflows/pr-size.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/ci-platform-contract.test.ts`
- Modify: `scripts/workflow-dependencies.test.ts` only if a tag-major assertion changes
- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`

**Interfaces:**

- Consumes: Node 26.8.1, Rust 1.98.0, Vite+ 0.3.0, and final package graph.
- Produces: immutable pins for Checkout 7.0.1, Rust Cache 2.9.2, setup-vp 1.18.0, action-gh-release 3.0.3, and Rust 1.98.0 setup.

- [ ] **Step 1: Verify the approved tag-to-SHA mappings**

Run:

```sh
gh api repos/actions/checkout/commits/v7.0.1 --jq .sha
gh api repos/Swatinem/rust-cache/commits/v2.9.2 --jq .sha
gh api repos/voidzero-dev/setup-vp/commits/v1.18.0 --jq .sha
gh api repos/softprops/action-gh-release/commits/v3.0.3 --jq .sha
gh api repos/dtolnay/rust-toolchain/commits/1.98.0 --jq .sha
```

Expected, in order:

```text
3d3c42e5aac5ba805825da76410c181273ba90b1
6323deb102c322ba6fcbdcafc7e3dddab59af2b6
1b32467adbe183473499fd9d5d372c3ed9641754
efb35369e0ad2afab669f228072c1b0d510eae64
62ae3a85dbdd2bedbb5819da8ce45635129289a1
```

A mismatch means the tag moved and blocks the action update; do not accept a different SHA silently.

- [ ] **Step 2: Replace workflow revisions and comments**

Use these exact references everywhere each action appears:

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2
uses: voidzero-dev/setup-vp@1b32467adbe183473499fd9d5d372c3ed9641754 # v1.18.0
uses: softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64 # v3.0.3
uses: dtolnay/rust-toolchain@62ae3a85dbdd2bedbb5819da8ce45635129289a1 # 1.98.0
```

Do not change workflow permissions, triggers, artifact topology, or trust boundaries.

- [ ] **Step 3: Replace hard-coded Rust installer versions**

Change the WSL and release shell installer arguments from `1.97.1` to `1.98.0` in `desktop-upgrade-smoke.yml` and `release.yml`.

- [ ] **Step 4: Update exact CI contract expectations**

Update any exact `uses:` value and Rust version string in `scripts/ci-platform-contract.test.ts` to the mappings above. Preserve matrix membership, job order, permissions, release gating, and non-publishing validation assertions.

- [ ] **Step 5: Run workflow contract tests**

Run:

```sh
node scripts/run-local-vp.mjs test run scripts/workflow-dependencies.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/rust-workspace.test.ts scripts/toolchain-contract.test.ts
vp run release:smoke
```

Expected: every action remains immutable-SHA pinned, ledger tags/SHAs match, six-target matrices remain intact, and validation-only release flows do not publish.

- [ ] **Step 6: Checkpoint without committing**

Run:

```sh
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: commit count remains `0`.

---

### Task 12: Close the active ledger and update living procedures

**Files:**

- Modify: `docs/dependency-upgrades/2026-07-17-ledger.json`
- Create: `docs/dependency-upgrades/2026-09-03-supported-convergence-report.md`
- Modify: `docs/reference/scripts.md`
- Modify: `docs/operations/ci.md`
- Modify: `docs/operations/release.md`
- Modify: `docs/testing/cross-platform-validation.md`
- Modify: `docs/testing/windows-desktop.md`
- Modify: `docs/testing/linux-desktop.md`
- Modify: `docs/testing/macos-desktop.md`
- Modify: `CHANGELOG.md`
- Verify unchanged: `docs/dependency-upgrades/2026-07-17-final-report.md`

**Interfaces:**

- Consumes: final manifests, lockfiles, patches, workflow pins, and all focused results.
- Produces: zero unaccounted dependencies, no unreviewed pending entries, accurate runbooks, and a dated evidence report.

- [ ] **Step 1: Requery direct JavaScript dependencies**

Run:

```sh
pnpm outdated --recursive --format json
pnpm view vite-plus version
pnpm view @voidzero-dev/vite-plus-core version
pnpm view typescript version
pnpm view react version
pnpm view react-dom version
pnpm view effect dist-tags --json
pnpm view drizzle-orm dist-tags --json
pnpm view drizzle-kit dist-tags --json
```

Expected: remaining outdated output contains only approved retained boundaries or a newer release published after the frozen 2026-09-03 target set. Do not silently add a newly published version to this migration.

- [ ] **Step 2: Requery Rust compatibility**

Run:

```sh
cargo update --dry-run
cargo tree --workspace --duplicates
```

Expected: no compatible lockfile change remains. New breaking-family releases stay documented exceptions.

- [ ] **Step 3: Finalize ledger statuses and validation metadata**

Set every completed migration row to `green`, already-current rows to `current`, and retained boundaries to `blocked` with their exact release condition. Update `auditDate` to `2026-09-03`, final version targets, action tags/SHAs, toolchain pins, inventory counts, command results, and native-validation status. Leave no unexplained `pending` row.

- [ ] **Step 4: Run the ledger validator**

Run:

```sh
vp run check:dependency-ledger
```

Expected: exit 0 and report zero unaccounted declarations.

- [ ] **Step 5: Update living documentation**

Document Node 26.8.1, pnpm 11.25.0, Rust 1.98.0, Vite+ 0.3.0, the one-local-Vite+ test rule, updated action tags, and any changed packaged/native command behavior. Preserve the living-versus-historical distinction and keep execution-specific counts/timings out of runbooks.

- [ ] **Step 6: Write the execution report structure with observed evidence only**

Create `docs/dependency-upgrades/2026-09-03-supported-convergence-report.md` with these sections:

```markdown
# Supported Dependency and Toolchain Convergence Report

## Result
## Final Toolchains
## Upgraded Cohorts
## Retained Boundaries
## Patch Reconciliation
## Local Validation
## Native and Packaged Validation
## Reproducibility
## Residual Risk
```

Populate each command, exit status, observed version, native/compatibility/unavailable evidence class, and residual risk from actual results. Do not copy historical test counts.

- [ ] **Step 7: Review testing runbooks**

Compare the shared and three OS-specific runbooks with source, scripts, CI, release workflows, and the new toolchain behavior. Update changed steps. If a runbook needs no text change, state in the final report that it was **reviewed and remains accurate**.

- [ ] **Step 8: Add a concise changelog entry**

Under the current unreleased section, record the dependency/toolchain convergence, single Vite+/Vitest runtime, patch removals/rebases, retained compatibility boundaries, and Rust 1.98 support. Do not claim native matrices passed until they have.

- [ ] **Step 9: Checkpoint without committing**

Run:

```sh
git diff --check
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

Expected: documentation matches executable state and commit count remains `0`.

---

### Task 13: Run complete verification and create the sole commit

**Ruling:** Executed verification on 2026-09-04 added a fail-closed shared Clerk
host rule: every DNS label beginning `xn--` is rejected before URL construction.
This intentionally leaves valid IDN custom Clerk Frontend API domains
unsupported until BiBCode owns a deterministic cross-runtime IDNA validator.
The exact source, test, and documentation paths are
`packages/shared/src/relayAuth.ts`, `packages/shared/src/relayAuth.test.ts`, and
`docs/cloud/bibcode-connect-clerk.md`.

**Files:**

- Review: every migration file from Tasks 1–12.
- Review: the Task 13 Clerk amendment source, test, and documentation paths
  named above.
- Stage: approved spec, this plan, manifests, lockfiles, patches, source/config changes, tests, workflows, ledger, report, runbooks, and changelog.
- Exclude: `outputs/`, `.codegraph/`, caches, build outputs, screenshots, logs, and unrelated files.

**Interfaces:**

- Consumes: all green uncommitted cohorts.
- Produces: exactly one migration commit and complete local/native evidence.

- [ ] **Step 1: Review the complete diff and status**

Run:

```sh
git diff --stat
git diff --check
git status --short
git diff -- package.json pnpm-workspace.yaml Cargo.toml rust-toolchain.toml .devcontainer/devcontainer.json
git diff -- patches .github/workflows scripts docs CHANGELOG.md
```

Expected: only approved migration files plus the untracked `outputs/` directory appear. No generated caches, debug output, temporary package tarballs, or unrelated cleanup is present.

- [ ] **Step 2: Stage the reviewed migration without committing**

The isolated worktree began with no unrelated tracked changes, so stage all reviewed tracked modifications/deletions, then add only the approved new files:

```sh
git add -u -- .
git add docs/superpowers/specs/2026-09-03-dependency-toolchain-supported-convergence-design.md docs/superpowers/plans/2026-09-03-dependency-toolchain-supported-convergence.md docs/dependency-upgrades/2026-09-03-supported-convergence-report.md patches/@effect__vitest@4.0.0-beta.107.patch patches/@wdio__tauri-plugin@1.2.0.patch
git status --short
git diff --cached --check
```

Expected: `outputs/` remains untracked and unstaged; every staged path was reviewed in Step 1. If any unexpected tracked path appears, unstage that exact path and investigate before continuing.

- [ ] **Step 3: Verify a clean frozen install from the staged final tree**

Run:

```sh
audit_clean_root="$(mktemp -d /tmp/bibcode-dependency-clean.XXXXXX)"
audit_clean_patch="$audit_clean_root/migration.patch"
git diff --cached --binary > "$audit_clean_patch"
git worktree add --detach "$audit_clean_root/worktree" "$BIBCODE_MIGRATION_BASE"
git -C "$audit_clean_root/worktree" apply "$audit_clean_patch"
git -C "$audit_clean_root/worktree" diff --binary -- package.json pnpm-workspace.yaml pnpm-lock.yaml Cargo.toml Cargo.lock > "$audit_clean_root/before-install.patch"
(
  cd "$audit_clean_root/worktree"
  corepack prepare pnpm@11.25.0 --activate
  pnpm install --frozen-lockfile
  cargo fetch --locked
  git diff --binary -- package.json pnpm-workspace.yaml pnpm-lock.yaml Cargo.toml Cargo.lock > "$audit_clean_root/after-install.patch"
  cmp "$audit_clean_root/before-install.patch" "$audit_clean_root/after-install.patch"
)
git worktree remove --force "$audit_clean_root/worktree"
```

Expected: the clean detached copy installs from the staged final manifests and lockfiles without changing them. Keep the temporary patch until Task 13 is complete; it is outside the repository and is never staged.

- [ ] **Step 4: Run every repository-wide gate**

Run:

```sh
vp run check:dependency-ledger
vp check
vp run typecheck
vp test
vp run test
vp run build
vp run release:smoke
cargo fmt --all --check
cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets -j 2
cargo test --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml
cargo test --manifest-path apps/server/tests/fixtures/task9-harness/Cargo.toml
cargo update --dry-run
```

Expected: all required commands exit 0. `pnpm outdated` is evaluated separately against retained exceptions rather than treated as an unconditional zero-exit command.

- [ ] **Step 5: Run the host-native desktop and updater gate**

On the current host, run the matching documented artifact build plus:

```sh
vp run test:ui:desktop:build
vp run test:ui:desktop
vp run test:desktop:upgrade
```

Expected: packaged UI and seeded updater pass. Record the exact native host/architecture; do not generalize it to unexecuted targets.

- [ ] **Step 6: Confirm tests did not add unstaged changes**

Run:

```sh
git diff --exit-code
git diff --cached --check
git status --short
```

Expected: the migration remains staged exactly as reviewed; only `outputs/` is untracked.

- [ ] **Step 7: Create the sole commit**

Run:

```sh
git commit -m "chore(deps): converge supported toolchains and dependencies"
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
git status --short
```

Expected: commit count is exactly `1`; tracked worktree state is clean; `outputs/` remains untracked.

- [ ] **Step 8: Push and run all native matrices**

After user authorization to push, run:

```sh
git push --force-with-lease -u origin "$(git branch --show-current)"
gh pr create --draft --base main --head "$(git branch --show-current)" --title "chore(deps): converge supported toolchains and dependencies" --body "One-commit supported dependency and toolchain convergence. No release publishing."
gh workflow run desktop-ui-smoke.yml --ref "$(git branch --show-current)"
gh workflow run desktop-upgrade-smoke.yml --ref "$(git branch --show-current)"
gh workflow run release.yml --ref "$(git branch --show-current)" -f channel=stable -f validate_only=true -f publish=false
```

Wait for the check, test, release-smoke, six-target native desktop/server, packaged UI, seeded updater, WSL x64, and release-assembly validation jobs. Do not publish a release.

- [ ] **Step 9: Repair CI without violating one-commit history**

For any failure, reproduce it locally or on the matching native host, use `superpowers:systematic-debugging`, modify only the owning cohort, rerun its focused tests and Task 13 Step 4, then run:

```sh
git add -u -- .
git diff --cached --name-only
git diff --cached --check
git commit --amend --no-edit
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
git push --force-with-lease
```

Expected: the cached name list contains only reviewed repair paths and commit count remains exactly `1`; `git add -u` excludes the untracked `outputs/` directory. A repair that creates a new file requires an approved plan amendment naming that file before it can be staged.

- [ ] **Step 10: Complete the execution report and verify final history**

After all CI results are known, update the report and active ledger with actual run URLs, native/compatibility/unavailable classifications, commands, counts, and residual risk. Run:

```sh
git add docs/dependency-upgrades/2026-09-03-supported-convergence-report.md docs/dependency-upgrades/2026-07-17-ledger.json
git commit --amend --no-edit
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
git show --stat --oneline HEAD
git status --short
```

Expected: one commit, complete evidence, clean tracked state, and only the preserved untracked research output.

## Plan Self-Review Mapping

| Spec requirement | Implementing task |
| --- | --- |
| One-commit history and amend-only repair | Tasks 0 and 13 |
| Node/pnpm/Rust/Vite+ contract | Tasks 1 and 2 |
| Marketing TypeScript 6 hold | Tasks 1, 3, and 12 |
| React/router/Pacer behavior | Task 4 |
| Lexical 0.50 migration | Task 5 |
| Clerk/Jose/Noble trust boundary | Task 6 |
| Pierre stable migration and patch removal | Task 7 |
| Effect beta.107 and single Vitest runtime | Tasks 2 and 8 |
| Wdio/Tauri compatibility gate and supported hold | Task 9 |
| Rust/Tauri updates and retained families | Task 10 |
| Immutable Action pins | Task 11 |
| Ledger, runbooks, report, and changelog | Task 12 |
| Repository/native/release evidence | Task 13 |
