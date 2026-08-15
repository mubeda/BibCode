# Parallel Test Deadline Repair Design

## Status

Approved on 2026-08-15.

## Context

The final `vp run test` verification for the repeatable platform-validation
runbooks exposed two different failure sets across two otherwise identical
parallel workspace runs:

- `high_volume_rpc_stream_replaces_lagged_subscribers_and_retains_exact_caps`
  completed its functional work but crossed its test-only 30-second aggregate
  wall-clock assertion; and
- three `production::provider_runtime` tests crossed local two-second fixture
  watchdogs while the server, desktop, and web package suites competed for the
  same host resources.

Every implicated test passed when run alone. The activity test passed in 7.87
seconds and the full `activity_load` integration binary passed in 8.65 seconds.
The three provider tests passed alone in 0.34, 0.35, and 1.06 seconds. The
failure location therefore moves with workspace load rather than with a product
behavior change.

The documentation-only range that preceded the failures does not modify any
server, desktop, web, package, or script source.

## Goal

Make the affected server test coverage deterministic under the repository's
normal parallel workspace graph without changing production deadlines,
capacity, scheduling, cancellation, process ownership, or cleanup behavior.

## Non-Goals

- Do not serialize the workspace graph, Rust harness, or provider fixtures.
- Do not add a global lock, retry loop, or arbitrary scheduling sleep.
- Do not widen a production provider or process timeout.
- Do not weaken functional assertions for paging, retention, ordering,
  bounded memory, stream replacement, provider payloads, or process cleanup.
- Do not create a general benchmark framework in this repair.

## Chosen Design

### Activity load coverage

The activity RPC load test remains a correctness and bounded-resource test. It
will continue to assert all observable caps, exact retention envelopes, stream
replacement, subscriber cleanup, roster paging, and RSS bounds. Its elapsed
duration remains printed as diagnostic evidence.

The aggregate `started_at.elapsed() < 30 seconds` assertion will be removed.
That value measures host scheduling and concurrent package load in addition to
the activity implementation, so it is not a deterministic product contract.
Performance regressions remain visible in the emitted timing and can be
measured in an isolated performance run rather than making the correctness
graph flaky.

### Provider fixture coverage

Provider integration fixtures will use one absolute, test-only integration
deadline for the positive milestones exercised by each affected test. The
deadline is created once before the operation begins and is passed to
`timeout_at`; later stages consume the remaining budget instead of receiving a
fresh timeout.

The integration deadline is 15 seconds, matching the existing loaded provider
startup milestone coverage in the same module. It governs test observation
only. Provider production timeouts and the dedicated tests that prove those
production timeout/kill/reap contracts remain unchanged.

The affected tests must still observe their real boundary events:

- a Claude delivery returns its real outcome;
- expected stream-usage, authoritative-usage, MCP-status, and completion
  events arrive in order;
- captured fixture requests contain the exact provider payload; and
- shutdown and process ownership complete through the existing owners.

Filesystem capture content is the positive cross-process milestone already
published by the Unix shell and Windows PowerShell fixtures. The repair changes
only how long the integration observer may wait under package-graph load; it
does not replace the milestone with elapsed time or success-by-timeout.

## Alternatives

### Serialize the graph or test harness

Rejected. Serialization would hide real concurrency interactions, lengthen the
suite, and violate the repository's parallel-test contract.

### Increase production deadlines

Rejected. No production request exceeded a product deadline. The failures came
from test observers running beside other package suites.

### Keep the 30-second activity assertion with a larger number

Rejected. Any aggregate wall-clock threshold inside the shared correctness
graph still measures host contention and would eventually fail for the same
reason.

### Build a dedicated benchmark runner now

Deferred. An isolated benchmark is the correct future owner for a hard
performance budget, but it is larger than the smallest coherent reliability
repair. The existing elapsed and RSS diagnostics remain available meanwhile.

## Failure and Cleanup Semantics

An absent provider milestone still fails at the one absolute integration
deadline with a stage-specific message. Completion does not extend the
deadline by advancing to another stage. Existing driver shutdown,
cancellation, kill, and reap paths remain authoritative and must be awaited in
both success and failure coverage.

The activity test continues to fail immediately on any functional or bounded
resource violation. Only the nondeterministic aggregate elapsed assertion is
removed.

## Verification

Implementation uses strict RED to GREEN evidence:

1. Preserve the two recorded failing `vp run test` outcomes as the load RED.
2. Add or adjust focused coverage so an absolute provider fixture deadline is
   shared rather than reset between milestones.
3. Run the activity load exact test and full integration binary.
4. Run each affected provider exact test, then the provider-runtime test module
   at default, 8, and 12 harness threads.
5. Run `cargo fmt --all --check`, server Clippy with warnings denied,
   `vp check`, and `vp run typecheck`.
6. Run one fresh `vp run test` graph. A different failure stops verification
   and is reported rather than hidden or rerun blindly.

## Documentation Impact

No living runtime architecture changes. The new testing runbooks are reviewed
as part of this repair; they remain accurate because their commands and
platform procedures do not depend on the removed aggregate wall-clock guard or
private provider fixture deadline.
