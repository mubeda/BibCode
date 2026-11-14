# CI build times, symbol dump error and Windows arm64 flake

Status: Approved 2026-11-14 (approved under the user's standing pre-approval of 2026-10-30)
Spec: spec.md (Status line: Approved 2026-11-14, sha256 be1cd41eb716)
Repository: this repository
Base: main

## Goal

- Windows native rows no longer compile the server for tests, and CI bundle builds compile the two workspace crates on several cores.
- A `dump_syms` error is either proven harmless or fails the dump.
- One `ci:full` run records where macOS bundle time and memory go, and the next #367 failure prints the terminal output.

## Global constraints

- Release keeps the shipped profile: `release.yml` never passes `--workspace-codegen-units` (spec D2, R3).
- The override is a per-package Cargo `--config`, never a `CARGO_PROFILE_RELEASE_*` variable, so dependency fingerprints stay the ones Release restores (spec D2).
- `server_tests_windows`: `timeout-minutes: 90`, `shared-key: native-desktop`, `save-if: "false"`, no `-j 2` (spec R2).
- Codegen units accepted: whole numbers 1 to 256; CI passes 16 (spec R3).
- Heartbeat interval 60 seconds; it never fails the step (spec R4).
- `cache-save: ${{ github.ref == 'refs/heads/main' }}` on every `setup-vp` step with `cache: true` (spec R5).
- Load test: 30 runs, four busy processes, count fixed in advance (spec R7).
- The repository is public: no hosts, names or machine paths in any file, commit or pull request text (AGENTS.md, Sensitive Data).

## Review focus

1. A `dump_syms` error must be attributed to an input before it is called harmless: pinned by Task 1.1's binary-only rerun cases, including the count mismatch.
2. The override reaching `release.yml` by a shared YAML alias: pinned by Task 3.2's contract case.
3. The new Windows job skipping tests silently when a filter matches nothing: the `counted` helper moves with the host metrics step, pinned by Task 3.1.
4. The heartbeat's background loop outliving a failed build, or hiding its exit code: pinned by Task 3.2's failed-child probe.
5. The shim helper losing its exit code check when the wait loop moves: pinned by Task 4.1, which moves only the loop.

## Out of scope

- Splitting `bibcode-server` into several crates: a design of its own.
- Changing the shipped release profile: needs a runtime measurement and the user's decision.
- Raising the Actions cache limit: the user's account setting.
- sccache, third-party runners and cache backends: no measurement supports them here.
- A larger timeout or serial runs for the #367 tests without evidence.

## Sources

- Repository rules: `AGENTS.md` (delivery discipline, sensitive data, testing runbook maintenance, completion requirements).
- Repository docs: `docs/operations/ci.md` (job descriptions and budgets this plan changes), `docs/operations/release.md` (symbol assets), `docs/testing/` (Windows runbook), `docs/skills/issue-delivery/SKILL.md` (checkpoint before a CI dispatch).
- Evidence: `research/measured_ci_and_local.md` (CI logs and local builds of 2026-11-14).
- External: `research/report.md` and the four notes beside it (GitHub cache limits, rust-cache behaviour, LTO and dSYM cost, CI speedups).

## Stack and commands

- Scripts and workflow contracts (TypeScript, Vitest through Vite+): `vp test run scripts/<file>`; whole folder `vp test run scripts`.
- Lint, format, types: `vp check`, `vp run typecheck`, `vp run check:markdown-links`.
- Rust: `cargo fmt --all --check`; Windows-only test target compiled and run in the Windows VM with `node scripts/run-msvc.mjs cargo test -p bibcode-server --test windows_terminal_shims`.
- Ran once on 2026-11-14: `vp run --filter @bibcode/web build` (26 s) and three release builds of `bibcode-desktop`.

## Phases

| Phase | File                                           | Goal                                                                     | Round | Depends on | Tier     |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------ | ----- | ---------- | -------- |
| 1     | phases/PHASE-01-symbol-dump-verification.md    | A logged `dump_syms` error is verified or fails                          | 1     | none       | standard |
| 2     | phases/PHASE-02-bundle-codegen-override.md     | The bundle script can build the workspace crates with more codegen units | 1     | none       | standard |
| 3     | phases/PHASE-03-ci-workflow.md                 | CI uses the new job, the override, the heartbeat and the cache-save rule | 2     | 2          | standard |
| 4     | phases/PHASE-04-shim-timeout-evidence.md       | A shim timeout prints its evidence and a load test records a rate        | 1     | none       | standard |
| 5     | phases/PHASE-05-docs-gates-and-pull-request.md | Docs match, gates pass, the pull request carries measured CI numbers     | 3     | 1, 2, 3, 4 | standard |

Phases in the same round run in parallel. A phase depends only on phases in earlier rounds.

## File map

| Path or external change                                           | Action   | Phase | Verification                                         |
| ----------------------------------------------------------------- | -------- | ----- | ---------------------------------------------------- |
| `scripts/dump-symbols.ts`                                         | modify   | 1     | `vp test run scripts/dump-symbols.test.ts`           |
| `scripts/dump-symbols.test.ts`                                    | modify   | 1     | same                                                 |
| `scripts/build-desktop-artifact.ts`                               | modify   | 2     | `vp test run scripts/build-desktop-artifact.test.ts` |
| `scripts/build-desktop-artifact.test.ts`                          | modify   | 2     | same                                                 |
| `.github/workflows/ci.yml`                                        | modify   | 3     | `vp test run scripts/ci-platform-contract.test.ts`   |
| `.github/workflows/*.yml` other than `ci.yml` (`cache-save` only) | modify   | 3     | same                                                 |
| `scripts/ci-platform-contract.test.ts`                            | modify   | 3     | same                                                 |
| `apps/server/tests/windows_terminal_shims.rs`                     | modify   | 4     | Windows VM run                                       |
| `docs/operations/ci.md`                                           | modify   | 5     | `vp run check:markdown-links`                        |
| `docs/operations/release.md`                                      | modify   | 5     | same                                                 |
| `docs/testing/` Windows runbook                                   | modify   | 5     | same                                                 |
| Pull request, `ci:full` label, issue comments                     | external | 5     | `gh pr checks`                                       |

Shared files reserved for the executor: `progress.md`, `docs/plans/README.md`.
Parallel conflicts: round 1 phases own disjoint source files. Their local build and dump checkpoints share the machine, so they run one after another, and measurement results go to the executor, who alone writes `progress.md`.

## Traceability

| Requirement | Tasks         |
| ----------- | ------------- |
| R1          | 1.1           |
| R2          | 3.1, 5.3      |
| R3          | 2.1, 3.2, 5.3 |
| R4          | 3.2, 5.3      |
| R5          | 3.3           |
| R6          | 4.1           |
| R7          | 4.2, 5.3      |
| R8          | 5.1           |

## End-to-end verification

- `vp test run scripts` passes with the new cases.
- `vp check`, `vp run typecheck`, `vp run check:markdown-links`, `cargo fmt --all --check` pass.
- The Windows VM compiles and runs the shim tests.
- One `ci:full` pull request run is green, and the pull request records each row's step times and the macOS heartbeat against `research/measured_ci_and_local.md`.

## Risks

- 16 codegen units raise peak compiler memory (12 GB locally) and may slow the 7 GB macOS arm64 row -> the heartbeat measures it and spec D3 removes the override from that row in the same pull request.
- Without `-j 2` a Windows runner may run out of memory in the server test build -> the 16 GB runner and the first pull request run decide; spec D4 allows restoring the flag.
- The new job compiles dependencies again when the cache misses -> about 6 minutes, measured in the bundle step.
- The Windows VM is unavailable -> Task 4.1's proof becomes the pull request's `server_tests_windows` job, whose filter runs the new test, and Task 4.2 is recorded as not run.

## Decisions

- P1. Inline execution in the planning session. Alternatives: a workflow with writer lanes (five small phases do not repay it). Decided by: agent's call; the user asked for the pull request in the same request.
- P2. The heartbeat is inline shell in the workflow step, not a new script. Alternatives: a Node wrapper (more code for one caller). Decided by: agent's call.
- P3. Skills were named from the session's skill list without a `mstack-find-skills` search, to keep the planning session short. A task may run without a specialist skill. Decided by: agent's call.
- P4. The spec was written in the planning session from the four issues and the diagnosis, because the user asked for the diagnosis and the plan in one request. Decided by: agent's call.

## Appendix: questions record

- 2026-11-14 Evidence: `research/measured_ci_and_local.md` section 1 / Decision: the cache is not the main cost; plan the compile count and codegen units first.
- 2026-11-14 Evidence: local dump of a second build reproduced the CFI error with identical `STACK` records / Decision: verify, do not fail on the log line alone.
- 2026-11-14 Evidence: plan review 1 (Codex) showed a tail-address check proves nothing about holes / Decision: R1 attributes the error with a binary-only rerun instead.
- 2026-11-14 Evidence: `setup-vp` `action.yml` at the pinned commit has a `cache-save` input / Decision: R5 uses it.
- 2026-11-14 Evidence: Cargo rebuilt only the two workspace crates under the per-package `--config` override / Decision: D2 uses `--config`.
- 2026-11-14 Evidence: plan review 2 (Codex) / Decision: R3 is accepted on the controlled local rebuild, not on a CI cache hit; the measured run's numbers live in the pull request, not in `progress.md`.
- 2026-11-14 Q: raise the cache limit above 10 GB? / Recommended: yes, to about 20 GB / Decision: left to the user, outside this pull request.
