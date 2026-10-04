# OpenCode repeated handoff investigation

**Result: PASS WITH RESIDUAL RISKS.** Issue [#36](https://github.com/mubeda/BibCode/issues/36)
was not reproduced in 200 isolated invocations or three complete supervisor
suite runs. Preserve the current ordering and assertions; there is no observed
cause that justifies a product change or a longer timeout. A future occurrence
must retain its exact assertion and receive a new baseline/change comparison.

## Revision and environment

Measured on `codex/fix-github-issues` at `102691a32`, macOS 27.0.1 build
26A434, ARM64, Rust/Cargo 1.98.1 (Homebrew). Other issue work was unstaged,
including the test-only hermetic guard in Report mode. No change for #36 was
made to product or test source. This is current-branch characterization, not a
clean-baseline versus changed-runtime experiment.

The executable was selected from Cargo's compiler-artifact JSON for
`provider_terminal_supervisor`; its SHA-256 was
`cb899cdd1b466800ad1dc88352c2f00904bb27d17ed564f19af74c34320ddd1d`.

## Execution

```sh
cargo test -p bibcode-server --test provider_terminal_supervisor \
  --no-run --message-format=json -j2
BIBCODE_HERMETIC_GUARD=report "$test_binary" \
  agent_activity_toggle_opencode_repeated_handoffs_return_to_one_stream \
  --exact --nocapture
BIBCODE_HERMETIC_GUARD=report "$test_binary" --nocapture
```

The exact-test invocation ran 200 times through an eight-process executor.
All 200 ran exactly one test and passed, in 3.251 seconds aggregate. The full
binary then ran three times at its default harness concurrency: 101/101 tests
passed each time, in 6.68, 6.55, and 6.41 seconds. No test name or failure
signature was hidden by retrying a failed invocation; none failed. No hermetic
guard refusal appeared in the three full-suite logs.

Evidence is retained in `/tmp/bibcode-issue-fixes-20261001/`:
`issue36-build.jsonl`, `stress-opencode-handoffs.py`,
`issue36-isolated/results.json` and its 200 logs, `issue36-stress.log`, and
`issue36-full-suite-{1,2,3}.log`. These local artifacts are execution evidence,
not required repository tooling.

## Why no speculative fix

The handoff waits for the activity transition and replaces the prior stream
before publication. The fixture decrements its open-stream count synchronously
when the old stream is dropped. The test therefore retains its immediate
one-stream assertion, epoch increments, maximum-two overlap bound, unchanged
history count, and retained helper-process check.

The historical one-off failure has no preserved assertion in the issue. These
runs do not prove that every host or load pattern is flake-free, and they do
not establish a general supervisor-suite failure rate. Since there was no
reproduction, the issue's conditional root-cause/differential step was not
triggered. The decision is to record this non-reproduction and retain the
existing behavioral pin, rather than classify the suite as inherently flaky.
The flaky-test runbook was reviewed and remains accurate.
