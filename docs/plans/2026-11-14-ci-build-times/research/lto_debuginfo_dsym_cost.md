# Build-time cost of thin LTO + codegen-units=1 + debug info, and macOS packed dSYMs (as of Nov 2026)

Research coverage note: ~16 tool calls. Several questions have no direct primary measurement; those are listed under Gaps and flagged as inference. Nothing below is from the user's own measurements except where labelled "given".

## 1. Why codegen-units=1 + thin LTO keeps the largest crate on one core; 1 vs 16 CGUs

### Takeaway

With codegen-units=1 the crate is a single LLVM module, so rustc's parallel LLVM stage has nothing to fan out and one thread does the optimization; ThinLTO phases only parallelize across modules. No controlled recent benchmark of thin-LTO CGU=1 vs CGU=16 (runtime and build time together) was found; the available numbers are older or from other projects.

### Cited Findings

- rustc splits a crate into codegen units that LLVM processes in parallel; defaults are 16 (non-incremental) and 256 (incremental). "Setting this to 1 may improve the performance of generated code, but may be slower to compile." — [rustc book, codegen options](https://doc.rust-lang.org/rustc/codegen-options/index.html)
- When `-C lto` is unspecified, rustc does "thin local LTO" across the crate's own CGUs, but this is disabled if codegen-units=1 or opt-level=0. With explicit `lto`, codegen-units=1 means 1 CGU plus cross-crate LTO. — [rustc book](https://doc.rust-lang.org/rustc/codegen-options/index.html); same text in [Cargo book, profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)
- Cargo profile semantics: `lto = false` = thin local LTO only, none if CGU=1; `lto="thin"` = cross-crate thin LTO. Defaults: release codegen-units=16, dev 256. — [Cargo book](https://doc.rust-lang.org/cargo/reference/profiles.html)
- Measured (rustc ~1.7x, Nethercote, image-0.24.1 debug full build): default up to 16 CGUs ~4.5 s vs single CGU ~9.7 s ("more than twice as long"), because one LLVM thread runs while the rustc thread idles. — [Nethercote 2023-07-11](https://nnethercote.github.io/2023/07/11/back-end-parallelism-in-the-rust-compiler.html)
- In release builds, thin-local-LTO threads start only after all `opt` threads finish (serial barrier); even the opt phase has a "staircase" with peak concurrency around seven threads because MIR-to-LLVM-IR conversion is serial. More parallelism costs more total cycles, peak memory, larger binaries and lower code quality. — [Nethercote 2023](https://nnethercote.github.io/2023/07/11/back-end-parallelism-in-the-rust-compiler.html)
- Measured on ruff (astral-sh, release build, one machine, Rust version not stated in the snippet): fat LTO + 16 CGU 77 s; thin 41 s; LTO off 19 s; LTO off + CGU 16 = 7 s; thin + CGU 16 = 16 s. — as quoted in a search result for [ruff commit](https://app.semanticdiff.com/gh/astral-sh/ruff/commit/3ce145c47669645c9031ec42ef9b339835e548c9) (secondary view of a commit message; not independently verified)
- Older runtime figure (2018, internals thread on ThinLTO): CGU=16 sped the build ~10% but made runtime ~13% slower; Serde JSON benchmarks with ThinLTO ranged from 12% faster to 16% slower. — [internals.rust-lang.org](https://internals.rust-lang.org/t/help-test-out-thinlto/6017/3) and [thread](https://internals.rust-lang.org/t/help-test-out-thinlto/6017)
- Given (user's own measurement): LTO off + CGU 16 cut a cold 4-core release test build from 666 s to 293 s.

### Inferences

- A very large single crate at CGU=1 is one LLVM module; opt and codegen for it run on one thread regardless of core count, so a 4-core or 3-core (arm64 runner) machine sits mostly idle during that crate. This follows from the Nethercote/rustc-book statements but no source says it about thin LTO CGU=1 specifically.
- The doubling from CGU=1 is likely comparable in order to the 2x Nethercote saw, but his case was debug and small; do not treat 2x as a general constant.

### Gaps

- No 2024-2026 controlled benchmark of `lto="thin"` with CGU=1 vs CGU=16 giving both runtime and build time was found. rustc-perf or Kobzol posts on this were not located.
- Rust 1.98 specifics not found; all sources predate or do not name 1.98.

## 2. What line-tables-only adds to rustc/LLVM and link time vs debug=0; interaction with thin LTO

### Takeaway

No source measured line-tables-only vs debug=0 time. The documented difference is that line-tables-only emits .debug_abbrev/.debug_info/.debug_str/.debug_aranges and line tables, with no variable or type info, which is the cheapest level that gives file:line. A known ThinLTO + `split-debuginfo=packed` bug exists (reported against an older rustc).

### Cited Findings

- `debug` levels: 0/none (release default), `line-directives-only`, `line-tables-only` ("minimal amount of debug info for backtraces with filename/line number info, but not anything else"), 1/limited, 2/full. MSRV 1.71 for the named levels. — [Cargo book](https://doc.rust-lang.org/cargo/reference/profiles.html), [rustc book](https://doc.rust-lang.org/rustc/codegen-options/index.html)
- A rust-lang PR notes line-tables-only adds .debug_abbrev, .debug_info, .debug_str and a proper .debug_aranges on top of what line-directives-only emits; `debuginfo=1` was never line-tables-only for compatibility reasons. — [rust-lang/rust#109808](https://github.com/rust-lang/rust/pull/109808) (from search summary; not opened)
- `strip = "none"` default in Cargo; `strip="debuginfo"` leaves "backtraces mostly-intact"; `strip="symbols"` is discouraged for crash reporting. Prior to 1.79 `strip="debuginfo"` unintentionally disabled PDB generation on MSVC. — [rustc book](https://doc.rust-lang.org/rustc/codegen-options/index.html)
- Reported bug: ThinLTO combined with `split-debuginfo="packed"` fails with a "duplicate split compilation unit" error for some binaries; fat LTO + packed and thin + unpacked built fine in that report. Current status not checked. — [rust-lang/rust#132677](https://github.com/rust-lang/rust/issues/132677) (via search summary)
- A rust-lang/rust test exists guarding an LLVM ODR assertion under LTO + debuginfo (tests/ui/lto/debuginfo-lto.rs). — [mirror](https://cdn05042023.gitlink.org.cn/dnrops/rust/src/branch/master/tests/ui/lto/debuginfo-lto.rs)

### Inferences

- Debug metadata travels in the bitcode that ThinLTO imports, so more DI means larger bitcode and more import/merge work, plausibly the main reason the LTO step slows with debug on. This is plausible LLVM behavior but no source here measures or states it. Treat as hypothesis; a measured A/B (`-Z time-passes` or `cargo --timings`) with debug=0 vs line-tables-only would settle it.
- The user's 38 -> 75-111 min jump is a combination of (a) DI generation/LTO, (b) strip=none linking bigger binaries, (c) dsymutil, and (d) any fingerprint rebuild of deps (Q5). Sources do not apportion it.

### Gaps

- No measurement of line-tables-only vs debug=0 compile or link time found. No source found on ThinLTO importing debug metadata cost.

## 3. macOS split-debuginfo: packed vs unpacked vs off; dsymutil cost, threading, flags; can Breakpad tools read unpacked?

### Takeaway

`packed` runs dsymutil after link on every binary; it is documented as a large share of macOS build time (7 of ~10 s in one incremental case). dsymutil's classic linker is largely single-threaded (143% CPU in a 2025 sample); LLVM's parallel linker (`--linker=parallel`) gives ~3-4x on clang and was reported made default in LLVM in June 2026, but Xcode shipping status was not found. `-j` only parallelizes across architectures; `--no-odr` skips C++ ODR uniquing (little relevance to Rust).

### Cited Findings

- rustc `split-debuginfo`: `off` on macOS "prevents the final execution of dsymutil"; `packed` (rustc default on macOS and Windows MSVC) puts debuginfo in a `.dSYM`; `unpacked` on macOS "means the original object files will contain debug information". — [rustc book](https://doc.rust-lang.org/rustc/codegen-options/index.html)
- Cargo's own default is `unpacked` on macOS for profiles with debug info enabled ("Be aware that Cargo and rustc have different defaults"). So the user's `packed` is an explicit opt-in. — [Cargo book](https://doc.rust-lang.org/cargo/reference/profiles.html)
- Measured (incremental debug build of Cargo itself, 2021): about 7 of ~10 s was dsymutil. — [internals thread](https://internals.rust-lang.org/t/help-test-faster-incremental-debug-macos-builds-on-nightly/14016)
- Unpacked leaves debug info in object files in the target dir; one report measured 2.1 GB of extra target dir. — same thread
- dsymutil on a large C++ build (LLVM discourse, 2025-2026): clang link took "a second or 2", classic dsymutil 1:38 wall, 143% CPU (133 s user); `--linker=parallel` 45 s wall, 531% CPU (216 s user). Thread also records the parallel linker being made default on June 4, 2026, with no LLVM or Xcode version stated. — [LLVM discourse](https://discourse.llvm.org/t/llvm-dsymutil-performance/89051)
- Same author's measurement on clang: ~3 min classic vs ~40 s parallel; parallel output is not binary-identical to classic, a semantic diff found ~50k differences among ~5M DIEs, and the author called the tool not yet production-ready (post predates the June 2026 default change). — [Devlieghere, dsymutil parallel linker](https://jonasdevlieghere.com/post/dsymutil-parallel-linker)
- dsymutil docs: `-j/--num-threads` = "maximum number of simultaneous threads to use when linking multiple architectures"; `--no-odr` = do not use ODR for uniquing C++ types; `--no-output` does the link in memory without writing (useful for timing); `--flat` emits a flat `.dwarf` file. The fetched doc page did not list `--linker`. — [LLVM dsymutil docs](https://llvm.org/docs/CommandGuide/dsymutil.html)
- With unpacked, the debug info lives in the object files and the binary holds a debug map; Rust code can symbolize without dsymutil. A rustc PR says dsymutil "can take quite a long time ... in debug builds and provides little benefit". — [internals thread](https://internals.rust-lang.org/t/help-test-faster-incremental-debug-macos-builds-on-nightly/14016), [rust-lang/rust#79361](https://github.com/rust-lang/rust/issues/79361) (via search summary)
- Historical: Firefox hit llvm-dsymutil crashes on Rust debug info and worked around by lowering debuginfo level on cross-compiled macOS builds; dsymutil SIGBUS under packed reported in 2021. — [Bugzilla 1430315](https://bugzilla.mozilla.org/show_bug.cgi?id=1430315), [internals thread](https://internals.rust-lang.org/t/help-test-faster-incremental-debug-macos-builds-on-nightly/14016)
- mozilla/dump_syms README documents inputs as DWARF/STABS in ELF and standalone PDB and says nothing about unpacked/debug-map inputs on macOS. — [mozilla/dump_syms](https://github.com/mozilla/dump_syms)

### Inferences

- Because Mach-O linked binaries carry only a debug map pointing at `.o` files (no DWARF) for unpacked, dump_syms (which reads DWARF from the input file or a dSYM) cannot get symbols from an unpacked build without running dsymutil anyway; the object files on disk are the only DWARF. No source confirms or refutes this for dump_syms 2.3.9; test it with a one-binary experiment.
- Running dsymutil yourself with `--linker=parallel` (if the installed Xcode's dsymutil supports it) is the cheapest way to keep a dSYM; the user's Rust binaries are single-language Rust so ODR flags are unlikely to matter.

### Gaps

- No measurement of dsymutil time on a large Rust binary with line-tables-only DI was found. Whether Xcode (e.g. 26.x/27.x) bundles a dsymutil with the parallel linker, and whether rustc invokes dsymutil with threading flags, was not found. How rustc invokes dsymutil (flags) not verified.
- GitHub-hosted macOS arm64 runner core count not verified here.

## 4. debug only for workspace crates; are CFI/unwind tables independent of `debug`?

### Takeaway

`[profile.release.package."*"] debug = false` is supported and applies to all dependencies but not workspace members, so it does keep DI only for first-party crates. Unwind tables are controlled by separate rustc flags (`force-unwind-tables`) and target defaults, not by `-C debuginfo`; on Apple platforms unwinding data is compact unwind (`__unwind_info`) plus `__eh_frame`, and Mozilla's dump_syms parses compact unwind.

### Cited Findings

- Package overrides: `"*"` overrides "all dependencies (but not any workspace member)"; precedence is `package.name`, then `package."*"`, then `build-override`, then the profile. Overrides cannot set `panic`, `lto`, or `rpath`. — [Cargo book](https://doc.rust-lang.org/cargo/reference/profiles.html)
- `-C force-unwind-tables` forces unwind table generation; default is target-dependent; it is separate from `-C debuginfo`. — [rustc book](https://doc.rust-lang.org/rustc/codegen-options/index.html)
- Apple compact unwinding lives in `__unwind_info`; Clang prefers it over DWARF CFI on Apple platforms, and the Rust dump_syms deployed in Firefox's build parses it. — [Gankra, Apple Compact Unwinding Format](https://gankra.github.io/blah/compact-unwinding)
- Old Google Breakpad dump_syms had incomplete CFI on iOS (no compact unwind support); Mozilla imported a newer Rust dump_syms to emit correct macOS CFI. — [Bugzilla 1723466](https://bugzilla.mozilla.org/show_bug.cgi?id=1723466), [Bugzilla 1716603](https://bugzilla.mozilla.org/show_bug.cgi?id=1716603)
- A Breakpad fix handled dSYMs where some Mach-O sections in `__DWARF`/`__eh_frame` are absent. — [Breakpad commit](https://android.googlesource.com/platform/external/google-breakpad/+/f7428bc3) (from search result titles/summary)
- clang/Rust can emit bogus unwind info for some functions on arm64 Windows causing dump_syms to fail on those functions. — [Bugzilla 1529355](https://bugzilla.mozilla.org/show_bug.cgi?id=1529355) (via summary)

### Inferences

- With `package."*" debug=false`, dependency frames lose file:line but keep function names (symbol table, strip=none) and CFI; this is probably acceptable for crash triage but loses inlined-frame detail. Not measured.
- For Windows MSVC, function names and unwind come from PDB + `.pdata/.xdata`; line info needs PDB with line tables, which `debug=false` deps would lack. Not verified by a source.

### Gaps

- No source states explicitly that unwind tables are unaffected by `debug` on macOS arm64, Linux and Windows; the above is derived from flag separation. Linux x86_64 uses `.eh_frame` by default; not cited.

## 5. Do CARGO_PROFILE_RELEASE_* env overrides force rebuilding all dependencies?

### Takeaway

Yes. Cargo hashes the whole `Profile` struct (plus Lto, rustflags) into each unit's fingerprint and into the metadata hash that names output files, and dependency changes propagate to dependents. A build with different debug/strip/split-debuginfo therefore cannot reuse a normal-profile cache for any unit it applies to.

### Cited Findings

- Fingerprint `profile` = "Hash of the Profile, CompileMode, and any extra flags"; `calculate_normal` hashes `&unit.profile`; `compare` returns `ProfileConfigurationChanged` when it differs; dependency fingerprints are included so dirtiness propagates up. — [Cargo fingerprint source](https://doc.rust-lang.org/nightly/nightly-rustc/src/cargo/compiler/fingerprint/mod.rs.html)
- The module doc table marks Profile and Lto as included in the fingerprint, `Metadata::unit_id` and `Metadata::c_metadata`, so artifacts of different profiles get different file names and do not overwrite each other. — same source
- Env vars `CARGO_PROFILE_<name>_<key>` set profile keys (e.g. `CARGO_PROFILE_RELEASE_DEBUG`). Buildroot uses them for debug levels. — [Buildroot patch](https://buildroot.uclibc.org/lists/buildroot/2023-November/364553.html)
- Build scripts/proc-macros with `build-override` may be built twice. — [Cargo book](https://doc.rust-lang.org/cargo/reference/profiles.html)

### Inferences

- The excerpt did not show `Profile` struct fields (file truncated at 100k chars), so `debug`, `strip` and `split_debuginfo` being fields is inferred from Cargo's profile model; confirm with `CARGO_LOG=cargo::core::compiler::fingerprint=trace` (reports `ProfileConfigurationChanged`).
- Fix: `debug=false` for deps via `package."*"` still changes the profile hash of deps relative to the non-symbol build if they differ; to share cached dependency artifacts, the deps' profile must be identical in both builds (e.g. set the same `package."*"` settings in both) and only workspace members differ.

### Gaps

- Whether `strip` is part of Cargo's hashed `Profile` (strip is applied at link, and Cargo passes it to rustc) was not verified.

## 6. Faster linkers on macOS and Windows; do they help LTO builds?

### Takeaway

Little macOS/Windows-specific evidence was found. Rust 1.90 made rust-lld the default only on x86_64 Linux. Wild's macOS support is in progress and not default as of its 0.11 release (Oct 2026 per one report). No source states any linker speeds up the LTO (LLVM) phase, which happens before linking.

### Cited Findings

- Rust 1.90.0 (2025-09-18) uses LLD by default only for `x86_64-unknown-linux-gnu`; opt out with `-C linker-features=-lld`. — [Rust blog 1.90](https://blog.rust-lang.org/2025/09/18/Rust-1.90.0/), [LLD post](https://blog.rust-lang.org/2025/09/01/rust-lld-on-1.90.0-stable)
- x86_64-apple-darwin was demoted to Tier 2 with host tools in 1.90. — [Rust blog](https://blog.rust-lang.org/2025/08/19/demoting-x86-64-apple-darwin-to-tier-2-with-host-tools)
- Wild linker: 0.9 (May 2026) expanded platform coverage; Phoronix (reported Oct 2026) says Wild 0.11 macOS port has progressed but is not enabled by default. — [Wild 0.9 post](https://davidlattimore.github.io/posts/2026/05/24/wild-update-0.9.0.html), [Phoronix 0.9](https://phoronix.com/news/wild-linker-0.9), [Phoronix 0.11 via search](https://phoronix.com/news/Wild-0.11-Released) (page returned 403 on fetch; date and claim from search snippet only)
- Nethercote notes LTO threads run inside rustc/LLVM before the system linker; the linker only receives the final objects. — [Nethercote 2023](https://nnethercote.github.io/2023/07/11/back-end-parallelism-in-the-rust-compiler.html) (inference on the second half; his post does not discuss linkers)

### Inferences

- Linker choice affects only the final link step, which for a debug-info-heavy binary is real but is not where thin-LTO time is spent. Link time on macOS with Apple's ld (ld-prime since Xcode 15) is typically seconds to tens of seconds; dsymutil dwarfs it (LLVM thread: link 1-2 s vs dsymutil 98 s on clang).

### Gaps

- Not found: ld-prime vs ld64 timings, rust-lld on aarch64-apple-darwin status, lld-link vs link.exe timings for Rust on Windows, any LTO-specific linker benchmark.

## 7. Known dump_syms CFI errors on macOS (`CfiError BadDebugInfo UnknownVersion`, `OffsetOutOfBounds`)

### Takeaway

No source documenting these exact error strings was found. `CfiError` and `BadDebugInfo` are in the `symbolic-cfi` crate used by dump_syms; the sources show bad macOS output has historically come from dsymutil/dSYM problems, not dump_syms. Whether the errors mean truncated or still-being-written input or >4 GiB dSYMs is unconfirmed.

### Cited Findings

- `symbolic-cfi` defines `CfiError` with kinds including `BadDebugInfo` ("debug information in the Object file is invalid") and `UnsupportedArch`; many Mach-O/DWARF parser errors are mapped to BadDebugInfo. — [docs.rs symbolic-cfi](https://docs.rs/symbolic-cfi/latest/src/symbolic_cfi/lib.rs.html)
- No `UnknownVersion` variant seen in the search summaries of that file (not read in full). — same
- Mozilla bug 1810249: wrong filenames/lines in macOS dSYMs traced to a dsymutil regression bundled with clang 15 (LLVM issue 60307), not dump_syms; `addr2line` on the raw dSYM showed the same bad data. — [Bugzilla 1810249](https://bugzilla.mozilla.org/show_bug.cgi?id=1810249)
- Mozilla/dump_syms open issues list has nothing on UnknownVersion/OffsetOutOfBounds in titles. — [dump_syms issues](https://github.com/mozilla/dump_syms/issues)

### Inferences

- `UnknownVersion` in a DWARF/Mach-O parser typically means a section header has an unexpected version field, which is consistent with garbage/truncated bytes (e.g. reading a file before dsymutil finished, or a corrupt/partial copy), and `OffsetOutOfBounds` is consistent with a section offset beyond file length (truncation or mismatch between object and dSYM). This is reasoning from error names, not a documented cause.
- Cheap diagnosis: check file size vs `dwarfdump --verify`/`dsymutil --verify`, re-run after `sync`, and confirm dsymutil exited 0 before dump_syms starts; compare the dSYM size against 4 GiB.

### Gaps

- No documented case of a >4 GiB dSYM breaking dump_syms found. The dump_syms 2.3.9 changelog and the symbolic repo issues were not searched directly.

## Cross-cutting summary for the report writer (opinion/inference, not measured)

- Highest-confidence cost drivers: (1) CGU=1 serializes the largest crate's LLVM work (rustc book, Nethercote); (2) `packed` adds a dsymutil run, classic dsymutil is ~1.4 cores; (3) any profile difference rebuilds every dependency (Cargo fingerprint source).
- Candidate low-cost symbol profile to test (untested): keep `lto="thin"`, test `codegen-units` 16 vs 1 for runtime; use `debug="line-tables-only"` for workspace crates and `package."*" debug=false`; same deps profile in both builds so the dependency cache is reusable; replace `packed` by running dsymutil (parallel linker if available) only on the final binaries, or measure `unpacked` + dsymutil manually.
