# Event-Driven VCS Observation Design

**Date:** 2026-08-20

## Outcome

Replace high-frequency evidence-free Git polling with execution-host-owned
change signals while preserving active-workspace responsiveness, external
terminal/editor reconciliation, inactive-sidebar branch and PR freshness,
remote/WSL correctness, and bounded recovery from missed watcher events.

This design begins only after VCS core coordination and File Manager indexing
measurements are available.

## Consumer Classes

### Active full-status consumers

Source Control, Files Git decorations, Git actions, Diff/Chat repository gates,
and the branch toolbar consume full status for the active worktree. They receive
event-driven updates and retain a 60-second safety fallback.

### Passive sidebar consumers

Inactive primary rows, worktree/thread rows, and command-palette rows consume a
lightweight summary containing:

- repository state;
- current branch/detached identity;
- dirty state;
- source-control provider; and
- branch-matched PR state needed by the existing indicator.

Passive summaries have a 30-second freshness budget. They do not compute
numstats, list full file rows, or initiate automatic fetch independently.

The summary is server-owned. The renderer does not derive it from static thread
metadata or remove indicators while a refresh is pending.

Passive VCS state remains orthogonal to thread/session delivery state. A summary
update cannot replace or suppress the session-error row, provider-versus-BiBCode
error attribution, or the unresolved failed/uncertain delivery row introduced
by the provider error-attribution work. VCS summaries are not stored by writing
complete thread or session projections.

## Execution-Host Watcher

The host that executes Git owns filesystem observation:

- native server for native workspaces;
- the selected WSL distro for WSL-routed workspaces; and
- the SSH/remote server for remote workspaces.

No client-side watcher interprets a path from another host.

The watcher observes the active working tree recursively plus the worktree Git
administrative files needed for branch/index/ref changes. It emits invalidation
signals only; Git status remains the authoritative snapshot.

Signals include:

- working-tree file create, modify, rename, and delete;
- per-worktree `HEAD`, index, and operation metadata changes;
- selected upstream-ref changes;
- completed BiBCode terminal commands for the active worktree; and
- every in-app workspace or Git mutation.

Provider turn completion, assistant-message settlement, and delivery-error
projection are not Git invalidation signals. Provider completion may trail the
final assistant message by tens of seconds, so using it as a refresh trigger
would recreate turn-correlated Git churn and conflate provider latency with VCS
freshness.

Watcher bursts debounce for 125 ms and feed the server status owner. The owner
retains one trailing invalidation and applies the mutation-epoch rules from the
VCS core design.

## Polling and Visibility

The active full-status safety interval is 60 seconds. Passive summaries refresh
within 30 seconds. Slow reads stretch their next evidence-free safety interval
up to five minutes so a slow workspace never approaches a continuous Git duty
cycle.

Desktop/browser visibility suppresses client-requested evidence-free refreshes,
but a headless server does not infer that every client is hidden. Server work
continues only while it has an active full or passive subscriber. Reveal or
reattachment requests one catch-up refresh.

The three-second Git ref poll is removed only after watcher, terminal, passive
summary, and safety-fallback coverage passes on native Windows, Linux, macOS,
WSL, and SSH paths.

## Failure Behavior

Watcher setup failure, overflow, interruption, or unsupported filesystems enter
polling fallback; they do not report a healthy watcher. A later successful
watcher installation may replace fallback under a lifecycle generation.

Watcher errors never clear the last usable status or sidebar summary. Loss of a
remote connection is unavailable/stale state, not evidence of a clean worktree
or missing branch.

Status reads remain bounded and cancel when their final owner leaves. A missed
event is bounded by the safety interval.

## Wire and Compatibility

The existing full-status subscription remains compatible. Passive summary is a
new typed subscription/capability; older servers make the client retain the
current full-status behavior rather than silently dropping sidebar freshness.
The RPC inventory, authorization scope, Rust/TypeScript wire fixtures, and
active-method parity counts change together when the summary subscription is
introduced.

The contracts package remains schema-only. Runtime watcher and scheduling logic
stays in the server and client-runtime owners.

## Success Criteria

- An active external file edit appears after one debounced status read.
- A terminal branch switch updates branch toolbar and thread metadata without a
  three-second Git poll.
- Inactive sidebar branches and PR badges reconcile within 30 seconds.
- Session failure attribution and failed/uncertain delivery rows remain visible
  and correct while passive VCS summaries update.
- A hidden/revealed client receives one catch-up refresh.
- Watcher overflow or failure converges through the 60-second safety path.
- With automatic fetch disabled and no filesystem activity, an active physical
  repository starts at most one Git status read per minute and passive summaries
  do no full-file/numstat work.
- Subscriber release stops watcher and fallback ownership without leaking a
  later publication into reattachment.

## Alternatives Rejected

- **Active-only status with no passive summary:** regresses live sidebar branch
  names and PR badges.
- **File Manager directory-mtime watcher:** misses in-place content changes.
- **Watcher with no fallback:** cannot meet remote/network filesystem or
  overflow reliability requirements.
- **Client-owned watching:** violates native/WSL/SSH execution ownership.
- **Remove the three-second ref poll first:** creates an unbounded branch
  freshness gap during migration.
