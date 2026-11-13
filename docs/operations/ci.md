# CI Quality Gates

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and manual
runs (`workflow_dispatch`). It has five job groups.

CI, Seeded Packaged Desktop Upgrade, and Linux Git Compatibility each set
`concurrency.group` to `${{ github.workflow }}-${{ github.ref }}`. On pull
requests `cancel-in-progress` is true: a later push to the same pull request
cancels that workflow's older run, so a burst of pushes does not leave a native
matrix queued for every superseded commit. On `main` a running run is not
cancelled, because a cancelled run saves no Rust cache and every pull request
restores its cache from `main`. GitHub keeps at most one pending run per group,
so during a burst of merges a newer pending run still replaces an older pending
one: the first and the last commit run, the ones between do not. GitHub keeps a workflow
run's status at `queued` until every job has left the queue. One macOS job
still waiting for `macos-26` or `macos-15-intel` therefore lists the whole
run as queued after Check, Test, and the other native rows have already
started. Inspect the jobs, not only the run status, before treating the
workflow as idle.

## Full CI and the `ci:full` label

The macOS legs take one to five hours each and share a five-job macOS
concurrency cap with every other workflow, so a pull request runs them only
when it carries the `ci:full` label:

| Runs on                                     | Every pull request push | `ci:full` pull request, `main` push, manual run |
| ------------------------------------------- | ----------------------- | ----------------------------------------------- |
| Check, Test, Release Smoke                  | yes                     | yes                                             |
| Native desktop: Linux and Windows rows      | yes                     | yes                                             |
| Native desktop: macOS arm64 and x64         | no                      | yes                                             |
| Server tests: macOS arm64 and x64           | no                      | yes                                             |
| Crash smoke: `ubuntu-24.04`, `windows-2025` | yes                     | yes                                             |
| Crash smoke: `macos-26`                     | no                      | yes                                             |
| Seeded Packaged Desktop Upgrade (all jobs)  | no                      | yes                                             |

Add the label to a pull request that changes macOS code, packaging, the updater,
or the release pipeline. The workflows do not listen for the `labeled` event:
a label event would start a run whose skipped jobs report check runs under the
same names as the real ones, and GitHub treats a skipped check as passing. The
label therefore takes effect on the pull request's next push. To run the full
set without pushing, start it manually:

```sh
gh workflow run ci.yml --ref <branch>
gh workflow run desktop-upgrade-smoke.yml --ref <branch>
```

A manual run uses the branch ref, so it does not cancel the pull request's run.
`main` pushes run the macOS legs and the seeded upgrade too, subject to the
pending-run replacement above. The repository has no merge queue, so the
workflows do not listen for `merge_group`.

## Required checks

`main` has no branch protection rule. Repository ruleset 20454382 blocks only
branch deletion and non-fast-forward pushes; it requires no status checks. If
required checks are added, require the job names that run on every pull
request: `Secrets`, `Check`, `Test`, `Release Smoke`, the four `Native desktop - Linux
…`/`Windows …` rows, and `Crash smoke - ubuntu-24.04` and `- windows-2025`.
Do not require the macOS rows or the seeded upgrade jobs: on pull requests
without `ci:full` they do not report under their row names (`macos-26` is not
in the crash matrix at all), and a required check that never reports blocks
the merge.

## Jobs

- **Secrets** runs the gitleaks 8.30.1 CLI (release tarball pinned by SHA-256) over
  every commit a pull request (`base..head`) or push (`before..sha`; the full
  history for a new branch) adds, merged branches included, with `.gitleaks.toml`.
  It then runs `scripts/no-sensitive-data.test.ts` with `BIBCODE_SENSITIVE_RANGE`
  set to the same range, which checks every commit message against the hashed
  banned values. It allowlists `.repos/` and the fixture hash manifests, posts
  no comments and uploads no artifact. The repository is public; see AGENTS.md,
  Sensitive Data.
- **Check** also runs `vp run check:markdown-links` on `README.md` and the living
  docs (relative links, images and anchors; no network).
- **Check** runs `vp check` (which fails on any lint warning), workspace
  typechecking (`vpr typecheck`),
  `cargo fmt --all --check`, and Clippy with warnings denied on Ubuntu 24.04.
  It no longer runs `vp run build:desktop`: the Linux x64 Native desktop row
  builds the shipped AppImage from the same sources, and that step took 23 of
  Check's 35 minutes (median of 34 green runs). The `.deb` and `.rpm` bundles
  are built only by Release. A separate
  `cargo check -p bibcode-server --lib --bins -j 2` also checks production
  feature wiring without dev units: all-targets Clippy enables the hermetic
  test guard, while ordinary server builds do not.
  It also runs `node --test scripts/check-agent-delivery.node-test.mjs` to verify
  rejection of stale or partial proof, duplicate runs, unchanged failed recipes,
  and repeated rounds without a revised diagnosis.
  Its 45-minute job budget covers the remaining steps (12 minutes median and
  15 at p90 over those runs) plus 26 minutes for the hosted apt mirror, which
  stretched the Tauri dependency install from 30 seconds to 20-25 minutes on
  pull request 177, with a few minutes for a cold-cache Clippy.
- **Test** runs every workspace package `test` script one task at a time with
  `vp run -r --concurrency-limit 1 test` on Ubuntu 24.04, then
  `cargo test -p bibcode-updater-verifier -j 2`. The package scripts already run
  the `bibcode-server` and `bibcode-desktop` suites; the updater verifier is the
  only workspace member without one. The job used to follow them with
  `cargo test --workspace -j 2`, which rebuilt and reran both suites under the
  workspace's unified features: 21-23 more minutes and a third target tree on
  a runner that has run out of disk. Serial tasks keep `rustc` from competing
  with a running server or desktop suite, whose 2-second test deadlines have
  failed on starved hosted runners. Right after Checkout it frees unused
  preinstalled toolchains (Android, .NET, GHC, Boost, CodeQL) and prunes Docker
  images, then fails if `/` has less than 30 GiB free: hosted runners vary from
  about 72 GB to 145 GB cow-roots, and a 12 GB `target` still needs that
  headroom even with `CARGO_PROFILE_TEST_STRIP: symbols`. Its 70-minute job
  budget is the package suites' 42 minutes at p90 over 27 green runs, about 3
  minutes for setup, the verifier and SSH, and the 21-minute apt stall seen on
  pull request 65.
  Test-owned deadlines stay unchanged. The `-j 2` bound limits concurrent Cargo compilation jobs; Rust
  test binaries use the default parallel harness threads. Exact subprocess
  tests may still select `--test-threads=1` inside an isolated child process
  that intentionally owns process-global state.
  That suite includes the transfer byte budget (`apps/server/tests/transfer_budget.rs`): it
  fails when the shell snapshot (whole and capped), the big thread's first `subscribeThread`
  item (whole, and as the history window the app opens) or its resume answer grows past
  `apps/server/tests/transfer_budget.json`, in bytes after deflate or decoded.
  It counts bytes, not time, so it is deterministic on any runner.
  The job then builds the guarded `bibcode` through
  `cargo test -p bibcode-server --test cli_smoke --no-run -j 2`
  and runs the ignored desktop SSH integration test
  (`cargo test -p bibcode-desktop --test ssh_environment -- --ignored`), which
  needs that fresh guarded binary and fakes only the SSH hop; see
  [Desktop-managed SSH environments](../testing/ssh-environments.md).
- **Release Smoke** runs `scripts/release-smoke.ts` to exercise release-only
  version rewriting, nightly metadata, and lockfile generation without
  publishing.
- **Native desktop** builds the web application, tests the desktop Rust host,
  and creates an unpublished native bundle on Linux ARM64/x64, Windows ARM64/x64,
  and macOS ARM64/x64 runners. The macOS rows are a separate job,
  `native_desktop_macos`, with the same steps (a YAML alias) and the `ci:full`
  gate above. macOS x64 runs on `macos-15-intel`, the runner Release builds the
  shipped Intel app on, so CI tests the build Release ships and saves the cache
  Release restores; Seeded Packaged Desktop Upgrade keeps `macos-26-intel` for
  runtime coverage on the newest macOS. The bundle step passes `--symbols`, the
  release symbol build (`STRIP=none`, line tables, a packed dSYM on macOS, a
  GNU build-id on Linux) that Release uses, so it also proves the `dump_syms`
  path on every pull request; the job installs `dump_syms` 2.3.9 for it, and
  Rust Cache keeps the binary in `~/.cargo/bin`.
  Each matrix row declares its complete-job budget:
  330 minutes for each macOS row and 120 minutes for the other four targets.
  That budget includes setup, host tests, the macOS optimized exception-recovery
  probe, and native packaging without shortening any check or test-owned deadline.
  Debug host tests cannot warm the optimized artifacts. The exception probe is
  the `bibcode-objc-exception-probe` crate: it depends only on `objc2` and
  `objc2-foundation`, with the `objc2` features the desktop graph enables, and
  runs under the shipped release profile. Do not move it back into
  `bibcode-desktop` as an example: an example enables the dev-dependency
  features (`bibcode-server/hermetic-test-guard`, `tauri/test`,
  `tokio/test-util`), so it compiled the whole desktop and server graph a
  second time, 84 of the 215 minutes of the macOS arm64 row on 2026-11-13.
  Check a change to the probe by running it once with
  `CARGO_PROFILE_RELEASE_PANIC=abort`, where it must fail. The shared `scripts/run-msvc.mjs` launcher selects
  the requested MSVC architecture. After the Rust host tests,
  the Windows row alone runs
  `vp test run apps/desktop/e2e/support/test-project.test.ts apps/web/src/components/gitManager/gitManagerRepositoryAvailability.test.ts`. That step is the
  supported native proof that the generated Cursor `.cmd` shim executes through
  the Windows command processor and writes its exact action record. Simulated
  target fixture assertions on other hosts are compatibility evidence, not a
  native Windows pass.
  The repository-availability contract additionally executes the generated
  drive/UNC trust commands through native Windows PowerShell and Git, including
  spaces, dollar signs, backticks, and typographic quotes. Every Git/home
  configuration input is fixture-owned. Other platforms skip that native case;
  their string assertions remain compatibility evidence.
  The Windows rows then run
  `node scripts/run-msvc.mjs cargo check -p bibcode-server --all-targets` so
  Unix-only test helpers or imports that are unused on Windows fail there under
  `-D warnings` instead of surfacing only during native validation; Clippy's
  `--all-targets` pass otherwise runs on Linux alone.
  The repository-availability contract additionally executes the generated
  drive/UNC trust commands through native Windows PowerShell and Git, including
  spaces, dollar signs, backticks, and typographic quotes. Every Git/home
  configuration input is fixture-owned. Other platforms skip that native case;
  their string assertions remain compatibility evidence.
- **Server tests (macOS)** is the job `server_tests_macos`, on `macos-26` and
  `macos-15-intel` with the `ci:full` gate above. It runs the server tests whose
  behaviour differs on macOS: `git_system_config`, the background Git index lock
  tests, and the host metrics tests. Linux runs them in Test and Windows in its
  Native desktop rows. They are a separate job because the server's test build
  took 32 to 56 minutes inside the macOS Native desktop rows and pushed both past
  their budget. The job restores the Native desktop Rust cache and never saves
  one. Its budget is 150 minutes. A full run now starts seven macOS jobs against
  the five-job cap, so two of them wait for a free runner.
- **Crash smoke** runs on `ubuntu-24.04` and `windows-2025` on every pull
  request, and also on `macos-26` with `ci:full`, on `main`, and in manual runs.
  It builds with the release symbol profile from
  [Symbol assets](./release.md#symbol-assets) and runs
  `cargo test -p bibcode-server --test crash_smoke --release` with
  `CRASH_SMOKE_OUT` set to `${{ runner.temp }}/crash-smoke`, so the minidump that
  the `crash-smoke` binary leaves under the crash monitor survives the test. The
  test treats that directory as a data root (the dump lands in
  `userdata/profiler/crashes/`), and `bibcode profiler symbolicate <id> --json`
  must read the dump's crash reason and crashing-thread frames.
  `scripts/dump-symbols.ts` then dumps that binary (with its dSYM on macOS and
  its PDB on Windows), and `minidump-stackwalk --json` must name
  `crash_here_in_named_function`, with its caller unwound through CFI. The
  release build's own
  `bibcode profiler symbolicate <id> --symbols <store> --json` must name it too,
  from the same store, so BiBCode's symbolication is proven on every OS and not
  only the third-party walker. `dump_syms` 2.3.9 and `minidump-stackwalk`
  0.27.0 are installed with `cargo install --locked`, and Rust Cache keeps them
  in `~/.cargo/bin`. A failed run uploads the dump, its sidecar, the symbol
  store, and the stack walk as the `crash-smoke-<os>` artifact. The Windows
  ARM64 dump path stays disabled, so the job has no Windows ARM64 row; the
  `macos-26` row is ARM64.
  The crash step adds `CARGO_PROFILE_RELEASE_LTO=off` and
  `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16` to that profile; optimisation, line
  tables, symbols and the packed dSYM stay. With the shipped thin-LTO single
  codegen unit, rustc spent most of the build optimising the `bibcode-server`
  crate on one core, and `macos-26` runs took 40 to 79 minutes or hit the
  90-minute limit. Commit `546648ee5f` added the overrides: a cold
  `cargo test -p bibcode-server --test crash_smoke --release --no-run` pinned to
  4 cores took 666 seconds with the shipped profile and 293 seconds with them,
  and the job timeout is 60 minutes. The planted frames are
  `#[inline(never)]`, and the symbol format, line tables, and unwind tables do
  not depend on LTO or codegen units, so the smoke still proves the release
  symbol path. `Cargo.toml`'s shipped profile is unchanged. The step prints its
  elapsed seconds as a `::notice::`.

The Check and Test jobs install the Linux libraries required by Tauri. The
native matrix installs them only on Linux and otherwise uses each platform's
native toolchain. Node.js and Vite+ are development/build dependencies; release
artifacts contain the Tauri/Rust application and built web assets, not a Node
runtime or TypeScript server.

All workflows use the repository's declared Node.js 26.12.1, pnpm 11.28.5,
Vite+ 1.1.0, and Rust 1.98.1 toolchains. External setup actions are immutable
SHA-pinned with audited tag comments: Checkout 7.0.1
(`3d3c42e5aac5ba805825da76410c181273ba90b1`), Rust Cache 2.9.2
(`6323deb102c322ba6fcbdcafc7e3dddab59af2b6`), setup-vp 1.21.2
(`68f39c78aaf39be468cabd2afb09c162574c84af`), action-gh-release 3.0.3
(`efb35369e0ad2afab669f228072c1b0d510eae64`), and Rust toolchain 1.98.1
(`18f0487477426dce244608110aa2660c2893deb7`). Reverify a tag before changing
its immutable SHA.

## Rust cache budget

GitHub keeps 10 GB of Actions caches per repository and evicts the least
recently used entries above that. Which workflow saves which entry:

- Check, Test, Native desktop, Crash smoke, and Linux Git Compatibility restore
  the Swatinem Rust cache on every run and save it only when `github.ref` is
  `refs/heads/main`, including when a later step fails (`cache-on-failure`).
  Pull requests read that default-branch cache and save nothing.
- Native desktop sets `shared-key: native-desktop`, so one entry per runner
  OS and architecture. Release's `build_desktop` and `build_server` use the
  same key, the same `. -> target` workspace, and no job-level `CARGO_*` or
  `RUST*` environment, so they restore the entry CI's `main` run saved and
  never save (`save-if: false`). A tag run used to save its own entries under
  `refs/tags/<tag>`, which no later run could restore and which pushed the
  `main` entries out.
- Seeded Packaged Desktop Upgrade has no Rust cache step: its harness builds in
  a run-owned target that a repository `target` cache cannot warm.
- The pnpm store stays on the setup-vp cache.

A job cancelled by `timeout-minutes` or by a newer run skips the cache post
step, so the Check and Test budgets above include a cold compile. Native
desktop keeps its 120-minute and 330-minute row budgets.

Six native-desktop entries of about 1.6 GB each are about 10 GB on their own,
before Check, Test, Crash smoke, Linux Git, and the setup-vp caches. Eviction
therefore still drops the least recently used entries, now always older `main`
entries rather than unrestorable tag or pull request entries. List them with
`gh cache list --sort size_in_bytes --limit 100`.

## Other Workflows

- `.github/workflows/linux-git-compatibility.yml` builds the real server Git
  runner regression test on Ubuntu 22.04, then executes it against system Git
  in Debian 12/13, Ubuntu 22.04/24.04, Fedora 44, and Arch rolling containers.
  It verifies AppImage library isolation for text and binary subprocesses,
  including inherited mounts from previous updates. This is Git compatibility
  evidence; native packaged desktop and updater validation remain separate.
- `.github/workflows/desktop-ui-smoke.yml` is a manual or reusable packaged-app
  UI smoke matrix for all six supported native targets. Each target uploads its
  screenshots, logs and the specs' JSON traces, such as the Mermaid timeline
  samples.
- `.github/workflows/desktop-upgrade-smoke.yml` runs real seeded updater flows on
  all six targets, including the isolated `remote-install` lane. That lane uses
  the product coordinator, verifies boot/version/storage/protection evidence,
  and scopes Linux process cleanup to its exact data root. The harness rejects
  local invocation; unit/syntax checks do not constitute real upgrade evidence.
  The two seeded macOS rows have a 360-minute complete-job allowance for three
  sequential 90-minute packaging children that share one run-owned Cargo target
  (only the first is cold; each bundle is staged into its own artifact root),
  three 10-minute frozen installs,
  and 60 minutes for setup, runtime verification, evidence, and cleanup: Intel
  needs it, and the capacity-constrained Apple silicon runners have taken 43
  minutes for one package. The other four rows and the separate WSL job keep
  240 minutes; their packaging children keep 60 minutes on Windows and 45 on Linux. If owned-child cleanup does not observe `close`
  within five seconds, the harness releases that child and exits nonzero so the
  job cannot stay open for the rest of the 240-minute budget.
  The smoke builds override the release profile with 16 codegen units, LTO off, and `opt-level` 1, because they prove upgrade behaviour, not optimised code: a single thin-LTO codegen unit kept Intel runners on one core for up to an hour per package, and optimising the workspace crates dominates what the shared target cannot remove. Release and CI packaging outside this harness keep the full release profile.
  The harness appends each install's and build's start, end, duration, and exit code or timeout to `build-timings.txt` in the evidence folder, plus a five-minute heartbeat with a `ps` sample of `rustc`, `cargo`, and `ld` (skipped on Windows), so a killed build still uploads evidence. The harness step ends 15 minutes before its job (345 of 360 minutes on macOS, 225 of 240 elsewhere) so the always-run upload still runs.
  `remote-install` reuses the protected package.
  Repository `target` caching cannot warm the run root's shared Cargo target,
  so the workflow has no Rust cache step. It runs on `main` pushes, manual
  runs, and pull requests labelled `ci:full` (see above), with the same
  concurrency rules as CI. Its evidence uploads use `if-no-files-found: warn`:
  when the harness fails before writing evidence, the job shows the harness
  error rather than an upload failure.
  Outside WSL, each lane also requires the embedded server's `serverVersion` to be the
  baseline version before the update and the candidate version after it, so a stale
  binary from another build in the shared target fails the lane.
  These packaging allowances are separate from the native desktop CI job above
  and preserve all existing product, WebDriver, and restart deadlines.
  Windows lanes wait for the exact candidate's installed PE version before
  stopping and relaunching the host, retaining bounded handoff observations.
  Its WSL-specific lane remains Windows x64.
- `.github/workflows/release.yml` runs the stable/nightly release pipeline. See
  the [Release Checklist](./release.md). Its separate server matrix builds six
  archives, four Linux packages, and native distribution evidence before release
  assembly can create a draft. Both matrices also publish Breakpad
  [symbol archives](./release.md#symbol-assets).
- `.github/workflows/deploy-relay.yml` deploys the BiBCode Connect relay from
  `main` only when the required Cloudflare repository configuration exists.
- `.github/workflows/transfer-report.yml` runs on pull requests that touch the server or its
  contracts. It compiles the transfer byte-budget test on the pull request's head and, with the
  head's test and fixture, on its base, and writes both measurements to the job summary and an
  artifact (`scripts/transfer-report.ts`). It reports and never fails on a budget; the Test job
  does. It has read-only repository permissions, no secrets and no comment step, so running the
  pull request's own code is safe. A base that does not build with the head's test shows "n/a".
- `.github/workflows/issue-labels.yml`, `pr-size.yml`, and `pr-vouch.yml` enforce
  repository-maintenance policy independently of the application quality
  gates.

When changing a workflow, update its focused workflow-contract tests and run
the repository gates documented in [Scripts](../reference/scripts.md).
Repeatable native manual and packaged validation follows the
[shared cross-platform runbook](../testing/cross-platform-validation.md) plus
the matching Windows, Linux, or macOS page in the
[testing runbook index](../testing/README.md).
