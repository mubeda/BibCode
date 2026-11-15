# Rust CI speedups on GitHub-hosted Windows and macOS runners (state as of 2026-11-14)

Research budget was limited (about 16 calls). Several questions have thin or no primary evidence; they are listed under Gaps. Items marked "Inference" are not sourced.

## 1. Runner specs, relative speed, why Windows is slower, Windows mitigations

### Takeaway

Standard public-repo runners are 4 vCPU / 16 GB on Linux and Windows (x64 and arm64), 3 vCPU M1 / 7 GB on macOS arm64, and 4 vCPU / 14 GB on macos-15-intel. macOS arm64 is the smallest box. Windows slowness is mainly process-spawn and file-system cost; the measured fix on hosted runners is moving TEMP/work to D:, not ReFS Dev Drive.

### Cited Findings

- Specs (public repos): ubuntu-24.04, ubuntu-24.04-arm, windows-2025, windows-11-arm = 4 vCPU, 16 GB RAM, 14 GB SSD. macos-26 and macos-15 = 3 vCPU (M1), 7 GB, 14 GB. macos-15-intel = 4 vCPU, 14 GB, 14 GB. — [GitHub docs, hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- macOS runners may start slowly in high demand; nested virtualization is unsupported on arm64 macOS. — same page
- macos-15-intel is reported as the last x86_64 image, supported until about August 2027 (WordPress Trac ticket) or "Fall 2027" (other sources). No official GitHub notice was found. — [WordPress Trac #64246](https://core.trac.wordpress.org/ticket/64246); [macos-13 closing notice](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/) (for context)
- nextest docs: process creation is "quite slow on Windows" and also slow on macOS (anti-malware); Windows nextest is "usually slower than on Unix". Docs recommend a Dev Drive (ReFS) for CARGO_HOME, source repo and target dir, or Defender exclusions for the same three paths. No numbers given. — [nextest why-process-per-test](https://nexte.st/docs/design/why-process-per-test/); [nextest Windows](https://nexte.st/docs/installation/windows/)
- Measured on GitHub Windows runners (pip test suite): moving TEMP to D: cut job time 28% (17m37 to 12m41; 14m58 to 10m44) on Python 3.8 and 10-11% on 3.13. A ReFS Dev Drive saved only about 1 minute on one job versus about 5 minutes for the TEMP move. Author presumes Defender scanning is already off on GitHub runners; no Defender timing measured. — [sichard.ca blog (formerly ichard26.github.io)](http://sichard.ca/blog/2025/03/faster-pip-ci-on-windows-d-drive)
- uv's setup script comment (as summarized by search tool): the runner's D: drive performs similar to or better than a ReFS Dev Drive; they saw no change after switching. Dioxus has a setup-dev-drive.ps1 for Rust CI. — [uv setup-dev-drive.ps1 mirror](https://git.joshthomas.dev/mirrors/uv/src/commit/e7f596711114528d98af1d20c91ce05f8462c703/.github/workflows/setup-dev-drive.ps1); [Dioxus script](https://code.morphllm.com/DioxusLabs/dioxus/src/branch/main/.github/workflows/setup-dev-drive.ps1) (search-snippet level only, not fetched)
- Microsoft claims Dev Drive gives up to ~30% faster builds versus standard Windows 11, not measured on GitHub runners. — [Microsoft devblog, 2023](https://devblogs.microsoft.com/engineering-at-microsoft/dev-drive-and-copy-on-write-for-developer-performance/)
- ARM64 Linux: a blog reports up to 40% better performance than x64 Linux for the same job, with queue time possibly offsetting it (anecdotal). — [corrode.dev](https://corrode.dev/blog/tips-for-faster-ci-builds/)

### Inferences

- Put CARGO_TARGET_DIR (and TEMP/TMP, CARGO_HOME) on D: on Windows rows first; it is a one-line env change. Try ReFS only if that is not enough.
- Because the C: drive has 14 GB and D: is larger on Windows images (not verified here), C: pressure from a big target dir may also matter.
- Windows ConPTY/process-spawn cost explains why test steps that spawn many processes (PTY tests, nextest) are disproportionately slow.

### Gaps

- No relative Rust compile benchmark across windows-2025, windows-11-arm, macos-26, macos-15-intel, ubuntu-24.04-arm found.
- No evidence on whether Defender real-time scanning is actually on for hosted Windows images; only the pip author's presumption.
- windows-11-arm and macos-26 GA/public dates not confirmed beyond their presence in the current table.

## 2. Multiple `cargo test` invocations vs `--no-run` + direct runs vs nextest archives

### Takeaway

Nextest builds with `cargo test --no-run` internally and supports `cargo nextest archive` plus `run --archive-file`, with partitioning across jobs. Plain-cargo rebuild behavior for different `--test`/`--lib` selections was not confirmed from a source.

### Cited Findings

- nextest first builds all test binaries with `cargo test --no-run`, then lists tests by querying the binaries. — [nextest how it works](https://nexte.st/book/how-it-works.html)
- `cargo nextest archive --archive-file x.tar.zst` stores test binaries, cargo metadata, and the build options; `cargo nextest run --archive-file` reuses them; `--workspace-remap` handles a different checkout path; partitioning (`--partition count:N/M`, hash or slice) splits tests across jobs. The docs link a GitHub Actions example. — [nextest reusing builds](https://nexte.st/book/reusing-builds); [partitioning](https://nexte.st/book/partitioning)
- Nextest claims up to 3x over cargo test; one blog saw about 40% in CI because runners have few cores. — [corrode.dev](https://corrode.dev/blog/tips-for-faster-ci-builds/)
- Windows caveat: nextest runs one process per test, and Windows process creation is slow; benchmark on your workflow. — [nextest Windows](https://nexte.st/docs/installation/windows/)
- Cargo config: `CARGO_BUILD_JOBS`/`build.jobs` defaults to logical CPUs; negative values mean CPUs minus N; `--jobs` overrides. A fixed `-j 2` on a 4 vCPU box halves compile parallelism. — [Cargo config](https://doc.rust-lang.org/cargo/reference/config.html)

### Inferences

- (Unverified by source) Cargo fingerprints units by profile, features and sources; filters like `--test a` or `-- filter` are runtime arguments, so a second invocation with identical flags and package selection should be a no-op build. A rebuild occurs when `-p`, `--workspace`, `--all-targets`, `--features` or `--profile` differ between invocations, because feature sets differ. Verify with `cargo test --no-run -v` or `CARGO_LOG=cargo::core::compiler::fingerprint=trace`.
- Cheapest change: one `cargo test --no-run` (or `cargo nextest archive`) step, then run the three selections from it. On macOS/Windows run the archive in the same job; cross-job reuse needs an archive per OS/arch (archives are platform-specific; not confirmed by source).
- `-j 2` on the test runs only limits the cargo build parallelism; test execution parallelism is `--test-threads`/nextest threads, a separate knob.

### Gaps

- No source confirming that `cargo test` with different `--test`/`--lib` selection rebuilds or relinks. The Cargo book `cargo test` page was not fetched.
- No measured numbers for archive vs repeated cargo test on Windows/macOS.

## 3. Does `cargo check --all-targets` share artifacts with `cargo test`?

### Takeaway

Only metadata (`.rmeta`) is shared across check runs; `check` does not do codegen, so it does not produce test binaries and is not reused by `cargo test`. Replacing the check step with `cargo test --no-run` (or `cargo check` removal) is the cheapest way to prove test targets compile.

### Cited Findings

- `cargo check` compiles without final code generation; some errors appear only at codegen, so check can pass where build fails. — [cargo check docs](https://doc.rust-lang.org/cargo/commands/cargo-check.html)
- To check test code: `cargo check --all-targets --profile=test`. — same page
- A 2026 Rust project goal proposes letting build reuse work done by check; this is a proposal, not current behavior. — [Rust project goal: incremental system rethought](https://rust-lang.github.io/rust-project-goals/2026/incremental-system-rethought.html)
- sccache does not cache check output (metadata only), per one personal blog (anecdotal). — [blog](https://tom-tang-3-ai-site.pages.dev/blog/why-cargo-ate-45gb-overnight/)

### Inferences

- `cargo check --all-targets` uses the check profile and separate fingerprints; it compiles every dependency again as metadata only. It is extra work in a job that later runs `cargo test`. Dropping it on Windows in favor of `cargo test --no-run` (which also catches codegen and link errors) is the likely saving. Keep `cargo check --all-targets` on Linux only if you want the cheap lint-like gate.
- `--all-targets` includes benches/examples, so `cargo test --no-run --workspace --all-targets` would build those with the test profile; narrow it to what tests actually need.

### Gaps

- No measurement of check vs test-build cost for the user's workspace type; no source on what `cargo test --no-run` shares with a later `cargo build --release` (nothing: different profile).

## 4. Feature unification and second compiles of the dependency graph

### Takeaway

Cargo builds one copy of a dependency per distinct feature set. With resolver 2/3, dev-dependency, build-dependency and platform features no longer unify unless needed, and selecting `-p crate` versus `--workspace` can change the unified feature set, so alternating them in CI can recompile large parts of the graph.

### Cited Findings

- Features unify as a union across packages that depend on the same crate; resolver 2 stops unifying for platform-specific deps, build-deps/proc-macros, and dev-deps (unless building targets that need them). Trade-off: a dependency may be built multiple times with different features. Suggested fix: `cargo tree --duplicates` and list features explicitly so they unify. — [Cargo book, Features](https://doc.rust-lang.org/cargo/reference/features.html)
- With resolver 2, `--features` and `--no-default-features` apply across all `-p`/`--workspace` selected packages. — same page
- Inspection: `cargo tree -e features`, `cargo tree -e features -i <crate>`, `cargo tree -d`. — same page
- cargo-hakari generates a `workspace-hack` crate that pins the union of features so every dependency compiles once across all member selections. A packaging page claims 15-95% faster local build/check, 20-25%+ cumulative; this is a description, not a benchmark. — [cargo-hakari docs](https://docs.rs/cargo-hakari/latest/cargo_hakari/about/index.html); [Nix package page](https://mynixos.com/nixpkgs/package/cargo-hakari)

### Inferences

- If CI uses `cargo test -p server` plus a workspace-wide desktop build or `--all-targets` check, the graph likely compiles under 2+ feature sets (for example, Tauri/desktop features versus server-only). Detect with `cargo build --workspace -v` vs `-p` timing logs, or compare the `-C metadata` hashes in `target/debug/deps` for the same crate name.
- Fixes in order of effort: use identical package/feature selection across all CI cargo steps; add hakari workspace-hack; or set the unstable/new `resolver.feature-unification` option (not verified).

### Gaps

- `resolver = "3"` and `resolver.feature-unification` (Cargo config) were not documented in the pages fetched; the Cargo config page lists only lockfile-path, incompatible-rust-versions, incompatible-publish-age under `[resolver]`. Status unverified; resolver 3 is believed to concern MSRV-aware resolution, not feature unification (unverified).
- No published before/after hakari timings found.

## 5. Dev/test profile tweaks

### Takeaway

Cheap, documented knobs: `debug = "line-tables-only"` or `0` for dev/test, `CARGO_INCREMENTAL=0` in CI, `split-debuginfo` defaults, and `opt-level` overrides for dependencies. Parallel front end and Cranelift are still not stable as of the 2026 goals pages found.

### Cited Findings

- `test` inherits `dev`; `dev` default is `debug = true` (full). `debug = "line-tables-only"` needs Rust 1.71+ and keeps backtraces with file/line. `split-debuginfo` defaults to `unpacked` on macOS when debug info is on; other defaults are platform-specific. — [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)
- `[profile.dev.package."*"] opt-level = 1/2` applies to dependencies only; the docs suggest trying `opt-level = 1` for dependencies. Build-overrides apply to build scripts and proc macros. — same page
- Cargo sets `incremental = false` by default when the `CI` env var is set and config is unset. — [Cargo config](https://doc.rust-lang.org/cargo/reference/config.html)
- `CARGO_PROFILE_TEST_DEBUG=0` and `CARGO_INCREMENTAL=0` recommended for CI to shrink target and improve cache efficiency; no numbers. Release `lto`/`codegen-units=1` may be set via env in CI only. — [corrode.dev](https://corrode.dev/blog/tips-for-faster-ci-builds/)
- Parallel front end (`-Z threads`): still being worked toward stabilization in the 2026 project goal; 2025 goal reported 20-30+% compile-time reduction. — [Rust goals 2026 parallel front-end](https://rust-lang.github.io/rust-project-goals/2026/parallel-front-end.html)
- Cranelift: February 2026 benchmarks show 5% faster than LLVM on a Zed build with `debug-info=none`; with line tables the gain ranges from negligible to about 30%. No confirmation it is stable for dev builds. — [Rust goals 2026 cg_clif](https://rust-lang.github.io/rust-project-goals/2026/improve-cg_clif-performance.html); [fast builds roadmap](https://rust-lang.github.io/rust-project-goals/2026/roadmap-fast-builds.html)

### Inferences

- For a thin-LTO release bundle of 38-53 minutes: keep it as a separate (possibly Linux-gated or tag-only) job; for PR rows consider a non-LTO `release`-like profile (`lto = off`, `codegen-units` higher) via `CARGO_PROFILE_RELEASE_LTO=off` env, to be validated against the bundle's purpose.
- Windows linking: MSVC link.exe with a large debug build is slow; `debug = "line-tables-only"` shrinks PDBs and link time. `rust-lld` as a linker on Windows/macOS was not verified here.

### Gaps

- No measured gains for debug=0, split-debuginfo, or linkers (lld/mold/zld/ld64 new linker) on Windows/macOS.
- Whether `-Z threads` or cranelift are stable on 2026-11 stable Rust could not be confirmed beyond the project goal pages (nightly-only per those pages).

## 6. Larger or third-party runners (public repos)

### Takeaway

Third-party runners are cheap for Linux but only partially documented for Windows/macOS; all price data below comes from comparison blogs by vendors/competitors and must be rechecked on vendor pages. No Rust-specific speedup numbers were found.

### Cited Findings

- Linux x64 per-minute (2/4/8 vCPU), early November 2026: Blacksmith and WarpBuild $0.004/$0.008/$0.016; Namespace and Depot $0.006/$0.012/$0.024 (Namespace $0.012 pay-as-you-go and $0.008 on a $100/mo plan in another source). Blacksmith 3,000 free minutes/month; Depot from $20/month with 2,000 minutes, billed per second. — [sengi_runners on dev.to](https://dev.to/sengi_runners/blacksmith-alternatives-for-github-actions-in-2026-50hi); [pricing table](https://dev.to/sengi_runners/github-actions-runner-pricing-table-2026-4g4g)
- macOS: WarpBuild M4 Pro 6 vCPU about $0.08/min; Blacksmith macOS M4 about $0.08/min; GitHub macOS M2 Pro larger runner $0.102/min. — [compiler.dev](https://compiler.dev/guides/faster-github-actions-runners)
- Blacksmith runs Windows and macOS; Namespace is recommended for macOS/Windows on a plan. No Windows per-minute price found. — [sengi_runners](https://dev.to/sengi_runners/blacksmith-alternatives-for-github-actions-in-2026-50hi); [sengi compare](https://sengi.run/compare)
- Cache storage: Blacksmith Docker layer cache $0.50/GB-month; WarpBuild cache $0.20/GB-month plus operations. — [sengi pricing traps](https://sengi.run/blog/github-actions-runner-pricing-traps)
- Depot: warm sccache with nextest gave a 35% speedup on 8-core runners. — [Depot guide](https://dev.to/depot/guide-to-faster-rust-builds-in-ci-3njl)
- Cirrus Runners: not covered by any source found.

### Inferences

- Moving from 4 vCPU hosted Windows to an 8-16 vCPU runner is the likeliest large win given `-j 2` currently; but larger GitHub runners are not free for public repos in the same way as standard ones (not verified here).

### Gaps

- No Windows runner prices; no Cirrus Runners data; no Rust compile speedup numbers per provider; GitHub larger-runner Windows/macOS prices not retrieved.

## 7. PTY / ConPTY tests on loaded Windows arm64

### Takeaway

The recurring remedy in other projects is to replace fixed timeouts with a deterministic readiness marker from the child process, and to avoid writing to ConPTY before the child is ready.

### Cited Findings

- Codex repo fixed Windows ConPTY flakiness from early stdin writes racing REPL startup by using a marker emitted by the child as a sync point. — [codex-rs utils/pty (mirror)](https://upd.dev/layers/codex/src/branch/main/codex-rs/utils/pty)
- A ConPTY startup stall of about 60 s was traced to a DA1 (Primary Device Attributes) query that never gets answered, with portable-pty. — [claudeissues.com #36328](https://claudeissues.com/issue/36328-60s-startup-delay-in-conpty-da1-sentinel-never-receives-response)
- Vim: fast-exiting processes lose final output in ConPTY; Vim fixed a flaky Test_terminal_cwd. — [vim_dev PR #19036](https://groups.google.com/g/vim_dev/c/UOlhQdJjgNM)
- LLDB (April 2026) moved to not use ConPTY in tests on Windows. — [lldb-commits PR #192657](https://lists.llvm.org/pipermail/lldb-commits/Week-of-Mon-20260413/167872.html)
- WezTerm issue comment: the bottleneck is the Windows pty layer rather than wezterm. — [wezterm #740](https://github.com/wez/wezterm/issues/740)
- A Rust project keeps Windows attach-latency probes behind `#[ignore]` as timing-sensitive. — [rmux windows_attach_exit.rs](https://docs.rs/crate/rmux/0.7.1/source/tests/windows_attach_exit.rs)

### Inferences

- For the 10 s flake: (a) answer DA1 (`ESC [ ? 1 ; 2 c`) or otherwise handle the startup query in the test harness; (b) wait for a child-emitted marker, then start the timeout clock; (c) run the PTY test serially in its own step or nextest test-group with `max-threads = 1` so it does not compete with a compile; (d) generous timeout (30-60 s) on Windows arm64 with fast failure on marker; (e) warm the shell/process once before the timed test.

### Gaps

- No source on alacritty or nushell CI practices; no measurement of ConPTY first-process cold start on windows-11-arm.
