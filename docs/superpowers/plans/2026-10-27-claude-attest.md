# Plan: AI Terminal Claude attestation behind a shim, and Linux (#203)

Design: [2026-10-27-claude-attest-design.md](../specs/2026-10-27-claude-attest-design.md).
Branch `claude/b3d-claude-attest` from `claude/issue-batch-after-v0.12.0` (046c7cfcac).

## Acceptance criteria

- **A1** (issue): on macOS, a Claude AI Terminal launched through a mise shim
  gets hooks, with the same attestation guarantees as a direct install. Proof:
  integration test 1, plus the live Linux lab run, because this Mac has no mise.
- **A1'** (implied by A1, which compares to a direct install): a direct install
  of any Anthropic-signed build at or above 2.1.220 is hooked on macOS. Today
  only 2.1.220 is. Proof: integration test 4, and the ignored live test against
  the installed 2.1.312.
- **A2** (issue): the Linux and Windows positions are decided and documented.
  Linux is supported, through a copy-pin and no publisher check (tested).
  Windows is explicitly unsupported (documented). Proof: the Linux unit tests,
  the Linux lab scenario, and the docs diff.

## Root cause (evidence)

- Only one build is approved: `claude.rs` 99-112, 226-228 and 1677-1690.
- The pin follows symlinks: `claude.rs` 741-755 (`clonefile`), which a shim
  reaches through 545 and 553.
- There is no Linux pin: `claude.rs` 757-763 returns `Unsupported`.
- A latent bug: `parse_claude_version` (1832) accepts mise's `2026.10.19`.

## Changes (in commit order, TDD where a seam exists)

1. **Version marker.** `parse_claude_version` requires the `(Claude Code)`
   marker. First a failing unit test with the mise string.
2. **Floor and identity attestation.** Replace `APPROVED_ADDITIVE_HOOK_*` with
   `MIN_ADDITIVE_HOOK_VERSION = 2.1.220` and an optional ceiling. On macOS, add
   the `codesign --verify --strict -R=<requirement>` check (cap 1.25 s), run once
   per source fingerprint. The cache value gains `sha256` and
   `signature_verified`. Per launch, hash the pinned copy and compare. Update the
   existing attestation unit tests and generalize the ignored live test to the
   installed build.
3. **Linux copy-pin.** `clone_executable` on non-macOS unix copies with
   `create_new`, 0600, `io::copy`, a fingerprint sandwich and `fsync`, then
   0500. The unit test asserts that `private_pinned_executable` accepts the
   result. The attestor's Linux branch has no publisher check.
4. **Shim resolver.** Add the `ClaudeInstallResolver` trait with a
   `MiseInstallResolver` (detection, `which` and `env --json` through
   `run_supervised` with the launch env and cwd, and strict parsers). Add a
   `ClaudeTerminalObserverFactory::with_resolver` test seam. `prepare_unix` pins
   the resolved candidate.
5. **Env overlay.** Add `PreparedTerminalLaunch::env_overlay`
   (`provider_terminal/model.rs`). `terminal/manager.rs` applies it over the
   client env before `private_env`, and never redacts it. Codex and OpenCode
   pass an empty map.
6. **Integration tests** in `apps/server/tests/provider_terminal_supervisor.rs`:
   flip the shim test (1), resolver failures (2), attestation failure (3), the
   direct 2.1.312 install (4), and the fingerprint-restored rewrite (5).
7. **Docs**: `docs/providers/claude.md`, `docs/architecture/activity-observation.md`
   (matrix and budgets), `docs/user/workspace-ui.md`,
   `docs/testing/ssh-environments.md` row 10, and the native validation runbook
   under `docs/testing/` (the P2 re-proof step and the Linux shim scenario).

## Files touched

- `apps/server/src/provider_terminal/claude.rs`. This batch owns it; #196
  already merged into the base.
- `apps/server/src/provider_terminal/model.rs` and `apps/server/src/terminal/manager.rs`:
  the one new field and its merge (about 10 lines). **These are outside a
  Claude-only scope. The integrator needs to confirm no other batch agent owns
  them.**
- `apps/server/src/provider_terminal/codex.rs` and `opencode.rs`: one
  `env_overlay: BTreeMap::new()` line each.
- `apps/server/tests/provider_terminal_supervisor.rs`.
- The docs listed above.

## Validation

- `cargo fmt --all --check`
- `cargo test -p bibcode-server --lib provider_terminal::claude`
- `cargo test -p bibcode-server --test provider_terminal_supervisor claude`
- `cargo test -p bibcode-server --lib terminal::manager`
- `cargo clippy -p bibcode-server --all-targets -- -D warnings`
- The ignored live test against the installed macOS build
  (`--ignored installed_`).
- `vp check --no-fmt`, `vp check <changed docs>`, `vp run typecheck`, and
  `vp test run scripts/bibcode-identity.test.ts`.
- Linux: run the unit and integration tests in the bibcode-linux-lab container,
  then the live mise scenario there, or hand it to the `validate-linux` agent.
  Record the cold copy time.

Not run: Windows (unchanged, and documented as unsupported). There are no
React or UI changes, so `vercel-react-best-practices` does not apply. Only the
`UI.md` copy review applies, to the "Status unavailable" wording in
`workspace-ui.md`.

## Skipped (ponytail)

These are not built: asdf/volta/proto resolvers (the trait allows them), an
offline signed-manifest cache for Linux, the cross-check of the shim's own
`--version`, Windows Authenticode, and a shared pin per build across terminals.
