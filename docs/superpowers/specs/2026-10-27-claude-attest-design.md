# AI Terminal Claude: attest the real install, widen the approved builds, Linux pinning (#203)

Status: proposed, awaiting approval. Parent: #196 (merged as `ac0bda0a57`).

## Problem

A Claude AI Terminal reports status and activity only when BiBCode can inject
its authenticated HTTP hooks with `--settings <overlay>`. Preparation
(`apps/server/src/provider_terminal/claude.rs`, `prepare_unix`, ~519) clones the
configured executable into a private generation directory, probes it, and hooks
it only if `probe_pinned` (~214) proves `additive_hook_merge`. Today that proof
is satisfied by exactly one binary:

- `approved_additive_hook_build` (~1677) requires version `2.1.220`, length
  `256_908_272`, one SHA-256 and one codesign CDHash (`APPROVED_ADDITIVE_HOOK_*`,
  ~99-112). Native installs auto-update in the background, so almost nobody runs
  that build. This machine runs `2.1.312`; a direct install gets no hooks
  today either. The acceptance criterion "the same guarantees as a direct
  install" is therefore empty until the approved set is widened. **Widening is
  the centre of this issue, not an extra.**
- `clone_executable` (~741) is `clonefile(2)`, which follows symlinks. Behind a
  mise shim (`~/.local/share/mise/shims/claude` -> `mise`) it pins `mise`, which
  never attests. The terminal runs the shim unobserved (#196 test
  `claude_terminal_behind_a_multi_call_shim_runs_unobserved_on_the_original_command`).
- On every other unix, `clone_executable` returns `Unsupported` (~757), so Linux
  never prepares a Claude Terminal. The user's remote server is Linux (Omarchy)
  with Claude installed through mise, so Linux is the case that matters most.
- Windows has no provider-terminal preparation at all (`prepare_inner`, ~504,
  is `cfg(unix)`).

Found while reading: `parse_claude_version` (~1832) takes the first dotted
triple anywhere in the output. mise answers `--version` with
`2026.10.19 macos-arm64 (2026-10-19)`, which parses as `2026.10.19` and passes
`MIN_PROVEN_HTTP_HOOK_VERSION`. The exact-hash gate hid this; a version floor
would not.

## What the pin and the attestation defend (threat model)

This decides every choice below.

| Property | Why hooks need it | Defended today by |
| --- | --- | --- |
| **P1 Identity.** The hooked program is Claude Code. | `--settings` and a hook token are only meaningful to Claude; injecting them into another program (mise, a wrapper script) at best breaks its argv. | Exact hash + CDHash. |
| **P2 Additive merge.** The build adds `--settings` hooks to the user's own hooks instead of replacing them. | A build that replaced hooks would silently disable the user's own hooks, for example a `PreToolUse` guard. That is a safety regression, and the user would never see it. | Exact hash of a build whose merge code was inspected (comment ~90-97). |
| **P3 Capabilities.** `--settings`, `--setting-sources`, authenticated HTTP hooks. | The overlay and the hook sink. | `--help` probe and the `2.1.63` floor. |
| **P4 Stability (TOCTOU).** The bytes that were checked are the bytes that run, for the whole session. | A background self-update, an npm in-place upgrade or the native installer's cleanup can replace or delete the file between probe and spawn, or during the session. | Private generation-scoped clone, `private_pinned_executable` (supervisor ~1201: canonical, inside the 0700 runtime dir, owned by us, mode 0500, `nlink == 1`), fingerprint re-reads. |

Out of scope: an attacker who can write the user's files. Such an attacker
already controls `~/.claude/settings.json`, the shell profile, and BiBCode's own
state, so no executable attestation stops them. Authenticity (P1 against a
deliberate forgery) therefore has value, but it is a defence in depth and not
the boundary. The boundary is **never inject hooks into the wrong program, and
never into a build that could drop the user's hooks**.

What Anthropic documents about P2: the hooks reference says hook entries merge
across settings levels rather than replacing each other (user, project, local,
managed). It does not name the `--settings` level in that sentence. So P2 for
`--settings` is **empirically established** (the inspected 2.1.220 merge code,
whose markers `Add to existing hooks, don't replace` and
`Failed to merge hooks from` are still present in 2.1.312) and has to be
re-proven by a live check (see Validation).

## Decisions

### D1. Widen the approved set: version floor plus vendor identity

Replace "one exact build" with:

- the `--version` output carries the `(Claude Code)` marker, and the version
  parsed from that line is at least **2.1.220** (`MIN_ADDITIVE_HOOK_VERSION`, the
  build whose merge was proven). There is **no upper bound**;
- `--help` lists both settings switches (unchanged);
- on macOS, the pinned bytes satisfy Anthropic's code signature (D2);
- on Linux, no publisher check exists (D4).

Alternatives:

| Option | P2 | Cost | Verdict |
| --- | --- | --- | --- |
| Keep one exact build (today) | Strongest | Every auto-update disables hooks until a BiBCode release adds the hash | Rejected: zero coverage in practice |
| Allowlist of hashes, bumped per BiBCode release | Strong | Claude ships near-daily; users are always ahead of the list; per-platform hashes | Rejected: same failure, slower |
| Closed range `[2.1.220, tested max]` | Strong | Breaks every auto-updated user between BiBCode releases | Rejected for the same reason |
| **Open floor + identity** | Relies on Anthropic not regressing documented merge behaviour | Free | **Chosen**, with the live re-proof per release and a one-line ceiling constant (`MAX_ADDITIVE_HOOK_VERSION: Option<..> = None`) to cut off a regressed release without code changes elsewhere |
| Behavioural probe (run the pinned build with a test user hook and the overlay, observe both fire) | Direct proof | Needs a session start, an account, network and seconds per build | Rejected for launch time; kept as the release-time live check |

### D2. macOS: verify the signature once per build, bind every launch by hash

Per build (cached by the source fingerprint, as `--version`/`--help` already are):

```
/usr/bin/codesign --verify --strict \
  -R='anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"' <pinned>
```

plus the SHA-256 of the same pinned bytes. Measured here on the installed
2.1.312 (276 MB): 0.43-0.76 s wall (23 % CPU, mostly trust evaluation). A clone
with **one byte flipped at offset 150 000 000 fails** with "invalid signature",
so the check covers the whole file, including Bun's embedded payload. This
replaces the fixed SHA-256 and the four `-dvvv` lines.

Per launch: SHA-256 of the pinned copy (in process; this is the step that
already runs today), compared to the digest recorded when the build was
verified. A rewrite with a restored mtime changes ctime, so it is a new
fingerprint and a new verification. A rewrite that kept the fingerprint would
still change the digest. Either way it is never reused
(`same_length_rewrite_with_restored_mtime_cannot_reuse_build_approval` keeps its
meaning).

Rejected: running `codesign --verify` on every launch. It is always correct, but
it adds 0.4-0.8 s to every terminal, and the `run_codesign` cap would have to go
from 500 ms to about 1.25 s. The first launch of a new build pays it once. The
500 ms cap rises to 1.25 s for that first verification only, and the "Preparation
budgets" text in `docs/architecture/activity-observation.md` changes with it.

### D3. Resolving the real install behind a shim

Discovery and attestation are separate. A candidate path may come from an
untrusted hint, because hooks are only injected after the pinned bytes pass D1
and D2/D4, whatever path they came from.

1. **Detect a shim.** The configured path is a symlink whose canonical target's
   file name is `mise`. Only mise is supported now (the user's case). The
   resolver is a small trait (`ClaudeInstallResolver`), so asdf or volta could
   be added later without touching preparation.
2. **Ask the shim manager what it would run**, with the launch environment and
   working directory (mise resolves the version per directory, as the chat probe
   learned in #195):
   `<canonical mise> which claude` (the bin name is the configured file name).
   It runs through `run_supervised` (timeout, output cap, reaping), with stdin
   null.
3. **Validate the answer before touching it:** one line, at most 4 KiB, an
   absolute path. It must canonicalize to a regular file that is not a
   directory, not group- or world-writable, owned by the effective user or root,
   and whose canonical file name is not `mise`. Anything else means pass-through
   on the shim.
4. Pin and attest the candidate exactly as a direct install (D1, D2/D4).

Rejected alternatives:

- **Guess install layouts from the shim's `--version`** (`~/.local/share/claude/versions/<v>`,
  `mise/installs/claude/<v>/claude`). It depends on `MISE_DATA_DIR`, the backend
  (`aqua:anthropics/claude-code`, `http:claude`, `npm:`) and the user's
  configuration; it is brittle and still needs attestation.
- **Cross-check the shim's own `--version` against the candidate.** It costs a
  second mise + Claude start (~100 ms+) and proves only that mise is
  self-consistent; D1/D2 already prove the candidate is a genuine build at or
  above the floor.
- **Run unpinned through the shim and only attest the target.** It loses P4
  (the shim re-resolves at exec time, and a session survives deletion of a
  version only because it runs a private copy).
- **`mise exec -- <pinned>` as the PTY command.** It keeps mise's environment
  for free, but the spawned executable would be mise and not the pinned copy.
  That breaks the supervisor invariant (`private_pinned_executable`), which is
  the only thing the manager trusts about a prepared Claude launch. Rejected.

**mise's environment.** A shim runs `mise exec`, which applies `[env]` from
`mise.toml` and the tools' `PATH` before exec. Running the pinned real binary
directly would silently drop that, for example a project's
`ANTHROPIC_BASE_URL`, API key or model, so the terminal would talk to a
different endpoint than the one the user configured. That is not acceptable.
Decision: in parallel with `which`, run `<canonical mise> env --json` with the
same environment and directory. The output must be a JSON object of
string-to-string, at most 64 KiB, with POSIX environment names, and must not
contain BiBCode's reserved names. It becomes a new **non-secret** environment
overlay on the prepared launch (`PreparedTerminalLaunch::env_overlay`, applied
over the client environment and before `private_env`). `private_env` cannot
carry it: its values are redacted from terminal output, and a key that collides
with the client's environment fails the open (`terminal/manager.rs` ~2171), and
`PATH` always collides. If `env` fails or is malformed, the launch passes
through on the shim (unobserved but exactly as configured), never "hooked with
the wrong environment".

### D4. Linux: copy-pin, the same fingerprint and hash binding, and no publisher check

**Pin.** Create the destination with `create_new` and mode 0600 in the
generation directory, then `std::io::copy` from the opened canonical source.
On Linux that is `copy_file_range`, which reflinks on btrfs, XFS and bcachefs
(Omarchy's default is btrfs) and copies in the kernel elsewhere. Then
`restrict_pinned_executable` (0500) and `fsync`. The result already satisfies
`private_pinned_executable` (owned by us, `nlink == 1`, 0500, inside the
runtime dir). The source's fingerprint is read before and after the copy from
the open descriptor and the path. If it moved, the pin is discarded.

Cost on a filesystem without reflink: about 256 MB written per live Claude
Terminal, removed with the generation. The plan measures the time in the Linux
lab. If a cold copy does not fit 2.25 s on the lab's disk, the budget table is
revised with that evidence. The probe of the source runs concurrently with the
copy.

Rejected:

- **Hard link.** It is free, but chmod 0500 would change the user's file,
  `nlink == 1` rejects it by design, it fails across filesystems and on a
  root-owned `/usr/bin/claude`, and it does not survive in-place truncation.
- **Keep an `O_PATH` descriptor and exec through `/proc/self/fd/N` (or
  `execveat`/`fexecve`).** The PTY layer would have to inherit a descriptor
  across `portable-pty`, which closes them. It does not survive in-place writes
  either, and it changes `/proc/self/exe` semantics for a Bun single-file binary.
- **`memfd` copy.** About 256 MB of RAM per terminal.
- **Verify against Anthropic's signed `manifest.json`.** Linux binaries are not
  individually signed; the documented integrity path is a GPG-signed per-release
  manifest of SHA-256s. Using it at launch needs network access during
  `terminal.open`, a GPG verifier and a pinned key. Rejected for launch time.
  It is a possible later offline cache keyed by version, noted and not built.
- **Run unpinned with a documented weaker guarantee.** It loses P4 for nothing,
  because the copy is cheap where reflink exists.

**Attestation on Linux:** D1 (marker, floor, help switches) on a build whose
fingerprint and SHA-256 are bound to the pinned copy exactly as on macOS, but
**without a publisher check**. The documented guarantee is weaker and must say
so: on Linux, BiBCode trusts the build's own report that it is Claude Code
2.1.220 or later. A program that lies about it receives a `--settings` path and
a loopback hook token that only accepts status events. Both are worth nothing to
a program that already runs as the user, so P1 against forgery is the only
property lost, and it was out of scope (see threat model).

Linux gets status hooks and Activity with this.

### D5. Windows: explicitly unsupported

There is no pin, the overlay writer and the loopback listener setup are
`cfg(unix)`, and the Authenticode check would need WinVerifyTrust FFI. A Claude
Terminal on Windows keeps **Status unavailable**. This change only documents
that; it is not widened.

## Behaviour after the change

| Install | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Native installer (`~/.local/bin/claude` -> `versions/X`), X >= 2.1.220 | Hooked | Hooked | Unavailable |
| Homebrew cask, apt/dnf/apk, npm (native binary) X >= 2.1.220 | Hooked | Hooked | Unavailable |
| mise shim to a native Claude build >= 2.1.220 | Hooked, with mise's env | Hooked, with mise's env | Unavailable |
| Claude < 2.1.220, unsigned or re-signed macOS build, a non-Claude program, `mise which`/`env` failure | Unavailable, original command | Unavailable, original command | Unavailable |

## Failure, cancellation, concurrency

- Every new step is inside the existing `CLAUDE_PREPARATION_BUDGET` timeout and
  the `ClaudePreparationResources` guard, so a timeout or cancellation removes
  the generation directory (pin, overlay) as today.
- `mise which`/`env` and `codesign` run through `run_supervised`: bounded output,
  timeout, kill and reap. They share the existing probe semaphore
  (`CLAUDE_CAPABILITY_PROBE_CONCURRENCY`) and single-flight gates.
- Cache: the entry key stays the source fingerprint. The value gains
  `sha256` and `signature_verified`. A failure is never cached as success. The
  gate's `failed` flag keeps its current one-shot semantics.
- The resolution is not cached: it depends on the launch's directory and
  environment, and costs two short mise runs.

## Security summary

- Hooks are injected only into pinned bytes that are (macOS) Anthropic-signed,
  or (Linux) self-identified Claude Code, at or above the floor, with the
  settings switches, and whose SHA-256 equals the verified build's.
- Discovery output (mise's) is untrusted. It is bounded, parsed strictly, and
  only ever selects which file to copy. It never selects what runs without
  passing attestation.
- The spawned executable is always the private pin (supervisor invariant
  unchanged). mise's environment is applied as data, not by running mise in the
  PTY.
- No new network, no new listener, no change to the hook token, correlation or
  hook validation.

## Tests

The fixtures exist on the base: `MultiCallClaudeProbeRunner`,
`claude_link_to_target`, `CopyClaudeExecutablePinner` in
`apps/server/tests/provider_terminal_supervisor.rs`. Resolution is injected
through the new trait, so no test runs mise.

Integration (complete caller: `TerminalManager::open` -> supervisor -> factory -> spawn):

1. **Symlinked multi-call fixture, flipped.** `bin/claude` -> `real/mise`. The
   resolver returns `installs/claude/2.1.312/claude` and an env overlay. The
   spawn executable is a private pin whose bytes equal the real install. The
   args include `--settings`. The spawn env carries the overlay (including
   `PATH`). The probe runner never saw `real/mise`.
   This replaces `claude_terminal_behind_a_multi_call_shim_runs_unobserved_on_the_original_command`.
2. Resolver fails, returns a relative, group-writable or `mise` path, or the env
   is malformed: the spawn is the configured shim, unchanged, without
   `--settings`, and the runtime holds only empty retired generations.
3. The candidate resolves but fails attestation (below the floor, or a mise-style
   version string): pass-through on the shim.
4. A direct install at 2.1.312 with a passing attestor is hooked (previously
   unapproved).
5. A rewrite of the source between two launches with the fingerprint restored is
   not hooked on the second launch (digest mismatch).

Unit (`claude.rs`):

- `parse_claude_version` requires the `(Claude Code)` marker. It rejects
  `2026.10.19 macos-arm64 (2026-10-19)` and accepts `2.1.312 (Claude Code)`.
- Floor: 2.1.219 is rejected, 2.1.220 and 2.1.312 are accepted. A configured
  ceiling cuts off above it.
- The macOS requirement string is exact. The ignored live test generalizes from
  "installed 2.1.220" to "the installed native build at or above the floor"
  (attests and fits the budget).
- mise output parsers: the `which` line rules and the `env --json` bounds, key
  syntax and reserved names.
- `cfg(target_os = "linux")`: the copy pinner yields a file accepted by
  `private_pinned_executable`, and a source changed during the copy is
  discarded. A `cfg(unix)` test covers the same copy path where it is generic,
  so macOS CI exercises it too.

Live validation (cannot run on this Mac, which has no mise):

- The Linux lab (`docs/testing`, the bibcode-linux-lab container) with mise and
  `aqua:anthropics/claude-code`. Open a Claude Terminal through the shim: the
  Agents row follows Working -> Done, and a `[env]` variable from `mise.toml` is
  visible inside Claude's Bash tool. Record the cold copy time on the lab disk.
- **P2 re-proof per release** (runbook step): in an isolated `CLAUDE_CONFIG_DIR`
  with a user `SessionStart` command hook that writes a marker file, open a Claude
  Terminal. Both the marker and BiBCode's status appear.

## Documentation

- `docs/providers/claude.md`: rewrite the #196 block (pinning per platform, the
  floor, the identity checks, shim resolution, mise env, the Linux guarantee).
- `docs/architecture/activity-observation.md`: the provider-matrix row, and
  "Preparation budgets" (the codesign cap, stages, the Linux copy measurement).
- `docs/user/workspace-ui.md`: which AI Terminals report a status.
- `docs/testing/ssh-environments.md` row 10, and the native validation runbook
  for the P2 re-proof and the Linux shim scenario.

## Profiler coverage

New child processes (`mise which`, `mise env`, `codesign --verify`) run through
`run_supervised`, as the existing probes do. No RPC methods, removal paths,
binaries or shutdown services are added. A preparation that passes through logs
one bounded reason (`shim_unresolved`, `shim_env_rejected`, `build_unattested`)
with `tracing::debug!` in `claude.rs`, warned once per reason like the
supervisor's `warn_once`. Paths and environment values are never logged.
