# Swatinem/rust-cache behaviour and Rust CI cache sizing (as of Nov 2026)

Method note: source files were read via a summarising fetch tool (raw.githubusercontent.com, master branch), not line-by-line by me, so code quotes are as relayed. Master may be slightly ahead of v2.9.2. Changelog has no dates.

## 1. What goes into the cache key (the two hashes)

### Takeaway

Key = `prefix[-shared-key | -key-job] -OS -arch -<env hash> -<lock hash>`, both hashes SHA-1 truncated to 8 hex chars. The last hash covers config/toolchain files, normalized Cargo.toml files (local versions zeroed) and only registry/git entries of Cargo.lock. A workspace version bump should NOT change it; dependency, feature, profile, `[patch]`, `.cargo/config.toml` or toolchain-file edits do.

### Cited Findings

- Prefix starts at `prefix-key` (default `v0-rust`); `shared-key` is appended if set, otherwise `key` plus job id; OS and arch are always appended — [config.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/config.ts)
- First hash (env hash): `rustc -vV` release/host/commit-hash, plus (since 2.9.0) every installed rustup toolchain, sorted; plus every env var whose NAME starts with CARGO, CC, CFLAGS, CXX, CMAKE, RUST (or prefixes from `env-vars`) as `NAME=value`, sorted — [config.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/config.ts), [README](https://raw.githubusercontent.com/Swatinem/rust-cache/master/README.md), [CHANGELOG 2.9.0](https://raw.githubusercontent.com/Swatinem/rust-cache/master/CHANGELOG.md)
- This hash is also the `restoreKey` (prefix + env hash, no lock hash) — [config.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/config.ts)
- Second hash (the one that changed 3x): raw bytes of `.cargo/config.toml`, `rust-toolchain`, `rust-toolchain.toml` (root and under each workspace root), each member `Cargo.toml` plus workspace root `Cargo.toml`, and Cargo.lock — [config.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/config.ts)
- Cargo.toml normalization: `package.version` / `workspace.package.version` set to "0.0.0"; for path dependencies (in dependencies, build-, dev-, workspace.dependencies) version set to "0.0.0" and path blanked; the normalized JSON is hashed. All other content (deps, features, `[profile]`, `[patch]`, lints, metadata) still counts — [config.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/config.ts)
- Cargo.lock: only packages with `source` or `checksum` are hashed (workspace-local crates excluded), so bumping workspace member versions does not alter it; lock versions other than 3/4 fall back to raw bytes — [config.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/config.ts)
- 2.7.2 changed the key to depend only on Cargo.toml/Cargo.lock of workspace members; 2.9.1 fixed a "regression in hash calculation"; 2.9.2 fixed rustc version sorting/dedup — [CHANGELOG](https://raw.githubusercontent.com/Swatinem/rust-cache/master/CHANGELOG.md)
- Env vars are in the FIRST hash, not the last. `RUSTFLAGS`, `CARGO_*` set in CI (e.g. `CARGO_INCREMENTAL`, `CARGO_PROFILE_*`, `CARGO_BUILD_JOBS`, `CARGO_TERM_*`) feed it — [config.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/config.ts)

### Inferences

- In `...-00d9be57-c5cda4df` the first part is env/toolchain, the last is manifests/lock/config. Three changes in a week = lockfile registry entries changing (dependabot/renovate, `cargo update`), or Cargo.toml dependency/feature/profile edits, or `.cargo/config.toml`/`rust-toolchain` edits. A version-only bump is ruled out by the normalization (verify with the "Cache key" debug output in the action log, which lists key files).
- Any Cargo.toml that is NOT a workspace member (e.g. fixtures) is not hashed; any `.cargo/config.toml` under the workspace root IS (glob `**/.cargo/config.toml`).
- Case-insensitive match is used for "full match" (2.9.0).

### Gaps

- I did not confirm whether a rustc patch bump on the runner image (hosted macOS images update rustup toolchains) changes the first hash; by the code it would (commit-hash included), but I saw no issue stating it.

## 2. Restore on partial match, and when it saves

### Takeaway

Exactly one restore-key is passed: prefix + env hash. A lock-hash change therefore gives "full match: false" and restores the newest entry sharing the env hash (GitHub picks the most recent prefix match), then saves a NEW entry at the end of the job (if `save-if` is true). Different env hash (rustc/RUSTFLAGS/CARGO_* change) = no restore at all.

### Cited Findings

- `restoreCache(paths, config.cacheKey, [config.restoreKey])` with a single fallback; exact-match compare is case-insensitive; log line "...full match: ${match}" — [restore.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/restore.ts)
- On a partial match the action runs `cleanTargetDir(target, [], true)` (timestamp mode, drops entries older than 1 week) before the build, sets cache-hit=false — [restore.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/restore.ts), [cleanup.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/cleanup.ts)
- Save: skipped if `save-if` != "true"; skipped with "Cache up-to-date" on an exact hit; otherwise cleanup (target dir, registry, bin if cache-bin, git) then `saveCache` — [save.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/save.ts)
- README: `cache-on-failure` defaults false (save even if workflow failed) — [README](https://raw.githubusercontent.com/Swatinem/rust-cache/master/README.md)
- GitHub restore order: exact key on current branch, prefix on current branch, each restore-key, then same on default branch; most recent among prefix matches wins; PR runs read base/default branch caches; PR-created caches are scoped to the merge ref — [GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- GitHub limits: 10 GB default per repo, oldest-by-last-access evicted when over limit ("cache thrashing"), entries unused 7 days removed — [GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

### Inferences

- With `save-if` default-branch-only, each lock change on main writes a fresh 1.5-1.85 GiB entry per OS/arch; with several OS/arch rows and several recent lock hashes the 10 GB repo budget is easily exceeded, evicting live entries (explains "No cache found"). This is an inference from limits above plus the measured entry sizes.
- Feature branches/PRs can only restore main's entries; a PR that changes Cargo.lock gets a partial match (or none if env hash differs).

### Gaps

- Whether `cache-on-failure` saves happen before cleanup differently: save.ts as fetched shows no reference to job status (handled via action.yml post-condition, not read).

## 3. What is deleted before saving; workspace crates

### Takeaway

Cleanup keeps only dependency artifacts. By default the workspace's own crates (and their build-script outputs/fingerprints) are deleted, `incremental/` is deleted, `~/.cargo/registry/src` is deleted, and binaries that existed before the action ran are removed from `~/.cargo/bin`. So a "full match" restores dependencies only; the workspace crates rebuild every run.

### Cited Findings

- README: removes incremental artifacts, unused deps and non-deps, artifacts with mtime older than a week; does not cache workspace crates; does not cache `~/.cargo/registry/src`; sets `CARGO_INCREMENTAL=0`; removes pre-existing `~/.cargo/bin` files — [README](https://raw.githubusercontent.com/Swatinem/rust-cache/master/README.md)
- Profile dir: only `build`, `.fingerprint`, `deps` kept; within them only entries matching the `packages` list (names/targets, `lib` prefix, hash suffix stripped); `tests` dirs keep only `target` and `trybuild`; top-level files other than CACHEDIR.TAG removed — [cleanup.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/cleanup.ts)
- `packages` = `getPackagesOutsideWorkspaceRoot` (cargo metadata, filtered to targets of kind in SAVE_TARGETS); workspace members are appended only when `cache-workspace-crates: true` — [save.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/save.ts), [workspace.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/workspace.ts)
- Registry: `credentials.toml` deleted; `registry/src` kept only for `-sys` crates; `.crate` files and index cache pruned to used crates; git db/checkouts pruned to referenced ones — [cleanup.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/cleanup.ts)
- `cache-workspace-crates` added in 2.8.0 — [CHANGELOG](https://raw.githubusercontent.com/Swatinem/rust-cache/master/CHANGELOG.md)
- A repo PR (#349) discusses that caching workspace targets grows cache count/size because source changes create new keys; status unclear — [search result](https://github.com/Swatinem/rust-cache/pull/349)

### Inferences

- Because pruning is based on crate name, BOTH debug and release profile dirs keep every dependency's artifacts, i.e. a job building two profiles holds two full dependency sets (plus macOS `.dSYM`/debuginfo in dev). Enabling `cache-workspace-crates` would add workspace objects but, by the Cargo fingerprint design, not help unless sources/mtimes match; I found no source on this mtime behaviour in this session, so treat as unverified.
- The 40-110 min release time "even on full match" is consistent with workspace crates always being rebuilt (and thin-LTO/codegen cost); it is not a cache miss.

### Gaps

- No authoritative measurement of how much `cache-workspace-crates: true` helps/grows a cache.

## 4. Options controlling size and scope

### Takeaway

Defaults and semantics from the README; the levers that shrink size are `cache-targets`, splitting by `key`/`shared-key` per profile, `cache-bin: false`, and `cache-all-crates` left false.

### Cited Findings (defaults per [README](https://raw.githubusercontent.com/Swatinem/rust-cache/master/README.md))

- `prefix-key` v0-rust (bump to force fresh cache); `shared-key` empty (replaces job-id key); `key` empty (extra separator); `add-job-id-key` true; `add-rust-environment-hash-key` true (if false, key = prefix only, no hashes — [config.ts](https://raw.githubusercontent.com/Swatinem/rust-cache/master/src/config.ts))
- `env-vars` default `CARGO CC CFLAGS CXX CMAKE RUST`; `workspaces` default `. -> target`; `cache-directories` empty; `cache-targets` true (false = only cargo registry/git cached)
- `cache-all-crates` false (true also keeps crates installed by CI tooling); `cache-workspace-crates` false; `save-if` true; `lookup-only` false (sets cache-hit without restoring); `cache-bin` true (cleanup deletes pre-existing bins; false for long-lived self-hosted runners); `cmd-format` `{0}` (wrappers/nix)
- `cache-provider`: `github` default, `warpbuild` documented (added 2.8.0); BuildJet was not listed in the README I read — [README](https://raw.githubusercontent.com/Swatinem/rust-cache/master/README.md), [CHANGELOG](https://raw.githubusercontent.com/Swatinem/rust-cache/master/CHANGELOG.md)
- `lookup-only` added 2.7.6; arch added to key 2.7.8 — [CHANGELOG](https://raw.githubusercontent.com/Swatinem/rust-cache/master/CHANGELOG.md)

### Inferences

- Two profiles in one job share one key; using `key: debug` / `key: release` in separate steps (each with its own save) gives smaller, independently evicted entries, and the lock hash then matches per entry. Not tested.

### Gaps

- BuildJet/other providers: no source found in README; I could not confirm any provider besides github and warpbuild.

## 5. Size reducers for target/ in CI

### Takeaway

Only Cargo-documented settings are sourced here; the rest (cargo-sweep, cargo-cache, zstd level) I could not source in this session.

### Cited Findings

- `debug` accepts `0`/`false`/`"none"`, `"line-tables-only"`, `1`/`"limited"`, `2`/`"full"`; dev default is full, release none. Named values need Rust 1.71 — [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)
- `strip` default "none", values "debuginfo"/"symbols"; `split-debuginfo` on macOS defaults to `unpacked` when debug info is on — [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)
- `incremental` is only for workspace members and path deps, controllable via `CARGO_INCREMENTAL`; rust-cache already sets 0 and deletes incremental dirs — [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html), [README](https://raw.githubusercontent.com/Swatinem/rust-cache/master/README.md)
- Profile settings come only from the workspace root; `[profile.dev.package."*"] debug = 0` style overrides can shrink dependency debug info without touching workspace crates — [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)
- Build-override defaults: opt-level 0, codegen-units 256, debug false for build scripts/proc macros — [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)

### Inferences

- `debug = "line-tables-only"` (or `0`) for dev/test and `[profile.dev.package."*"] debug = 0` is the lowest-risk way to cut the debug profile's share (debuginfo typically dominates dev target size; no number sourced here). On macOS `unpacked` split-debuginfo leaves `.o` files in deps that are cached; `debug = 0` avoids them.

### Gaps

- No source found for: cargo-sweep, cargo-cache usage with rust-cache, zstd level tuning of actions/cache, measured size effect of `strip`/`debug=0`.

## 6. sccache vs rust-cache for a workspace dominated by its own crates

### Takeaway

sccache caches per rustc invocation, so it can cache workspace lib crates that rust-cache discards, but it cannot cache anything that invokes the linker (bin, dylib, cdylib, proc-macro; build scripts are bins), requires incremental off, and Depot measured it slowing release builds. For thin-LTO/codegen-units=1 I found no documentation either way.

### Cited Findings

- Not cacheable: crates invoking the system linker (bin, dylib, cdylib, proc-macro); requires `--emit` link/metadata/dep-info, `--crate-name`, `--out-dir` — [sccache Rust.md](https://raw.githubusercontent.com/mozilla/sccache/main/docs/Rust.md), [README](https://raw.githubusercontent.com/mozilla/sccache/main/README.md)
- sccache errors if `CARGO_INCREMENTAL=1` unless `SCCACHE_ALLOW_INCREMENTAL=1`, which leaves workspace members/path deps uncached — same sources
- Hits across directories carry the original paths in debuginfo/panic messages unless `--remap-path-prefix`; `SCCACHE_BASEDIRS` exists — [README](https://raw.githubusercontent.com/mozilla/sccache/main/README.md)
- GHA backend: rate limits can skip stores silently; `SCCACHE_GHA_RW_MODE=READ_ONLY`; `SCCACHE_GHA_VERSION` change purges — [GHA.md](https://raw.githubusercontent.com/mozilla/sccache/main/docs/GHA.md)
- Depot (Zed, 8 cores): warm sccache 25m18s vs 28m36s baseline (11.5% faster), cold 16.8% slower; FAQ says sccache speeds test compilation 11-14% but can slow release builds up to 50%, suggesting plain cargo for release — [Depot guide](https://depot.dev/blog/guide-to-faster-rust-builds-in-ci.md)
- RisingWave (Apr 2026, vendor blog): no-cache release 21m40s vs 1m52s warm sccache on a different provider's runner — via search summary of [avrea.com](https://avrea.com/blog/risingwave-sccache-ci-benchmark), not opened by me

### Inferences

- Since the final bin/proc-macro/build-script steps are uncacheable, a Tauri app's final link stays; but lib crates of the workspace (the bulk of 40-110 min if codegen-heavy) could hit. Whether thin LTO objects are cached is unknown: LTO runs in the rustc invocation for lib crates only when requested, and neither doc addresses it.

### Gaps

- sccache + thin LTO / codegen-units=1: no source found; must be tested with `sccache --show-stats` non-cacheable reasons.
- sccache Windows/macOS-specific limits: none found in docs fetched this session (README only mentions static linking). Not answered.
- No clean rust-cache vs sccache benchmark on a workspace dominated by own crates.
