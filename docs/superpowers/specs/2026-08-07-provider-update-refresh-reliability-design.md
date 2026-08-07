# Provider Update Refresh Reliability

**Date:** 2026-08-07

## Context

Provider snapshots combine an installed CLI version with the latest version
reported by the provider's package registry. The Rust server currently caches
both successful registry responses and failed lookups for one hour. The manual
`server.refreshProviders` path uses the same cache as background checks, so a
manual refresh can report a newly probed provider timestamp without making a
new registry request. The web UI hides an `unknown` version advisory, making a
failed registry lookup indistinguishable from a current provider.

On Windows, separate package managers or `PATH` entries can also resolve
different OpenCode installations. The provider snapshot must continue to use
the executable actually launched by BiBCode as the installed-version source of
truth.

## Goals

- A manual provider refresh must revalidate latest versions with the registry.
- A transient registry failure must not suppress later refresh attempts for an
  hour.
- The UI must distinguish a failed update check from a current provider.
- Background checks must retain successful-response caching and remain bounded.
- Provider probing and chat availability must survive registry failures.
- The installed version must continue to come from the resolved provider
  executable, not from an unrelated package-manager inventory.

## Non-goals

- Automatically installing provider updates.
- Changing provider update commands or installation-source detection.
- Reconciling multiple provider installations on the host.
- Adding a new RPC method or changing persisted settings.

## Design

### Refresh policy

`ProviderMaintenance` remains the owner of latest-version state. Its in-memory
cache carries a monotonic refresh generation:

- normal probes may reuse a non-expired successful registry result;
- `server.refreshProviders` advances the required generation before starting
  its full probe, so the manual action revalidates the registry;
- scheduled checks keep using the normal cache policy.

Each package has an independent asynchronous lookup lock. The first probe for a
package and generation fetches the registry result; concurrent instances of the
same provider reuse that result, while different provider packages remain
concurrent. An older in-flight lookup cannot satisfy a newer manual generation.
No public RPC shape changes.

### Failure handling

Only valid registry versions enter the one-hour cache. Transport failures,
non-success HTTP statuses, malformed JSON, and missing or empty `version`
values produce an `unknown` advisory for that snapshot but are not cached.
Consequently, the next automatic or manual refresh retries the request.

The server records a bounded warning with the registry host, package name, and
failure category. It does not log response bodies, provider credentials, or
arbitrary URLs.

The advisory uses its existing optional message to explain that the update
check failed. The settings UI renders that message as a non-update warning. A
failed check does not expose an update action and does not change provider
readiness.

### Check timestamps

The existing provider `checkedAt` continues to represent the provider probe.
The version advisory's `checkedAt` is set only when a registry result is
actually evaluated during that probe. Reusing a cached success retains the
time at which that registry result was obtained. A failed request records the
attempt time alongside the `unknown` advisory. This prevents the provider-level
“Checked just now” label from being interpreted as proof of a successful
registry lookup; the advisory presentation carries the registry outcome.

No persisted format changes: latest-version cache entries are in-memory only.

## Data Flow

1. The UI invokes `server.refreshProviders` for a manual refresh.
2. `NativeServerControl` advances the required latest-version generation once.
3. A full provider probe resolves the executable and installed version.
4. `ProviderMaintenance` fetches the provider package's latest version.
5. A successful version is cached and compared with the installed version.
6. A failure remains uncached and produces a visible `unknown` advisory without
   affecting provider readiness.
7. The existing provider snapshot publication path updates connected clients.

Background checks enter at step 3 without invalidating a still-valid successful
cache entry.

## Testing

Focused Rust tests will prove:

- a manual cache invalidation observes an OpenCode registry change from
  1.18.11 to 1.18.15;
- a failed registry lookup is retried immediately and can recover;
- successful latest-version responses remain cached for one hour;
- failed checks preserve the provider snapshot and produce an `unknown`
  advisory with no update action.

Focused web tests will prove that current advisories remain hidden, available
updates retain their action, and failed checks render a warning without an
update action.

Repository checks follow `AGENTS.md`, including focused tests, `vp check`,
`vp run typecheck`, Rust formatting, affected Rust tests, and Clippy with
warnings denied.
