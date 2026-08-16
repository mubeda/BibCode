# Git Status Integration Deadline Design

## Status

Approved on 2026-08-15.

## Context

A fresh `vp run test` at merged HEAD `3a90bdd5` passed all TypeScript tests but
failed the server integration test
`project_file_save_publishes_git_status_without_waiting_for_the_fallback_poller`.
The public `projects.writeFile` call succeeded, but the subscribed dirty local
Git-status event did not arrive inside the test's two-second wall-clock wait.
The same exact test passed immediately afterward in isolation.

Production local invalidation is already owned by a dedicated repository task
independent of remote/ref work. Its deterministic owner test blocks remote Git
work, positively observes a second local scan, receives the dirty
`LocalUpdated` event, and verifies cancellation on final subscriber drop. The
public integration test's two-second limit is not a documented product SLO; it
was previously 750 milliseconds and was widened for loaded Windows runners.
The production fallback local-status interval is 30 seconds.

## Goal

Keep the public RPC integration test deterministic under the normal parallel
workspace graph while still proving that a successful project write publishes
the real dirty local Git-status event before the 30-second fallback poller.

## Non-Goals

- Do not change production Git scheduling, polling, process execution,
  cancellation, publication, queues, or timeouts.
- Do not serialize the package graph or Rust test harness.
- Do not add sleeps, yields, retries, global locks, or mocked Git publication.
- Do not weaken the exact `localUpdated`, dirty-state, request-ID, and file-path
  assertions.
- Do not define a two-second product performance SLO in a correctness test.

## Chosen Design

The public integration test creates one absolute 15-second Tokio deadline
immediately before sending `subscribeVcsStatus`, before that request can create
the broadcaster owner. Subscription setup, the initial clean snapshot, the
initial `remoteUpdated` event, the `projects.writeFile` response, and the real
dirty `localUpdated` event share that operation window. One outer `timeout_at`
governs the complete sequence, so no later milestone can restart the budget.

Success still requires the real `localUpdated` event for request `703`, a dirty
working tree, and `tracked.txt`. The test prints elapsed publication time as
diagnostic evidence after receiving the event. Fifteen seconds is test-only and
remains strictly below the unchanged 30-second fallback interval, so success
cannot come from the fallback poller.

The deterministic `StatusBroadcaster` owner test remains the concurrency
contract: local invalidation must start and publish while remote refresh is
positively blocked, and final subscriber removal must cancel that remote owner.
Together, the owner test proves scheduling independence and the public test
proves end-to-end RPC wiring.

## Alternatives

### Preserve the hard two-second threshold

Rejected. It fails only under the shared package graph and measures host
scheduling plus Git subprocess admission rather than a documented product
contract.

### Increase the production fallback or process timeout

Rejected. Production behavior is not the failing boundary and must remain
unchanged.

### Replace real Git work with a fake runner in the public test

Rejected. That would weaken the end-to-end contract. The existing owner-level
test already provides deterministic controlled-runner coverage.

### Serialize the test graph

Rejected. Serialization would hide the load condition, slow validation, and
violate the repository's parallel-test requirements.

## Failure and Cleanup Semantics

If subscription setup, either initial event, the write response, or the positive
dirty status does not arrive before the one absolute deadline, the test fails
with stage-specific context. WebSockets and the server runtime retain their
existing explicit close, shutdown, and join paths. No fallback success, retry,
or extra operation deadline is introduced.

## Verification

The preserved full-graph failure is the RED evidence. Verification will:

1. run the exact public Git-status integration test;
2. run the deterministic broadcaster owner test;
3. run the complete `production_git_vcs_rpc` integration binary at default,
   8, and 12 harness threads;
4. resume the Windows E2E plan's full `vp run test`, Rust workspace, formatting,
   Clippy, `vp check`, and typecheck sequence; and
5. stop on any different failure instead of rerunning or repairing it blindly.

## Documentation Impact

No living runtime architecture changes. The architecture already documents the
independent local-status owner. This spec records only the test-observation
contract; testing runbooks remain accurate.
