# Phase 1: Symbol dump verification

- Goal: `scripts/dump-symbols.ts` proves the stored file complete, or fails, whenever `dump_syms` logs an error, with tests.
- Round: 1
- Depends on: none
- Owns: `scripts/dump-symbols.ts`, `scripts/dump-symbols.test.ts`
- Must not touch: `scripts/build-desktop-artifact.ts`, `.github/workflows/`
- Skills: tdd (keeps the failing test ahead of the script change)
- Read first: `research/measured_ci_and_local.md` section 4 (why the error is harmless when it comes from the dSYM, and when it is not)
- Checkpoint: `vp test run scripts/dump-symbols.test.ts` passes; a dump of an already built local binary with its dSYM that logs the CFI error prints the "all stored" line and exits 0. The binary comes from the 2026-11-14 measurement builds, so this phase starts no build.

## Tasks

### Task 1.1: Attribute a dump_syms error and verify the stored unwind records

- Satisfies: R1 (error from the dSYM, error from the binary, count mismatch, error without a dSYM, no error)
- Depends on: none
- Files: modify `scripts/dump-symbols.ts`; test `scripts/dump-symbols.test.ts`
- Interfaces: produces `countStackRecords(sym: string | Buffer): number`; `dumpSymbols(input, dumpSyms?)` keeps its signature
- Skills: tdd (red-green on the five scenarios)
- Read first: `scripts/dump-symbols.ts` (`assertUsableSymbols`, `hasRecord`, and how `dumpSymbols` stages inputs and spawns the tool)
- Tier: standard
- TDD: red-green
- Done when: `vp test run scripts/dump-symbols.test.ts` exits 0 with the five new cases passing

Steps

1. [ ] Write failing tests in `scripts/dump-symbols.test.ts` that drive `dumpSymbols` with a fake `dump_syms` executable (a Node script that writes a `.sym` and, by argument count, an `[ERROR] CFI: CfiError { kind: BadDebugInfo, source: Some(UnknownVersion(0)) }` line to standard error): error with two inputs and a clean binary-only run with equal `STACK` counts succeeds and prints `dump_syms reported an error for the dSYM; the binary's 3 STACK records are all stored`; error again in the binary-only run fails with `dump_syms reported an error while reading the unwind tables of the binary`; counts 3 against 5 fail with `the stored symbols hold 3 STACK records, the binary 5`; error without `--dsym` fails with `dump_syms reported an error`; no error runs the fake once (it records its invocations in a file) and succeeds. Also `countStackRecords` counts `STACK` lines at the start of the file and after a newline, given a string and a `Buffer`. Expected: six new cases in the file.
2. [ ] Run `vp test run scripts/dump-symbols.test.ts`. Expected: FAIL, `countStackRecords` is not exported and the error cases pass where they must fail.
3. [ ] Implement: spawn with standard error piped, write it through to the script's standard error, and when it holds `[ERROR]` apply the rule above (the binary-only run reuses the staged binary and writes to a second file in the work folder, without `--store`). Expected: the script type-checks.
4. [ ] Run `vp test run scripts/dump-symbols.test.ts`. Expected: PASS.
5. [ ] Prove the test can fail: skip the binary-only run, run the command. Expected: FAIL on the binary-error and mismatch cases. Restore and run again. Expected: PASS.
6. [ ] Run `vp check scripts/dump-symbols.ts scripts/dump-symbols.test.ts`. Expected: no errors.
