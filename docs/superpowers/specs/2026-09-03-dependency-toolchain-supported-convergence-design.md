# Dependency and Toolchain Supported Convergence Design

**Status:** Approved in chat on 2026-09-03; amended by the executed Task 8,
Task 9, Task 11, and Task 13 rulings on 2026-09-04.

**Delivery constraint:** The migration lands as exactly one commit above its
selected base. Intermediate work may be tested in cohorts, but it remains
uncommitted until the complete migration is green. Any CI repair amends that
same commit.

## Amendment audit trail

- **Task 8 preview tuple:** retain Effect beta.107 and select Alchemy
  `2.0.0-beta.72` with exact `drizzle-orm` and `drizzle-kit`
  `1.0.0-rc.5-ab785fc`. Alchemy beta.76 was rejected because it requires the
  separately excluded Effect RC.112 line, and Drizzle RC.4 crashed while
  evaluating `drizzle-orm/effect-postgres` against beta.107. The executable
  boundary is `infra/relay/src/dbRuntime.test.ts` and the selected declarations
  are in `infra/relay/package.json`.
- **Task 9 Wdio hold:** retain Service/Plugin 1.2.0, direct WebdriverIO 9.29.1,
  and native-utils 2.5.0 until one upstream Service release fixes
  `afterSession` teardown ordering and aligns its globals/expect cohort.
- **Task 11 Rust action pin:** use the user-approved live, verified
  `dtolnay/rust-toolchain` 1.98.0 commit
  `62ae3a85dbdd2bedbb5819da8ce45635129289a1`; do not restore the stale planned
  SHA.
- **Task 13 Clerk host policy:** reject every DNS label beginning `xn--` before
  URL construction. This fail-closed ruling deliberately makes valid IDN
  custom Clerk Frontend API domains unsupported until BiBCode owns one
  deterministic cross-runtime IDNA validator. Source, regression coverage, and
  user-facing compatibility documentation are
  `packages/shared/src/relayAuth.ts`, `packages/shared/src/relayAuth.test.ts`,
  and `docs/cloud/bibcode-connect-clerk.md`.

## Outcome

BiBCode moves every direct dependency and development toolchain to the newest
version that has a defensible, testable target on 2026-09-03. The migration
accepts high-value coordinated changes such as Vite+ 0.3, Effect v4 beta.107,
Lexical 0.50, stable Pierre Diffs 1.3.6, current Tauri plugins, and the desktop
test stack. It does not force versions whose upstream channel, local patch,
platform family, or compatibility boundary makes "latest" unsafe.

The final result is one reviewable repository state with aligned manifests,
lockfiles, patches, CI actions, toolchain contracts, dependency policy,
runbooks, and validation evidence. Node.js and TypeScript remain development
dependencies only; no production Node runtime, TypeScript service, Electron
host, or helper sidecar is introduced.

## Why this is one program

The migration crosses seven coupled areas:

1. exact Node, pnpm, Rust, Cargo, and Vite+ toolchain contracts;
2. React, editor, router, authentication, state, and rendering packages;
3. the Effect v4 preview cohort and its patched Vite+ test adapter;
4. Rust server, desktop, storage, networking, and platform dependencies;
5. Tauri production plugins and the WebdriverIO/Tauri packaged-UI harness;
6. immutable GitHub Action pins and six-target release workflows; and
7. the active dependency ledger, living runbooks, and release evidence.

These areas are tested in ordered cohorts so a failure is attributable, but
the user-selected history contract requires a single final commit rather than
one commit per cohort.

## Global constraints

- Preserve package ownership and dependency direction defined in `AGENTS.md`.
- Privileged desktop behavior continues to cross `DesktopBridge`; normal
  application traffic remains typed HTTP/WebSocket RPC.
- `packages/contracts` remains schema-only.
- Do not add runtime JavaScript to the shipped desktop or server artifacts.
- Keep `vite` aliased to `@voidzero-dev/vite-plus-core`; do not replace the
  repository toolchain with standalone upstream Vite.
- Keep every Effect v4 package on one prerelease train.
- Keep React and React DOM exact and identical.
- Keep Lexical core and React bindings identical.
- Keep Clerk browser, backend, shared, and clerk-js packages on one train and
  retain the wallet-package exclusions.
- Keep Drizzle ORM and Kit identical.
- Keep the JavaScript and Rust Tauri Wdio packages on the validated 1.2.0
  boundary, with direct WebdriverIO packages at 9.29.1 and native-utils 2.5.0,
  until one upstream Service release both fixes `afterSession` teardown
  ordering and aligns its `@wdio/globals` / `expect-webdriverio` cohort.
- Keep WebdriverIO runtime packages in a metadata-supported cohort rather than
  forcing newer independently published packages around an older Service pin.
- Preserve canonical ASCII Clerk authentication and wire behavior. The approved
  Task 13 exception rejects every `xn--` label fail-closed and therefore does
  not promise completely unchanged behavior for IDN custom domains.
- Preserve the local `portable-pty` fork and the Tao Git revision.
- Do not hand-edit `.codegraph/` or generated package-manager content.
- Preserve the user-owned untracked `outputs/` research workbook; it is
  evidence for planning, not migration source to stage or commit.
- The migration commit contains the approved design, implementation plan,
  source/configuration changes, lockfiles, policy ledger, and affected living
  documentation. It contains no temporary reports, caches, screenshots, or
  machine-specific logs.

## Target toolchain

| Tool | Current | Target | Policy |
| --- | --- | --- | --- |
| Node.js | 26.5.0 | 26.8.1 | Exact repository and devcontainer pin |
| pnpm | 11.15.0 | 11.25.0 | Exact `packageManager` and Corepack target |
| Rust | 1.97.1 | 1.98.0 | Exact toolchain and workspace MSRV |
| Cargo | 1.97.1 | 1.98.0 | Moves with Rust |
| Rust edition | 2024 | 2024 | Unchanged |
| TypeScript, main workspace | 7.0.2 | 7.0.2 | Already current |
| TypeScript, marketing | 6.0.3 | 6.0.3 | Retained compatibility island |
| Vite+ | 0.2.5 | 0.3.0 | Exact catalog pin |
| `@voidzero-dev/vite-plus-core` alias | 0.2.5 | 0.3.0 | Exact and identical to Vite+ |
| Vite bundled by Vite+ | 8.1.4 | 8.2.2 | Obtained only through Vite+ 0.3 |
| Vitest bundled by Vite+ | 4.1.10 | 4.1.11 | One test runtime only |
| Rolldown bundled by Vite+ | 1.1.5 | 1.2.5 | Vite+ 0.3 selected version |
| Oxfmt bundled by Vite+ | 0.58.0 | 0.64.0 | Vite+ 0.3 selected version |
| Oxlint bundled by Vite+ | 1.73.0 | 1.79.0 | Vite+ 0.3 selected version |
| oxlint-tsgolint | 0.24.0 | 7.0.2001 | Vite+ 0.3 selected version |

The direct `@oxlint/plugins` dependency targets exact 1.79.0 for compatibility
with Vite+ 0.3's bundled Oxlint rather than independently selecting registry
latest 1.81.0. `@vitest/coverage-v8` targets 4.1.11 to match the one bundled
Vitest runtime.

GitHub publishes pnpm 12 releases, while the npm package's `latest` dist-tag
used by the repository's package-manager flow is 11.25.0. pnpm 12 remains a
separate major migration and is not silently combined with this convergence.

## JavaScript dependency targets

### Coordinated application cohorts

| Cohort | Current | Target | Required treatment |
| --- | --- | --- | --- |
| React and React DOM | 19.2.7 | 19.2.8 | Update exact pins together |
| React types | 19.2.17 / 19.2.3 | 19.2.18 / 19.2.6 | Update with React core |
| Lexical core and React | 0.48.0 | 0.50.0 | Migrate breaking 0.49 APIs, then accept 0.50 fixes |
| TanStack React Router | 1.170.18 | 1.170.32 | Update with router plugin |
| TanStack router plugin | 1.168.22 | 1.168.35 | Must satisfy its React Router peer |
| Effect v4 | beta.99 | beta.107 | Update every Effect package together |
| Alchemy and Drizzle | Alchemy beta.63 / Drizzle RC.4 | Alchemy beta.72 / Drizzle `1.0.0-rc.5-ab785fc` | Use the newest Alchemy preview compatible with Effect beta.107 and its exact Drizzle peer build |
| Pierre Diffs | 1.3.0-beta.10 | 1.3.6 | Reconcile local behavior patch before removal |
| Pierre Trees | 1.0.0-beta.5 | 1.0.0-beta.6 | Retain preview status |
| Clerk React | 6.12.5 | 6.15.0 | Update with all Clerk catalog entries |
| Clerk backend | 3.11.7 | 3.17.1 | Update with browser/relay train |
| Clerk JS | 6.25.5 | 6.31.0 | Catalog/override alignment |
| Clerk shared | 4.25.5 | 4.31.0 | Catalog/override alignment |
| Noble curves and hashes | 2.2.0 | 2.4.0 | Update together and run crypto parity tests |
| WebdriverIO/Tauri JS | 1.2.0 / Wdio 9.29.1 | Retain current; researched 1.3.0 / Wdio 9.31.x blocked | Service 1.3 warns during `afterSession`; its pinned globals expect v5 while Wdio 9.31 supplies expect v6 |

The Effect cohort includes `effect`, `@effect/atom-react`,
`@effect/platform-node`, `@effect/platform-node-shared`, `@effect/sql-d1`,
`@effect/sql-pg`, `@effect/sql-sqlite-do`, and `@effect/vitest`. The relevant
target is beta.107 even when an npm `latest` tag names the older stable v3 or
0.x product line. Exact catalog and override ownership prevents optional peer
resolution from pulling RC.112 companions into this conservative beta-to-beta
update.

`@effect/vitest` continues to use the sole Vite+ test runtime. The existing
patch is rebased from beta.99 to beta.107 unless beta.107 natively supports the
`vite-plus/test` import and export surface. In beta.107 the internal suite
lookup remains `V.TestRunner.getCurrentSuite`; the patch redirects only the
`V` import and never adds a runner-subpath import. The patch is removed only
when the installed package provides equivalent behavior and the complete
Effect-backed test suite proves that no second Vitest runtime is loaded.

Pierre Diffs 1.3.6 is compared with the beta.10 patch before installation is
accepted. The resulting state must preserve configurable gutter utilities,
line selection, and hover highlighting, and must not add editor pointer
handling when package-level line selection owns the gesture. If upstream 1.3.6
contains those semantics, the patch is deleted. Otherwise a minimal 1.3.6
patch carries only the still-missing behavior.

The researched Wdio Tauri plugin and Service 1.3.0 releases are not installed.
Plugin 1.3.0 still needs the generic `invoke<T>` and `listen<T>` declarations,
but Service 1.3.0 calls page-side mock restoration from `afterSession` after
WDIO has removed the session ID. That warning reproduces even with no registered
mock and with the newest internally coherent Wdio 9.30.1 cohort. Moving direct
packages to 9.31 additionally resolves Service's pinned
`@wdio/globals@9.29.1` against unsupported `expect-webdriverio` 6 state. Retain
Service/Plugin 1.2.0, direct Wdio 9.29.1, the native-utils 2.5.0 override, and
the existing narrow 1.2.0 generic-type patch. Record 1.3/9.31 as blocked until
one upstream Service release fixes teardown ordering and aligns the Wdio/expect
cohort; do not carry a third package patch or suppress the cleanup warning.

### Other JavaScript updates

The same commit takes these direct updates and preserves each declaration's
existing exact-versus-range intent:

| Package | Target |
| --- | --- |
| `@base-ui/react` | 1.7.0 |
| `@effect/tsgo` | 0.40.0 |
| `@fontsource-variable/dm-sans` | 5.3.0 |
| `@fontsource/jetbrains-mono` | 5.3.0 |
| `@legendapp/list` | 3.3.10 |
| `@tanstack/react-pacer` | 0.23.0 |
| `@types/node` | 26.4.1 |
| `@vercel/config` | 0.7.0 |
| `@vitejs/plugin-react` | 6.1.1 |
| `@vitest/coverage-v8` | 4.1.11 |
| `astro` | 7.3.0 |
| `@astrojs/check` | 0.9.10 |
| `happy-dom` | 20.13.2 |
| `jose` | 6.2.10 |
| `lucide-react` | 1.40.0 |
| `smol-toml` | 1.8.0 |
| `zustand` | 5.0.15 |
| `@cloudflare/workers-types` | 5.20260903.1 |
| `alchemy` | 2.0.0-beta.72 |

The two font packages move together. `@vercel/config` is a pre-1.0 migration,
so both `apps/web/vercel.ts` and `apps/marketing/vercel.ts` must compile and
their route/config contract tests must pass. TanStack Pacer 0.23 must preserve
the existing debounce timing, cancellation, and disposal behavior in UI state,
storage, chat, and pull-request dialog consumers.

No dependency is updated solely because a transitive lockfile version is
newer. Direct manifests and the active catalog remain the policy owners.

Alchemy beta.72 is the latest published preview whose peer range supports the
approved Effect beta.107 boundary. Its exact Drizzle peer build is
`1.0.0-rc.5-ab785fc` for both ORM and Kit. That tarball uses
`Schema.TaggedError`; retaining Drizzle RC.4 would fail while evaluating the
Effect Postgres adapter, while Alchemy beta.76 would pull the separately
excluded Effect RC.112 cohort.

## Rust dependency targets

### Production workspace updates

| Package | Current resolution | Target | Boundary |
| --- | --- | --- | --- |
| `clap` | 4.6.2 | 4.6.6 | CLI parsing |
| `futures-util` | 0.3.33 | 0.3.34 | Async streams/sinks |
| `libc` | 0.2.186 | 0.2.189 | Unix FFI |
| `open` | 5.4.0 | 5.4.3 | Platform launch |
| `rusqlite` | 0.40.1 | 0.40.2 | Bundled SQLite/persistence |
| `serde_json` | 1.0.150 | 1.0.151 | Protocol/persistence serialization |
| `thiserror` | 2.0.19 | 2.0.20 | Error definitions |
| `time` | 0.3.53 | 0.3.55 | Parsing/formatting/deserialization |
| `tokio` | 1.53.0 | 1.53.1 | Runtime and process/network lifecycle |
| `tokio-util` | 0.7.18 | 0.7.19 | Cancellation and I/O utilities |
| `toml` | 1.1.3 | 1.1.5 | Development/config parsing |
| `tower-http` | 0.7.0 | 0.7.1 | HTTP middleware |
| `uuid` | 1.24.0 | 1.26.0 | Persisted and protocol identifiers |

Broad requirements such as `time = "0.3"`, `serde = "1"`, and
`tracing = "0.1"` retain their existing granularity; compatible patch
selection belongs to `Cargo.lock`. Requirements that already encode an exact
minor floor, such as Tokio, Rusqlite, Tokio Util, and UUID, move their floor to
the selected target.

`time` is the first Rust cohort validated because 0.3.55 fixes date-iteration
underflow, timestamp deserialization overflow and out-of-bounds handling,
suppressed UTC-offset errors, and out-of-range panics.

### Tauri plugin cohort

Tauri core 2.11.5 and `tauri-build` 2.6.3 remain unchanged. The official
plugins move together:

| Package | Current resolution | Target |
| --- | --- | --- |
| `tauri-plugin-deep-link` | 2.4.9 | 2.4.10 |
| `tauri-plugin-dialog` | 2.7.2 | 2.7.3 |
| `tauri-plugin-opener` | 2.5.4 | 2.5.5 |
| `tauri-plugin-shell` | 2.3.5 | 2.3.6 |
| `tauri-plugin-single-instance` | 2.4.3 | 2.4.4 |
| `tauri-plugin-updater` | 2.10.1 | 2.11.0 |
| `tauri-plugin-wdio` | 1.2.0 exact | Retain 1.2.0; 1.3.0 blocked with the JS Service cohort |
| `tauri-plugin-wdio-webdriver` | 1.2.0 exact | Retain 1.2.0; 1.3.0 blocked with the JS Service cohort |

Updater validation covers signature verification, version selection, manifest
parsing, artifact discovery, and seeded native upgrade flows. Deep-link,
opener, shell, and single-instance validation covers malicious or malformed
input, second-launch races, cancellation, and OS-specific command behavior.

### Fixture lockfiles

The Task 8 and Task 9 harness manifests retain their existing compatibility
ranges and deliberate older-major dependencies, including Task 8 SHA2 0.10,
Sysinfo 0.37, Process Wrap 9, and the local PTY. Their independent lockfiles
are refreshed to the newest versions allowed by those unchanged requirements.
Each fixture suite runs directly through its own `--manifest-path` after the
refresh. This removes accidental patch drift without widening the behavior
the fixture was built to exercise.

### Compatible transitive refresh

The root Cargo lockfile accepts non-yanked compatible patches selected by
Cargo for unchanged direct ranges, including dependencies used by the local
`portable-pty` crate. `third_party/portable-pty/Cargo.toml`, its source, and
`UPSTREAM.md` remain unchanged because no new portable-pty release containing
the two required Windows fixes exists.

## Explicitly retained boundaries

| Boundary | Retained state | Reason and release condition |
| --- | --- | --- |
| Marketing TypeScript | 6.0.3 | TypeScript 7.0 lacks the programmatic API required by Astro's embedded-language checker. Move only after an official compatible checker exists and `astro check` passes without an alias/fork. |
| Process Wrap | 9.1.0 | Version 10 is a dedicated process-supervision migration covering admission, ownership, cancellation, shutdown, reaping, and Windows descendant containment. |
| Rust Base64 | 0.22.1 | 0.23 is a pre-1.0 breaking line and needs protocol/serialization review. |
| GTK/cairo | GTK 0.18 / cairo-rs 0.18 | Migrate with WebKit and Linux system-library support as one platform project. |
| Windows crates | production 0.61 family | 0.x FFI line changes require Tauri/WebView compatibility and native Windows validation. |
| WebView2 COM | 0.38 | 0.39 is a pre-1.0 Windows FFI migration. |
| portable-pty | local 0.9.0 fork | Required at-creation Job Object and termination-result fixes are not replaced by registry version equality. |
| Tao | Git revision `c704261c519c58cfdd0bc2d58ba24e06a0b71c92` | Retain until Tauri consumes an upstream equivalent to the Windows reentrant keyboard/IME fix. |
| minisign-verify | exact 0.2.5 | Updater-signature trust boundary is already current and exact. |

The active ledger marks these entries as retained/blocked with the exact
reason. `pnpm outdated` and Cargo registry queries are therefore interpreted
against this approved exception list rather than required to return an empty
set.

## Migration order inside the uncommitted worktree

### Cohort 0: baseline

Record the selected base SHA, clean tracked state, ambient versions, existing
dependency-ledger result, and focused package/toolchain gates. The untracked
research workbook remains outside the migration diff.

### Cohort 1: toolchain contract

Update Node, pnpm, Rust/Cargo, devcontainer setup, setup-vp action pins,
Rust-toolchain action pins, and the tests that assert those exact values.
Install with the new local Vite+ path as soon as Vite+ moves. Prove both a
normal install and a detached clean worktree frozen install before later
cohorts depend on the new toolchain.

### Cohort 2: Vite+ and test runtime

Update `vite-plus`, its aliased core, `@vitejs/plugin-react`,
`@vitest/coverage-v8`, `@oxlint/plugins`, and the Effect test patch as one
toolchain unit. Accept formatting changes only after reviewing them for
semantic edits. The package scripts continue using `scripts/run-local-vp.mjs`
so no global Vite+/Vitest instance enters tests.

### Cohort 3: stable React/web dependencies

Update React, types, router, editor, rendering, state, auth, font, test DOM,
Vercel config, and related direct packages. Compile first, adapt only APIs that
actually changed, then run focused behavioral and visual checks. Dependency
updates do not authorize unrelated UI redesign.

### Cohort 4: preview and patched JavaScript dependencies

Move Effect, Alchemy, and Pierre preview or patched packages. Evaluate the
Wdio/Tauri 1.3 cohort against published metadata and packaged teardown; retain
1.2/9.29 when the newer cohort fails that compatibility gate. Rebase or remove
patches by comparing installed upstream behavior, not by assuming a newer
version includes the local fix.

### Cohort 5: Rust and Tauri

Move compatible Rust dependencies, Tauri plugins, and fixture locks. Run
focused server/desktop/fixture tests before the complete Rust gate. No retained
breaking family is widened to make Cargo report fewer outdated entries.

### Cohort 6: CI, policy, and documentation

Refresh immutable action SHAs to the commits underlying the approved release
tags, preserving tag comments. Update contract tests, the active dependency
ledger, affected living runbooks, `docs/reference/scripts.md`,
`docs/operations/ci.md`, release documentation, and a new dated execution
report. Historical reports are not rewritten.

### Cohort 7: final validation and commit

Run every local gate, inspect the complete diff, prove no generated or
unrelated files are staged, and create the sole commit. Push that one-commit
branch through all required CI and native matrices. A repair changes the
worktree, reruns the affected cohort plus global gates, and uses
`git commit --amend`; it never adds a second commit.

## Failure handling and rollback

- Each cohort must pass its focused gate before the next cohort begins.
- A failed cohort is repaired or removed from the migration before work
  continues. Later cohorts never hide an earlier failure.
- Lockfile changes are accepted only with their owning manifest/catalog
  change or an explicitly documented compatible transitive refresh.
- A patch that no longer applies is not deleted automatically. Upstream source
  is compared with the old patch and consumer tests prove equivalent behavior.
- A platform-specific failure blocks the owning cohort even if the current
  development host passes.
- CI failures after the first commit are repaired with an amended commit and a
  force-push of the migration branch. The base branch is never rewritten.
- If an approved target proves incompatible, its current version is restored
  and added to the retained-boundary table and active ledger with evidence.
  The one-commit constraint does not justify shipping a failing target.

## Test and evidence contract

### Focused JavaScript evidence

- Toolchain contract, local Vite+ launcher, dependency-ledger, privacy, and CI
  workflow contract tests.
- React compiler/build, hydration, router generation/navigation, Zustand
  subscription/persistence, TanStack Pacer cancellation/disposal, Lexical
  composer/custom-node/paste/selection/history, Pierre diff/editor/worker,
  Clerk/Jose authentication, and relay Effect tests.
- Changed React components and hooks reviewed against
  `vercel-react-best-practices`; unavailable skill access is reported rather
  than silently omitted.
- User-visible behavior reviewed against `UI.md`, with packaged screenshots
  compared for unintended visual or interaction drift.

### Focused Rust evidence

- Time parsing/formatting, persistence backup/compatibility, RPC wire/parity,
  process supervision, updater verification, deep-link, opener, shell,
  single-instance, and desktop bridge tests.
- Task 8 and Task 9 fixture suites run from their isolated manifests.
- Rust format and warnings-denied Clippy run after cleaning all workspace
  packages so cached lint evidence cannot mask drift.

### Repository-wide evidence

The final local state passes:

```sh
vp install --frozen-lockfile
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
pnpm outdated --recursive --format json
cargo update --dry-run
```

`pnpm outdated` may return its documented non-zero status when approved
retained entries remain; its JSON must contain only the exception set in this
design. `cargo update --dry-run` must propose no compatible lockfile changes
under the final manifests and Rust 1.98.0.

### Native and release evidence

Before merge, CI proves:

- check, complete workspace test, and release-smoke jobs;
- desktop build and Rust tests on Linux, macOS, and Windows, x64 and ARM64;
- packaged desktop UI smoke on all six targets;
- seeded desktop updater flow on all six targets, including WSL x64;
- standalone server archives and Linux package installation tests; and
- release assembly completeness without publishing a stable release.

Every execution report distinguishes native, compatibility, and unavailable
evidence as required by the living testing runbooks.

## Documentation and policy

- Keep `docs/dependency-upgrades/2026-07-17-ledger.json` as the active
  machine-consumed ledger despite its historical filename. Refresh its audit
  date, targets, statuses, baseline, and validation foundation.
- Do not rewrite `docs/dependency-upgrades/2026-07-17-final-report.md`; it
  remains historical evidence.
- Add `docs/dependency-upgrades/2026-09-03-supported-convergence-report.md`
  containing final versions, exact commands, observed results, retained
  boundaries, and residual risk.
- Update living toolchain, CI, release, and testing documentation wherever the
  exact commands, versions, bundled-tool behavior, action releases, or native
  procedures change.
- Version counts, timings, machine paths, screenshots, and logs belong in the
  dated execution report, not the living runbooks.

## Single-commit contract

The implementation records its starting commit in the task-specific shell
variable `BIBCODE_MIGRATION_BASE`. Before the final commit, `git diff` and
`git status --short` must show only approved
migration files and the pre-existing untracked `outputs/` directory. The
research workbook is excluded from staging.

After committing, the migration branch must satisfy:

```sh
git rev-list --count "$BIBCODE_MIGRATION_BASE"..HEAD
```

with output exactly `1`. The sole commit message is:

```text
chore(deps): converge supported toolchains and dependencies
```

If CI repair is necessary, the repaired history must still contain exactly
that one commit above the recorded base.

## Acceptance criteria

1. Every upgrade target in this design is represented in manifests, catalogs,
   lockfiles, action pins, or bundled-tool evidence as applicable.
2. Every retained boundary remains unchanged and is recorded in the active
   ledger with its release condition.
3. Vite+ core/CLI, React/DOM, Lexical, Effect, Clerk, Drizzle, Tauri Wdio, and
   WebdriverIO families satisfy their alignment rules.
4. No stale patch key remains in `patchedDependencies`; every retained patch
   applies to the installed package and contains only required deviations.
5. Clean and frozen JavaScript installation succeeds with Node 26.8.1 and pnpm
   11.25.0.
6. Cargo's production workspace and both isolated fixtures resolve and test
   successfully with Rust/Cargo 1.98.0.
7. All focused, repository-wide, native, packaged UI, updater, server-package,
   and release-assembly gates pass or are explicitly reported unavailable.
8. Living runbooks and policy documentation match the final executable state.
9. The final diff excludes temporary artifacts, generated caches, debug output,
   unrelated cleanup, and the user-owned research workbook.
10. The branch contains exactly one migration commit above its selected base.

## Non-goals

- Migrating to pnpm 12.
- Replacing Astro or forcing the marketing app onto TypeScript 7 before the
  embedded-language toolchain supports it.
- Moving Effect from beta.107 to RC.112.
- Moving Drizzle beyond Alchemy beta.72's exact
  `1.0.0-rc.5-ab785fc` peer build without a newer official coordinated release.
- Taking Process Wrap 10, Base64 0.23, GTK/cairo, WebView2 COM 0.39, or the
  production Windows 0.62 family.
- Removing the local PTY or Tao patches without equivalent upstream behavior.
- Refactoring application architecture or redesigning UI while adapting
  dependency APIs.
- Publishing a release as part of dependency migration validation.
