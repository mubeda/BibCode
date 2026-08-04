# macOS WebKit Resource Attribution

## Goal

Include the WebKit processes owned by the running BiBCode desktop instance in
Resource Manager's **BiBCode Core** totals on macOS without elevated
privileges, new entitlements, or weaker attribution correctness.

## Problem

BiBCode currently installs `WebView2DesktopUiProcessObserver` only on Windows.
Every other desktop platform receives `UnavailableDesktopUiProcessObserver`, so
macOS reports the native host/server process but explicitly excludes WebKit UI
usage.

The Windows strategy cannot be copied directly. WebView2 helpers are current
BiBCode descendants and expose host-specific command-line markers. macOS
launches WKWebView helpers as generic `com.apple.WebKit.*` XPC services whose
observed parent is `launchd`. Their executable names do not identify the owning
application.

An unprivileged macOS probe confirmed two useful platform properties:

- private WKWebView selectors expose the current WebContent, provisional
  WebContent, GPU, and Networking process identifiers; and
- `PROC_PIDCOALITIONINFO` reports the same resource and jetsam coalition IDs for
  BiBCode and its WebKit helpers, while unrelated applications have different
  coalition IDs.

Both mechanisms use private SPI. They require runtime availability checks and
packaged-version testing, but they do not require elevated permissions.

## Chosen Approach

Add a Tauri-owned `MacosDesktopUiProcessObserver` that obtains process IDs from
every WebView owned by the current `AppHandle`. Treat those object-derived PIDs
as the ownership authority. Validate each candidate against the existing native
process sample, a strict WebKit executable check, and the native host's macOS
coalition before returning its stable `ProcessIdentity`.

Coalition membership is validation, not discovery. The observer must never scan
the host coalition and claim every generic WebKit process. This prevents an
external provider launched by BiBCode from becoming Core merely because it
inherits the host coalition and starts its own WebKit helper.

The observer dynamically checks every private selector before calling it. A
missing selector, failed WebView dispatch, failed coalition query, PID absent
from the native snapshot, or observation deadline produces honest partial or
unavailable coverage instead of a guessed result.

## Alternatives Considered

### Coalition-only discovery

Scanning for generic WebKit executables in the host coalition would avoid
passing a Tauri handle into backend startup. It is rejected because coalition
membership is broader than WebView ownership and can be inherited by external
tools. Command names plus coalition membership are not sufficiently exact to
be the ownership authority.

### Public WebKit API only

Public `WKProcessPool` coordinates WebKit processes but does not expose their
PIDs. Keeping macOS coverage unavailable is the only public-API-only option. It
does not meet the requested Resource Manager behavior.

### Process-name or launch-time matching

Generic XPC executable names and similar launch timestamps are not unique to
BiBCode. This approach is rejected as unreliable and race-prone.

## Architecture

### Platform observer factory

Create `apps/desktop/src-tauri/src/backend/ui_process_observer.rs` as the
platform-selection boundary. It returns an `Arc<dyn DesktopUiProcessObserver>`:

- Windows: the existing `WebView2DesktopUiProcessObserver`;
- macOS: `MacosDesktopUiProcessObserver` constructed from the live `AppHandle`;
- Linux and unsupported targets: `UnavailableDesktopUiProcessObserver`.

This removes platform construction logic from the already-large `backend.rs`.

### Backend supervisor ownership

`BackendSupervisor` retains the current observer behind shared synchronized
state. `start_default` installs the observer created from its `AppHandle` before
starting any local in-process backend. Direct test-only `start` calls continue
to use the unavailable observer by default.

`start_managed_backend` receives a snapshot of the configured observer and
passes it to `ServerRuntime::start_with_ui_process_observer`. Restart paths read
the configured observer again, so a restarted local backend keeps macOS UI
coverage without storing platform objects in the server crate.

### macOS WebView PID source

Create
`apps/desktop/src-tauri/src/backend/ui_process_observer/macos.rs`. The module
enumerates `AppHandle::webviews()` on every observation and dispatches
`Webview::with_webview` callbacks. Tauri executes each callback on the UI thread,
where the module may safely access the underlying `WKWebView`.

For each owned WebView, the source checks and, when supported, calls:

- `_webProcessIdentifier`;
- `_provisionalWebProcessIdentifier`;
- `_gpuProcessIdentifier`;
- `configuration.websiteDataStore._networkProcessIdentifier`.

Each nonzero result is retained as a typed candidate: `webContent`, `gpu`, or
`networking`. The provisional selector also produces a `webContent` candidate.
Zero PIDs mean that the corresponding helper is not running and are ignored.
Results from the main application WebView and native preview WebViews are
deduplicated after role validation.

The PID source has an internal deadline shorter than the server's existing
250-millisecond observer deadline. Completed callbacks are retained when one
WebView is slow, allowing partial coverage instead of forcing the entire sample
to unavailable. Late callbacks send into a closed channel and are discarded.

### Candidate validation

Validation is a pure, separately tested step over the existing
`Arc<[ProcessRow]>`:

1. Locate the exact server row using `server_identity`.
2. Read its resource and jetsam coalition IDs with
   `proc_pidinfo(PROC_PIDCOALITIONINFO)`.
3. For every nonzero object-derived PID, locate the row in the same native
   snapshot.
4. Require the executable name or path to match the candidate's exact role:
   `com.apple.WebKit.WebContent` (including the Enhanced Security variant),
   `com.apple.WebKit.GPU`, or `com.apple.WebKit.Networking`.
5. Require the candidate's coalition IDs to match the server's nonzero IDs.
6. Return the row's existing PID/start-time `ProcessIdentity`.
7. Deduplicate identities before returning them.

PID lookup against one immutable native snapshot prevents totals from combining
measurements taken at different times. Coalition and executable validation
prevent a stale or rapidly reused PID from acquiring UI ownership.

The private coalition structure and numeric flavor remain isolated in the
macOS module. FFI checks the exact returned byte count and treats any mismatch
as an observation failure.

## Coverage Semantics

The observer returns:

- `available` when every WebView dispatch completed, the WebContent, GPU, and
  Networking selector families were available, every reported nonzero PID was
  present and validated, and at least one WebKit identity was found;
- `partial` when at least one WebKit identity was validated but a dispatch,
  selector, snapshot lookup, executable check, coalition query, or internal
  deadline prevented complete observation;
- `unavailable` when no WebKit identity could be validated; and
- never `notApplicable`, because the observer is installed only for a desktop
  runtime with a co-located UI.

Messages identify the failed boundary without including commands, paths,
environment variables, or other unrestricted process data. The server's
existing scalar bound remains the final safety limit.

macOS 11 remains supported. Runtime selector checks permit older releases to
return partial coverage when newer GPU or Networking identifiers are not
available. No deployment-target increase is part of this change.

## Failure and Lifecycle Behavior

- Observation remains demand-driven through the existing resource sampler.
- No additional machine-wide process refresh or background polling loop is
  introduced.
- A WebKit crash or process rotation may yield one partial sample; the next
  sample re-queries every owned WebView and converges on the new identities.
- A closed preview WebView disappears from `AppHandle::webviews()` and is no
  longer claimed.
- Observer failure cannot stop or restart the backend, provider, terminal, or
  desktop UI.
- The existing server-level 250-millisecond timeout remains the final bound.
- Windows, Linux, headless, remote-host, and process-signal behavior remain
  unchanged.

## Security and Distribution Constraints

The implementation calls private selectors dynamically and uses a private
`proc_pidinfo` flavor. It does not add headers from the private SDK, link a new
framework, request elevated access, attach to another task, inspect process
memory, disable the hardened runtime, or add an entitlement.

All private calls are capability-checked and fail closed. This feature is not
compatible with a strict Mac App Store public-API-only policy. Packaged
Developer ID builds must verify the selectors and coalition query on every
supported macOS release before distribution.

## Testing

### Pure macOS observer tests

Use fake WebView PID results and fake coalition lookups to verify:

- exact WebContent, GPU, Networking, and provisional PIDs become Core UI;
- duplicate PIDs from multiple WebViews are counted once;
- zero PIDs are ignored;
- a PID absent from the native snapshot yields partial coverage;
- an unrelated WebKit process with a different coalition is rejected;
- a non-WebKit process with the correct coalition is rejected;
- coalition lookup failure yields partial coverage when other candidates are
  valid and unavailable coverage when none are valid;
- missing selectors and WebView dispatch failures preserve validated rows but
  report partial coverage; and
- no validated identity reports unavailable rather than a healthy zero.

### Backend integration tests

Verify that:

- a newly constructed `BackendSupervisor` uses the unavailable observer;
- installing an observer makes the next in-process runtime start use that exact
  observer;
- restart paths retain the installed observer; and
- Windows factory behavior remains unchanged under its existing tests.

### Live packaged verification

On macOS, open Resource Manager and confirm that:

- the warning disappears when complete observation is available;
- `core/server` and the expected `core/ui` rows are present;
- Combined equals Core plus External for memory, CPU, and process count;
- opening and closing preview WebViews updates the Core process set;
- provider and terminal processes remain External;
- another application's WebKit helpers are excluded; and
- quitting BiBCode leaves no owned WebKit or supervised process behind.

Run the focused Rust tests, then the required repository gates:

```bash
cargo test -p bibcode-server observer -- --nocapture
cargo test -p bibcode-desktop macos_ui -- --nocapture
vp check
vp run typecheck
```

## Acceptance Criteria

- Current macOS BiBCode WebKit helpers appear as exact `core/ui` rows without
  elevated privileges or new entitlements.
- Generic WebKit processes are never claimed solely by name, launch time, or
  coalition membership.
- Missing or changing private SPI produces bounded partial/unavailable coverage
  rather than a crash or silent undercount.
- macOS 11 remains the deployment floor.
- Windows, Linux, web, headless, remote, and External Tooling attribution remain
  behaviorally unchanged.
- Focused tests, `vp check`, and `vp run typecheck` pass before implementation is
  considered complete.
