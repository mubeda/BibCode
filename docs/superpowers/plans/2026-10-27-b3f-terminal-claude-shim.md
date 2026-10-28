# Plan: AI Terminal Claude behind a multi-call shim (#196)

Batch `b3f-terminal-claude-shim`, branch `claude/b3f-terminal-claude-shim`. Phase 1; nothing is implemented.
The branch is `claude/b3-agent-status` plus the #195 commits (merged from the `claude/b3-probe` tip,
`cda49387b1`, because merging the whole integration branch conflicts in `provider_terminal/codex.rs` and
`tests/provider_terminal_supervisor.rs`, which this batch does not own).

## Finding: this is not a mirror of #195

The terminal path does not launch the resolved path. It launches a private copy-on-write clone of it, and a
second gate then admits only one exact Claude build. The wrong-program probe in #196 exists but cannot cause
what the issue describes.

Evidence (`apps/server/src/provider_terminal/claude.rs`):

- `prepare_unix` (about 515-560) first pins: `pinner.pin(launch.executable, <generation dir>/claude)`.
  The terminal then runs the pinned clone (`PreparedTerminalLaunch.executable`, about 630), never the shim.
- macOS pin is `clonefile(2)` (`clone_executable`, about 745). Checked on this machine: `clonefile` of a
  symlink produces a regular file holding the target's bytes, so a mise shim pins as a copy of `mise`.
- Linux (and any non-macOS Unix) pin returns `Unsupported` (about 757). `prepare_unix` returns `None` before the
  probe runs. Windows returns `None` in `prepare_inner`. So the probe path is **unreachable on Linux and
  Windows**: Omarchy's mise shim never reaches `CachedClaudeCapabilityProbe` from terminal mode. Its terminal
  always runs the original command and its status reads **Status unavailable** (already documented at
  `docs/providers/claude.md` about 639-641, but without naming the platform cause).
- On macOS the hooks need `capabilities.additive_hook_merge` (about 551-555). That is true only when the probed
  version equals `2.1.220` and the pinned file's length, SHA-256 and codesign identity match the single approved
  build (`approved_additive_hook_build`, about 1668). A mise clone, a script shim, or any other Claude build
  fails closed, with or without a correct probe.
- `probe`/`probe_pinned` canonicalize the source (about 193, 211), and that canonical file is exactly the one
  `clonefile` copies. For a symlinked shim the probe therefore describes what is pinned (mise). It does not
  poison anything the terminal launches: the cache entry is keyed by the target's fingerprint, and no terminal
  launches that file as Claude. A mise answer cannot grant hooks: `mise --version` parses as `2026.10.19`,
  which satisfies the `>= 2.1.63` check, but `additive_hook_merge` also needs `== 2.1.220` and the attested
  hash.

So the observable outcome behind a shim is already "no hooks, status unavailable, original command runs". Probing
the shim path under its link name (the #195 change) would change no launch, because the pinned object would
still be `mise`. Making hooks work behind a shim means pinning and attesting the real install the shim hands off
to, which is a new capability and an architectural decision (attestation trust) that AGENTS.md says needs an
approved design before implementation.

## Acceptance mapped to this finding

1. "Probes what the terminal launches, with launch env and cwd": the terminal launches the pinned clone of the
   canonical target, and that is what is probed today. Launch env and cwd cannot change a clone's answer for a
   single-purpose Claude binary. I do not plan to thread them through.
2. "Regression test with a symlinked multi-call fixture": planned, see below.
3. "If unreachable on a platform, the docs say so": planned, Linux and Windows, plus the macOS shim result.

## Proposed change (option A, recommended, small)

Files: `apps/server/src/provider_terminal/claude.rs` (capability probe paths and their tests only, not the status
hook code) and `docs/providers/claude.md` (the "Provider-terminal observation" paragraph, about 614-641).

1. **Tests (no behavior change).** In the existing `tests` module, with `PosixShellFixture`-style fixtures:
   - a symlinked multi-call fixture (`real/mise.sh` branching on `${0##*/}`, link `bin/claude.sh`): the factory's
     `prepare` over a link with a fake `ClaudeExecutablePinner` (the existing injectable seam) returns `None`
     (pass-through) and never reports hooks, whatever the target answers;
   - the same fixture answering as Claude under its real name proves `probe` keeps one cache entry per
     canonical file and does not cross-contaminate with an unrelated link of another name.
   Both are `#[cfg(unix)]` through the module gate (`#[cfg(all(test, unix))]`), so no Windows dead-code risk.
2. **Docs.** State plainly: native pinning exists on macOS only; on Linux and Windows a Claude Terminal is never
   prepared, so status is unavailable and activity is off; behind a shim (any renamed link whose target is not a
   Claude build) the terminal runs the original command without hooks. Name the single approved build.
3. **Small hardening, optional, your call:** do not cache a probe whose `--version` has no recognizable Claude
   shape and make `probe` log nothing new. Skipped unless you want it, because the gate makes it unobservable.

Skipped (ponytail): the launch environment/cwd threading, `PATH` prefix handling, #195's recheck/Mismatch
logging, and a production fix. They have no effect on a clone that is attested by hash.

## Option B (not planned without approval)

Make hooks work behind a shim: resolve the real install a shim hands off to (for mise, `mise which claude` under
the launch environment, or the shim's target directory), pin and attest that file, and widen the approved-build
set beyond one exact 2.1.220 binary. This needs a design document for the trust model (what "attested" means for
a version the project cannot hash in advance) and likely a separate issue. It is the only change that would make
the issue's symptom (Claude Terminal without status behind a shim) go away.

## Validation (if A is approved)

`cargo test -p bibcode-server --lib provider_terminal::claude`, `cargo fmt --all --check`,
`cargo clippy -p bibcode-server --all-targets -- -D warnings`, `vp test run scripts/bibcode-identity.test.ts`.

## Profiler coverage

None applies (tests and docs only; no process, RPC, event or shutdown change).
