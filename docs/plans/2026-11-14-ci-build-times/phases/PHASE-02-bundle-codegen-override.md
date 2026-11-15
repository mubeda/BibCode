# Phase 2: Bundle codegen override

- Goal: `scripts/build-desktop-artifact.ts` can build the two workspace crates with a chosen number of codegen units, with tests, and builds exactly as today without the flag.
- Round: 1
- Depends on: none
- Owns: `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`
- Must not touch: `scripts/dump-symbols.ts`, `.github/workflows/`
- Skills: tdd (keeps the failing test ahead of the script change)
- Read first: `research/measured_ci_and_local.md` section 3 (what 16 codegen units buy and cost)
- Checkpoint: `vp test run scripts/build-desktop-artifact.test.ts` passes; through the real wrapper, Cargo receives the two `--config` arguments (see Task 2.1 step 6), and a direct Cargo rebuild with them compiled only `bibcode-server` and `bibcode-desktop` (recorded in `research/measured_ci_and_local.md` section 3).

## Tasks

### Task 2.1: Add --workspace-codegen-units to the bundle script

- Satisfies: R3 (flag given, flag absent, invalid value)
- Depends on: none
- Files: modify `scripts/build-desktop-artifact.ts`; test `scripts/build-desktop-artifact.test.ts`
- Interfaces: produces the CLI flag `--workspace-codegen-units <n>` and the input field `workspaceCodegenUnits?: number`; the build command gains `-- --config profile.release.package.bibcode-server.codegen-units=<n> --config profile.release.package.bibcode-desktop.codegen-units=<n>` after its existing arguments
- Skills: tdd (red-green on the three scenarios)
- Read first: `scripts/build-desktop-artifact.ts` (`tauriCommand`, the argument parser and its `symbols` option)
- Tier: standard
- TDD: red-green
- Done when: `vp test run scripts/build-desktop-artifact.test.ts` exits 0 with the new cases passing

Steps

1. [ ] Write failing tests: a plan with `workspaceCodegenUnits: 16` has a build command whose arguments end with `--`, `--config`, `profile.release.package.bibcode-server.codegen-units=16`, `--config`, `profile.release.package.bibcode-desktop.codegen-units=16` and a bundle command without them; a plan without it equals today's; parsing `--workspace-codegen-units 0`, `257`, `1.5` or `abc` fails with `--workspace-codegen-units must be a whole number from 1 to 256.`
2. [ ] Run `vp test run scripts/build-desktop-artifact.test.ts`. Expected: FAIL on the three new cases.
3. [ ] Implement: the parser option (string, validated to an integer 1 to 256), the input field, and the extra arguments in `tauriCommand("build")` only.
4. [ ] Run `vp test run scripts/build-desktop-artifact.test.ts`. Expected: PASS.
5. [ ] Prove the test can fail: drop the `--` separator, run the command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Prove the complete caller: start `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --output-dir <scratch> --symbols --workspace-codegen-units 16` as the leader of its own process group (it builds into this checkout's `target/aarch64-apple-darwin`, which nothing else uses), poll `ps` for up to 160 seconds for a `cargo build` process whose arguments hold `codegen-units=16`, then send `TERM` to the process group and check that no process of the group is left. Expected: the command line reads `cargo build --config profile.release.package.bibcode-server.codegen-units=16 --config profile.release.package.bibcode-desktop.codegen-units=16 ...`, and the group is empty afterwards.
7. [ ] Run `vp check scripts/build-desktop-artifact.ts scripts/build-desktop-artifact.test.ts`. Expected: no errors.
