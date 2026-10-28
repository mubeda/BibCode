# Terminal preparation budget: one owner per provider (#200)

Branch `claude/b3f-terminal-budget` (from `claude/b3-agent-status` + `claude/issue-batch-after-v0.12.0`).
Plan only; nothing below is implemented yet.

## Acceptance (issue #200)

1. One coherent budget per provider: the manager cap never undercuts a provider's own budget, with a measured
   justification.
2. A test through manager -> supervisor -> Claude preparation shows a preparation longer than 500 ms but within
   its budget is observed.

## What happens today

`terminal.open` waits for `TerminalLaunchPreparer::prepare` under a budget the manager asks the preparer for
(`apps/server/src/terminal/manager.rs`, `preparation_execution_budget` call ~2113-2140; default
`OBSERVER_CALLBACK_TIMEOUT` = 500 ms at :43; hard ceiling `MAX_PREPARATION_EXECUTION_BUDGET` = 1 s at :44).

`ProviderTerminalActivitySupervisor::preparation_execution_budget` (`provider_terminal/supervisor.rs` ~1124-1150)
hard-codes the answer: 1 s for a validated OpenCode instance, 500 ms for every other driver.

| Provider | Own budget (inner `timeout`)               | Budget the manager gives | Effect                                         |
| -------- | ------------------------------------------ | ------------------------ | ---------------------------------------------- |
| Codex    | `CODEX_PREPARATION_BUDGET` 350 ms          | 500 ms                   | coherent (150 ms slack)                        |
| OpenCode | `OPENCODE_PREPARATION_BUDGET` 850 ms       | 1 s                      | coherent (150 ms slack)                        |
| Claude   | `CLAUDE_PREPARATION_BUDGET` 3 250 ms       | **500 ms**               | **cut short; the 1 s ceiling would cut it too** |

Root cause: the outer budget is a second hand-maintained table in the supervisor, keyed on `driver_kind ==
"opencode"`. Claude's own 3.25 s never reaches the manager, so a Claude preparation that needs more than 500 ms
is cancelled (`PreparationRejected`) and the terminal runs unobserved: no Activity, no agent status (#187).

## Measured justification (this Mac, 12 cores, Claude 2.1.312 binary, 276 MB)

Claude's preparation is: pin (`clonefile`), `--version` + `--help` probe (parallel, runner timeout 2 s), and the
attestation (SHA-256 of the binary + `codesign -dvvv`, 500 ms timeout), joined in parallel; then bind a loopback
listener and write the settings overlay.

| Stage                                    | Idle     | 2x CPU-oversubscribed (15 runs) |
| ---------------------------------------- | -------- | ------------------------------- |
| `clonefile` pin                          | 5 ms     |                                 |
| `--version` / `--help` (cold first run)  | 12 / 127 ms |                              |
| `codesign -dvvv`                         | 22-32 ms |                                 |
| SHA-256 of the binary                    | 155 ms   |                                 |
| Parallel join of the three               | ~0.2 s   | median 252 ms, max 356 ms       |

So a healthy preparation takes 0.2-0.4 s even under load, and the first launch after install or reboot adds only
page-in of the 276 MB image. 500 ms is therefore too tight (0.36 s measured max plus thread admission and the
budget callback), but 3.25 s is far more than a healthy launch needs. The slow cases are not slow machines but a
hung probe, which the runner kills at its own 2 s timeout. (Note: Claude 2.1.312 is not the approved 2.1.220
build, so on this machine preparation fails fast with a pass-through and never reaches either budget; the numbers
above are the cost the approved build pays.)

## Decision

**Rule: a provider factory owns its preparation budget; the manager waits for it plus a fixed 150 ms outer slack
(so the provider's own timeout always fires first and cleans up), and its ceiling is a safety net that is
asserted to be at or above every provider's outer budget.**

- Add `fn preparation_budget(&self) -> Duration` to `ProviderTerminalObserverFactory` (default 350 ms, Codex's).
  Each factory returns its own `*_PREPARATION_BUDGET` constant. Constants stay where they are.
- `ProviderTerminalActivitySupervisor::preparation_execution_budget` drops the `"opencode"` special case: for any
  validated instance (enabled, driver matches, executable validated, factory present - the existing OpenCode
  gate) it returns `factory.preparation_budget() + 150 ms`; otherwise the 500 ms default. Codex stays 350 + 150 =
  500 ms and OpenCode 850 + 150 = 1 s, so neither changes. **Codex's budget is not raised** (#192 decided to
  change budgets only on evidence).
- **Claude, two options (your call):**
  - **A. Honour the existing 3 250 ms** (the minimal fix as the issue is written): outer 3.4 s, manager ceiling
    raised to 4 s. A hung probe makes `terminal.open` wait up to 3.4 s.
  - **B. Lower it to 2 250 ms** (recommended, keeps the failure wait short): outer 2.4 s, ceiling 3 s. 2 250 ms is
    structural, not a guess: the slowest step the preparation can take is the probe runner's own 2 s timeout (the
    attestation's `codesign` is capped at 500 ms and runs in parallel), plus 250 ms for pin, overlay write and
    listener bind. Measured work is 0.2-0.4 s, so ~6x headroom. Caveat: the test that proves the approved
    2.1.220 build fits (`installed_v21220_probe_and_per_launch_attestation_fit_preparation_budget`) needs a
    2.1.220 fixture via `BIBCODE_CLAUDE_ATTESTATION_FIXTURE`; only 2.1.309-312 are installed here, so B's
    headroom is verified for the stage costs above on 2.1.312, not on the approved build. #192 changed budgets
    only on evidence; A is the choice if you want that stance applied strictly.
- The ceiling `MAX_PREPARATION_EXECUTION_BUDGET` rises from 1 s to 4 s under A, 3 s under B: always at or above
  the largest provider outer budget, never a clamp on a provider (still a hard stop for a preparer that returns
  nonsense). It becomes `pub(crate)` so a test can assert every factory fits under it.
- **`NATIVE_COMMAND_TIMEOUT` is decoupled** from that ceiling. It is currently an alias of it
  (`manager.rs:47`), so raising the ceiling would silently raise the native-command callback, which runs before
  preparation in `open()`, from 1 s to 3-4 s. It becomes its own `Duration::from_secs(1)` (the OpenCode 900 ms
  cold-probe comment stays), so the pre-spawn worst case is native command (1 s, OpenCode only) + budget query
  (500 ms cap, milliseconds in practice) + the provider's outer budget.
- The manager's 500 ms `OBSERVER_CALLBACK_TIMEOUT` stays for isolated setup callbacks, admission and the budget
  query itself (milliseconds of work); it is no longer the preparation budget for any provider.

### How long `terminal.open` may block before PTY spawn

- Fast failures (unapproved or unsupported Claude build, bad capabilities, executable mismatch) return
  `PassThrough` or `None` in ~0.15-0.4 s; they never wait for the budget.
- Only a preparation that is still running pays the budget: Claude at most **2.4 s (B) / 3.4 s (A)**, Codex 0.5 s, OpenCode 1 s,
  then the original command spawns unobserved (the existing `PreparationRejected` path, with the manager's
  existing `callback timed out` warning carrying `timeout_ms`).
- Attaching late or an early soft pass-through is not offered for Claude: the observer changes the command itself
  (pinned executable and `--settings` overlay), so it cannot be added after the PTY spawns. Shortening the wait
  is done by lowering the budget to the measured need, above.

## Change

Files:

- `apps/server/src/provider_terminal/supervisor.rs`: trait method, supervisor budget lookup (~240-265, ~1124-1150).
- `apps/server/src/provider_terminal/{claude,codex,opencode}.rs`: `preparation_budget` impls; Claude constant to
  2 250 ms under B.
- `apps/server/src/terminal/manager.rs`: ceiling 1 s -> 3 s (B) / 4 s (A), `pub(crate)`; decouple
  `NATIVE_COMMAND_TIMEOUT`; comment on `OBSERVER_CALLBACK_TIMEOUT` (~43-47, ~2113-2140).
- `apps/server/tests/provider_terminal_supervisor.rs`.
- Docs: `docs/architecture/activity-observation.md` (budget paragraph ~601),
  `docs/testing/cross-platform-validation.md` (observer-budget rule ~3250).

## Tests (complete caller)

In `apps/server/tests/provider_terminal_supervisor.rs`, using the existing Claude fixtures
(`claude_pinning_fixture_supervisor`, `ClaudeProbeFixtureRunner`, `CopyClaudeExecutablePinner`):

1. **Acceptance:** manager -> supervisor -> `ClaudeTerminalObserverFactory` with a probe runner that delays 700
   ms (above the 500 ms default, below Claude's budget). `terminal.open` spawns the pinned executable with the
   `--settings` overlay and installs the observer (observed); it fails on today's code with an unobserved spawn.
2. **Failure wait is bounded:** same path, probe that never finishes: `open` returns after about the outer
   budget (2.4 s under B, 3.4 s under A; below the ceiling), spawns the original command, observer cancelled.
3. **Budget table:** `hardening_only_validated_opencode_preparation_receives_the_1s_budget` installs one
   `DelayedProviderFactory` as codex, claude and opencode, so with a factory-owned budget it could only yield one
   value. Give that fixture a configurable `preparation_budget` (or install three instances: 350 ms, the Claude
   figure, 850 ms) so the table (Codex 500 ms, Claude 2.4 s / 3.4 s validated, OpenCode 1 s, 500 ms for every
   unvalidated combination) exercises the real lookup, and the existing 612 ms OpenCode completion still holds.
4. **Never undercut:** a unit test over all three factories asserting `preparation_budget() + slack <=
   MAX_PREPARATION_EXECUTION_BUDGET`.
5. Update `hardening_preparation_execution_budget_defaults_to_500ms_and_clamps_at_1s` to the new ceiling
   (name and bounds; its oversize case takes as long as the ceiling), still proving a preparer that asks for more is clamped.

Validation commands (pinned toolchain, own `target/`, `CARGO_BUILD_JOBS=3`): the focused `cargo test -p
bibcode-server --test provider_terminal_supervisor <names>`, `cargo test -p bibcode-server --lib
provider_terminal`, `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`,
`vp check` on the changed docs. No Codex process is run.

## Docs

- `activity-observation.md`: replace "the preparation budget (350 ms) and the manager's callback cap (500 ms) are
  unchanged" with the rule above, the per-provider table and the measurement; keep "budgets change only on
  evidence from the stage logs".
- `cross-platform-validation.md`: observer-budget rule says the factory owns the budget and the manager adds a
  fixed slack, with the stage log as the evidence for any change.
- Testing runbooks otherwise reviewed and expected to remain accurate (no command or procedure changes).

## Profiler coverage

None touched: no new process, RPC method, worktree removal, binary mode, shutdown service, event or finding. The
existing `callback timed out` warning and the Codex/Claude stage logs are unchanged.

## Skipped

No change to the preparation-time inner timeouts of Codex (350 ms) or OpenCode (850 ms); no late attach or
soft-timeout pass-through; no change to admission gating (b6a's area), the probe runner's 2 s timeout, or the
approved-build attestation (Claude 2.1.312 passing through unobserved is a separate matter).

## Merge note and tooling

The merge of `claude/issue-batch-after-v0.12.0` conflicted in `provider_terminal/codex.rs` and
`tests/provider_terminal_supervisor.rs`. Resolved by keeping the agent-status structure (scope publication moved
into `publish_codex_root_scope`) and re-adding the integration branch's `live_publication_rejected` warning at the
call site (`observer_started` and `generation` are already in scope there), and by keeping both sides of the
appended tests. It is committed as its own merge commit after the test crate compiled.

CodeGraph: `codegraph sync .` ran; its graph was not needed for this change (single-crate, files read directly).
