# Progress: CI build times, symbol dump error and Windows arm64 flake

Plan: plan.md
Spec: spec.md (sha256 be1cd41eb716)
Plan status: Approved 2026-11-14
Plan review: Codex gpt-6.1-sol, round 2, findings handled (reviews/plan-review-1.md, reviews/plan-review-2.md)
Executor: inline
Branch: claude/build-times-investigation-ec72b8

| Task | Title                                                            | Phase | State | Owner | Note |
| ---- | ---------------------------------------------------------------- | ----- | ----- | ----- | ---- |
| 1.1  | Attribute a dump_syms error and verify the stored unwind records | 1     | Open  |       |      |
| 2.1  | Add --workspace-codegen-units to the bundle script               | 2     | Open  |       |      |
| 3.1  | Move the Windows server tests into server_tests_windows          | 3     | Open  |       |      |
| 3.2  | Pass the override and record a heartbeat in the bundle step      | 3     | Open  |       |      |
| 3.3  | Save pnpm store entries only on main                             | 3     | Open  |       |      |
| 4.1  | Print the collected output and exit state on timeout             | 4     | Open  |       |      |
| 4.2  | Measure the #367 rate under load in the Windows arm64 VM         | 4     | Open  |       |      |
| 5.1  | Update the living documents                                      | 5     | Open  |       |      |
| 5.2  | Local gates, review and pull request                             | 5     | Open  |       |      |
| 5.3  | Accept the requirements on the measured run                      | 5     | Open  |       |      |

## Log

- 2026-11-14 09:27 1.1 Closed. Evidence: `vp test run scripts/dump-symbols.test.ts` 12 passing; with the binary-only rerun disabled, 3 cases fail; a real dump of a local binary and dSYM that logs the CFI error printed "the binary's 635173 STACK records are all stored" and exited 0.
- 2026-11-14 09:33 2.1 Closed. Evidence: `vp test run scripts/build-desktop-artifact.test.ts` 59 passing; without the `--` separator 1 case fails; under the real wrapper the process list showed `cargo build --config profile.release.package.bibcode-server.codegen-units=16 --config profile.release.package.bibcode-desktop.codegen-units=16 --bins --features tauri/custom-protocol --release --target aarch64-apple-darwin`, and the process group was empty after `TERM`.
- 2026-11-14 09:38 3.1, 3.2, 3.3 Closed. Evidence: `vp test run scripts/ci-platform-contract.test.ts` 53 passing (3 new cases failed first). Heartbeat probes: a child exiting 7 gives exit 7 and the notice; a `ps` that fails gives heartbeat lines without memory and exit 0; a heartbeat that died early no longer fails a good build (found by the probe: the trap's `kill` ran under `bash -e`, fixed with `|| true`).
- 2026-11-14 09:45 5.1 Closed. Evidence: `vp run check:markdown-links` passes; `vp test run scripts` 952 passing after `scripts/rust-workspace.test.ts` was updated for the sixth Rust job.
- 2026-11-14 09:45 4.1 In progress. Owner: inline. The helper and its test are written; the Windows arm64 VM is compiling them.
