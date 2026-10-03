# Unix recovery-test child watchdog

Approved on 2026-10-03 with the issue #26 design. This amendment records the
stable Rust API constraint and the private testing topology. Living validation
instructions are in [the flaky-test runbook](../testing/flaky-tests.md).

## Ownership and scope

`apps/server/tests/turn_delivery_recovery.rs` owns this helper. It is private
integration-test support; production process ownership, application protocols,
providers, persistence, dependencies, and the Windows direct helper do not
change.

On Unix, the test parent re-executes one ignored, exactly selected monitor
fixture as a new process-group leader. The parent exclusively retains the
monitor's stdin writer as a lifetime lease. The monitor reads one lossless
framed command request, then arms an independent EOF watcher before spawning
the requested child with null stdin and fresh captured stdout/stderr. That
child and descendants inherit the monitor's group. EOF kills that group while
its leader still exists. A monitor cleanup guard does the same on errors or
unwind.

The monitor's stderr is a separate framed result transport; ordinary libtest
stdout is drained as monitor diagnostics. Child output uses incremental binary
frames. Completion carries the real child's raw wait status, including signal
termination, rather than the monitor's final SIGKILL. After the real child
exits, nonblocking capture drains available output under the caller's absolute
deadline, emits and flushes completion, and kills the owned group. It does not
wait for a descendant to close inherited output pipes. The parent validates
framing and reaps the monitor before returning output.

The parent keeps one absolute deadline beginning before monitor startup,
including nonblocking configuration transmission and result collection. On
timeout or protocol failure it kills the owned group before reaping the leader;
diagnostic collection shares one bounded cleanup budget. No saved group ID is
signaled after ownership of the leader ends.

## Stable command configuration

Rust 1.98 cannot inspect whether an opaque `Command` cleared its environment,
nor recover stdio, argument-zero, identity, group, or pre-exec policy. Its
stable environment getter omits inherited values. A getter-only clone would
silently lose behavior; parsing `Debug`, using unstable getters, and an
unsupervised fallback are rejected.

The six existing callsites construct a narrow private `ChildCommandSpec`
directly. It records program, arguments, optional cwd, environment inheritance,
and explicit overrides/removals. Clear mode clears earlier mappings; later
overrides win. Unix request fields encode OS strings as bytes. Fixed null and
captured stdio and monitor-owned grouping are helper policy. The API cannot
accept an opaque `Command`, hooks, custom identity, stdio, or group policy.
The same spec builds the unchanged direct command on Windows.

The monitor selector's original inherited value is carried separately and
restored before child overrides/removals; clear mode stays clear. This avoids
polluting or deleting an existing variable in the requested child's environment.

## Alternatives and acceptance

Linux parent-death signals exclude macOS and do not cover a whole descendant
group. A watchdog inside the real child dies before late descendants. A monitor
outside the group needs a separate group-leader lifetime handshake. The
approved group leader keeps cleanup tied to a retained identity, at the cost of
one small harness process and framing overhead that must be measured.

Acceptance requires native Linux and native macOS parent SIGKILL and SIGINT
cases with readiness-proven child/grandchild identities and an unaffected
owned peer. It also requires real success/nonzero/signal/binary output,
lossless configuration, root exit with descendant-held pipes, deadline,
startup/protocol/cancellation failure, harmless fixture listing, monitor reaping,
and the complete recovery target. Existing 100 ms and 250 ms deadlines remain
fixed. Paired alternating base/change measurements must report median/p95 and
failures before claiming no meaningful normal-run regression.

The claim covers descendants retaining the owned group. A descendant starting
another group or session remains outside this mechanism and is cleaned only
by its explicit test owner. Native evidence and measurements belong in the
execution report, not this design or living runbooks.
