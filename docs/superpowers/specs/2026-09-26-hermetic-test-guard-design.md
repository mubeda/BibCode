# Hermetic test guard: tests can never run the developer's real provider or hosting CLIs

Status: **Approved on 2026-09-26** by the controller, under approval the user delegated ("yolo"). A Fable second
opinion preceded it, and all nine of its changes are folded in below: the build scope, the example-run finding, the
CI SSH step, stderr and Drop, removing `compile_error!` in favour of a manifest contract test, path rules, the target
root, desktop scope, and the workspace dev-dependency.

## Problem and evidence

A read-only audit on 2026-09-26 traced every Rust test in `bibcode-server` and `bibcode-desktop` under
`strace -f -e trace=execve,connect` with logging fake CLIs first on PATH: 4,187 tests. It did not trace the desktop
integration binaries.

- **86 tests executed the developer's real `claude`, `codex` and `opencode`** through bare-name PATH lookups.
  - `claude --print` starts the user's MCP servers.
  - With the real CLIs installed, runtime-booting tests also sent latest-version requests to registry.npmjs.org
    and downloads.claude.ai.
- **3 tests ran the real `gh` and `glab`** with the user's stored credentials, making HTTPS calls to api.github.com
  and a private GitLab host.
- **Root causes:**
  - every production-runtime boot probes providers at once with default settings (bare names);
  - a partial `providerInstances` is back-filled from the default legacy `providers` block;
  - `SourceControlDiscovery` and `GitVcsServices` resolve `gh` and `glab` from PATH, and only `cfg(test)` seams
    exist.

Layer 1, the shared `tests/support/hermetic_providers.rs` helper plus its adoption by every harness, fixes today's
hits. Nothing stops the next test from regressing: any new `ServerConfig::new(tmp)` followed by
`ServerRuntime::start` silently runs the real CLIs again. This design adds the enforcement layer.

## Goals and non-goals

**Goals:**
- A test that would resolve a guarded executable outside test-owned directories fails loudly and names the program
  and path.
- Locally as well as in CI, because the developer's machine and credentials are what need protecting.
- Zero cost and zero behaviour change in every build without dev units: `cargo build`, `cargo run`,
  `tauri build`, and the release workflow's `cargo build --release --bin bibcode`.
  - Check-mode builds of all targets enable the feature: `cargo clippy --workspace --all-targets`,
    `cargo check --all-targets` and CI's test-target compile step. That is harmless, since they produce no shipped
    artifact.
  - Cargo builds the feature-off configuration only through `cargo build`.

**Non-goals:**
- Sandboxing what fixtures themselves do.
- Guarding `git`, `node` and `sh`: tests use them deliberately, with isolated config.
- **Desktop-owned resolution** (`ssh`, `wsl.exe`, tailscale).
  - The Layer 1 desktop wave makes those tests hermetic instead: `ssh -F /dev/null` with a literal unroutable
    address, plus fakes.
  - The rollout adds a strace audit of the desktop integration binaries, which the original audit did not trace.

## Alternatives

### A. Resolution guard behind a test-only cargo feature (recommended)
- **Feature:** add a `hermetic-test-guard` feature to `bibcode-server`. Only builds that contain a dev unit (a test,
  bench or example) enable it, through dev-dependencies:
  - `apps/server/Cargo.toml` `[dev-dependencies]`:
    `bibcode-server = { workspace = true, features = ["hermetic-test-guard"] }`. This is a self dependency through
    the workspace entry `bibcode-server = { path = "apps/server" }`, so `check-dependency-upgrade-ledger.ts` sees a
    workspace dependency. Verify that it resolves to the crate itself.
  - `apps/desktop/src-tauri/Cargo.toml` `[dev-dependencies]`: the same line.
  - Cargo unifies dev-dependency features only when a dev unit is in the build (Cargo book, "Feature resolver
    version 2"; the known cargo#2911 workaround). The audit confirmed this on cargo 1.98 with resolver 3: unit
    tests, integration tests and the `CARGO_BIN_EXE_bibcode` binary see the feature, and plain builds do not.
  - Examples are dev units too. So CI's `cargo run --release … -p bibcode-desktop --example objc_exception_probe`
    (ci.yml:242) builds WITH the feature, which is harmless because the example resolves no provider.
- **Where it checks:** every place that turns a program name into a path:
  - `resolve_provider_executable_in_path` (`production/provider_runtime.rs`) covers probes, maintenance, session
    launch, control and usage;
  - `SourceControlDiscovery::command` (`source_control/discovery.rs`);
  - the GitHub/GitLab hosting commands in `production/git_vcs.rs`;
  - the provider-terminal `resolve_executable` fallback (`provider_terminal/supervisor.rs`).
- **The rule:**
  - Guarded names are `claude`, `codex`, `opencode`, `cursor-agent`, `agent`, `grok`, `gh`, `glab`, `az`, `jj`,
    `npm`, `npx`, `bun`, `pnpm`, `yarn`, `brew`, `vp` and `winget`.
  - Match on the file stem, case-insensitively on Windows, so `codex.cmd` and `gh.exe` count.
  - Judge the resolved target BEFORE any `cmd.exe`/`powershell.exe` shim wrapping.
  - Judge only paths that exist. A missing path cannot execute, and Layer 1's `missing-provider-executable` never
    exists, so it falls through to the normal "not found".
  - An existing guarded path passes only when its canonical form lies under a canonical allowed root:
    - `std::env::temp_dir()`;
    - a crate's `tests/fixtures`;
    - the cargo target directory root. Derive it from `std::env::current_exe()`: a test binary lives in
      `target/<profile>/deps`, while the spawned CLI binary lives in `target/<profile>`.
  - Canonicalize both sides, which handles `\\?\` on Windows and `/var`→`/private/var` on macOS.
  - A bare guarded name never searches the ambient PATH.
- **Credentials:** the provider-usage fetchers read `~/.codex/auth.json` and `~/.claude/.credentials.json`. Under
  the feature, they refuse any credential path outside the allowed roots.
- **Failure:**
  - The default mode writes one line straight to `std::io::stderr()` (not `eprintln!`), then calls
    `std::process::abort()`. The line is `hermetic-test-guard: refused <name> at <path> (thread <thread name>)`.
    - libtest's output capture is inherited by tokio workers, and `abort()` discards the capture buffer. With
      `eprintln!` only "signal: 6" would remain.
    - Tokio swallows panics in background probe tasks, so a panic could pass silently; abort cannot.
    - Re-running with `--test-threads=1` shows which test was running.
    - Abort skips `Drop`, so `kill_on_drop` fixture children and temp dirs from that run leak. That is acceptable for
      a guard that should never fire after rollout; report mode avoids it while enumerating.
  - `BIBCODE_HERMETIC_GUARD=report` refuses the program (treats it as not installed) and logs the same line. It is
    for the one-off enumeration during rollout.
  - Any other value aborts with a message naming the bad value. There is deliberately no `off`.
- **Release safety:**
  - No `compile_error!`: it would break the macOS example step, `cargo test --release` and `llvm-cov --release`.
  - Instead, a manifest contract test (`scripts/hermetic-guard-contract.test.ts`, beside `privacy-contract.test.ts`)
    asserts that `hermetic-test-guard` appears only in `[dev-dependencies]` entries, never in `[dependencies]` or
    in any `default` feature list.
- **CI:**
  - The SSH integration step (ci.yml:126) builds the CLI with `cargo build -p bibcode-server --bin bibcode`. With
    the feature, that would recompile the server crate and replace the guarded `target/debug/bibcode` with an
    unguarded one, which `ssh_environment --ignored` then runs.
  - Replace it with `cargo test -p bibcode-server --test cli_smoke --no-run -j 2`, which reuses the guarded build.
  - Update `scripts/ci-platform-contract.test.ts` (around line 115) and the runbooks that describe that step.
  - Commit `Cargo.lock` if it changes; some workflows use `--locked`.
- **Trade-offs:**
  - Pro: catches every future regression automatically, in local runs and in CI.
  - Con: global and process-wide, and a violation aborts the whole test binary.
  - Con: a local edit, test, run loop compiles the server crate twice, once with the feature and once without.

### B. A `ServerConfig`-level provider-host policy
Inject a policy object (real host vs sandbox) through `ServerConfig`, and have tests pass a sandbox policy.
- Pro: no globals.
- Con: still opt-in, so a forgotten test regresses silently.
- Con: a larger refactor across constructors.
- Con: misses callers with no config (`SourceControlDiscovery::default()`, the usage fetchers).

### C. CI-only enforcement (strace or seccomp and fake PATH in CI)
- Pro: no product code at all.
- Con: does not protect local runs, which is where the credentials are.
- Con: adds CI complexity.
- Con: sees only executions, not resolutions.

### D. A `#[cfg(test)]`-only guard
Covers only the library's own unit tests (30 of 86 hits). It misses integration tests and the spawned CLI binary.

## Recommendation and rollout
A.
1. Finish Layer 1 wave 2: `control.rs`, `lifecycle.rs` and the desktop harnesses. Add the strace audit of the
   desktop integration binaries.
2. Implement the guard. Run every suite (server lib, all integration binaries, desktop lib and integration) with
   `BIBCODE_HERMETIC_GUARD=report`, and collect the violations from stderr.
3. Fix each violation by adopting the hermetic helper.
4. Make abort the default, and add the manifest contract test and the CI step change.

## Affected files
- `apps/server/Cargo.toml` (the feature and the self dev-dependency).
- `apps/desktop/src-tauri/Cargo.toml` (dev-dependency).
- `Cargo.lock`, if it changes.
- A new `apps/server/src/hermetic_guard.rs`, compiled only under the feature.
- The four resolution points and the two usage fetchers.
- `.github/workflows/ci.yml` (the SSH step) and `scripts/ci-platform-contract.test.ts`.
- A new `scripts/hermetic-guard-contract.test.ts`.
- `docs/testing/README.md` (the rule, the guard, report mode, the leak note), plus the runbooks that describe the
  SSH CI step.

## Tests
- Under the feature:
  - a guarded bare name aborts;
  - in report mode it is refused and logged;
  - an unknown mode value aborts naming it;
  - an existing guarded path under `temp_dir()` passes;
  - an existing real-looking path such as `/usr/bin/gh` is refused;
  - a missing path falls through to "not found";
  - unguarded names (`git`) pass;
  - on Windows, `gh.exe` and `codex.cmd` are matched.

  The abort path is tested by re-executing the test binary as a child and asserting its abort status and its raw
  stderr line, as the existing re-exec tests do.
- The manifest contract test.
- The full suites stay green in abort mode after rollout.

## Risks
- **A new test aborts the whole binary.** Mitigation: the raw stderr line names the program, path and thread, and
  report mode lists everything.
- **CI would otherwise build the feature-off configuration only in release builds.** Check-mode builds of all
  targets see only the feature-on configuration. Add a cheap CI step, `cargo check -p bibcode-server --lib --bins`
  (no dev units, so the feature is off), and list it in the affected CI files.
- **Local builds compile the server twice** (with and without the feature). That is accepted.
