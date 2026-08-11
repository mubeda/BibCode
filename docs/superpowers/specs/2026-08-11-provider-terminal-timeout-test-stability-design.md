# Provider Terminal Timeout Test Stability

## Context

The final workspace test graph exposed two provider-terminal unit-test failures
only while the complete Rust suite was competing for host CPU and process
scheduling:

- Claude's bounded-output probe exhausted the production two-second probe
  timeout while its shell fixture emitted and drained two large streams.
- Codex's cancellation-before-readiness test exhausted a two-second test
  watchdog before its helper shell wrote the positive process-start marker.

Both tests pass independently. The failures do not show that the production
deadlines are too short; they show that the tests combine production timing
policy with a separate host-scheduling observation bound.

## Decision

Keep all production deadlines and failure behavior unchanged.

The system Claude probe runner will continue to use a two-second timeout by
default. Its private construction will accept an explicit timeout so the
bounded-output test can exercise the real process-supervision and truncation
path with a generous test-only deadline. No public API or provider behavior
changes.

The Codex cancellation test will retain the real helper supervisor, readiness,
cancellation, and reap paths. Only its outer watchdog for observing the helper's
PID marker will increase. The production three-second readiness timeout and
two-second reap timeout remain unchanged.

## Alternatives Rejected

- Increasing production deadlines would make genuine provider failures slower
  without evidence that runtime behavior is incorrect.
- Globally serializing provider process tests would reduce useful concurrency,
  lengthen the suite, and hide rather than isolate the scheduling assumption.
- Retrying failed tests would conceal nondeterminism and provide weaker
  evidence than separating product deadlines from test watchdogs.

## Verification

The existing failing tests are the regressions. Verification will include:

1. each exact test after the change;
2. repeated focused execution to exercise process creation and cleanup;
3. the complete provider-terminal unit module;
4. the full `vp run test` workspace graph;
5. `vp check`, `vp run typecheck`, Rust formatting, Clippy with warnings denied,
   and final diff/status review.

The production timeout constants will remain unchanged and the tests will
continue asserting bounded output, cancellation ownership, and child reaping.
