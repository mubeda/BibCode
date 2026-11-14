# Measured facts from this repository (2026-11-14)

These come from the CI job logs and jobs API of ten `main` runs (2026-11-04 to 2026-11-14) and
from local builds on a 12-core Apple silicon Mac with 96 GB RAM, Rust 1.98.1. They are primary
evidence and outrank general claims in the other notes. Local numbers are one run per variant on
a machine under other load (load average 6 to 30), so read them as ballpark figures.

## 1. Where the time goes in CI

Bundle step `Build native bundle without publishing` of run 43562279474 (2026-11-14), from the
timestamps of Cargo's `Compiling` lines:

| Row                                            | Dependencies (all `Compiling` lines) | After the last dependency until `Finished` | Cargo total  |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------------ | ------------ |
| macOS arm64 (no cache restored)                | 7 min (527 crates)                   | 81 min                                     | 87 min 51 s  |
| Linux x64 (no cache restored)                  | 6 min (582 crates)                   | 23 min                                     | about 29 min |
| Windows x64 (partial restore)                  | under 1 min                          | 42 min                                     | about 42 min |
| macOS arm64, run 42542822659, full cache match | 2.5 min (58 crates)                  | 107 min                                    | 109 min 51 s |

The times are when Cargo printed each `Compiling` line, which is when a unit started, so the
split is an estimate: some dependencies may still have been compiling after the last line. After
`Finished`, the symbol dump took 27 s and bundling 30 s. On this reading the two workspace crates
(`bibcode-server`, `bibcode-desktop`) and the final link take 80% to 97% of the step. The two
macOS rows are different runs, so their difference is not a measured cache saving; the Windows
arm64 attempts in section 2 give about 12 minutes saved before the bundle step with a full match.

Windows arm64 row of the same run (103 minutes in total, partial cache restore), `bibcode-server`
was compiled five times:

| Step                                                         | Cargo build time | Test run time |
| ------------------------------------------------------------ | ---------------- | ------------- |
| `cargo test -p bibcode-desktop` (debug)                      | 10 min 41 s      | 34 s          |
| `cargo check -p bibcode-server --all-targets`                | 5 min 06 s       | none          |
| `cargo test -p bibcode-server --test git_system_config -j 2` | 6 min 42 s       | 17 s          |
| `cargo test -p bibcode-server --lib -j 2 -- <filters>`       | 17 min 30 s      | 71 s          |
| `cargo test ... --test windows_terminal_shims -j 2`          | 16 s             | 5 s           |
| release bundle build                                         | 36 min 15 s      | none          |

That is 76 of 103 minutes compiling one crate, against about 2 minutes running tests.

Bundle step minutes over time (same step, `main` runs):

| Date                             | macOS arm64 | macOS x64 | Linux x64 | Windows x64 | Windows arm64 |
| -------------------------------- | ----------- | --------- | --------- | ----------- | ------------- |
| 2026-11-04 (before symbols)      | 37 to 40    | 47 to 57  | 26 to 28  | 35 to 41    | 32 to 38      |
| 2026-11-06 to 11-07 (symbols on) | 75 to 79    | 81 to 92  | 25 to 26  | 30 to 45    | 40 to 48      |
| 2026-11-09                       | 111         | 101       | 25        | 36          | 44            |
| 2026-11-13 to 11-14              | 81 to 89    | 69 to 90  | 27 to 33  | 44 to 53    | 38 to 44      |

Turning the symbol profile on roughly doubled the two macOS rows and left Linux unchanged.

## 2. Cache store

- `gh cache list` total: 9.98 GiB of a 10 GB limit (`max_cache_size_gb: 10`, retention 7 days).
- Entries present: three of six `native-desktop` Rust entries (1.5 to 1.85 GiB each), `check`
  0.78, two of three `crash-smoke` (0.57 each), one Linux Git entry 0.45, and six pnpm store
  entries of about 0.48 GiB each. One pnpm entry belonged to a pull request ref.
- Missing: both Windows `native-desktop` entries, Linux x64 `native-desktop`, `test`, and the
  macOS `crash-smoke` entry.
- In run 43562279474 (push to `main`) 11 of 13 Rust-cache restores logged `No cache found`; the
  two Windows rows restored a partial match.
- Wanted total if every entry existed: about 17 GB.
- Run 43523947929, Windows arm64, three attempts: attempt 1 restored nothing and was cancelled at
  its limit while saving; attempt 2 (01:09) restored that entry as a full match (2,056 MB), so a
  job cancelled in its post step had saved; attempt 3 (02:08) found no cache, so the entry was
  evicted within an hour of being used. With the full match the steps before the bundle took
  about 12 minutes less (desktop tests 11 against 19 minutes, check 6 against 7, Git tests 7
  against 10).

## 3. Local release build of `bibcode-desktop` (cold target, `--timings`)

| Variant                                                                                     | Total  | `bibcode-server` lib | `bibcode-desktop` lib | `bibcode-desktop` bin (thin LTO link) |
| ------------------------------------------------------------------------------------------- | ------ | -------------------- | --------------------- | ------------------------------------- |
| Shipped profile (thin LTO, 1 codegen unit, stripped, no debug info)                         | 1299 s | 650 s                | 187 s                 | 288 s                                 |
| Symbol profile (same plus `strip=none`, `debug=line-tables-only`, `split-debuginfo=packed`) | 1260 s | 676 s                | 177 s                 | 304 s                                 |
| Symbol profile with `codegen-units=16`                                                      | 673 s  | 311 s                | 79 s                  | 177 s                                 |

- The symbol profile makes no measurable difference on this machine (1260 s against 1299 s).
- No `dsymutil` or `ld` process was ever seen by a 15-second sampler in the symbol build, so
  `dsymutil` takes well under a minute here. The dSYM DWARF file is 353 MB.
- 16 codegen units cut the build to about half.
- The three crates build one after another, so the build is serial for 17 of its 21 minutes.
- A rebuild in the shipped-profile target with `--config profile.release.package.bibcode-server.codegen-units=16`
  and the same for `bibcode-desktop` compiled only those two crates (every dependency stayed
  fresh) and took 653 s, against 1125 s for the same three units with one codegen unit. Another
  build was running at the same time.

Peak resident memory of single `rustc` processes (10-second samples):

| Variant                                                                   | `bibcode-server` | `bibcode-desktop` lib | `bibcode-desktop` bin |
| ------------------------------------------------------------------------- | ---------------- | --------------------- | --------------------- |
| Shipped profile                                                           | 8.7 GB           | 3.9 GB                | 5.6 GB                |
| Symbol profile (one codegen unit, a later rebuild of the two crates only) | 9.6 GB           | 4.8 GB                | 6.4 GB                |
| Symbol profile with 16 codegen units                                      | 12.0 GB          | 5.5 GB                | 9.4 GB                |

GitHub-hosted runner memory (GitHub docs, see `rust_ci_speedups.md`): macOS arm64 7 GB, macOS
Intel 14 GB, Linux and Windows 16 GB. The shipped-profile compile of `bibcode-server` already
needs more memory than the macOS arm64 runner has.

## 4. Symbol dump (`dump_syms` 2.3.9)

- `[ERROR] CFI: CfiError { kind: BadDebugInfo, ... }` appears in 7 of 24 macOS job logs that
  dump symbols (desktop bundle on both architectures and the crash smoke job), most recently on
  2026-11-14. It never appears on Linux or Windows.
- The crash smoke job of 2026-11-14 logged the error and still passed its check that the
  caller frame was unwound with `trust == "cfi"`.
- In the tool's source (`object_info.rs`), the unwind writer logs this error and keeps whatever
  it wrote before failing; the process still exits 0.
- Locally, the one-codegen-unit symbol build: six runs on the same binary and dSYM gave
  byte-identical output with no error, 334,968 `STACK CFI` records, and every one of the 56,811
  `FUNC` records lies inside a `STACK CFI INIT` range. Dumping the dSYM alone fails with "No CFI
  data".
- Locally, the 16-codegen-unit symbol build reproduces the error: dumping the dSYM alone logs
  `CfiError { kind: BadDebugInfo, source: Some(UnexpectedEof(...)) }` and writes no `STACK`
  record; dumping the binary alone logs nothing and writes 635,173; dumping both logs the error
  and writes the same 635,173 (0 lines differ). In the dSYM, the `__unwind_info` section header
  has file offset 0 with a non-zero size, so the parser reads unrelated bytes.
- `symbolic-cfi` 13.9.0 (`process_macho`, `read_compact_unwind_info`) returns on the first
  failing entry, so an error inside the binary's own unwind data would truncate the records.

## 5. Flaky Windows arm64 test

Run 43523947929, attempt 2: `running 10 tests` at 02:01:33; the four tests that libtest started
first each failed after exactly 10 s (`Elapsed`), and the other six passed within the next 5 s.
The same step normally finishes in 3.7 to 4.6 s on Windows arm64 and 2.4 to 3.0 s on x64
(9 other runs).
