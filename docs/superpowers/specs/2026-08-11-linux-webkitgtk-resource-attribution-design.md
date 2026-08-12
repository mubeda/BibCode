# Linux WebKitGTK Resource Attribution

## Goal

Include every WebKitGTK helper process that the running BiBCode desktop
instance owns in Resource Manager's **BiBCode Core** totals on Linux. Main and
native Preview WebViews must receive the same fail-closed treatment as the
WKWebView and WebView2 helpers on macOS and Windows.

The implementation must prefer an honest `partial` or `unavailable` result to
claiming an unrelated process. It must not require elevated privileges, a
production helper sidecar, a WebKit process extension, or a private WebKitGTK
ABI.

## Current Problem

`apps/desktop/src-tauri/src/backend/ui_process_observer.rs` constructs a
platform observer for macOS and Windows. Linux falls through to
`UnavailableDesktopUiProcessObserver`, which always returns no process
identities. The server therefore cannot append any exact `core/ui` claims.

Depending on WebKitGTK's process topology, an unclaimed helper that remains a
descendant of the combined Tauri host/server may appear as
`external/unknown/fallback`; a helper outside that descendant tree is omitted
from Combined entirely. Resource Manager correctly reports UI coverage as
unavailable, but Linux Core and Combined totals omit or misclassify native UI
usage.

The current living documentation deliberately calls Linux unsupported and
forbids generic browser or renderer executable-name matching. The new observer
must preserve that trust boundary.

## Requirements

- Attribute Linux WebKitGTK Web, Network, and GPU helper roots only with exact
  current-instance evidence.
- Cover helpers shared by the main WebView and helpers created for native
  Preview WebViews.
- Preserve PID-reuse safety by validating PID plus `/proc` start identity.
- Keep observation demand-driven and bounded by the existing server observer
  deadline.
- Reuse the current native process snapshot; do not add another machine-wide
  refresh or background polling loop.
- Exclude another application's WebKitGTK processes and WebKitGTK processes
  launched inside a registered provider or terminal subtree.
- Preserve Windows, macOS, headless, remote-host, process-signal, and RPC
  contract behavior.
- Fail closed on unrecognized process topology, executable identity, or
  permission failures.

## Non-goals

- Discover generic WebKitGTK processes by name across the machine.
- Attribute browser processes launched by providers or terminals to Core.
- Add a WebKit process extension, native sidecar, eBPF probe, cgroup manager,
  or elevated capability.
- Change Resource Manager layout, aggregation contracts, sampling cadence, or
  signal eligibility.
- Promise support for an unobserved Linux process topology. A topology that
  contradicts the packaged-runtime probe requires a design amendment before
  implementation continues.

## Chosen Approach

Add a Tauri-owned `LinuxDesktopUiProcessObserver`. It discovers candidates only
among immediate children of the combined Tauri host/server process in the
existing immutable `ProcessRow` snapshot. It then validates each candidate's
stable identity and executable through `/proc` before returning it as a
`ProcessIdentity`.

Immediate parentage is the instance-specific ownership authority. An
executable role match validates that the child is a WebKitGTK helper; the role
name is never used as machine-wide discovery evidence. Registered provider and
terminal roots retain precedence over UI claims as a defense against a
directly launched external executable that happens to use a WebKit helper
name.

The initial strict role set is:

- `WebKitWebProcess`;
- `WebKitNetworkProcess`; and
- `WebKitGPUProcess`.

Implementation begins with a packaged AppImage probe on the supported Linux
target. The probe must confirm these executable basenames and immediate-parent
relationships for the main and Preview WebViews. If any expected helper uses
an intermediary parent, a different basename, or a topology that cannot be
proved from current process identity, implementation stops and this design is
amended; the allowlist is not widened opportunistically.

## Alternatives Considered

### WebKit process-extension handshake

A WebKitGTK web-process extension could report its process PID and Web page
identifier to the UI process. This provides strong Web-process ownership, but
it does not cover the shared Network or GPU helpers. It also adds a separately
packaged native library, initialization ordering constraints, and an AppImage
runtime surface solely for diagnostics. It is rejected for the first Linux
implementation.

### Private WebKitGTK internals

Internal WebKit APIs may expose auxiliary process identifiers. Calling them
dynamically could resemble the macOS private-selector solution, but Linux
distributions ship materially different WebKitGTK builds and ABIs. Depending
on private symbols would be fragile across the supported system-WebKit model
and is rejected while a stable `/proc` ownership proof is available.

### Generic name plus descendant matching

Scanning the machine for WebKit helper names, or accepting any descendant with
one of those names, would maximize apparent coverage. It cannot distinguish a
provider-owned WebKit subtree from BiBCode UI and violates the existing
fail-closed attribution invariant. It is rejected.

## Architecture

### Platform observer factory

Add `apps/desktop/src-tauri/src/backend/ui_process_observer/linux.rs` and select
`LinuxDesktopUiProcessObserver` from `ui_process_observer::for_app` under
`#[cfg(target_os = "linux")]`.

The factory constructs the observer while handling the live `AppHandle`, but
the observer does not retain an otherwise unused platform object. Installation
through this factory proves that the observer belongs to a desktop host;
process ownership comes from the server identity and Linux process records
rather than WebView count or generic names.

`BackendSupervisor` continues to retain one observer and reuse it for initial
start and restart. The in-process server receives the observer through the
existing `ServerRuntime::start_with_ui_process_observer` boundary.

### Candidate discovery

For each immutable native snapshot:

1. Locate the exact server row using `server_identity`.
2. Select only rows whose `ppid` is the server PID.
3. Reject an edge when the server start identity is later than the child start
   identity.
4. Use the first command element only as a bounded hint that the row may be one
   of the three supported WebKitGTK roles.
5. Validate the candidate through Linux `/proc` as described below.

The observer does not traverse arbitrary descendants. A provider or terminal
WebKit helper has its registered external root between it and the server and is
therefore not a candidate.

### Stable identity and executable validation

For each hinted immediate child:

1. Read `/proc/<pid>/stat` and require its parent PID and start ticks to equal
   the immutable snapshot row.
2. Resolve `/proc/<pid>/exe` and require the executable basename to equal the
   hinted strict WebKitGTK role.
3. Read `/proc/<pid>/stat` again and require the same parent PID and start
   ticks. This closes the PID-reuse window around executable inspection.
4. Return the snapshot's existing `ProcessIdentity`; do not create a new time
   domain or replace native sampler values.

The Linux stat parser and process-identity comparison belong to native
diagnostics. The implementation should expose or reuse the existing parser
rather than create a divergent start-identity interpretation in the desktop
crate. `/proc/<pid>/exe` inspection remains Linux observer policy.

Permission denial, process exit, malformed stat data, a changed identity, a
non-file executable target, or a role mismatch rejects that candidate. Error
messages name only the failed boundary and role; they do not publish the
resolved executable path, command, environment, or arbitrary `/proc` content.

### Claim precedence

Production provider and terminal registrations are exact process ownership
claims. They must win over a UI candidate for the same stable identity.

The sampler will snapshot registered claims and append a UI claim only when no
existing exact non-UI claim owns that identity. This shared rule protects all
desktop observers and prevents a directly launched external process from
becoming Core merely because it resembles a platform UI helper. Descendants of
an accepted UI root continue to inherit `core/ui` through the existing
attributor.

### Coverage semantics

The Linux observer returns:

- `available` when at least one supported helper validates and every hinted
  immediate-child candidate validates;
- `partial` when at least one supported helper validates but another hinted
  candidate fails stable-identity, executable, or role validation;
- `unavailable` when no supported helper validates; and
- never `notApplicable`, because the observer is installed only in desktop
  mode.

WebKitGTK may create helpers lazily or share them between WebViews. The absence
of a particular role is not itself a failure. Coverage describes every process
exposed by the supported direct-child mechanism, not a fixed required count.

An immediate child whose command basename begins with `WebKit` but is not in
the strict role set is never claimed. It records an unsupported-role issue,
making otherwise successful coverage partial and an otherwise empty result
unavailable. This detects a changed WebKit topology without widening
ownership.

All messages pass through the existing Unicode-scalar bound. The server's
250-millisecond observer deadline remains the final time bound.

## Data Flow

1. Resource Manager activates the existing native resource sample.
2. `NativeProcessSampler` produces one immutable machine process snapshot.
3. The Linux observer inspects only direct children of the exact combined
   host/server identity and revalidates hinted candidates through `/proc`.
4. The registry supplies exact provider and terminal ownership claims.
5. The sampler appends non-conflicting validated UI claims.
6. `ResourceAttributor` emits accepted roots and their descendants as
   `core/ui`, while existing Core Server and External policies remain intact.
7. Current diagnostics and history carry the existing UI coverage object
   through the unchanged RPC contract.
8. Resource Manager renders the existing totals, rows, and bounded coverage
   warning.

No new persisted state, schema, RPC method, desktop bridge command, event, or
background task is introduced.

## Failure and Lifecycle Behavior

- A WebKit helper crash or rotation may yield one partial sample; the next
  demand-driven sample observes the replacement identity.
- A candidate that exits during `/proc` validation is rejected without failing
  native server sampling.
- An observer panic or deadline continues to become unavailable through the
  existing server wrapper.
- A hidden retained Preview WebView remains covered as long as its helper
  remains an owned direct child. Reused and shared helpers are deduplicated by
  stable identity.
- Closing a Preview may remove or rotate helpers; no retained claim survives
  beyond the current sample.
- Backend restart reuses the configured observer and validates against the new
  combined host/server identity.
- An unsupported distro topology degrades coverage without changing backend,
  provider, terminal, or UI lifecycle.

## Performance and Security

The machine-wide process refresh remains single-pass. The observer scans the
in-memory rows once, and `/proc` work is proportional only to hinted direct
children. No file content other than bounded Linux stat records is retained,
and executable paths are used only for local validation.

Direct current parentage, stable start ticks around executable resolution, the
strict role set, and external-claim precedence form the ownership proof. No
single signal is sufficient by itself. Another application's WebKit helpers
have a different parent. Provider and terminal helpers have an external root
between them and the server. PID reuse changes the stat start identity.

## Testing

### Pure Linux observer tests

Use fixture `ProcessRow` snapshots and an injected Linux process inspector to
verify:

- exact Web, Network, and GPU immediate children become UI identities;
- helpers shared across the main and Preview WebViews are deduplicated;
- accepted root descendants inherit `core/ui` in the server attributor;
- unrelated same-name processes with another parent are excluded;
- provider- and terminal-owned WebKit subtrees are excluded;
- a registered exact external claim wins over a conflicting UI identity;
- stale PID/start identities, changed parentage, invalid start ordering,
  executable mismatch, process exit, malformed stat, and permission failure
  fail closed;
- an unknown direct-child `WebKit*Process` role is not claimed and degrades
  coverage;
- valid plus failed candidates yield partial coverage;
- no validated identity yields unavailable coverage;
- messages remain bounded by Unicode scalar count; and
- the implementation performs no second machine-wide refresh.

### Factory and lifecycle tests

On Linux, verify that:

- `ui_process_observer::for_app` constructs the Linux observer;
- the configured observer reaches the initial in-process runtime;
- restart uses the same observer instance; and
- the generic unavailable fallback remains available for unsupported targets
  and test-only starts without a configured app observer.

Existing Windows WebView2 and macOS WKWebView observer tests must continue to
pass unchanged except for shared external-claim-precedence coverage.

### Packaged AppImage verification

Before enabling the role set, run the supported Linux AppImage and capture PID,
PPID, start identity, executable basename, and bounded command data for the
combined host/server and its direct children. Repeat with:

1. only the main WebView;
2. a native Preview WebView open;
3. the Preview closed after a later sample;
4. a provider and terminal running;
5. another WebKitGTK application running; and
6. BiBCode shutdown.

Confirm that the observed helper roles and parentage match this design. Then
open Resource Manager and verify:

- `core/server` and every validated `core/ui` row are visible;
- main and Preview helpers are covered without duplicate identities;
- the unrelated application's WebKit helpers are absent;
- provider and terminal processes remain External;
- Combined equals Core plus External for CPU, RSS, and process count;
- unsupported or failed validation displays partial/unavailable coverage; and
- quitting BiBCode leaves no owned WebKit or supervised process behind.

### Commands

Run focused tests followed by repository gates:

```bash
cargo test -p bibcode-server resource_sampler -- --nocapture
cargo test -p bibcode-desktop linux_ui -- --nocapture
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
vp check
vp run typecheck
```

Run the broader desktop/server tests because the change crosses the desktop
host and in-process server boundary:

```bash
cargo test -p bibcode-server
cargo test -p bibcode-desktop
```

## Documentation Changes

Update `docs/operations/observability.md` in the implementation patch to define
the Linux ownership proof and coverage behavior. No architecture overview,
contract, or user-facing Resource Manager documentation changes are required
unless implementation changes one of their current invariants.

## Acceptance Criteria

- Supported Linux AppImage WebKitGTK helpers owned by the main and Preview
  WebViews appear as exact `core/ui` rows.
- Another application and provider/terminal WebKit processes are never claimed
  as Core.
- Stable PID identity and executable validation close PID reuse and command
  spoofing windows.
- Unsupported topology or validation failure reports bounded
  partial/unavailable coverage rather than a guessed result.
- Sampling remains demand-driven, bounded, and single-refresh.
- Windows, macOS, web/headless, remote, and signal behavior remains correct.
- Focused tests, broader affected-package tests, Rust format, Clippy,
  `vp check`, and `vp run typecheck` pass before implementation is complete.
