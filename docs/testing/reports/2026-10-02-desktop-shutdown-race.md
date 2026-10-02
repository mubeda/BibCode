# Desktop shutdown-race investigation

**Result: PASS WITH RESIDUAL RISKS.** The historical natural flake in
[#23](https://github.com/mubeda/BibCode/issues/23) did not reproduce. A controlled
port-reuse case proved the old TCP assertion could fail after correct cleanup.
The revised test observes its exact runtime and detects an intentionally broken
cleanup ordering. Production lifecycle behavior is unchanged.

## Revision and environment

Measured on `codex/fix-github-issues` at `102691a32`, with concurrent issue work
unstaged. Host: macOS 27.0.1 build 26A434, ARM64, Rust/Cargo 1.98.1 Homebrew.
Every executable came from Cargo compiler-artifact JSON.

## Evidence

| Check                                                                    | Result                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Original test, 200 processes, eight concurrent, 12 CPU workers           | 200 passed, zero failed; 11.318 s aggregate                                                                               |
| Old TCP assertion with a different listener reusing its released address | Failed the cleanup assertion, 0.27 s                                                                                      |
| Revised test, temporary mutation returning before runtime join           | Failed `start must await this runtime's join`, 0.29 s                                                                     |
| Revised test, identical 200/eight/12 stress                              | 200 passed, zero failed; 17.099 s aggregate                                                                               |
| Full backend unit group                                                  | 94 passed                                                                                                                 |
| Full desktop package with guard in Report mode                           | 449 library and nine nonignored integration tests passed; six SSH integration tests ignored by default; no guard refusals |
| Desktop Clippy, all targets, warnings denied                             | Passed, 20.84 s                                                                                                           |

The two temporary mutations were removed before the fixed build. All owned
CPU workers were killed and reaped after each stress phase. The baseline test
executable SHA-256 was
`f29ebe63b4b43be70dc25233fc48e810aa365a8db20957a0830c323a7b24ecf8`;
the fixed executable SHA-256 was
`51c934c01a7e50acfebace66e53318f4f445ef4789a39a6f53874cb87e9c15bb`.

Commands:

```sh
cargo test -p bibcode-desktop --lib --no-run --message-format=json -j2
cargo test -p bibcode-desktop --lib backend::tests -j2
BIBCODE_HERMETIC_GUARD=report cargo test -p bibcode-desktop -j2
cargo clippy -p bibcode-desktop --all-targets -j2 -- -D warnings
python3 /tmp/bibcode-issue-fixes-20261001/stress-backend-start-stop.py fixed
```

The external harness invoked the exact selected test once per process, rather
than assuming `--test-threads=8` creates eight copies of a single test. The gate
holds the specific runtime's join, observes its stop-request event, and verifies
both callers remain pending. The test then captures the join result without
an intervening yield when `start` returns.

Detailed logs and per-run results remain under
`/tmp/bibcode-issue-fixes-20261001/`: `issue-23-baseline/`, `issue-23-fixed/`,
`issue-23-port-reuse-red.log`, `issue-23-ordering-mutant.log`,
`issue-23-backend-suite.log`, `issue-25-desktop-report.log`, and
`issue-25-desktop-clippy.log`. The shared desktop run includes the separate
hermetic-fixture work; it is not an isolated clean-commit comparison.

These results demonstrate an identity-safe, ordering-sensitive assertion.
They do not establish a reduction in the historical natural failure rate,
which was zero in both measured stress phases. The flaky-test runbook was
updated; native macOS process procedures were reviewed and remain accurate.
