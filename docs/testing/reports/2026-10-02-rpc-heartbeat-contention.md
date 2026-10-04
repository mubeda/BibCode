# RPC heartbeat contention investigation

**Result: PASS WITH RESIDUAL RISKS.** Both the original and revised test passed
300 native Linux trials under the same one-CPU contention profile. The natural
failure in [#39](https://github.com/mubeda/BibCode/issues/39) did not reproduce.
Controlled-clock regressions demonstrate that the old fixed observation window
could end before enough heartbeats arrived. The repair measures survival and
answered heartbeats independently; production heartbeat and silence limits are
unchanged.

## Revision and environment

[Qualification run 36982908757](https://github.com/mubeda/BibCode/actions/runs/36982908757)
ran the disposable qualification commit
`a1b0b21e32b00c39ce14f56392581f0b4ef1c04d` on Ubuntu 24.04.5 x86_64,
Linux 6.17.0-1022-azure, an Intel Xeon 6973P-C, and Rust 1.98.0.
Both test binaries used identical current production source. The baseline
replaced only `rpc_liveness.rs` with its original test source at
`102691a329e84e7422348a44e192e560e57280fa`; it is not an old production build.

Both binaries were compiled before contention began. Each phase ran 16
concurrent test processes and one CPU worker, all pinned to CPU 0. Each process
had a 1,500-second limit and each phase a 2,400-second limit. Every invocation
selected exactly `an_idle_client_that_answers_pings_is_kept_past_the_silence_limit`
and used a private fixture HOME with the hermetic guard's default Abort mode.

## Evidence

| Check                                  | Result                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original test, native Linux contention | 300 executed, 300 passed, zero failures; 1,165.197 seconds                                                                                               |
| Revised test, identical contention     | 300 executed, 300 passed, zero failures; 1,166.805 seconds                                                                                               |
| Controlled-clock regressions           | Three passed: delayed fourth heartbeat, early four heartbeats, bounded missing heartbeats                                                                |
| Transport unit group                   | 23 passed                                                                                                                                                |
| Execution and cleanup audit            | All 600 processes ran exactly one test and were reaped; no timeout, log overflow, or survivor; both CPU workers reaped and private fixture roots removed |

The old observation ended at a fixed wall-clock deadline and separately
asserted a minimum heartbeat count. Scheduler delay could violate the count
without proving incorrect server liveness accounting. The revised helper
requires both at least 60 seconds of survival and four answered heartbeats,
with a separate 180-second bound. It still fails on a closed socket or a
bounded lack of progress. A dropped teardown observer no longer adds a second
panic while the primary failure is unwinding.

Source hashes recorded by the workflow:

- Baseline test SHA-256:
  `33c06368dbcde17bfecfb9e6de737e499eb4fa9839cfcf19140304bf5999ce28`.
- Revised test SHA-256:
  `3d2691b1a19e751f7e8c2608417f7cbc7a4fe86d60dbd6c309d9d10fdf6517a4`.
- Baseline executable SHA-256:
  `8188ba2f4c58f6fd893ea27808614326bfb7b72c9f1927fad00f7121078acc6f`.
- Revised executable SHA-256:
  `af2c9a3f348c20f5fad20c24c46c42428e5a2b7a28836d952823d35adacf0f59`.

Commands and driver source are retained at the immutable qualification commit:

```sh
cargo test --locked -p bibcode-server --test rpc_liveness --no-run -j 2 --message-format=json
cargo test --locked -p bibcode-server --lib --no-run -j 2 --message-format=json
python3 -B scripts/rpc-liveness-qualification.test.py
python3 -B scripts/rpc-liveness-qualification.py run \
  --evidence-root "$RUNNER_TEMP/issue39-evidence" \
  --baseline-binary "$RUNNER_TEMP/issue39-binaries/baseline" \
  --fixed-binary "$RUNNER_TEMP/issue39-binaries/fixed"
```

The workflow resolves executable paths from Cargo's compiler-artifact JSON and
invokes the driver with separate baseline and fixed binaries. Its full command
and all bounds are recorded in
`.github/workflows/rpc-liveness-qualification.yml` at that commit. The temporary
workflow and driver are qualification artifacts, not additions to normal CI.

Downloaded evidence is retained locally at
`/tmp/bibcode-issue-fixes-20261001/issue39-ci-native-result/`: `source.json`,
`qualification.json`, both phases' `results.json` and before/after process
records, all 600 bounded per-trial logs, and controlled-clock/transport logs.
The GitHub artifact is `issue39-linux-36982908757-1` (seven-day retention).

The original isolated Linux baseline also passed 300/300 in 1,155.891 seconds;
that earlier run is separate evidence. These green natural baselines do not
demonstrate a measured reduction in the historical failure rate. Ordinary CI
at a revision containing the final repair remains a separate completion gate.
The affected flaky-test runbook was updated; native process and cleanup
procedures were reviewed and remain accurate.
