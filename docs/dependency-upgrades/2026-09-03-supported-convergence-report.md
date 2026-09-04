# Supported Dependency and Toolchain Convergence Report

This report records the target set frozen on 2026-09-03. Execution, the final
read-only registry requery, and the final-review fix wave continued on
2026-09-04. Manifests, lockfiles, workflow contracts, and the active ledger are
executable evidence; earlier dated reports are used only for the individual
task results they observed.

## Result

The approved supported-convergence target set is implemented without a commit.
The active ledger contains 221 rows: 112 completed migrations are `green`, 63
already-current rows are `current`, 42 retained boundaries are `blocked` with
release conditions, and 4 removed declarations remain `removed`. No row is
`pending`, and the validator reports zero unaccounted declarations.

The final-review fix wave makes reference-repository application
interruption-safe, corrects five ledger targets to audited exact releases while
retaining their declaration-range `current` values, raises the touched file
preview notice from 11px to the `text-xs` minimum, and records the executed
Task 8 and Task 13 design amendments. These repairs remain unstaged over the
controller-packaged index; the real index is preserved separately from the
privately computed final candidate tree.

The migration base and current `HEAD` are both
`610a65be4ae5269c9a3848c898725a29035b4341`; the commit count above that base is
zero. Review packaging advanced the index without creating a commit:

- Task 12 started from the Tasks 1-11 tree
  `1389f415b20e587370771937503c0a3ad58f6351`;
- the initial Task 12 package produced
  `7682b85d26a829eac748354bff6b41117c817a65`;
- fix round 1 was packaged as
  `e018f07520601d71957170472321e3a1a4f0e491`; and
- fix round 2 was packaged for review as
  `ac69da845ba12ded99e7dedc31f75b3c2aca46f2`; and
- the complete Tasks 1-12 review candidate was packaged as
  `fb8e4d58647116af1ff444a54c4634f8fd9a61e0` before the Task 13 repairs.

These are review checkpoints, not the sole migration commit. The final commit
SHA and tree are recorded by Git after final validation; embedding the final
tree in this tracked report would make that tree self-referential.

The final local repository gates, a detached frozen install audit, native Rust
validation, the retained Wdio 1.2/9.29 packaged seven-spec suite, and both
seeded macOS arm64 upgrade paths pass. The remaining matrix targets are
explicitly unavailable: no branch was pushed and no remote workflow was
dispatched because that authorization was not provided.

## Final Toolchains

| Tool               | Final declaration                                  | Evidence                                                    |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------- |
| Node.js            | `26.8.1`                                           | root engine, devcontainer, toolchain contract               |
| pnpm               | `11.25.0`                                          | root package-manager declaration and devcontainer bootstrap |
| Rust / Cargo       | `1.98.0`                                           | `rust-toolchain.toml`, workspace MSRV, workflow actions     |
| Vite+ / core alias | `0.3.0` / `npm:@voidzero-dev/vite-plus-core@0.3.0` | workspace catalog and lock                                  |
| Vitest             | one `4.1.11` runtime supplied by Vite+             | lock and `pnpm why` evidence from Task 8                    |
| TypeScript         | `7.0.2` workspace; `6.0.3` marketing island        | catalog, marketing manifest, typecheck                      |
| React / React DOM  | `19.2.8` / `19.2.8`                                | web manifest and lock                                       |
| Effect v4          | `4.0.0-beta.107`                                   | catalog, overrides, lock, exact reference snapshot          |

The 2026-09-04 registry query still reports Vite+ and its core alias at 0.3.0,
TypeScript at 7.0.2, and React/React DOM at 19.2.8. Effect's `beta` tag remains
beta.107 and its separately excluded `rc` tag remains RC.112; the lock contains
zero Effect RC.112 packages.

## Upgraded Cohorts

- The stable JavaScript tooling, UI, editor, router, Clerk/Jose/Noble, and
  marketing cohorts are at their approved frozen targets. A read-only
  `pnpm outdated` requery additionally reported `@oxlint/plugins` 1.81.0, but
  the frozen migration target remains exact 1.79.0 and was not silently moved.
- The active ledger now records exact audited targets `5.3.0` for both font
  packages, `19.2.6` for `@types/react-dom`, `20.13.2` for `happy-dom`, and
  `5.0.15` for `zustand`. Their `current` values intentionally retain the
  manifest declaration ranges, and all five migrated rows remain `green` in
  their owning React UI or stable JavaScript tooling cohorts.
- Pierre Diffs is stable 1.3.6. BiBCode uses the stable `@pierre/diffs/edit`
  API, and the maintained packaged scenario covers diff, staging, editing, and
  retained undo behavior in the Task 7 package.
- Effect core and every selected v4 companion are beta.107. Alchemy is
  beta.72, the latest preview compatible with that Effect line, and
  `drizzle-orm` plus `drizzle-kit` are both exact
  `1.0.0-rc.5-ab785fc`. Alchemy beta.76 is newer but requires the excluded
  Effect RC.112 line. The 2026-09-04 Drizzle query confirms both selected exact
  builds still exist; Alchemy's peer tuple, rather than an independently moving
  Drizzle tag, owns this selection. The RPC fixture manifest's Effect-labelled
  field is generator provenance, not a wire-protocol epoch; it now reports
  beta.107 and TypeScript/Rust parity remains green.
- The direct Rust floors and matched Tauri plugin cohort are updated under Rust
  1.98.0. Root workspace check, formatting, warnings-denied Clippy, focused
  server tests, desktop tests, and updater-verifier tests passed in Task 10.
- Workflow setup uses immutable SHA pins with audited tag comments: Checkout
  7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`), Rust Cache 2.9.2
  (`6323deb102c322ba6fcbdcafc7e3dddab59af2b6`), setup-vp 1.18.0
  (`1b32467adbe183473499fd9d5d372c3ed9641754`), action-gh-release 3.0.3
  (`efb35369e0ad2afab669f228072c1b0d510eae64`), and Rust toolchain
  1.98.0 (`62ae3a85dbdd2bedbb5819da8ce45635129289a1`). The last value is the
  user-approved live SHA; the stale planned SHA was not restored.

## Retained Boundaries

The WebdriverIO/Tauri automation cohort remains blocked at these installed and
researched values:

| Dependency                         | Current  | Blocked target |
| ---------------------------------- | -------- | -------------- |
| `@wdio/cli`                        | `9.29.1` | `9.31.5`       |
| `@wdio/globals`                    | `9.29.1` | `9.31.3`       |
| `@wdio/local-runner`               | `9.29.1` | `9.31.5`       |
| `@wdio/mocha-framework`            | `9.29.1` | `9.31.5`       |
| `@wdio/native-utils`               | `2.5.0`  | `2.6.0`        |
| `@wdio/spec-reporter`              | `9.29.1` | `9.31.2`       |
| `@wdio/tauri-service`              | `1.2.0`  | `1.3.0`        |
| `webdriverio`                      | `9.29.1` | `9.31.5`       |
| `@wdio/tauri-plugin`               | `1.2.0`  | `1.3.0`        |
| Rust `tauri-plugin-wdio`           | `=1.2.0` | `1.3.0`        |
| Rust `tauri-plugin-wdio-webdriver` | `=1.2.0` | `1.3.0`        |

Every row requires both upstream conditions: a Service release must fix
`afterSession` teardown ordering, and it must align
`@wdio/globals/expect-webdriverio` with the selected direct WebdriverIO cohort.
The rejected 1.3 experiment passed behavior with a short socket root but emitted
the disqualifying cleanup warning; 9.31 also created the unsupported expect
5-versus-6 peer boundary.

Other explicit retained boundaries are:

| Boundary        | Current / target                                              | Release condition                                                                                                                             |
| --------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript      | workspace `7.0.2`; marketing `6.0.3` / target `7.0.2`         | official Astro checker support for TypeScript 7, with `astro check` green without alias or fork                                               |
| Process Wrap    | `9.1.0` / `9.1.0`                                             | version 10 requires a dedicated admission, ownership, cancellation, shutdown, reaping, and Windows containment migration                      |
| Base64          | `0.22.1` / `0.22.1`                                           | the 0.23 pre-1.0 line requires protocol and serialization review                                                                              |
| Linux GTK stack | Cairo `0.18`, GTK `0.18`, WebKit2GTK `2.0`                    | migrate together with Linux system-library support                                                                                            |
| Windows FFI     | `windows` `0.61`, `windows-sys` `0.61.2`, WebView2 COM `0.38` | migrate with Tauri/WebView compatibility and native Windows validation                                                                        |
| local PTY       | local `portable-pty` `0.9.0`                                  | preserve the at-creation Job Object and termination-result fixes; refresh its manifest-owned dependencies only through its upstream procedure |
| Minisign        | exact `0.2.5`                                                 | updater-signature trust boundary is already current and exact                                                                                 |
| Tao             | Git revision `c704261c519c58cfdd0bc2d58ba24e06a0b71c92`       | Tauri must consume an upstream equivalent of the Windows reentrant keyboard/IME fix                                                           |

## Patch Reconciliation

Only two package patches remain:

| Patch                           | SHA-256                                                            | Reason                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@effect/vitest@4.0.0-beta.107` | `7e0f6fdea2c983d50482bb931a0f4c0aa0feb43d72f40a22d5ba7c7b2064f66b` | route public and internal test imports through the single `vite-plus/test` runtime while preserving beta.107's `V.TestRunner.getCurrentSuite` implementation |
| `@wdio/tauri-plugin@1.2.0`      | `2547396d2661c317237f202ae58f2bef480d23831ea594bbdbf7608518160fe1` | retain the narrow generic `invoke` and `listen` typing repair for the supported 1.2 cohort                                                                   |

The Pierre beta patch and the Effect beta.99 patch were removed. No Wdio 1.3,
Alchemy, Drizzle, Service-runtime, or compatibility-alias patch was added.

## Local Validation

Fresh Task 12 validation:

| Command                                                                                                                                              | Exit | Result / evidence class                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm outdated --recursive --format json`                                                                                                            |    1 | JSON reported `@oxlint/plugins` 1.79.0/1.81.0, Wdio 9.29.1/9.31.x, native-utils 2.5.0/2.6.0, Service/Plugin 1.2.0/1.3.0, marketing TypeScript 6.0.3/7.0.2, and Alchemy beta.72/beta.76 as current/latest; every `wanted` value remains frozen or retained current            |
| `pnpm view vite-plus version`                                                                                                                        |    0 | `0.3.0`                                                                                                                                                                                                                                                                      |
| `pnpm view @voidzero-dev/vite-plus-core version`                                                                                                     |    0 | `0.3.0`                                                                                                                                                                                                                                                                      |
| `pnpm view typescript version`                                                                                                                       |    0 | `7.0.2`                                                                                                                                                                                                                                                                      |
| `pnpm view react version`                                                                                                                            |    0 | `19.2.8`                                                                                                                                                                                                                                                                     |
| `pnpm view react-dom version`                                                                                                                        |    0 | `19.2.8`                                                                                                                                                                                                                                                                     |
| `pnpm view effect dist-tags --json`                                                                                                                  |    0 | `latest=3.22.1`, `beta=4.0.0-beta.107`, `rc=4.0.0-rc.112`, `snapshot=0.0.0-snapshot-6ebc752baf28354006ca2a0ae783a5bccf5de9ad`                                                                                                                                                |
| `pnpm view drizzle-orm dist-tags --json`                                                                                                             |    0 | `latest=0.45.2`, `beta=1.0.0-beta.22`, `rc=1.0.0-rc.4`, `rc5=1.0.0-rc.5-169397b`; the Alchemy-owned exact peer build is queried below                                                                                                                                        |
| `pnpm view drizzle-kit dist-tags --json`                                                                                                             |    0 | `latest=0.31.10`, `beta=1.0.0-beta.22`, `rc=1.0.0-rc.4`, `rc5=1.0.0-rc.5-ab785fc`                                                                                                                                                                                            |
| `pnpm view drizzle-orm@1.0.0-rc.5-ab785fc version`                                                                                                   |    0 | `1.0.0-rc.5-ab785fc`                                                                                                                                                                                                                                                         |
| `pnpm view drizzle-kit@1.0.0-rc.5-ab785fc version`                                                                                                   |    0 | `1.0.0-rc.5-ab785fc`                                                                                                                                                                                                                                                         |
| `pnpm view @oxlint/plugins@1.81.0 time --json`                                                                                                       |    0 | `1.81.0` published `2026-09-01T15:20:15.129Z`; observed but outside the approved frozen target                                                                                                                                                                               |
| `pnpm view alchemy@2.0.0-beta.76 time --json`                                                                                                        |    0 | beta.76 published `2026-08-31T19:39:42.488Z`; rejected because its Effect peer line is incompatible                                                                                                                                                                          |
| `cargo update --dry-run`                                                                                                                             |    0 | read-only registry evidence; proposed only `cc` 1.4.5, `find-msvc-tools` 0.1.12, and `tokio-rustls` 0.26.5, all published 2026-09-04 after the frozen set; `Cargo.lock` remained SHA-256 `80070f9d5d613f30b34b92c93a1e61c8badde7d8597316165e1464d2c2d0a59f` before and after |
| `cargo tree --workspace --duplicates`                                                                                                                |    0 | local compatibility evidence; intentional ecosystem family splits remain                                                                                                                                                                                                     |
| focused ledger RED                                                                                                                                   |    1 | expected failure against 69 stale `current` values before closure                                                                                                                                                                                                            |
| focused ledger GREEN                                                                                                                                 |    0 | 1 selected test passed after closure                                                                                                                                                                                                                                         |
| inventory/RPC provenance RED command                                                                                                                 |    1 | 6 expected failures and 15 passes before implementation: standalone duplicates, path patches, command metadata, active closure, and Effect provenance                                                                                                                        |
| inventory/RPC implementation checkpoint                                                                                                              |    1 | 20 tests passed; only active-ledger reconciliation remained red                                                                                                                                                                                                              |
| fix-round 2 target/status/collision RED                                                                                                              |    1 | 5 expected failures and 15 passes before implementation                                                                                                                                                                                                                      |
| fix-round 2 implementation checkpoint                                                                                                                |    1 | 19 tests passed; only active-ledger platform/status reconciliation remained red                                                                                                                                                                                              |
| fix-round 3 malformed-platform RED                                                                                                                   |    1 | 1 expected failure and 20 skipped; validator threw while comparing a non-array platform object                                                                                                                                                                               |
| fix-round 3 malformed-platform GREEN                                                                                                                 |    0 | 1 selected test passed and 20 skipped; malformed shape returned a bounded validation error without throwing                                                                                                                                                                  |
| `node scripts/run-local-vp.mjs test run scripts/check-dependency-upgrade-ledger.test.ts`                                                             |    0 | 21/21 focused ledger tests passed                                                                                                                                                                                                                                            |
| combined ledger/exporter focused suite                                                                                                               |    0 | 25/25 tests passed                                                                                                                                                                                                                                                           |
| `vp run check:dependency-ledger`                                                                                                                     |    0 | 81 direct JavaScript dependencies, 112 registry Rust crates, 3 path Rust declarations, 1 Git Rust revision, 9 Actions, 9 toolchain pins, and zero unaccounted entries                                                                                                        |
| `vp run --filter @bibcode/contracts typecheck`                                                                                                       |    0 | contracts typecheck passed with one non-fatal Effect suggestion                                                                                                                                                                                                              |
| `node scripts/run-local-vp.mjs test run packages/contracts/src/rpcRustParity.test.ts packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`    |    0 | 9 TypeScript exporter/parity tests passed                                                                                                                                                                                                                                    |
| `cargo test -p bibcode-server --test rpc_wire`                                                                                                       |    0 | 13 Rust RPC wire/parity tests passed                                                                                                                                                                                                                                         |
| `node scripts/run-local-vp.mjs test run scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts scripts/workflow-dependencies.test.ts` |    0 | 45 workflow and release contract tests passed                                                                                                                                                                                                                                |
| `vp check`                                                                                                                                           |    0 | 2,207 files formatted; 0 errors and the existing 442 non-fatal warnings in 1,556 linted files                                                                                                                                                                                |
| first fix-round 2 `vp run typecheck`                                                                                                                 |    1 | four `exactOptionalPropertyTypes` errors exposed explicit `undefined` platform fields                                                                                                                                                                                        |
| final `vp run typecheck`                                                                                                                             |    0 | all 11 workspace packages passed after making optional authoritative-platform fields explicitly admit unavailable context; non-fatal Effect suggestions remain                                                                                                               |
| `git diff HEAD --check -- . ':(exclude).repos/**'`                                                                                                   |    0 | all repository-owned staged and unstaged changes pass                                                                                                                                                                                                                        |

The first unauthenticated crates.io API requests returned HTTP 403 (`curl`
exit 56). Repeating each exact version query with the identifying user agent
`BiBCode dependency audit` exited 0 and returned publish timestamps
`2026-09-04T09:28:57.146598Z` for `cc@1.4.5`,
`2026-09-04T09:28:52.840002Z` for `find-msvc-tools@0.1.12`, and
`2026-09-04T08:52:06.163215Z` for `tokio-rustls@0.26.5`.

Task 10 observed the root Rust gates green under the final Rust dependency
cohort. The isolated Task 8 harness remains the accepted E0432/E0433 compile
failure with 9/11 summary counts, and the isolated Task 9 harness remains the
accepted E0432/E0433/E0308/E0599 compile failure with 12/35 summary counts.
Their normalized failure signatures are unchanged from baseline; they are not
represented as passing tests.

Task 13 repaired the executable `xn--a.clerk.accounts.dev` baseline-report
inconsistency at the shared Clerk publishable-key trust boundary. The existing
case was the RED test. A second valid ACE spelling proved that browser/Node URL
canonicalization cannot distinguish the malformed case safely. The smallest
cross-runtime fail-closed policy therefore rejects every DNS label beginning
`xn--` before URL construction. The focused suite passes 11/11 cases and the
43-file Clerk/relay trust selection passes 421/421 tests. No rejected host or
publishable-key material is added to error messages. The compatibility cost is
intentional and documented: IDN custom Clerk Frontend API domains remain
unsupported until BiBCode owns one deterministic browser/WebView/server IDNA
validator.

### Final Task 13 local verification

| Command                                                       | Exit | Observed result                                                                                                                                                |
| ------------------------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| focused shared Clerk relay-auth suite                         |    0 | 11/11 tests passed after the pre-fix malformed/valid-ACE RED                                                                                                   |
| 43-file Clerk/relay trust selection                           |    0 | 421/421 tests passed                                                                                                                                           |
| Rust auth, crypto, and remote-pairing selection               |    0 | 38/38 tests passed; one non-fatal transient database-busy diagnostic occurred in the concurrency coverage                                                      |
| `vp run check:dependency-ledger`                              |    0 | 81 direct JavaScript names, 112 registry Rust declarations, 3 path declarations, 1 Git revision, 9 Actions, 9 toolchains, and 0 unaccounted entries            |
| `vp check`                                                    |    0 | 2,207 files formatted, 0 errors, and 442 non-fatal warnings in 1,556 files                                                                                     |
| `vp run typecheck`                                            |    0 | all 11 workspace projects passed                                                                                                                               |
| `vp test`                                                     |    0 | 680 files passed, 3 skipped; 9,091 tests passed, 33 skipped                                                                                                    |
| `vp run test`                                                 |    0 | the complete package-script graph passed                                                                                                                       |
| `vp run build`                                                |    0 | all four build tasks passed                                                                                                                                    |
| `vp run release:smoke`                                        |    0 | release smoke passed; the disclosed optional-peer warning remains non-fatal                                                                                    |
| `cargo fmt --all --check`                                     |    0 | final Rust sources are formatted                                                                                                                               |
| clean `cargo clippy --workspace --all-targets -- -D warnings` |    0 | all workspace/all-target code passed with warnings denied                                                                                                      |
| `cargo test --workspace --all-targets -j 2`                   |    0 | workspace/all-target tests passed, including 343 desktop tests, 1,928 server-library tests with 2 ignored, and all integration/updater targets                 |
| Task 8 isolated Cargo harness                                 |  101 | accepted signature-equivalent E0432/E0433 failure; normalized 9/11 summary is unchanged                                                                        |
| Task 9 isolated Cargo harness                                 |  101 | accepted signature-equivalent E0432/E0433/E0308/E0599 failure; normalized 12/35 summary is unchanged                                                           |
| `cargo update --dry-run`                                      |    0 | proposed only `cc` 1.4.5, `find-msvc-tools` 0.1.12, and `tokio-rustls` 0.26.5, all published after the frozen 2026-09-03 set; the lock remained byte-identical |
| `pnpm outdated --recursive --format json`                     |    1 | reports retained holds and post-freeze releases separately; the lock remained byte-identical and no result was adopted                                         |

Task 13 also repaired four verification-harness reliability defects exposed by
the complete candidate rather than changing product policy: repository-identity
tests now exclude the read-only `.repos` payload at their Git query source;
reference-sync default-root coverage is independent of the package runner's
working directory; desktop port-probe coverage retains its non-listening probe
socket and uses production-equivalent reuse semantics; and the two 5,000-event
activity-load tests have a 25-second watchdog around their unchanged explicit
20-second performance contract. Focused RED/GREEN evidence exists for each.

### Final-review fix validation

The reference-sync regression was first observed RED: four selected tests
failed because interruption and defects bypassed rollback and because failed
rollback released the common-directory lock. After the transaction fix, the
same four tests passed. The strict interruption case runs the real mutating
`read-tree`, adds ignored residue, interrupts before completion, and proves the
original tree plus clean ordinary/managed-ignored state before the original
interruption is observed and the lock disappears. The defect case proves the
same recovery before re-propagating the original defect. Typed rollback and
literal-path behavior remain covered.

A subsequent scoped-lifecycle re-review found one exception: the apply and
rollback child resources still belonged to the outer sync scope. Capturing an
interrupted apply as an `Exit` could therefore begin rollback before the apply
child's scope finalizer killed and reaped it, and a completed timed rollback
step could enter cleanup before its own child finalizer. The new lifecycle RED
observed exactly
`rollback-restore-entered, rollback-cleanup-entered` where the required order
was `apply-finalizer-started, rollback-finalizer-started`. Apply now runs in its
own nested scope inside the restored interruptible region, and every timed
rollback command runs in a separate nested scope. The lifecycle GREEN proves
both finalizers complete before the following phase while preserving the
original interruption and verified rollback state.

| Command / review                                     |        Exit | Observed result                                                                                               |
| ---------------------------------------------------- | ----------: | ------------------------------------------------------------------------------------------------------------- |
| focused interruption/defect/rollback/lock RED        |           1 | 4 expected failures: no interruption/defect recovery and premature lock release                               |
| focused interruption/defect/rollback/lock GREEN      |           0 | 4/4 selected tests passed                                                                                     |
| scoped apply/rollback lifecycle RED                  |           1 | rollback restore/cleanup entered before their preceding command finalizers                                    |
| scoped apply/rollback lifecycle GREEN                |           0 | 1/1 lifecycle test passed                                                                                     |
| final focused lifecycle selection                    |           0 | 5/5 selected tests passed                                                                                     |
| full reference sync plus catalog suite               |           0 | 45/45 tests passed                                                                                            |
| `vp run --filter @bibcode/scripts typecheck`         |           0 | scripts TypeScript passed                                                                                     |
| focused ledger target/status RED                     |           1 | exact target assertion rejected range-valued target                                                           |
| focused ledger GREEN                                 |           0 | 21/21 tests passed                                                                                            |
| `vp run check:dependency-ledger`                     |           0 | zero pending and zero unaccounted declarations                                                                |
| FilePreviewPanel/editor/Pierre selection             |           0 | 10 files and 200 tests passed                                                                                 |
| `vp run --filter @bibcode/web typecheck`             |           0 | web TypeScript passed with existing non-fatal Effect suggestions                                              |
| `vp run --filter @bibcode/web build`                 |           0 | 4,715 modules transformed and production bundle built                                                         |
| detached private-tree `vp install --frozen-lockfile` |           0 | 1,242 packages materialized with pnpm 11.25.0; five manifest/lock hashes were byte-identical before and after |
| final `vp check`                                     |           0 | all 2,207 files formatted; 0 errors and 442 established non-fatal warnings in 1,556 files                     |
| final `vp run typecheck`                             |           0 | all 11 workspace package checks passed                                                                        |
| pre-lifecycle-review `vp test`                       |           0 | 680 files passed, 3 skipped; 9,093 tests passed, 33 skipped                                                   |
| pre-lifecycle-review `vp run test`                   |           0 | all 9 package-script tasks passed; desktop 343/343 and server library 1,928 passed with 2 ignored             |
| pre-lifecycle-review `vp run build`                  |           0 | all 4 application/package build tasks passed                                                                  |
| `UI.md` review                                       |           0 | touched 11px notice now uses the required `text-xs`; no copy, control, or interaction behavior changed        |
| `vercel-react-best-practices` review                 | unavailable | skill was not available to this agent and was not silently claimed                                            |

## Native and Packaged Validation

| Target/evidence                                              | Classification             | Result                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 26.6.2 arm64 root Rust gates                           | native final candidate     | formatting, clean warnings-denied Clippy, and workspace/all-target tests passed                                                                                                                                                       |
| macOS arm64 retained Wdio 1.2/9.29 package                   | native final-fix candidate | rebuilt ad-hoc-signed `0.5.1` arm64 DMG passed all 7 maintained packaged scenarios in 44.8 seconds under short launcher-owned root `/tmp/ffr.TWMaAh`; 23 screenshots and the full logs/state were inspected, with no teardown warning |
| macOS arm64 seeded updater                                   | native final candidate     | both previous-stable `v0.5.4` and protected migration-base `0.5.4` state upgraded to candidate `0.5.5-upgrade.task13.1`; project retention, storage-identity retention, and pre-update backup were all observed                       |
| macOS x64 final state                                        | unavailable                | not executed locally and no remote workflow was dispatched                                                                                                                                                                            |
| Linux arm64/x64 final state                                  | unavailable                | not executed locally and no remote workflow was dispatched                                                                                                                                                                            |
| Windows arm64/x64 final state                                | unavailable                | not executed locally and no remote workflow was dispatched                                                                                                                                                                            |
| WSL x64, packaged server distributions, and release assembly | unavailable                | no branch push or remote workflow dispatch was authorized                                                                                                                                                                             |

The final-fix packaged artifact supersedes the earlier Task 13 package. It was
`BiBCode_0.5.1_aarch64.dmg`, 17,190,281 bytes, SHA-256
`d9371d252738756b567ee09b6f786fdca45296c47f8bc31325744fe31e013309`.
Its app bundle identifier was `com.bibcode.desktop.e2e`; the executable was an
arm64 Mach-O; deep/strict code-signature verification passed with an ad-hoc
signature; no Team identifier or notarization was present. The run used a
short task-owned root and supplied no caller override for `HOME`, `home`, or
`CODEX_HOME`. Evidence remains at `/tmp/ffa.cJeNhq`. The full and Pierre-only
screenshot contact sheets were visually inspected; the maintained narrow
Pierre fixture wraps heavily but remains visible without clipping. Four native
trace spans all ended `Success`; provider and terminal logs contain expected
fixture events. WebDriver/Wdio logs contain no `WARN`, `ERROR`, teardown,
`afterSession`, missing-session, mock-store, panic, timeout, or retry diagnostic.
The launcher removed its run root. Its task-owned Cursor opener ignored TERM
for ten seconds, so the exact verified five-process group was killed; afterward
no task process remained. `/dev/disk8s1` was detached, its mount directory was
removed, TCP 4445 was free, and the two user-owned `/Volumes/BiBCode*` mounts
were untouched.

The seeded-upgrade candidate DMG was 17,189,631 bytes; its updater archive was
17,537,903 bytes with a 404-byte signature. The previous-stable and
protected-baseline verifier phases each passed 1/1 after the expected
application restart disconnect, and the updater server observed one readiness
request, three manifest requests, and two payload requests. Ephemeral signing
keys and the 7.6-GiB upgrade work root were removed after exact process, port,
mount, and worktree checks.

The seeded updater was not rerun after the final-fix package rebuild. The only
shipped behavior changed by this wave is FilePreviewPanel typography from 11px
to the existing 12px token; updater and runtime lifecycle behavior did not
change. The prior Task 13 updater result therefore remains historical evidence,
not a newly executed final-fix result.

The following testing procedures were compared with current scripts, source,
CI, and release workflows and did not need a text change:

- `docs/testing/cross-platform-validation.md` — **reviewed and remains
  accurate**.
- `docs/testing/windows-desktop.md` — **reviewed and remains accurate**.
- `docs/testing/linux-desktop.md` — **reviewed and remains accurate**.
- `docs/testing/macos-desktop.md` — **reviewed and remains accurate**.

The release procedure was corrected to name all six seeded-upgrade matrix
targets. The repository scripts reference and root agent guidance now also
record interruption-safe reference-sync recovery and deliberate lock retention
after unverified rollback. They and the CI page remain aligned with the
converged toolchains, one-local-Vite+ rule, and audited immutable action pins.
The dated moved-tag observation remains in this report rather than the
living CI guide. `UI.md` was reviewed for the fail-closed Clerk-host policy,
the FilePreviewPanel typography repair, and the packaged/updater evidence. The
touched preview notice now uses the mandated `text-xs` minimum; the wave
preserves safe defaults and existing invalid-configuration behavior and adds no
new screen, copy, control, or interaction flow. The required
`vercel-react-best-practices` skill was not available to this agent, so the
React component/hook review was **not run**.

## Reproducibility

The official reference synchronization command is history-independent:
`vp run sync:repos` (or `vp run sync:repos --repo <id>`). It requires a clean
index and working tree, treats configured prefixes and prune paths as literal
Git paths, constructs exact fetched trees, stages only the selected snapshot,
and creates no commit. A mode-0600
`bibcode-reference-repos-sync.lock` in the absolute Git common directory holds
one writer across linked worktrees from the first clean check through apply or
verified rollback. A stale lock may be removed only after process inspection
proves no synchronization process owns that repository.

The final-review repair treats the second clean gate and apply as one masked
transaction boundary. Once apply may start, its full `Exit` captures typed
failure, defect, or caller interruption; every non-success runs bounded
rollback while caller interruption remains deferred. Only exact restoration of
the original index tree plus clean ordinary and managed-ignored status makes
the lock releasable and allows the original defect/interruption or typed
rolled-back result to propagate. A timeout, rollback command failure, or failed
verification leaves the common-directory lock in place for explicit manual
recovery instead of exposing a partially recovered repository to another
writer.

The mutating apply's nested process scope closes before its captured failure is
available to rollback. Each timed rollback command also has its own nested
scope, so its process is killed/reaped on interruption or timeout and its
finalizers finish before recovery advances or returns.

Rust inventory keys preserve source ownership. Root dependency intent is
`rust:workspace:<name>`; explicit standalone declarations are
`rust:<manifest-directory>:<name>` even when the name also exists at the root;
true `workspace = true` consumers do not create duplicate rows. Crates.io
overrides use `rust:patch:<name>`. Consequently the root
`rust:workspace:portable-pty` version declaration and
`rust:patch:portable-pty=path:third_party/portable-pty` effective local source
are both explicit, while the Task 8 fixture's separate relative path remains a
third manifest-owned path declaration.

Known Cargo target context is authoritative inventory evidence. Unconditional
tables map to all three supported operating systems, Windows/Linux/macOS
selectors map to that host, and `cfg(unix)` maps to Linux plus macOS. Repeated
manifest/name declarations union their contexts; unknown selectors remain
non-authoritative. Inventory construction rejects duplicate stable keys rather
than silently certifying a reserved-scope collision.

Status is likewise state-based: `current` means the audited lock/declaration
target was already selected, `green` means the migration moved a declaration or
compatible lock resolution to its target, and `blocked` requires an independent
retained dependency release condition. The accepted Task 8/9 harness compiler
signatures remain validation risk and do not classify their unrelated
dependencies as blocked. Only the Task 8 local portable-pty path remains blocked
with the root path patch and local subtree under `UPSTREAM.md`.

Task 13 serialized the complete candidate relative to `HEAD` as a binary patch
and materialized it from the migration base in a detached disposable worktree.
Because the candidate contains an intentional case-only vendored rename on the
default case-insensitive APFS volume, the audit applied the patch to a private
temporary index and then materialized that exact index. `corepack prepare
pnpm@11.25.0 --activate`, `pnpm install --frozen-lockfile`, and `cargo fetch
--locked` all passed. `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
`Cargo.toml`, and `Cargo.lock` were byte-identical before and after the install
and fetch. The disposable worktree was removed; its outside-repository patch
and comparison evidence remain available for Task 13 review.

The final-review wave repeated this audit with the exact specification command
`vp install --frozen-lockfile`, not a direct pnpm substitute. It built the
candidate through `/tmp/ffi.URNaMQ/private.index`, materialized that tree into a
detached disposable worktree, and left the real migration index unchanged.
Vite+ installed 1,242 packages with pnpm 11.25.0 and exited 0. The before/after
SHA-256 lists are byte-identical (list hash
`1740628b0555e7bce3f9339754fe2c189b30e746ee45a6947428aada3646b037`):

- `package.json`:
  `4707d05241934c8d101e5aaaf2b265819487871f37ad68a4b9c547ae4c0cfca8`;
- `pnpm-workspace.yaml`:
  `33959eb49f6ecb6a7bc541f0838e395ddf4d7ed8cad04121645c900c34b01c88`;
- `pnpm-lock.yaml`:
  `ebbfd9a7188c970e93570e9c47112cb5cf665ab8061d72c29a44765eb990d2f4`;
- `Cargo.toml`:
  `2f862956f29b4e0634ce7fe136dd3d0a23547d9b681e2c2129187d2e13fef55d`;
  and
- `Cargo.lock`:
  `80070f9d5d613f30b34b92c93a1e61c8badde7d8597316165e1464d2c2d0a59f`.

The disposable worktree and registration were removed. The evidence root
`/tmp/ffi.URNaMQ` retains the private index, binary patch, and comparison lists;
the real index remained
`3044e46453b00fe528bb589ff752a05f796d25fa` before and after.

No sync was run from this intentionally staged migration worktree. Direct index
verification proves the exact synchronized snapshots:

- Effect tree: `5e77033d116402945c4115c8c3c6b8fce8ec81e8`;
- configured-prune Alchemy tree:
  `61ba96e20b8d9c45f967e3ebdc8f406696aae4eb`;
- zero unstaged or ordinary untracked vendor paths; and
- zero nested generated snapshot edits.

`git diff HEAD --check -- .repos` exits 2 with exactly 49 upstream diagnostics
across the eight known vendored files: 25 trailing-whitespace and 24
space-before-tab findings. They are snapshot-fidelity evidence and were not
edited. Repository-owned whitespace validation excludes `.repos` and passes.

The historical `docs/dependency-upgrades/2026-07-17-final-report.md` remains
byte-identical at SHA-256
`af12480806466ccc7417ce31d45e7a4d177afd75ed672ec9ab8d907504611d59`.

## Residual Risk

- The Punycode authentication discrepancy is repaired fail-closed. The
  deliberate compatibility cost is that valid IDN/Punycode custom Clerk
  Frontend API domains are rejected until BiBCode has a deterministic
  cross-runtime IDNA validator.
- Vite+ 0.3 exposes 442 non-fatal Oxlint/React diagnostics across 96 files;
  they remain application debt rather than migration suppressions.
- `pnpm peers check` exits 1 only for the disclosed Pierre theme 2.0 versus
  `@pierre/theming@1.0.0` optional `^1.1.0` peer and `capnp-es@0.0.14`'s
  TypeScript `^5.7.3` peer versus workspace TypeScript 7.0.2.
- Final-state macOS arm64 repository, packaged UI, and seeded-upgrade evidence
  includes the rebuilt final-fix packaged UI. The seeded-upgrade result predates
  the typography-only final fix and was deliberately not rerun. macOS x64,
  Linux arm64/x64, Windows arm64/x64, WSL x64, packaged server distributions,
  CI, and release assembly remain unavailable because no push or remote
  workflow authorization was provided; they are not passed.
- Lexical 0.50 automated composer and packaged native-trigger coverage is
  green, but the requested manual native typing, IME composition, multiline
  paste, mention/skill token, undo/redo, and submission interaction pass remains
  unexecuted.
- The final-fix DMG is ad-hoc signed and unnotarized. Release signing and
  notarization remain remote release responsibilities.
- `origin/main` is currently
  `55cbf4acf48cc0f47548cb52a66cfe1c0793ddcf`, ten commits ahead of the migration
  base with merge-base `610a65be4ae5269c9a3848c898725a29035b4341`.
  It overlaps six candidate paths: `CHANGELOG.md`, `Cargo.lock`,
  `apps/web/package.json`, `docs/operations/release.md`, and the client-runtime
  E2EE socket source/test pair. This is an integration residual only; no merge,
  rebase, branch, or history change was performed.
- The Task 8/9 isolated harnesses remain signature-equivalent compile failures.
- The 2026-09-04 Cargo patch releases and the requery's newer
  `@oxlint/plugins` are outside the frozen target set. They require a separate
  reviewed update rather than silent lock or manifest drift.
- GitHub action tags can move. Future updates must requery them and keep the
  approved immutable SHA, especially the Rust 1.98.0 mapping corrected during
  Task 11.
- The required `vercel-react-best-practices` review was not run because that
  skill was unavailable to this agent. `UI.md` review passed for the scoped
  fail-closed auth policy and native evidence.
