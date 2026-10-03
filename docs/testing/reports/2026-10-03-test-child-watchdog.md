# Test-child watchdog native validation

**Result: PASS WITH RESIDUAL RISKS.** This report covers the private Unix test-child watchdog and its paired native measurements. It does not qualify a product release or every supported OS/version.

## Tested revisions and environment

- Repository: `mubeda/BibCode`.
- Exact baseline: `7e8722dbd72d1180992a63512b3bd7b34437d343`.
- Exact qualified candidate: `6b93d9b0e1705ade63177a2171a1e4d3fb135b98` on `codex/fix-test-watchdog`.
- Native run: [37138099818](https://github.com/mubeda/BibCode/actions/runs/37138099818), attempt 1; both jobs passed.
- Linux: Ubuntu 24.04 runner, x86_64, kernel `6.17.0-1022-azure`.
- macOS: macOS 26 runner, arm64, Darwin `25.6.0`.
- Both builds used the repository-pinned Rust/Cargo 1.98.0. GUI, WSL, signing and installer capabilities were not involved.
- The baseline and changed checkouts built separate integration executables before measurements. Native evidence retains both Git SHAs, binary SHA256 digests, compiler-artifact JSON, complete/ignored enumerations and every invocation log.

## Focused validation

| Native target | Baseline full target | Changed full target  | Watchdog filter | Result |
| ------------- | -------------------- | -------------------- | --------------- | ------ |
| Linux x86_64  | 16 passed            | 30 passed, 4 ignored | 14 passed       | PASS   |
| macOS arm64   | 14 passed            | 28 passed, 4 ignored | 14 passed       | PASS   |

The selected native acceptance cases prove parent SIGKILL and SIGINT cleanup of the requested child and grandchild, descendant-held output cleanup, monitor reaping, independent peer survival, deadline/configuration failure cleanup, lossless command/environment framing and real raw exit/signal results. Every driver invocation succeeded; no empty test filter counted as a pass.

Exact native build and fixture commands:

```sh
cargo test -p bibcode-server --test turn_delivery_recovery --no-run --message-format=json -j 2
# Invoke the exact executable obtained from each side's compiler-artifact JSON:
TEST_BINARY --list
TEST_BINARY --list --ignored
TEST_BINARY --exact child_deadline_kills_and_reaps_a_stalled_child_and_reports_timeout --nocapture
TEST_BINARY --exact child_deadline_returns_complete_output_on_normal_exit --nocapture
# Linux only:
TEST_BINARY --exact child_deadline_bounds_output_collection_when_a_descendant_escapes --nocapture
CHANGED_TEST_BINARY child_watchdog_ --nocapture
TEST_BINARY
```

## Paired latency and reliability

Each common case used two warmup pairs followed by ten measured pairs. Order alternated base/change and change/base. Compilation finished before either side was timed. All warmup and measured runs passed. Median/p95 are wall time in milliseconds for an exact fixture invocation, including executable startup; they are not production provider timings.

| Host/case                      | Base median | Changed median | Median delta | Relative delta | Base p95 | Changed p95 |
| ------------------------------ | ----------: | -------------: | -----------: | -------------: | -------: | ----------: |
| Linux: stalled-child deadline  |      110.09 |         110.57 |        +0.48 |         +0.44% |   111.07 |      112.46 |
| Linux: normal complete output  |       76.16 |          62.85 |       -13.32 |        -17.48% |   106.24 |       64.95 |
| Linux: escaped-pipe collection |     1270.07 |         270.56 |      -999.51 |        -78.70% |  1270.64 |      270.83 |
| macOS: stalled-child deadline  |      128.80 |         117.76 |       -11.04 |         -8.57% |   194.61 |      126.33 |
| macOS: normal complete output  |      242.17 |         145.51 |       -96.66 |        -39.92% |   309.39 |      221.43 |

Normal-output median and p95 improved on both observed hosts. Linux stalled-deadline median increased 0.48 ms (0.44%) and p95 increased 1.39 ms; its original timeout/cleanup assertions still passed. macOS stalled-deadline timings improved. Linux escaped-pipe collection improved by about one second. These paired observations show no meaningful measured latency/reliability regression in the selected workloads; they do not establish a universal performance bound. Full-target durations have different test inventories and are not used as a like-for-like overhead comparison.

## Source, cleanup and documentation

The approved implementation is private test infrastructure: an explicit command spec, re-executed Unix group-leading monitor, parent-only pipe lease and framed output/raw status. Windows keeps the direct helper flow. Production runtime, protocol, persistence, provider processes and dependency versions are unchanged by this issue.

The sustained-output regression was repaired after independent review. Its writer proves actual successful writes and real pipe backpressure before atomic readiness publication; observed output and root release are required. Unrelated framing/protocol failures cannot satisfy the deadline branch. Both source revisions and the temporary native evidence driver received independent review.

The observed process-death/cleanup assertions use exact owned PIDs/groups and verify peer survival. Independently daemonized descendants that create new sessions/groups remain outside monitor ownership and retain their explicit fixture owner. User applications, profiles and installations were not used. The four private ignored fixtures require explicit selection/markers and were not counted as active acceptance passes.

`docs/testing/flaky-tests.md` and `docs/testing/cross-platform-validation.md` were updated with the owned monitor/lifecycle procedure. Shared/native platform procedures were reviewed and remain accurate. The temporary qualification workflow replacement and Python comparison driver remain on the qualification branch and are excluded from the release patch.

## Residual risks and publication state

Native coverage is Linux x86_64 and macOS arm64 on the recorded runner versions; native Windows runtime behavior and other Unix versions/architectures are not claimed. Source/native evidence qualifies the private helper; integrated release-branch checks are recorded by the issue-fix coordinator before its final commit. No release/tag or installed-product qualification is implied by this report.
