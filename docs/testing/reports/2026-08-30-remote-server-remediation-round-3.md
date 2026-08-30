# Platform Validation Execution Report

**Result:** PASS WITH RESIDUAL RISKS

Round-3 remediation of the Remote Servers feature: every finding from
`docs/plans/remote-servers/2026-08-30-remediation-round-2-adversarial-review.md`
(4 High, 31 Medium, 16 Low, plus validation-process gaps) was fixed, tested,
and documented, or explicitly dispositioned below. Design decisions are
recorded in `docs/plans/remote-servers/2026-08-30-remediation-round-3-design.md`.

## Tested revision

- Repository: BibCode (`/work/workspaces/orca/BibCode/develop`, linked worktree)
- Remote: origin (GitHub)
- Branch or requested revision: `mubeda/develop`
- Local HEAD: `a90b0ad9` (revision validated by the final clean full-suite
  run; the report commit itself lands one commit above)
- Remote HEAD: `8487ce78` (round-2 final; this round is local-only, not pushed)
- Merge base and ahead/behind: branch ahead of `8487ce78` by the 22 round-3
  commits at validation time (23 with this report), listed under Publication
  state; nothing behind
- Dirty state before execution: clean apart from the three untracked
  adversarial review documents (committed this round as `87126ebd`)
- Dirty state after execution: clean (see final `git status` evidence)

## Native environment

- Operating system and release/build: Fedora Linux 44 (Workstation Edition)
- Architecture: x86_64
- Kernel: Linux 7.1.10-200.fc44.x86_64
- Desktop environment/display protocol, when applicable: not exercised
  (no packaged-UI scenarios in this round)
- Rust/Cargo: rustc 1.97.1 / cargo 1.97.1
- Node/package manager/Vite+: Node v26.5.0, pnpm 11.15.0, vp 0.3.0
  (vite-plus 0.2.5, vitest 4.1.10, oxfmt 0.58.0, oxlint 1.73.0)
- Native compiler/SDK/runtime dependencies: system clang/gcc toolchain as
  configured for the workspace; no cross-compilation this round
- Optional capabilities such as WSL, signing, or notarization: not exercised

## Requested inputs and ancestry

- Expected product version: not applicable (no packaging this round)
- Observed version sources: not applicable
- Required commits: round-2 base `0e4767b5..8487ce78` present; round-3 work
  committed on top (see Publication state)
- Ancestry result for each commit: all round-3 commits are linear descendants
  of `8487ce78` on `mubeda/develop`
- Inputs that were unavailable: none

## Focused validation

| Command                                                                                                 | Result/exit code | Duration | Evidence and warnings                                                      |
| ------------------------------------------------------------------------------------------------------- | ---------------- | -------- | -------------------------------------------------------------------------- |
| `vp test run` ConnectTab + remote + pairingAdd + frame + advertisedEndpoint                             | pass / 0         | ~1s      | 162/162 (40+30+38+54) after C15/C16                                        |
| `cargo test -p bibcode-server --lib "rpc::e2ee"`                                                        | pass / 0         | ~15s     | 39/39 incl. new fixture parity test                                        |
| `vp test run packages/contracts/src/remotePairing.test.ts scripts/remote-architecture-contract.test.ts` | pass / 0         | <1s      | 6/6 after request-flag removal + doc rewrite                               |
| `vp test run apps/web/src/connection/databaseHealth.test.ts` (×2 before fix, ×1 after)                  | fail→pass        | <1s      | deterministic unhandled-rejection error before `57deed80`; clean after     |
| `vp run check:contracts`                                                                                | pass / 0         | ~2 min   | contracts typecheck, fixture export 4/4, Rust parity 5/5, `rpc_wire` 13/13 |
| `vp run check:dependency-ledger`                                                                        | pass / 0         | ~5s      | complete; 0 unaccounted entries                                            |
| Interop vs freshly built HEAD binary                                                                    | pass / 0         | ~2s      | 3/3 via `BIBCODE_E2EE_SERVER_BIN`                                          |
| Interop vs real `0e4767b5` binary                                                                       | pass / 0         | ~2s      | 3/3; prior-generation server built in a scratch worktree                   |

## VCS observation evidence

- Execution host and route: Native
- Not applicable: this round changed no VCS observation behavior; the VCS
  scenario table is intentionally omitted (see Commands not run).

## Workspace and static gates

| Command                                             | Result/exit code | Duration      | Test totals or warning summary                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp test` (full, final)                             | pass / 0         | ~2.5 min wall | 8,639 passed / 29 skipped / 0 failed (618 files; the 2 skipped files are the opt-in interop and Docker gates, run separately). Earlier full runs surfaced two real defects fixed mid-battery: the `bibcode-identity` sweep flagged the `T4` finding ID once the review report was tracked (respelled in `a90b0ad9`; initially misattributed to `databaseHealth`), and `databaseHealth` leaked a momentarily-unhandled settle rejection (`57deed80`) |
| `cargo test -p bibcode-server` (all targets, run 1) | pass / 0         | ~3 min        | lib 1,750 passed / 2 ignored; all integration targets green                                                                                                                                                                                                                                                                                                                                                                                         |
| `cargo test -p bibcode-server` (all targets, run 2) | pass / 0         | ~2 min        | 2,855 passed across all targets; 0 failed (flake-prone tests green both runs)                                                                                                                                                                                                                                                                                                                                                                       |
| `cargo test -p bibcode-desktop`                     | pass / 0         | ~30s          | 339 passed + auxiliary targets; 0 failed                                                                                                                                                                                                                                                                                                                                                                                                            |
| `vp check`                                          | pass / 0         | ~3.5s         | all 2,008 files formatted; 0 warnings in 1,413 linted files; **no exclusions**                                                                                                                                                                                                                                                                                                                                                                      |
| `vp run typecheck`                                  | pass / 0         | ~1 min        | 11/11 targets; pre-existing non-failing Effect suggestions remain                                                                                                                                                                                                                                                                                                                                                                                   |
| `cargo fmt --all --check`                           | pass / 0         | ~2s           | clean                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fresh Clippy with `-D warnings`                     | pass / 0         | ~4 min        | `cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier` removed 20,861 files / 66.4 GiB, then `cargo clippy --workspace --all-targets -- -D warnings` re-checked exactly the 3 workspace crates — evidence the lint was re-derived, not replayed                                                                                                                                                                             |
| `git diff --check`                                  | pass / 0         | <1s           | clean                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Native package artifacts

Not applicable: no packaging performed this round.

## Packaged UI and visual evidence

Not applicable: no packaged-UI scenarios this round; the native visual
runbooks were updated (`8f6f21e3`) for the next packaged validation pass.

## External-worktree scenario

Not applicable: worktree discovery/adoption behavior unchanged this round.
A scratch worktree at the session scratchpad (`old-server`, checked out at
`0e4767b5` to build the prior-generation interop binary) was removed and
pruned before the final status check (evidence under Process cleanup).

## Process and temporary-root cleanup

- Before snapshot: one stray `cargo test -p bibcode-server --lib` process
  (3h14m old, hung, zero output) found and terminated before the battery
- After snapshot: no `bibcode`/`cargo`/`rustc` processes; scratch
  `old-server` worktree removed and pruned (`git worktree list` back to the
  two real checkouts)
- Scoped surviving processes: none
- New test-owned roots: session scratchpad only (logs, notes, old-server
  worktree until removal)
- Pre-existing roots/processes intentionally left untouched: user worktrees
  and unrelated sessions
- Package mounts or platform resources released: not applicable

## Non-native compatibility evidence

### Windows

- Evidence class: Unavailable evidence
- Source/contracts reviewed: Windows spawn/cleanup paths compile under the
  cross-platform clippy gate; `windows-desktop.md` runbook updated with the
  fresh-clippy prescription (MSVC-wrapped)
- Commands and results: none run natively
- Native-only evidence still required: full `windows-desktop.md` runbook pass

### macOS

- Evidence class: Unavailable evidence
- Source/contracts reviewed: `macos-desktop.md` updated for round-3 ceremony
  outcomes
- Commands and results: none run natively
- Native-only evidence still required: full `macos-desktop.md` runbook pass

## Source changes and commits created

- Files changed: server RPC/admission/E2EE/auth/persistence, desktop bridge
  and network classification, client-runtime pairing/registry/E2EE socket,
  web share-exposure and IndexedDB recovery, shared pairing owner, contracts,
  fixtures, living architecture docs, spec amendments, runbooks, and the
  three tracked adversarial review reports
- Behavioral reason: fix all round-3 adversarial findings (4 High, 31 Medium,
  16 Low + validation gaps), per the round-3 design document
- RED evidence: each behavioral commit's tests were written or re-pinned
  first and observed failing where applicable (recorded per-commit; e.g. the
  ConnectTab shared-owner suite failed 39/40 before the rewire, the fixture
  parity tests failed before the fixture existed, mutation probes for the
  aging threshold and pre-auth soft cap fail when the fix is reverted)
- GREEN evidence: the gates in this report
- Local commits: 23 including this report (listed under Publication state)

## Commands not run

| Command or scenario                              | Reason                                                                                                                   | Required follow-up owner                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Packaged desktop UI validation (all OS runbooks) | Out of scope for this remediation round; runbooks updated for the next pass                                              | Next platform validation execution            |
| VCS observation scenario table                   | No VCS behavior changed this round                                                                                       | Next platform validation execution            |
| `cargo test --workspace` single invocation       | Superseded by per-package runs (`bibcode-server` ×2, `bibcode-desktop`) to double-run the flake-prone package under load | —                                             |
| Docker cross-container integration               | Unchanged since round 2 (`8487ce78`); no container-facing behavior changed this round                                    | Next round touching container-facing behavior |

## Residual risks

- Risk: two load-sensitive pre-existing test flakes observed or review-noted
  this session — `provider_terminal::codex::tests::two_codex_probes_bound_both_output_streams_in_parallel`
  (failed once under full-suite load while a concurrent build ran; passes in
  isolation) and `concurrent_pairing_offer_retries_across_live_servers_return_one_result`
  (review-observed). The SQLite checkpoint/startup stress flake root remains
  `dff24b3e` (attribution corrected from `bfbecf595` in earlier reporting).
  Impact: occasional spurious CI/local failures. Evidence that bounds it:
  isolation runs pass; modules untouched this round. Required follow-up:
  dedicated de-flaking pass.
- Risk: the single-use WebSocket-ticket redemption set is in-memory; a server
  restart forgets redemptions within one 5-minute ticket window.
  Impact: bounded replay window after restart. Evidence: documented in
  `remote.md`; tickets remain transport-bound and expire. Follow-up: optional
  durable redemption store if the threat model tightens.
- Risk: `/pair` browser URLs still deliver the pairing code in the query for
  newly generated links (scrubbed after consumption; app-wide `no-referrer`
  added). Impact: code may transit intermediary logs. Follow-up: fragment
  migration (named follow-up).
- Risk: pre-auth writer keeps a flat 5-second deadline (pre-auth frames are
  small by protocol); wide-prefix pre-auth exhaustion residual documented in
  the design doc and test comments.
- Risk: H-N2 inconclusive pairing path — after an ambiguous confirmation with
  no supervisor proof within 30 seconds, the entry stays saved and the
  supervisor owns recovery. Deliberate, documented in
  `connection-runtime.md`.
- Risk: public default-route addresses remain selectable in externally
  managed topologies (documented, warned, never preselected — M12 residual).
- Pre-existing, out of scope (disclosed, unchanged): `provider_opencode`
  timing tests, plain-`/ws` DOM decode and missing outbound byte budget,
  principal-unpartitioned outbound budget, 7 unreachable browser tests
  (count corrected this round), `auth_sessions` unbounded growth,
  `remote-architecture-contract` prose-gate shape, absolute-date activity
  fixtures, guarded-activity double serialization (M24 remainder).

## Historical disclosure

- L6: during rounds 1–2, validated trees did not always match the commits
  their reports named; affected commits `81eff018`, `eb11b705`, `01102b1a`.
  Round-3 validation binds every claim to the exact HEAD recorded above.
- Grab-bag commit subjects and report ordering in already-pushed round-1/2
  history are unfixable retroactively and are disclosed here.
- The round-1 review's suppression-mechanism claim and the round-2 review's
  unreachable-test count were corrected inline with dated markers before the
  review documents were committed (`87126ebd`).

## Delegation note

C1–C14 were implemented inline by the supervising session (Fable 5).
C15–C19 were implemented by Codex (`codex:rescue`, resumed writable thread)
under supervision after the user's delegation directive; the first two
delegation attempts on the original read-only thread could not write (the
Codex sandbox pins write access at thread creation), so a fresh writable
thread was used. All reviews, validation runs, and commits in this round
were performed by the supervising session. Codex's sandbox could not bind
loopback sockets; the nine affected `rpc_wire` tests were re-run natively
here and pass 13/13.

## Runbook review

`docs/testing/README.md`, `cross-platform-validation.md`,
`linux-desktop.md`, `macos-desktop.md`, and `windows-desktop.md` were
updated this round (fresh-clippy prescription, round-3 ceremony outcomes,
supervisor-as-bearer-proof expectations, off-host confirmation and sweep
gates). `execution-report-template.md` was reviewed and remains accurate.

## Publication state

- Commits created (oldest first): `9af814dc` (M5 staged deletions),
  `b3f50b60` (round-3 design), `7281e434` (C3+C4 admission),
  `f31c5ee8` (C5 inbound deadline), `64a5f11d` (C6 pre-auth fairness),
  `8d6a290a` (C7 server-decided confirmation), `9bf11d9f` (C8 single
  encode), `65790f18` (C9 auth/session hygiene), `15d2882b` (C10 transport
  caps), `a8850e0b` (C11 desktop), `a13cbd4a` (C12 pairing commit),
  `19047245` (C13 exposure convergence), `9a108f68` (C14 IndexedDB
  recovery), `56095479` (C15 shared pairing owner), `817b6034` (C16 parity
  fixture), `70783d87` (C17 lint/format hygiene), `cec881fc` (contracts
  flag removal), `09f63731` (C18 docs alignment), `8f6f21e3` (C19
  runbooks), `87126ebd` (C20 review reports), `57deed80` (blocked-deletion
  test fix), `a90b0ad9` (T-4 identity respell), plus this report's commit
- Pushed: no (not requested)
- Branch merged: no
- Pull request opened: no
- Artifacts published: no
